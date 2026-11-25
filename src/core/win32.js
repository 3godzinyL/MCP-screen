// Warstwa Win32 przez koffi (FFI bez kompilacji).
// Najważniejsze: proces staje się DPI-aware ZANIM cokolwiek dotknie ekranu,
// więc zrzuty, kursor i UIA mówią tym samym językiem: fizyczne piksele.
// Na laptopie ze skalowaniem 150% bez tego klik trafiałby obok przycisku.
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
let dwmapi = null;
try { dwmapi = koffi.load('dwmapi.dll'); } catch { /* starsze systemy */ }

// ── DPI ───────────────────────────────────────────────────────────────────
const SetProcessDpiAwarenessContext = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)');
const SetProcessDPIAware = user32.func('bool __stdcall SetProcessDPIAware()');
const GetDpiForSystem = user32.func('uint __stdcall GetDpiForSystem()');

try {
  // Electron ustawia to sam z manifestu — wtedy wywołanie zwraca false i to jest w porządku
  if (!SetProcessDpiAwarenessContext(-4)) SetProcessDPIAware();
} catch {
  try { SetProcessDPIAware(); } catch { /* ignore */ }
}
let dpiMode = 'unknown';
try {
  const GetThreadDpiAwarenessContext = user32.func('intptr_t __stdcall GetThreadDpiAwarenessContext()');
  const GetAwarenessFromDpiAwarenessContext = user32.func('int __stdcall GetAwarenessFromDpiAwarenessContext(intptr_t ctx)');
  dpiMode = ['unaware', 'system', 'per-monitor'][GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())] || 'unknown';
} catch { /* Win < 10 1607 */ }

// ── Typy ──────────────────────────────────────────────────────────────────
const POINT = koffi.struct('MPC_POINT', { x: 'int32', y: 'int32' });
const RECT = koffi.struct('MPC_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const MONITORINFOEXW = koffi.struct('MPC_MONITORINFOEXW', {
  cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32', szDevice: koffi.array('uint16', 32),
});
const MOUSEINPUT = koffi.struct('MPC_MOUSEINPUT', {
  dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('MPC_KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('MPC_HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
const INPUT_UNION = koffi.union('MPC_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('MPC_INPUT', { type: 'uint32', u: INPUT_UNION });

const EnumWindowsProc = koffi.proto('bool __stdcall MpcEnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
const MonitorEnumProc = koffi.proto('bool __stdcall MpcMonitorEnumProc(intptr_t hMon, intptr_t hdc, MPC_RECT *rc, intptr_t lParam)');

// ── Funkcje ───────────────────────────────────────────────────────────────
const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ MPC_POINT *p)');
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
const SendInput = user32.func('uint __stdcall SendInput(uint n, MPC_INPUT *inputs, int size)');
const GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vk)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const VkKeyScanW = user32.func('int16 __stdcall VkKeyScanW(uint16 ch)');
const MapVirtualKeyW = user32.func('uint __stdcall MapVirtualKeyW(uint code, uint mapType)');

const EnumWindows = user32.func('bool __stdcall EnumWindows(MpcEnumWindowsProc *cb, intptr_t lParam)');
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hwnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr_t hwnd)');
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hwnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16 *buf, int max)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hwnd)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16 *buf, int max)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ MPC_RECT *rc)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)');
const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hwnd, int index)');
const GetAncestor = user32.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, uint flags)');
const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(MPC_POINT p)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 a, uint32 b, bool attach)');
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
const EnumDisplayMonitors = user32.func('bool __stdcall EnumDisplayMonitors(intptr_t hdc, MPC_RECT *clip, MpcMonitorEnumProc *cb, intptr_t lParam)');
const GetMonitorInfoW = user32.func('bool __stdcall GetMonitorInfoW(intptr_t hMon, _Inout_ MPC_MONITORINFOEXW *info)');
let GetDpiForWindow = null;
try { GetDpiForWindow = user32.func('uint __stdcall GetDpiForWindow(intptr_t hwnd)'); } catch { /* Win < 10 */ }
let MonitorFromPoint = null;
try { MonitorFromPoint = user32.func('intptr_t __stdcall MonitorFromPoint(MPC_POINT p, uint32 flags)'); } catch { /* ignore */ }
let GetDpiForMonitor = null;
try {
  const shcore = koffi.load('shcore.dll');
  GetDpiForMonitor = shcore.func('long __stdcall GetDpiForMonitor(intptr_t hMon, int type, _Out_ uint32 *x, _Out_ uint32 *y)');
} catch { /* ignore */ }

