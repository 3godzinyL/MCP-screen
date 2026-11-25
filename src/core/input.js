// Mysz i klawiatura „jak człowiek” + bezpieczniki.
//  • kursor w lewym górnym rogu ekranu → STOP (10 s blokady)
//  • człowiek poruszył myszą w trakcie ruchu AI → STOP bieżącej akcji
//  • przycisk STOP w MPC Studio → blokada do czasu „Wznów”
//  • tryb próbny (dryRun) → nic się nie klika, Studio rysuje tylko plan
const win32 = require('./win32');
const { planMove, rand } = require('./humanizer');
const recordings = require('./recordings');
const { getSettings, getControl, setControl } = require('./settings');
const { emit } = require('./events');

class StopError extends Error {
  constructor(msg) { super(msg); this.name = 'StopError'; this.stopped = true; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const between = (range, speed = 1) => Math.round(rand(range[0], range[1]) / Math.max(0.2, speed));

let lastSet = null;      // gdzie ostatnio postawiliśmy kursor
let lastSetAt = 0;

function checkStop() {
  const c = getControl();
  if (c.stop) throw new StopError(`Zatrzymane przez człowieka (${c.reason || 'STOP w MPC Studio'}). Poproś o „Wznów” w MPC Studio albo uruchom: node src/cli.js resume`);
  if (c.pauseUntil && Date.now() < c.pauseUntil) {
    throw new StopError(`Pauza bezpieczeństwa jeszcze ${Math.ceil((c.pauseUntil - Date.now()) / 1000)} s (${c.reason || 'róg ekranu'}).`);
  }
  const st = getSettings();
  if (st.failsafeCorner && !st.dryRun) {
    const p = win32.getCursor();
    const vs = win32.virtualScreen();
    if (p.x <= vs.x + 1 && p.y <= vs.y + 1) {
      setControl({ pauseUntil: Date.now() + 10000, reason: 'kursor w lewym górnym rogu (bezpiecznik)' });
      emit('stop', { reason: 'failsafe-corner' });
      throw new StopError('Bezpiecznik: kursor w lewym górnym rogu ekranu. Wszystkie akcje wstrzymane na 10 s.');
    }
  }
}

// W trakcie ruchu AI wystarczy 14 px, żeby uznać, że człowiek złapał mysz.
// Między akcjami tolerujemy trącenie biurka (40 px).
function checkUserMove(threshold = 14) {
  const st = getSettings();
  if (!st.stopOnUserMove || st.dryRun || !lastSet) return;
  const p = win32.getCursor();
  const d = Math.hypot(p.x - lastSet.x, p.y - lastSet.y);
  if (d > threshold && Date.now() - lastSetAt < 4000) {
    lastSet = null;
    emit('stop', { reason: 'user-moved', at: p });
    throw new StopError(`Człowiek przejął mysz (kursor przesunięty o ${Math.round(d)} px). Akcja przerwana.`);
  }
}

function cursor() { return win32.getCursor(); }

// Przejście kursora wzdłuż zaplanowanej ścieżki (próbki {t,x,y}).
async function followPath(samples) {
  const start = Date.now();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const wait = start + s.t - Date.now();
    if (wait > 0) await sleep(wait);
    if (i % 4 === 0) { checkStop(); checkUserMove(i === 0 ? 40 : 14); }
    win32.setCursor(s.x, s.y);
    lastSet = { x: s.x, y: s.y };
    lastSetAt = Date.now();
  }
}

function thin(samples, every = 3) {
  return samples.filter((_, i) => i % every === 0 || i === samples.length - 1).map((s) => ({ x: s.x, y: s.y, t: s.t }));
}

async function moveTo(target, { targetW = 24, motion, label = '' } = {}) {
  checkStop();
  const st = getSettings();
  const start = st.dryRun && lastSet ? lastSet : cursor();
  const plan = planMove(start, target, {
    library: recordings.library(),
    motion: motion || st.motion,
    speed: st.speed,
    noisePx: st.noisePx,
    speedJitter: st.speedJitter,
    targetW,
  });
  const duration = plan.samples.length ? plan.samples[plan.samples.length - 1].t : 0;
  emit('move', { from: start, to: target, method: plan.method, recording: plan.recording, durationMs: duration, path: thin(plan.samples), dry: !!st.dryRun, label });
  if (st.dryRun) {
    await sleep(Math.min(duration, 450));
    lastSet = { ...target };
    lastSetAt = Date.now();
    return { ...plan, durationMs: duration, dry: true };
  }
  await followPath(plan.samples);
  return { ...plan, durationMs: duration, dry: false };
}

async function click({ button = 'left', double = false, at = null, label = '' } = {}) {
  checkStop();
  const st = getSettings();
  const pos = at || (st.dryRun && lastSet ? lastSet : cursor());
  emit('click', { at: pos, button, double, dry: !!st.dryRun, label });
  if (st.dryRun) { await sleep(120); return { at: pos, dry: true }; }
  await sleep(between(st.preClickPauseMs, st.speed));
  checkStop();
  checkUserMove();
  const times = double ? 2 : 1;
  for (let i = 0; i < times; i++) {
    win32.mouseButton(button, true);
    await sleep(double ? between([45, 85]) : between(st.clickHoldMs));
    win32.mouseButton(button, false);
    if (double && i === 0) await sleep(between([70, 130]));
  }
  await sleep(between(st.postClickPauseMs, st.speed));
  lastSet = cursor();
  lastSetAt = Date.now();
  return { at: pos, dry: false };
}

async function mouseDown(button = 'left') {
  checkStop();
  if (getSettings().dryRun) return;
  win32.mouseButton(button, true);
}

async function mouseUp(button = 'left') {
  if (getSettings().dryRun) return;
  win32.mouseButton(button, false);
}

async function drag(from, to, { button = 'left', targetW = 24 } = {}) {
  await moveTo(from, { targetW });
  const st = getSettings();
  emit('drag', { from, to, dry: !!st.dryRun });
  await mouseDown(button);
  try {
    await sleep(between([90, 180]));
    // przeciąganie jest wolniejsze niż zwykły ruch
    const prev = st.speed;
    const plan = planMove(st.dryRun ? from : cursor(), to, { library: recordings.library(), motion: st.motion, speed: prev * 0.7, noisePx: st.noisePx * 0.6, speedJitter: st.speedJitter, targetW });
    emit('move', { from, to, method: plan.method, path: thin(plan.samples), dry: !!st.dryRun, label: 'drag' });
    if (!st.dryRun) await followPath(plan.samples);
    await sleep(between([80, 160]));
  } finally {
    await mouseUp(button);
  }
  lastSet = st.dryRun ? { ...to } : cursor();
  lastSetAt = Date.now();
}

async function scroll({ direction = 'down', amount = 3 } = {}) {
  checkStop();
  const st = getSettings();
  const n = Math.max(1, Math.min(50, Math.round(amount)));
  emit('scroll', { direction, amount: n, at: st.dryRun && lastSet ? lastSet : cursor(), dry: !!st.dryRun });
  if (st.dryRun) { await sleep(100); return; }
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'up' || direction === 'right' ? 1 : -1;
  for (let i = 0; i < n; i++) {
    checkStop();
    win32.mouseWheel(sign, horizontal);
    await sleep(between([45, 110], st.speed));
  }
}

// ── Klawiatura ────────────────────────────────────────────────────────────
const VK = {
  ctrl: 0x11, control: 0x11, ctl: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, backspace: 0x08, bksp: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, ins: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, arrowup: 0x26, arrowdown: 0x28, arrowleft: 0x25, arrowright: 0x27,
  space: 0x20, spacja: 0x20, capslock: 0x14, printscreen: 0x2c, prtsc: 0x2c, menu: 0x5d, apps: 0x5d, pause: 0x13,
  numlock: 0x90, scrolllock: 0x91, plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, mediaplay: 0xb3, medianext: 0xb0, mediaprev: 0xb1,
};
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
for (let i = 0; i <= 9; i++) { VK[String(i)] = 0x30 + i; VK[`num${i}`] = 0x60 + i; VK[`numpad${i}`] = 0x60 + i; }
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c).toLowerCase()] = c;
const MODIFIERS = new Set([0x11, 0x10, 0x12, 0x5b]);

