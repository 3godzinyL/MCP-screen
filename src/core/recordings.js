// Biblioteka nagranych ruchów myszy (format zgodny z bocikmexik: {samples:[{t,x,y}]}).
// Nagrania powstają w MPC Studio (F8) albo automatycznie z nagranej sekwencji kliknięć człowieka.
const fs = require('fs');
const path = require('path');
const { RECORDINGS_DIR } = require('./paths');
const { readJson, writeJson, ensureDir, safeName } = require('./json');
const { trimIdle, describePath } = require('./humanizer');

let cache = null;
let cacheKey = '';

function dirKey() {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.json'));
    return files.length + ':' + files.map((f) => fs.statSync(path.join(RECORDINGS_DIR, f)).mtimeMs).reduce((a, b) => a + b, 0);
  } catch {
    return 'none';
  }
}

function prepare(name, data) {
  const samples = trimIdle((data.samples || []).filter((s) => Number.isFinite(s.x) && Number.isFinite(s.y)));
  if (samples.length < 5) return null;
  const d = describePath(samples);
  return { name, samples, len: d.len, angle: d.angle, duration: d.duration, createdAt: data.createdAt || null, source: data.source || 'human' };
}

function library() {
  const key = dirKey();
  if (cache && key === cacheKey) return cache;
  const out = [];
  try {
    for (const f of fs.readdirSync(RECORDINGS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace(/\.json$/, '');
      const data = readJson(path.join(RECORDINGS_DIR, f), null);
      if (!data) continue;
      const p = prepare(name, data);
      if (p) out.push(p);
    }
  } catch { /* brak katalogu */ }
  cache = out;
  cacheKey = key;
  return out;
}

function list() {
  return library().map((r) => ({
    name: r.name, samples: r.samples.length, lengthPx: Math.round(r.len),
    angleDeg: Math.round((r.angle * 180) / Math.PI), durationMs: Math.round(r.duration), source: r.source, createdAt: r.createdAt,
  }));
}

function get(name) {
  return readJson(path.join(RECORDINGS_DIR, `${safeName(name)}.json`), null);
}

function save(name, samples, meta = {}) {
  ensureDir(RECORDINGS_DIR);
  let base = safeName(name) || `ruch_${Date.now()}`;
  let file = path.join(RECORDINGS_DIR, `${base}.json`);
  if (meta.unique) {
    let i = 2;
    while (fs.existsSync(file)) { file = path.join(RECORDINGS_DIR, `${base}_${i}.json`); i++; }
    base = path.basename(file, '.json');
  }
  const data = {
    version: 1,
    name: base,
    createdAt: new Date().toISOString(),
    source: meta.source || 'human',
    screen: meta.screen || null,
    sampleIntervalMs: meta.sampleIntervalMs || 16,
    samples: samples.map((s) => ({ t: Math.round(s.t), x: Math.round(s.x), y: Math.round(s.y) })),
  };
  writeJson(file, data);
  cache = null;
  return { name: base, file, samples: data.samples.length };
}

function remove(name) {
  const file = path.join(RECORDINGS_DIR, `${safeName(name)}.json`);
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  cache = null;
  return true;
}

module.exports = { library, list, get, save, remove };
