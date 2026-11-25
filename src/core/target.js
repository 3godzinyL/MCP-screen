// Jedno miejsce, które zamienia opis celu na piksel na ekranie.
// Cel może być: zapisanym elementem, numerem strefy z detect_elements, napisem (OCR) albo współrzędnymi.
const capture = require('./capture');
const elements = require('./elements');
const win32 = require('./win32');
const { ocrShot, searchText } = require('./detect/ocr');
const { getSettings } = require('./settings');
const { gaussian } = require('./humanizer');

function describeTarget(t) {
  if (!t) return '(brak celu)';
  if (t.element) return `element „${t.element}”`;
  if (t.mark !== undefined && t.mark !== null) return `strefa #${t.mark}${t.shot ? ` na ${t.shot}` : ''}`;
  if (t.text) return `napis „${t.text}”`;
  if (t.x !== undefined) return `${t.space === 'screen' ? 'ekran' : (t.shot || 'ostatni zrzut')} (${t.x}, ${t.y})`;
  return JSON.stringify(t);
}

function hasTarget(t) {
  return !!t && (t.element || (t.mark !== undefined && t.mark !== null) || t.text || (t.x !== undefined && t.y !== undefined));
}

// Człowiek nie klika zawsze w idealny środek — rozrzut w środkowej części elementu.
function humanPoint(box, exact) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const spread = getSettings().targetSpread ?? 0.25;
  if (exact || box.w < 14 || box.h < 10 || spread <= 0) return { x: Math.round(cx), y: Math.round(cy) };
  const dx = Math.max(-box.w * spread, Math.min(box.w * spread, gaussian(box.w * spread * 0.45)));
  const dy = Math.max(-box.h * spread, Math.min(box.h * spread, gaussian(box.h * spread * 0.45)));
  return { x: Math.round(cx + dx), y: Math.round(cy + dy) };
}

async function findWindow(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return null;
  const wins = win32.listWindows().filter((w) => !w.minimized || true);
  const byTitle = wins.filter((w) => w.title.toLowerCase().includes(q));
  const byProc = wins.filter((w) => w.process.toLowerCase() === q || w.process.toLowerCase().includes(q));
  const list = byTitle.length ? byTitle : byProc;
  if (!list.length) return null;
  list.sort((a, b) => (a.minimized - b.minimized) || (a.z - b.z));
  return list[0];
}

async function shotForArea({ window: winQuery, region } = {}) {
  if (region) return capture.capture({ rect: region });
  if (winQuery) {
    const w = await findWindow(winQuery);
    if (!w) throw new Error(`Nie znalazłem okna „${winQuery}”. Użyj list_windows.`);
    if (w.minimized) throw new Error(`Okno „${w.title}” jest zminimalizowane — użyj focus_window.`);
    return capture.capture({ rect: w.rect, window: w });
  }
  return capture.capture();
}

function windowExpect(w) {
  if (!w) return null;
  return { hwnd: w.hwnd ? Number(w.hwnd) : 0, pid: w.pid || 0, process: w.process || '', title: w.title || '' };
}

// Strażnik zasłonięcia: cel należy do okna X — w punkcie kliknięcia musi leżeć to okno
// (albo okno tej samej aplikacji, np. rozwinięta lista). Inaczej klik trafiłby w cudzy program.
function guardTarget(r) {
  if (!r || !r.expect || !r.point) return;
  const top = win32.rootHwndAt(r.point.x, r.point.y);
  if (!top) return;
  const e = r.expect;
  if (e.hwnd && top === e.hwnd) return;
  const info = win32.describeWindow(top);
  if (e.pid && info.pid === e.pid) return;
  if (!e.pid && e.process && info.process.toLowerCase() === e.process.toLowerCase()) return;
  if (!e.hwnd && !e.pid && !e.process) return;
  const err = new Error(`Klik zablokowany: w punkcie (${r.point.x}, ${r.point.y}) leży okno „${info.title || info.className}” [${info.process}], ` +
    `a cel należy do „${e.title}” [${e.process}]. Okno jest zasłonięte — użyj focus_window i wykryj elementy ponownie.`);
  err.blocked = true;
  throw err;
}

