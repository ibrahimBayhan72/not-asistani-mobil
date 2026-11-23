// Not Asistanı Mobil — telefonda puan hazırlama (PWA).
// Veriler yalnızca bu cihazda tutulur (öğretmen onay verirse localStorage, vermezse yalnızca bellekte).
import { validateStudent, validateQuestions, validateSheet } from '../modules/score-validator.js';
import { parseScore, studentTotal, formatNumber, isAbsentMark, ABSENT_MARK } from '../modules/score-calculator.js';
import { sheetToRows, toCSV, makeFileName } from '../modules/export-manager.js';
import { KIND, makeFrames, decodeListText, encodeScoresText } from '../modules/qr-transfer.js';
import { renderQR, scanQR } from '../ui/qr-ui.js';
import { initKagit, render as renderKagit, leave as leaveKagit } from './kagit.js';

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ------------------------------------------------------------------ saklama
const KEY = 'yna_mobil_v1';
const CONSENT = 'yna_mobil_onay';
const ls = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
      return true;
    } catch {
      return false;
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};
const store = {
  consent: ls.get(CONSENT), // '1' evet, '0' hayır, null sorulmadı
  data: { exams: [] },
  load() {
    if (this.consent !== '1') return;
    try {
      const d = JSON.parse(ls.get(KEY) || 'null');
      if (d && Array.isArray(d.exams)) this.data = d;
    } catch {}
    for (const e of this.data.exams) e.questions.forEach((q) => (q.max = q.max == null ? NaN : q.max));
  },
  save() {
    if (this.consent === '1') ls.set(KEY, JSON.stringify(this.data));
  },
  setConsent(on) {
    this.consent = on ? '1' : '0';
    ls.set(CONSENT, this.consent);
    if (on) this.save();
    else ls.del(KEY);
  },
};
let saveTimer = null;
const scheduleSave = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.save(), 300);
};

// ------------------------------------------------------------------ yardımcılar
let toastTimer = null;
function toast(msg, kind = '', ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), ms);
}
function ask(title, html, okLabel = 'Evet', cancelLabel = 'Vazgeç') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ask';
    d.innerHTML = `<h3>${esc(title)}</h3><div>${html}</div><div class="row"><button data-v="0">${esc(cancelLabel)}</button><button class="primary" data-v="1">${esc(okLabel)}</button></div>`;
    document.body.appendChild(d);
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      d.close();
      d.remove();
      resolve(b.dataset.v === '1');
    });
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      d.close();
      d.remove();
      resolve(false);
    });
    d.showModal();
  });
}
// Titreşim yalnızca kullanıcı sayfaya dokunduktan sonra (tarayıcı kuralı) ve destekleniyorsa
const buzz = (p) => navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive) && navigator.vibrate(p);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const examTitle = (e) => [e.exam.sinifSube, e.exam.ders].filter(Boolean).join(' · ') || 'Adsız sınav';
// Son sütun: OYSS'de toplam, ders notunda ortalama
const isDN = () => current && current.mode === 'dersnotu';
const lastVal = (v) => (v.status === 'absent' ? 'G' : !v.filled ? '' : isDN() ? formatNumber(Math.round((v.total / v.filled) * 100) / 100) : formatNumber(v.total));

// ------------------------------------------------------------------ görünümler
let current = null; // açık sınav
const cur = { r: 0, q: 0, fresh: true, mode: 'student' };
const VIEWS = ['home', 'setup', 'entry', 'list', 'send', 'kagit'];
let qrHandle = null;
let wakeLock = null;

function go(view) {
  if (view !== 'kagit') leaveKagit(); // kamera açıksa kapat
  for (const v of VIEWS) $(`#v${v[0].toUpperCase()}${v.slice(1)}`).hidden = v !== view;
  if (qrHandle) qrHandle.stop(), (qrHandle = null);
  if (wakeLock) wakeLock.release().catch(() => {}), (wakeLock = null);
  if (view === 'home') renderHome();
  if (view === 'entry') renderEntry();
  if (view === 'list') renderList();
  if (view === 'send') renderSend();
  if (view === 'kagit') renderKagit();
  window.scrollTo(0, 0);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});

