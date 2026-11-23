// El yazısı rakam tanıma (MNIST CNN, düz JavaScript; onnxruntime gerekmez).
// Ağ: Conv5x5(1→8)+ReLU → MaxPool2 → Conv5x5(8→16)+ReLU → MaxPool3 → Tam bağlı(256→10).
// Ağırlıklar: mobil/lib/digit-net.json (kaynak: onnx/models mnist-12, Apache-2.0; tools/onnx-to-json.mjs ile üretildi).
// Bu modül tarayıcıya ve DOM'a bağlı DEĞİLDİR; Node'da da çalışır (birim testleri için).

/** same-padded 5×5 evrişim. in: [C][H][W] düz dizi, w: [O][C][5][5], b: [O] */
function conv5(inp, C, H, W, w, b, O) {
  const out = new Float32Array(O * H * W);
  for (let o = 0; o < O; o++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = b[o];
        for (let c = 0; c < C; c++) {
          const wb = ((o * C + c) * 5) * 5;
          const ib = c * H * W;
          for (let ky = 0; ky < 5; ky++) {
            const yy = y + ky - 2;
            if (yy < 0 || yy >= H) continue;
            for (let kx = 0; kx < 5; kx++) {
              const xx = x + kx - 2;
              if (xx < 0 || xx >= W) continue;
              s += w[wb + ky * 5 + kx] * inp[ib + yy * W + xx];
            }
          }
        }
        out[(o * H + y) * W + x] = s > 0 ? s : 0; // ReLU
      }
    }
  }
  return out;
}
function maxpool(inp, C, H, W, k) {
  const oh = Math.floor(H / k), ow = Math.floor(W / k);
  const out = new Float32Array(C * oh * ow);
  for (let c = 0; c < C; c++)
    for (let y = 0; y < oh; y++)
      for (let x = 0; x < ow; x++) {
        let m = -Infinity;
        for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) m = Math.max(m, inp[(c * H + y * k + dy) * W + x * k + dx]);
        out[(c * oh + y) * ow + x] = m;
      }
  return out;
}

/**
 * @param {Float32Array|number[]} img 28×28, 0..1 (rakam açık, zemin koyu)
 * @param {object} net digit-net.json içeriği
 * @returns {{digit:number, prob:number, probs:number[]}}
 */
export function classify(img, net) {
  const a = conv5(img, 1, 28, 28, net.c1w, net.c1b, 8);
  const p1 = maxpool(a, 8, 28, 28, 2); // 8×14×14
  const b = conv5(p1, 8, 14, 14, net.c2w, net.c2b, 16);
  const p2 = maxpool(b, 16, 14, 14, 3); // 16×4×4 = 256
  const logits = new Float64Array(10);
  for (let j = 0; j < 10; j++) {
    let s = net.fb[j];
    for (let i = 0; i < 256; i++) s += p2[i] * net.fw[i * 10 + j];
    logits[j] = s;
  }
  const m = Math.max(...logits);
  const e = Array.from(logits, (v) => Math.exp(v - m));
  const sum = e.reduce((x, y) => x + y, 0);
  const probs = e.map((v) => v / sum);
  let best = 0;
  for (let i = 1; i < 10; i++) if (probs[i] > probs[best]) best = i;
  return { digit: best, prob: probs[best], probs };
}

/**
 * İkili mürekkep maskesini (1 = mürekkep) MNIST biçimine getirir:
 * sınırlayıcı kutuya kırp → uzun kenar 20 px olacak şekilde alan ortalamasıyla küçült → 28×28'e ağırlık merkezine göre ortala.
 * @returns {Float32Array|null} 784 değer (0..1) ya da maske boşsa null
 */
export function toMnist(mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const sc = 20 / Math.max(bw, bh);
  const tw = Math.max(1, Math.round(bw * sc)), th = Math.max(1, Math.round(bh * sc));
  const small = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = y0 + ty / sc, sy1 = y0 + (ty + 1) / sc;
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = x0 + tx / sc, sx1 = x0 + (tx + 1) / sc;
      let sum = 0, area = 0;
      for (let yy = Math.floor(sy0); yy < Math.ceil(sy1); yy++) {
        const hy = Math.min(yy + 1, sy1) - Math.max(yy, sy0);
        if (hy <= 0 || yy < 0 || yy >= h) continue;
        for (let xx = Math.floor(sx0); xx < Math.ceil(sx1); xx++) {
          const hx = Math.min(xx + 1, sx1) - Math.max(xx, sx0);
          if (hx <= 0 || xx < 0 || xx >= w) continue;
          const wgt = hx * hy; sum += wgt * mask[yy * w + xx]; area += wgt;
        }
      }
      small[ty * tw + tx] = area ? sum / area : 0;
    }
  }
  // ağırlık merkezi
  let m = 0, cx = 0, cy = 0;
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const v = small[y * tw + x]; m += v; cx += v * x; cy += v * y; }
  cx = m ? cx / m : tw / 2; cy = m ? cy / m : th / 2;
  const ox = Math.round(14 - cx), oy = Math.round(14 - cy);
  const out = new Float32Array(784);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const X = x + ox, Y = y + oy;
    if (X >= 0 && X < 28 && Y >= 0 && Y < 28) out[Y * 28 + X] = small[y * tw + x];
  }
  return out;
}