const OpenProcess = kernel32.func('intptr_t __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(intptr_t h)');
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32 flags, _Out_ uint16 *buf, _Inout_ uint32 *size)');

let DwmGetWindowAttribute = null;
let DwmCloaked = null;
if (dwmapi) {
  DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ MPC_RECT *rc, uint32 size)');
  DwmCloaked = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ uint32 *val, uint32 size)');
}

// ── Pomocnicze ────────────────────────────────────────────────────────────
function u16ToString(arr, len) {
  const n = typeof len === 'number' ? len : arr.indexOf(0);
  return String.fromCharCode(...arr.slice(0, n < 0 ? arr.length : n));
}

function getCursor() {
  const p = {};
  GetCursorPos(p);
  return { x: p.x, y: p.y };
}

function setCursor(x, y) {
  return SetCursorPos(Math.round(x), Math.round(y));
}

function virtualScreen() {
  return {
    x: GetSystemMetrics(76), y: GetSystemMetrics(77),
    w: GetSystemMetrics(78), h: GetSystemMetrics(79),
  };
}

function primaryScreen() {
  return { x: 0, y: 0, w: GetSystemMetrics(0), h: GetSystemMetrics(1) };
}

function listMonitors() {
  const out = [];
  const cb = koffi.register((hMon) => {
    const info = { cbSize: koffi.sizeof(MONITORINFOEXW), rcMonitor: {}, rcWork: {}, dwFlags: 0, szDevice: new Array(32).fill(0) };
    if (GetMonitorInfoW(hMon, info)) {
      const r = info.rcMonitor;
      const w = info.rcWork;
      let dpi = 96;
      if (GetDpiForMonitor) {
        const dx = [0]; const dy = [0];
        if (GetDpiForMonitor(hMon, 0, dx, dy) === 0) dpi = dx[0];
      }
      out.push({
        index: out.length,
        primary: (info.dwFlags & 1) === 1,
        name: u16ToString(info.szDevice),
        x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top,
        work: { x: w.left, y: w.top, w: w.right - w.left, h: w.bottom - w.top },
        dpi, scale: Math.round((dpi / 96) * 100) / 100,
      });
    }
    return true;
  }, koffi.pointer(MonitorEnumProc));
  try {
    EnumDisplayMonitors(0, null, cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  out.sort((a, b) => (b.primary - a.primary) || (a.x - b.x));
  out.forEach((m, i) => { m.index = i; });
  return out;
}

function windowTitle(hwnd) {
  const len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return '';
  const buf = new Array(len + 1).fill(0);
  const n = GetWindowTextW(hwnd, buf, len + 1);
  return u16ToString(buf, n);
}

function windowClass(hwnd) {
  const buf = new Array(256).fill(0);
  const n = GetClassNameW(hwnd, buf, 256);
  return u16ToString(buf, n);
}

const procNameCache = new Map();
function processName(pid) {
  if (!pid) return '';
  const hit = procNameCache.get(pid);
  if (hit && Date.now() - hit.t < 60000) return hit.name;
  let name = '';
  const h = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
  if (h) {
    try {
      const buf = new Array(1024).fill(0);
      const size = [1024];
      if (QueryFullProcessImageNameW(h, 0, buf, size)) {
        const full = u16ToString(buf, size[0]);
        name = full.split('\\').pop().replace(/\.exe$/i, '');
      }
    } finally {
      CloseHandle(h);
    }
  }
  procNameCache.set(pid, { name, t: Date.now() });
  return name;
}

// Prawdziwy prostokąt okna (bez niewidzialnych ramek Windows 10, które dodają ~7 px).
function windowRect(hwnd) {
  const rc = {};
  if (DwmGetWindowAttribute && DwmGetWindowAttribute(hwnd, 9 /* EXTENDED_FRAME_BOUNDS */, rc, koffi.sizeof(RECT)) === 0) {
    return { x: rc.left, y: rc.top, w: rc.right - rc.left, h: rc.bottom - rc.top };
  }
  GetWindowRect(hwnd, rc);
  return { x: rc.left, y: rc.top, w: rc.right - rc.left, h: rc.bottom - rc.top };
}

function isCloaked(hwnd) {
  if (!DwmCloaked) return false;
  const v = [0];
  return DwmCloaked(hwnd, 14 /* DWMWA_CLOAKED */, v, 4) === 0 && v[0] !== 0;
}

function describeWindow(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return {
    hwnd: Number(hwnd),
    title: windowTitle(hwnd),
    className: windowClass(hwnd),
    pid: pid[0],
    process: processName(pid[0]),
    rect: windowRect(hwnd),
    minimized: IsIconic(hwnd),
    maximized: IsZoomed(hwnd),
  };
}

// Okna, które człowiek widzi na pasku zadań (bez narzędziowych, ukrytych i „cloaked”).
function listWindows({ includeUntitled = false } = {}) {
  const handles = [];
  const cb = koffi.register((hwnd) => { handles.push(hwnd); return true; }, koffi.pointer(EnumWindowsProc));
  try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  const fg = GetForegroundWindow();
  const out = [];
  let z = 0;
  for (const h of handles) {
    if (!IsWindowVisible(h)) continue;
    const exStyle = Number(GetWindowLongPtrW(h, -20));
    if (exStyle & 0x80 /* WS_EX_TOOLWINDOW */) continue;
    if (isCloaked(h)) continue;
    const info = describeWindow(h);
    if (!includeUntitled && !info.title) continue;
    if (info.rect.w < 40 || info.rect.h < 30) continue;
    info.z = z++;
    info.foreground = Number(h) === Number(fg);
    out.push(info);
  }
  return out;
}

function foregroundWindow() {
  const h = GetForegroundWindow();
  if (!h) return null;
  const info = describeWindow(h);
  info.foreground = true;
  return info;
}

function windowAt(x, y) {
  const h = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
  if (!h) return null;
  const root = GetAncestor(h, 2 /* GA_ROOT */) || h;
  return describeWindow(root);
}

// Lekka wersja: tylko uchwyt okna najwyższego poziomu pod punktem (do testu zasłonięcia).
function rootHwndAt(x, y) {
  const h = WindowFromPoint({ x: Math.round(x), y: Math.round(y) });
  if (!h) return 0;
  return Number(GetAncestor(h, 2 /* GA_ROOT */) || h);
}

function windowExists(hwnd) {
  return !!hwnd && IsWindow(hwnd);
}

// Windows blokuje „kradzież fokusu”, gdy ktoś inny niedawno używał klawiatury/myszy.
// Kolejne próby, od najłagodniejszej. Bez triku z ALT — w Electronie/Win32 otwiera pasek menu.
let SwitchToThisWindow = null;
try { SwitchToThisWindow = user32.func('void __stdcall SwitchToThisWindow(intptr_t hwnd, bool altTab)'); } catch { /* ignore */ }

function isForeground(hwnd) { return Number(GetForegroundWindow()) === Number(hwnd); }

function focusWindow(hwnd, { maximize = false } = {}) {
  if (!windowExists(hwnd)) throw new Error(`Okno ${hwnd} nie istnieje`);
  if (IsIconic(hwnd)) ShowWindow(hwnd, 9 /* SW_RESTORE */);
  if (maximize) ShowWindow(hwnd, 3 /* SW_MAXIMIZE */);
  const attempts = [
    () => SetForegroundWindow(hwnd),
    // pusty ruch myszy przez SendInput: nasz proces staje się „ostatnim wejściem” i dostaje prawo do fokusu
    () => { SendInput(1, [mouseInput(0x0001 /* MOVE */)], INPUT_SIZE); SetForegroundWindow(hwnd); },
    () => {
      const fg = GetForegroundWindow();
      const fgThread = fg ? GetWindowThreadProcessId(fg, [0]) : 0;
      const myThread = GetCurrentThreadId();
      const attach = fgThread && fgThread !== myThread;
      if (attach) AttachThreadInput(myThread, fgThread, true);
      try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); } finally { if (attach) AttachThreadInput(myThread, fgThread, false); }
    },
    () => { if (SwitchToThisWindow) SwitchToThisWindow(hwnd, true); },
  ];
  for (const attempt of attempts) {
    try { attempt(); } catch { /* następna metoda */ }
    if (isForeground(hwnd)) return true;
  }
  return false;
}