// ------------------------------------------------------------------ ana sayfa
function examStats(e) {
  const v = validateSheet({ questions: e.questions, students: e.students, integerOnly: e.integerOnly, mode: e.mode });
  const s = v.summary;
  return { ...s, done: s.ok + s.absent, total: e.students.length };
}
function renderHome() {
  $('#consent').hidden = store.consent !== null;
  $('#memoryWarn').hidden = store.consent !== '0';
  const list = $('#examList');
  const exams = [...store.data.exams].sort((a, b) => b.updated - a.updated);
  if (!exams.length) {
    list.innerHTML = '<div class="empty">Henüz sınav yok. Bilgisayardaki panelden listeyi QR ile alın ya da elle oluşturun.</div>';
    return;
  }
  list.innerHTML = exams
    .map((e) => {
      const s = examStats(e);
      const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
      return `<div class="exam" data-id="${e.id}">
        <div class="main" data-open="${e.id}">
          <b>${esc(examTitle(e))}</b>
          <small>${esc(e.exam.sinav || '')}</small>
          <small>${s.done}/${s.total} tamam${s.incomplete ? ` · ${s.incomplete} eksik` : ''}${s.error ? ` · ${s.error} hatalı` : ''}${s.absent ? ` · ${s.absent} G` : ''} · ${new Date(e.updated).toLocaleDateString('tr-TR')}</small>
          <div class="bar-p"><i style="width:${pct}%"></i></div>
        </div>
        <button class="del" data-del="${e.id}" aria-label="Sınavı sil">🗑</button>
      </div>`;
    })
    .join('');
}
$('#examList').addEventListener('click', async (e) => {
  const open = e.target.closest('[data-open]');
  const del = e.target.closest('[data-del]');
  if (open) openExam(open.dataset.open);
  if (del) {
    const ex = store.data.exams.find((x) => x.id === del.dataset.del);
    if (ex && (await ask('Sınav silinsin mi?', `<p><b>${esc(examTitle(ex))}</b> ve girilen tüm puanlar bu telefondan silinecek. Geri alınamaz.</p>`, 'Sil'))) {
      store.data.exams = store.data.exams.filter((x) => x !== ex);
      store.save();
      renderHome();
    }
  }
});
$('#consentYes').onclick = () => {
  store.setConsent(true);
  toast('Veriler bu telefonda saklanacak.', 'ok');
  renderHome();
};
$('#consentNo').onclick = () => {
  store.setConsent(false);
  renderHome();
};
$('#consentAsk').onclick = () => {
  store.consent = null;
  renderHome();
};

function openExam(id, r = 0) {
  current = store.data.exams.find((x) => x.id === id) || null;
  if (!current) return;
  Object.assign(cur, { r, q: 0, fresh: true });
  go('entry');
}

// ------------------------------------------------------------------ listeyi QR ile al
$('#btnScanList').onclick = async () => {
  const res = await scanQR({
    title: '📷 Listeyi QR ile al',
    hint: "Bilgisayarda panelde <b>📲 Listeyi telefona gönder</b>'e basın ve kamerayı ekrandaki koda tutun.",
    expectedKind: KIND.LIST,
  });
  if (res) await receiveList(res.text);
};