/**
 * Bir kutudaki (ikili maske) bir ya da daha çok haneli sayıyı okur.
 * Bağlantılı bileşenler soldan sağa sıralanır; çok küçük lekeler (gürültü) atılır.
 * @returns {{text:string, conf:number, digits:{digit:number, prob:number, box:number[]}[], noise:number}}
 */
export function readNumber(mask, w, h, net, { minArea = 0.004, maxDigits = 3 } = {}) {
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    const id = comps.length + 1;
    let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p / w) | 0; area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && !lab[q]) { lab[q] = id; stack.push(q); }
      }
    }
    comps.push({ id, area, x0, y0, x1, y1 });
  }
  const minPx = Math.max(6, minArea * w * h);
  const bwOf = (c) => c.x1 - c.x0 + 1, bhOf = (c) => c.y1 - c.y0 + 1;
  // ince/küçük lekeler ve kutu çizgisi artıkları (kırpık kenarına değen ince parçalar) rakam değildir
  let keep = comps.filter((c) => {
    if (c.area < minPx || bhOf(c) < h * 0.18) return false;
    const touches = c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
    return !(touches && (bwOf(c) <= 0.3 * bhOf(c) || bhOf(c) <= 0.3 * bwOf(c)));
  });
  const noise = comps.length - keep.length;
  keep.sort((a, b) => a.x0 - b.x0);

  const subMask = (c, xa, xb) => {
    const bw = xb - xa + 1, bh = bhOf(c);
    const sub = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sub[y * bw + x] = lab[(c.y0 + y) * w + xa + x] === c.id ? 1 : 0;
    return toMnist(sub, bw, bh);
  };
  const cls = (c, xa, xb) => { if (xb - xa + 1 < 2) return null; const img = subMask(c, xa, xb); return img ? classify(img, net) : null; };
  /**
   * Bitişik rakamları böler: olası kesim noktalarını dener, iki/üç parçanın birlikte en güvenle tanındığı kesimi seçer
   * ("tanıyarak bölme"). Yuvarlak rakamlarda (0, 8) izdüşümün en ince yeri değme noktası olmadığı için izdüşüm kullanılmaz.
   * @returns {[number,number][]} her parça için [xa, xb]
   */
  const splitCols = (c, n) => {
    const bw = bwOf(c), x0 = c.x0;
    const lp = (xa, xb) => { const r = cls(c, xa, xb); return r ? Math.log(Math.max(r.prob, 1e-6)) : -20; };
    let best = null, bestS = -Infinity;
    const minW = Math.max(3, Math.round(0.14 * bw));
    if (n === 2) {
      for (let k = Math.round(0.28 * bw); k <= Math.round(0.72 * bw); k++) {
        if (k < minW || bw - k < minW) continue;
        const sc = lp(x0, x0 + k - 1) + lp(x0 + k, x0 + bw - 1);
        if (sc > bestS) { bestS = sc; best = [[x0, x0 + k - 1], [x0 + k, x0 + bw - 1]]; }
      }
    } else {
      const step = Math.max(1, Math.round(bw / 60));
      for (let k1 = Math.round(0.2 * bw); k1 <= Math.round(0.45 * bw); k1 += step)
        for (let k2 = Math.round(0.55 * bw); k2 <= Math.round(0.8 * bw); k2 += step) {
          if (k1 < minW || k2 - k1 < minW || bw - k2 < minW) continue;
          const sc = lp(x0, x0 + k1 - 1) + lp(x0 + k1, x0 + k2 - 1) + lp(x0 + k2, x0 + bw - 1);
          if (sc > bestS) { bestS = sc; best = [[x0, x0 + k1 - 1], [x0 + k1, x0 + k2 - 1], [x0 + k2, x0 + bw - 1]]; }
        }
    }
    return best || [[c.x0, c.x1]];
  };

  // Bitişik rakamlar tek bileşen olur (ör. "20"). Rakam genelde yüksekliğinden dardır; belirgin biçimde genişse bölünür.
  // (Güvene dayalı deneme bölmesi "8"i "63" diye böldüğü için kaldırıldı.)
  const digits = [];
  for (const c of keep) {
    const ratio = bwOf(c) / bhOf(c);
    let segs = [[c.x0, c.x1]];
    if (ratio > 1.1) segs = splitCols(c, Math.min(3, Math.max(2, Math.round(bwOf(c) / (0.75 * bhOf(c))))));
    for (const [xa, xb] of segs) {
      const r = cls(c, xa, xb);
      if (r) digits.push({ digit: r.digit, prob: r.prob, box: [xa, c.y0, xb, c.y1] });
    }
  }
  digits.sort((a, b) => a.box[0] - b.box[0]);
  if (digits.length > maxDigits) digits.length = maxDigits;
  return { text: digits.map((d) => d.digit).join(''), conf: digits.length ? Math.min(...digits.map((d) => d.prob)) : 0, digits, noise };
}
