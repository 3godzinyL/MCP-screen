// Nagrywanie lekcji: człowiek pracuje normalnie w dowolnych aplikacjach, a MPC (bez AI) zapisuje:
//  • każde kliknięcie → zrzut okna, rozpoznany element (UI Automation → piksele → OCR), kolor typu, wzorzec
//  • wpisany tekst (hasła wykryte przez UIA są ukryte) i skróty klawiszowe
//  • ruch myszy między kliknięciami → biblioteka próbek dla AI
//  • mapę wszystkich stref każdego nowego ekranu („przy okazji zmapuj wszystkie przyciski”)
const capture = require('../core/capture');
const elements = require('../core/elements');
const lessons = require('../core/lessons');
const apps = require('../core/apps');
const recordings = require('../core/recordings');
const win32 = require('../core/win32');
const { workers } = require('../core/psworker');
const { detectElements } = require('../core/detect/index');
const { autoName } = require('../core/categories');
const { iou } = require('../core/detect/cv');
const { emit } = require('../core/events');

const SPECIAL = {
  0x0d: 'Enter', 0x09: 'Tab', 0x1b: 'Esc', 0x2e: 'Delete', 0x2d: 'Insert', 0x21: 'PageUp', 0x22: 'PageDown', 0x23: 'End', 0x24: 'Home',
  0x25: 'Left', 0x26: 'Up', 0x27: 'Right', 0x28: 'Down',
};
for (let i = 1; i <= 24; i++) SPECIAL[0x6f + i] = `F${i}`;
const MODS = new Set([0x10, 0x11, 0x12, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0x5b, 0x5c, 0x14, 0x90, 0x91]);
const KEYS = [];
for (let vk = 0x08; vk <= 0xfe; vk++) {
  if (MODS.has(vk) || (vk >= 0x01 && vk <= 0x07) || (vk >= 0x0a && vk <= 0x0c) || (vk >= 0x0e && vk <= 0x0f) || (vk >= 0x15 && vk <= 0x1a) || (vk >= 0x1c && vk <= 0x1f) || (vk >= 0x88 && vk <= 0x8f) || (vk >= 0x92 && vk <= 0x9f) || (vk >= 0xa6 && vk <= 0xb9)) continue;
  KEYS.push(vk);
}

function keyName(vk) {
  if (SPECIAL[vk]) return SPECIAL[vk];
  if (vk >= 0x30 && vk <= 0x39) return String.fromCharCode(vk);
  if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
  return `VK${vk.toString(16)}`;
}

function thumbKey(shot) {
  // 16×12 szarości — tani odcisk wyglądu okna (czy to „nowy ekran”?)
  const W = 16; const H = 12;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.floor(((x + 0.5) / W) * shot.width);
      const sy = Math.floor(((y + 0.5) / H) * shot.height);
      const p = (sy * shot.width + sx) * 4;
      out[y * W + x] = (shot.rgba[p] * 0.3 + shot.rgba[p + 1] * 0.59 + shot.rgba[p + 2] * 0.11) | 0;
    }
  }
  return out;
}

function thumbDiff(a, b) {
  if (!a || !b) return 1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) d++;
  return d / a.length;
}

