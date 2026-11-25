// Akcje wysokiego poziomu — wspólne dla narzędzi MCP i dla odtwarzania sekwencji.
// Każda akcja: rozwiąż cel → ruch jak człowiek → wykonaj → (opcjonalnie) sprawdź, czy ekran się zmienił.
const input = require('./input');
const capture = require('./capture');
const elements = require('./elements');
const win32 = require('./win32');
const { resolveTarget, guardTarget, describeTarget, hasTarget, findWindow, shotForArea } = require('./target');
const { diffRatio } = require('./match');
const { ocrShot, searchText } = require('./detect/ocr');
const { getSettings } = require('./settings');
const { emit } = require('./events');

// Jedna akcja naraz — mysz jest jedna.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function around(box, pad) {
  const vs = win32.virtualScreen();
  const x = Math.max(vs.x, box.x - pad);
  const y = Math.max(vs.y, box.y - pad);
  const x2 = Math.min(vs.x + vs.w, box.x + box.w + pad);
  const y2 = Math.min(vs.y + vs.h, box.y + box.h + pad);
  return { x, y, w: x2 - x, h: y2 - y };
}

async function snapshot(rect) {
  if (getSettings().dryRun) return null;
  try { return await capture.grabRect(rect); } catch { return null; }
}

async function measureChange(before, rect, delayMs = 450) {
  if (!before) return null;
  await input.sleep(delayMs);
  const after = await capture.grabRect(rect);
  return +diffRatio(before.rgba, after.rgba).toFixed(4);
}

async function doClick(t, { button = 'left', double = false, verify = false } = {}) {
  const r = await resolveTarget(t);
  const vRect = verify ? around(r.box.w > 1 ? r.box : { ...r.point, w: 1, h: 1 }, 160) : null;
  const before = verify ? await snapshot(vRect) : null;
  const mv = await input.moveTo(r.point, { targetW: Math.max(8, Math.min(r.box.w, r.box.h)), label: r.label });
  guardTarget(r); // okno mogło zostać zasłonięte w trakcie ruchu
  const c = await input.click({ button, double, at: r.point, label: r.label });
  const changed = verify ? await measureChange(before, vRect) : null;
  return { action: 'click', target: r.label, kind: r.kind, point: r.point, box: r.box, info: r.info, motion: mv.method, recording: mv.recording, moveMs: mv.durationMs, dry: !!c.dry, changed };
}

async function doMove(t) {
  const r = await resolveTarget(t);
  const mv = await input.moveTo(r.point, { targetW: Math.max(8, Math.min(r.box.w, r.box.h)), label: r.label });
  return { action: 'move', target: r.label, point: r.point, box: r.box, info: r.info, motion: mv.method, moveMs: mv.durationMs, dry: !!mv.dry };
}

async function doDrag(from, to) {
  const a = await resolveTarget(from);
  const b = await resolveTarget(to);
  guardTarget(a);
  await input.drag(a.point, b.point, { targetW: Math.max(8, Math.min(b.box.w, b.box.h)) });
  return { action: 'drag', from: a.label, to: b.label, fromPoint: a.point, toPoint: b.point };
}

async function doScroll({ target, direction = 'down', amount = 3 } = {}) {
  let r = null;
  if (hasTarget(target)) {
    r = await resolveTarget(target);
    await input.moveTo(r.point, { targetW: Math.max(8, Math.min(r.box.w, r.box.h)), label: r.label });
    guardTarget(r);
  }
  await input.scroll({ direction, amount });
  return { action: 'scroll', direction, amount, target: r ? r.label : 'pod kursorem', point: r ? r.point : input.plannedCursor() };
}

async function doType(text, { target, clear = false, enter = false } = {}) {
  let r = null;
  if (hasTarget(target)) {
    r = await resolveTarget(target);
    await input.moveTo(r.point, { targetW: Math.max(8, Math.min(r.box.w, r.box.h)), label: r.label });
    guardTarget(r);
    await input.click({ at: r.point, label: r.label });
  }
  if (clear) {
    await input.pressKeys('Ctrl+A');
    await input.sleep(90);
    await input.pressKeys('Delete');
    await input.sleep(80);
  }
  const n = await input.typeText(text);
  if (enter) { await input.sleep(120); await input.pressKeys('Enter'); }
  return { action: 'type', chars: n, target: r ? r.label : 'aktywne pole', clear, enter };
}

