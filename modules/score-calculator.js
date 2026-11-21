// Puan çözümleme ve toplam hesaplama.
// Boş hücre "puan girilmedi" demektir; asla otomatik olarak 0 sayılmaz.

/** "Sınava girmedi" işareti: G, GR, GRM, Girmedi, Sınava Girmedi (büyük/küçük harf fark etmez) */
export const ABSENT_MARK = 'G';
export function isAbsentMark(raw) {
  const t = String(raw ?? '').trim().toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ');
  return /^(g|gr|grm|girmedi|sınava girmedi)$/.test(t);
}

/** "7,5" / "7.5" / " 10 " → sayı; boş → {empty:true}; sayı olmayan → value NaN */
export function parseScore(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { empty: true, value: null };
  const t = s.replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(t)) return { empty: false, value: NaN };
  return { empty: false, value: Number(t) };
}

export const round2 = (n) => Math.round(n * 100) / 100;

/** Ondalık basamak sayısı ("7,25" → 2) */
export function decimalPlaces(raw) {
  const t = String(raw ?? '').trim().replace(',', '.');
  const i = t.indexOf('.');
  return i < 0 ? 0 : t.length - i - 1;
}

/** Bir öğrencinin girilmiş (geçerli) puanlarının toplamı */
export function studentTotal(scores) {
  let sum = 0;
  let filled = 0;
  for (const raw of scores || []) {
    const p = parseScore(raw);
    if (!p.empty && Number.isFinite(p.value)) {
      sum += p.value;
      filled++;
    }
  }
  return { total: round2(sum), filled };
}

/** Soruların maksimum puanlarının toplamı */
export function maxTotal(questions) {
  return round2((questions || []).reduce((a, q) => a + (Number.isFinite(q.max) ? q.max : 0), 0));
}

/** Türkçe gösterim: 7.5 → "7,5" */
export function formatNumber(n) {
  if (n == null || !Number.isFinite(n)) return '';
  return String(round2(n)).replace('.', ',');
}

/** Kullanıcının yazdığı puanı tek biçime getirir ("7.50" → "7,5"); geçersizse aynen bırakır */
export function normalizeScoreText(raw) {
  if (isAbsentMark(raw)) return ABSENT_MARK;
  const p = parseScore(raw);
  if (p.empty) return '';
  if (!Number.isFinite(p.value)) return String(raw).trim();
  return formatNumber(p.value);
}
