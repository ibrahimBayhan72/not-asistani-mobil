// "Kâğıttan oku": sınav PDF'sinden şablon çıkarır, öğrenci kâğıdının fotoğraflarından (kaç sayfa ise) puanları okur,
// öğretmene onaylatır ve sınav listesine yazar. Her şey cihazda yapılır; fotoğraflar saklanmaz ve hiçbir yere gönderilmez.
import { itemsFromPdfjs, detectPage, buildTemplate } from '../modules/paper-template.js';
import { validateScore } from '../modules/score-validator.js';
import { loadCV, loadNet, photoToCanvas, scaleCanvas, alignPage, refThumbs, readBox } from './kagit-cv.js';

const S = 2; // şablon ve hizalama ölçeği: px / pt
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

let api = null; // { getExam, saveScores, toast, ask, go }
let exam = null;
let tpl = null; // { template, pages:[{canvas, ptW, ptH}], pdfName }
let thumbs = null;
let scan = null; // { pages: {pageIdx: entries[]}, preview: {pageIdx: dataURL} }
let busy = false;
let tplFor = null; // şablonun ait olduğu sınav
let pending = []; // şablon yokken çekilen sayfalar (PDF seçilince okunur)
const SURUM = 'v10';

// ------------------------------------------------------------------ şablon deposu (IndexedDB; öğrenci verisi içermez, boş sınav kâğıdı)
const db = () => new Promise((res, rej) => {
  const r = indexedDB.open('yna_kagit', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('sablon');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idb = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('sablon', mode); const q = fn(t.objectStore('sablon')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
const canvasToBlob = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
async function saveTemplate(examId, t) {
  const pages = [];
  for (const p of t.pages) pages.push({ blob: await canvasToBlob(p.canvas), ptW: p.ptW, ptH: p.ptH });
  try { await idb('readwrite', (s) => s.put({ template: t.template, pages, pdfName: t.pdfName, saved: Date.now() }, examId)); } catch { /* depolama kapalıysa şablon bu oturumda bellekte kalır */ }
}
async function loadTemplate(examId) {
  let rec = null;
  try { rec = await idb('readonly', (s) => s.get(examId)); } catch { return null; }
  if (!rec) return null;
  const pages = [];
  for (const p of rec.pages) {
    const bmp = await createImageBitmap(p.blob);
    const c = mk(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0); bmp.close && bmp.close();
    pages.push({ canvas: c, ptW: p.ptW, ptH: p.ptH });
  }
  return { template: rec.template, pages, pdfName: rec.pdfName };
}
const deleteTemplate = (examId) => idb('readwrite', (s) => s.delete(examId)).catch(() => {});

// ------------------------------------------------------------------ PDF → şablon
async function pdfToTemplate(file, questions) {
  const pdfjs = await import('./lib/pdfjs/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdfjs/pdf.worker.min.js', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [], detected = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: S });
    const c = mk(Math.round(vp.width), Math.round(vp.height));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    pages.push({ canvas: c, ptW: v1.width, ptH: v1.height });
    const tc = await page.getTextContent();
    detected.push(detectPage(itemsFromPdfjs(tc.items, v1.height), v1.width, v1.height));
  }
  return { template: buildTemplate(detected, questions), pages, pdfName: file.name };
}

// ------------------------------------------------------------------ görünüm
export function initKagit(a) {
  api = a;
  $('#kPdf').onchange = onPdf;
  $('#kCekInput').onchange = (e) => onPhotos(e.target.files);
  $('#kGaleriInput').onchange = (e) => onPhotos(e.target.files);
  $('#kCek').onclick = openCamera;
  $('#kKamKapat').onclick = () => { closeCamera(); renderTara(); };
  $('#kKamBitti').onclick = () => { closeCamera(); if (!tpl) { setSection('kSablon'); renderBekleyen(); } else showResults(); };
  $('#kSablonCek').onclick = openCamera;
  $('#kNative').onclick = () => $('#kCekInput').click(); // telefonun kendi kamera uygulaması (kullanıcı dokunuşuyla açılır)
  $('#kKamCek').onclick = shoot;
  $('#kGaleri').onclick = () => $('#kGaleriInput').click();
  $('#kSablonDegis').onclick = async () => {
    if (!(await api.ask('Şablon silinsin mi?', '<p>Bu sınav için kaydedilen sınav PDF şablonu silinecek. Öğrenci puanlarına dokunulmaz.</p>', 'Sil'))) return;
    await deleteTemplate(exam.id); tpl = null; thumbs = null; scan = null; render();
  };
  $('#kSonucaGec').onclick = showResults;
  $('#kYeniden').onclick = () => { scan = null; render(); };
  $('#kKaydet').onclick = saveResults;
  $('#kSonucGeri').onclick = () => { $('#kSonuc').hidden = true; $('#kTara').hidden = false; };
  $('#kElleBitti').onclick = finishManual;
  $('#kElleLink').onclick = () => startManual();
  $('#kElleGeri').onclick = () => { manual && manual.boxes.pop(); drawManual(); };
  document.querySelectorAll('input[name=kArac]').forEach((r) => (r.onchange = () => manual && (manual.tool = r.value)));
}

export async function render({ camera = true } = {}) {
  exam = api.getExam();
  if (!exam) return api.go('home');
  $('#kBaslik').textContent = ([exam.exam.sinifSube, exam.exam.ders].filter(Boolean).join(' · ') || 'Sınav') + ' · ' + SURUM;
  setSection(null);
  $('#kHata').textContent = ''; $('#kNative').hidden = true;
  if (tplFor !== exam.id) { tpl = null; thumbs = null; scan = null; manual = null; pendingPdf = null; pending = []; tplFor = exam.id; } // başka sınava geçildi
  if (!tpl) tpl = await loadTemplate(exam.id);
  if (tpl && !thumbs) thumbs = refThumbs(tpl.pages.map((p) => p.canvas));
  if (!scan) scan = { pages: {}, preview: {} };
  if (!tpl) { setSection('kSablon'); renderBekleyen(); if (camera) openCamera(); return; } // şablon yoksa da kamera ÖNCE açılır

  setSection('kTara');
  renderTara();
  if (camera) openCamera(); // 📷'e basınca doğrudan kamera açılır; kâğıt görseli aramak gerekmez
}
export function leave() { closeCamera(); } // başka görünüme geçilirken kamerayı kapat
function setSection(id) { for (const s of ['kSablon', 'kTara', 'kSonuc', 'kElle']) $('#' + s).hidden = s !== id; }
const status = (t, err) => { const el = $('#kDurum'); el.textContent = t || ''; el.className = 'k-durum' + (err ? ' err' : ''); };

async function onPdf(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || busy) return;
  busy = true; $('#kHata').textContent = ''; $('#kPdfDurum').textContent = 'PDF okunuyor…';
  try {
    const t = await pdfToTemplate(f, exam.questions);
    const tp = t.template;
    if (!tp.blanks.length) { // metin katmanı yok → elle işaretleme
      busy = false; $('#kPdfDurum').textContent = '';
      return startManual(t);
    }
    if (tp.blanks.length !== exam.questions.length) {
      $('#kHata').innerHTML = esc(tp.notes.join(' ')) + '<br>Bu PDF bu sınavla uyuşmuyor olabilir. Doğru PDF\'yi seçin ya da kutuları elle işaretleyin.';
      $('#kElleLink').hidden = false; pendingPdf = t; return;
    }
    if (!tp.ok && !(await api.ask('Uyarı', `<p>${esc(tp.notes.join(' '))}</p><p>e-Okul'daki puanlar esas alınır. Yine de kullanılsın mı?</p>`, 'Kullan'))) return;
    tpl = t; thumbs = refThumbs(t.pages.map((p) => p.canvas));
    await saveTemplate(exam.id, t);
    busy = false; scan = null; await afterTemplate(); // meşgul bayrağı kapandıktan sonra: bekleyen sayfalar okunur, kamera açılır
  } catch (err) {
    $('#kHata').textContent = 'PDF okunamadı: ' + (err && err.message ? err.message : err) + ' — Bu cihazın tarayıcısı PDF okuyucuyu desteklemiyor olabilir (güncel Chrome/Safari gerekir).';
  } finally { busy = false; $('#kPdfDurum').textContent = ''; }
}
let pendingPdf = null;

function renderBekleyen() {
  const el = $('#kBekleyen');
  el.hidden = !pending.length;
  el.textContent = pending.length ? `📷 ${pending.length} sayfa çekildi. Okumak için sınav PDF'sini seçin (sınav başına bir kez).` : '';
}
/** Şablon hazır olunca: şablon yokken çekilmiş sayfalar okunur; eksik sayfa varsa kamera açılır, hepsi tamamsa sonuç gösterilir */
async function afterTemplate() {
  if (!pending.length) return render();
  setSection('kTara'); if (!scan) scan = { pages: {}, preview: {} }; renderTara();
  const list = pending; pending = [];
  busy = true; let red = 0;
  try {
    status(`Çektiğiniz ${list.length} sayfa okunuyor…`);
    await Promise.all([loadCV(), loadNet()]);
    for (const c of list) { await new Promise((r) => setTimeout(r, 30)); const r = await processCanvas(c); if (r.rejected) red++; }
    status(red ? `${red} fotoğraf şablondaki hiçbir sayfaya benzemediği için atlandı; yeniden çekin.` : '', red > 0);
  } catch (err) {
    $('#kHata').textContent = 'Sayfalar okunamadı: ' + (err && err.message ? err.message : err);
  } finally { busy = false; renderTara(); }
  if (Object.keys(scan.pages).length >= tpl.pages.length) return showResults();
  render(); // eksik sayfalar için kamera
}

function renderTara() {
  const tp = tpl.template;
  $('#kSablonBilgi').innerHTML = `📄 <b>${esc(tpl.pdfName || 'Şablon')}</b> · ${tp.pageCount || tpl.pages.length} sayfa · ${tp.blanks.length} soru${tp.manual ? ' (elle işaretlendi)' : ''}`;
  const done = Object.keys(scan.pages).map(Number);
  $('#kSayfalar').innerHTML = tpl.pages.map((_, i) => `<span class="k-chip ${done.includes(i) ? 'ok' : ''}">${i + 1}. sayfa ${done.includes(i) ? '✓' : '○'}</span>`).join('');
  $('#kSonucaGec').disabled = !done.length;
  const next = tpl.pages.findIndex((_, i) => !done.includes(i));
  $('#kCek').textContent = next >= 0 ? `📷 Kamerayı aç (${next + 1}. sayfa)` : '📷 Kamerayı aç (yeniden çek)';
  $('#kOnizleme').innerHTML = Object.entries(scan.preview).map(([i, u]) => `<figure><img src="${u}" alt="${+i + 1}. sayfa"><figcaption>${+i + 1}. sayfa — yeşil: okundu</figcaption></figure>`).join('');
  if (!busy && !$('#kDurum').textContent) status(done.length ? '' : 'Kâğıdı düz bir zemine koyun, tamamı görünsün ve gölge düşmesin. Kâğıt arka plandan koyu renkte olursa en iyi sonucu verir.');
}

// ------------------------------------------------------------------ fotoğraf → okuma
/** Bir sayfa görüntüsünü (tuval) şablona hizalar, kutuları okur ve oturuma yazar. @returns {{rejected:boolean, page?:number, warn:string[]}} */
async function processCanvas(photo) {
  const [cv, net] = await Promise.all([loadCV(), loadNet()]);
  const refs = tpl.pages.map((p) => p.canvas);
  const al = alignPage(cv, photo, refs, thumbs, null);
  const warn = [];
  if (!al.paperFound) warn.push('kâğıdın kenarları bulunamadı');
  if (!al.refined) warn.push('ince hizalama yapılamadı');
  if (al.score < 0.15 && !al.refined) return { rejected: true, warn }; // şablondaki hiçbir sayfaya benzemiyor
  const tp = tpl.template;
  const entries = [];
  const add = (id, label, box, numeric, extra = {}) => { const r = readBox(al.canvas, refs[al.page], box, S, net, { numeric }); entries.push({ id, label, box, ...extra, ...r }); };
  tp.blanks.forEach((b, i) => { if (b.page === al.page) add('s' + i, `${i + 1}. soru`, b, true, { index: i, max: exam.questions[i] ? exam.questions[i].max : b.max }); });
  if (tp.no && tp.no.page === al.page) add('no', 'Öğrenci no', tp.no, true);
  if (tp.total && tp.total.page === al.page) add('toplam', 'Toplam puan', tp.total, true);
  if (tp.name && tp.name.page === al.page) add('ad', 'Ad soyad', tp.name, false);
  if (tp.sinif && tp.sinif.page === al.page) add('sinif', 'Sınıf/şube', tp.sinif, false);
  // önizleme: hizalanmış sayfa üzerinde kutular
  const pv = mk(al.canvas.width, al.canvas.height), g = pv.getContext('2d'); g.drawImage(al.canvas, 0, 0);
  g.lineWidth = 4;
  for (const en of entries) { g.strokeStyle = en.text || !en.ink ? '#16a34a' : '#dc2626'; g.strokeRect(en.box.x * S, en.box.y * S, en.box.w * S, en.box.h * S); }
  const small = mk(500, Math.round((500 * pv.height) / pv.width)); small.getContext('2d').drawImage(pv, 0, 0, small.width, small.height);
  scan.pages[al.page] = entries; scan.preview[al.page] = small.toDataURL('image/jpeg', 0.8);
  return { rejected: false, page: al.page, warn };
}

/** Galeriden / telefonun kendi kamera uygulamasından gelen dosyalar (ikincil yol) */
async function onPhotos(files) {
  const list = [...files]; for (const id of ['#kCekInput', '#kGaleriInput']) $(id).value = '';
  if (!list.length || busy) return;
  if (!tpl) { // şablon yok: fotoğraflar bekleme listesine
    try { for (const f of list) pending.push(await photoToCanvas(f, 2000)); renderBekleyen(); $('#kHata').textContent = ''; $('#kNative').hidden = true; }
    catch (err) { $('#kHata').textContent = 'Fotoğraf işlenemedi: ' + (err && err.message ? err.message : err); }
    return;
  }
  busy = true; $('#kHata').textContent = '';
  try {
    status('Görüntü işleme motoru yükleniyor… (ilk kullanımda ~13 MB, sonra çevrimdışı çalışır)');
    await Promise.all([loadCV(), loadNet()]);
    for (const [n, f] of list.entries()) {
      status(`Fotoğraf ${n + 1}/${list.length} işleniyor…`);
      await new Promise((r) => setTimeout(r, 30)); // arayüz güncellensin
      const r = await processCanvas(await photoToCanvas(f, 2000));
      status(r.rejected ? '✖ Bu fotoğraf şablondaki hiçbir sayfaya benzemiyor; atlandı.' : `${r.page + 1}. sayfa okundu.${r.warn.length ? ' Dikkat: ' + r.warn.join(', ') + ' — emin değilseniz yeniden çekin.' : ''}`, r.rejected || r.warn.length > 0);
    }
  } catch (err) {
    status('', false); $('#kHata').textContent = 'Fotoğraf işlenemedi: ' + (err && err.message ? err.message : err);
  } finally { busy = false; renderTara(); }
}

// ------------------------------------------------------------------ canlı kamera (📷'e basınca doğrudan açılır)
let stream = null, camBusy = false, camGen = 0; // camGen: açılış sırasında kapatılırsa gelen akışı yoksaymak için
const camStatus = (t, err) => { const el = $('#kKamDurum'); el.textContent = t || ''; el.className = err ? 'err' : ''; };
function camInfo() {
  if (!tpl) { $('#kKamBilgi').textContent = `Sayfa ${pending.length + 1}`; $('#kKamBitti').disabled = !pending.length; return; }
  const done = Object.keys(scan.pages).map(Number);
  const next = tpl.pages.findIndex((_, i) => !done.includes(i));
  $('#kKamBilgi').textContent = next >= 0 ? `Sayfa ${next + 1} / ${tpl.pages.length}` : `${tpl.pages.length} sayfa tamam · yeniden çek`;
  $('#kKamBitti').disabled = !done.length;
}
async function openCamera() {
  if (stream || busy || $('#kKamera').hidden === false) return;
  const my = ++camGen;
  if (!scan) scan = { pages: {}, preview: {} };
  $('#kKamera').hidden = false; document.body.style.overflow = 'hidden'; document.body.classList.add('kam-acik');
  camInfo(); camStatus('Kamera açılıyor…');
  loadCV().catch(() => {}); loadNet().catch(() => {}); // ilk çekimden önce motoru ısıt
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('bu tarayıcıda yok'), { name: 'NotSupported' });
    // önce yüksek çözünürlük; olmazsa daha sade istekler (bazı telefonlar yüksek çözünürlüğü reddeder)
    const denemeler = [
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false },
    ];
    let s = null, sonHata = null;
    for (const c of denemeler) {
      try { s = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { sonHata = e; if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break; }
    }
    if (!s) throw sonHata || new Error('kamera açılamadı');
    if (my !== camGen) { s.getTracks().forEach((t) => t.stop()); return; } // izin beklenirken kamera kapatıldı
    stream = s;
    const v = $('#kVideo'); v.srcObject = stream; await v.play();
    camStatus('Kâğıdın tamamı çerçevede olsun, sonra çekin.');
  } catch (e) {
    if (my !== camGen) return;
    closeCamera();
    if (tpl) renderTara(); else { setSection('kSablon'); renderBekleyen(); }
    showCamError(e);
  }
}
/** Kamera açılamadıysa nedenini ekranda açıkça yazar ve telefonun kendi kamera uygulamasını önerir */
function showCamError(e) {
  const n = (e && e.name) || 'Hata';
  const ipucu = {
    NotAllowedError: 'Kamera izni verilmedi. Adres çubuğundaki kilit/ayarlar simgesinden bu site için kamerayı "İzin ver" yapıp yeniden deneyin.',
    NotFoundError: 'Bu telefonda kamera bulunamadı.',
    NotReadableError: 'Kamera başka bir uygulama tarafından kullanılıyor olabilir. Diğer uygulamaları kapatıp yeniden deneyin.',
    NotSupported: 'Bu tarayıcı uygulama içinde kamera açmayı desteklemiyor.',
    OverconstrainedError: 'Kamera ayarları bu telefonda desteklenmiyor.',
    SecurityError: 'Kamera yalnızca güvenli (https) bağlantıda açılır.',
  }[n] || '';
  $('#kHata').textContent = `Kamera açılamadı (${n}${e && e.message ? ': ' + e.message : ''}). ${ipucu} Aşağıdaki düğmeyle telefonun kendi kamera uygulamasını da kullanabilirsiniz.`;
  $('#kNative').hidden = false;
}
function closeCamera() {
  camGen++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; camBusy = false;
  const v = $('#kVideo'); if (v) v.srcObject = null;
  const o = $('#kKamera'); if (o) o.hidden = true;
  document.body.style.overflow = ''; document.body.classList.remove('kam-acik');
}
async function shoot() {
  const v = $('#kVideo');
  if (camBusy) return;
  if (!stream || !v.videoWidth) { camStatus('Kamera hazırlanıyor, birkaç saniye bekleyip yeniden dokunun…'); return; }
  camBusy = true; $('#kKamCek').disabled = true;
  const fl = $('#kFlash'); fl.classList.add('on'); setTimeout(() => fl.classList.remove('on'), 80);
  const frame = mk(v.videoWidth, v.videoHeight); frame.getContext('2d').drawImage(v, 0, 0);
  camStatus('Okunuyor…');
  try {
    await new Promise((r) => setTimeout(r, 30));
    if (!tpl) { // şablon (PDF) henüz yok: sayfayı sakla, PDF seçilince okunur
      pending.push(scaleCanvas(frame, 2000)); camInfo();
      camStatus(`✓ ${pending.length}. sayfa çekildi. Sıradaki sayfayı çekin; bitince "Bitti"ye basın.`);
      return;
    }
    const r = await processCanvas(scaleCanvas(frame, 2000));
    if (r.rejected) camStatus('✖ Sayfa tanınamadı. Kâğıdı çerçeveye alıp yeniden çekin.', true);
    else if (Object.keys(scan.pages).length >= tpl.pages.length) { closeCamera(); renderTara(); showResults(); return; }
    else { camInfo(); renderTara(); camStatus(`✓ ${r.page + 1}. sayfa okundu${r.warn.length ? ' (' + r.warn.join(', ') + ')' : ''}. Sıradaki sayfayı çekin.`, r.warn.length > 0); }
  } catch (e) {
    camStatus('Hata: ' + (e && e.message ? e.message : e), true);
  } finally { camBusy = false; const b = $('#kKamCek'); if (b) b.disabled = false; if (stream) camInfo(); }
}

