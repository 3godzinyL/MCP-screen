// Dziennik zdarzeń (data/events.jsonl). Serwer MCP dopisuje, Studio czyta na żywo
// i pokazuje publiczności, co AI właśnie robi (zrzut, wykrywanie, klik, sekwencja).
const fs = require('fs');
const path = require('path');
const { EVENTS_FILE, HEARTBEAT_FILE } = require('./paths');
const { ensureDir, writeJson } = require('./json');

const MAX_BYTES = 4 * 1024 * 1024;
let source = 'mcp';
let seq = 0;

function setSource(name) { source = name; }

function rotateIfNeeded() {
  try {
    const st = fs.statSync(EVENTS_FILE);
    if (st.size > MAX_BYTES) {
      const old = EVENTS_FILE.replace(/\.jsonl$/, '.1.jsonl');
      try { fs.unlinkSync(old); } catch { /* brak */ }
      fs.renameSync(EVENTS_FILE, old);
    }
  } catch { /* brak pliku */ }
}

function emit(type, payload = {}) {
  const ev = { ts: Date.now(), pid: process.pid, src: source, n: ++seq, type, ...payload };
  try {
    ensureDir(path.dirname(EVENTS_FILE));
    if (seq % 50 === 0) rotateIfNeeded();
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(ev) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[mpc] events: ${err.message}\n`);
  }
  return ev;
}

function heartbeat(info) {
  try { writeJson(HEARTBEAT_FILE, { ts: Date.now(), pid: process.pid, ...info }); } catch { /* ignore */ }
}

module.exports = { emit, heartbeat, setSource };