async function receiveList(text) {
  let d;
  try {
    d = decodeListText(text);
  } catch (e) {
    return toast(e.message || 'Liste okunamadı.', 'err', 5000);
  }
  if (!d.students.length) return toast('Listede öğrenci yok.', 'warn');
  const same = store.data.exams.find(
    (e) =>
      (d.fingerprint && e.fingerprint === d.fingerprint) ||
      (e.exam.sinifSube === d.exam.sinifSube && e.exam.ders === d.exam.ders && e.exam.sinav === d.exam.sinav && d.exam.sinifSube)
  );
  if (same && (await ask('Bu sınav telefonda zaten var', `<p><b>${esc(examTitle(same))}</b> güncellensin mi? Girilen puanlar okul numarasına göre korunur.</p>`, 'Güncelle', 'Yeni sınav olarak ekle'))) {
    const sameQ = same.questions.length === d.questions.length;
    const old = new Map(same.students.map((s) => [s.no, s.scores]));
    same.students = d.students.map((s) => ({ no: s.no, name: s.name, scores: sameQ && old.get(s.no) ? old.get(s.no).slice() : Array(d.questions.length).fill('') }));
    Object.assign(same, { exam: d.exam, fingerprint: d.fingerprint, integerOnly: d.integerOnly, mode: d.mode, questions: d.questions, updated: Date.now() });
    store.save();
    toast(`${d.students.length} öğrencilik liste güncellendi.`, 'ok');
    return openExam(same.id);
  }
  const exam = {
    id: uid(),
    created: Date.now(),
    updated: Date.now(),
    exam: d.exam,
    fingerprint: d.fingerprint,
    integerOnly: d.integerOnly,
    mode: d.mode,
    questions: d.questions,
    students: d.students.map((s) => ({ no: s.no, name: s.name, scores: Array(d.questions.length).fill('') })),
  };
  store.data.exams.push(exam);
  store.save();
  toast(`${exam.students.length} öğrenci, ${exam.questions.length} soru alındı.`, 'ok');
  openExam(exam.id);
}

// ------------------------------------------------------------------ elle oluştur
// e-Okul "Ders Notu Girişi" sütunları
const DN_ALL = ['1.Sınav', '2.Sınav', '3.Sınav', '4.Sınav', '5.Sınav', '6.Sınav', '1.Perf.', '2.Perf.', '3.Perf.', '1.Uyg.', '2.Uyg.', '3.Uyg.', 'Proje'];
const DN_DEFAULT = ['1.Sınav', '2.Sınav', '1.Perf.', '2.Perf.'];
$('#setupDnList').innerHTML = DN_ALL.map((l) => `<label><input type="checkbox" name="dncol" value="${esc(l)}"${DN_DEFAULT.includes(l) ? ' checked' : ''}>${esc(l)}</label>`).join('');
const setupMode = () => (document.querySelector('#setupForm input[name=ntype]:checked') || {}).value || 'oyss';
function renderSetupMode() {
  const dn = setupMode() === 'dersnotu';
  $('#setupOyss').hidden = dn;
  $('#setupDN').hidden = !dn;
  $('#setupErr').textContent = '';
}
document.querySelectorAll('#setupForm input[name=ntype]').forEach((r) => r.addEventListener('change', renderSetupMode));

