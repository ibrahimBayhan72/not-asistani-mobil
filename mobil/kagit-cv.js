// Kâğıt fotoğrafı işleme (OpenCV.js + modules/digit-net.js). Tüm işlem cihazda yapılır; görüntü hiçbir yere gönderilmez.
//
// Akış: fotoğraf → kâğıdı bul (4 köşe) → yön ve sayfa (4 döndürme × şablon sayfaları, NCC) → perspektif düzelt (şablon boyutuna)
//       → ORB + homografi ile ince hizalama → kutuları kırp → basılı yazıyı çıkar (şablon farkı) → rakamları oku.
import { readNumber } from '../modules/digit-net.js';

// ------------------------------------------------------------------ OpenCV.js yükleme (tembel; ~13 MB, bir kez önbelleğe alınır)
let cvPromise = null;
export function loadCV() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise((resolve, reject) => {
    const fail = (m) => { cvPromise = null; reject(new Error(m)); };
    if (window.cv && window.cv.Mat) return resolve(window.cv);
    const s = document.createElement('script');
    s.src = new URL('./lib/opencv/opencv.js', import.meta.url).href;
    s.onerror = () => fail('Görüntü işleme motoru yüklenemedi. İlk kullanımda internet gerekir (~13 MB); sonra çevrimdışı çalışır.');
    s.onload = async () => {
      try {
        let c = window.cv;
        if (c && typeof c.then === 'function') c = await c;
        else if (c && !c.Mat) await new Promise((r) => (c.onRuntimeInitialized = r));
        window.cv = c;
        resolve(c);
      } catch (e) { fail('Görüntü işleme motoru başlatılamadı: ' + (e && e.message)); }
    };
    document.head.appendChild(s);
  });
  return cvPromise;
}
let netPromise = null;
export function loadNet() {
  return (netPromise ||= fetch(new URL('./lib/digit-net.json', import.meta.url)).then((r) => { if (!r.ok) throw new Error('Rakam modeli yüklenemedi'); return r.json(); }).catch((e) => { netPromise = null; throw e; }));
}

