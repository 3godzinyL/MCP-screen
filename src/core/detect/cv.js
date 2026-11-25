// Wykrywanie elementów interfejsu z samych pikseli (bez AI, bez sieci).
// Dwa strumienie propozycji:
//   1) „pojemniki” — płaskie pola jednego koloru otoczone krawędzią: przyciski, pola tekstowe, zakładki, wiersze
//   2) „treść”     — skupiska krawędzi: napisy, ikony, linki bez ramki
// Wynik: prostokąty we współrzędnych obrazu wejściowego, posortowane od najbardziej „klikalnych”.

function downsample2(rgba, W, H) {
  const w = W >> 1;
  const h = H >> 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((y * 2) * W + x * 2) * 4;
      const b = a + 4;
      const c = a + W * 4;
      const d = c + 4;
      const o = (y * w + x) * 4;
      out[o] = (rgba[a] + rgba[b] + rgba[c] + rgba[d]) >> 2;
      out[o + 1] = (rgba[a + 1] + rgba[b + 1] + rgba[c + 1] + rgba[d + 1]) >> 2;
      out[o + 2] = (rgba[a + 2] + rgba[b + 2] + rgba[c + 2] + rgba[d + 2]) >> 2;
      out[o + 3] = 255;
    }
  }
  return { rgba: out, w, h };
}

// Siła krawędzi = największa różnica kanału z prawym/dolnym sąsiadem.
function edgeMap(rgba, w, h) {
  const E = new Uint8Array(w * h);
  const row = w * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      let d = 0;
      if (x + 1 < w) {
        const q = p + 4;
        const dr = Math.abs(rgba[p] - rgba[q]);
        const dg = Math.abs(rgba[p + 1] - rgba[q + 1]);
        const db = Math.abs(rgba[p + 2] - rgba[q + 2]);
        d = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
      }
      if (y + 1 < h) {
        const q = p + row;
        const dr = Math.abs(rgba[p] - rgba[q]);
        const dg = Math.abs(rgba[p + 1] - rgba[q + 1]);
        const db = Math.abs(rgba[p + 2] - rgba[q + 2]);
        const m = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db);
        if (m > d) d = m;
      }
      E[i] = d;
    }
  }
  return E;
}

// Domykanie przerw: litery jednego słowa/frazy zlewają się w jedną plamę.
function closeGaps(mask, w, h, gx, gy) {
  if (gx > 0) {
    for (let y = 0; y < h; y++) {
      let last = -1;
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (mask[base + x]) {
          if (last >= 0 && x - last > 1 && x - last <= gx + 1) mask.fill(1, base + last + 1, base + x);
          last = x;
        }
      }
    }
  }
  if (gy > 0) {
    for (let x = 0; x < w; x++) {
      let last = -1;
      for (let y = 0; y < h; y++) {
        if (mask[y * w + x]) {
          if (last >= 0 && y - last > 1 && y - last <= gy + 1) {
            for (let k = last + 1; k < y; k++) mask[k * w + x] = 1;
          }
          last = y;
        }
      }
    }
  }
  return mask;
}

// Etykietowanie spójnych składowych (4-sąsiedztwo, dwa przejścia + union-find).
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - w] : 0;
      if (!left && !up) {
        if (next >= parent.length) { const p2 = new Int32Array(parent.length * 2); p2.set(parent); parent = p2; }
        parent[next] = next;
        labels[i] = next++;
      } else if (left && up) {
        const a = find(left);
        const b = find(up);
        labels[i] = a < b ? a : b;
        if (a !== b) parent[a > b ? a : b] = a < b ? a : b;
      } else {
        labels[i] = left || up;
      }
    }
  }
  const boxes = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (!l) continue;
      const r = find(l);
      let b = boxes.get(r);
      if (!b) { b = { x0: x, y0: y, x1: x, y1: y, n: 0 }; boxes.set(r, b); }
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      b.n++;
    }
  }
  return [...boxes.values()].map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, n: b.n }));
}