$('#btnManual').onclick = () => {
  $('#setupErr').textContent = '';
  renderSetupMode();
  go('setup');
};
$('#setupForm').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const errs = [];
  const mode = setupMode();
  let questions;
  if (mode === 'dersnotu') {
    const cols = f.getAll('dncol').map(String);
    questions = DN_ALL.filter((l) => cols.includes(l)).map((label) => ({ max: 100, label }));
    if (!questions.length) errs.push('En az bir not sütunu seçin.');
  } else {
    const maxText = String(f.get('maxes') || '').trim();
    questions = maxText
      .split(/[,;\s]+/)
      .filter(Boolean)
      .map((x) => ({ max: parseScore(x).value }));
    const qv = validateQuestions(questions);
    if (!maxText) errs.push('Soru maksimum puanlarını yazın (ör. 20,10,10,20,10,10,10,10).');
    else errs.push(...qv.errors);
  }
  const students = [];
  const seen = new Set();
  String(f.get('students') || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((l, i) => {
      const m = l.match(/^(\d+)[\s.,;:\t-]*(.*)$/);
      if (!m) return errs.push(`${i + 1}. satır okul numarasıyla başlamalı: "${l}"`);
      if (seen.has(m[1])) return errs.push(`Okul no ${m[1]} iki kez yazılmış.`);
      seen.add(m[1]);
      students.push({ no: m[1], name: m[2].trim().toLocaleUpperCase('tr-TR'), scores: Array(questions.length).fill('') });
    });
  if (!students.length) errs.push('En az bir öğrenci yazın.');
  if (errs.length) {
    $('#setupErr').textContent = errs.join('\n');
    return;
  }
  const exam = {
    id: uid(),
    created: Date.now(),
    updated: Date.now(),
    exam: { sinifSube: String(f.get('sinifSube') || '').trim(), ders: String(f.get('ders') || '').trim(), sinav: String(f.get('sinav') || '').trim() },
    fingerprint: '',
    integerOnly: mode === 'dersnotu' || !!f.get('integerOnly'),
    mode,
    questions,
    students,
  };
  store.data.exams.push(exam);
  store.save();
  e.target.reset();
  renderSetupMode();
  openExam(exam.id);
};

// ------------------------------------------------------------------ puan girişi
const Q = () => current.questions.length;
const stu = () => current.students[cur.r];
// OYSS: G satırın tamamı içindir. Ders notunda G kutu bazındadır (satır "girmedi" sayılmaz).
const isAbsentRow = (s) => current.mode !== 'dersnotu' && s.scores.some(isAbsentMark);

function setMode(mode) {
  cur.mode = mode;
  document.querySelectorAll('.mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}
document.querySelector('.mode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setMode(b.dataset.mode), renderEntry();
});

function renderEntry(msg = '', msgKind = '') {
  if (!current) return go('home');
  const s = stu();
  const v = validateStudent(s, current.questions, { integerOnly: current.integerOnly, mode: current.mode });
  const done = examStats(current);
  $('#eTitle').textContent = examTitle(current);
  $('#eSub').textContent = `${done.done}/${done.total} öğrenci tamam${current.integerOnly ? ' · tam sayı' : ''}`;
  $('#stuNo').textContent = s.no;
  $('#stuName').textContent = s.name || '—';
  $('#stuPos').textContent = `${cur.r + 1} / ${current.students.length}`;
  $('#chips').innerHTML =
    current.questions
      .map((q, i) => {
        const c = v.cells[i];
        const val = s.scores[i] ?? '';
        return `<button data-q="${i}" class="${i === cur.q ? 'cur' : ''} ${c && c.status === 'error' ? 'err' : ''}"><small>${esc(q.label || `${i + 1}.S`)} /${formatNumber(q.max)}</small><b>${esc(isAbsentMark(val) ? 'G' : val)}</b></button>`;
      })
      .join('') + `<button class="tot" disabled><small>${isDN() ? 'Ortalama' : 'Toplam'}</small><b>${lastVal(v)}</b></button>`;
  $('#chips').querySelector('.cur')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });

  const val = s.scores[cur.q] ?? '';
  const max = current.questions[cur.q].max;
  const dv = $('#dValue');
  const cell = v.cells[cur.q];
  if (v.status === 'absent' || (v.absent && isAbsentRow(s))) {
    $('#dLabel').textContent = 'Sınava girmedi';
    dv.textContent = 'G';
    dv.className = 'd-value absent';
  } else {
    $('#dLabel').textContent = `${current.questions[cur.q].label || `${cur.q + 1}. Soru`} · en fazla ${formatNumber(max)} puan`;
    dv.textContent = val === '' ? '—' : String(val).replace('.', ',');
    dv.className = 'd-value' + (val === '' ? ' empty' : cell && cell.status === 'error' ? ' err' : '');
  }
  const m = $('#dMsg');
  m.textContent = msg || (cell && cell.status === 'error' ? cell.message : v.errors[0] || '');
  m.className = 'd-msg' + (msgKind === 'err' || (cell && cell.status === 'error') || v.errors.length ? ' err' : '');
  $('#kDot').hidden = !!current.integerOnly;
  $('#btnKagit').hidden = isDN(); // kâğıttan okuma yalnızca OYSS (soru bazlı) kâğıtlar için
}
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  cur.q = +b.dataset.q;
  cur.fresh = true;
  renderEntry();
});
$('#prevStu').onclick = () => moveStudent(-1);
$('#nextStu').onclick = () => moveStudent(1);
function moveStudent(step) {
  const n = current.students.length;
  cur.r = Math.max(0, Math.min(n - 1, cur.r + step));
  if (cur.mode === 'student') cur.q = 0;
  cur.fresh = true;
  renderEntry();
}