// ------------------------------------------------------------------ sonuç / onay
function editDistance(a, b) { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
function matchStudent(noText) {
  const sts = exam.students;
  const exact = sts.findIndex((s) => s.no === noText);
  if (noText && exact >= 0) return { idx: exact, exact: true };
  if (!noText) return { idx: -1 };
  const cand = sts.map((s, i) => ({ i, d: editDistance(noText, s.no) })).filter((x) => x.d <= 1);
  return cand.length === 1 ? { idx: cand[0].i, exact: false } : { idx: -1 };
}
const all = () => Object.values(scan.pages).flat();

function showResults() {
  const en = all();
  const no = en.find((e) => e.id === 'no');
  const toplam = en.find((e) => e.id === 'toplam');
  const m = matchStudent(no ? no.text : '');
  const crop = (e) => (e && e.crop ? `<img class="k-crop" src="${e.crop}" alt="">` : '<span class="k-crop none">—</span>');
  const opts = exam.students.map((s, i) => `<option value="${i}" ${i === m.idx ? 'selected' : ''}>${esc(s.no)} — ${esc(s.name)}</option>`).join('');
  const missingPages = tpl.pages.map((_, i) => i).filter((i) => !scan.pages[i]);
  const ad = en.find((e) => e.id === 'ad'), sinif = en.find((e) => e.id === 'sinif');
  $('#kSonucGovde').innerHTML = `
    ${missingPages.length ? `<p class="warnbox">${missingPages.map((i) => i + 1).join(', ')}. sayfa çekilmedi; o sayfadaki sorular boş kalır.</p>` : ''}
    <div class="k-ogr">
      <div class="k-row">${crop(no)}<label>Okunan numara<input id="kNo" inputmode="numeric" value="${esc(no ? no.text : '')}" autocomplete="off"></label></div>
      <label>Öğrenci<select id="kOgr"><option value="-1">— seçin —</option>${opts}</select></label>
      <p id="kOgrDurum" class="k-not"></p>
      ${ad || sinif ? `<div class="k-row">${crop(ad)}${crop(sinif)}<small>Kâğıttaki ad / sınıf (göz kontrolü)</small></div>` : ''}
    </div>
    <div class="k-sorular">${exam.questions.map((q, i) => {
      const e = en.find((x) => x.id === 's' + i);
      return `<div class="k-soru" data-i="${i}"><div class="k-lbl"><b>${i + 1}. soru</b><small>en fazla ${q.max}</small></div>${e ? crop(e) : '<span class="k-crop none">çekilmedi</span>'}
        <input inputmode="numeric" data-i="${i}" value="${esc(e ? e.text : '')}" ${e ? '' : 'disabled'} autocomplete="off" aria-label="${i + 1}. soru puanı"><span class="k-flag" data-flag="${i}"></span></div>`;
    }).join('')}</div>
    <div class="k-toplam">${crop(toplam)}<div><b>Toplam puan</b><div id="kToplamSonuc"></div></div></div>`;
  $('#kTara').hidden = true; $('#kSonuc').hidden = false;
  const inputs = [...document.querySelectorAll('#kSonucGovde input[data-i]')];
  const refresh = () => {
    // soru kontrolleri
    let sum = 0, filled = 0, bad = 0;
    inputs.forEach((inp) => {
      const i = +inp.dataset.i, e = en.find((x) => x.id === 's' + i), q = exam.questions[i];
      const v = validateScore(inp.value, q.max, { integerOnly: exam.integerOnly });
      const flag = document.querySelector(`[data-flag="${i}"]`);
      let t = '', cls = '';
      if (inp.disabled) { t = ''; }
      else if (v.status === 'error') { t = v.message; cls = 'err'; bad++; }
      else if (v.status === 'empty') { t = e && e.ink > 0.002 ? 'boş okundu' : 'boş'; cls = 'warn'; }
      else if (e && e.conf && e.conf < 0.85 && inp.value === e.text) { t = 'emin değil'; cls = 'warn'; }
      if (v.status === 'ok') { sum += v.value; filled++; }
      flag.textContent = t; flag.className = 'k-flag ' + cls; inp.className = cls;
    });
    // toplam
    const read = toplam && toplam.text !== '' ? +toplam.text : null;
    const box = $('#kToplamSonuc');
    if (read == null) box.innerHTML = `Hesaplanan: <b>${sum}</b> <small>(kâğıttaki toplam okunamadı)</small>`;
    else if (read === sum) box.innerHTML = `Hesaplanan <b>${sum}</b> = kâğıttaki <b>${read}</b> <span class="k-ok">✓ tutuyor</span>`;
    else box.innerHTML = `Hesaplanan <b>${sum}</b>, kâğıttaki <b>${read}</b> <span class="k-bad">✖ tutmuyor</span><br><small>Bir puan yanlış okunmuş ya da kâğıtta toplam hatalı olabilir.</small>`;
    // öğrenci
    const sel = +$('#kOgr').value;
    const st = sel >= 0 ? exam.students[sel] : null;
    const has = st && st.scores.some((x) => String(x ?? '').trim() !== '');
    $('#kOgrDurum').innerHTML = !st ? '⚠ Öğrenciyi seçin.' : (m.exact === false && +$('#kNo').value === +(no ? no.text : '') ? '≈ Numara tam eşleşmedi; en yakın öğrenci seçildi, kontrol edin.' : '') + (has ? ' <b>Bu öğrencinin kayıtlı puanları var; kaydedince değişir.</b>' : '');
    $('#kKaydet').disabled = !st || bad > 0;
    $('#kKaydet').textContent = st ? `💾 ${st.no} ${st.name} için kaydet` : '💾 Kaydet';
  };
  inputs.forEach((i) => i.addEventListener('input', refresh));
  $('#kOgr').onchange = refresh;
  $('#kNo').oninput = () => { const mm = matchStudent($('#kNo').value.trim()); if (mm.idx >= 0) $('#kOgr').value = String(mm.idx); refresh(); };
  refresh();
}

async function saveResults() {
  const sel = +$('#kOgr').value;
  const st = exam.students[sel];
  if (!st) return;
  const scores = exam.questions.map((_, i) => { const inp = document.querySelector(`#kSonucGovde input[data-i="${i}"]`); return inp && !inp.disabled ? inp.value.trim() : (st.scores[i] ?? ''); });
  const had = st.scores.some((x) => String(x ?? '').trim() !== '');
  if (had && !(await api.ask('Puanlar değişsin mi?', `<p><b>${esc(st.no)} ${esc(st.name)}</b> için kayıtlı puanlar var; kâğıttan okunanlarla değiştirilecek.</p>`, 'Değiştir'))) return;
  api.saveScores(sel, scores);
  api.toast(`${st.no} ${st.name} kaydedildi. Sıradaki kâğıt.`, 'ok');
  scan = { pages: {}, preview: {} }; status('');
  $('#kSonuc').hidden = true; $('#kTara').hidden = false; renderTara();
  openCamera(); // sıradaki öğrencinin kâğıdı
}

// ------------------------------------------------------------------ elle işaretleme (metin katmanı olmayan PDF'ler)
let manual = null;
async function startManual(t) {
  manual = { t: t || pendingPdf, boxes: [], tool: 'soru' };
  if (!manual.t) return;
  setSection('kElle');
  $('#kElleSayfalar').innerHTML = '';
  manual.t.pages.forEach((p, pi) => {
    const wrap = document.createElement('div'); wrap.className = 'k-elle-sayfa'; wrap.dataset.p = pi;
    const c = mk(p.canvas.width / 2, p.canvas.height / 2); c.getContext('2d').drawImage(p.canvas, 0, 0, c.width, c.height);
    c.style.width = '100%';
    wrap.append(c);
    wrap.addEventListener('click', (e) => {
      const r = wrap.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * p.ptW, y = ((e.clientY - r.top) / r.height) * p.ptH;
      const size = { soru: [56, 30], no: [70, 28], toplam: [60, 26] }[manual.tool];
      manual.boxes.push({ page: pi, tool: manual.tool, x: Math.max(0, x - size[0] / 2), y: Math.max(0, y - size[1] / 2), w: size[0], h: size[1] });
      drawManual();
    });
    $('#kElleSayfalar').append(wrap);
  });
  drawManual();
}
function drawManual() {
  if (!manual) return;
  let k = 0;
  const order = manual.boxes.map((b, i) => ({ b, i })).filter((x) => x.b.tool === 'soru').sort((a, b) => a.b.page - b.b.page || a.b.y - b.b.y);
  const num = new Map(order.map((x, n) => [x.i, n + 1]));
  document.querySelectorAll('.k-elle-sayfa').forEach((wrap) => {
    wrap.querySelectorAll('.k-kutu').forEach((n) => n.remove());
    const pi = +wrap.dataset.p, p = manual.t.pages[pi];
    manual.boxes.forEach((b, i) => {
      if (b.page !== pi) return;
      const d = document.createElement('div'); d.className = 'k-kutu ' + b.tool;
      d.style.cssText = `left:${(b.x / p.ptW) * 100}%;top:${(b.y / p.ptH) * 100}%;width:${(b.w / p.ptW) * 100}%;height:${(b.h / p.ptH) * 100}%`;
      d.textContent = b.tool === 'soru' ? num.get(i) : b.tool === 'no' ? 'No' : 'Top';
      wrap.append(d);
    });
  });
  const n = manual.boxes.filter((b) => b.tool === 'soru').length;
  $('#kElleSay').textContent = `${n} / ${exam.questions.length} soru kutusu işaretlendi`;
  $('#kElleBitti').disabled = n !== exam.questions.length;
}
async function finishManual() {
  const t = manual.t, b = manual.boxes;
  const soru = b.filter((x) => x.tool === 'soru').sort((x, y) => x.page - y.page || x.y - y.y).map((x) => ({ x: x.x, y: x.y, w: x.w, h: x.h, page: x.page, max: 0 }));
  soru.forEach((s, i) => (s.max = exam.questions[i].max));
  const pick = (k) => { const x = b.find((z) => z.tool === k); return x ? { x: x.x, y: x.y, w: x.w, h: x.h, page: x.page } : null; };
  t.template = { blanks: soru, no: pick('no'), total: pick('toplam'), name: null, sinif: null, ok: true, notes: [], pageCount: t.pages.length, manual: true };
  tpl = t; thumbs = refThumbs(t.pages.map((p) => p.canvas)); manual = null; pendingPdf = null;
  await saveTemplate(exam.id, t); scan = null; await afterTemplate();
}
