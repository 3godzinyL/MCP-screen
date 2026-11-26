// Ustawienia wspólne dla serwera MCP i Studia (data/settings.json).
// Studio zmienia je w locie (np. tryb próbny), serwer przeładowuje plik po zmianie mtime.
const fs = require('fs');
const { SETTINGS_FILE, CONTROL_FILE } = require('./paths');
const { readJson, writeJson } = require('./json');

const DEFAULTS = {
  dryRun: false,             // true = nic nie klika naprawdę, tylko rysuje i loguje plan
  motion: 'recorded',        // recorded (nagrane ruchy człowieka) | synthetic (krzywa) | direct (skok)
  speed: 1.0,                // 1 = tempo człowieka, 2 = dwa razy szybciej
  noisePx: 2.0,              // szum ścieżki (px), maleje przy celu
  speedJitter: 0.15,         // ±15% tempa między próbkami
  clickHoldMs: [70, 140],    // czas wciśnięcia przycisku
  preClickPauseMs: [60, 170],
  postClickPauseMs: [120, 320],
  typeDelayMs: [35, 105],    // przerwa między znakami
  targetSpread: 0.25,        // klik nie zawsze w idealny środek (ułamek rozmiaru elementu)
  failsafeCorner: true,      // kursor w lewym górnym rogu = natychmiastowy STOP
  stopOnUserMove: true,      // człowiek ruszył myszką w trakcie ruchu AI = STOP
  maxImageWidth: 1400,       // szerokość zrzutu dla AI (~1,1 MP, bez skalowania po stronie modelu)
  imageFormat: 'jpeg',
  jpegQuality: 82,
  ocrLanguage: 'auto',       // auto | pl | en-US
  ocrScale: 2,               // OCR na powiększonym obrazie = lepsze małe napisy
  matchThreshold: 0.8,       // próg dopasowania wzorca elementu
  activeProfile: 'default',
  lessonHotkey: 'F9',        // skrót start/stop nagrywania lekcji (MPC Studio)
  lessonKeyboard: true,      // nagrywaj wpisywany tekst (hasła wykryte przez UIA są ukrywane)
  lessonMapScreens: true,    // przy nowym ekranie zmapuj wszystkie strefy (UIA + OCR + piksele)
  lessonMotion: true,        // ruch myszy między kliknięciami → próbki ruchu dla AI
};

let cache = null;
let cacheMtime = -1;

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function getSettings() {
  const m = mtimeOf(SETTINGS_FILE);
  if (!cache || m !== cacheMtime) {
    cache = { ...DEFAULTS, ...readJson(SETTINGS_FILE, {}) };
    cacheMtime = m;
  }
  if (process.env.MPC_DRY_RUN === '1') return { ...cache, dryRun: true };
  if (dryOverride !== null) return { ...cache, dryRun: dryOverride };
  return cache;
}

// Tryb próbny tylko na czas jednej operacji (np. sequence_run z dry_run=true).
let dryOverride = null;
async function withDryRun(flag, fn) {
  if (flag === undefined || flag === null) return fn();
  const prev = dryOverride;
  // false z jednego wywołania nigdy nie wyłącza globalnego trybu próbnego
  dryOverride = !!flag || !!getSettings().dryRun;
  try { return await fn(); } finally { dryOverride = prev; }
}

function updateSettings(patch) {
  const current = readJson(SETTINGS_FILE, {});
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS)) continue;
    if (v === undefined) continue;
    next[k] = v;
  }
  writeJson(SETTINGS_FILE, next);
  cache = null;
  return getSettings();
}

// ── Sterowanie awaryjne (STOP ze Studia lub z rogu ekranu) ────────────────
let controlCache = { stop: false };
let controlMtime = -1;

function getControl() {
  const m = mtimeOf(CONTROL_FILE);
  if (m !== controlMtime) {
    controlCache = { stop: false, ...readJson(CONTROL_FILE, {}) };
    controlMtime = m;
  }
  return controlCache;
}

function setControl(patch) {
  const next = { ...readJson(CONTROL_FILE, {}), ...patch, updatedAt: Date.now() };
  writeJson(CONTROL_FILE, next);
  controlMtime = -1;
  return next;
}

module.exports = { DEFAULTS, getSettings, updateSettings, getControl, setControl, withDryRun };
