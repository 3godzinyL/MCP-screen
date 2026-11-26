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
const { categoryOf } = require('./categories');

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
    anchor: computeAnchor(box, win.rect),
    scale: win.hwnd ? win32.windowDpi(win.hwnd) / 96 : 1,
  };
}

// Do której krawędzi okna element jest „przyklejony”? Potrzebne, gdy okno zmieni rozmiar:
// pasek narzędzi zostaje u góry z lewej, przycisk w prawym dolnym rogu jedzie z krawędzią.
function computeAnchor(box, wr) {
  const cx = (box.x + box.w / 2 - wr.x) / wr.w;
  const fromRight = wr.x + wr.w - (box.x + box.w);
  const fromBottom = wr.y + wr.h - (box.y + box.h);
  const h = cx < 0.34 ? 'left' : (cx > 0.66 || fromRight < 60) ? 'right' : 'prop';
  const v = fromBottom < 70 ? 'bottom' : (box.y - wr.y) < 160 ? 'top' : 'prop';
  return { h, v };
}

// Gdzie element powinien być w oknie o nowym położeniu/rozmiarze/skali.
function expectedBox(el, winRect, nowScale = 1) {
  const w0 = el.window;
  if (!w0 || !w0.rel || !w0.rect) return null;
  const k = w0.scale ? nowScale / w0.scale : 1;
  const r0 = w0.rect;
  const rel = w0.rel;
  const a = w0.anchor || { h: 'left', v: 'top' };
  const w = Math.round(rel.w * k);
  const h = Math.round(rel.h * k);
  let x;
  if (a.h === 'right') x = winRect.x + winRect.w - Math.round((r0.w - rel.x) * k);
  else if (a.h === 'prop') x = winRect.x + Math.round(((rel.x + rel.w / 2) / r0.w) * winRect.w - w / 2);
  else x = winRect.x + Math.round(rel.x * k);
  let y;
  if (a.v === 'bottom') y = winRect.y + winRect.h - Math.round((r0.h - rel.y) * k);
  else if (a.v === 'prop') y = winRect.y + Math.round(((rel.y + rel.h / 2) / r0.h) * winRect.h - h / 2);
  else y = winRect.y + Math.round(rel.y * k);
  return { x, y, w, h };
}

// Zapis elementu z prostokąta na zrzucie (box w px ekranu).
// uia = { role, name, automationId } — tożsamość kontrolki z UI Automation (jeśli była).
async function saveFromShot(shot, { name, box, description = '', kind = '', source = 'ai', text = '', role = '', profile = activeProfile(), uia = null, category = '', extra = {} }) {
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
    category: category || categoryOf(role || kind, 'inne'),
    uia: uia && (uia.automationId || uia.name) ? { role: uia.role || role || '', name: uia.name || '', automationId: uia.automationId || '' } : (prev && prev.uia) || null,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSeen: { at: new Date().toISOString(), box: b, score: 1, method: 'saved' },
    uses: prev ? prev.uses || 0 : 0,
    ...extra,
  };
  saveProfile(profile, data);
  return data.elements[n];
}

// Ręczna poprawka (człowiek w edytorze albo AI): nowy prostokąt → nowy wycinek z podanego obrazu.
async function updateElement(name, patch = {}, profile = activeProfile()) {
  const data = loadProfile(profile);
  const el = data.elements[name];
  if (!el) throw new Error(`Nie ma elementu ${name}`);
  if (patch.description !== undefined) el.description = patch.description;
  if (patch.category) el.category = patch.category;
  if (patch.important !== undefined) el.important = !!patch.important;
  if (patch.kind) el.kind = patch.kind;
  if (patch.box && patch.image) {
    // image: { rgba, width, height, rect } — zrzut, na którym poprawiono strefę (współrzędne ekranu)
    const { rgba, width, rect } = patch.image;
    const b = {
      x: Math.max(rect.x, Math.round(patch.box.x)), y: Math.max(rect.y, Math.round(patch.box.y)),
      w: Math.max(3, Math.round(patch.box.w)), h: Math.max(3, Math.round(patch.box.h)),
    };
    b.w = Math.min(b.w, rect.x + rect.w - b.x);
    b.h = Math.min(b.h, rect.y + patch.image.height - b.y);
    const out = Buffer.alloc(b.w * b.h * 4);
    for (let r = 0; r < b.h; r++) {
      const src = ((b.y - rect.y + r) * width + (b.x - rect.x)) * 4;
      rgba.copy(out, r * b.w * 4, src, src + b.w * 4);
    }
    const dir = ensureDir(path.join(profileDir(profile), 'crops'));
    const file = `${safeName(name)}.png`;
    await sharp(out, { raw: { width: b.w, height: b.h, channels: 4 } }).png().toFile(path.join(dir, file));
    el.template = `crops/${file}`;
    el.box = b;
    el.center = { x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) };
    if (patch.window && patch.window.rect) {
      el.window = { ...(el.window || {}), ...patch.window, rel: { x: b.x - patch.window.rect.x, y: b.y - patch.window.rect.y, w: b.w, h: b.h }, anchor: computeAnchor(b, patch.window.rect) };
    } else if (el.window && el.window.rect) {
      el.window.rel = { x: b.x - el.window.rect.x, y: b.y - el.window.rect.y, w: b.w, h: b.h };
      el.window.anchor = computeAnchor(b, el.window.rect);
    }
    el.manual = true;
  }
  el.updatedAt = new Date().toISOString();
  saveProfile(profile, data);
  return el;
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
  let wins = win32.listWindows({ includeUntitled: true, includeTool: true }).filter((w) => w.process.toLowerCase() === el.window.process.toLowerCase() && !w.minimized);
  // ten sam proces bywa wieloma „aplikacjami” (explorer = pasek zadań + foldery) — klasa okna rozstrzyga
  if (el.window.className) {
    const same = wins.filter((w) => w.className === el.window.className);
    if (same.length) wins = same;
  }
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

