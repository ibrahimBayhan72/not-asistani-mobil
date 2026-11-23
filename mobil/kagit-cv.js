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
const orderCorners = (p) => {
  const s = p.map(([x, y]) => x + y), d = p.map(([x, y]) => y - x);
  return [p[s.indexOf(Math.min(...s))], p[d.indexOf(Math.min(...d))], p[s.indexOf(Math.max(...s))], p[d.indexOf(Math.max(...d))]]; // sol-üst, sağ-üst, sağ-alt, sol-alt
};

// ------------------------------------------------------------------ kâğıdı bul
function bestQuad(cv, bin, minArea) {
  const contours = new cv.MatVector(), hier = new cv.Mat();
  let best = null, bestA = 0;
  try {
    cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > minArea && a > bestA) {
        const peri = cv.arcLength(c, true);
        const ap = new cv.Mat();
        for (const eps of [0.02, 0.03, 0.045]) {
          cv.approxPolyDP(c, ap, eps * peri, true);
          if (ap.rows === 4 && (!cv.isContourConvex || cv.isContourConvex(ap))) {
            best = Array.from({ length: 4 }, (_, j) => [ap.data32S[j * 2], ap.data32S[j * 2 + 1]]);
            bestA = a;
            break;
          }
        }
        ap.delete();
      }
      c.delete();
    }
  } finally { contours.delete(); hier.delete(); }
  return best;
}
/** @returns {[number,number][]|null} sol-üst, sağ-üst, sağ-alt, sol-alt (fotoğraf pikseli) */
export function findPaperCorners(cv, canvas) {
  const mats = [];
  const T = (m) => (mats.push(m), m);
  try {
    const src = T(cv.imread(canvas));
    const gray = T(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const sc = 640 / Math.max(canvas.width, canvas.height);
    const small = T(new cv.Mat());
    cv.resize(gray, small, new cv.Size(Math.round(canvas.width * sc), Math.round(canvas.height * sc)), 0, 0, cv.INTER_AREA);
    cv.GaussianBlur(small, small, new cv.Size(5, 5), 0);
    const minArea = small.cols * small.rows * 0.2;
    let q = null;
    // A: Otsu — açık renkli kâğıt koyu zeminde; yazılar kapama ile kâğıda katılır
    const bin = T(new cv.Mat());
    cv.threshold(small, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const k = T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(17, 17)));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
    q = bestQuad(cv, bin, minArea);
    // B: kenar tabanlı yedek
    if (!q) {
      const ed = T(new cv.Mat());
      cv.Canny(small, ed, 40, 120);
      cv.dilate(ed, ed, k);
      q = bestQuad(cv, ed, minArea);
    }
    return q ? orderCorners(q.map(([x, y]) => [x / sc, y / sc])) : null;
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

// ------------------------------------------------------------------ yön ve sayfa tespiti (küçük resimlerde NCC)
const TW = 96, TH = 136;
function thumbOf(canvas) {
  const c = mk(TW, TH), g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(canvas, 0, 0, TW, TH);
  const d = g.getImageData(0, 0, TW, TH).data, v = new Float32Array(TW * TH);
  let m = 0;
  for (let i = 0; i < v.length; i++) { v[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; m += v[i]; }
  m /= v.length;
  let s = 0;
  for (let i = 0; i < v.length; i++) { v[i] -= m; s += v[i] * v[i]; }
  s = Math.sqrt(s / v.length) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= s;
  return v;
}
const ncc = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s / a.length; };
/** refThumbs: şablon sayfalarının küçük resimleri (thumbOf). expected verilirse yalnızca o sayfaya bakılır. */
export function refThumbs(refCanvases) { return refCanvases.map(thumbOf); }
function bestOrientation(cv, photo, quad, thumbs, expected) {
  let best = { score: -2, rot: 0, page: 0 };
  for (let r = 0; r < 4; r++) {
    const q = quad.slice(r).concat(quad.slice(0, r));
    const small = warpQuad(cv, photo, q, TW * 2, TH * 2);
    const t = thumbOf(small);
    thumbs.forEach((rt, p) => {
      if (expected != null && p !== expected) return;
      const sc = ncc(t, rt);
      if (sc > best.score) best = { score: sc, rot: r, page: p };
    });
  }
  return best;
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

/**
 * Fotoğrafı şablon sayfasına hizalar.
 * @param {HTMLCanvasElement} photo
 * @param {HTMLCanvasElement[]} refs şablon sayfa görüntüleri (aynı ölçek)
 * @param {Float32Array[]} thumbs refThumbs(refs)
 * @param {number|null} expected beklenen sayfa (0 tabanlı) — null ise en iyi eşleşen seçilir
 */
export function alignPage(cv, photo, refs, thumbs, expected = null) {
  let quad = findPaperCorners(cv, photo);
  const paperFound = !!quad;
  if (!quad) quad = [[0, 0], [photo.width, 0], [photo.width, photo.height], [0, photo.height]];
  const o = bestOrientation(cv, photo, quad, thumbs, expected);
  const q = quad.slice(o.rot).concat(quad.slice(0, o.rot));
  const ref = refs[o.page];
  let canvas = warpQuad(cv, photo, q, ref.width, ref.height);
  let refined = false, inliers = 0;
  try {
    const r = refineORB(cv, canvas, ref);
    if (r) { canvas = r.canvas; refined = true; inliers = r.inliers; }
  } catch (e) { /* ince hizalama başarısız → kaba hizalama kalır */ }
  return { canvas, page: o.page, score: o.score, refined, inliers, paperFound, rot: o.rot };
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
export function readBox(aligned, ref, box, S, net, { numeric = true, debug = false } = {}) {
  const x = Math.max(0, Math.floor(box.x * S)), y = Math.max(0, Math.floor(box.y * S));
  const w = Math.min(aligned.width - x, Math.ceil(box.w * S)), h = Math.min(aligned.height - y, Math.ceil(box.h * S));
  if (w < 8 || h < 8) return { crop: '', text: '', conf: 0, ink: 0, digits: [], noise: 0 };
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
