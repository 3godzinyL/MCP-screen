// Zrzuty ekranu + rejestr „shotów”.
// Każdy zrzut dostaje id (s1, s2...). AI dostaje pomniejszony obraz, a serwer pamięta
// pełną rozdzielczość i mapowanie: punkt na obrazku AI → piksel na ekranie.
// Dzięki temu AI może powiedzieć „kliknij x=512,y=300 na s4” i trafić co do piksela.
const nut = require('@nut-tree-fork/nut-js');
const win32 = require('./win32');

const MAX_SHOTS = 10;
const MAX_BYTES = 260 * 1024 * 1024;
const shots = new Map();
let counter = 0;

function clampRect(r, bounds) {
  const x = Math.max(bounds.x, Math.round(r.x));
  const y = Math.max(bounds.y, Math.round(r.y));
  const x2 = Math.min(bounds.x + bounds.w, Math.round(r.x + r.w));
  const y2 = Math.min(bounds.y + bounds.h, Math.round(r.y + r.h));
  if (x2 - x < 1 || y2 - y < 1) throw new Error(`Obszar ${JSON.stringify(r)} jest poza ekranem ${JSON.stringify(bounds)}`);
  return { x, y, w: x2 - x, h: y2 - y };
}

// BGRA (nut-js) → RGBA w miejscu
function bgraToRgba(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}

async function grabRect(rect) {
  const vs = win32.virtualScreen();
  const r = clampRect(rect, vs);
  let img;
  try {
    img = await nut.screen.grabRegion(new nut.Region(r.x, r.y, r.w, r.h));
  } catch (err) {
    // nut-js na niektórych układach wielu monitorów nie lubi ujemnych współrzędnych — tniemy z pełnego zrzutu
    const full = await nut.screen.grab();
    const data = Buffer.from(full.data);
    const out = Buffer.alloc(r.w * r.h * 4);
    const ox = r.x - vs.x;
    const oy = r.y - vs.y;
    for (let row = 0; row < r.h; row++) {
      const src = ((oy + row) * full.width + ox) * 4;
      data.copy(out, row * r.w * 4, src, src + r.w * 4);
    }
    return { rgba: bgraToRgba(out), width: r.w, height: r.h, rect: r };
  }
  let data = Buffer.from(img.data);
  // Gdy system zwróci obraz w innej skali (stary sterownik), dociągnij do wymiaru prostokąta.
  if (img.width !== r.w || img.height !== r.h) {
    const sharp = require('sharp');
    data = await sharp(bgraToRgba(data), { raw: { width: img.width, height: img.height, channels: 4 } })
      .resize(r.w, r.h, { fit: 'fill' }).raw().toBuffer();
    return { rgba: data, width: r.w, height: r.h, rect: r };
  }
  return { rgba: bgraToRgba(data), width: img.width, height: img.height, rect: r };
}

function totalBytes() {
  let n = 0;
  for (const s of shots.values()) n += s.rgba.length;
  return n;
}

function evict() {
  while (shots.size > MAX_SHOTS || (shots.size > 2 && totalBytes() > MAX_BYTES)) {
    const oldest = shots.keys().next().value;
    shots.delete(oldest);
  }
}

class Shot {
  constructor({ rgba, width, height, rect, window = null, parent = null, label = '' }) {
    this.id = `s${++counter}`;
    this.ts = Date.now();
    this.rgba = rgba;
    this.width = width;
    this.height = height;
    this.rect = rect;               // obszar ekranu (fizyczne px), który obejmuje zrzut
    this.window = window;           // okno, jeśli zrzut był „okna”
    this.parent = parent;           // id shota, z którego zrobiono zoom
    this.label = label;
    this.view = null;               // { w, h, scale } — obraz wysłany do AI
    this.marks = new Map();         // numerowane kandydaty z detect_elements
    this.ocr = null;                // cache OCR dla find_text
    this.uia = null;
  }

  setView(w, h) {
    this.view = { w, h, scale: w / this.rect.w };
    return this.view;
  }

  // obraz AI → ekran
  toScreen(ix, iy) {
    const s = this.view ? this.view.scale : 1;
    return { x: Math.round(this.rect.x + ix / s), y: Math.round(this.rect.y + iy / s) };
  }

  toScreenBox(b) {
    const s = this.view ? this.view.scale : 1;
    return {
      x: Math.round(this.rect.x + b.x / s), y: Math.round(this.rect.y + b.y / s),
      w: Math.max(1, Math.round(b.w / s)), h: Math.max(1, Math.round(b.h / s)),
    };
  }

  // ekran → obraz AI
  toImage(sx, sy) {
    const s = this.view ? this.view.scale : 1;
    return { x: Math.round((sx - this.rect.x) * s), y: Math.round((sy - this.rect.y) * s) };
  }

  toImageBox(b) {
    const s = this.view ? this.view.scale : 1;
    return {
      x: Math.round((b.x - this.rect.x) * s), y: Math.round((b.y - this.rect.y) * s),
      w: Math.max(1, Math.round(b.w * s)), h: Math.max(1, Math.round(b.h * s)),
    };
  }

  containsScreen(x, y) {
    const r = this.rect;
    return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
  }

  // Wycinek w pełnej rozdzielczości (współrzędne ekranu) → RGBA
  crop(box) {
    const r = clampRect(box, this.rect);
    const out = Buffer.alloc(r.w * r.h * 4);
    const ox = r.x - this.rect.x;
    const oy = r.y - this.rect.y;
    for (let row = 0; row < r.h; row++) {
      const src = ((oy + row) * this.width + ox) * 4;
      this.rgba.copy(out, row * r.w * 4, src, src + r.w * 4);
    }
    return { rgba: out, width: r.w, height: r.h, rect: r };
  }

  describe() {
    const v = this.view;
    return `${this.id}: ekran x=${this.rect.x} y=${this.rect.y} ${this.rect.w}x${this.rect.h}` +
      (v ? `, obraz ${v.w}x${v.h} (skala ${v.scale.toFixed(4)})` : '');
  }
}

function register(shot) {
  shots.set(shot.id, shot);
  evict();
  return shot;
}

async function capture({ rect, window: win = null, label = '' } = {}) {
  const target = rect || win32.primaryScreen();
  const g = await grabRect(target);
  return register(new Shot({ ...g, window: win, label }));
}

function fromCrop(parentShot, box, label = 'zoom') {
  const c = parentShot.crop(box);
  return register(new Shot({ ...c, parent: parentShot.id, window: parentShot.window, label }));
}

function getShot(id) {
  if (!id) return null;
  const s = shots.get(String(id));
  if (!s) throw new Error(`Nie ma zrzutu ${id} (pamiętam ostatnie ${MAX_SHOTS}: ${[...shots.keys()].join(', ') || 'brak'}). Zrób nowy screenshot.`);
  return s;
}

function latestShot() {
  let last = null;
  for (const s of shots.values()) last = s;
  return last;
}

function listShots() {
  return [...shots.values()].map((s) => s.describe());
}

module.exports = { capture, fromCrop, getShot, latestShot, listShots, grabRect, Shot, register };