// ------------------------------------------------------------------ yardımcılar
const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
/** Dosyadan (kamera fotoğrafı) tuvale; EXIF yönü uygulanır, uzun kenar maxEdge'e indirilir */
export async function photoToCanvas(file, maxEdge = 2000) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const c = mk(Math.round(bmp.width * k), Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}
/** Tuvali uzun kenarı maxEdge'i geçmeyecek şekilde küçültür (kamera karesi için) */
export function scaleCanvas(src, maxEdge = 2000) {
  const k = Math.min(1, maxEdge / Math.max(src.width, src.height));
  if (k >= 1) return src;
  const c = mk(Math.round(src.width * k), Math.round(src.height * k));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const orderCorners = (p) => {
  const s = p.map(([x, y]) => x + y), d = p.map(([x, y]) => y - x);
  return [p[s.indexOf(Math.min(...s))], p[d.indexOf(Math.min(...d))], p[s.indexOf(Math.max(...s))], p[d.indexOf(Math.max(...d))]]; // sol-üst, sağ-üst, sağ-alt, sol-alt
};

// ------------------------------------------------------------------ kâğıdı bul
const A4_ORAN = 0.707;
const quadAlan = (q) => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0)) / 2;
/** Aday dörtgenin kâğıda benzerliği (0..1): A4 en/boy oranı ve konturun dörtgeni doldurması */
function quadScore(q, konturAlan, resimAlan) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = (d(q[0], q[1]) + d(q[3], q[2])) / 2, h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const oran = Math.min(w, h) / Math.max(w, h);
  const alan = quadAlan(q), ar = alan / resimAlan;
  if (ar < 0.1 || ar > 0.99) return 0;
  const doluluk = Math.min(1, konturAlan / alan);
  return (1 - Math.min(1, Math.abs(oran - A4_ORAN) / 0.25)) * doluluk * doluluk;
}
/** İkili maskeden aday dörtgenler üretir: köşegen yaklaşıklaştırma + en küçük dönük dikdörtgen */
function adaylar(cv, bin, resimAlan) {
  const out = [];
  const contours = new cv.MatVector(), hier = new cv.Mat();
  try {
    cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const list = [];
    for (let i = 0; i < contours.size(); i++) { const c = contours.get(i); list.push({ i, a: cv.contourArea(c) }); c.delete(); }
    list.sort((x, y) => y.a - x.a);
    for (const { i, a } of list.slice(0, 4)) {
      if (a < resimAlan * 0.1) continue;
      const c = contours.get(i);
      const peri = cv.arcLength(c, true);
      const ap = new cv.Mat();
      for (const eps of [0.015, 0.03, 0.05]) {
        cv.approxPolyDP(c, ap, eps * peri, true);
        if (ap.rows === 4 && (!cv.isContourConvex || cv.isContourConvex(ap))) {
          const q = Array.from({ length: 4 }, (_, j) => [ap.data32S[j * 2], ap.data32S[j * 2 + 1]]);
          out.push({ q: orderCorners(q), s: quadScore(q, a, resimAlan) });
          break;
        }
      }
      ap.delete();
      if (cv.minAreaRect && cv.RotatedRect && cv.RotatedRect.points) {
        const q = cv.RotatedRect.points(cv.minAreaRect(c)).map((p) => [p.x, p.y]);
        out.push({ q: orderCorners(q), s: quadScore(q, a, resimAlan) * 0.97 });
      }
      c.delete();
    }
  } finally { contours.delete(); hier.delete(); }
  return out;
}
/**
 * Fotoğrafta kâğıdın 4 köşesini bulur. Kâğıt nötr (düşük doygunluk) ve açık renklidir; masa genellikle renklidir (ahşap vb.).
 * Bu yüzden önce renk (doygunluk) ayrımı, yedek olarak gri tonlama eşiği ve kenar tabanlı yöntemler denenir;
 * hepsinin adayları A4 en/boy oranına ve dikdörtgenliğe göre puanlanır, en iyisi seçilir.
 * @returns {[number,number][]|null} sol-üst, sağ-üst, sağ-alt, sol-alt (fotoğraf pikseli)
 */
export function findPaperCorners(cv, canvas) {
  const mats = [];
  const T = (m) => (mats.push(m), m);
  try {
    const src = T(cv.imread(canvas));
    const sc = 640 / Math.max(canvas.width, canvas.height);
    const small = T(new cv.Mat());
    cv.resize(src, small, new cv.Size(Math.round(canvas.width * sc), Math.round(canvas.height * sc)), 0, 0, cv.INTER_AREA);
    cv.GaussianBlur(small, small, new cv.Size(5, 5), 0);
    const resimAlan = small.cols * small.rows;
    const all = [];
    const k21 = T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(21, 21)));
    const k7 = T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)));

    // A: renk — kâğıt nötr/mavimsi (R ≤ B), ahşap ve benzeri masa yüzeyleri kırmızımsıdır (R − B büyük).
    //    Güneşten solmuş ahşapta bile R − B kâğıttakinden belirgin yüksektir; doygunluk eşiğinden daha ayırt edicidir.
    const rgb = T(new cv.Mat()), hsv = T(new cv.Mat());
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const rgbCh = T(new cv.MatVector());
    cv.split(rgb, rgbCh);
    const R = T(rgbCh.get(0)), B = T(rgbCh.get(2));
    const hsvCh = T(new cv.MatVector());
    cv.split(hsv, hsvCh);
    const V = T(hsvCh.get(2)), S = T(hsvCh.get(1));
    const vm = T(new cv.Mat());
    cv.threshold(V, vm, 100, 255, cv.THRESH_BINARY);
    {
      const D = T(new cv.Mat()), dm = T(new cv.Mat()), renk = T(new cv.Mat());
      cv.subtract(R, B, D); // doygun çıkarma: R ≤ B ise 0
      cv.threshold(D, dm, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      cv.bitwise_and(dm, vm, renk);
      cv.morphologyEx(renk, renk, cv.MORPH_CLOSE, k21);
      cv.morphologyEx(renk, renk, cv.MORPH_OPEN, k7);
      all.push(...adaylar(cv, renk, resimAlan));
    }
    {
      // A2: düşük doygunluk (S ≤ Otsu)
      const sm = T(new cv.Mat()), renk = T(new cv.Mat());
      cv.threshold(S, sm, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      cv.bitwise_and(sm, vm, renk);
      cv.morphologyEx(renk, renk, cv.MORPH_CLOSE, k21);
      cv.morphologyEx(renk, renk, cv.MORPH_OPEN, k7);
      all.push(...adaylar(cv, renk, resimAlan).map((x) => ({ ...x, s: x.s * 0.97 })));
    }

    // B: gri tonlama Otsu (koyu zemin üzerinde açık kâğıt)
    const gray = T(new cv.Mat()), bin = T(new cv.Mat());
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k21);
    all.push(...adaylar(cv, bin, resimAlan).map((x) => ({ ...x, s: x.s * 0.9 })));

    // C: kenar tabanlı yedek
    const ed = T(new cv.Mat());
    cv.Canny(gray, ed, 40, 120);
    cv.dilate(ed, ed, k21);
    all.push(...adaylar(cv, ed, resimAlan).map((x) => ({ ...x, s: x.s * 0.8 })));

    all.sort((x, y) => y.s - x.s);
    const best = all[0];
    return best && best.s >= 0.3 ? best.q.map(([x, y]) => [x / sc, y / sc]) : null;
  } finally { mats.forEach((m) => m.delete()); }
}

