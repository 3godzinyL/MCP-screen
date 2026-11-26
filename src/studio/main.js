// MPC Studio — program do pokazu i pracy z MPC Ekran.
//  • Stara wersja: człowiek sam zaznacza elementy (nakładka jak w bocikmexik) i nagrywa ruchy/sekwencje.
//  • Nowa wersja: AI przez MCP robi to sama — Studio pokazuje na żywo, co AI widzi i co klika.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, screen, globalShortcut, shell, clipboard, protocol, net } = require('electron');
const { pathToFileURL } = require('url');

process.env.MPC_STUDIO = '1';
const win32 = require('../core/win32');
const paths = require('../core/paths');
const capture = require('../core/capture');
const image = require('../core/image');
const elements = require('../core/elements');
const sequences = require('../core/sequences');
const recordings = require('../core/recordings');
const settings = require('../core/settings');
const events = require('../core/events');
const humanizer = require('../core/humanizer');
const { detectElements } = require('../core/detect/index');
const { shutdownWorkers } = require('../core/psworker');
const { readJson, ensureDir, safeName } = require('../core/json');
const lessons = require('../core/lessons');
const apps = require('../core/apps');
const { colorOf, CATEGORIES } = require('../core/categories');
const { createLessonRecorder } = require('./lesson-recorder');
const pkg = require('../../package.json');

events.setSource('studio');
ensureDir(paths.DATA_DIR);

protocol.registerSchemesAsPrivileged([{ scheme: 'mpc', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
// Treść okien Studia widoczna dla Windows UI Automation (nazwy pól i przycisków dla AI).
// Bez tego Chromium pokazuje tylko pustą „Chrome Legacy Window”.
app.commandLine.appendSwitch('force-renderer-accessibility', 'complete');
app.commandLine.appendSwitch('enable-features', 'UiaProvider');

let mainWin = null;
let overlayWin = null;
let hudWin = null;
let demoWin = null;
let overlayMode = 'off';
let overlayShowAi = true;

// ── Okna ──────────────────────────────────────────────────────────────────
const preload = path.join(__dirname, 'preload.js');

function createMain() {
  mainWin = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0c0d10',
    title: 'MPC Studio',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0d10', symbolColor: '#e9e4d8', height: 40 },
    // autotest wyglądu renderuje poza ekranem — nic nie wyskakuje człowiekowi przy pracy
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, offscreen: !!process.env.MPC_STUDIO_SNAP },
    show: false,
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  if (!process.env.MPC_STUDIO_SNAP) mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('closed', () => { mainWin = null; app.quit(); });
  if (process.env.MPC_STUDIO_SNAP) snapPages(process.env.MPC_STUDIO_SNAP);
}

// Autotest wyglądu: każda zakładka → PNG (MPC_STUDIO_SNAP=<folder>), potem wyjście.
function snapPages(dir) {
  mainWin.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1500);
    ensureDir(dir);
    const pages = (process.env.MPC_STUDIO_PAGES || 'show,live,elements,sequences,paths,connect').split(',');
    for (const p of pages) {
      await mainWin.webContents.executeJavaScript(`go(${JSON.stringify(p)})`);
      await wait(900);
      if (p === 'learn' && process.env.MPC_STUDIO_SNAP_LESSON) {
        await mainWin.webContents.executeJavaScript(`openLesson(${JSON.stringify(process.env.MPC_STUDIO_SNAP_LESSON)})`);
        await wait(1500);
        fs.writeFileSync(path.join(dir, 'studio-learn-top.png'), (await mainWin.webContents.capturePage()).toPNG());
        await mainWin.webContents.executeJavaScript("document.getElementById('lesson-editor').scrollIntoView(); document.querySelector('main').scrollTop += 0");
        await wait(500);
        if (process.env.MPC_STUDIO_SNAP_JS) {
          // autotest edytora: kod wykonany w oknie (np. poprawka strefy + zapis przez IPC)
          await mainWin.webContents.executeJavaScript(process.env.MPC_STUDIO_SNAP_JS);
          await wait(2000);
        }
      }
      const img = await mainWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `studio-${p}.png`), img.toPNG());
    }
    if (process.env.MPC_STUDIO_SNAP_OVERLAY === '1') {
      // nakładka: skan „tak widzi AI”, potem tryb ręczny
      openDemo();
      await wait(2500);
      await runScan({});
      await wait(1500);
      fs.writeFileSync(path.join(dir, 'overlay-scan.png'), (await overlayWin.webContents.capturePage()).toPNG());
      setOverlayMode('manual');
      await wait(1500);
      fs.writeFileSync(path.join(dir, 'overlay-manual.png'), (await overlayWin.webContents.capturePage()).toPNG());
      setOverlayMode('off');
      if (mainWin) mainWin.restore();
    }
    if (process.env.MPC_STUDIO_SNAP_KEEP !== '1') app.quit();
  });
}

function primaryDip() {
  const d = screen.getPrimaryDisplay();
  return { bounds: d.bounds, scale: d.scaleFactor };
}

function ensureOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const { bounds } = primaryDip();
  overlayWin = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, resizable: false, movable: false, skipTaskbar: true,
    hasShadow: false, alwaysOnTop: true, focusable: true, show: false, enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  // Nakładka nie trafia na zrzuty ekranu (Windows 10 2004+) — AI widzi aplikację, nie nasze ramki.
  overlayWin.setContentProtection(true);
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; overlayMode = 'off'; notifyMain('overlay-mode', 'off'); });
  return overlayWin;
}

