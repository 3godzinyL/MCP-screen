#!/usr/bin/env node
// MPC Ekran — serwer MCP (stdio). AI widzi ekran, zaznacza elementy na niebiesko,
// klika jak człowiek i układa sekwencje kliknięć w dowolnej aplikacji Windows.
//
// stdout = wyłącznie protokół MCP. Wszystkie logi idą na stderr.
console.log = (...a) => process.stderr.write(`[mpc] ${a.map(String).join(' ')}\n`);
console.info = console.log;
console.warn = (...a) => process.stderr.write(`[mpc:warn] ${a.map(String).join(' ')}\n`);
process.removeAllListeners('warning');
process.on('warning', () => {});

require('../core/win32'); // DPI-aware zanim cokolwiek dotknie ekranu
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const win32 = require('../core/win32');
const capture = require('../core/capture');
const image = require('../core/image');
const elements = require('../core/elements');
const actions = require('../core/actions');
const sequences = require('../core/sequences');
const recordings = require('../core/recordings');
const input = require('../core/input');
const { detectElements } = require('../core/detect/index');
const { ocrShot, searchText } = require('../core/detect/ocr');
const { getSettings, updateSettings, getControl, DEFAULTS } = require('../core/settings');
const { emit, heartbeat, setSource } = require('../core/events');
const { shutdownWorkers } = require('../core/psworker');
const { findWindow } = require('../core/target');
const apps = require('../core/apps');
const lessons = require('../core/lessons');
const { colorOf } = require('../core/categories');
const pkg = require('../../package.json');

setSource('mcp');

const INSTRUCTIONS = `MPC Ekran lets you see and operate ANY Windows application like a human (also apps nobody wrote an MCP for, e.g. MetaTrader 5): screenshot → numbered zones → named elements (blue zones) → human-like clicks/typing → reusable recipes. It remembers each app, so the second visit is cheap.

Start every app task with app(action="open", window="<title or process>") — a compact TEXT map (named elements with window-relative positions, mapped screens, recipes with goals/variables, human lessons, learned notes). If a recipe fits the goal, run it: sequence_run(name, variables). If a human lesson exists, lesson(action="get") shows the exact path a human took; lesson(action="to_sequence") turns it into a recipe.

New app or unknown screen:
1. focus_window, then detect_elements(window=…) → image with NUMBERED ZONES (UI Automation + OCR + pixels) and a list "#n role "text" @x,y wxh". Use image=false when the list is enough.
2. Act: click(mark=12, shot="s4") / click(text="Zapisz") / click(element="name"). Batch several steps in ONE act(steps=[…]) call.
3. Name what you will reuse: label_elements(shot, items=[{mark, name, description}]) — template + window anchors + UIA identity, re-found after moves, resizes and DPI changes. Fix a zone with edit_element(action="update", x,y,w,h).
4. Small/crowded targets: zoom(shot, x,y,w,h, grid=true) and use its coordinates.
5. Verify outcomes: click(verify=true) or click(screenshot_after=true) for short-lived messages, or wait(for_text=…) as the next call.
6. Save the flow: sequence_record start → actions → stop, or sequence_save(goal, steps with element names and {{variables}}). Save what you learned: app(action="note", section, text).
Token economy: prefer app open, act, image=false, element/text targets and wait(for_text) over repeated screenshots.
Coordinates: x/y with shot="sN" are IMAGE pixels of that shot; space="screen" = physical screen pixels. Marks live only for their shot.
Clicks are refused ("Klik zablokowany") when another window covers the target — focus_window and detect again; never bypass with screen coordinates. If focus_window says Windows refused focus, ask the human.
Safety: the human can stop you any time (MPC Studio STOP, Pause key, mouse to the top-left corner, moving the mouse). On "ZATRZYMANE" stop and ask. settings(dry_run=true) rehearses without clicking. Never buy, pay, send messages, place trading orders, delete data or change account/security settings without explicit confirmation in chat.`;

const server = new McpServer(
  { name: 'mpc-ekran', title: 'MPC Ekran — AI steruje ekranem', version: pkg.version },
  { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
);

// ── Pomocnicze ────────────────────────────────────────────────────────────
const IMG = (r) => ({ type: 'image', data: r.base64, mimeType: r.mime });
const TXT = (t) => ({ type: 'text', text: t });

function brief(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v;
    else if (Array.isArray(v)) out[k] = v.length > 6 ? `[${v.length} pozycji]` : v;
    else out[k] = v;
  }
  return out;
}

let calls = 0;
let clientInfo = null;
function beat(extra = {}) {
  heartbeat({ server: 'mpc-ekran', version: pkg.version, client: clientInfo, calls, ...extra });
}

// Rejestracja narzędzia z logiem do Studia, blokadą myszy i czytelnym błędem dla AI.
function tool(name, config, handler, { lock = false } = {}) {
  server.registerTool(name, config, async (args, extra) => {
    const t0 = Date.now();
    calls++;
    emit('tool', { name, status: 'start', args: brief(args) });
    try {
      const run = () => handler(args || {}, extra);
      const res = lock ? await actions.exclusive(run) : await run();
      emit('tool', { name, status: 'ok', ms: Date.now() - t0, summary: res.summary || '', image: res.imageFile || null, shot: res.shot || null });
      beat({ lastTool: name, lastAt: Date.now() });
      return { content: res.content };
    } catch (err) {
      emit('tool', { name, status: 'error', ms: Date.now() - t0, error: err.message, stopped: !!err.stopped });
      beat({ lastTool: name, lastAt: Date.now(), lastError: err.message });
      return { content: [TXT(`${err.stopped ? 'ZATRZYMANE' : 'Błąd'}: ${err.message}`)], isError: true };
    }
  });
}

const targetShape = {
  element: z.string().optional().describe('Name of a saved element (blue zone) in the active profile'),
  mark: z.number().int().optional().describe('Zone number from the latest detect_elements image'),
  shot: z.string().optional().describe('Screenshot id the mark or x/y refer to (e.g. "s4"); default = latest'),
  text: z.string().optional().describe('Visible text to find on screen with OCR and use as the target'),
  occurrence: z.number().int().min(1).optional().describe('Which match of `text` (1 = first in reading order)'),
  window: z.string().optional().describe('Limit the `text` search to this window (title fragment or process name)'),
  x: z.number().optional().describe('X in image pixels of `shot` (or screen pixels when space="screen")'),
  y: z.number().optional().describe('Y in image pixels of `shot` (or screen pixels when space="screen")'),
  space: z.enum(['image', 'screen']).optional().describe('Coordinate space for x/y (default image)'),
  offset_x: z.number().optional().describe('Pixel offset added after resolving (screen px)'),
  offset_y: z.number().optional(),
};

function pickTarget(a) {
  const t = {};
  for (const k of Object.keys(targetShape)) if (a[k] !== undefined) t[k] = a[k];
  return t;
}

const regionShape = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).describe('Screen rectangle in physical pixels');

function windowLine(w) {
  return `${w.foreground ? '★ ' : ''}„${w.title}” [${w.process}] x=${w.rect.x} y=${w.rect.y} ${w.rect.w}x${w.rect.h}${w.minimized ? ' (zminimalizowane)' : ''} hwnd=${w.hwnd}`;
}

function mappingText(shot) {
  const v = shot.view;
  const ratio = v ? (1 / v.scale).toFixed(3) : '1';
  return `Zrzut ${shot.id}: ekran x=${shot.rect.x} y=${shot.rect.y} ${shot.rect.w}x${shot.rect.h} → obraz ${v.w}x${v.h} (1 px obrazu = ${ratio} px ekranu)` +
    (shot.window ? `, okno „${shot.window.title}”` : '') + '.';
}

// Czy okno ze zrzutu jest naprawdę na wierzchu? (próbkujemy, które okno leży pod punktami siatki)
function coverageNote(shot) {
  if (!shot.window || !shot.window.hwnd) return '';
  const r = shot.rect;
  let mine = 0;
  let total = 0;
  for (let i = 1; i <= 5; i++) {
    for (let j = 1; j <= 4; j++) {
      total++;
      if (win32.rootHwndAt(r.x + (i / 6) * r.w, r.y + (j / 5) * r.h) === Number(shot.window.hwnd)) mine++;
    }
  }
  const pct = Math.round((mine / total) * 100);
  return pct < 80 ? `\nUWAGA: okno jest widoczne tylko w ~${pct}% (zasłaniają je inne okna) — użyj focus_window przed klikaniem.` : '';
}