// ------------------------------------------------------------------ perspektif düzeltme
export function warpQuad(cv, canvas, quad, W, H) {
  const src = cv.imread(canvas), dst = new cv.Mat();
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(from, to);
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    const out = mk(W, H);
    cv.imshow(out, dst);
    return out;
  } finally { [src, dst, from, to, M].forEach((m) => m.delete()); }
}

// ------------------------------------------------------------------ yön ve sayfa tespiti (küçük resimlerde korelasyon)
// Işık/gölge etkisini atmak için görüntüden bulanık hâli çıkarılır (yüksek geçiren filtre): geriye metin satırları,
// tablo çizgileri ve başlık blokları kalır; bunlar sayfaya özgüdür ve 4 yön ile sayfa seçimini ayırt eder.
const TW = 160, TH = 226;
function boxBlur(src, w, h, r) {
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) I[(y + 1) * W1 + x + 1] = src[y * w + x] + I[y * W1 + x + 1] + I[(y + 1) * W1 + x] - I[y * W1 + x];
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}
function thumbOf(canvas) {
  const c = mk(TW, TH), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, TW, TH);
  const d = g.getImageData(0, 0, TW, TH).data, lum = new Float32Array(TW * TH);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const bl = boxBlur(lum, TW, TH, 7), v = new Float32Array(TW * TH);
  let m = 0;
  for (let i = 0; i < v.length; i++) { v[i] = lum[i] - bl[i]; m += v[i]; }
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= m; s += v[i] * v[i]; }
  s = Math.sqrt(s / v.length) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}
const ncc = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / a.length; };
/** refThumbs: şablon sayfalarının küçük resimleri (thumbOf). */
export function refThumbs(refCanvases) { return refCanvases.map(thumbOf); }
/** 4 yön × şablon sayfaları içinde en iyi eşleşmeyi (ve ikinciyi) bulur; expected verilirse yalnızca o sayfaya bakılır. */
function adayYonler(cv, photo, quad, thumbs, expected, n = 3) {
  const list = [];
  for (let r = 0; r < 4; r++) {
    const q = quad.slice(r).concat(quad.slice(0, r));
    const t = thumbOf(warpQuad(cv, photo, q, TW * 2, TH * 2));
    thumbs.forEach((rt, p) => { if (expected == null || p === expected) list.push({ score: ncc(t, rt), rot: r, page: p }); });
  }
  return list.sort((x, y) => y.score - x.score).slice(0, n);
}