let toolbarBounds = null;
let hoverTimer = null;
function setOverlayMode(mode, payload = {}) {
  if (mode === 'off') {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.close();
    overlayMode = 'off';
    notifyMain('overlay-mode', 'off');
    return;
  }
  const w = ensureOverlay();
  overlayMode = mode;
  const passThrough = mode === 'ai' || mode === 'observe';
  const send = () => {
    w.webContents.send('overlay:mode', { mode, ...payload, display: primaryDip(), profile: elements.activeProfile() });
    w.showInactive();
    // Windows przycina okno do obszaru roboczego (bez paska zadań) — przywracamy cały ekran
    w.setBounds(primaryDip().bounds);
    // dopiero na widocznym oknie Windows przyjmuje WDA_EXCLUDEFROMCAPTURE
    w.setContentProtection(true);
    if (passThrough) w.setIgnoreMouseEvents(true, { forward: true });
    else { w.setIgnoreMouseEvents(false); w.focus(); }
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
  if (hoverTimer) clearInterval(hoverTimer);
  // w trybie AI pasek narzędzi nakładki jest klikalny, reszta przepuszcza mysz do aplikacji
  hoverTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !(overlayMode === 'ai' || overlayMode === 'observe') || !toolbarBounds) return;
    const p = screen.getCursorScreenPoint();
    const b = toolbarBounds;
    const inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    overlayWin.setIgnoreMouseEvents(!inside, { forward: true });
  }, 60);
  notifyMain('overlay-mode', mode);
}

function notifyMain(channel, data) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, data);
}

function sendOverlay(channel, data) {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, data);
}

// ── Przeliczanie px ekranu → DIP okna (laptop ze skalą 125–150%) ─────────
function dipRect(r) {
  if (!r) return r;
  const d = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { ...r, x: d.x, y: d.y, w: d.width, h: d.height };
}
function dipPoint(p) {
  if (!p) return p;
  const d = screen.screenToDipPoint({ x: p.x, y: p.y });
  return { ...p, x: d.x, y: d.y };
}
function screenRect(r) {
  const d = screen.dipToScreenRect(null, { x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: d.x, y: d.y, w: d.width, h: d.height };
}

function eventToDip(ev) {
  const e = { ...ev };
  for (const k of ['at', 'from', 'to']) if (e[k] && typeof e[k].x === 'number') e[k] = dipPoint(e[k]);
  if (e.rect) e.rect = dipRect(e.rect);
  if (Array.isArray(e.path)) e.path = e.path.map(dipPoint);
  if (Array.isArray(e.marks)) e.marks = e.marks.map(dipRect);
  if (Array.isArray(e.elements)) e.elements = e.elements.map((x) => ({ ...x, box: x.box ? dipRect(x.box) : x.box }));
  return e;
}

// ── Podgląd zdarzeń AI na żywo (data/events.jsonl) ───────────────────────
let tailOffset = 0;
let tailBuf = '';
const history = [];

function readTail(initial = false) {
  let st;
  try { st = fs.statSync(paths.EVENTS_FILE); } catch { return; }
  if (st.size < tailOffset) { tailOffset = 0; tailBuf = ''; }
  if (initial && st.size > 600000) tailOffset = st.size - 600000;
  if (st.size === tailOffset) return;
  const fd = fs.openSync(paths.EVENTS_FILE, 'r');
  const len = st.size - tailOffset;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, tailOffset);
  fs.closeSync(fd);
  tailOffset = st.size;
  tailBuf += buf.toString('utf8');
  const lines = tailBuf.split('\n');
  tailBuf = lines.pop();
  const batch = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { batch.push(JSON.parse(line)); } catch { /* urwana linia */ }
  }
  if (initial) {
    history.push(...batch.slice(-400));
    return;
  }
  for (const ev of batch) {
    history.push(ev);
    if (history.length > 600) history.shift();
    notifyMain('event', ev);
    if (overlayWin && !overlayWin.isDestroyed() && overlayShowAi) sendOverlay('overlay:event', eventToDip(ev));
  }
}

function startTail() {
  readTail(true);
  setInterval(() => { try { readTail(false); } catch { /* ignore */ } }, 120);
}

// ── Stan dla interfejsu ───────────────────────────────────────────────────
function heartbeatInfo() {
  const hb = readJson(paths.HEARTBEAT_FILE, null);
  if (!hb) return { connected: false };
  let alive = false;
  try { process.kill(hb.pid, 0); alive = true; } catch { alive = false; }
  return { connected: alive && Date.now() - hb.ts < 30000, ...hb };
}

function stateSnapshot() {
  const st = settings.getSettings();
  return {
    version: pkg.version,
    dataDir: paths.DATA_DIR,
    root: paths.ROOT,
    settings: st,
    control: settings.getControl(),
    mcp: heartbeatInfo(),
    profile: elements.activeProfile(),
    profiles: elements.listProfiles(),
    sequences: sequences.list(),
    recordings: recordings.list(),
    overlayMode,
    dpi: win32.dpiMode,
    monitors: win32.listMonitors(),
    bocikAvailable: bocik.available(),
  };
}