// Płaskie pola jednego koloru (flood fill z tolerancją do koloru ziarna).
function flatRegions(rgba, E, w, h, flatT, tol) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const queue = new Int32Array(N);
  const out = [];
  for (let start = 0; start < N; start++) {
    if (seen[start] || E[start] >= flatT) continue;
    const sp = start * 4;
    const sr = rgba[sp]; const sg = rgba[sp + 1]; const sb = rgba[sp + 2];
    let head = 0; let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let x0 = w; let y0 = h; let x1 = 0; let y1 = 0; let n = 0;
    let border = false;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      // 4 sąsiadów
      for (let k = 0; k < 4; k++) {
        let j;
        if (k === 0) { if (x + 1 >= w) continue; j = i + 1; }
        else if (k === 1) { if (x === 0) continue; j = i - 1; }
        else if (k === 2) { if (y + 1 >= h) continue; j = i + w; }
        else { if (y === 0) continue; j = i - w; }
        if (seen[j] || E[j] >= flatT) continue;
        const p = j * 4;
        if (Math.abs(rgba[p] - sr) + Math.abs(rgba[p + 1] - sg) + Math.abs(rgba[p + 2] - sb) > tol) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, n, border, color: [sr, sg, sb] });
  }
  return out;
}

function integral(mask, w, h) {
  const I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 1; y <= h; y++) {
    let rowSum = 0;
    for (let x = 1; x <= w; x++) {
      rowSum += mask[(y - 1) * w + (x - 1)] ? 1 : 0;
      I[y * (w + 1) + x] = I[(y - 1) * (w + 1) + x] + rowSum;
    }
  }
  return I;
}

function sumRect(I, w, b) {
  const W1 = w + 1;
  const x0 = b.x; const y0 = b.y; const x1 = b.x + b.w; const y1 = b.y + b.h;
  return I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
}