// Zwraca { point, box, kind, label, info, expect }
async function resolveTarget(t = {}, { exact = false } = {}) {
  let box = null;
  let kind = '';
  let info = {};
  let expect = null;
  if (t.element) {
    const r = await elements.resolveElement(t.element, { profile: t.profile || elements.activeProfile() });
    box = r.box;
    kind = 'element';
    info = { score: r.score, method: r.method, moved: r.moved, warning: r.warning || null };
    expect = windowExpect(r.window) || (r.element && r.element.window ? windowExpect({ process: r.element.window.process, title: r.element.window.title }) : null);
  } else if (t.mark !== undefined && t.mark !== null) {
    const shot = t.shot ? capture.getShot(t.shot) : findShotWithMarks();
    if (!shot) throw new Error('Brak zrzutu z ponumerowanymi strefami — najpierw detect_elements.');
    const m = shot.marks.get(Number(t.mark));
    if (!m) throw new Error(`Na ${shot.id} nie ma strefy #${t.mark} (jest ${shot.marks.size}).`);
    box = { x: m.x, y: m.y, w: m.w, h: m.h };
    kind = 'mark';
    info = { shot: shot.id, text: m.text || '', role: m.role, source: m.source };
    expect = windowExpect(shot.window);
  } else if (t.text) {
    const shot = await shotForArea({ window: t.window, region: t.region });
    expect = windowExpect(shot.window);
    const ocr = await ocrShot(shot);
    const hits = searchText(ocr, t.text, { exact: !!t.exact_text });
    const n = Math.max(1, Number(t.occurrence) || 1);
    if (hits.length < n) {
      const seen = ocr.phrases.slice(0, 40).map((p) => p.text).join(' | ');
      throw new Error(`Nie widzę napisu „${t.text}”${n > 1 ? ` (wystąpienie ${n})` : ''}. OCR widzi m.in.: ${seen.slice(0, 600)}`);
    }
    const h = hits[n - 1];
    box = { x: h.x, y: h.y, w: h.w, h: h.h };
    kind = 'text';
    info = { found: h.text, score: +h.score.toFixed(2), shot: shot.id, others: hits.length - 1 };
  } else if (t.x !== undefined && t.y !== undefined) {
    let p;
    if (t.space === 'screen') {
      p = { x: Math.round(t.x), y: Math.round(t.y) };
    } else {
      const shot = t.shot ? capture.getShot(t.shot) : capture.latestShot();
      if (!shot) throw new Error('Podaj shot albo space="screen" — nie mam żadnego zrzutu.');
      p = shot.toScreen(Number(t.x), Number(t.y));
      info = { shot: shot.id };
      expect = windowExpect(shot.window);
    }
    box = { x: p.x, y: p.y, w: 1, h: 1 };
    kind = 'coords';
  } else {
    throw new Error('Nie podano celu: element | mark (+shot) | text | x,y (+shot albo space="screen").');
  }
  let point = kind === 'coords' ? { x: box.x, y: box.y } : humanPoint(box, exact || t.exact);
  if (t.offset_x || t.offset_y) point = { x: point.x + Math.round(t.offset_x || 0), y: point.y + Math.round(t.offset_y || 0) };
  const vs = win32.virtualScreen();
  if (point.x < vs.x || point.y < vs.y || point.x >= vs.x + vs.w || point.y >= vs.y + vs.h) {
    throw new Error(`Punkt (${point.x}, ${point.y}) jest poza ekranem ${vs.w}x${vs.h}.`);
  }
  const res = { point, box, kind, label: describeTarget(t), info, expect };
  guardTarget(res);
  return res;
}

function findShotWithMarks() {
  let found = null;
  for (const id of capture.listShots().map((d) => d.split(':')[0])) {
    const s = capture.getShot(id);
    if (s.marks && s.marks.size) found = s;
  }
  return found;
}

module.exports = { resolveTarget, guardTarget, describeTarget, hasTarget, humanPoint, findWindow, shotForArea };