function elementsWithCrops(profile) {
  const data = elements.loadProfile(profile);
  return Object.values(data.elements).map((e) => {
    let crop = null;
    const f = elements.cropPath(profile, e);
    if (f && fs.existsSync(f)) crop = `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    return { ...e, crop };
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// ── Skan „Tak widzi AI” ───────────────────────────────────────────────────
let lastScan = null;
async function runScan({ sources = ['uia', 'ocr', 'cv'], hideStudio = true } = {}) {
  const hadMain = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && !mainWin.isMinimized();
  if (hideStudio && hadMain) { mainWin.minimize(); await new Promise((r) => setTimeout(r, 450)); }
  try {
    const t0 = Date.now();
    const shot = await capture.capture();
    const det = await detectElements(shot, { sources, maxMarks: 220 });
    const boxes = det.marks.map((m) => ({ ...m, label: String(m.id) }));
    const img = await image.renderShot(shot, { boxes, suffix: 'scan' });
    lastScan = { shot, det };
    const by = det.marks.reduce((a, m) => { a[m.source] = (a[m.source] || 0) + 1; return a; }, {});
    const summary = { shot: shot.id, count: det.marks.length, by, ms: Date.now() - t0, timings: det.timings, image: img.file, windows: det.windows };
    events.emit('scan', summary);
    setOverlayMode('scan', { marks: det.marks.map((m) => ({ id: m.id, ...dipRect(m), source: m.source, role: m.role, text: (m.text || '').slice(0, 60) })), summary });
    return summary;
  } catch (err) {
    if (hadMain) mainWin.restore();
    throw err;
  }
}

// ── Nagrywanie człowieka: ruch myszy albo sekwencja kliknięć ─────────────
let rec = null;

function openHud(opts) {
  if (hudWin && !hudWin.isDestroyed()) { hudWin.webContents.send('hud:init', opts); hudWin.show(); return; }
  const d = screen.getPrimaryDisplay().workArea;
  const W = 380;
  const H = 150;
  hudWin = new BrowserWindow({
    x: d.x + d.width - W - 24, y: d.y + 24, width: W, height: H,
    frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, transparent: true,
    backgroundColor: '#00000000', focusable: true,
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.loadFile(path.join(__dirname, 'recorder.html'));
  hudWin.webContents.once('did-finish-load', () => { hudWin.webContents.send('hud:init', opts); hudWin.setContentProtection(true); });
  hudWin.on('closed', () => { hudWin = null; if (rec) recCancel(); globalShortcut.unregister('F8'); });
  globalShortcut.register('F8', () => { if (rec && rec.running) recStop(); else recStart(); });
}

function hudSend(ch, data) { if (hudWin && !hudWin.isDestroyed()) hudWin.webContents.send(ch, data); }

let pendingRec = null;
function recPrepare({ mode = 'path', name = '' }) {
  const n = (name || '').trim() || `${mode === 'path' ? 'ruch' : 'sekwencja'}_${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`;
  pendingRec = { mode, name: n };
  openHud(pendingRec);
  return pendingRec;
}

function insideHud(p) {
  if (!hudWin || hudWin.isDestroyed()) return false;
  const b = hudWin.getBounds();
  const s = screenRect({ x: b.x, y: b.y, w: b.width, h: b.height });
  return p.x >= s.x && p.y >= s.y && p.x <= s.x + s.w && p.y <= s.y + s.h;
}

function recStart() {
  if (!pendingRec) return;
  const start = Date.now();
  rec = { ...pendingRec, running: true, start, samples: [], steps: [], segFrom: 0, down: { left: false, right: false }, busy: Promise.resolve(), lastClick: null };
  rec.timer = setInterval(recTick, 16);
  events.emit('human-record', { status: 'start', mode: rec.mode, name: rec.name });
  hudSend('hud:state', { running: true, mode: rec.mode, name: rec.name });
}

function recTick() {
  if (!rec || !rec.running) return;
  const p = win32.getCursor();
  const t = Date.now() - rec.start;
  rec.samples.push({ t, x: p.x, y: p.y });
  if (rec.mode === 'sequence') {
    for (const [btn, vk] of [['left', 0x01], ['right', 0x02]]) {
      const down = win32.isKeyDown(vk);
      if (down && !rec.down[btn] && !insideHud(p)) onHumanClick(btn, p, t);
      rec.down[btn] = down;
    }
  }
  if (rec.samples.length % 6 === 0) hudSend('hud:tick', { ms: t, samples: rec.samples.length, clicks: rec.steps.filter((s) => s.action === 'click').length });
}

function onHumanClick(button, p, t) {
  const idx = rec.samples.length - 1;
  // dwuklik: drugi klik w to samo miejsce w < 420 ms
  const prev = rec.lastClick;
  if (prev && t - prev.t < 420 && Math.hypot(prev.x - p.x, prev.y - p.y) < 6 && prev.button === button) {
    const step = rec.steps[rec.steps.length - 1];
    if (step && step.action === 'click') step.double = true;
    rec.lastClick = null;
    return;
  }
  rec.lastClick = { ...p, t, button };
  const n = rec.steps.length + 1;
  const segment = rec.samples.slice(rec.segFrom, idx + 1);
  rec.segFrom = idx;
  const name = rec.name;
  const stepIndex = rec.steps.length;
  rec.steps.push({ action: 'click', element: `${name}_k${n}`, at: { x: p.x, y: p.y }, ...(button !== 'left' ? { button } : {}) });
  events.emit('human-click', { at: p, button, i: n, name });
  hudSend('hud:click', { i: n, at: p });
  // wycinek wokół kliknięcia = wzorzec elementu; odcinek drogi = nowe nagranie ruchu do biblioteki
  rec.busy = rec.busy.then(async () => {
    try {
      const box = { x: p.x - 34, y: p.y - 18, w: 68, h: 36 };
      const shot = await capture.capture({ rect: box });
      await elements.saveFromShot(shot, { name: `${name}_k${n}`, box: shot.rect, description: `klik człowieka nr ${n} w sekwencji ${name}`, source: 'human-record' });
      if (segment.length > 6) {
        const a = segment[0];
        const b = segment[segment.length - 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) > 30) {
          const t0 = a.t;
          recordings.save(`${name}_ruch${n}`, segment.map((s) => ({ ...s, t: s.t - t0 })), { source: 'human-sequence', unique: true });
        }
      }
    } catch (err) {
      rec && rec.steps[stepIndex] && (rec.steps[stepIndex].note = `brak wzorca: ${err.message}`);
    }
  });
}

async function recStop() {
  if (!rec || !rec.running) return null;
  clearInterval(rec.timer);
  rec.running = false;
  const r = rec;
  rec = null;
  await r.busy;
  let result;
  if (r.mode === 'path') {
    if (r.samples.length < 6) result = { ok: false, error: 'Za krótkie nagranie' };
    else result = { ok: true, kind: 'path', ...recordings.save(r.name, r.samples, { source: 'human', unique: true, screen: win32.primaryScreen() }) };
  } else {
    if (!r.steps.length) result = { ok: false, error: 'Nie było żadnego kliknięcia' };
    else {
      const seq = sequences.save({ name: r.name, description: 'Nagrane przez człowieka w MPC Studio (kliknięcia + ruchy).', steps: r.steps.map((s) => ({ ...s })), createdBy: 'human' });
      result = { ok: true, kind: 'sequence', name: seq.name, steps: seq.steps.length };
    }
  }
  events.emit('human-record', { status: 'stop', mode: r.mode, name: r.name, ...result });
  hudSend('hud:done', result);
  notifyMain('refresh', {});
  return result;
}

function recCancel() {
  if (rec) { clearInterval(rec.timer); rec = null; }
  pendingRec = null;
  hudSend('hud:done', { ok: false, cancelled: true });
}

// ── Import starej kalibracji z bocikmexik ─────────────────────────────────
const bocik = require('../core/bocik');

// ── Autotest ──────────────────────────────────────────────────────────────
async function selftest() {
  const out = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { const info = await fn(); out.push({ name, ok: true, ms: Date.now() - t0, info }); } catch (e) { out.push({ name, ok: false, ms: Date.now() - t0, info: e.message }); }
  };
  await step('Tryb DPI procesu', async () => `${win32.dpiMode}, skala ${win32.listMonitors().map((m) => `${Math.round(m.scale * 100)}%`).join('/')}`);
  await step('Zrzut ekranu', async () => { const s = await capture.capture(); return `${s.width}x${s.height}`; });
  await step('OCR Windows', async () => { const s = await capture.capture(); const o = await require('../core/detect/ocr').ocrShot(s); return `${o.lang}, ${o.phrases.length} fraz, ${o.ms} ms`; });
  await step('UI Automation', async () => { const s = await capture.capture(); const u = await require('../core/detect/uia').uiaShot(s); return `${u.items.length} kontrolek w ${u.windows.length} oknach, ${u.ms} ms`; });
  await step('Wykrywanie pikseli', async () => { const s = await capture.capture(); const r = require('../core/detect/cv').detectCv(s.rgba, s.width, s.height, {}); return `${r.items.length} kandydatów, ${r.ms} ms`; });
  await step('Serwer MCP', async () => { const h = heartbeatInfo(); return h.connected ? `połączony (${h.client ? h.client.name : 'klient'})` : 'nie działa teraz (uruchomi go AI)'; });
  return out;
}

// ── Strefy na nakładce, które PODĄŻAJĄ za oknem ──────────────────────────
// Strefa pamięta okno (hwnd) i położenie względem niego. Przesuniesz okno → strefy jadą razem z nim.
const zones = [];
let zonesKey = '';
function addZones(list, ms = 20000) {
  const until = Date.now() + ms;
  for (const z of list) {
    const i = zones.findIndex((x) => x.hwnd === z.hwnd && x.name === z.name);
    if (i >= 0) zones.splice(i, 1);
    zones.push({ ...z, until });
  }
  while (zones.length > 400) zones.shift();
  pushZones(true);
}

function zoneFromBox(name, box, category, hwnd = 0) {
  if (!hwnd) hwnd = win32.rootHwndAt(box.x + box.w / 2, box.y + box.h / 2);
  const wr = hwnd ? win32.windowRect(hwnd) : null;
  return wr ? { hwnd, name, category, rel: { x: box.x - wr.x, y: box.y - wr.y, w: box.w, h: box.h } } : { hwnd: 0, name, category, abs: box };
}

function pushZones(force = false) {
  const now = Date.now();
  for (let i = zones.length - 1; i >= 0; i--) if (zones[i].until < now || (zones[i].hwnd && !win32.windowExists(zones[i].hwnd))) zones.splice(i, 1);
  const rects = new Map();
  const out = zones.map((z) => {
    let box = z.abs;
    if (z.hwnd) {
      if (!rects.has(z.hwnd)) rects.set(z.hwnd, win32.windowRect(z.hwnd));
      const wr = rects.get(z.hwnd);
      box = { x: wr.x + z.rel.x, y: wr.y + z.rel.y, w: z.rel.w, h: z.rel.h };
    }
    return { name: z.name, color: colorOf(z.category), box: dipRect(box), ms: z.until - now };
  });
  const key = JSON.stringify(out.map((o) => [o.name, o.box.x, o.box.y, o.box.w]));
  if (!force && key === zonesKey) return;
  zonesKey = key;
  if (out.length && overlayMode === 'off') setOverlayMode('ai');
  sendOverlay('overlay:zones', { zones: out, recording: lessonRec.isRunning() });
}
setInterval(() => { if (zones.length) pushZones(false); }, 150);

// ── Lekcje: nagrywanie pod skrótem ────────────────────────────────────────
// Kliknięcia w samo Studio (okno główne, nakładka, HUD) nie trafiają do lekcji.
// Aplikacja ćwiczebna to ten sam proces, ale JEST celem lekcji — jej nie pomijamy.
function hwndOf(w) {
  if (!w || w.isDestroyed()) return 0;
  const b = w.getNativeWindowHandle();
  return Number(b.length >= 8 ? b.readBigUInt64LE(0) : b.readUInt32LE(0));
}
function isOwnWindow(hwnd) {
  return [mainWin, overlayWin, hudWin].some((w) => hwndOf(w) === Number(hwnd));
}

const lessonRec = createLessonRecorder({
  isOwnWindow,
  onChange: (st) => { notifyMain('lesson-status', st); hudSend('hud:lesson', st); },
  onZone: (z) => addZones([{ hwnd: z.hwnd, rel: z.rel, name: z.name, category: z.category }], 25000),
});

let lessonHotkey = null;
function registerLessonHotkey(acc) {
  if (lessonHotkey) { try { globalShortcut.unregister(lessonHotkey); } catch { /* ignore */ } }
  lessonHotkey = null;
  if (!acc) return { ok: true, hotkey: '' };
  let ok = false;
  try { ok = globalShortcut.register(acc, toggleLesson); } catch { ok = false; }
  if (ok) lessonHotkey = acc;
  return { ok, hotkey: ok ? acc : '' };
}

function hotkeyVk(acc) {
  const key = String(acc || '').split('+').pop();
  const m = key.match(/^F(\d{1,2})$/i);
  if (m) return 0x6f + Number(m[1]);
  if (/^[A-Z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return 0;
}

let pendingGoal = '';
function lessonStart(opts = {}) {
  const st = settings.getSettings();
  const r = lessonRec.start({
    name: opts.name, goal: opts.goal ?? pendingGoal,
    options: { keyboard: opts.keyboard ?? st.lessonKeyboard, mapScreens: opts.mapScreens ?? st.lessonMapScreens, motion: opts.motion ?? st.lessonMotion },
  });
  lessonRec.setHotkeyVk(hotkeyVk(lessonHotkey));
  openHud({ mode: 'lesson', name: r.name, hotkey: lessonHotkey || '' });
  if (overlayMode === 'off') setOverlayMode('ai');
  if (mainWin && !mainWin.isMinimized() && !opts.keepStudio) mainWin.minimize();
  return r;
}

async function lessonStop() {
  const r = await lessonRec.stop();
  hudSend('hud:done', r && r.ok ? { ok: true, kind: 'lesson', name: r.name, steps: r.steps } : { ok: false, error: r ? r.error : 'nie nagrywam' });
  if (mainWin) { mainWin.restore(); mainWin.focus(); }
  if (r && r.ok) notifyMain('lesson-saved', r);
  return r;
}

function toggleLesson() {
  if (lessonRec.isRunning()) lessonStop();
  else lessonStart({});
}

// ── Nauka AI: plik zadania + terminal z Claude ────────────────────────────
function launchCmd(cmdFile) {
  spawn('cmd.exe', ['/c', 'start', '"MPC"', `"${cmdFile}"`], { cwd: paths.ROOT, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }).unref();
}

function launchClaudeWithTask(taskFile, title) {
  const dir = ensureDir(path.join(paths.DATA_DIR, 'learn'));
  const cmdFile = path.join(dir, `${path.basename(taskFile, '.md')}.cmd`);
  // .cmd tylko ASCII (strona kodowa konsoli) — polska treść zadania jest w pliku .md
  const lines = [
    '@echo off',
    `cd /d "${paths.ROOT}"`,
    `title ${title.replace(/[^\x20-\x7e]/g, '_')}`,
    `claude "Read the file ${taskFile.replace(/"/g, '')} and carry out the task described there. Use the MPC Ekran MCP tools and the mpc-ekran skill. Talk to me in Polish."`,
    '',
  ];
  fs.writeFileSync(cmdFile, lines.join('\r\n'), 'ascii');
  launchCmd(cmdFile);
  return cmdFile;
}