// ------------------------------------------------------------------ ORB + homografi ile ince hizalama
function refineORB(cv, warped, ref) {
  const mats = [];
  const T = (m) => (mats.push(m), m);
  try {
    const a = T(cv.imread(warped)), b = T(cv.imread(ref));
    const ga = T(new cv.Mat()), gb = T(new cv.Mat());
    cv.cvtColor(a, ga, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(b, gb, cv.COLOR_RGBA2GRAY);
    const orb = new cv.ORB(2500);
    const k1 = new cv.KeyPointVector(), k2 = new cv.KeyPointVector();
    const d1 = T(new cv.Mat()), d2 = T(new cv.Mat());
    orb.detectAndCompute(ga, T(new cv.Mat()), k1, d1);
    orb.detectAndCompute(gb, T(new cv.Mat()), k2, d2);
    try {
      if (d1.rows < 30 || d2.rows < 30) return null;
      const bf = new cv.BFMatcher(cv.NORM_HAMMING, true);
      const ms = new cv.DMatchVector();
      bf.match(d1, d2, ms);
      const list = [];
      for (let i = 0; i < ms.size(); i++) { const m = ms.get(i); list.push({ q: m.queryIdx, t: m.trainIdx, d: m.distance }); }
      ms.delete(); bf.delete();
      list.sort((x, y) => x.d - y.d);
      const top = list.slice(0, 400);
      if (top.length < 20) return null;
      const sp = [], dp = [];
      for (const m of top) { const p = k1.get(m.q).pt, q = k2.get(m.t).pt; sp.push(p.x, p.y); dp.push(q.x, q.y); }
      const S = T(cv.matFromArray(top.length, 1, cv.CV_32FC2, sp)), D = T(cv.matFromArray(top.length, 1, cv.CV_32FC2, dp));
      const mask = T(new cv.Mat());
      const H = T(cv.findHomography(S, D, cv.RANSAC, 3, mask));
      if (H.empty()) return null;
      let inl = 0;
      for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inl++;
      if (inl < 18) return null;
      // makullük: köşeler şablon boyutunun %6'sından fazla kaymamalı
      const h = H.data64F, W = ref.width, Hh = ref.height;
      const proj = ([x, y]) => { const z = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z]; };
      for (const c of [[0, 0], [W, 0], [W, Hh], [0, Hh]]) { const p = proj(c); if (Math.hypot(p[0] - c[0], p[1] - c[1]) > 0.06 * Math.max(W, Hh)) return null; }
      const dst = T(new cv.Mat());
      cv.warpPerspective(a, dst, H, new cv.Size(W, Hh), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const out = mk(W, Hh);
      cv.imshow(out, dst);
      return { canvas: out, inliers: inl };
    } finally { k1.delete(); k2.delete(); orb.delete(); }
  } finally { mats.forEach((m) => m.delete()); }
}

// ------------------------------------------------------------------ doğrudan özellik eşleştirmesi
// Fotoğraftaki ORB özelliklerini şablon sayfalarınınkilerle eşleştirir (ölçek ve döndürmeden bağımsız); kâğıdın kenarlarını
// bulmaya gerek kalmaz: kâğıt kadrajda küçük de olsa, masa renkli/açık da olsa, ters de çekilse çalışır.
const refOzellik = new WeakMap();
function ozellikler(cv, canvas, nfeat) {
  const m = cv.imread(canvas), g = new cv.Mat(), mask = new cv.Mat();
  const orb = new cv.ORB(nfeat), kp = new cv.KeyPointVector(), des = new cv.Mat();
  try {
    cv.cvtColor(m, g, cv.COLOR_RGBA2GRAY);
    orb.detectAndCompute(g, mask, kp, des);
    const pts = new Float32Array(kp.size() * 2);
    for (let i = 0; i < kp.size(); i++) { const p = kp.get(i).pt; pts[i * 2] = p.x; pts[i * 2 + 1] = p.y; }
    return { des, pts, n: kp.size() };
  } finally { m.delete(); g.delete(); mask.delete(); orb.delete(); kp.delete(); }
}
function refOz(cv, canvas) {
  let o = refOzellik.get(canvas);
  if (!o) { o = ozellikler(cv, canvas, 3000); refOzellik.set(canvas, o); }
  return o;
}
/** İki özellik kümesini eşleştirir (oran testi) ve RANSAC homografisi (kaynak → hedef) bulur */
function esle(cv, A, B) {
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
  const mm = new cv.DMatchVectorVector();
  const sp = [], dp = [];
  try {
    bf.knnMatch(A.des, B.des, mm, 2);
    for (let i = 0; i < mm.size(); i++) {
      const v = mm.get(i);
      if (v.size() < 2) { v.delete(); continue; }
      const m1 = v.get(0), m2 = v.get(1);
      if (m1.distance < 0.78 * m2.distance) { sp.push(A.pts[m1.queryIdx * 2], A.pts[m1.queryIdx * 2 + 1]); dp.push(B.pts[m1.trainIdx * 2], B.pts[m1.trainIdx * 2 + 1]); }
      v.delete();
    }
  } finally { mm.delete(); bf.delete(); }
  const n = sp.length / 2;
  if (n < 12) return { n, inliers: 0, H: null };
  const S = cv.matFromArray(n, 1, cv.CV_32FC2, sp), D = cv.matFromArray(n, 1, cv.CV_32FC2, dp), mask = new cv.Mat();
  let H = null, inl = 0;
  try {
    const h = cv.findHomography(S, D, cv.RANSAC, 4.0, mask);
    if (!h.empty()) { for (let i = 0; i < mask.rows; i++) if (mask.data[i]) inl++; H = h; } else h.delete();
  } finally { S.delete(); D.delete(); mask.delete(); }
  return { n, inliers: inl, H };
}
/** @returns {{canvas, page, inliers, ikinci}|null} */
function dogrudanHizala(cv, photo, refs, beklenen) {
  const A = ozellikler(cv, photo, 3000);
  try {
    if (A.n < 30) return null;
    let best = null, ikinci = 0;
    refs.forEach((ref, p) => {
      if (beklenen != null && p !== beklenen) return;
      const r = esle(cv, A, refOz(cv, ref));
      if (!best || r.inliers > best.inliers) { if (best && best.H) { ikinci = Math.max(ikinci, best.inliers); best.H.delete(); } best = { ...r, page: p }; }
      else { ikinci = Math.max(ikinci, r.inliers); if (r.H) r.H.delete(); }
    });
    if (!best || !best.H || best.inliers < 25 || (beklenen == null && refs.length > 1 && best.inliers < 1.4 * ikinci)) { if (best && best.H) best.H.delete(); return { inliers: best ? best.inliers : 0, ikinci, ok: false }; }
    // fotoğrafı şablon sayfasına çevir
    const ref = refs[best.page];
    const src = cv.imread(photo), dst = new cv.Mat();
    try {
      cv.warpPerspective(src, dst, best.H, new cv.Size(ref.width, ref.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const out = mk(ref.width, ref.height);
      cv.imshow(out, dst);
      return { ok: true, canvas: out, page: best.page, inliers: best.inliers, ikinci };
    } finally { src.delete(); dst.delete(); best.H.delete(); }
  } finally { A.des.delete(); }
}

/**
 * Fotoğrafı şablon sayfasına hizalar. Sonuçtaki `ok` güvenilirliği söyler: yanlış sayfaya/yere okumamak için
 * ok=false ise çekim reddedilmelidir.
 * 1) Doğrudan özellik eşleştirmesi (kâğıdı bulmadan, ölçek/döndürmeden bağımsız).
 * 2) Kâğıt köşeleri → 4 yön × sayfa seçimi (yüksek geçirgen korelasyon) → ORB ince hizalama.
 * Not: ECC (findTransformECC) bilerek KULLANILMAZ: yakınsamadığında OpenCV.js belleğini bozuyor ve farklı kâğıtlarda bile
 * yüksek korelasyon verebiliyor (yanlış sayfayı kabul ettirir).
 * @param {HTMLCanvasElement} photo
 * @param {HTMLCanvasElement[]} refs şablon sayfa görüntüleri (aynı ölçek)
 * @param {Float32Array[]} thumbs refThumbs(refs)
 * @param {number|null} expected beklenen sayfa (0 tabanlı) — null ise en iyi eşleşen seçilir
 */
export function alignPage(cv, photo, refs, thumbs, expected = null) {
  let d = null;
  try { d = dogrudanHizala(cv, photo, refs, expected); } catch (e) { d = null; }
  if (d && d.ok) {
    let canvas = d.canvas, inliers = d.inliers;
    try { const r = refineORB(cv, canvas, refs[d.page]); if (r) { canvas = r.canvas; inliers = Math.max(inliers, r.inliers); } } catch (e) { /* kaba hizalama kalır */ }
    return { ok: true, canvas, page: d.page, score: 1, refined: true, inliers, paperFound: true, rot: 0, yontem: 'ozellik', ikinci: d.ikinci };
  }
  let quad = findPaperCorners(cv, photo);
  const paperFound = !!quad;
  if (!quad) quad = [[0, 0], [photo.width, 0], [photo.width, photo.height], [0, photo.height]];
  // En iyi birkaç (yön, sayfa) adayı gerçekten hizalanıp sınanır; ince hizalama sonucu en yüksek olan seçilir.
  // Yanlış sayfa ORB'da az eşleşme verir; ORB ile doğrulanamayan çekim reddedilir.
  const sonuclar = [];
  for (const o of adayYonler(cv, photo, quad, thumbs, expected)) {
    const q = quad.slice(o.rot).concat(quad.slice(0, o.rot));
    const ref = refs[o.page];
    const canvas = warpQuad(cv, photo, q, ref.width, ref.height);
    let r = null;
    try { r = refineORB(cv, canvas, ref); } catch (e) { r = null; }
    if (r) sonuclar.push({ q: r.inliers, canvas: r.canvas, inliers: r.inliers, yontem: 'kose+orb', o });
    else sonuclar.push({ q: 0, canvas, inliers: 0, yontem: 'kose', o });
  }
  sonuclar.sort((x, y) => y.q - x.q);
  const s = sonuclar[0], iki = sonuclar[1] ? sonuclar[1].q : 0;
  const ok = s.q > 0 && (iki === 0 || s.q >= 1.3 * iki); // ORB doğruladı ve ikinci adaydan belirgin iyi
  return { ok, canvas: s.canvas, refined: s.q > 0, inliers: s.inliers, yontem: s.yontem, page: s.o.page, score: s.o.score, margin: s.q - iki, paperFound, rot: s.o.rot, ozellikInliers: d ? d.inliers : 0 };
}

// ------------------------------------------------------------------ mürekkep (el yazısı) çıkarma
function dilate(bin, w, h, r) {
  const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = -r; k <= r && !v; k++) { const xx = x + k; if (xx >= 0 && xx < w && bin[y * w + xx]) v = 1; } t[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = -r; k <= r && !v; k++) { const yy = y + k; if (yy >= 0 && yy < h && t[yy * w + x]) v = 1; } o[y * w + x] = v; }
  return o;
}
/**
 * Fotoğraf kırpığındaki el yazısını ikili maskeye çevirir; şablondaki (boş kâğıt) basılı öğeler çıkarılır.
 * Kalem rengi fark etmez: koyuluk = 255 − min(R,G,B).
 */
export function inkMask(photo, ref, dilateR = 3) {
  const { width: w, height: h } = photo, n = w * h;
  const g = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = Math.min(photo.data[i * 4], photo.data[i * 4 + 1], photo.data[i * 4 + 2]); g[i] = v; hist[v]++; }
  let acc = 0, bg = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.85) { bg = v; break; } }
  const thr = Math.max(28, bg * 0.2);
  const printed = new Uint8Array(n);
  if (ref) for (let i = 0; i < n; i++) printed[i] = 255 - Math.min(ref.data[i * 4], ref.data[i * 4 + 1], ref.data[i * 4 + 2]) > 90 ? 1 : 0;
  const pd = dilate(printed, w, h, dilateR);
  const mask = new Uint8Array(n);
  let ink = 0;
  for (let i = 0; i < n; i++) if (bg - g[i] > thr && !pd[i]) { mask[i] = 1; ink++; }
  return { mask, w, h, ink: ink / n };
}

