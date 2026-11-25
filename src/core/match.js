// Dopasowanie wzorca (znormalizowana korelacja, NCC) — odnajduje zapisany element na nowym zrzucie,
// nawet gdy okno się przesunęło albo zmieniła się jasność. Najpierw zgrubnie na pomniejszeniu,
// potem dokładnie w pełnej rozdzielczości wokół najlepszych kandydatów.

function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = rgba[p] * 0.299 + rgba[p + 1] * 0.587 + rgba[p + 2] * 0.114;
  return g;
}

function shrink(g, w, h, f) {
  if (f === 1) return { g, w, h };
  const W = Math.floor(w / f);
  const H = Math.floor(h / f);
  const out = new Float32Array(W * H);
  const inv = 1 / (f * f);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * w + x * f;
        for (let dx = 0; dx < f; dx++) s += g[row + dx];
      }
      out[y * W + x] = s * inv;
    }
  }
  return { g: out, w: W, h: H };
}

function integrals(g, w, h) {
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1));
  const Q = new Float64Array(W1 * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rs = 0;
    let rq = 0;
    for (let x = 1; x <= w; x++) {
      const v = g[(y - 1) * w + (x - 1)];
      rs += v;
      rq += v * v;
      S[y * W1 + x] = S[(y - 1) * W1 + x] + rs;
      Q[y * W1 + x] = Q[(y - 1) * W1 + x] + rq;
    }
  }
  return { S, Q, W1 };
}

function prepTemplate(t, tw, th) {
  const n = tw * th;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += t[i];
  mean /= n;
  const tz = new Float32Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    tz[i] = t[i] - mean;
    norm += tz[i] * tz[i];
  }
  return { tz, norm: Math.sqrt(norm), mean, n };
}

function nccAt(img, iw, ints, tp, tw, th, x, y) {
  const { S, Q, W1 } = ints;
  const x1 = x + tw;
  const y1 = y + th;
  const sum = S[y1 * W1 + x1] - S[y * W1 + x1] - S[y1 * W1 + x] + S[y * W1 + x];
  const sq = Q[y1 * W1 + x1] - Q[y * W1 + x1] - Q[y1 * W1 + x] + Q[y * W1 + x];
  const varI = sq - (sum * sum) / tp.n;
  if (tp.norm < 1e-3 || varI < 1e-3) {
    // płaski wzorzec lub płaskie okno: porównanie średnich jasności
    const meanI = sum / tp.n;
    return tp.norm < 1e-3 && varI < tp.n * 4 ? 1 - Math.min(1, Math.abs(meanI - tp.mean) / 64) : 0;
  }
  let cross = 0;
  const tz = tp.tz;
  for (let r = 0; r < th; r++) {
    const row = (y + r) * iw + x;
    const trow = r * tw;
    for (let c = 0; c < tw; c++) cross += img[row + c] * tz[trow + c];
  }
  return cross / (Math.sqrt(varI) * tp.norm);
}

// Szuka wzorca (RGBA) w obrazie (RGBA). Zwraca najlepsze dopasowanie we współrzędnych obrazu.
// Gdy wynik na zgrubnej skali jest niepewny (drobny tekst ginie po pomniejszeniu),
// powtarza na drobniejszej skali — o ile koszt mieści się w budżecie operacji.
// topK = ilu najlepszych kandydatów ze zgrubnej skali doprecyzowujemy (wiersze list wyglądają z daleka tak samo).
function matchTemplate(imgRgba, iw, ih, tplRgba, tw, th, { maxCoarsePixels = 600, topK = 48, budget = 6e8 } = {}) {
  if (tw > iw || th > ih) return { x: 0, y: 0, score: 0 };
  const t0 = Date.now();
  const G = toGray(imgRgba, iw, ih);
  const T = toGray(tplRgba, tw, th);

  let f = 1;
  for (const c of [1, 2, 3, 4, 6, 8]) {
    f = c;
    if ((tw / c) * (th / c) <= maxCoarsePixels) break;
    if (tw / (c * 1.5) < 6 || th / (c * 1.5) < 6) break;
  }
  while (f > 1 && (tw / f < 5 || th / f < 5)) f--;

  let res = matchAt(G, iw, ih, T, tw, th, f, topK);
  while (res.score < 0.85 && f > 1) {
    const f2 = f >= 4 ? Math.floor(f / 2) : f - 1;
    const cost = ((iw - tw) / f2) * ((ih - th) / f2) * ((tw * th) / (f2 * f2));
    if (cost > budget) break;
    const r2 = matchAt(G, iw, ih, T, tw, th, f2, topK);
    if (r2.score > res.score) res = r2;
    f = f2;
  }
  return { ...res, ms: Date.now() - t0 };
}

function matchAt(G, iw, ih, T, tw, th, f, topK) {
  const gi = shrink(G, iw, ih, f);
  const ti = shrink(T, tw, th, f);
  const tp = prepTemplate(ti.g, ti.w, ti.h);
  const ints = integrals(gi.g, gi.w, gi.h);
  const peaks = [];
  const maxX = gi.w - ti.w;
  const maxY = gi.h - ti.h;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      const s = nccAt(gi.g, gi.w, ints, tp, ti.w, ti.h, x, y);
      if (peaks.length < topK || s > peaks[peaks.length - 1].s) {
        // tłumienie sąsiadów: ten sam szczyt nie zajmuje kilku miejsc
        const near = peaks.findIndex((p) => Math.abs(p.x - x) <= 2 && Math.abs(p.y - y) <= 2);
        if (near >= 0) {
          if (peaks[near].s < s) { peaks[near] = { x, y, s }; peaks.sort((a, b) => b.s - a.s); }
          continue;
        }
        peaks.push({ x, y, s });
        peaks.sort((a, b) => b.s - a.s);
        if (peaks.length > topK) peaks.pop();
      }
    }
  }

  if (f === 1) {
    const b = peaks[0] || { x: 0, y: 0, s: 0 };
    return { x: b.x, y: b.y, score: b.s, factor: f };
  }

  // doprecyzowanie w pełnej rozdzielczości
  const tpFull = prepTemplate(T, tw, th);
  const intsFull = integrals(G, iw, ih);
  let best = { x: 0, y: 0, score: -1 };
  for (const p of peaks) {
    const cx = p.x * f;
    const cy = p.y * f;
    for (let y = Math.max(0, cy - f - 1); y <= Math.min(ih - th, cy + f + 1); y++) {
      for (let x = Math.max(0, cx - f - 1); x <= Math.min(iw - tw, cx + f + 1); x++) {
        const s = nccAt(G, iw, intsFull, tpFull, tw, th, x, y);
        if (s > best.score) best = { x, y, score: s };
      }
    }
  }
  return { ...best, factor: f };
}

// Wynik dopasowania w jednym, znanym miejscu (szybka weryfikacja „czy element nadal tu jest”).
function scoreAt(imgRgba, iw, ih, tplRgba, tw, th, x, y) {
  if (x < 0 || y < 0 || x + tw > iw || y + th > ih) return 0;
  const G = toGray(imgRgba, iw, ih);
  const T = toGray(tplRgba, tw, th);
  return nccAt(G, iw, integrals(G, iw, ih), prepTemplate(T, tw, th), tw, th, x, y);
}

// Ułamek pikseli, które zmieniły się wyraźnie między dwoma obrazami tego samego rozmiaru.
function diffRatio(a, b, threshold = 28) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  const n = a.length / 4;
  for (let p = 0; p < a.length; p += 4) {
    const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
    if (d > threshold) changed++;
  }
  return changed / n;
}

module.exports = { matchTemplate, scoreAt, diffRatio, toGray };