function learnTask({ app, goal, lessonNames = [], windowTitle = '' }) {
  const dir = ensureDir(path.join(paths.DATA_DIR, 'learn'));
  const id = `nauka_${safeName(app || 'okno')}_${Date.now()}`;
  const file = path.join(dir, `${id}.md`);
  const ls = lessonNames.length ? lessonNames : lessons.list().filter((l) => (l.apps || []).includes(app)).map((l) => l.name);
  const target = app ? `app="${app}"` : `window="${windowTitle}"`;
  const md = [
    `# Zadanie: naucz się aplikacji ${app ? `„${app}”` : `w oknie „${windowTitle}”`}`,
    '',
    `**Cel użytkownika:** ${goal || '(nie podano — poznaj najważniejsze funkcje aplikacji)'}`,
    '',
    'Masz narzędzia MCP serwera **mpc-ekran** i skill **mpc-ekran**. Pracuj po polsku.',
    '',
    '## Kroki',
    `1. \`app(action="open", ${target})\` — wczytaj mapę aplikacji (elementy, ekrany, przepisy, wiedza). To tani tekst, bez obrazów.`,
    ls.length
      ? `2. Przeczytaj lekcje człowieka: ${ls.map((n) => `\`lesson(action="get", name="${n}")\``).join(', ')}. Droga człowieka jest wzorem. Obrazy kroków bierz tylko dla niejasnych miejsc (\`images=true\`, \`from\`/\`to\`).`
      : '2. Lekcji człowieka nie ma — poznajesz aplikację samodzielnie.',
    '3. `focus_window`, potem dla każdego potrzebnego ekranu `detect_elements(window=…)` (gdy wystarczy lista: `image=false`). Nazwij elementy potrzebne do celu (`label_elements`, jasne nazwy i opisy); ważne oznacz `edit_element(action="update", important=true)`.',
    '4. Zbuduj przepis dla celu: `sequence_save` z `goal`, zmiennymi `{{…}}` (dane, które się zmieniają) i `wait_for`/`wait_stable` po zmianach ekranu. Gdy jest lekcja, zacznij od `lesson(action="to_sequence")` i popraw wynik.',
    '5. Sprawdź przepis: `sequence_run(dry_run=true)`, potem na żywo. Jeśli przepis robi coś nieodwracalnego (wysyłka, zlecenie, płatność, usuwanie) — najpierw zapytaj mnie.',
    '6. Zapisz wiedzę: `app(action="note", section="…", text="…")` — ekrany i co na nich jest, jak sprawdzić efekt, pułapki, skróty klawiszowe. Zwięźle: to czyta następna AI.',
    '7. Na koniec krótko: jakie elementy, jakie przepisy (jak je uruchomić), co zapisałeś w wiedzy.',
    '',
    '## Zasady',
    '- Oszczędzaj tokeny: `app open` zamiast zgadywania, `act` do kilku kroków w jednym wywołaniu, `detect_elements(image=false)` gdy wystarczy lista, zrzuty tylko gdy coś jest niejasne.',
    '- Nie obchodź blokady „Klik zablokowany”. Gdy Windows nie oddaje fokusu albo widzisz `ZATRZYMANE` — przerwij i zapytaj.',
    '',
  ].join('\n');
  fs.writeFileSync(file, md, 'utf8');
  return { id, file };
}

