const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) return fallback;
    throw err;
  }
}

// Zapis atomowy: tmp + rename, żeby Studio nigdy nie przeczytało połowy pliku.
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows: rename potrafi chwilowo dostać EPERM, gdy drugi proces czyta plik.
    if (err.code === 'EPERM' || err.code === 'EBUSY') {
      fs.copyFileSync(tmp, file);
      fs.unlinkSync(tmp);
    } else {
      throw err;
    }
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name) {
  return String(name || '').trim().replace(/[^\p{L}\p{N}_\-.]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

module.exports = { readJson, writeJson, ensureDir, safeName };
