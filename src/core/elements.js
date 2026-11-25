// Elementy = nazwane niebieskie strefy. Każdy element pamięta:
//   • prostokąt na ekranie (fizyczne px) i wycinek-wzorzec (PNG) do ponownego odnalezienia,
//   • okno, w którym leżał (proces, tytuł, pozycja względem okna),
//   • skąd się wziął: AI (mark/box), człowiek (ręczna kalibracja), import z bocikmexik.
// Profil = aplikacja (np. „notatnik”, „mexc”). Plik: data/profiles/<profil>/elements.json
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { PROFILES_DIR } = require('./paths');
const { readJson, writeJson, ensureDir, safeName } = require('./json');
const { getSettings, updateSettings } = require('./settings');
const win32 = require('./win32');
const capture = require('./capture');
const { matchTemplate, scoreAt } = require('./match');
const { similarity } = require('./detect/ocr');

function profileDir(profile) { return path.join(PROFILES_DIR, safeName(profile) || 'default'); }
function profileFile(profile) { return path.join(profileDir(profile), 'elements.json'); }

function activeProfile() { return getSettings().activeProfile || 'default'; }

function setActiveProfile(name) {
  const p = safeName(name);
  if (!p) throw new Error('Pusta nazwa profilu');
  ensureDir(profileDir(p));
  if (!fs.existsSync(profileFile(p))) saveProfile(p, emptyProfile(p));
  updateSettings({ activeProfile: p });
  return p;
}

function emptyProfile(name) {
  return { version: 1, profile: name, description: '', createdAt: new Date().toISOString(), updatedAt: null, elements: {} };
}

function loadProfile(profile = activeProfile()) {
  const p = safeName(profile) || 'default';
  return readJson(profileFile(p), emptyProfile(p));
}

function saveProfile(profile, data) {
  data.updatedAt = new Date().toISOString();
  writeJson(profileFile(profile), data);
  return data;
}

function listProfiles() {
  try {
    return fs.readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const data = readJson(path.join(PROFILES_DIR, d.name, 'elements.json'), null);
        return { name: d.name, elements: data ? Object.keys(data.elements || {}).length : 0, description: data ? data.description || '' : '', updatedAt: data ? data.updatedAt : null };
      });
  } catch {
    return [];
  }
}

function validName(name) {
  const n = String(name || '').trim();
  if (!/^[\p{L}\p{N}_\-.]{1,64}$/u.test(n)) throw new Error(`Nazwa elementu „${name}” — dozwolone litery, cyfry, _ - . (bez spacji), np. przycisk_zapisz`);
  return n;
}

function windowContext(box, hint = null) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // Zrzut okna wie najlepiej, do którego okna należy element (to, co leży teraz na wierzchu, może być innym oknem).
  const hinted = hint && hint.hwnd && win32.windowExists(hint.hwnd) ? win32.describeWindow(hint.hwnd) : null;
  const win = hinted || win32.windowAt(cx, cy);
  if (!win || !win.rect || win.className === 'Progman' || win.className === 'WorkerW') return null;
  return {
    process: win.process, title: win.title, className: win.className,
    rect: win.rect, rel: { x: box.x - win.rect.x, y: box.y - win.rect.y, w: box.w, h: box.h },
  };
}

// Zapis elementu z prostokąta na zrzucie (box w px ekranu).
async function saveFromShot(shot, { name, box, description = '', kind = '', source = 'ai', text = '', role = '', profile = activeProfile() }) {
  const n = validName(name);
  const data = loadProfile(profile);
  const crop = shot.crop(box);
  const dir = ensureDir(path.join(profileDir(profile), 'crops'));
  const file = `${safeName(n)}.png`;
  await sharp(crop.rgba, { raw: { width: crop.width, height: crop.height, channels: 4 } }).png().toFile(path.join(dir, file));
  const prev = data.elements[n];
  const b = crop.rect;
  data.elements[n] = {
    name: n,
    description: description || (prev && prev.description) || '',
    kind: kind || role || (prev && prev.kind) || '',
    text: text || '',
    box: b,
    center: { x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) },
    scale: win32.monitorScaleAt(b.x + b.w / 2, b.y + b.h / 2),
    window: windowContext(b, shot.window),
    template: `crops/${file}`,
    source,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeen: { at: new Date().toISOString(), box: b, score: 1, method: 'saved' },
    uses: prev ? prev.uses || 0 : 0,
  };
  saveProfile(profile, data);
  return data.elements[n];
}