// ── IPC ───────────────────────────────────────────────────────────────────
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, arg) => {
    try { return { ok: true, data: await fn(arg || {}) }; } catch (err) { return { ok: false, error: err.message }; }
  });
}

handle('state', () => stateSnapshot());
handle('stats', () => {
  const out = { manual: 0, manualMs: [], ai: 0, imported: 0 };
  for (const p of elements.listProfiles()) {
    for (const e of Object.values(elements.loadProfile(p.name).elements)) {
      if (e.source === 'human') { out.manual++; if (e.manualMs) out.manualMs.push(e.manualMs); }
      else if (String(e.source).startsWith('ai')) out.ai++;
      else if (e.source === 'bocikmexik') out.imported++;
    }
  }
  return out;
});
handle('history', () => history.slice(-400));
handle('settings:set', (patch) => settings.updateSettings(patch));
handle('control:stop', () => { const c = settings.setControl({ stop: true, reason: 'STOP w MPC Studio', pauseUntil: 0 }); events.emit('stop', { reason: 'studio' }); return c; });
handle('control:resume', () => { const c = settings.setControl({ stop: false, reason: '', pauseUntil: 0 }); events.emit('resume', {}); return c; });
handle('profile:set', ({ name }) => { const p = elements.setActiveProfile(name); events.emit('profile', { profile: p }); return p; });
handle('elements:list', ({ profile }) => elementsWithCrops(profile || elements.activeProfile()));
handle('elements:remove', ({ name, profile }) => elements.removeElement(name, profile || elements.activeProfile()));
handle('elements:rename', ({ name, to, profile }) => elements.renameElement(name, to, profile || elements.activeProfile()));
handle('elements:describe', ({ name, description, profile }) => {
  const p = profile || elements.activeProfile();
  const d = elements.loadProfile(p);
  if (!d.elements[name]) throw new Error('Brak elementu');
  d.elements[name].description = description;
  elements.saveProfile(p, d);
  return true;
});
handle('elements:locate', async ({ name, profile }) => {
  const p = profile || elements.activeProfile();
  const r = await elements.resolveElement(name, { profile: p });
  addZones([zoneFromBox(name, r.box, r.element && r.element.category, r.window && r.window.hwnd)], 6000);
  return { box: r.box, score: r.score, method: r.method, moved: r.moved };
});
handle('elements:showAll', async ({ profile, locate = true }) => {
  const p = profile || elements.activeProfile();
  const d = elements.loadProfile(p);
  const shown = [];
  const missing = [];
  for (const e of Object.values(d.elements)) {
    let box = e.box;
    if (locate && e.template) {
      try { box = (await elements.resolveElement(e.name, { profile: p })).box; } catch { missing.push(e.name); continue; }
    }
    shown.push(zoneFromBox(e.name, box, e.category));
  }
  addZones(shown, 12000);
  return { shown: shown.length, missing };
});
handle('sequences:list', () => sequences.list());
handle('sequences:get', ({ name }) => sequences.get(name));
handle('sequences:delete', ({ name }) => sequences.remove(name));
handle('sequences:update', ({ name, description, variables }) => {
  const s = sequences.get(name);
  return sequences.save({ ...s, description: description ?? s.description, variables: variables ?? s.variables });
});
let seqRunning = false;
handle('sequences:run', async ({ name, variables, dry }) => {
  if (seqRunning) throw new Error('Sekwencja już działa');
  seqRunning = true;
  try {
    if (overlayMode === 'off') setOverlayMode('ai');
    if (mainWin && !dry) { mainWin.minimize(); await new Promise((r) => setTimeout(r, 400)); }
    return await sequences.run(name, { variables: variables || {}, dryRun: !!dry });
  } finally {
    seqRunning = false;
    if (mainWin && !dry) mainWin.restore();
  }
});
handle('recordings:list', () => recordings.library().map((r) => ({ name: r.name, len: Math.round(r.len), duration: Math.round(r.duration), angle: r.angle, source: r.source, createdAt: r.createdAt, samples: r.samples.filter((_, i) => i % 2 === 0 || i === r.samples.length - 1) })));
handle('recordings:delete', ({ name }) => recordings.remove(name));
handle('recordings:preview', ({ from, to, motion }) => {
  const lib = recordings.library();
  const plan = humanizer.planMove(from, to, { library: lib, motion: motion || 'recorded', speed: 1, noisePx: 2, speedJitter: 0.15 });
  const syn = humanizer.planMove(from, to, { library: [], motion: 'synthetic', speed: 1, noisePx: 1 });
  return { plan, synthetic: syn };
});
handle('recorder:prepare', (opts) => (opts.mode === 'sequence' ? lessonStart({}) : recPrepare(opts)));
handle('recorder:start', () => { recStart(); return true; });
handle('recorder:stop', () => recStop());
handle('recorder:cancel', () => { recCancel(); if (hudWin) hudWin.close(); return true; });
handle('overlay:set', ({ mode }) => { setOverlayMode(mode); return overlayMode; });
handle('overlay:ai-toggle', ({ on }) => { overlayShowAi = !!on; return overlayShowAi; });
handle('scan:run', (opts) => runScan(opts));
handle('scan:name', async ({ id, name, description }) => {
  if (!lastScan) throw new Error('Brak skanu');
  const m = lastScan.shot.marks.get(Number(id));
  if (!m) throw new Error(`Brak strefy #${id}`);
  const el = await elements.saveFromShot(lastScan.shot, { name, box: { x: m.x, y: m.y, w: m.w, h: m.h }, description: description || '', role: m.role, text: m.text, source: 'human-scan' });
  events.emit('label', { profile: elements.activeProfile(), elements: [{ name: el.name, box: el.box, description: el.description }], by: 'human-scan' });
  return { name: el.name, box: dipRect(el.box) };
});
handle('manual:save', async ({ name, rect, description, ms }) => {
  const box = screenRect(rect);
  const shot = await capture.capture({ rect: box });
  const el = await elements.saveFromShot(shot, { name, box: shot.rect, description: description || '', source: 'human' });
  const p = elements.activeProfile();
  const d = elements.loadProfile(p);
  if (d.elements[el.name]) { d.elements[el.name].manualMs = ms || null; elements.saveProfile(p, d); }
  events.emit('label', { profile: p, elements: [{ name: el.name, box: el.box }], by: 'human', ms });
  return { name: el.name, box: dipRect(el.box) };
});
handle('manual:list', () => {
  const p = elements.activeProfile();
  return Object.values(elements.loadProfile(p).elements).map((e) => ({ name: e.name, box: dipRect(e.lastSeen && e.lastSeen.found !== false && e.lastSeen.box ? e.lastSeen.box : e.box), source: e.source }));
});
handle('manual:remove', ({ name }) => elements.removeElement(name));
handle('demo:open', () => { openDemo(); return true; });
handle('selftest', () => selftest());
handle('import:bocik', () => bocik.importBocik());
handle('open:data', () => shell.openPath(paths.DATA_DIR));
handle('open:root', () => shell.openPath(paths.ROOT));
handle('clipboard', ({ text }) => { clipboard.writeText(text); return true; });
handle('ai:launch', () => {
  launchCmd(path.join(paths.ROOT, 'START_AI.cmd'));
  return true;
});
handle('window:restore', () => { if (mainWin) { mainWin.restore(); mainWin.focus(); } return true; });