/**
 * Hizalanmış sayfadan bir kutuyu (PDF pt) kırpar, el yazısını çıkarır ve (sayı alanıysa) okur.
 * @returns {{crop:string, text:string, conf:number, ink:number, digits:object[], noise:number}}
 */
/**
 * Okuma alanı basılı bir çerçevenin (ör. "| ___ / 16 puan |" kutusu) kenarını içine alıyorsa alanı çerçevenin içine daraltır.
 * Basılı çizgiler mürekkep maskesinden silindiği için çizginin üstüne denk gelen rakam parçası ("1") da silinirdi.
 * Dikey çizgi: sütundaki koyu piksel oranı alan yüksekliğinin %45'ini aşar. Yalnızca sol kenar (sağ sınır zaten "/" işaretidir).
 * @returns {{l:number, r:number}} piksel sınırları
 */
export function cerceveIci(refData, w, h) {
  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) { let k = 0; for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; if (Math.min(refData[i], refData[i + 1], refData[i + 2]) < 140) k++; } col[x] = k / h; }
  let l = 0, r = w;
  for (let x = 0; x < Math.floor(w * 0.4); x++) if (col[x] > 0.45) l = x + 3;
  return r - l >= 12 ? { l, r } : { l: 0, r: w };
}

export function readBox(aligned, ref, box, S, net, { numeric = true, debug = false, frame = false } = {}) {
  let x = Math.max(0, Math.floor(box.x * S)), y = Math.max(0, Math.floor(box.y * S));
  let w = Math.min(aligned.width - x, Math.ceil(box.w * S)), h = Math.min(aligned.height - y, Math.ceil(box.h * S));
  if (w < 8 || h < 8) return { crop: '', text: '', conf: 0, ink: 0, digits: [], noise: 0 };
  if (frame) { const k = cerceveIci(ref.getContext('2d').getImageData(x, y, w, h).data, w, h); x += k.l; w -= k.l; } // yalnızca soldaki çerçeve kenarı
  const pa = aligned.getContext('2d').getImageData(x, y, w, h);
  const pr = ref.getContext('2d').getImageData(x, y, w, h);
  const c = mk(w, h);
  c.getContext('2d').putImageData(pa, 0, 0);
  const crop = c.toDataURL('image/jpeg', 0.85);
  const { mask, ink } = inkMask(pa, pr);
  if (!numeric) return { crop, text: '', conf: 0, ink, digits: [], noise: 0 };
  const r = readNumber(mask, w, h, net);
  let maskUrl;
  if (debug) { // tanılama: maskeyi (siyah zemin, beyaz mürekkep) ve bulunan rakam kutularını çiz
    const mc = mk(w, h), mg = mc.getContext('2d'), id = mg.createImageData(w, h);
    for (let i = 0; i < w * h; i++) { const v = mask[i] ? 255 : 0; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    mg.putImageData(id, 0, 0); mg.strokeStyle = '#f0c'; for (const d of r.digits) mg.strokeRect(d.box[0], d.box[1], d.box[2] - d.box[0] + 1, d.box[3] - d.box[1] + 1);
    maskUrl = mc.toDataURL();
  }
  return { crop, text: r.text, conf: r.conf, ink, digits: r.digits, noise: r.noise, maskUrl };
}

/** Yalnızca tanılama/test için (bellek sızıntısı avı) */
export const _dbg = { dogrudanHizala, refineORB, adayYonler };