async function shotFrom({ shot, window: win, region, monitor } = {}) {
  if (shot) return capture.getShot(shot);
  if (region) return capture.capture({ rect: region });
  if (win) {
    const w = await findWindow(win);
    if (!w) throw new Error(`Nie znalazłem okna „${win}”. Użyj list_windows.`);
    if (w.minimized) throw new Error(`Okno „${w.title}” jest zminimalizowane — najpierw focus_window.`);
    return capture.capture({ rect: w.rect, window: w });
  }
  if (monitor !== undefined) {
    const m = win32.listMonitors()[monitor];
    if (!m) throw new Error(`Nie ma monitora ${monitor}`);
    return capture.capture({ rect: m });
  }
  return capture.capture();
}

function elementBoxes(profile, names = null) {
  const data = elements.loadProfile(profile);
  return Object.values(data.elements)
    .filter((e) => !names || names.includes(e.name))
    .map((e) => ({ ...(e.lastSeen && e.lastSeen.box && e.lastSeen.found !== false ? e.lastSeen.box : e.box), label: e.name, source: 'element', strong: true }));
}

function markLine(m, shot) {
  const b = shot.toImageBox(m);
  const t = m.text ? ` "${m.text.replace(/\s+/g, ' ').slice(0, 60)}"` : '';
  return `#${m.id} ${m.role}${t} @${b.x},${b.y} ${b.w}x${b.h}${m.enabled === false ? ' (nieaktywny)' : ''}`;
}

// ── Narzędzia: obserwacja ─────────────────────────────────────────────────
tool('screen_info', {
  title: 'Stan ekranu i serwera',
  description: 'Screens (resolution, DPI scale), cursor position, foreground window, current mode (live/dry-run), active profile with element count, saved sequences, mouse-motion library and stop status. Call once at the start.',
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const st = getSettings();
  const ctl = getControl();
  const mons = win32.listMonitors();
  const fg = win32.foregroundWindow();
  const prof = elements.loadProfile();
  const lines = [
    `MPC Ekran ${pkg.version} · tryb: ${st.dryRun ? 'PRÓBNY (dry-run, nic nie klika)' : 'NA ŻYWO'} · ruch: ${st.motion} · tempo ×${st.speed}`,
    `Monitory: ${mons.map((m) => `#${m.index}${m.primary ? ' główny' : ''} ${m.w}x${m.h} @${m.x},${m.y} skala ${Math.round(m.scale * 100)}%`).join(' | ')}`,
    `DPI procesu: ${win32.dpiMode} · kursor: ${JSON.stringify(win32.getCursor())}`,
    `Aktywne okno: ${fg ? windowLine(fg) : '(brak)'}`,
    `Profil: „${prof.profile}” — ${Object.keys(prof.elements).length} elementów; profile: ${elements.listProfiles().map((p) => `${p.name}(${p.elements})`).join(', ') || 'brak'}`,
    `Sekwencje: ${sequences.list().map((s) => `${s.name}(${s.steps})`).join(', ') || 'brak'}`,
    `Nagrane ruchy człowieka: ${recordings.list().length} (używane między kliknięciami, gdy ruch=recorded)`,
    `Nagrywanie sekwencji: ${sequences.isRecording() ? `TAK (${sequences.recordStatus().name}, ${sequences.recordStatus().steps} kroków)` : 'nie'}`,
    `STOP: ${ctl.stop ? `TAK — ${ctl.reason || ''}` : ctl.pauseUntil && ctl.pauseUntil > Date.now() ? 'pauza bezpieczeństwa' : 'nie'}`,
  ];
  return { content: [TXT(lines.join('\n'))], summary: lines[0] };
});

tool('list_windows', {
  title: 'Lista okien',
  description: 'List visible top-level windows (title, process, position, z-order; ★ = foreground). Optional filter by title/process fragment.',
  inputSchema: { filter: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ filter }) => {
  let ws = win32.listWindows();
  if (filter) {
    const q = filter.toLowerCase();
    ws = ws.filter((w) => w.title.toLowerCase().includes(q) || w.process.toLowerCase().includes(q));
  }
  const text = ws.length ? ws.map(windowLine).join('\n') : 'Brak pasujących okien.';
  return { content: [TXT(text)], summary: `${ws.length} okien` };
});

tool('focus_window', {
  title: 'Przełącz na okno',
  description: 'Bring a window to the front (restores if minimized). `window` = title fragment or process name (e.g. "Notatnik", "chrome").',
  inputSchema: { window: z.string(), maximize: z.boolean().optional() },
}, async ({ window: w, maximize }) => {
  const r = await actions.doFocus({ window: w, maximize });
  await sequences.recordAction({ action: 'focus', window: w, ...(maximize ? { maximize } : {}) });
  const how = r.ok ? `Na wierzchu${r.method === 'restore' ? ' (po minimalizacji i przywróceniu)' : ''}` : 'Windows NIE oddał fokusu (ktoś inny używa komputera?)';
  const tip = r.ok || r.dry ? '' : ' Nie klikaj dalej w ciemno — poproś człowieka, żeby kliknął to okno, albo spróbuj maximize=true.';
  return { content: [TXT(`${how}: „${r.window}” [${r.process}]${r.rect ? ` x=${r.rect.x} y=${r.rect.y} ${r.rect.w}x${r.rect.h}` : ''}${r.dry ? ' (próbnie)' : ''}.${tip}`)], summary: r.window };
}, { lock: true });