// ── Lekcje i nauka ────────────────────────────────────────────────────────
async function loadPng(file) {
  const sharp = require('sharp');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: data, width: info.width, height: info.height };
}

handle('lesson:status', () => ({ ...lessonRec.status(), hotkey: lessonHotkey || '', wantedHotkey: settings.getSettings().lessonHotkey, categories: CATEGORIES }));
handle('lesson:start', (o) => lessonStart(o));
handle('lesson:stop', () => lessonStop());
handle('lesson:goal', ({ goal }) => { pendingGoal = goal || ''; return true; });
handle('lesson:hotkey', ({ hotkey }) => {
  const r = registerLessonHotkey(hotkey);
  if (r.ok) settings.updateSettings({ lessonHotkey: hotkey });
  else registerLessonHotkey(settings.getSettings().lessonHotkey);
  return r;
});
handle('lesson:list', () => lessons.list());
handle('lesson:get', ({ name }) => {
  const l = lessons.get(name);
  const screens = {};
  for (const a of l.apps || []) for (const s of apps.listScreens(a)) screens[`${a}/${s.id}`] = { id: s.id, app: a, elements: s.elements, window: s.window };
  const els = {};
  for (const a of l.apps || []) els[a] = elements.loadProfile(a).elements;
  return { lesson: l, screens, elements: els };
});
handle('lesson:update', ({ name, goal, steps }) => {
  const l = lessons.get(name);
  if (goal !== undefined) l.goal = goal;
  if (Array.isArray(steps)) {
    for (const p of steps) {
      const s = l.steps.find((x) => x.i === p.i);
      if (!s) continue;
      for (const k of ['text', 'var', 'secret', 'skip', 'keys', 'note']) if (p[k] !== undefined) s[k] = p[k];
    }
  }
  lessons.save(l);
  return l;
});
handle('lesson:delete', ({ name }) => lessons.remove(name));
// Ręczna poprawka strefy na zrzucie kroku: nowy prostokąt / nazwa / kolor → nowy wycinek-wzorzec
handle('lesson:element', async ({ name, i, box, rename, category, description }) => {
  const l = lessons.get(name);
  const s = l.steps.find((x) => x.i === i);
  if (!s || !s.element) throw new Error('Ten krok nie ma elementu');
  let el = s.element;
  if (rename && rename !== el) {
    elements.renameElement(el, rename, s.app);
    for (const x of l.steps) if (x.element === el && x.app === s.app) x.element = rename;
    el = rename;
  }
  let image = null;
  if (box && s.shot) image = { ...(await loadPng(lessons.stepImagePath(name, s.shot))), rect: s.window.rect };
  const cur = elements.loadProfile(s.app).elements[el];
  const upd = await elements.updateElement(el, {
    box, image, category, description,
    window: box && cur && cur.window ? { ...cur.window, rect: s.window.rect } : undefined,
  }, s.app);
  if (box) s.elementInfo = { ...(s.elementInfo || {}), box: upd.box, manual: true };
  if (category) s.elementInfo = { ...(s.elementInfo || {}), category };
  lessons.save(l);
  events.emit('label', { profile: s.app, elements: [{ name: el, box: upd.box }], by: 'human-edit' });
  return { element: el, box: upd.box, category: upd.category };
});
handle('lesson:toSequence', ({ name, seqName, goal }) => {
  const def = lessons.toSequenceDef(lessons.get(name), { name: seqName, goal });
  const seq = sequences.save(def);
  return { name: seq.name, steps: seq.steps.length, variables: Object.keys(seq.variables || {}), secrets: def.secrets };
});
handle('apps:list', () => apps.listApps().map((a) => ({ ...a, knowledge: apps.readKnowledge(a.name).length, screens: apps.listScreens(a.name).length })));
handle('apps:knowledge', ({ app }) => apps.readKnowledge(app));
handle('apps:map', ({ app }) => apps.compactMap(app).text);
handle('windows:list', () => win32.listWindows().filter((w) => !isOwnWindow(w.hwnd)).map((w) => ({ hwnd: w.hwnd, title: w.title, process: w.process })));
handle('learn:launch', async ({ app, goal, lessonNames, hwnd }) => {
  let appName = app;
  let title = '';
  if (!appName && hwnd) {
    const w = win32.describeWindow(hwnd);
    appName = await apps.identifyApp(w);
    title = w.title;
  }
  if (!appName) throw new Error('Wybierz aplikację albo okno');
  const t = learnTask({ app: appName, goal, lessonNames: lessonNames || [], windowTitle: title });
  if (process.env.MPC_NO_LAUNCH !== '1') launchClaudeWithTask(t.file, `MPC nauka ${appName}`);
  events.emit('learn', { app: appName, goal, file: t.file });
  return { app: appName, file: t.file };
});

