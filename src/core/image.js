// Obrazy dla AI: pomniejszenie, siatka współrzędnych, niebieskie strefy z numerami i podpisami.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { SHOTS_DIR, TMP_DIR } = require('./paths');
const { ensureDir } = require('./json');
const { getSettings } = require('./settings');

sharp.cache(false);

// Kolory stref: niebieski = element. Odcień mówi, skąd się wziął.
const COLORS = {
  element: '#1d4ed8',   // zapisany, nazwany element (pełny niebieski)
  uia: '#2563eb',       // z drzewa dostępności Windows (UI Automation)
  ocr: '#0284c7',       // tekst odczytany OCR
  cv: '#4f46e5',        // wykryty z pikseli (krawędzie / płaskie pola)
  manual: '#1d4ed8',
  match: '#0891b2',     // znaleziony ponownie dopasowaniem wzorca
  click: '#dc2626',     // miejsce kliknięcia
};

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function viewSize(width, height, maxWidth) {
  const mw = Math.max(200, Math.round(maxWidth || getSettings().maxImageWidth || 1400));
  // Pilnujemy też ~1,15 MP, żeby model nie skalował obrazu po swojej stronie.
  const maxPixels = 1_150_000;
  let scale = Math.min(1, mw / width, Math.sqrt(maxPixels / (width * height)));
  if (scale > 0.98) scale = 1;
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)), scale };
}

