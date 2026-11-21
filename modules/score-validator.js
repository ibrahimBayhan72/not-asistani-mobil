// Soru bazlı puan doğrulama kuralları.
import { parseScore, decimalPlaces, studentTotal, maxTotal, formatNumber, isAbsentMark } from './score-calculator.js';

export const TOTAL_LIMIT = 100;
export const MAX_DECIMALS = 2;

/**
 * Tek bir hücreyi doğrular.
 * @param {{integerOnly?:boolean}} [opts] integerOnly: e-Okul kutuları yalnızca tam sayı kabul ediyorsa
 * @returns {{status:'ok'|'empty'|'error', value:number|null, message:string}}
 */
export function validateScore(raw, max, opts = {}) {
  const p = parseScore(raw);
  if (p.empty) return { status: 'empty', value: null, message: 'Puan girilmedi' };
  if (Number.isNaN(p.value)) return { status: 'error', value: null, message: 'Sayı değil' };
  if (p.value < 0) return { status: 'error', value: null, message: 'Negatif puan girilemez' };
  if (decimalPlaces(raw) > MAX_DECIMALS)
    return { status: 'error', value: null, message: `En fazla ${MAX_DECIMALS} ondalık basamak` };
  if (opts.integerOnly && !Number.isInteger(p.value))
    return { status: 'error', value: p.value, message: "e-Okul bu sınavda yalnızca tam sayı puan kabul ediyor" };
  if (Number.isFinite(max) && p.value > max)
    return { status: 'error', value: p.value, message: `En fazla ${formatNumber(max)} puan verilebilir` };
  return { status: 'ok', value: p.value, message: '' };
}

/** Soru ayarlarını (maksimum puanlar) doğrular. */
export function validateQuestions(questions) {
  const items = (questions || []).map((q, i) => {
    if (!Number.isFinite(q.max)) return { status: 'error', message: `${i + 1}. sorunun maksimum puanı girilmedi` };
    if (q.max <= 0) return { status: 'error', message: `${i + 1}. sorunun maksimum puanı 0'dan büyük olmalı` };
    if (q.max > TOTAL_LIMIT) return { status: 'error', message: `${i + 1}. sorunun maksimum puanı ${TOTAL_LIMIT}'ü aşamaz` };
    return { status: 'ok', message: '' };
  });
  const total = maxTotal(questions);
  const errors = items.filter((x) => x.status === 'error').map((x) => x.message);
  const warnings = [];
  if (!questions || !questions.length) errors.push('Soru sayısı en az 1 olmalı');
  else if (total > TOTAL_LIMIT) errors.push(`Soruların toplam puanı ${TOTAL_LIMIT}'ü aşamaz (şu an ${formatNumber(total)})`);
  else if (total < TOTAL_LIMIT && !errors.length)
    warnings.push(`Soruların toplam puanı ${formatNumber(total)}; genellikle ${TOTAL_LIMIT} olmalıdır`);
  return { items, total, errors, warnings, ok: errors.length === 0 };
}

/** Bir öğrencinin satırını doğrular. */
export function validateStudent(student, questions, opts = {}) {
  // Sınava girmedi (G): satırda başka puan olmamalı
  const scores = student.scores || [];
  if (questions.some((_, i) => isAbsentMark(scores[i]))) {
    const cells = questions.map((_, i) => {
      const raw = String(scores[i] ?? '').trim();
      if (isAbsentMark(raw)) return { status: 'absent', value: null, message: 'Sınava girmedi' };
      if (raw === '') return { status: 'skip', value: null, message: '' };
      return { status: 'error', value: null, message: 'Sınava girmedi (G) işaretli öğrencide puan olamaz' };
    });
    const errors = cells.some((c) => c.status === 'error') ? ["Sınava girmedi (G) işaretli öğrencide puan olamaz; ya G'yi ya puanları silin"] : [];
    return { cells, total: 0, filled: 0, missing: 0, errors, status: errors.length ? 'error' : 'absent', absent: true };
  }

  const cells = questions.map((q, i) => validateScore(student.scores?.[i], q.max, opts));
  const { total, filled } = studentTotal(student.scores);
  const errors = [];
  cells.forEach((c, i) => c.status === 'error' && errors.push(`${i + 1}. soru: ${c.message}`));
  if (total > TOTAL_LIMIT) errors.push(`Toplam ${formatNumber(total)}, ${TOTAL_LIMIT}'ü aşamaz`);
  const missing = cells.filter((c) => c.status === 'empty').length;
  let status = 'ok';
  if (errors.length) status = 'error';
  else if (filled === 0) status = 'empty';
  else if (missing) status = 'incomplete';
  return { cells, total, filled, missing, errors, status };
}

/**
 * Tüm tabloyu doğrular.
 * @param {{questions:{max:number}[], students:{no:string,name:string,scores:string[]}[], integerOnly?:boolean}} sheet
 */
export function validateSheet(sheet) {
  const questions = validateQuestions(sheet.questions);
  const opts = { integerOnly: !!sheet.integerOnly };
  const students = sheet.students.map((s) => validateStudent(s, sheet.questions, opts));

  // Kimlik kontrolleri: okul no tekrarı ve kimliksiz satırlar
  const byNo = new Map();
  sheet.students.forEach((s, i) => {
    const no = String(s.no ?? '').trim();
    if (no) byNo.set(no, [...(byNo.get(no) || []), i]);
  });
  const identityIssues = [];
  for (const [no, idxs] of byNo)
    if (idxs.length > 1) {
      idxs.forEach((i) => {
        students[i].errors.push(`Okul no ${no} birden fazla satırda var`);
        students[i].status = 'error';
        students[i].duplicateNo = true;
      });
      identityIssues.push(`Okul no ${no} ${idxs.length} kez yazılmış`);
    }
  sheet.students.forEach((s, i) => {
    if (!String(s.no ?? '').trim() && !String(s.name ?? '').trim() && (students[i].filled || students[i].absent)) {
      students[i].errors.push('Okul no ve ad soyad boş');
      students[i].status = 'error';
    }
  });

  const summary = { ok: 0, incomplete: 0, empty: 0, absent: 0, error: 0, errorCells: 0, missingCells: 0, rows: students.length };
  for (const r of students) {
    summary[r.status]++;
    summary.errorCells += r.cells.filter((c) => c.status === 'error').length;
    summary.missingCells += r.missing;
  }
  const canTransfer = questions.ok && summary.error === 0 && students.length > 0;
  return { questions, students, summary, identityIssues, canTransfer };
}