// Ostateczność: zminimalizuj i przywróć — Windows zawsze aktywuje przywracane okno.
function forceFocusByRestore(hwnd) {
  const wasMax = IsZoomed(hwnd);
  ShowWindow(hwnd, 6 /* SW_MINIMIZE */);
  ShowWindow(hwnd, wasMax ? 3 : 9);
  return isForeground(hwnd);
}

function windowDpi(hwnd) {
  if (!GetDpiForWindow) return GetDpiForSystem();
  return GetDpiForWindow(hwnd) || GetDpiForSystem();
}

function monitorScaleAt(x, y) {
  if (!MonitorFromPoint || !GetDpiForMonitor) return GetDpiForSystem() / 96;
  const hMon = MonitorFromPoint({ x: Math.round(x), y: Math.round(y) }, 2 /* NEAREST */);
  const dx = [0]; const dy = [0];
  if (GetDpiForMonitor(hMon, 0, dx, dy) === 0) return dx[0] / 96;
  return GetDpiForSystem() / 96;
}

// ── SendInput: mysz ───────────────────────────────────────────────────────
const INPUT_SIZE = koffi.sizeof(INPUT);
const MOUSE_FLAGS = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
};

function mouseInput(flags, mouseData = 0) {
  return { type: 0, u: { mi: { dx: 0, dy: 0, mouseData: mouseData >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function mouseButton(button, down) {
  const f = MOUSE_FLAGS[button] || MOUSE_FLAGS.left;
  return SendInput(1, [mouseInput(down ? f.down : f.up)], INPUT_SIZE);
}

// notches > 0 = w górę / w prawo; WHEEL_DELTA = 120 na ząbek kółka
function mouseWheel(notches, horizontal = false) {
  const delta = Math.round(notches * 120);
  return SendInput(1, [mouseInput(horizontal ? 0x01000 : 0x0800, delta)], INPUT_SIZE);
}

// ── SendInput: klawiatura ─────────────────────────────────────────────────
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const EXTENDED_VK = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5]);

function keyInput(vk, up) {
  let flags = up ? KEYEVENTF_KEYUP : 0;
  if (EXTENDED_VK.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
  const scan = MapVirtualKeyW(vk, 0) & 0xffff;
  return { type: 1, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function keyDown(vk) { return SendInput(1, [keyInput(vk, false)], INPUT_SIZE); }
function keyUp(vk) { return SendInput(1, [keyInput(vk, true)], INPUT_SIZE); }
function keyTap(vk) { keyDown(vk); keyUp(vk); }

// Znak Unicode niezależnie od układu klawiatury (ą, ę, ł, emoji, cyrylica...)
function unicodeChar(ch, up) {
  const inputs = [];
  for (let i = 0; i < ch.length; i++) {
    const code = ch.charCodeAt(i);
    inputs.push({ type: 1, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } } });
  }
  return SendInput(inputs.length, inputs, INPUT_SIZE);
}

function vkForChar(ch) {
  const r = VkKeyScanW(ch.charCodeAt(0));
  if (r === -1) return null;
  return { vk: r & 0xff, shift: !!(r & 0x100), ctrl: !!(r & 0x200), alt: !!(r & 0x400) };
}

function isKeyDown(vk) {
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

module.exports = {
  dpiMode,
  systemDpi: () => GetDpiForSystem(),
  getCursor,
  setCursor,
  virtualScreen,
  primaryScreen,
  listMonitors,
  listWindows,
  foregroundWindow,
  windowAt,
  rootHwndAt,
  windowExists,
  windowRect,
  describeWindow,
  focusWindow,
  forceFocusByRestore,
  isForeground,
  windowDpi,
  monitorScaleAt,
  mouseButton,
  mouseWheel,
  keyDown,
  keyUp,
  keyTap,
  unicodeChar,
  vkForChar,
  isKeyDown,
};
