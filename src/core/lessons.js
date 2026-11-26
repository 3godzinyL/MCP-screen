// Lekcje = nagrania człowieka (kliknięcia, wpisany tekst, klawisze) z mapą klikniętych elementów.
// data/lessons/<nazwa>/lesson.json + step-<n>.png (zrzut okna w chwili kliknięcia)
// Z lekcji AI uczy się aplikacji, a jednym poleceniem robi z niej przepis (sekwencję) ze zmiennymi.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { DATA_DIR } = require('./paths');
const { readJson, writeJson, ensureDir, safeName } = require('./json');
const { detectCv } = require('./detect/cv');
const { categoryOf, slug } = require('./categories');
const win32 = require('./win32');

const LESSONS_DIR = path.join(DATA_DIR, 'lessons');

function lessonDir(name) { return path.join(LESSONS_DIR, safeName(name)); }

function list() {
  try {
    return fs.readdirSync(LESSONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const l = readJson(path.join(LESSONS_DIR, d.name, 'lesson.json'), null);
      if (!l) return null;
      return { name: l.name, goal: l.goal || '', steps: (l.steps || []).length, apps: l.apps || [], createdAt: l.createdAt, durationMs: l.durationMs || 0 };
    }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch {
    return [];
  }
}

function get(name) {
  const l = readJson(path.join(lessonDir(name), 'lesson.json'), null);
  if (!l) throw new Error(`Nie ma lekcji „${name}”. Dostępne: ${list().map((x) => x.name).join(', ') || '(brak — nagraj w MPC Studio, F9)'}`);
  return l;
}

function save(lesson) {
  const dir = ensureDir(lessonDir(lesson.name));
  lesson.updatedAt = new Date().toISOString();
  writeJson(path.join(dir, 'lesson.json'), lesson);
  return lesson;
}

function remove(name) {
  const dir = lessonDir(name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function stepImagePath(name, file) { return path.join(lessonDir(name), file); }

async function saveStepImage(name, i, shot) {
  const dir = ensureDir(lessonDir(name));
  const file = `step-${String(i).padStart(3, '0')}.png`;
  await sharp(shot.rgba, { raw: { width: shot.width, height: shot.height, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(dir, file));
  return file;
}

// ── Co zostało kliknięte? (bez AI) ────────────────────────────────────────
// 1) UI Automation — dokładny prostokąt, typ i nazwa kontrolki
// 2) piksele — najmniejszy „pojemnik” (przycisk/pole) zawierający punkt, albo plama treści obok
// 3) OCR napisu w strefie (do nazwy)    4) awaryjnie: mały prostokąt wokół punktu
// Czy pod punktem jest treść (napis/ikona), a nie gładkie tło — mały wycinek, analiza pikseli.
function textAtPoint(shot, point) {
  // szeroko: CV pomija plamy dotykające brzegu wycinka, a napis etykiety bywa długi
  const w = Math.min(shot.width, 640);
  const h = Math.min(shot.height, 100);
  const x = Math.max(shot.rect.x, Math.min(point.x - w / 2, shot.rect.x + shot.width - w));
  const y = Math.max(shot.rect.y, Math.min(point.y - h / 2, shot.rect.y + shot.height - h));
  const crop = shot.crop({ x: Math.round(x), y: Math.round(y), w, h });
  const det = detectCv(crop.rgba, crop.width, crop.height, { scale: win32.monitorScaleAt(point.x, point.y) });
  const px = point.x - crop.rect.x;
  const py = point.y - crop.rect.y;
  return det.items.some((b) => b.kind === 'content' && px >= b.x - 4 && py >= b.y - 4 && px <= b.x + b.w + 4 && py <= b.y + b.h + 4);
}

async function analyzeClick({ shot, point, uiaPromise = null }) {
  const win = shot.window && shot.window.rect ? shot.window.rect : shot.rect;
  let uia = null;
  try { uia = uiaPromise ? await uiaPromise : null; } catch { uia = null; }
  if (uia && uia.found) {
    const area = uia.w * uia.h;
    const inWin = uia.x >= win.x - 2 && uia.y >= win.y - 2 && uia.x + uia.w <= win.x + win.w + 2 && uia.y + uia.h <= win.y + win.h + 2;
    const reasonable = uia.w >= 6 && uia.h >= 6 && area < 0.25 * win.w * win.h && !['Pane', 'Window', 'Document', 'Group', 'Custom'].includes(uia.type);
    // via=label: klik w napis obok checkboxa/radia — przyjmujemy tylko, gdy pod punktem naprawdę jest napis
    const contains = uia.via === 'label'
      ? textAtPoint(shot, point)
      : point.x >= uia.x - 1 && point.y >= uia.y - 1 && point.x <= uia.x + uia.w + 1 && point.y <= uia.y + uia.h + 1;
    if (inWin && reasonable && contains) {
      return {
        source: 'uia', role: uia.type, name: (uia.name || '').trim(), automationId: uia.id || '', password: !!uia.password,
        box: { x: Math.round(uia.x), y: Math.round(uia.y), w: Math.round(uia.w), h: Math.round(uia.h) },
        category: categoryOf(uia.type),
      };
    }
  }
  // piksele: wycinek wokół punktu, żeby było szybko
  const cw = Math.min(shot.width, 520);
  const ch = Math.min(shot.height, 300);
  const cx = Math.max(shot.rect.x, Math.min(point.x - cw / 2, shot.rect.x + shot.width - cw));
  const cy = Math.max(shot.rect.y, Math.min(point.y - ch / 2, shot.rect.y + shot.height - ch));
  const crop = shot.crop({ x: Math.round(cx), y: Math.round(cy), w: cw, h: ch });
  const scale = win32.monitorScaleAt(point.x, point.y);
  const det = detectCv(crop.rgba, crop.width, crop.height, { scale });
  const px = point.x - crop.rect.x;
  const py = point.y - crop.rect.y;
  const inside = (b, pad = 0) => px >= b.x - pad && py >= b.y - pad && px <= b.x + b.w + pad && py <= b.y + b.h + pad;
  const containers = det.items.filter((b) => b.kind !== 'content' && inside(b)).sort((a, b) => a.w * a.h - b.w * b.h);
  const blobs = det.items.filter((b) => b.kind === 'content' && inside(b, 10))
    .sort((a, b) => Math.hypot(a.x + a.w / 2 - px, a.y + a.h / 2 - py) - Math.hypot(b.x + b.w / 2 - px, b.y + b.h / 2 - py));
  let pick = containers[0] || blobs[0] || null;
  let role = pick ? (pick.kind === 'field' ? 'pole?' : pick.kind === 'container' ? 'przycisk?' : 'ikona/tekst?') : 'punkt';
  let box = pick
    ? { x: crop.rect.x + pick.x, y: crop.rect.y + pick.y, w: pick.w, h: pick.h }
    : { x: point.x - 22, y: point.y - 14, w: 44, h: 28 };
  // za duże pojemniki (cały panel) zamieniamy na mniejszą strefę wokół punktu
  if (box.w * box.h > 0.2 * shot.width * shot.height) {
    box = { x: point.x - 40, y: point.y - 16, w: 80, h: 32 };
    role = 'punkt';
  }
  return { source: pick ? 'cv' : 'point', role, name: '', automationId: '', password: false, box, category: categoryOf(role, 'inne') };
}

// Krótki OCR napisu w strefie (do nazwy elementu, gdy UIA nie podało nazwy)
async function ocrLabel(shot, box) {
  try {
    const { ocrShot } = require('./detect/ocr');
    const capture = require('./capture');
    const pad = 4;
    const sub = capture.fromCrop(shot, { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad }, 'ocr-label');
    const o = await ocrShot(sub, { scale: 3 });
    return o.lines.map((l) => l.text).join(' ').trim().slice(0, 60);
  } catch {
    return '';
  }
}

// ── Lekcja → przepis (sekwencja) ──────────────────────────────────────────
// Wpisany tekst staje się zmienną (domyślna wartość = to, co wpisał człowiek); hasła zmienną bez wartości.
function toSequenceDef(lesson, { name, goal, variables = 'auto', insertWaits = true } = {}) {
  const steps = [];
  const vars = {};
  let lastApp = null;
  let lastWindow = null;
  let prevT = null;
  const varName = (base) => {
    let n = slug(base, 24) || 'tekst';
    let k = n;
    let i = 2;
    while (vars[k] !== undefined) k = `${n}_${i++}`;
    return k;
  };
  for (const s of lesson.steps || []) {
    if (s.skip) continue;
    if (s.window && s.window.process && (s.app !== lastApp || (lastWindow && s.window.title && !s.window.title.startsWith(lastWindow.slice(0, 12))))) {
      const t = (s.window.title || '').split(/[—–|]/)[0].trim().slice(0, 40) || s.window.process;
      steps.push({ action: 'focus', window: t });
      lastApp = s.app;
      lastWindow = s.window.title || '';
    }
    if (insertWaits && prevT !== null && s.t - prevT > 1500) steps.push({ action: 'wait_stable', timeout_ms: Math.min(8000, Math.round((s.t - prevT) * 1.5)) });
    prevT = s.t;
    if (s.type === 'click') {
      steps.push({ action: 'click', element: s.element, ...(s.button && s.button !== 'left' ? { button: s.button } : {}), ...(s.double ? { double: true } : {}), ...(s.note ? { note: s.note } : {}) });
    } else if (s.type === 'type') {
      let text = s.text;
      if (s.secret) {
        const v = varName(s.var || 'haslo');
        vars[v] = '';
        text = `{{${v}}}`;
      } else if (s.var || variables === 'auto') {
        const v = varName(s.var || s.field || 'tekst');
        vars[v] = s.text;
        text = `{{${v}}}`;
      }
      steps.push({ action: 'type', text, ...(s.clear ? { clear: true } : {}) });
    } else if (s.type === 'keys') {
      steps.push({ action: 'keys', keys: s.keys });
    } else if (s.type === 'drag') {
      steps.push({ action: 'drag', from: { element: s.element }, to: { x: s.to.x, y: s.to.y } });
    }
  }
  const profile = (lesson.apps || [])[0] || undefined;
  return {
    name: name || `przepis_${slug(lesson.name, 30)}`,
    description: `Z lekcji „${lesson.name}”${lesson.goal ? `: ${lesson.goal}` : ''}`,
    goal: goal || lesson.goal || '',
    profile,
    variables: Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== '')),
    secrets: Object.entries(vars).filter(([, v]) => v === '').map(([k]) => k),
    steps,
    createdBy: 'human',
  };
}

// Krótki opis kroku (do list i do AI)
function stepLabel(s) {
  if (s.type === 'click') return `${s.double ? 'dwuklik' : 'klik'} ${s.element}${s.elementInfo && s.elementInfo.name ? ` („${s.elementInfo.name.slice(0, 40)}”)` : ''} [${s.elementInfo ? s.elementInfo.category : ''}]`;
  if (s.type === 'type') return s.secret ? 'wpisanie hasła (ukryte)' : `wpisz „${String(s.text).slice(0, 60)}”${s.field ? ` w ${s.field}` : ''}`;
  if (s.type === 'keys') return `klawisze ${s.keys}`;
  if (s.type === 'drag') return `przeciągnij ${s.element} → (${s.to.x}, ${s.to.y})`;
  return s.type;
}

module.exports = { LESSONS_DIR, lessonDir, list, get, save, remove, saveStepImage, stepImagePath, analyzeClick, ocrLabel, toSequenceDef, stepLabel };
