// Telefon ↔ bilgisayar QR aktarım biçimi (sunucu yok; veri yalnızca ekran ve kamera üzerinden geçer).
//
// İki içerik türü:
//   L (liste)   : bilgisayar → telefon. Sınav bilgisi, soru maksimumları, öğrenci no + ad.
//   P (puanlar) : telefon → bilgisayar. Liste parmak izi, soru maksimumları, öğrenci no + puanlar (ad YOK).
//
// Çerçeve (her QR kodu): YNA1:<tür><z>:<kimlik>:<sıra>:<toplam>:<veri>
//   z=1 → veri deflate-raw ile sıkıştırılmış. Veri base64url (yalnızca ASCII; Türkçe karakter sorunu olmaz).
//   Büyük sınıflarda birden çok QR olur; okuyucu parçaları sırası fark etmeksizin toplar.

export const MAGIC = 'YNA1';
export const KIND = { LIST: 'L', SCORES: 'P' };
export const DEFAULT_CHUNK = 600;

// ------------------------------------------------------------------ base64url ve sıkıştırma
export function bytesToB64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
export const canCompress = () => typeof CompressionStream === 'function';
const deflate = (b) => pipe(b, new CompressionStream('deflate-raw'));
function inflate(b) {
  if (typeof DecompressionStream !== 'function')
    throw new Error('Bu tarayıcı sıkıştırılmış QR verisini açamıyor. Tarayıcınızı güncelleyin.');
  return pipe(b, new DecompressionStream('deflate-raw'));
}

// ------------------------------------------------------------------ metin biçimleri
const clean = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ').trim();
const maxesText = (questions) => questions.map((q) => (Number.isFinite(q.max) ? q.max : '')).join(',');
const parseMaxes = (t) => (t || '').split(',').filter((x, i, a) => a.length > 1 || x !== '').map((x) => ({ max: x === '' ? NaN : Number(x) }));

function header(exam = {}, fingerprint = '', questions = []) {
  return ['v1', `s\t${clean(exam.sinifSube)}`, `d\t${clean(exam.ders)}`, `n\t${clean(exam.sinav)}`, `f\t${clean(fingerprint)}`, `m\t${maxesText(questions)}`];
}
function parseCommon(text) {
  const lines = String(text).split('\n');
  if (lines[0] !== 'v1') throw new Error('Tanınmayan QR içeriği (sürüm uyumsuz).');
  const out = { exam: { sinifSube: '', ders: '', sinav: '' }, fingerprint: '', integerOnly: false, questions: [], rows: [] };
  for (const line of lines.slice(1)) {
    const [k, ...r] = line.split('\t');
    if (k === 's') out.exam.sinifSube = r[0] || '';
    else if (k === 'd') out.exam.ders = r[0] || '';
    else if (k === 'n') out.exam.sinav = r[0] || '';
    else if (k === 'f') out.fingerprint = r[0] || '';
    else if (k === 'i') out.integerOnly = r[0] === '1';
    else if (k === 'm') out.questions = parseMaxes(r[0]);
    else if (k === 'o') out.rows.push(r);
  }
  if (!out.questions.length) throw new Error('QR içeriğinde soru bilgisi yok.');
  return out;
}

/** Liste (bilgisayar → telefon) */
export function encodeListText({ exam, fingerprint, questions, integerOnly, students }) {
  const lines = header(exam, fingerprint, questions);
  lines.push(`i\t${integerOnly ? 1 : 0}`);
  for (const s of students) lines.push(`o\t${clean(s.no)}\t${clean(s.name)}`);
  return lines.join('\n');
}
export function decodeListText(text) {
  const c = parseCommon(text);
  return { exam: c.exam, fingerprint: c.fingerprint, integerOnly: c.integerOnly, questions: c.questions, students: c.rows.map((r) => ({ no: r[0] || '', name: r[1] || '' })) };
}

