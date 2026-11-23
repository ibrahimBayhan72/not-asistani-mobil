// Sınav kâğıdı şablonu: PDF'nin metin katmanından puan kutularının ("___ / 10 puan"), öğrenci numarasının,
// adın, sınıfın ve "Toplam Puan" kutusunun yerini bulur. DOM'a bağlı değildir (Node'da test edilir).
//
// Koordinatlar: PDF noktası (1 pt = 1/72 inç), başlangıç sol-üst, y aşağı doğru.
// items: [{str, x, y, w, h}] — y = metin satırının ÜST kenarı, h = yazı yüksekliği.

/** pdf.js getTextContent() öğelerini {str,x,y,w,h} biçimine çevirir (pageHeight = sayfa yüksekliği, pt) */
export function itemsFromPdfjs(textItems, pageHeight) {
  const out = [];
  for (const it of textItems) {
    if (typeof it.str !== 'string' || !it.transform) continue;
    const h = it.height || Math.abs(it.transform[3]) || 10;
    out.push({ str: it.str, x: it.transform[4], y: pageHeight - it.transform[5] - h, w: it.width || 0, h });
  }
  return out;
}

/** Bir öğenin içinde regex eşleşmesinin alt konumunu (yaklaşık: eşit harf genişliği) bulur */
function locate(items, re) {
  const found = [];
  for (const it of items) {
    const m = re.exec(it.str);
    if (!m || !it.str.length) continue;
    const cw = it.w / it.str.length;
    found.push({ x: it.x + cw * m.index, w: cw * m[0].length, y: it.y, h: it.h, item: it, m });
  }
  return found;
}
const sameLine = (a, b) => Math.abs(a.y - b.y) < Math.max(a.h, b.h) * 0.6;

/** Bu sayfadaki puan kutuları, öğrenci no/ad/sınıf alanları ve toplam kutusu */
export function detectPage(items, pageW, pageH) {
  const out = { blanks: [], no: null, name: null, sinif: null, total: null };

  // ---- "___ / 10 puan" kutuları
  for (const u of locate(items, /_{2,}/)) {
    // "___ / 10 puan" tek öğede, "___ /" + "10" + "puan" üç öğede ya da her biri ayrı olabilir (pdf.js PDF'e göre böler):
    // öğenin kendi kalanı + aynı satırda sağındaki öğeler birleştirilir.
    const after = u.item.str.slice(u.m.index + u.m[0].length);
    const right = items.filter((o) => o !== u.item && sameLine(o, u) && o.x >= u.item.x + u.item.w - 2).sort((a, b) => a.x - b.x).slice(0, 5);
    const tail = [after, ...right.map((o) => o.str)].join(' ');
    const mm = /^\s*\/\s*(\d+)\s*puan/i.exec(tail);
    if (!mm) continue;
    const slashX = u.x + u.w + 2;
    const left = Math.max(2, u.x - 16);
    out.blanks.push({ x: left, y: u.y - 14, w: Math.max(20, slashX - left - 1), h: u.h + 18, max: +mm[1] });
  }
  out.blanks.sort((a, b) => a.y - b.y || a.x - b.x);

  // ---- başlık alanları
  const no = locate(items, /[ÖO]ğrenci\s*Numaras[ıi]\s*:?/i)[0];
  const sinif = locate(items, /S[ıi]n[ıi]f[ıi]?\s*\/\s*[ŞS]ubesi\s*:?/i)[0];
  const ad = locate(items, /Ad[ıi]\s*ve\s*Soyad[ıi]\s*:?/i)[0] || locate(items, /Soyad[ıi]\s*:/i)[0];
  const rightMargin = pageW - 34;
  if (no) out.no = { x: no.x + no.w + 2, y: no.y - 10, w: Math.max(30, rightMargin - (no.x + no.w + 2)), h: no.h + 16 };
  if (sinif) out.sinif = { x: sinif.x + sinif.w + 2, y: sinif.y - 6, w: Math.max(30, (no ? no.x : rightMargin) - (sinif.x + sinif.w + 2) - 4), h: sinif.h + 12 };
  if (ad) out.name = { x: ad.x + ad.w + 2, y: ad.y - 6, w: Math.max(30, (sinif ? sinif.x : rightMargin) - (ad.x + ad.w + 2) - 4), h: ad.h + 12 };

  // ---- "Toplam Puan" kutusu (etiketin altı)
  const top = locate(items, /Toplam\s*Puan/i)[0] || locate(items, /Toplam/i)[0];
  if (top) {
    const pu = locate(items, /^Puan$/i).find((p) => sameLine(p, top) && p.x > top.x);
    const x1 = pu ? pu.x + pu.w : top.x + top.w;
    // yazı alanı kutunun çizgilerinin İÇİNDE tutulur: kutu çizgileri kırpığa girerse rakama yapışıp yanlış okutur
    out.total = { x: top.x + 1, y: top.y + top.h + 4, w: Math.max(30, x1 - top.x - 2), h: 16 };
  }
  return out;
}

/**
 * Tüm sayfaları birleştirip soruları sıraya dizer (sayfa, sonra yukarıdan aşağı).
 * @param {{blanks:{x,y,w,h,max}[], no?:object, name?:object, sinif?:object, total?:object}[]} pages detectPage çıktıları (sayfa sırasıyla)
 * @param {{max:number}[]} questions sınavın soruları (e-Okul listesinden)
 */
export function buildTemplate(pages, questions = []) {
  const blanks = [];
  pages.forEach((p, pi) => p.blanks.forEach((b) => blanks.push({ ...b, page: pi })));
  const notes = [];
  let ok = true;
  if (!blanks.length) { ok = false; notes.push('PDF\'de "___ / N puan" kutusu bulunamadı (metin katmanı yok olabilir). Kutuları elle işaretleyin.'); }
  else if (questions.length && blanks.length !== questions.length) {
    ok = false;
    notes.push(`PDF'de ${blanks.length} puan kutusu bulundu, sınavda ${questions.length} soru var.`);
  }
  if (questions.length) {
    const diff = blanks.map((b, i) => (questions[i] && Number.isFinite(questions[i].max) && questions[i].max !== b.max ? `${i + 1}. soru: PDF'de ${b.max}, sınavda ${questions[i].max}` : null)).filter(Boolean);
    if (diff.length) { ok = false; notes.push('Maksimum puanlar uyuşmuyor → ' + diff.join('; ')); }
  }
  const first = (k) => { const i = pages.findIndex((p) => p[k]); return i >= 0 ? { ...pages[i][k], page: i } : null; };
  return { blanks, no: first('no'), name: first('name'), sinif: first('sinif'), total: first('total'), ok, notes, pageCount: pages.length };
}