// Kontrolka po tożsamości z UI Automation (AutomationId / nazwa + typ) — najbliższa oczekiwanemu miejscu.
async function findByUia(el, win, expected) {
  if (!el.uia || !win || !(el.uia.automationId || el.uia.name)) return null;
  try {
    const { workers } = require('./psworker');
    const res = await workers.uia.call('find', { hwnd: win.hwnd, automationId: el.uia.automationId || undefined, name: el.uia.automationId ? undefined : el.uia.name, type: el.uia.role || undefined }, 6000);
    const items = (res.items || []).filter((it) => it.w > 2 && it.h > 2);
    if (!items.length) return null;
    const cx = expected.x + expected.w / 2;
    const cy = expected.y + expected.h / 2;
    items.sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy));
    const it = items[0];
    return { box: { x: Math.round(it.x), y: Math.round(it.y), w: Math.round(it.w), h: Math.round(it.h) }, unique: items.length === 1 };
  } catch {
    return null;
  }
}

// Gdzie jest element TERAZ? Kolejno: tam, gdzie oczekujemy (kotwice + skala okna) → po tożsamości UI Automation
// → w całym oknie → na całym ekranie. Działa po przesunięciu, zmianie rozmiaru okna i zmianie skali DPI.
async function resolveElement(name, { profile = activeProfile(), threshold, mode = 'auto' } = {}) {
  const { el } = getElement(name, profile);
  const thr = threshold || getSettings().matchThreshold || 0.8;
  const tplRaw = await loadTemplate(profile, el);
  const stored = el.box;
  const win = findWindowFor(el);
  if (!tplRaw && !(el.uia && win)) {
    return { name, box: stored, center: el.center, score: null, method: 'stored', moved: false, element: el, window: win ? { hwnd: win.hwnd, pid: win.pid, title: win.title, process: win.process } : null, warning: 'element bez wzorca — używam zapisanych współrzędnych' };
  }
  if (mode === 'stored') return { name, box: stored, center: el.center, score: null, method: 'stored', moved: false, element: el };

  const nowScale = win ? win32.windowDpi(win.hwnd) / 96 : win32.monitorScaleAt(stored.x + stored.w / 2, stored.y + stored.h / 2);
  const savedScale = (el.window && el.window.scale) || el.scale || nowScale;
  const tpl = tplRaw ? await scaledTemplate(tplRaw, nowScale / savedScale) : null;
  const tw = tpl ? tpl.width : stored.w;
  const th = tpl ? tpl.height : stored.h;

  const exp = win ? expectedBox(el, win.rect, nowScale) : null;
  const expected = exp ? { ...exp, w: tw, h: th } : { x: stored.x, y: stored.y, w: tw, h: th };
  const resized = win && el.window && el.window.rect && (Math.abs(win.rect.w - el.window.rect.w) > 4 || Math.abs(win.rect.h - el.window.rect.h) > 4);

  let best = null;
  const consider = (box, score, method) => { if (!best || score > best.score) best = { box, score, method }; };
  const grabMatch = async (rect, method) => {
    if (!tpl || rect.w < tw || rect.h < th) return 0;
    const g = await capture.grabRect(rect);
    const m = matchTemplate(g.rgba, g.width, g.height, tpl.rgba, tw, th);
    consider({ x: g.rect.x + m.x, y: g.rect.y + m.y, w: tw, h: th }, m.score, method);
    return m.score;
  };

  // 1) oczekiwane miejsce (margines rośnie, gdy okno zmieniło rozmiar)
  const margin = Math.max(24, Math.round(Math.max(tw, th) * 0.5), resized ? 60 : 0);
  const near = intersectScreen({ x: expected.x - margin, y: expected.y - margin, w: expected.w + 2 * margin, h: expected.h + 2 * margin });
  if (near && (await grabMatch(near, 'expected')) >= thr) return finish();

  // 2) tożsamość kontrolki (UI Automation) — dokładny prostokąt nawet po przebudowie układu
  const u = await findByUia(el, win, expected);
  if (u) {
    let s = null;
    if (tpl) {
      const pad = 6;
      const r = intersectScreen({ x: u.box.x - pad, y: u.box.y - pad, w: u.box.w + 2 * pad, h: u.box.h + 2 * pad });
      if (r && r.w >= tw && r.h >= th) {
        const g = await capture.grabRect(r);
        s = matchTemplate(g.rgba, g.width, g.height, tpl.rgba, tw, th).score;
      }
    }
    // unikalne AutomationId wystarcza nawet przy zmienionym wyglądzie (np. inny napis na przycisku)
    if (!tpl || (s !== null && s >= thr - 0.2) || (u.unique && el.uia.automationId)) {
      best = { box: u.box, score: s === null ? 1 : Math.max(s, thr), method: 'uia' };
      return finish();
    }
  }

  // 3) całe okno, 4) cały ekran
  if (win) {
    const wr = intersectScreen(win.rect);
    if (wr && (await grabMatch(wr, 'window')) >= thr - 0.03) return finish();
  }
  if (mode !== 'near' && tpl) await grabMatch(win32.primaryScreen(), 'screen');
  return finish();

  function finish() {
    return finishResolve({ name, profile, el, best, thr, stored, win });
  }
}

function finishResolve({ name, profile, el, best, thr, stored, win }) {
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
  updateElement, computeAnchor, expectedBox, findWindowFor,
};