/** Puanlar (telefon → bilgisayar). Ad gönderilmez; eşleştirme okul numarasıyla yapılır. */
export function encodeScoresText({ exam, fingerprint, questions, students }) {
  const lines = header(exam, fingerprint, questions);
  for (const s of students) {
    const scores = questions.map((_, q) => clean(s.scores?.[q]).replace(',', '.'));
    if (scores.every((v) => v === '')) continue; // puanı olmayan öğrenci gönderilmez
    lines.push(`o\t${clean(s.no)}\t${scores.join(',')}`);
  }
  return lines.join('\n');
}
export function decodeScoresText(text) {
  const c = parseCommon(text);
  const Q = c.questions.length;
  const students = c.rows.map((r) => {
    const scores = (r[1] || '').split(',');
    while (scores.length < Q) scores.push('');
    return { no: r[0] || '', scores: scores.slice(0, Q) };
  });
  return { exam: c.exam, fingerprint: c.fingerprint, questions: c.questions, students };
}

/** Puanları panelin içe aktarma penceresinin anlayacağı sekmeli metne çevirir */
export function scoresToTSV(decoded) {
  const head = ['Okul No', ...decoded.questions.map((q, i) => `${i + 1}. Soru (${Number.isFinite(q.max) ? q.max : ''})`)];
  return [head, ...decoded.students.map((s) => [s.no, ...s.scores])].map((r) => r.join('\t')).join('\n');
}

// ------------------------------------------------------------------ çerçeveler
export async function makeFrames(kind, text, { maxChunk = DEFAULT_CHUNK, compress = canCompress() } = {}) {
  let bytes = new TextEncoder().encode(text);
  let z = '0';
  if (compress) {
    const c = await deflate(bytes);
    if (c.length < bytes.length) {
      bytes = c;
      z = '1';
    }
  }
  const data = bytesToB64u(bytes);
  const n = Math.max(1, Math.ceil(data.length / maxChunk));
  const id = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return Array.from({ length: n }, (_, i) => `${MAGIC}:${kind}${z}:${id}:${i + 1}:${n}:${data.slice(i * maxChunk, (i + 1) * maxChunk)}`);
}

const FRAME_RE = /^YNA1:([LP])([01]):([a-z0-9]{4}):(\d{1,3}):(\d{1,3}):([A-Za-z0-9_-]*)$/;
export function parseFrame(str) {
  const m = FRAME_RE.exec(String(str || '').trim());
  if (!m) return null;
  const i = Number(m[4]);
  const n = Number(m[5]);
  if (!n || i < 1 || i > n) return null;
  return { kind: m[1], z: m[2] === '1', id: m[3], i, n, data: m[6] };
}

/** Kameradan gelen QR metinlerini toplar; tüm parçalar gelince içeriği çözer. */
export class FrameCollector {
  constructor(expectedKind = null) {
    this.expectedKind = expectedKind;
    this.reset();
  }
  reset() {
    this.id = null;
    this.parts = new Map();
    this.total = 0;
    this.kind = null;
    this.z = false;
  }
  /** @returns {{status:'ignored'|'wrong-kind'|'progress'|'complete', got:number, total:number}} */
  add(str) {
    const f = parseFrame(str);
    if (!f) return { status: 'ignored', got: this.parts.size, total: this.total };
    if (this.expectedKind && f.kind !== this.expectedKind) return { status: 'wrong-kind', kind: f.kind, got: this.parts.size, total: this.total };
    if (f.id !== this.id) {
      this.reset();
      Object.assign(this, { id: f.id, total: f.n, kind: f.kind, z: f.z });
    }
    this.parts.set(f.i, f.data);
    const done = this.parts.size === this.total;
    return { status: done ? 'complete' : 'progress', got: this.parts.size, total: this.total, kind: this.kind };
  }
  get missing() {
    return Array.from({ length: this.total }, (_, i) => i + 1).filter((i) => !this.parts.has(i));
  }
  async text() {
    if (!this.total || this.parts.size !== this.total) throw new Error('QR parçaları eksik.');
    const data = Array.from({ length: this.total }, (_, i) => this.parts.get(i + 1)).join('');
    let bytes = b64uToBytes(data);
    if (this.z) bytes = await inflate(bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
}