// Zapis elementu bez obrazu (np. import starych współrzędnych z bocikmexik).
function saveRaw(profile, el) {
  const data = loadProfile(profile);
  const n = validName(el.name);
  data.elements[n] = { createdAt: new Date().toISOString(), uses: 0, ...el, name: n, updatedAt: new Date().toISOString() };
  saveProfile(profile, data);
  return data.elements[n];
}

function removeElement(name, profile = activeProfile()) {
  const data = loadProfile(profile);
  const el = data.elements[name];
  if (!el) return false;
  delete data.elements[name];
  if (el.template) { try { fs.unlinkSync(path.join(profileDir(profile), el.template)); } catch { /* ignore */ } }
  saveProfile(profile, data);
  return true;
}

function renameElement(oldName, newName, profile = activeProfile()) {
  const data = loadProfile(profile);
  const el = data.elements[oldName];
  if (!el) throw new Error(`Nie ma elementu ${oldName}`);
  const n = validName(newName);
  delete data.elements[oldName];
  el.name = n;
  if (el.template) {
    const nf = `crops/${safeName(n)}.png`;
    try { fs.renameSync(path.join(profileDir(profile), el.template), path.join(profileDir(profile), nf)); el.template = nf; } catch { /* ignore */ }
  }
  data.elements[n] = el;
  saveProfile(profile, data);
  return el;
}

function getElement(name, profile = activeProfile()) {
  const data = loadProfile(profile);
  const el = data.elements[name];
  if (el) return { el, profile };
  // podpowiedź przy literówce
  const names = Object.keys(data.elements);
  const best = names.map((n) => ({ n, s: similarity(n.toLowerCase(), String(name).toLowerCase()) })).sort((a, b) => b.s - a.s)[0];
  const hint = best && best.s > 0.5 ? ` Może chodziło o „${best.n}”?` : '';
  throw new Error(`W profilu „${profile}” nie ma elementu „${name}”.${hint} Dostępne: ${names.slice(0, 40).join(', ') || '(brak — użyj label_elements)'}`);
}