function touch() {
  current.updated = Date.now();
  scheduleSave();
}
function setCell(value) {
  stu().scores[cur.q] = value;
  touch();
}

/** Sonraki hücre (öğrenci öğrenci: soru → soru; soru soru: öğrenci → öğrenci) */
function advance() {
  const n = current.students.length;
  cur.fresh = true;
  if (cur.mode === 'student') {
    if (cur.q < Q() - 1 && !isAbsentRow(stu())) cur.q++;
    else if (cur.r < n - 1) (cur.r++, (cur.q = 0));
    else return renderEntry('Son öğrenciye ulaşıldı. 📋 ile listeyi kontrol edebilirsiniz.');
  } else {
    let r = cur.r + 1;
    while (r < n && isAbsentRow(current.students[r])) r++;
    if (r < n) cur.r = r;
    else if (cur.q < Q() - 1) {
      cur.q++;
      cur.r = 0;
      while (cur.r < n - 1 && isAbsentRow(current.students[cur.r])) cur.r++;
      toast(`${cur.q + 1}. soruya geçildi.`, 'ok', 1500);
    } else return renderEntry('Son soru ve son öğrenciye ulaşıldı.');
  }
  renderEntry();
}

function reject(msg) {
  buzz(80);
  const d = $('#display');
  d.classList.remove('shake');
  void d.offsetWidth;
  d.classList.add('shake');
  renderEntry(msg, 'err');
}

