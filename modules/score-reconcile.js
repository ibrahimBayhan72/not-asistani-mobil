// Kâğıttan okunan puanları OYSS kurallarıyla uzlaştırır (DOM'a bağlı değildir, Node'da test edilir).
//
// Rakam tanıyıcı her rakam için 10 olasılık verir. Tek başına en olası rakamlar bazen tutarsızdır
// (ör. "10" puanlık soruda "70", ya da soruların toplamı kâğıttaki "Toplam Puan"dan farklı). Kâğıtta iki bağımsız
// bilgi vardır: her sorunun maksimumu ve öğretmenin yazdığı toplam. Bu modül, her kutu için olası okumaları üretir ve
//   • her soru 0..max aralığında,
//   • soruların toplamı = toplam kutusundaki sayı
// koşullarını sağlayan EN OLASI birleşimi seçer. Sonuç yalnızca bir öneridir: değişen kutular işaretlenir, öğretmen onaylar.

/**
 * Bir kutunun rakam olasılıklarından olası sayı okumalarını üretir.
 * @param {{probs:number[]}[]} digits soldan sağa rakamlar
 * @param {number} [k] her rakam için denenecek en olası sınıf sayısı
 * @returns {{text:string, value:number, logp:number}[]} olasılığa göre azalan
 */
export function candidates(digits, k = 3, limit = 12) {
  if (!digits || !digits.length) return [{ text: '', value: 0, logp: 0 }];
  let list = [{ text: '', logp: 0 }];
  for (const d of digits) {
    const top = d.probs.map((p, i) => ({ i, p })).sort((a, b) => b.p - a.p).slice(0, k);
    const next = [];
    for (const c of list) for (const t of top) next.push({ text: c.text + t.i, logp: c.logp + Math.log(Math.max(t.p, 1e-9)) });
    list = next.sort((a, b) => b.logp - a.logp).slice(0, limit * 3);
  }
  return list.map((c) => ({ ...c, value: +c.text })).slice(0, limit);
}

/**
 * @param {{digits:{probs:number[]}[], max:number}[]} questions okunan soru kutuları (çekilmeyen soru: null)
 * @param {{digits:{probs:number[]}[]}|null} total "Toplam Puan" kutusu
 * @param {{maxDrop?:number}} [opt] maxDrop: uzlaşık çözüm en olası okumadan en çok bu kadar (doğal log) daha az olası olabilir
 * @returns {{ok:boolean, values:(string|null)[], total:string|null, changed:boolean[], totalChanged:boolean, reason:string}}
 */
export function reconcile(questions, total, { maxDrop = 3.5 } = {}) {
  const n = questions.length;
  const raw = questions.map((q) => (q ? candidates(q.digits)[0].text : null));
  const rawTotal = total && total.digits && total.digits.length ? candidates(total.digits)[0].text : null;
  const no = (reason) => ({ ok: false, values: raw, total: rawTotal, changed: raw.map(() => false), totalChanged: false, reason });
  if (questions.some((q) => !q)) return no('bazı sorular çekilmedi');
  if (rawTotal == null) return no('toplam okunamadı');

  const opts = questions.map((q) => candidates(q.digits).filter((c) => c.value <= q.max));
  if (opts.some((o) => !o.length)) return no('bir sorunun hiçbir okuması maksimuma uymuyor');
  const best0 = questions.reduce((s, q) => s + candidates(q.digits)[0].logp, 0) + candidates(total.digits)[0].logp;

  // DP: toplam → en iyi log olasılık ve seçimler
  const maxSum = questions.reduce((s, q) => s + q.max, 0);
  let dp = new Map([[0, { lp: 0, pick: [] }]]);
  for (let i = 0; i < n; i++) {
    const nd = new Map();
    for (const [sum, st] of dp) for (const c of opts[i]) {
      const s2 = sum + c.value;
      if (s2 > maxSum) continue;
      const lp = st.lp + c.logp, cur = nd.get(s2);
      if (!cur || lp > cur.lp) nd.set(s2, { lp, pick: [...st.pick, c.text] });
    }
    dp = nd;
  }
  let best = null;
  for (const t of candidates(total.digits)) {
    const st = dp.get(t.value);
    if (!st) continue;
    const lp = st.lp + t.logp;
    if (!best || lp > best.lp) best = { lp, values: st.pick, total: t.text };
  }
  if (!best) return no('toplamla uyumlu okuma bulunamadı');
  if (best0 - best.lp > maxDrop) return no('uyumlu okuma çok düşük olasılıklı');
  const changed = best.values.map((v, i) => v !== raw[i]);
  return { ok: true, values: best.values, total: best.total, changed, totalChanged: best.total !== rawTotal, reason: changed.some(Boolean) || best.total !== rawTotal ? 'toplamla uyumlu hâle getirildi' : 'zaten uyumlu' };
}
