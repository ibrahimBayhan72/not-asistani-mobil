// QR gösterme ve kamerayla QR okuma (eklenti paneli ve mobil uygulama ortak).
// Gerekli globaller: qrcode (vendor/qrcode-generator.js), jsQR (vendor/jsQR.js).
// Kamera görüntüsü yalnızca bu cihazda işlenir; hiçbir yere gönderilmez.
import { FrameCollector, KIND } from '../modules/qr-transfer.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Titreşim yalnızca kullanıcı sayfaya dokunduktan sonra (tarayıcı kuralı) ve destekleniyorsa
const canBuzz = () => !!navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive);

// ------------------------------------------------------------------ QR çizimi
/** QR kodunu ölçeklenebilir SVG olarak üretir */
export function qrSvg(text) {
  const qr = globalThis.qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 4; // sessiz bölge
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const s = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR kod"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/**
 * Bir ya da daha çok QR çerçevesini kutuda gösterir; birden çoksa otomatik döndürür.
 * @returns {{stop:()=>void}}
 */
export function renderQR(container, frames, { interval = 1100 } = {}) {
  let i = 0;
  let paused = false;
  container.innerHTML = `
    <div class="qr-box">
      <div class="qr-svg"></div>
      <div class="qr-meta"></div>
      ${frames.length > 1 ? '<div class="qr-ctrl"><button type="button" data-a="prev" aria-label="Önceki">‹</button><button type="button" data-a="pause">⏸ Durdur</button><button type="button" data-a="next" aria-label="Sonraki">›</button></div>' : ''}
    </div>`;
  const svg = container.querySelector('.qr-svg');
  const meta = container.querySelector('.qr-meta');
  const show = () => {
    svg.innerHTML = qrSvg(frames[i]);
    meta.textContent = frames.length > 1 ? `Kod ${i + 1} / ${frames.length} — kodlar kendiliğinden değişir, kamerayı tutmaya devam edin` : 'Tek kod';
  };
  show();
  const timer = frames.length > 1 ? setInterval(() => !paused && ((i = (i + 1) % frames.length), show()), interval) : null;
  container.querySelector('.qr-ctrl')?.addEventListener('click', (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'prev') i = (i - 1 + frames.length) % frames.length;
    if (a === 'next') i = (i + 1) % frames.length;
    if (a === 'pause') {
      paused = !paused;
      e.target.textContent = paused ? '▶ Devam' : '⏸ Durdur';
    }
    show();
  });
  return { stop: () => clearInterval(timer) };
}