async function doKeys(keys, { repeat = 1 } = {}) {
  const k = await input.pressKeys(keys, { repeat });
  return { action: 'keys', keys: k, repeat };
}

async function doFocus({ window: query, hwnd, maximize = false } = {}) {
  let w = null;
  if (hwnd) w = win32.describeWindow(hwnd);
  else w = await findWindow(query);
  if (!w) throw new Error(`Nie znalazłem okna „${query || hwnd}”. Sprawdź list_windows.`);
  emit('focus', { title: w.title, process: w.process, dry: !!getSettings().dryRun });
  if (getSettings().dryRun) return { action: 'focus', window: w.title, process: w.process, ok: true, dry: true };
  win32.focusWindow(w.hwnd, { maximize });
  await input.sleep(220);
  let method = 'normal';
  if (!win32.isForeground(w.hwnd)) {
    win32.forceFocusByRestore(w.hwnd);
    await input.sleep(450);
    method = 'restore';
  }
  const ok = win32.isForeground(w.hwnd);
  const now = win32.describeWindow(w.hwnd);
  return { action: 'focus', window: now.title, process: now.process, rect: now.rect, ok, method };
}

// Czekanie na pojawienie się / zniknięcie elementu albo napisu.
async function doWaitFor({ element, text, gone = false, timeout_ms = 8000, window: winQuery, region, profile } = {}) {
  const t0 = Date.now();
  const deadline = t0 + Math.max(200, Math.min(120000, timeout_ms));
  let last = null;
  let polls = 0;
  if (getSettings().dryRun) return { action: 'wait_for', ok: true, dry: true, what: element ? `element ${element}` : `napis „${text}”` };
  while (true) {
    input.checkStop();
    polls++;
    let present = false;
    if (element) {
      try {
        last = await elements.resolveElement(element, { profile: profile || elements.activeProfile(), mode: 'auto' });
        present = true;
      } catch (e) {
        last = { error: e.message };
        present = false;
      }
    } else if (text) {
      const shot = await shotForArea({ window: winQuery, region });
      const ocr = await ocrShot(shot);
      const hits = searchText(ocr, text);
      present = hits.length > 0;
      last = present ? { found: hits[0].text, box: { x: hits[0].x, y: hits[0].y, w: hits[0].w, h: hits[0].h } } : null;
    } else {
      throw new Error('wait_for potrzebuje element albo text');
    }
    if (present !== gone) {
      return { action: 'wait_for', ok: true, what: element ? `element ${element}` : `napis „${text}”`, gone, ms: Date.now() - t0, polls, last };
    }
    if (Date.now() > deadline) {
      return { action: 'wait_for', ok: false, what: element ? `element ${element}` : `napis „${text}”`, gone, ms: Date.now() - t0, polls, last };
    }
    await input.sleep(350);
  }
}

// Czekanie, aż ekran przestanie się zmieniać (strona się doładowała, animacja skończyła).
async function doWaitStable({ region, timeout_ms = 6000, quiet_ms = 600 } = {}) {
  if (getSettings().dryRun) return { action: 'wait_stable', ok: true, dry: true };
  const rect = region || win32.primaryScreen();
  const t0 = Date.now();
  let prev = await capture.grabRect(rect);
  let quietSince = Date.now();
  while (Date.now() - t0 < timeout_ms) {
    input.checkStop();
    await input.sleep(200);
    const cur = await capture.grabRect(rect);
    const d = diffRatio(prev.rgba, cur.rgba);
    if (d > 0.002) quietSince = Date.now();
    prev = cur;
    if (Date.now() - quietSince >= quiet_ms) return { action: 'wait_stable', ok: true, ms: Date.now() - t0 };
  }
  return { action: 'wait_stable', ok: false, ms: Date.now() - t0 };
}

module.exports = { exclusive, doClick, doMove, doDrag, doScroll, doType, doKeys, doFocus, doWaitFor, doWaitStable, describeTarget, around };