ipcMain.on('overlay:toolbar', (_e, b) => {
  if (!overlayWin || !b) return;
  const wb = overlayWin.getBounds();
  toolbarBounds = { x: wb.x + b.x, y: wb.y + b.y, w: b.w, h: b.h };
});
ipcMain.on('overlay:close', () => {
  setOverlayMode('off');
  if (mainWin && mainWin.isMinimized()) mainWin.restore();
});
ipcMain.on('overlay:mode', (_e, mode) => setOverlayMode(mode));

// ── Aplikacja ćwiczebna ───────────────────────────────────────────────────
function openDemo() {
  if (demoWin && !demoWin.isDestroyed()) { demoWin.show(); demoWin.focus(); return; }
  demoWin = new BrowserWindow({
    width: 980, height: 700, title: 'Biuro Pomocy — aplikacja ćwiczebna',
    backgroundColor: '#f6f4ef', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  demoWin.loadFile(path.join(__dirname, 'demo.html'));
  // test automatyczny: okno ćwiczebne zawsze na wierzchu, żeby klik nie trafił w inne okno
  if (process.env.MPC_DEMO_TOP === '1') demoWin.setAlwaysOnTop(true, 'floating');
  demoWin.on('closed', () => { demoWin = null; });
}

// ── Start ─────────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

app.whenReady().then(() => {
  // Okna Studia (i aplikacja ćwiczebna) wystawiają drzewo UI Automation — AI widzi nazwy pól i przycisków.
  app.setAccessibilitySupportEnabled(true);
  protocol.handle('mpc', (req) => {
    const u = new URL(req.url);
    const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.resolve(paths.DATA_DIR, rel);
    if (!file.startsWith(path.resolve(paths.DATA_DIR) + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createMain();
  startTail();
  const stopKey = () => {
    if (settings.getControl().stop) return;
    settings.setControl({ stop: true, reason: 'klawisz STOP', pauseUntil: 0 });
    events.emit('stop', { reason: 'hotkey' });
    notifyMain('refresh', {});
  };
  try { globalShortcut.register('Control+Shift+F12', stopKey); } catch { /* zajęty przez inny program */ }
  registerLessonHotkey(settings.getSettings().lessonHotkey);
  // Pause/Break nie ma w skrótach Electrona — odpytujemy klawisz bezpośrednio
  let pauseWas = false;
  setInterval(() => {
    const down = win32.isKeyDown(0x13);
    if (down && !pauseWas) stopKey();
    pauseWas = down;
  }, 80);
  if (process.argv.includes('--demo')) openDemo();
  if (process.argv.includes('--overlay')) setTimeout(() => setOverlayMode('ai'), 800);
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); shutdownWorkers(); });
app.on('window-all-closed', () => app.quit());

module.exports = { setOverlayMode };