const templateCache = new Map();
async function loadTemplate(profile, el) {
  if (!el.template) return null;
  const file = path.join(profileDir(profile), el.template);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}:${st.mtimeMs}`;
  if (templateCache.has(key)) return templateCache.get(key);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const t = { rgba: data, width: info.width, height: info.height };
  templateCache.set(key, t);
  if (templateCache.size > 60) templateCache.delete(templateCache.keys().next().value);
  return t;
}

async function scaledTemplate(tpl, ratio) {
  if (Math.abs(ratio - 1) < 0.03) return tpl;
  const w = Math.max(4, Math.round(tpl.width * ratio));
  const h = Math.max(4, Math.round(tpl.height * ratio));
  const data = await sharp(tpl.rgba, { raw: { width: tpl.width, height: tpl.height, channels: 4 } }).resize(w, h).raw().toBuffer();
  return { rgba: data, width: w, height: h };
}

// Okno, w którym element powinien być teraz (ten sam proces, najbardziej podobny tytuł).
function findWindowFor(el) {
  if (!el.window || !el.window.process) return null;
  const wins = win32.listWindows().filter((w) => w.process.toLowerCase() === el.window.process.toLowerCase() && !w.minimized);
  if (!wins.length) return null;
  const scored = wins.map((w) => ({
    w,
    s: (el.window.title ? similarity(w.title.toLowerCase(), el.window.title.toLowerCase()) : 0) +
      (w.className === el.window.className ? 0.3 : 0) + (w.foreground ? 0.2 : 0) - w.z * 0.01,
  })).sort((a, b) => b.s - a.s);
  return scored[0].w;
}

function intersectScreen(r) {
  const vs = win32.virtualScreen();
  const x = Math.max(vs.x, r.x);
  const y = Math.max(vs.y, r.y);
  const x2 = Math.min(vs.x + vs.w, r.x + r.w);
  const y2 = Math.min(vs.y + vs.h, r.y + r.h);
  if (x2 - x < 4 || y2 - y < 4) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

// Gdzie jest element TERAZ? Najpierw tam, gdzie oczekujemy; potem szukamy w oknie; na końcu na całym ekranie.
async function resolveElement(name, { profile = activeProfile(), threshold, mode = 'auto' } = {}) {
  const { el } = getElement(name, profile);
  const thr = threshold || getSettings().matchThreshold || 0.8;
  const tplRaw = await loadTemplate(profile, el);
  const stored = el.box;
  if (!tplRaw || mode === 'stored') {
    return { name, box: stored, center: el.center, score: null, method: 'stored', moved: false, element: el, warning: tplRaw ? null : 'element bez wzorca — używam zapisanych współrzędnych' };
  }
  const nowScale = win32.monitorScaleAt(stored.x + stored.w / 2, stored.y + stored.h / 2);
  const tpl = await scaledTemplate(tplRaw, el.scale ? nowScale / el.scale : 1);

  const win = findWindowFor(el);
  const expected = win && el.window && el.window.rel
    ? { x: win.rect.x + el.window.rel.x, y: win.rect.y + el.window.rel.y, w: tpl.width, h: tpl.height }
    : { x: stored.x, y: stored.y, w: tpl.width, h: tpl.height };

  const tries = [];
  const margin = Math.max(24, Math.round(Math.max(tpl.width, tpl.height) * 0.5));
  const near = intersectScreen({ x: expected.x - margin, y: expected.y - margin, w: expected.w + 2 * margin, h: expected.h + 2 * margin });
  if (near) tries.push({ rect: near, method: 'expected', thr });
  if (win) {
    const wr = intersectScreen(win.rect);
    if (wr) tries.push({ rect: wr, method: 'window', thr: thr - 0.03 });
  }
  if (mode !== 'near') tries.push({ rect: win32.primaryScreen(), method: 'screen', thr: thr - 0.03 });

  let best = null;
  for (const t of tries) {
    if (t.rect.w < tpl.width || t.rect.h < tpl.height) continue;
    const g = await capture.grabRect(t.rect);
    const m = matchTemplate(g.rgba, g.width, g.height, tpl.rgba, tpl.width, tpl.height);
    const box = { x: g.rect.x + m.x, y: g.rect.y + m.y, w: tpl.width, h: tpl.height };
    if (!best || m.score > best.score) best = { box, score: m.score, method: t.method };
    if (m.score >= t.thr) break;
  }
  const ok = best && best.score >= thr - 0.03;
  const data = loadProfile(profile);
  if (data.elements[name]) {
    data.elements[name].lastSeen = { at: new Date().toISOString(), box: best ? best.box : null, score: best ? +best.score.toFixed(3) : 0, method: best ? best.method : 'none', found: !!ok };
    if (ok) data.elements[name].uses = (data.elements[name].uses || 0) + 1;
    saveProfile(profile, data);
  }
  if (!ok) {
    const e = new Error(`Nie widzę elementu „${name}” na ekranie (najlepsze dopasowanie ${best ? best.score.toFixed(2) : '0'} < ${thr}). Może okno jest zasłonięte, zamknięte albo wygląd się zmienił — zrób screenshot i oznacz element ponownie.`);
    e.best = best;
    throw e;
  }
  const b = best.box;
  return {
    name, box: b, center: { x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) },
    score: +best.score.toFixed(3), method: best.method,
    moved: Math.abs(b.x - stored.x) > 3 || Math.abs(b.y - stored.y) > 3, element: el,
    window: win ? { hwnd: win.hwnd, pid: win.pid, title: win.title, process: win.process } : null,
  };
}

function cropPath(profile, el) {
  return el && el.template ? path.join(profileDir(profile), el.template) : null;
}

module.exports = {
  activeProfile, setActiveProfile, loadProfile, saveProfile, listProfiles, saveFromShot, saveRaw,
  removeElement, renameElement, getElement, resolveElement, cropPath, profileDir, validName, scoreAt,
};