tool('screenshot', {
  title: 'Zrzut ekranu',
  description: 'Capture the screen, a window or a region and return it as an image with an id (sN). Downscaled to ~1400 px wide; coordinates you read from the image can be used directly with shot="sN". Options: grid=true draws labeled coordinate lines; show_elements=true draws saved elements as blue zones.',
  inputSchema: {
    window: z.string().optional().describe('Capture only this window (title fragment or process)'),
    region: regionShape.optional(),
    monitor: z.number().int().optional(),
    max_width: z.number().int().min(300).max(2000).optional(),
    grid: z.boolean().optional(),
    show_elements: z.boolean().optional(),
    format: z.enum(['jpeg', 'png']).optional(),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const shot = await shotFrom(a);
  const boxes = a.show_elements ? elementBoxes(elements.activeProfile()) : [];
  const r = await image.renderShot(shot, { maxWidth: a.max_width, grid: a.grid, boxes, format: a.format });
  emit('shot', { shot: shot.id, rect: shot.rect, image: r.file });
  return { content: [TXT(mappingText(shot) + coverageNote(shot)), IMG(r)], summary: mappingText(shot), imageFile: r.file, shot: shot.id };
});

tool('zoom', {
  title: 'Zbliżenie',
  description: 'Sharp close-up of part of a screenshot (full native resolution, upscaled when small). x/y/w/h are image pixels of `shot` (or screen pixels with space="screen"). Returns a NEW shot id; use it for precise coordinates or label_elements with an explicit box. fresh=true recaptures the area live.',
  inputSchema: {
    shot: z.string().optional(),
    x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive(),
    space: z.enum(['image', 'screen']).optional(),
    grid: z.boolean().optional(),
    fresh: z.boolean().optional(),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  let box;
  let parent = null;
  if (a.space === 'screen') box = { x: a.x, y: a.y, w: a.w, h: a.h };
  else {
    parent = a.shot ? capture.getShot(a.shot) : capture.latestShot();
    if (!parent) throw new Error('Brak zrzutu — najpierw screenshot');
    box = parent.toScreenBox({ x: a.x, y: a.y, w: a.w, h: a.h });
  }
  let shot;
  if (a.fresh || !parent || !parent.containsScreen(box.x, box.y)) shot = await capture.capture({ rect: box, label: 'zoom' });
  else shot = capture.fromCrop(parent, box, 'zoom');
  const up = Math.max(1, Math.min(4, Math.floor(1000 / Math.max(shot.width, shot.height * 1.6))));
  const r = await image.renderShot(shot, { grid: a.grid, upscale: up, format: 'png', gridStep: 50 });
  const rel = parent && parent.view ? ` (×${((r.width / shot.width) / parent.view.scale).toFixed(1)} względem ${parent.id})` : '';
  return { content: [TXT(`${mappingText(shot)} Powiększenie${rel}. Współrzędne z tego obrazu podawaj z shot="${shot.id}".`), IMG(r)], summary: `zoom ${shot.id}`, imageFile: r.file, shot: shot.id };
});

tool('detect_elements', {
  title: 'Wykryj elementy (niebieskie strefy)',
  description: 'Find clickable elements and text and return the screenshot with NUMBERED BLUE ZONES plus a list "#n role "text" @x,y wxh" (image px). Sources: uia = Windows UI Automation (exact controls with names), ocr = Windows OCR text, cv = pixel analysis (buttons, fields, icons). Then click(mark=n, shot=...) or label_elements to save zones under names. Narrow with window/region for cleaner results; `query` keeps only zones whose text matches.',
  inputSchema: {
    shot: z.string().optional().describe('Reuse an existing screenshot instead of capturing'),
    window: z.string().optional(),
    region: regionShape.optional(),
    sources: z.array(z.enum(['uia', 'ocr', 'cv'])).optional(),
    max_marks: z.number().int().min(5).max(400).optional(),
    query: z.string().optional(),
    grid: z.boolean().optional(),
    list_limit: z.number().int().min(0).max(400).optional().describe('How many zones to list as text (default all)'),
    image: z.boolean().optional().describe('false = text list only (saves ~1.5k tokens) when you already know the screen'),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const shot = await shotFrom(a);
  const det = await detectElements(shot, { sources: a.sources || ['uia', 'ocr', 'cv'], maxMarks: a.max_marks || 150, query: a.query || '' });
  const boxes = det.marks.map((m) => ({ ...m, label: String(m.id) }));
  const r = await image.renderShot(shot, { boxes, grid: a.grid });
  const by = det.marks.reduce((acc, m) => { acc[m.source] = (acc[m.source] || 0) + 1; return acc; }, {});
  const errs = Object.entries(det.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
  const limit = a.list_limit === undefined ? det.marks.length : a.list_limit;
  const head = `${mappingText(shot)}\nStref: ${det.marks.length} (UIA ${by.uia || 0}, OCR ${by.ocr || 0}, piksele ${by.cv || 0})` +
    `${det.truncated ? `, pominięto ${det.truncated} słabszych` : ''} · ${det.timings.total} ms` +
    `${det.windows && det.windows.length ? ` · okna: ${det.windows.filter((w) => w.title).map((w) => `„${w.title.slice(0, 40)}”`).join(', ')}` : ''}` +
    `${errs ? `\nUwaga: ${errs}` : ''}${det.warning ? `\nUWAGA: ${det.warning}` : ''}${coverageNote(shot)}\nUżyj: click(mark=N, shot="${shot.id}") albo label_elements(shot="${shot.id}", items=[{mark:N, name:"..."}]).`;
  const list = det.marks.slice(0, limit).map((m) => markLine(m, shot)).join('\n');
  emit('detect', { shot: shot.id, rect: shot.rect, image: r.file, marks: det.marks.map((m) => ({ id: m.id, x: m.x, y: m.y, w: m.w, h: m.h, source: m.source, text: (m.text || '').slice(0, 40) })) });
  const content = a.image === false ? [TXT(head), TXT(list || '(brak stref)')] : [TXT(head), IMG(r), TXT(list || '(brak stref)')];
  return { content, summary: `${det.marks.length} stref`, imageFile: r.file, shot: shot.id };
});

tool('find_text', {
  title: 'Znajdź napis',
  description: 'Find visible text on screen with Windows OCR (Polish and English, tolerant to OCR typos). Returns matches with screen boxes and an image with the matches highlighted. Use click(text=...) to click a text directly.',
  inputSchema: {
    text: z.string(),
    window: z.string().optional(),
    region: regionShape.optional(),
    shot: z.string().optional(),
    exact: z.boolean().optional(),
    max_results: z.number().int().min(1).max(50).optional(),
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const shot = await shotFrom(a);
  const ocr = await ocrShot(shot);
  const hits = searchText(ocr, a.text, { exact: a.exact }).slice(0, a.max_results || 10);
  const boxes = hits.map((h, i) => ({ x: h.x, y: h.y, w: h.w, h: h.h, label: `${i + 1}`, source: 'ocr', strong: i === 0 }));
  const r = await image.renderShot(shot, { boxes });
  const lines = hits.map((h, i) => {
    const b = shot.toImageBox(h);
    return `${i + 1}. „${h.text}” (pewność ${(h.score * 100).toFixed(0)}%) ekran x=${h.x} y=${h.y} ${h.w}x${h.h} · obraz @${b.x},${b.y}${h.line !== h.text ? ` · linia: „${h.line.slice(0, 80)}”` : ''}`;
  });
  const text = hits.length
    ? `${mappingText(shot)}\nZnaleziono ${hits.length}:\n${lines.join('\n')}\nKliknij: click(text="${a.text}"${a.window ? `, window="${a.window}"` : ''}) albo occurrence=N.`
    : `${mappingText(shot)}\nNie znaleziono „${a.text}”. OCR (${ocr.lang}) widzi m.in.: ${ocr.phrases.slice(0, 50).map((p) => p.text).join(' | ').slice(0, 900)}`;
  return { content: [TXT(text), IMG(r)], summary: `${hits.length} trafień „${a.text}”`, imageFile: r.file, shot: shot.id };
});

// ── Narzędzia: elementy (niebieskie strefy) ───────────────────────────────
tool('label_elements', {
  title: 'Nazwij elementy (zapisz niebieskie strefy)',
  description: 'Save elements under names: from zone numbers (mark) of detect_elements, or from an explicit box in image pixels of `shot` (x,y,w,h). Crops each element as a template, remembers its window, and returns a preview with blue zones + names so you can confirm you labeled the right thing. Names: letters/digits/_ (e.g. save_button, email_field).',
  inputSchema: {
    shot: z.string().optional().describe('Shot the marks/boxes refer to (default latest)'),
    items: z.array(z.object({
      name: z.string(),
      mark: z.number().int().optional(),
      x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(),
      description: z.string().optional().describe('What the element is / does (helps later)'),
      kind: z.string().optional().describe('button, field, tab, menu, link, checkbox, icon, ...'),
    })).min(1),
    profile: z.string().optional().describe('Profile (app) to store into; default active'),
  },
}, async (a) => {
  const shot = a.shot ? capture.getShot(a.shot) : capture.latestShot();
  if (!shot) throw new Error('Brak zrzutu — zrób screenshot albo detect_elements');
  const profile = a.profile ? elements.setActiveProfile(a.profile) : elements.activeProfile();
  const saved = [];
  const problems = [];
  for (const it of a.items) {
    try {
      let box;
      let text = '';
      let role = '';
      if (it.mark !== undefined) {
        const m = shot.marks.get(it.mark);
        if (!m) throw new Error(`brak strefy #${it.mark} na ${shot.id}`);
        box = { x: m.x, y: m.y, w: m.w, h: m.h };
        text = m.text || '';
        role = m.role || '';
      } else if ([it.x, it.y, it.w, it.h].every((v) => typeof v === 'number')) {
        box = shot.toScreenBox({ x: it.x, y: it.y, w: it.w, h: it.h });
      } else {
        throw new Error('podaj mark albo x,y,w,h');
      }
      if (box.w < 3 || box.h < 3) throw new Error('za mała strefa');
      const el = await elements.saveFromShot(shot, { name: it.name, box, description: it.description || '', kind: it.kind || '', role, text, source: it.mark !== undefined ? 'ai-mark' : 'ai-box', profile });
      saved.push(el);
    } catch (err) {
      problems.push(`${it.name}: ${err.message}`);
    }
  }
  const boxes = saved.map((e) => ({ ...e.box, label: e.name, source: 'element', strong: true }));
  const r = await image.renderShot(shot, { boxes, suffix: 'labels' });
  emit('label', { shot: shot.id, profile, image: r.file, elements: saved.map((e) => ({ name: e.name, box: e.box, description: e.description })) });
  const txt = `Profil „${profile}”: zapisano ${saved.length}/${a.items.length}.\n` +
    saved.map((e) => `• ${e.name}${e.kind ? ` (${e.kind})` : ''}${e.text ? ` „${e.text.slice(0, 40)}”` : ''} — ekran x=${e.box.x} y=${e.box.y} ${e.box.w}x${e.box.h}${e.window ? `, okno „${e.window.title.slice(0, 50)}” [${e.window.process}]` : ''}`).join('\n') +
    (problems.length ? `\nProblemy: ${problems.join('; ')}` : '') + '\nPodgląd poniżej — sprawdź, czy niebieskie strefy leżą na właściwych elementach.';
  return { content: [TXT(txt), IMG(r)], summary: `zapisano ${saved.length} elementów`, imageFile: r.file, shot: shot.id };
});

tool('list_elements', {
  title: 'Lista elementów',
  description: 'List saved elements of a profile (name, kind, description, last known position, when last found). Also lists all profiles.',
  inputSchema: { profile: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ profile }) => {
  const p = profile || elements.activeProfile();
  const data = elements.loadProfile(p);
  const els = Object.values(data.elements);
  const lines = els.map((e) => `• ${e.name}${e.kind ? ` [${e.kind}]` : ''}${e.description ? ` — ${e.description}` : ''}${e.text ? ` „${e.text.slice(0, 40)}”` : ''} · x=${e.box.x} y=${e.box.y} ${e.box.w}x${e.box.h}` +
    `${e.window ? ` · ${e.window.process}` : ''}${e.template ? '' : ' · bez wzorca'}${e.lastSeen ? ` · ostatnio ${e.lastSeen.found === false ? 'NIE znaleziony' : `ok (${e.lastSeen.method})`}` : ''} · źródło ${e.source}`);
  const profiles = elements.listProfiles().map((x) => `${x.name}(${x.elements})`).join(', ');
  return { content: [TXT(`Profil „${p}”: ${els.length} elementów.\n${lines.join('\n') || '(pusto)'}\nWszystkie profile: ${profiles || 'brak'}`)], summary: `${els.length} elementów` };
});

tool('show_elements', {
  title: 'Pokaż elementy na ekranie',
  description: 'Screenshot with all saved elements of the profile drawn as named blue zones. locate=true first re-finds each element by template matching (shows where they are NOW, reports missing ones).',
  inputSchema: { profile: z.string().optional(), names: z.array(z.string()).optional(), locate: z.boolean().optional(), window: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const p = a.profile || elements.activeProfile();
  const missing = [];
  if (a.locate) {
    const data = elements.loadProfile(p);
    for (const name of Object.keys(data.elements).filter((n) => !a.names || a.names.includes(n))) {
      try { await elements.resolveElement(name, { profile: p }); } catch { missing.push(name); }
    }
  }
  const shot = await shotFrom({ window: a.window });
  const boxes = elementBoxes(p, a.names).filter((b) => !missing.includes(b.label));
  const r = await image.renderShot(shot, { boxes, suffix: 'elements' });
  emit('label', { shot: shot.id, profile: p, image: r.file, elements: boxes.map((b) => ({ name: b.label, box: { x: b.x, y: b.y, w: b.w, h: b.h } })) });
  return { content: [TXT(`${mappingText(shot)}\nProfil „${p}”: ${boxes.length} stref na obrazie.${missing.length ? ` Nie znaleziono teraz: ${missing.join(', ')}` : ''}`), IMG(r)], summary: `${boxes.length} elementów`, imageFile: r.file, shot: shot.id };
});

tool('locate_element', {
  title: 'Znajdź element',
  description: 'Re-find a saved element on the current screen by template matching (handles moved windows). Returns its current box, match score and a close-up image.',
  inputSchema: { element: z.string(), profile: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ element, profile }) => {
  const res = await elements.resolveElement(element, { profile: profile || elements.activeProfile() });
  const pad = 60;
  const shot = await capture.capture({ rect: actions.around(res.box, pad) });
  const r = await image.renderShot(shot, { boxes: [{ ...res.box, label: element, source: 'match', strong: true }], upscale: 2, format: 'png' });
  return {
    content: [TXT(`„${element}”: x=${res.box.x} y=${res.box.y} ${res.box.w}x${res.box.h}, środek (${res.center.x}, ${res.center.y}), dopasowanie ${res.score ?? 'brak wzorca'} (${res.method})${res.moved ? ', PRZESUNIĘTY względem zapisu' : ''}.${res.warning ? ` Uwaga: ${res.warning}` : ''}`), IMG(r)],
    summary: `${element} ${res.score}`, imageFile: r.file,
  };
});

tool('edit_element', {
  title: 'Popraw element',
  description: 'Adjust saved elements: action=remove (names), rename (names[0] → rename_to), update (names[0]: new box x,y,w,h in image px of `shot` or screen px with space="screen" — re-crops the template; description; category przycisk|pole|wybor|menu|link|inne; important=true marks key elements in the app map).',
  inputSchema: {
    action: z.enum(['remove', 'rename', 'update']),
    names: z.array(z.string()).min(1),
    rename_to: z.string().optional(),
    shot: z.string().optional(),
    x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(),
    space: z.enum(['image', 'screen']).optional(),
    description: z.string().optional(),
    category: z.enum(['przycisk', 'pole', 'wybor', 'menu', 'link', 'inne']).optional(),
    important: z.boolean().optional(),
    profile: z.string().optional(),
  },
}, async (a) => {
  const p = a.profile || elements.activeProfile();
  if (a.action === 'remove') {
    const done = a.names.filter((n) => elements.removeElement(n, p));
    emit('label', { profile: p, removed: done });
    return { content: [TXT(`Usunięto: ${done.join(', ') || 'nic (brak takich nazw)'}`)], summary: `usunięto ${done.length}` };
  }
  if (a.action === 'rename') {
    if (!a.rename_to) throw new Error('Podaj rename_to');
    const el = elements.renameElement(a.names[0], a.rename_to, p);
    emit('label', { profile: p, renamed: { from: a.names[0], to: el.name } });
    return { content: [TXT(`Zmieniono nazwę: ${a.names[0]} → ${el.name}`)], summary: 'rename' };
  }
  const name = a.names[0];
  const patch = { description: a.description, category: a.category, important: a.important };
  let shot = null;
  if ([a.x, a.y, a.w, a.h].every((v) => typeof v === 'number')) {
    let box;
    if (a.space === 'screen') {
      box = { x: a.x, y: a.y, w: a.w, h: a.h };
      shot = await capture.capture({ rect: actions.around(box, 40) });
    } else {
      shot = a.shot ? capture.getShot(a.shot) : capture.latestShot();
      if (!shot) throw new Error('Brak zrzutu — podaj shot');
      box = shot.toScreenBox({ x: a.x, y: a.y, w: a.w, h: a.h });
    }
    patch.box = box;
    patch.image = { rgba: shot.rgba, width: shot.width, height: shot.height, rect: shot.rect };
    if (shot.window && shot.window.rect) patch.window = { process: shot.window.process, title: shot.window.title, className: shot.window.className, rect: shot.window.rect };
  }
  const el = await elements.updateElement(name, patch, p);
  const content = [TXT(`Zaktualizowano „${name}”: ${el.category || ''}${el.important ? ' ★ ważny' : ''} · x=${el.box.x} y=${el.box.y} ${el.box.w}x${el.box.h}${el.description ? ` · ${el.description}` : ''}`)];
  if (shot && patch.box) {
    const r = await image.renderShot(shot, { boxes: [{ ...el.box, label: name, source: 'element', strong: true }], suffix: 'edit' });
    content.push(IMG(r));
  }
  emit('label', { profile: p, elements: [{ name, box: el.box }] });
  return { content, summary: `popraw ${name}` };
});

// ── Aplikacje: mapa, wiedza, ekrany (tanio w tokenach) ────────────────────
tool('app', {
  title: 'Aplikacja: mapa i wiedza',
  description: 'App-level memory, text only (cheap in tokens). action=open: identify the app of a window (or use app=name), make it the active profile and return its compact MAP — named elements with window-relative positions and anchors, mapped screens, recipes (sequences with goals and variables), human lessons and learned knowledge. Call this FIRST for any app; it often makes screenshots unnecessary. action=list: known apps. action=knowledge: full notes. action=note: save what you learned (section + text, markdown; replaces a section with the same title). action=screen: which mapped screen is visible now and its zones (role "text" rel x,y wxh).',
  inputSchema: {
    action: z.enum(['open', 'list', 'knowledge', 'note', 'screen']),
    app: z.string().optional().describe('App/profile name (from list)'),
    window: z.string().optional().describe('Window title fragment or process — identifies/creates the app'),
    focus: z.boolean().optional().describe('open: also bring its window to front'),
    section: z.string().optional(),
    text: z.string().optional(),
  },
}, async (a) => {
  if (a.action === 'list') {
    const list = apps.listApps();
    return { content: [TXT(list.map((x) => `• ${x.name}${x.app ? ` [${x.app.process}]` : ''} — ${x.elements} elementów${x.description ? ` — ${x.description}` : ''}`).join('\n') || 'Brak aplikacji. app(action="open", window="…") zakłada nową.')], summary: `${list.length} aplikacji` };
  }
  let name = a.app;
  if (!name && a.window) {
    const w = await findWindow(a.window);
    if (!w) throw new Error(`Nie znalazłem okna „${a.window}”. list_windows pokaże otwarte okna.`);
    name = await apps.identifyApp(w);
  }
  if (!name && a.action === 'open') {
    const fg = win32.foregroundWindow();
    if (fg) name = await apps.identifyApp(fg);
  }
  if (!name) name = elements.activeProfile();
  if (a.action === 'knowledge') return { content: [TXT(apps.readKnowledge(name) || '(brak wiedzy — zapisz: app action=note)')], summary: 'wiedza' };
  if (a.action === 'note') {
    if (!a.text) throw new Error('Podaj text (markdown)');
    apps.writeKnowledge(name, a.text, a.section || '');
    emit('knowledge', { app: name, section: a.section || '' });
    return { content: [TXT(`Zapisano w wiedzy „${name}”${a.section ? ` (sekcja „${a.section}”)` : ''}.`)], summary: 'notatka' };
  }
  if (a.action === 'screen') {
    const win = apps.windowForApp(name);
    if (!win) throw new Error('Okno aplikacji nie jest otwarte');
    const shot = await capture.capture({ rect: win.rect, window: win });
    const ocr = await ocrShot(shot);
    const sig = apps.signatureOf(ocr.phrases);
    const best = apps.bestScreen(name, sig);
    if (!best || best.score < 0.3) return { content: [TXT(`Nieznany ekran (najbliższy: ${best ? `${best.screen.id} ${(best.score * 100).toFixed(0)}%` : 'brak map'}). detect_elements(window=…) zmapuje go; podczas lekcji MPC Studio mapuje ekrany samo.`)], summary: 'nieznany ekran' };
    const s = best.screen;
    const lines = s.elements.slice(0, 160).map((e, i) => `${i + 1} ${e.role}${e.text ? ` "${e.text.slice(0, 40)}"` : ''} @${e.rel.x},${e.rel.y} ${e.rel.w}x${e.rel.h}`);
    return { content: [TXT(`Ekran „${s.id}” (podobieństwo ${(best.score * 100).toFixed(0)}%), okno teraz x=${win.rect.x} y=${win.rect.y}. Strefy (x,y względem okna):\n${lines.join('\n')}`)], summary: s.id };
  }
  // open
  elements.setActiveProfile(name);
  let focusNote = '';
  if (a.focus) {
    const w = apps.windowForApp(name);
    if (w) { const r = await actions.doFocus({ hwnd: w.hwnd }); focusNote = r.ok ? '\n(okno na wierzchu)' : '\n(Windows nie oddał fokusu — poproś człowieka o kliknięcie okna)'; }
  }
  const map = apps.compactMap(name);
  emit('profile', { profile: name });
  return { content: [TXT(map.text + focusNote)], summary: `mapa ${name}` };
}, { lock: false });

// ── Lekcje nagrane przez człowieka (MPC Studio, F9) ───────────────────────
tool('lesson', {
  title: 'Lekcje człowieka',
  description: 'Human demonstrations recorded in MPC Studio (hotkey F9): every click with the mapped element (name, type, colour category, window), typed text (passwords hidden) and keys. action=list | get (steps as text; images=true adds step screenshots with the clicked zone, use from/to to limit) | to_sequence (turn the lesson into a replayable recipe; typed texts become {{variables}} with recorded defaults; optional name/goal).',
  inputSchema: {
    action: z.enum(['list', 'get', 'to_sequence']),
    name: z.string().optional(),
    images: z.boolean().optional(),
    from: z.number().int().min(1).optional(),
    to: z.number().int().min(1).optional(),
    sequence_name: z.string().optional(),
    goal: z.string().optional(),
  },
  annotations: { readOnlyHint: false },
}, async (a) => {
  if (a.action === 'list') {
    const list = lessons.list();
    return { content: [TXT(list.map((l) => `• ${l.name} — ${l.steps} kroków · ${(l.apps || []).join(', ')}${l.goal ? ` · cel: ${l.goal}` : ''}`).join('\n') || 'Brak lekcji. Człowiek nagrywa je w MPC Studio → Nauka (F9).')], summary: `${list.length} lekcji` };
  }
  if (!a.name) throw new Error('Podaj name');
  const l = lessons.get(a.name);
  if (a.action === 'to_sequence') {
    const def = lessons.toSequenceDef(l, { name: a.sequence_name, goal: a.goal });
    const seq = sequences.save(def);
    return { content: [TXT(`Przepis „${seq.name}” z lekcji (${seq.steps.length} kroków, profil ${seq.profile}).\nZmienne z wartościami z lekcji: ${Object.entries(seq.variables || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') || 'brak'}${def.secrets.length ? `\nTajne (podaj przy uruchomieniu): ${def.secrets.join(', ')}` : ''}\n${seq.steps.map((s, i) => `${i + 1}. ${sequences.stepLabel(s)}`).join('\n')}\nUruchom: sequence_run(name="${seq.name}", variables={…}) — najpierw dry_run=true.`)], summary: `przepis ${seq.name}` };
  }
  const from = a.from || 1;
  const to = Math.min(l.steps.length, a.to || l.steps.length);
  const lines = l.steps.filter((s) => s.i >= from && s.i <= to).map((s) => {
    const w = s.window ? ` · okno „${(s.window.title || '').slice(0, 40)}”` : '';
    const rel = s.elementInfo && s.elementInfo.box && s.window ? ` @${s.elementInfo.box.x - s.window.rect.x},${s.elementInfo.box.y - s.window.rect.y}` : '';
    return `${s.i}. [${(s.t / 1000).toFixed(1)}s] ${lessons.stepLabel(s)}${rel}${s.app ? ` · ${s.app}` : ''}${w}${s.screen ? ` · ekran ${s.screen}` : ''}${s.skip ? ' (pominięty)' : ''}`;
  });
  const content = [TXT(`Lekcja „${l.name}”${l.goal ? ` — cel: ${l.goal}` : ''} · ${l.steps.length} kroków · aplikacje: ${(l.apps || []).join(', ')} · ${(l.durationMs / 1000).toFixed(0)} s\n${lines.join('\n')}`)];
  if (a.images) {
    for (const s of l.steps.filter((x) => x.i >= from && x.i <= to && x.shot).slice(0, 6)) {
      const shot = capture.register(new capture.Shot({ ...(await image.pngToRgba(lessons.stepImagePath(l.name, s.shot))), rect: s.window.rect, window: null, label: `lekcja ${s.i}` }));
      const r = await image.renderShot(shot, { maxWidth: 900, boxes: s.elementInfo ? [{ ...s.elementInfo.box, label: `${s.i} ${s.element}`, color: colorOf(s.elementInfo.category), strong: true }] : [], clicks: s.point ? [{ ...s.point }] : [], save: false });
      content.push(TXT(`Krok ${s.i} (${shot.id}):`), IMG(r));
    }
  }
  return { content, summary: `lekcja ${l.name}` };
}, { lock: false });

// ── act: wiele kroków w jednym wywołaniu ──────────────────────────────────
tool('act', {
  title: 'Wykonaj kilka kroków',
  description: 'Run several actions in ONE call (saves tokens and round trips): steps like sequence steps — click/move (element | text | mark+shot | x,y+shot), type (text, + element/text_target/mark to click first, clear, enter), keys, scroll, drag, wait (ms), wait_for (element|text, gone), wait_stable, focus (window). Stops at the first error (blocked or stopped clicks always stop). screenshot_after=true returns one screenshot of the active window at the end. Recorded into the sequence if sequence_record is on.',
  inputSchema: {
    steps: z.array(z.object({
      action: z.enum(['click', 'move', 'type', 'keys', 'scroll', 'drag', 'wait', 'wait_for', 'wait_stable', 'focus']),
      element: z.string().optional(), text: z.string().optional(), text_target: z.string().optional(),
      mark: z.number().int().optional(), shot: z.string().optional(),
      x: z.number().optional(), y: z.number().optional(), space: z.enum(['image', 'screen']).optional(),
      button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional(),
      clear: z.boolean().optional(), enter: z.boolean().optional(), keys: z.string().optional(), repeat: z.number().int().optional(),
      direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().int().optional(),
      from: z.object({ element: z.string().optional(), text: z.string().optional(), mark: z.number().int().optional(), shot: z.string().optional(), x: z.number().optional(), y: z.number().optional(), space: z.enum(['image', 'screen']).optional() }).optional(),
      to: z.object({ element: z.string().optional(), text: z.string().optional(), mark: z.number().int().optional(), shot: z.string().optional(), x: z.number().optional(), y: z.number().optional(), space: z.enum(['image', 'screen']).optional() }).optional(),
      ms: z.number().int().optional(), gone: z.boolean().optional(), timeout_ms: z.number().int().optional(), window: z.string().optional(),
    }).passthrough()).min(1).max(40),
    variables: z.record(z.string()).optional(),
    continue_on_error: z.boolean().optional(),
    screenshot_after: z.boolean().optional(),
  },
}, async (a) => {
  const r = await sequences.act(a.steps, { variables: a.variables || {}, stopOnError: !a.continue_on_error });
  const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.i}. ${s.label}${s.changed !== undefined ? ` · zmiana ${(s.changed * 100).toFixed(1)}%` : ''}${s.error ? ` — ${s.error}` : ''}`);
  const content = [TXT(`${r.dry ? '[PRÓBA] ' : ''}${r.ok ? 'OK' : `PRZERWANE na kroku ${r.failedStep}`} · ${r.steps.length}/${a.steps.length} kroków · ${r.ms} ms\n${lines.join('\n')}`)];
  let imageFile = null;
  if (a.screenshot_after) {
    await input.sleep(400);
    const fg = win32.foregroundWindow();
    const shot = fg && fg.rect && fg.rect.w > 50 ? await capture.capture({ rect: fg.rect, window: fg }) : await capture.capture();
    const img = await image.renderShot(shot, { suffix: 'act' });
    content.push(TXT(mappingText(shot)), IMG(img));
    imageFile = img.file;
  }
  return { content, summary: r.ok ? `act ${r.steps.length} kroków` : `act błąd ${r.failedStep}`, imageFile };
}, { lock: true });

tool('use_profile', {
  title: 'Profil aplikacji',
  description: 'Switch the active profile (one profile per application, e.g. "notatnik", "mexc", "excel"); created if missing. Without name: list profiles.',
  inputSchema: { name: z.string().optional(), description: z.string().optional() },
}, async ({ name, description }) => {
  if (!name) {
    const list = elements.listProfiles();
    return { content: [TXT(`Aktywny: ${elements.activeProfile()}\n${list.map((p) => `• ${p.name} — ${p.elements} elementów${p.description ? ` — ${p.description}` : ''}`).join('\n') || '(brak profili)'}`)], summary: 'profile' };
  }
  const p = elements.setActiveProfile(name);
  if (description) { const d = elements.loadProfile(p); d.description = description; elements.saveProfile(p, d); }
  emit('profile', { profile: p });
  return { content: [TXT(`Aktywny profil: „${p}” (${Object.keys(elements.loadProfile(p).elements).length} elementów).`)], summary: p };
});

// ── Narzędzia: działanie ──────────────────────────────────────────────────
function actionText(r) {
  const where = r.point ? ` w (${r.point.x}, ${r.point.y})` : '';
  const info = [];
  if (r.info && r.info.score !== undefined && r.info.score !== null) info.push(`dopasowanie ${r.info.score}`);
  if (r.info && r.info.moved) info.push('element był przesunięty — znaleziony po wyglądzie');
  if (r.info && r.info.found) info.push(`OCR: „${r.info.found}”`);
  if (r.info && r.info.others) info.push(`jest jeszcze ${r.info.others} podobnych (occurrence=N)`);
  if (r.motion) info.push(`ruch: ${r.motion}${r.recording ? ` (${r.recording})` : ''} ${r.moveMs || 0} ms`);
  if (r.changed !== null && r.changed !== undefined) info.push(r.changed < 0.002 ? `UWAGA: obszar się nie zmienił (${(r.changed * 100).toFixed(2)}%)` : `obszar zmienił się w ${(r.changed * 100).toFixed(1)}%`);
  return `${r.dry ? '[PRÓBA] ' : ''}${r.target}${where}${info.length ? ` · ${info.join(' · ')}` : ''}`;
}

tool('click', {
  title: 'Kliknij',
  description: 'Move the mouse along a human-like path (recorded human movements or a natural curve) and click. Target: element | mark(+shot) | text | x,y(+shot or space="screen"). verify=true reports whether the area around the target changed. screenshot_after=true returns a screenshot of that window ~0.6 s after the click — use it for buttons that show short-lived messages (toasts disappear while you think).',
  inputSchema: {
    ...targetShape,
    button: z.enum(['left', 'right', 'middle']).optional(),
    double: z.boolean().optional(),
    verify: z.boolean().optional(),
    screenshot_after: z.boolean().optional(),
  },
}, async (a) => {
  const t = pickTarget(a);
  const r = await actions.doClick(t, { button: a.button || 'left', double: !!a.double, verify: !!a.verify });
  await sequences.recordAction({ action: 'click', ...(a.button && a.button !== 'left' ? { button: a.button } : {}), ...(a.double ? { double: true } : {}) }, { target: t, resolved: r });
  const content = [TXT(`Kliknięto${a.double ? ' dwukrotnie' : ''}${a.button && a.button !== 'left' ? ` (${a.button})` : ''}: ${actionText(r)}`)];
  let imageFile = null;
  let shotId = null;
  if (a.screenshot_after) {
    await input.sleep(r.changed !== null && r.changed !== undefined ? 150 : 600);
    const w = win32.windowAt(r.point.x, r.point.y);
    const shot = w && w.rect && w.rect.w > 50 ? await capture.capture({ rect: w.rect, window: w }) : await capture.capture();
    const img = await image.renderShot(shot, { clicks: [{ ...r.point, label: 'klik' }], suffix: 'after' });
    content.push(TXT(`Po kliknięciu — ${mappingText(shot)}`), IMG(img));
    imageFile = img.file;
    shotId = shot.id;
  }
  return { content, summary: `klik ${r.target}`, imageFile, shot: shotId };
}, { lock: true });

tool('move_mouse', {
  title: 'Najedź myszą',
  description: 'Hover: move the mouse (human-like) onto a target without clicking — e.g. to open a hover menu or tooltip.',
  inputSchema: { ...targetShape },
}, async (a) => {
  const t = pickTarget(a);
  const r = await actions.doMove(t);
  await sequences.recordAction({ action: 'move' }, { target: t, resolved: r });
  return { content: [TXT(`Kursor nad: ${actionText(r)}`)], summary: `hover ${r.target}` };
}, { lock: true });

const dragTarget = z.object({
  element: z.string().optional(), mark: z.number().int().optional(), shot: z.string().optional(), text: z.string().optional(),
  x: z.number().optional(), y: z.number().optional(), space: z.enum(['image', 'screen']).optional(),
});
tool('drag', {
  title: 'Przeciągnij',
  description: 'Press, drag along a human-like path and release (sliders, drag & drop, selections). from/to accept the same target fields as click.',
  inputSchema: { from: dragTarget, to: dragTarget },
}, async ({ from, to }) => {
  const r = await actions.doDrag(from, to);
  return { content: [TXT(`Przeciągnięto ${r.from} (${r.fromPoint.x},${r.fromPoint.y}) → ${r.to} (${r.toPoint.x},${r.toPoint.y})`)], summary: 'drag' };
}, { lock: true });

tool('scroll', {
  title: 'Przewiń',
  description: 'Scroll the mouse wheel (amount = notches, ~3 lines each) over a target or at the current cursor.',
  inputSchema: { ...targetShape, direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().int().min(1).max(50).optional() },
}, async (a) => {
  const t = pickTarget(a);
  const r = await actions.doScroll({ target: t, direction: a.direction || 'down', amount: a.amount || 3 });
  await sequences.recordAction({ action: 'scroll', direction: r.direction, amount: r.amount, ...(t.element ? { element: t.element } : {}) });
  return { content: [TXT(`Przewinięto ${r.direction} ×${r.amount} (${r.target})`)], summary: 'scroll' };
}, { lock: true });

tool('type_text', {
  title: 'Wpisz tekst',
  description: 'Type text like a human (variable rhythm, any Unicode incl. Polish letters). Optionally click a target field first (same target fields as click; `text_target` = click on this visible text first), clear it (Ctrl+A, Delete) and press Enter after.',
  inputSchema: {
    text: z.string().describe('Text to type (\\n = Enter, \\t = Tab)'),
    element: z.string().optional(), mark: z.number().int().optional(), shot: z.string().optional(),
    text_target: z.string().optional().describe('Click this visible text (OCR) before typing'),
    x: z.number().optional(), y: z.number().optional(), space: z.enum(['image', 'screen']).optional(),
    clear: z.boolean().optional(), enter: z.boolean().optional(),
  },
}, async (a) => {
  const t = {};
  for (const k of ['element', 'mark', 'shot', 'x', 'y', 'space']) if (a[k] !== undefined) t[k] = a[k];
  if (a.text_target) t.text = a.text_target;
  let resolved = null;
  const hasT = Object.keys(t).some((k) => k !== 'shot' && k !== 'space');
  if (hasT) resolved = await actions.doClick(t, {});
  const r = await actions.doType(a.text, { clear: !!a.clear, enter: !!a.enter });
  await sequences.recordAction({ action: 'type', text: a.text, ...(a.clear ? { clear: true } : {}), ...(a.enter ? { enter: true } : {}) }, hasT ? { target: t, resolved } : {});
  return { content: [TXT(`${getSettings().dryRun ? '[PRÓBA] ' : ''}Wpisano ${r.chars} znaków${resolved ? ` w ${resolved.target}` : ''}${a.clear ? ' (po wyczyszczeniu)' : ''}${a.enter ? ' + Enter' : ''}.`)], summary: `wpisano ${r.chars}` };
}, { lock: true });

tool('press_keys', {
  title: 'Klawisze',
  description: 'Press a key or shortcut, e.g. "Enter", "Esc", "Tab", "Ctrl+S", "Ctrl+Shift+T", "Alt+F4", "Win+D", "PageDown", "F5". repeat = how many times.',
  inputSchema: { keys: z.string(), repeat: z.number().int().min(1).max(50).optional() },
}, async ({ keys, repeat }) => {
  const r = await actions.doKeys(keys, { repeat: repeat || 1 });
  await sequences.recordAction({ action: 'keys', keys: r.keys, ...(repeat > 1 ? { repeat } : {}) });
  return { content: [TXT(`${getSettings().dryRun ? '[PRÓBA] ' : ''}Naciśnięto ${r.keys}${repeat > 1 ? ` ×${repeat}` : ''}`)], summary: r.keys };
}, { lock: true });

tool('wait', {
  title: 'Czekaj',
  description: 'Wait: a fixed time (ms), until an element or text appears (or disappears with gone=true), or until the screen stops changing (stable=true). Use after clicks that load something.',
  inputSchema: {
    ms: z.number().int().min(0).max(120000).optional(),
    for_element: z.string().optional(),
    for_text: z.string().optional(),
    window: z.string().optional(),
    gone: z.boolean().optional(),
    stable: z.boolean().optional(),
    timeout_ms: z.number().int().min(200).max(120000).optional(),
  },
}, async (a) => {
  if (a.for_element || a.for_text) {
    const r = await actions.doWaitFor({ element: a.for_element, text: a.for_text, gone: a.gone, timeout_ms: a.timeout_ms || 8000, window: a.window });
    await sequences.recordAction({ action: 'wait_for', ...(a.for_element ? { element: a.for_element } : { text: a.for_text }), ...(a.gone ? { gone: true } : {}), timeout_ms: a.timeout_ms || 8000 });
    return { content: [TXT(`${r.ok ? 'OK' : 'NIE DOCZEKAŁEM SIĘ'}: ${r.what}${a.gone ? ' zniknął' : ' jest'} po ${r.ms} ms${r.dry ? ' (próbnie)' : ''}`)], summary: r.ok ? 'ok' : 'timeout' };
  }
  if (a.stable) {
    const r = await actions.doWaitStable({ timeout_ms: a.timeout_ms || 6000 });
    await sequences.recordAction({ action: 'wait_stable', timeout_ms: a.timeout_ms || 6000 });
    return { content: [TXT(r.ok ? `Ekran stabilny po ${r.ms} ms` : `Ekran wciąż się zmienia po ${r.ms} ms`)], summary: 'stable' };
  }
  const ms = a.ms ?? 1000;
  await input.sleep(ms);
  await sequences.recordAction({ action: 'wait', ms });
  return { content: [TXT(`Odczekano ${ms} ms`)], summary: `${ms} ms` };
}, { lock: true });

// ── Narzędzia: sekwencje ──────────────────────────────────────────────────
tool('sequence_record', {
  title: 'Nagrywaj sekwencję',
  description: 'Record your own actions into a reusable sequence. start(name) → every click/type/keys/scroll/wait/focus you do is appended (marks and image coordinates are auto-saved as elements, so replay works when windows move) → stop (saves) | cancel | status.',
  inputSchema: { action: z.enum(['start', 'stop', 'cancel', 'status']), name: z.string().optional(), description: z.string().optional() },
}, async ({ action, name, description }) => {
  if (action === 'start') {
    sequences.recordStart(name || `sekwencja_${Date.now()}`, description || '');
    return { content: [TXT(`Nagrywam sekwencję „${sequences.recordStatus().name}”. Wykonuj akcje; potem sequence_record(action="stop").`)], summary: 'nagrywanie start' };
  }
  if (action === 'status') {
    const s = sequences.recordStatus();
    return { content: [TXT(s.active ? `Nagrywam „${s.name}”: ${s.steps} kroków\n${s.list.map((l, i) => `${i + 1}. ${l}`).join('\n')}` : 'Nie nagrywam.')], summary: 'status' };
  }
  if (action === 'cancel') {
    const n = sequences.recordCancel();
    return { content: [TXT(`Anulowano nagrywanie (${n} kroków odrzucone).`)], summary: 'anulowano' };
  }
  const r = sequences.recordStop({ name, description });
  const seq = r.sequence;
  return { content: [TXT(`Zapisano sekwencję „${seq.name}” (${seq.steps.length} kroków):\n${seq.steps.map((s, i) => `${i + 1}. ${sequences.stepLabel(s)}`).join('\n')}\nUruchom: sequence_run(name="${seq.name}"). Możesz zamienić wpisywany tekst na {{zmienną}} przez sequence_save.`)], summary: `zapisano ${seq.name}` };
});

const stepShape = z.object({
  action: z.enum(['click', 'move', 'type', 'keys', 'scroll', 'drag', 'wait', 'wait_for', 'wait_stable', 'focus', 'run']),
  element: z.string().optional(),
  text: z.string().optional().describe('click/move/wait_for: visible text target; type: the text to type'),
  text_target: z.string().optional().describe('type: click this visible text first'),
  x: z.number().optional(), y: z.number().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional(), verify: z.boolean().optional(),
  clear: z.boolean().optional(), enter: z.boolean().optional(),
  keys: z.string().optional(), repeat: z.number().int().optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().int().optional(),
  from: z.object({ element: z.string().optional(), text: z.string().optional(), x: z.number().optional(), y: z.number().optional() }).optional(),
  to: z.object({ element: z.string().optional(), text: z.string().optional(), x: z.number().optional(), y: z.number().optional() }).optional(),
  ms: z.number().int().optional(), gone: z.boolean().optional(), timeout_ms: z.number().int().optional(),
  window: z.string().optional(), maximize: z.boolean().optional(),
  sequence: z.string().optional(), variables: z.record(z.string()).optional(),
  occurrence: z.number().int().optional(),
  note: z.string().optional(),
}).passthrough();

tool('sequence_save', {
  title: 'Zapisz sekwencję',
  description: 'Save (or overwrite) a named click sequence from explicit steps. Steps use saved element names or visible text (not marks); x/y are screen pixels. Use {{var}} in strings and give defaults in `variables`. Example step list: [{"action":"focus","window":"Notatnik"},{"action":"click","element":"menu_plik"},{"action":"click","text":"Zapisz jako"},{"action":"type","text":"{{nazwa}}","enter":true},{"action":"wait_for","text":"Zapisano","timeout_ms":5000}]',
  inputSchema: { name: z.string(), description: z.string().optional(), goal: z.string().optional().describe('What this recipe achieves (shown in the app map)'), profile: z.string().optional(), variables: z.record(z.string()).optional(), steps: z.array(stepShape).min(1) },
}, async (a) => {
  const seq = sequences.save({ name: a.name, description: a.description, goal: a.goal, profile: a.profile, variables: a.variables, steps: a.steps, createdBy: 'ai' });
  return { content: [TXT(`Zapisano „${seq.name}” (${seq.steps.length} kroków, profil ${seq.profile}):\n${seq.steps.map((s, i) => `${i + 1}. ${sequences.stepLabel(s)}`).join('\n')}`)], summary: `sekwencja ${seq.name}` };
});

tool('sequence_list', {
  title: 'Sekwencje',
  description: 'List saved sequences; with name: show its steps, variables and run statistics.',
  inputSchema: { name: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ name }) => {
  if (name) {
    const s = sequences.get(name);
    const vars = Object.entries(s.variables || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
    return { content: [TXT(`„${s.name}” — ${s.description || 'bez opisu'} · profil ${s.profile} · autor ${s.createdBy} · uruchomień ${s.stats ? s.stats.runs : 0} (udanych ${s.stats ? s.stats.ok : 0})\nZmienne: ${vars || 'brak'}\n${s.steps.map((st, i) => `${i + 1}. ${sequences.stepLabel(st)}  ${JSON.stringify(st)}`).join('\n')}`)], summary: s.name };
  }
  const list = sequences.list();
  return { content: [TXT(list.map((s) => `• ${s.name} — ${s.steps} kroków · ${s.createdBy}${s.description ? ` · ${s.description}` : ''}${s.variables.length ? ` · zmienne: ${s.variables.join(', ')}` : ''}`).join('\n') || 'Brak sekwencji.')], summary: `${list.length} sekwencji` };
});

tool('sequence_run', {
  title: 'Uruchom sekwencję',
  description: 'Run a saved sequence step by step with human-like motion. Elements are re-located on screen before each click. variables fill {{var}}. dry_run=true rehearses without clicking. from_step/to_step run a part. Returns a per-step report and a final screenshot.',
  inputSchema: {
    name: z.string(), variables: z.record(z.string()).optional(), dry_run: z.boolean().optional(),
    from_step: z.number().int().min(1).optional(), to_step: z.number().int().min(1).optional(),
    continue_on_error: z.boolean().optional(),
  },
}, async (a) => {
  const r = await sequences.run(a.name, { variables: a.variables || {}, dryRun: a.dry_run, fromStep: a.from_step || 1, toStep: a.to_step, stopOnError: !a.continue_on_error });
  const lines = r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.i}. ${s.label} (${s.ms} ms)${s.moved ? ' · element przesunięty, znaleziony' : ''}${s.changed !== undefined ? ` · zmiana ${(s.changed * 100).toFixed(1)}%` : ''}${s.error ? ` — ${s.error}` : ''}`);
  const shot = await capture.capture();
  const img = await image.renderShot(shot, { maxWidth: 1100, suffix: 'seq' });
  return {
    content: [TXT(`${r.dry ? '[PRÓBA] ' : ''}Sekwencja „${r.name}”: ${r.ok ? 'OK' : `PRZERWANA na kroku ${r.failedStep}`} w ${r.ms} ms\n${lines.join('\n')}\nStan ekranu po zakończeniu (${shot.id}):`), IMG(img)],
    summary: `${r.name}: ${r.ok ? 'ok' : 'błąd'}`, imageFile: img.file, shot: shot.id,
  };
}, { lock: true });

tool('sequence_delete', {
  title: 'Usuń sekwencję',
  description: 'Delete a saved sequence.',
  inputSchema: { name: z.string() },
  annotations: { destructiveHint: true },
}, async ({ name }) => {
  const ok = sequences.remove(name);
  return { content: [TXT(ok ? `Usunięto sekwencję „${name}”.` : `Nie ma sekwencji „${name}”.`)], summary: ok ? 'usunięto' : 'brak' };
});

// ── Ustawienia ────────────────────────────────────────────────────────────
tool('settings', {
  title: 'Ustawienia',
  description: 'Show or change behaviour: dry_run (rehearse, no real input), motion (recorded = replay human mouse recordings between clicks, synthetic = natural curve, direct = jump), speed (1 = human pace), noise_px, ocr_language (auto|pl|en-US), max_image_width. Also lists the human mouse-movement library.',
  inputSchema: {
    dry_run: z.boolean().optional(),
    motion: z.enum(['recorded', 'synthetic', 'direct']).optional(),
    speed: z.number().min(0.25).max(5).optional(),
    noise_px: z.number().min(0).max(10).optional(),
    ocr_language: z.string().optional(),
    max_image_width: z.number().int().min(400).max(2000).optional(),
  },
}, async (a) => {
  const patch = { dryRun: a.dry_run, motion: a.motion, speed: a.speed, noisePx: a.noise_px, ocrLanguage: a.ocr_language, maxImageWidth: a.max_image_width };
  const changed = Object.values(patch).some((v) => v !== undefined);
  const st = changed ? updateSettings(patch) : getSettings();
  if (changed) emit('settings', { patch: brief(patch) });
  const recs = recordings.list();
  const lines = Object.keys(DEFAULTS).map((k) => `${k}: ${JSON.stringify(st[k])}`);
  return {
    content: [TXT(`${changed ? 'Zmieniono. ' : ''}Ustawienia:\n${lines.join('\n')}\nNagrane ruchy człowieka (${recs.length}): ${recs.slice(0, 30).map((r) => `${r.name} ${r.lengthPx}px/${r.durationMs}ms`).join(', ') || 'brak — nagraj w MPC Studio (F8), do tego czasu ruch syntetyczny'}`)],
    summary: changed ? 'zmiana ustawień' : 'ustawienia',
  };
});

// ── Prompt z gotowym planem pracy ─────────────────────────────────────────
server.registerPrompt('automate_app', {
  title: 'Zautomatyzuj aplikację',
  description: 'Step-by-step plan for automating a task in a desktop app with MPC Ekran',
  argsSchema: { app: z.string().describe('Application / window'), task: z.string().describe('What to do') },
}, ({ app, task }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Use MPC Ekran tools to do this in "${app}": ${task}\n` +
        '1) screen_info, then focus_window. 2) use_profile with the app name. 3) detect_elements on that window. ' +
        '4) label_elements for every element you need (clear names + descriptions) and check the preview. ' +
        '5) sequence_record start → perform the task with click/type_text/press_keys, verifying with wait(for_text) or a screenshot after important steps → sequence_record stop. ' +
        '6) Report what was saved and how to rerun it (sequence_run). Ask me before any irreversible action.',
    },
  }],
}));

server.registerPrompt('learn_app', {
  title: 'Naucz się aplikacji',
  description: 'Learn an application for a goal: read its map and human lessons, map screens, label elements, build and test a recipe, save knowledge',
  argsSchema: { app: z.string().describe('Window title fragment or app name'), goal: z.string().describe('What the user wants to be able to do') },
}, ({ app, goal }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Naucz się aplikacji „${app}” pod cel: ${goal}\n` +
        `1) app(action="open", window="${app}") — mapa, przepisy, lekcje, wiedza. 2) Jeśli są lekcje człowieka: lesson(action="get") — droga człowieka to wzór (obrazy tylko dla niejasnych kroków). ` +
        '3) Dla każdego potrzebnego ekranu: detect_elements(window, image=false gdy wystarczy lista), label_elements z jasnymi nazwami i opisami. ' +
        '4) Przepis: lesson(action="to_sequence") albo sequence_save z goal i {{zmiennymi}}, wait_for po zmianach ekranu; sprawdź sequence_run(dry_run=true), potem na żywo — przed czymś nieodwracalnym zapytaj mnie. ' +
        '5) app(action="note") — zwięzła wiedza: ekrany, jak sprawdzić efekt, pułapki. 6) Podsumuj, jak uruchomić przepis. Oszczędzaj tokeny: act, image=false, element/text zamiast zrzutów.',
    },
  }],
}));

// ── Start ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  server.server.oninitialized = () => {
    clientInfo = server.server.getClientVersion() || null;
    emit('connect', { client: clientInfo, version: pkg.version });
    beat({ connectedAt: Date.now() });
  };
  await server.connect(transport);
  emit('server-start', { version: pkg.version, dpi: win32.dpiMode });
  beat({ startedAt: Date.now() });
  const hb = setInterval(() => beat(), 10000);
  hb.unref();
  const bye = () => {
    emit('server-stop', {});
    try { require('fs').unlinkSync(require('../core/paths').HEARTBEAT_FILE); } catch { /* ignore */ }
    shutdownWorkers();
    process.exit(0);
  };
  process.stdin.on('end', bye);
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

process.on('uncaughtException', (e) => process.stderr.write(`[mpc] uncaught: ${e.stack || e.message}\n`));
process.on('unhandledRejection', (e) => process.stderr.write(`[mpc] unhandled: ${(e && e.stack) || e}\n`));

main().catch((e) => {
  process.stderr.write(`[mpc] start failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