function iou(a, b) {
  const x0 = Math.max(a.x, b.x); const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w); const y1 = Math.min(a.y + a.h, b.y + b.h);
  if (x1 <= x0 || y1 <= y0) return 0;
  const inter = (x1 - x0) * (y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function contains(outer, inner, pad = 2) {
  return inner.x >= outer.x - pad && inner.y >= outer.y - pad &&
    inner.x + inner.w <= outer.x + outer.w + pad && inner.y + inner.h <= outer.y + outer.h + pad;
}

function detectCv(rgbaIn, Win, Hin, { scale = 1 } = {}) {
  const t0 = Date.now();
  let f = 1;
  let rgba = rgbaIn; let w = Win; let h = Hin;
  if (Win * Hin > 4_700_000) {
    const d = downsample2(rgbaIn, Win, Hin);
    rgba = d.rgba; w = d.w; h = d.h; f = 2;
  }
  const s = Math.max(0.5, scale / f);
  const E = edgeMap(rgba, w, h);

  // 1) treść: mocne krawędzie, domknięte w poziomie (litery → słowa → frazy)
  const content = new Uint8Array(w * h);
  // „miękkie” krawędzie (12–33) dominują na zdjęciach i wideo; interfejs ma krawędzie ostre albo żadne
  const soft = new Uint8Array(w * h);
  for (let i = 0; i < E.length; i++) {
    const e = E[i];
    content[i] = e >= 34 ? 1 : 0;
    soft[i] = e >= 10 && e < 34 ? 1 : 0;
  }
  const contentI = integral(content, w, h);
  const softI = integral(soft, w, h);
  const photoLike = (b) => {
    const area = b.w * b.h;
    if (area < 64) return false;
    const sr = sumRect(softI, w, b) / area;
    const cr = sumRect(contentI, w, b) / area;
    return sr > 0.16 || (sr > 0.1 && sr > cr * 0.9);
  };
  const closed = Uint8Array.from(content);
  closeGaps(closed, w, h, Math.round(6 * s), Math.round(2 * s));
  const blobsRaw = components(closed, w, h);

  // 2) pojemniki: płaskie pola z tolerancją koloru
  const flats = flatRegions(rgba, E, w, h, 12, 30);

  const N = w * h;
  const containers = [];
  for (const r of flats) {
    if (r.w < 14 * s || r.h < 10 * s) continue;
    if (r.h > 150 * s || r.w > 0.96 * w) continue;
    if (r.w * r.h > 0.3 * N) continue;
    if (r.w / r.h > 80 || r.h / r.w > 6) continue;
    const fill = r.n / (r.w * r.h);
    if (fill < 0.4) continue;
    // ramka/obramowanie: dolicz 1–2 px na krawędź elementu
    const pad = Math.max(1, Math.round(1 * s));
    const box = {
      x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
      w: Math.min(w - Math.max(0, r.x - pad), r.w + 2 * pad), h: Math.min(h - Math.max(0, r.y - pad), r.h + 2 * pad),
    };
    if (photoLike(box)) continue;
    const inner = sumRect(contentI, w, box);
    const density = inner / (box.w * box.h);
    containers.push({ ...box, kind: inner > 6 ? 'container' : 'field', density, fill, color: r.color });
  }

  // pojemniki zawierające ≥3 inne pojemniki to panele (pasek narzędzi, karta) — nie są celem kliknięcia
  containers.sort((a, b) => b.w * b.h - a.w * a.h);
  const keptC = [];
  for (let i = 0; i < containers.length; i++) {
    const c = containers[i];
    let kids = 0;
    for (let j = i + 1; j < containers.length && kids < 3; j++) {
      if (contains(c, containers[j]) && containers[j].w * containers[j].h < 0.8 * c.w * c.h) kids++;
    }
    if (kids >= 3) continue;
    if (keptC.some((k) => iou(k, c) > 0.72)) continue;
    keptC.push(c);
  }

  const blobs = [];
  for (const b of blobsRaw) {
    if (b.w < 5 * s || b.h < 6 * s) continue;
    if (b.h > 90 * s || b.w > 0.7 * w) continue;
    if (b.w * b.h > 0.12 * N) continue;
    const box = { x: b.x, y: b.y, w: b.w, h: b.h };
    // otoczenie plamy też musi być „interfejsowe”, inaczej to fragment zdjęcia
    const ring = { x: Math.max(0, b.x - 6), y: Math.max(0, b.y - 6), w: 0, h: 0 };
    ring.w = Math.min(w - ring.x, b.w + 12);
    ring.h = Math.min(h - ring.y, b.h + 12);
    if (photoLike(box) || photoLike(ring)) continue;
    blobs.push({ ...box, kind: 'content', n: b.n });
  }

  // treść wewnątrz pojemnika = pojemnik (przycisk z napisem), nie osobny cel
  const out = [];
  for (const c of keptC) {
    c.kids = 0;
    out.push(c);
  }
  for (const b of blobs) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const host = keptC.find((c) => cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h && b.w * b.h < 0.92 * c.w * c.h);
    if (host) { host.kids++; continue; }
    if (out.some((o) => o.kind === 'content' && iou(o, b) > 0.6)) continue;
    out.push(b);
  }

  for (const o of out) {
    const area = o.w * o.h;
    if (o.kind === 'container') o.score = 2.2 + Math.min(0.6, area / (4000 * s * s)) + (o.kids ? 0.4 : 0);
    else if (o.kind === 'field') o.score = 2.3;
    else o.score = 1.2 + (Math.abs(o.w - o.h) < 0.4 * Math.max(o.w, o.h) ? 0.4 : 0);
    // wynik w skali wejścia
    o.x *= f; o.y *= f; o.w *= f; o.h *= f;
    delete o.n; delete o.color; delete o.fill; delete o.density;
  }

  return { items: out, ms: Date.now() - t0, factor: f };
}

module.exports = { detectCv, iou, contains, edgeMap, components, closeGaps };