function createLessonRecorder({ isOwnWindow, onChange, onZone }) {
  let rec = null;

  function status() {
    if (!rec) return { running: false };
    return {
      running: true, name: rec.name, goal: rec.goal, since: rec.start, steps: rec.steps.length,
      clicks: rec.steps.filter((s) => s.type === 'click').length, apps: [...rec.apps], options: rec.options,
      pending: rec.pending,
    };
  }

  function start({ name, goal = '', options = {} } = {}) {
    if (rec) return status();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1_$2');
    rec = {
      name: (name || `lekcja_${stamp}`).replace(/[^\p{L}\p{N}_\-.]+/gu, '_'),
      goal, start: Date.now(),
      options: { keyboard: options.keyboard !== false, mapScreens: options.mapScreens !== false, motion: options.motion !== false },
      steps: [], apps: new Set(), screens: [], queue: Promise.resolve(), pending: 0,
      samples: [], segFrom: 0,
      btn: { left: false, right: false }, down: null, lastClick: null,
      keys: { prev: new Uint8Array(256), buf: '', field: null, secret: null, bufT: 0, lastAt: 0 },
      thumbs: new Map(), takenNames: new Map(),
    };
    // zerujemy bity „wciśnięty od ostatniego odczytu” — klawisze sprzed startu (np. skrót F9) nie trafią do lekcji
    for (const vk of KEYS) win32.asyncKeyState(vk);
    rec.timer = setInterval(tick, 10);
    emit('lesson', { status: 'start', name: rec.name, goal });
    onChange(status());
    return status();
  }

  function t() { return Date.now() - rec.start; }

  function tick() {
    if (!rec) return;
    const p = win32.getCursor();
    const now = t();
    rec.samples.push({ t: now, x: p.x, y: p.y });
    // przyciski myszy
    for (const [btn, vk] of [['left', 0x01], ['right', 0x02]]) {
      const down = win32.isKeyDown(vk);
      if (down && !rec.btn[btn]) onDown(btn, p, now);
      if (!down && rec.btn[btn]) onUp(btn, p, now);
      rec.btn[btn] = down;
    }
    // klawiatura
    if (rec.options.keyboard) {
      const k = rec.keys;
      for (const vk of KEYS) {
        // bit 0x8000 = wciśnięty teraz; bit 1 = wciśnięty od poprzedniego odczytu (szybkie stuknięcie między próbkami)
        const st = win32.asyncKeyState(vk);
        const d = (st & 0x8000) !== 0;
        if (!k.prev[vk] && (d || (st & 1))) onKey(vk);
        k.prev[vk] = d ? 1 : 0;
      }
      if (k.buf && now - k.lastAt > 2500) flushText();
    }
  }

  // ── Mysz ────────────────────────────────────────────────────────────────
  function onDown(button, p, now) {
    const hwnd = win32.rootHwndAt(p.x, p.y);
    if (!hwnd || isOwnWindow(hwnd)) { rec.down = { ignore: true }; return; }
    const win = win32.describeWindow(hwnd);
    if (win.className === 'Shell_TrayWnd' || win.className === 'Progman' || win.className === 'WorkerW') {
      // pasek zadań / pulpit też jest celem (np. uruchomienie programu) — zapisujemy jak każde okno
    }
    // od razu: zrzut okna (zanim UI zareaguje) i pytanie UIA o element pod kursorem
    const rect = win.rect && win.rect.w > 20 && win.rect.h > 20 ? win.rect : { x: p.x - 300, y: p.y - 200, w: 600, h: 400 };
    rec.down = {
      button, point: { ...p }, t: now, win,
      shotPromise: capture.capture({ rect, window: win }).catch(() => null),
      uiaPromise: workers.fast.call('element_at', { x: p.x, y: p.y }, 4000).catch(() => null),
      sampleIdx: rec.samples.length - 1,
    };
  }

  function onUp(button, p, now) {
    const d = rec.down;
    rec.down = null;
    if (!d || d.ignore || d.button !== button) return;
    flushText();
    const moved = Math.hypot(p.x - d.point.x, p.y - d.point.y);
    const prev = rec.lastClick;
    // dwuklik: drugi klik w to samo miejsce w < 450 ms → poprzedni krok staje się dwuklikiem
    if (moved < 6 && prev && d.t - prev.t < 450 && Math.hypot(prev.point.x - d.point.x, prev.point.y - d.point.y) < 6 && prev.button === button) {
      prev.step.double = true;
      rec.lastClick = null;
      onChange(status());
      return;
    }
    const step = { i: rec.steps.length + 1, t: d.t, type: moved > 10 ? 'drag' : 'click', button, point: d.point, ...(moved > 10 ? { to: { ...p } } : {}) };
    rec.steps.push(step);
    rec.lastClick = { t: d.t, point: d.point, button, step };
    // odcinek drogi myszy od poprzedniego kliknięcia → próbka ruchu człowieka
    const seg = rec.samples.slice(rec.segFrom, d.sampleIdx + 1);
    rec.segFrom = rec.samples.length - 1;
    rec.pending++;
    onChange(status());
    rec.queue = rec.queue.then(() => processClick(step, d, seg)).catch((err) => { step.error = err.message; }).finally(() => {
      if (rec) { rec.pending--; onChange(status()); }
    });
  }

  async function processClick(step, d, seg) {
    const r = rec;
    const shot = await d.shotPromise;
    if (!shot) { step.error = 'brak zrzutu'; return; }
    const info = await lessons.analyzeClick({ shot, point: d.point, uiaPromise: d.uiaPromise });
    let label = info.name;
    if (!label && info.source !== 'point') label = await lessons.ocrLabel(shot, info.box);
    const app = await apps.identifyApp(d.win);
    r.apps.add(app);
    // ten sam element kliknięty drugi raz → ta sama nazwa (po tożsamości UIA albo po miejscu w oknie)
    const prof = elements.loadProfile(app);
    const rel = { x: info.box.x - shot.rect.x, y: info.box.y - shot.rect.y, w: info.box.w, h: info.box.h };
    let name = null;
    for (const e of Object.values(prof.elements)) {
      if (e.uia && info.automationId && e.uia.automationId === info.automationId) { name = e.name; break; }
      if (e.window && e.window.rel && iou(e.window.rel, rel) > 0.7 && (!label || !e.text || e.text === label)) { name = e.name; break; }
    }
    if (!name) {
      const taken = new Set(Object.keys(prof.elements));
      name = autoName(info.category, label, taken);
    }
    await elements.saveFromShot(shot, {
      name, box: info.box, description: label ? `„${label}”` : '', role: info.role, text: label || '', source: 'human-lesson', profile: app,
      uia: info.source === 'uia' ? { role: info.role, name: info.name, automationId: info.automationId } : null, category: info.category,
    });
    step.app = app;
    step.element = name;
    step.window = { process: d.win.process, title: d.win.title, rect: shot.rect, hwnd: d.win.hwnd };
    step.rel = { x: d.point.x - shot.rect.x, y: d.point.y - shot.rect.y };
    step.elementInfo = { role: info.role, name: label || '', category: info.category, source: info.source, box: info.box, password: info.password };
    step.shot = await lessons.saveStepImage(r.name, step.i, shot);
    if (r.options.motion && seg.length > 6) {
      const a = seg[0];
      const b = seg[seg.length - 1];
      if (Math.hypot(b.x - a.x, b.y - a.y) > 30) {
        const saved = recordings.save(`${r.name}_ruch${step.i}`, seg.map((s) => ({ ...s, t: s.t - a.t })), { source: 'human-lesson', unique: true });
        step.motion = saved.name;
      }
    }
    emit('lesson-click', { name: r.name, i: step.i, element: name, category: info.category, source: info.source, box: info.box, hwnd: d.win.hwnd, rel, app, label: label || '' });
    onZone({ hwnd: d.win.hwnd, rel, name, category: info.category, box: info.box });
    // nowy ekran? → mapa wszystkich stref (UIA + OCR + piksele), raz na wygląd
    if (r.options.mapScreens) {
      const key = `${app}:${d.win.hwnd}`;
      const th = thumbKey(shot);
      const prev = r.thumbs.get(key);
      if (!prev || thumbDiff(prev, th) > 0.2) {
        r.thumbs.set(key, th);
        try {
          const det = await detectElements(shot, { maxMarks: 250 });
          const sc = await apps.saveScreen(app, shot, det.marks, { title: d.win.title });
          step.screen = sc.id;
          if (!r.screens.includes(sc.id)) r.screens.push(sc.id);
          emit('lesson-screen', { name: r.name, app, screen: sc.id, isNew: sc.isNew, count: sc.elements });
        } catch (err) {
          step.screenError = err.message;
        }
      } else {
        const last = [...r.steps].reverse().find((s) => s.screen && s.app === app);
        if (last) step.screen = last.screen;
      }
    }
  }

  // ── Klawiatura ──────────────────────────────────────────────────────────
  function mods() {
    const altgr = win32.isKeyDown(0xa5) && win32.isKeyDown(0x11);
    return {
      shift: win32.isKeyDown(0x10), ctrl: win32.isKeyDown(0x11) && !altgr, alt: win32.isKeyDown(0x12) && !altgr,
      altgr, win: win32.isKeyDown(0x5b) || win32.isKeyDown(0x5c), caps: win32.capsLockOn(),
    };
  }

  function onKey(vk) {
    const k = rec.keys;
    const m = mods();
    if (rec.hotkeyVk && vk === rec.hotkeyVk) return;
    k.lastAt = t();
    if (m.ctrl || m.win || (m.alt && !m.altgr)) {
      flushText();
      const combo = [m.ctrl ? 'Ctrl' : '', m.alt ? 'Alt' : '', m.shift ? 'Shift' : '', m.win ? 'Win' : '', keyName(vk)].filter(Boolean).join('+');
      pushKeys(combo);
      return;
    }
    if (SPECIAL[vk]) {
      flushText();
      pushKeys(m.shift && vk === 0x09 ? 'Shift+Tab' : SPECIAL[vk]);
      return;
    }
    if (vk === 0x08) {
      if (k.buf) k.buf = k.buf.slice(0, -1);
      else { flushText(); pushKeys('Backspace'); }
      return;
    }
    const ch = win32.charFromVk(vk, m);
    if (!ch || ch < ' ') return;
    if (!k.buf) {
      k.bufT = t();
      const last = rec.lastClick && rec.lastClick.step;
      k.field = last && last.elementInfo && last.elementInfo.category === 'pole' ? last.element : (last ? last.element : null);
      k.secret = null;
      const st = k;
      // aktywne pole to hasło? (UIA IsPassword) — wtedy tekstu nie zapisujemy
      workers.fast.call('focused', {}, 2500).then((f) => { st.secret = !!(f && f.password); }).catch(() => {});
    }
    k.buf += ch;
  }

  function pushKeys(combo) {
    rec.steps.push({ i: rec.steps.length + 1, t: t(), type: 'keys', keys: combo });
    onChange(status());
  }

  function flushText() {
    if (!rec) return;
    const k = rec.keys;
    if (!k.buf) return;
    const looksSecret = k.secret === true || /has[lł]o|password|pin|passw/i.test(String(k.field || ''));
    rec.steps.push({
      i: rec.steps.length + 1, t: k.bufT, type: 'type', text: looksSecret ? '' : k.buf, secret: looksSecret,
      field: k.field || null, ...(looksSecret ? { var: 'haslo' } : {}),
    });
    k.buf = '';
    k.field = null;
    onChange(status());
  }

  async function stop() {
    if (!rec) return null;
    flushText();
    clearInterval(rec.timer);
    const r = rec;
    rec = null;
    await r.queue;
    // kliknięcia w nasz własny przycisk STOP itp. już odfiltrowane; puste kroki bez elementu wyrzucamy
    const steps = r.steps.filter((s) => s.type !== 'click' && s.type !== 'drag' ? true : !!s.element);
    steps.forEach((s, i) => { s.i = i + 1; });
    const lesson = {
      version: 1, name: r.name, goal: r.goal, createdAt: new Date(r.start).toISOString(), durationMs: Date.now() - r.start,
      apps: [...r.apps], screens: r.screens, options: r.options, steps,
    };
    if (!steps.length) {
      emit('lesson', { status: 'empty', name: r.name });
      return { ok: false, error: 'Lekcja jest pusta — nie było kliknięć ani wpisów.' };
    }
    lessons.save(lesson);
    emit('lesson', { status: 'stop', name: r.name, steps: steps.length, apps: lesson.apps });
    onChange(status());
    return { ok: true, name: r.name, steps: steps.length, apps: lesson.apps };
  }

  function setHotkeyVk(vk) { if (rec) rec.hotkeyVk = vk; }

  // Test bez wciskania przycisku: ta sama ścieżka co prawdziwy klik (zrzut, UIA, element, mapa ekranu).
  async function simulateClick(point, button = 'left') {
    if (!rec) throw new Error('Nie nagrywam');
    onDown(button, point, t());
    await new Promise((r) => setTimeout(r, 40));
    onUp(button, point, t());
    await rec.queue;
  }

  function simulateText(text, field = null) {
    if (!rec) throw new Error('Nie nagrywam');
    rec.keys.buf = text;
    rec.keys.field = field;
    rec.keys.bufT = t();
    rec.keys.secret = false;
    flushText();
  }

  return { start, stop, status, setHotkeyVk, isRunning: () => !!rec, simulateClick, simulateText };
}

module.exports = { createLessonRecorder, keyName };