function parseCombo(keys) {
  const parts = Array.isArray(keys) ? keys : String(keys).split(/\s*\+\s*/);
  return parts.filter(Boolean).map((k) => {
    const key = String(k).trim();
    const vk = VK[key.toLowerCase()];
    if (vk) return { vk, name: key };
    if (key.length === 1) {
      const m = win32.vkForChar(key);
      if (m) return { vk: m.vk, name: key, shift: m.shift };
    }
    throw new Error(`Nieznany klawisz „${key}”. Przykłady: Ctrl+S, Alt+F4, Enter, Esc, Tab, F5, Shift+Tab, Win+D, PageDown`);
  });
}

async function pressKeys(keys, { repeat = 1 } = {}) {
  checkStop();
  const st = getSettings();
  const combo = parseCombo(keys);
  const text = combo.map((c) => c.name).join('+');
  emit('keys', { keys: text, repeat, dry: !!st.dryRun });
  if (st.dryRun) { await sleep(80); return text; }
  for (let r = 0; r < Math.max(1, Math.min(50, repeat)); r++) {
    checkStop();
    const needShift = combo.some((c) => c.shift) && !combo.some((c) => c.vk === 0x10);
    const seq = needShift ? [{ vk: 0x10 }, ...combo] : combo;
    for (const c of seq) {
      win32.keyDown(c.vk);
      await sleep(MODIFIERS.has(c.vk) ? between([25, 55]) : between([15, 35]));
    }
    await sleep(between([45, 110]));
    for (const c of [...seq].reverse()) {
      win32.keyUp(c.vk);
      await sleep(between([12, 30]));
    }
    if (repeat > 1) await sleep(between([70, 160], st.speed));
  }
  return text;
}

async function typeText(text, { perChar } = {}) {
  checkStop();
  const st = getSettings();
  const str = String(text ?? '');
  emit('type', { text: str.length > 200 ? `${str.slice(0, 200)}…` : str, length: str.length, dry: !!st.dryRun });
  if (st.dryRun) { await sleep(Math.min(600, str.length * 15)); return str.length; }
  const delay = perChar || st.typeDelayMs;
  let i = 0;
  for (const ch of str) {
    if (i++ % 6 === 0) checkStop();
    if (ch === '\n') { win32.keyTap(0x0d); }
    else if (ch === '\t') { win32.keyTap(0x09); }
    else if (ch === '\r') { continue; }
    else {
      win32.unicodeChar(ch, false);
      await sleep(between([8, 22]));
      win32.unicodeChar(ch, true);
    }
    let pause = between(delay, st.speed);
    if (/[ .,;:!?]/.test(ch) && Math.random() < 0.35) pause += between([40, 160], st.speed);
    await sleep(pause);
  }
  return str.length;
}

// Ostatnia pozycja kursora znana planerowi (w trybie próbnym kursor się nie rusza).
function plannedCursor() {
  return getSettings().dryRun && lastSet ? { ...lastSet } : cursor();
}

module.exports = { moveTo, click, drag, scroll, pressKeys, typeText, mouseDown, mouseUp, checkStop, cursor, plannedCursor, parseCombo, StopError, sleep };