// ------------------------------------------------------------------ QR okuma
/** Bir görüntü kaynağından (video/img/canvas) QR metnini bulur */
async function decodeFrom(source, w, h, ctx, detector) {
  if (detector) {
    try {
      const codes = await detector.detect(source);
      if (codes.length) return codes.map((c) => c.rawValue);
    } catch {
      /* jsQR ile devam */
    }
  }
  const scale = Math.min(1, 900 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  ctx.canvas.width = cw;
  ctx.canvas.height = ch;
  ctx.drawImage(source, 0, 0, cw, ch);
  const img = ctx.getImageData(0, 0, cw, ch);
  const res = globalThis.jsQR(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
  return res ? [res.data] : [];
}

async function makeDetector() {
  try {
    if ('BarcodeDetector' in globalThis && (await globalThis.BarcodeDetector.getSupportedFormats()).includes('qr_code'))
      return new globalThis.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    /* desteklenmiyor */
  }
  return null;
}

const KIND_NAME = { [KIND.LIST]: 'öğrenci listesi', [KIND.SCORES]: 'puanlar' };

/**
 * Kamerayla (ya da görüntü dosyasından) QR okur, çok parçalı aktarımları birleştirir.
 * @param {{title:string, hint?:string, expectedKind:string}} o
 * @returns {Promise<{text:string, kind:string}|null>} iptal edilirse null
 */
export function scanQR({ title, hint = '', expectedKind }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'qr-scan';
    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      ${hint ? `<p class="qs-hint">${hint}</p>` : ''}
      <div class="qs-view"><video playsinline muted></video><div class="qs-frame"></div></div>
      <div class="qs-status" role="status">Kamera açılıyor…</div>
      <div class="qs-progress" hidden><i></i></div>
      <div class="qs-actions">
        <label class="qs-file">🖼 Görüntüden oku<input type="file" accept="image/*" hidden></label>
        <button type="button" class="qs-cancel">Vazgeç</button>
      </div>`;
    document.body.appendChild(dlg);
    const video = dlg.querySelector('video');
    const status = dlg.querySelector('.qs-status');
    const prog = dlg.querySelector('.qs-progress');
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const collector = new FrameCollector(expectedKind);
    let stream = null;
    let running = true;
    let detector = null;
    let busy = false;

    const finish = (value) => {
      running = false;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    const setStatus = (t, kind = '') => {
      status.textContent = t;
      status.className = 'qs-status ' + kind;
    };

    async function handle(texts) {
      for (const t of texts) {
        const r = collector.add(t);
        if (r.status === 'ignored') setStatus('Bu QR kodu Yazılı Not Asistanı\'na ait değil.', 'warn');
        else if (r.status === 'wrong-kind')
          setStatus(`Bu kod ${KIND_NAME[r.kind] || 'farklı içerik'} içeriyor; burada ${KIND_NAME[expectedKind]} bekleniyor.`, 'warn');
        else {
          prog.hidden = r.total < 2;
          prog.firstElementChild.style.width = `${(r.got / r.total) * 100}%`;
          if (r.status === 'progress') {
            setStatus(`Okundu: ${r.got} / ${r.total} kod. Diğer kodlar için kamerayı tutmaya devam edin…`, 'ok');
            if (canBuzz()) navigator.vibrate(15);
          } else {
            if (canBuzz()) navigator.vibrate([20, 40, 20]);
            setStatus('Tamamlandı ✓', 'ok');
            try {
              const text = await collector.text();
              return finish({ text, kind: collector.kind });
            } catch (e) {
              collector.reset();
              setStatus(e.message || 'Kod çözülemedi, tekrar deneyin.', 'err');
            }
          }
        }
      }
    }

    async function loop() {
      if (!running) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          await handle(await decodeFrom(video, video.videoWidth, video.videoHeight, ctx, detector));
        } finally {
          busy = false;
        }
      }
      if (running) setTimeout(loop, 120);
    }

    dlg.querySelector('.qs-cancel').onclick = () => finish(null);
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    dlg.querySelector('input[type=file]').onchange = async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const img = new Image();
      img.src = URL.createObjectURL(f);
      try {
        await img.decode();
        const found = await decodeFrom(img, img.naturalWidth, img.naturalHeight, ctx, detector);
        if (!found.length) setStatus('Görüntüde QR kodu bulunamadı.', 'warn');
        else await handle(found);
      } catch {
        setStatus('Görüntü açılamadı.', 'err');
      } finally {
        URL.revokeObjectURL(img.src);
      }
    };

    dlg.showModal();
    (async () => {
      detector = await makeDetector();
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error(), { name: 'NotSupported' });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!running) return stream.getTracks().forEach((t) => t.stop());
        video.srcObject = stream;
        await video.play();
        setStatus('QR kodunu çerçevenin içine getirin.');
        loop();
      } catch (e) {
        dlg.querySelector('.qs-view').hidden = true;
        const msg =
          e && e.name === 'NotAllowedError'
            ? 'Kamera izni verilmedi. Tarayıcının adres çubuğundaki kamera simgesinden izin verebilir ya da "Görüntüden oku" ile QR kodunun fotoğrafını seçebilirsiniz.'
            : e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')
              ? 'Kamera bulunamadı. "Görüntüden oku" ile QR kodunun fotoğrafını seçebilirsiniz.'
              : 'Kamera açılamadı. "Görüntüden oku" ile QR kodunun fotoğrafını seçebilirsiniz.';
        setStatus(msg, 'err');
      }
    })();

    // Test kancası: kamera olmadan çerçeve vermek için
    dlg.__feed = (texts) => handle(texts);
  });
}
