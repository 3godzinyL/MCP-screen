// Import starej, ręcznej kalibracji z bocikmexik (data/coordinates.json) jako profil „mexc_bocik”.
// To współrzędne na sztywno, bez wycinków — dobrze pokazują różnicę między starą a nową wersją.
const path = require('path');
const fs = require('fs');
const paths = require('./paths');
const elements = require('./elements');
const { readJson } = require('./json');
const { emit } = require('./events');

const BOCIK_DIR = path.join(path.dirname(paths.ROOT), 'bocikmexik');
const BOCIK_COORDS = path.join(BOCIK_DIR, 'data', 'coordinates.json');

function available() { return fs.existsSync(BOCIK_COORDS); }

function importBocik() {
  const data = readJson(BOCIK_COORDS, null);
  if (!data || !data.regions) throw new Error(`Nie znalazłem ${BOCIK_COORDS}`);
  let meta = {};
  try {
    const { REQUIRED_REGIONS } = require(path.join(BOCIK_DIR, 'src', 'storage', 'regions.js'));
    meta = Object.fromEntries(REQUIRED_REGIONS.map((r) => [r.name, r]));
  } catch { /* opisy są opcjonalne */ }
  const prof = 'mexc_bocik';
  const prev = elements.activeProfile();
  elements.setActiveProfile(prof);
  const d = elements.loadProfile(prof);
  d.description = 'Import ręcznej kalibracji z bocikmexik (stara wersja: bez wzorców, współrzędne na sztywno).';
  elements.saveProfile(prof, d);
  let n = 0;
  for (const [name, r] of Object.entries(data.regions)) {
    const m = meta[name] || {};
    elements.saveRaw(prof, {
      name, description: m.pl || m.desc || '', kind: m.group || '', box: { x: r.x, y: r.y, w: r.w, h: r.h },
      center: { x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) }, source: 'bocikmexik', template: null, window: null,
    });
    n++;
  }
  if (prev && prev !== prof) elements.setActiveProfile(prev);
  emit('import', { from: 'bocikmexik', profile: prof, count: n });
  return { profile: prof, count: n, screen: data.screen };
}

module.exports = { importBocik, available, BOCIK_COORDS };