async function press(k) {
  if (!current) return;
  const s = stu();
  const max = current.questions[cur.q].max;
  if (k === 'next') return advance();
  if (k === 'G') {
    // Ders notu: G yalnızca bu kutuya (ör. 1.Sınav) yazılır; aynı kutuda tekrar G → kaldır
    if (current.mode === 'dersnotu') {
      const wasG = isAbsentMark(s.scores[cur.q]);
      setCell(wasG ? '' : ABSENT_MARK);
      buzz(15);
      if (wasG) {
        cur.fresh = true;
        return renderEntry('G kaldırıldı.');
      }
      return advance();
    }
    if (isAbsentRow(s)) {
      s.scores = Array(Q()).fill('');
      touch();
      return renderEntry('G kaldırıldı.');
    }
    const filled = s.scores.filter((x) => String(x ?? '').trim() !== '').length;
    if (filled && !(await ask('Sınava girmedi olarak işaretlensin mi?', `<p>Bu öğrencinin ${filled} puanı silinecek.</p>`, 'Evet, G yap'))) return;
    s.scores = Array.from({ length: Q() }, (_, i) => (i === 0 ? ABSENT_MARK : ''));
    touch();
    buzz(15);
    cur.q = 0;
    if (cur.r < current.students.length - 1) {
      cur.r++;
      cur.fresh = true;
    }
    return renderEntry(`${s.no} sınava girmedi olarak işaretlendi.`);
  }
  if (isAbsentRow(s)) {
    if (!(await ask('G işareti kaldırılsın mı?', '<p>Bu öğrenci "sınava girmedi" olarak işaretli. Puan girmek için işaret kaldırılacak.</p>', 'Kaldır'))) return;
    s.scores = Array(Q()).fill('');
    cur.fresh = true;
  }
  const curVal = String(s.scores[cur.q] ?? '');
  if (k === 'empty') {
    setCell('');
    return advance();
  }
  if (k === 'back') {
    setCell(curVal.slice(0, -1));
    cur.fresh = false;
    return renderEntry();
  }
  if (k === 'dot') {
    if (current.integerOnly) return reject('e-Okul yalnızca tam sayı kabul ediyor.');
    const base = cur.fresh ? '0' : curVal || '0';
    if (base.includes('.')) return;
    setCell(base + '.');
    cur.fresh = false;
    return renderEntry();
  }
  if (!/^\d$/.test(k)) return;
  let cand = cur.fresh || curVal === '0' || isAbsentMark(curVal) ? k : curVal + k;
  if (curVal.includes('.') && !cur.fresh) {
    if (curVal.split('.')[1].length >= 2) return reject('En fazla 2 ondalık basamak.');
    cand = curVal + k;
  }
  const num = parseScore(cand).value;
  if (Number.isFinite(max) && num > max) return reject(`${cur.q + 1}. soru en fazla ${formatNumber(max)} puan.`);
  setCell(cand);
  cur.fresh = false;
  buzz(8);
  // Akıllı geçiş: bir rakam daha eklemek maksimumu aşacaksa sonraki hücreye geç
  const decimalStarted = cand.includes('.');
  const noMoreDigits = decimalStarted ? (cand.split('.')[1] || '').length >= 1 : num * 10 > max || (current.integerOnly && cand === '0');
  if (Number.isFinite(max) && noMoreDigits) {
    renderEntry();
    setTimeout(advance, 140);
  } else renderEntry();
}
$('#keypad').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]');
  if (b) press(b.dataset.k);
});
// Fiziksel klavye (tablet / bilgisayarda deneme)
document.addEventListener('keydown', (e) => {
  if ($('#vEntry').hidden || document.querySelector('dialog[open]')) return;
  if (/^\d$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') press('back');
  else if (e.key === 'Enter' || e.key === 'ArrowRight') press('next');
  else if (e.key === 'g' || e.key === 'G') press('G');
  else if (e.key === ',' || e.key === '.') press('dot');
  else if (e.key === 'ArrowLeft') (cur.q = Math.max(0, cur.q - 1)), (cur.fresh = true), renderEntry();
  else if (e.key === 'ArrowDown') moveStudent(1);
  else if (e.key === 'ArrowUp') moveStudent(-1);
  else return;
  e.preventDefault();
});

// ------------------------------------------------------------------ liste
function sumChips(v) {
  const s = v.summary;
  return `<span class="ok">✔ Tamam ${s.ok}</span><span class="${s.incomplete ? 'warn' : ''}">◐ Eksik ${s.incomplete}</span><span class="${s.error ? 'err' : ''}">✖ Hatalı ${s.error}</span><span>○ Boş ${s.empty}</span>${s.absent ? `<span>G ${s.absent}</span>` : ''}`;
}
function renderList() {
  if (!current) return go('home');
  const v = validateSheet({ questions: current.questions, students: current.students, integerOnly: current.integerOnly, mode: current.mode });
  $('#lSub').textContent = examTitle(current);
  $('#lSum').innerHTML = sumChips(v);
  const head = `<tr><th>No</th><th>Ad Soyad</th>${current.questions.map((q, i) => `<th>${esc(q.label || i + 1)}</th>`).join('')}<th>${isDN() ? 'Ort.' : 'Top.'}</th></tr>`;
  $('#lTable').innerHTML =
    head +
    current.students
      .map((s, r) => {
        const sv = v.students[r];
        return `<tr data-r="${r}" class="st-${sv.status}"><td>${esc(s.no)}</td><td class="n">${esc(s.name)}</td>${current.questions
          .map((_, i) => `<td class="${sv.cells[i] && sv.cells[i].status === 'error' ? 'e' : ''}">${esc(isAbsentMark(s.scores[i]) ? 'G' : String(s.scores[i] ?? '').replace('.', ','))}</td>`)
          .join('')}<td><b>${lastVal(sv)}</b></td></tr>`;
      })
      .join('');
}
$('#lTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-r]');
  if (!tr) return;
  cur.r = +tr.dataset.r;
  cur.q = 0;
  cur.fresh = true;
  go('entry');
});