function textWidth(str, size) {
  // Przybliżenie szerokości Segoe UI (bold) — wystarcza do układania etykiet.
  let w = 0;
  for (const ch of String(str)) w += /[il.,:;|!'`]/.test(ch) ? 0.32 : /[mwMW@]/.test(ch) ? 0.9 : /[A-Z0-9_]/.test(ch) ? 0.66 : 0.56;
  return Math.ceil(w * size) + 8;
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Buduje SVG nakładki: prostokąty + etykiety rozłożone tak, żeby się nie zasłaniały.
function overlaySvg(w, h, { boxes = [], grid = false, gridStep = 100, clicks = [], paths = [], fontSize = 12 } = {}) {
  const parts = [];
  if (grid) parts.push(gridSvg(w, h, gridStep));

  const placed = [];
  const labels = [];
  for (const b of boxes) {
    const color = b.color || COLORS[b.source] || COLORS.cv;
    const sw = b.strong ? 2.5 : 1.6;
    const fill = b.strong ? 0.16 : 0.08;
    // jasna obwódka pod niebieską ramką — strefa widoczna i na ciemnym, i na jasnym tle
    parts.push(`<rect x="${b.x - 0.5}" y="${b.y - 0.5}" width="${b.w + 1}" height="${b.h + 1}" fill="none" stroke="#ffffff" stroke-opacity="0.75" stroke-width="${sw + 2}" rx="2.5"/>` +
      `<rect x="${b.x + 0.5}" y="${b.y + 0.5}" width="${Math.max(1, b.w - 1)}" height="${Math.max(1, b.h - 1)}" fill="${color}" fill-opacity="${fill}" stroke="${color}" stroke-width="${sw}" rx="2"/>`);
    if (b.label === undefined || b.label === null || b.label === '') continue;
    const fs_ = b.strong ? Math.round(fontSize * 1.1) : fontSize;
    const tw = textWidth(b.label, fs_);
    const th = fs_ + 5;
    // kolejność: na zewnątrz strefy (nie zasłaniamy elementu), dopiero na końcu w środku
    const candidates = [
      { x: b.x, y: b.y - th },                 // nad, z lewej
      { x: b.x, y: b.y + b.h },                // pod, z lewej
      { x: b.x + b.w + 1, y: b.y },            // z prawej strony
      { x: b.x - tw - 1, y: b.y },             // z lewej strony
      { x: b.x + b.w - tw, y: b.y - th },      // nad, z prawej
      { x: b.x + b.w - tw, y: b.y + b.h },     // pod, z prawej
      { x: b.x, y: b.y },                      // w środku, lewy górny
    ];
    let pos = null;
    for (const c of candidates) {
      const r = { x: Math.round(c.x), y: Math.round(c.y), w: tw, h: th };
      if (r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) continue;
      if (placed.some((p) => overlaps(p, r))) continue;
      pos = r;
      break;
    }
    if (!pos) {
      pos = { x: Math.max(0, Math.min(w - tw, Math.round(b.x))), y: Math.max(0, Math.min(h - th, Math.round(b.y))), w: tw, h: th };
    }
    placed.push(pos);
    labels.push(`<rect x="${pos.x}" y="${pos.y}" width="${pos.w}" height="${pos.h}" fill="${color}" rx="2"/>` +
      `<text x="${pos.x + 4}" y="${pos.y + th - 4}" font-family="Segoe UI, Arial, sans-serif" font-size="${fs_}" font-weight="700" fill="#ffffff">${esc(b.label)}</text>`);
  }

  for (const p of paths) {
    if (!p.points || p.points.length < 2) continue;
    const d = p.points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${p.color || '#f59e0b'}" stroke-width="2" stroke-opacity="0.9" stroke-linejoin="round"/>`);
  }

  for (const c of clicks) {
    const color = c.color || COLORS.click;
    parts.push(`<circle cx="${c.x}" cy="${c.y}" r="11" fill="none" stroke="#ffffff" stroke-width="4"/>` +
      `<circle cx="${c.x}" cy="${c.y}" r="11" fill="none" stroke="${color}" stroke-width="2.2"/>` +
      `<line x1="${c.x - 17}" y1="${c.y}" x2="${c.x + 17}" y2="${c.y}" stroke="${color}" stroke-width="1.5"/>` +
      `<line x1="${c.x}" y1="${c.y - 17}" x2="${c.x}" y2="${c.y + 17}" stroke="${color}" stroke-width="1.5"/>`);
    if (c.label) {
      const tw = textWidth(c.label, fontSize);
      const x = Math.max(0, Math.min(w - tw, c.x + 14));
      const y = Math.max(0, Math.min(h - fontSize - 5, c.y + 12));
      parts.push(`<rect x="${x}" y="${y}" width="${tw}" height="${fontSize + 5}" fill="${color}" rx="2"/>` +
        `<text x="${x + 4}" y="${y + fontSize + 1}" font-family="Segoe UI, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${esc(c.label)}</text>`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}${labels.join('')}</svg>`;
}

function gridSvg(w, h, step) {
  const s = [];
  for (let x = step; x < w; x += step) {
    s.push(`<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#000" stroke-opacity="0.35" stroke-width="2"/>` +
      `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#ff2bd6" stroke-opacity="0.65" stroke-width="1"/>`);
  }
  for (let y = step; y < h; y += step) {
    s.push(`<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#000" stroke-opacity="0.35" stroke-width="2"/>` +
      `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#ff2bd6" stroke-opacity="0.65" stroke-width="1"/>`);
  }
  const lab = (x, y, t) => `<rect x="${x}" y="${y}" width="${textWidth(t, 11)}" height="15" fill="#111" fill-opacity="0.8"/>` +
    `<text x="${x + 4}" y="${y + 12}" font-family="Consolas, monospace" font-size="11" fill="#ff8be8">${t}</text>`;
  for (let x = step; x < w; x += step) s.push(lab(x + 2, 0, x), lab(x + 2, h - 15, x));
  for (let y = step; y < h; y += step) s.push(lab(0, y + 2, y), lab(w - textWidth(y, 11), y + 2, y));
  return s.join('');
}

// Główna funkcja: shot (pełne RGBA) → obraz dla AI (+ nakładka). Boxy w WSPÓŁRZĘDNYCH EKRANU.
async function renderShot(shot, opts = {}) {
  const st = getSettings();
  const { w, h } = viewSize(shot.width, shot.height, opts.maxWidth);
  const zoomUp = opts.upscale && w === shot.width ? Math.min(opts.upscale, Math.floor(1600 / shot.width) || 1) : 1;
  const outW = Math.max(1, Math.round(w * zoomUp));
  const outH = Math.max(1, Math.round(h * zoomUp));
  shot.setView(outW, outH);

  let img = sharp(shot.rgba, { raw: { width: shot.width, height: shot.height, channels: 4 } });
  if (outW !== shot.width || outH !== shot.height) {
    img = img.resize(outW, outH, { kernel: zoomUp > 1 ? 'nearest' : 'lanczos3', fit: 'fill' });
  }
  const boxes = (opts.boxes || []).map((b) => ({ ...b, ...shot.toImageBox(b) }));
  const clicks = (opts.clicks || []).map((c) => ({ ...c, ...shot.toImage(c.x, c.y) }));
  const paths = (opts.paths || []).map((p) => ({ ...p, points: p.points.map((pt) => shot.toImage(pt.x, pt.y)) }));
  const fontSize = Math.max(11, Math.min(15, Math.round(outW / 110)));
  if (boxes.length || clicks.length || paths.length || opts.grid) {
    const gridStep = opts.gridStep || (outW > 1000 ? 100 : 50);
    const svg = overlaySvg(outW, outH, { boxes, clicks, paths, grid: !!opts.grid, gridStep, fontSize });
    img = sharp(await img.png({ compressionLevel: 1 }).toBuffer()).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
  }
  const format = opts.format || (zoomUp > 1 ? 'png' : st.imageFormat) || 'jpeg';
  let buffer;
  let mime;
  if (format === 'png') {
    buffer = await img.png({ compressionLevel: 6 }).toBuffer();
    mime = 'image/png';
  } else {
    buffer = await img.jpeg({ quality: opts.quality || st.jpegQuality || 82, mozjpeg: true }).toBuffer();
    mime = 'image/jpeg';
  }
  let file = null;
  // pid w nazwie: numeracja zrzutów zaczyna się od s1 po każdym starcie serwera
  if (opts.save !== false) file = saveForStudio(`${shot.id}${opts.suffix ? `-${opts.suffix}` : ''}-${process.pid}`, buffer, mime);
  return { buffer, mime, base64: buffer.toString('base64'), width: outW, height: outH, file };
}

// Ostatnie obrazy trafiają do data/shots, żeby Studio mogło je pokazać publiczności.
let saveCounter = 0;
function saveForStudio(name, buffer, mime) {
  try {
    ensureDir(SHOTS_DIR);
    const file = path.join(SHOTS_DIR, `${name}.${mime === 'image/png' ? 'png' : 'jpg'}`);
    fs.writeFileSync(file, buffer);
    if (++saveCounter % 10 === 0) pruneShots();
    return file;
  } catch {
    return null;
  }
}

function pruneShots(keep = 80) {
  try {
    const files = fs.readdirSync(SHOTS_DIR).map((f) => ({ f, t: fs.statSync(path.join(SHOTS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) fs.unlinkSync(path.join(SHOTS_DIR, x.f));
  } catch { /* ignore */ }
}

async function rgbaToPng(rgba, width, height, { scale = 1 } = {}) {
  let img = sharp(rgba, { raw: { width, height, channels: 4 } });
  if (scale !== 1) img = img.resize(Math.round(width * scale), Math.round(height * scale), { kernel: scale > 1 ? 'lanczos3' : 'lanczos3' });
  return img.png({ compressionLevel: 1 }).toBuffer();
}

async function writeTempPng(rgba, width, height, scale = 1) {
  ensureDir(TMP_DIR);
  const file = path.join(TMP_DIR, `ocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  await sharp(rgba, { raw: { width, height, channels: 4 } })
    .resize(Math.round(width * scale), Math.round(height * scale), { kernel: 'lanczos3' })
    .png({ compressionLevel: 1 }).toFile(file);
  return file;
}

async function pngToRgba(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, width: info.width, height: info.height };
}

module.exports = { COLORS, renderShot, overlaySvg, viewSize, rgbaToPng, writeTempPng, pngToRgba, saveForStudio, esc };
