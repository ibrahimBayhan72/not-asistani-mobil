// CSV dışa aktarma (Türkçe Excel uyumlu: UTF-8 BOM, ';' ayırıcı, ondalık virgül).
import { studentTotal, formatNumber, normalizeScoreText } from './score-calculator.js';

/** Sütun başlığı: ders notunda e-Okul'daki ad ("1.Sınav"), OYSS'de "1. Soru (20)" */
export const columnTitle = (q, i) => (q && q.label ? q.label : `${i + 1}. Soru (${formatNumber(q.max)})`);

export function sheetToRows(sheet) {
  const dersNotu = sheet.mode === 'dersnotu';
  const head = ['Okul No', 'Adı Soyadı', ...sheet.questions.map(columnTitle), dersNotu ? 'Ortalama' : 'Toplam'];
  const rows = sheet.students.map((s) => {
    const scores = sheet.questions.map((_, i) => normalizeScoreText(s.scores?.[i]));
    const { total, filled } = studentTotal(s.scores);
    const last = !filled ? '' : dersNotu ? formatNumber(Math.round((total / filled) * 100) / 100) : formatNumber(total);
    return [s.no ?? '', s.name ?? '', ...scores, last];
  });
  return [head, ...rows];
}

export function toCSV(rows, delimiter = ';') {
  const needsQuote = new RegExp(`["\\r\\n${delimiter === '\t' ? '\\t' : delimiter}]`);
  return rows
    .map((r) => r.map((c) => (needsQuote.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(delimiter))
    .join('\r\n');
}

/** Panoya / Excel'e yapıştırmaya uygun sekme ayrılmış metin */
export function toTSV(rows) {
  return rows.map((r) => r.map((c) => String(c).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\r\n');
}

export function makeFileName(exam, prefix, ext) {
  const parts = [prefix, exam?.sinifSube, exam?.ders].filter(Boolean).join('_');
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  const safe = parts.replace(/[\\/:*?"<>|()]+/g, '').replace(/\s+/g, '_').slice(0, 80);
  return `${safe}_${stamp}.${ext}`;
}

/** Tarayıcıda dosya indirir (yalnızca panel/popup sayfasında çağrılır). */
export function downloadText(fileName, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 2000);
}