// ------------------------------------------------------------------ gönder
async function renderSend() {
  if (!current) return go('home');
  const v = validateSheet({ questions: current.questions, students: current.students, integerOnly: current.integerOnly, mode: current.mode });
  $('#sSub').textContent = examTitle(current);
  $('#sSum').innerHTML = sumChips(v);
  const warns = [];
  if (v.summary.error) warns.push(`${v.summary.error} öğrencide hatalı puan var; bilgisayarda kırmızı görünecek ve düzeltmeden e-Okul'a aktarılamaz.`);
  if (v.summary.incomplete) warns.push(`${v.summary.incomplete} öğrencide eksik puan var.`);
  if (!current.fingerprint) warns.push('Bu sınav telefonda elle oluşturuldu; bilgisayarda öğrenciler okul numarasıyla eşleştirilecek.');
  $('#sWarn').innerHTML = warns.map((w) => `<p class="warnbox">${esc(w)}</p>`).join('');
  const text = encodeScoresText({ exam: current.exam, fingerprint: current.fingerprint, questions: current.questions, students: current.students, mode: current.mode });
  if (!text.includes('\no\t')) {
    $('#qrHost').innerHTML = '<div class="empty">Henüz puan girilmedi.</div>';
    return;
  }
  const frames = await makeFrames(KIND.SCORES, text);
  qrHandle = renderQR($('#qrHost'), frames);
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); // QR gösterilirken ekran kararmasın
  } catch {}
}
$('#btnShareCsv').onclick = async () => {
  if (!current) return;
  const csv = '﻿' + toCSV(sheetToRows(current));
  const name = makeFileName(current.exam, 'puanlar', 'csv');
  const file = new File([csv], name, { type: 'text/csv' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: examTitle(current) });
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 2000);
  toast('CSV dosyası indirildi.', 'ok');
};

// ------------------------------------------------------------------ kurulum (ana ekrana ekle)
let installEvt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  const box = $('#install');
  box.hidden = false;
  box.innerHTML = '📲 Uygulamayı ana ekrana ekleyin; internetsiz de çalışır. <button class="primary" id="btnInstall">Yükle</button>';
  $('#btnInstall').onclick = async () => {
    installEvt.prompt();
    await installEvt.userChoice;
    box.hidden = true;
  };
});
if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
  const box = $('#install');
  box.hidden = false;
  box.innerHTML = '📲 Ana ekrana eklemek için Safari\'de <b>Paylaş</b> ⬆ düğmesine, sonra <b>Ana Ekrana Ekle</b>\'ye dokunun.';
}

// ------------------------------------------------------------------ kâğıttan okuma
initKagit({
  getExam: () => current,
  saveScores(i, scores) { current.students[i].scores = scores; touch(); },
  toast,
  ask,
  go,
});

// ------------------------------------------------------------------ başlat
store.load();
go('home');
// Yeni sürüm yüklenince kullanıcıyı bilgilendir (eski sürüm açıkken yeni dosyalar arka planda iner)
const eskiKontrol = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => { if (eskiKontrol) toast('Yeni sürüm yüklendi. Uygulamayı kapatıp yeniden açın.', 'ok', 9000); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'))
  navigator.serviceWorker.register('sw.js').catch(() => {});

// Test kancası (yalnızca geliştirme)
globalThis.__ynaMobil = { store, receiveList, press, openExam, go, get current() { return current; }, cur };
