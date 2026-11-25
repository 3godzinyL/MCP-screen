// UI Automation Windows — dokładne prostokąty i nazwy kontrolek (przyciski, pola, linki...).
// Działa dla aplikacji Windows i przeglądarek Chromium (Chrome, Brave, Edge), Electron, Office.
// Pytamy każde okno widoczne na zrzucie i odrzucamy kontrolki zasłonięte przez inne okno.
const { workers } = require('../psworker');
const win32 = require('../win32');

const ROLE_PL = {
  Button: 'przycisk', Edit: 'pole', CheckBox: 'pole wyboru', RadioButton: 'opcja', ComboBox: 'lista rozwijana',
  Hyperlink: 'link', ListItem: 'pozycja listy', MenuItem: 'menu', TabItem: 'zakładka', Slider: 'suwak',
  TreeItem: 'gałąź', SplitButton: 'przycisk', Spinner: 'licznik', DataItem: 'komórka', HeaderItem: 'nagłówek',
  Text: 'tekst', Image: 'obraz',
};

const MAX_WINDOWS = 3;

// Okna widoczne w obszarze: próbkujemy siatkę punktów i bierzemy okno najwyższe w każdym punkcie.
function visibleWindows(shot) {
  if (shot.window && shot.window.hwnd && win32.windowExists(shot.window.hwnd)) return [{ hwnd: shot.window.hwnd, hits: 99 }];
  const r = shot.rect;
  const counts = new Map();
  const nx = 8;
  const ny = 6;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = r.x + ((i + 0.5) / nx) * r.w;
      const y = r.y + ((j + 0.5) / ny) * r.h;
      const h = win32.rootHwndAt(x, y);
      if (h) counts.set(h, (counts.get(h) || 0) + 1);
    }
  }
  // pasek zadań i inne cienkie paski u dołu/góry
  for (const y of [r.y + 3, r.y + r.h - 4]) {
    for (let i = 0; i < nx; i++) {
      const h = win32.rootHwndAt(r.x + ((i + 0.5) / nx) * r.w, y);
      if (h && !counts.has(h)) counts.set(h, 1);
    }
  }
  const fg = win32.foregroundWindow();
  const list = [...counts.entries()].map(([hwnd, hits]) => ({ hwnd, hits: hits + (fg && fg.hwnd === hwnd ? 50 : 0) }));
  list.sort((a, b) => b.hits - a.hits);
  return list.slice(0, MAX_WINDOWS);
}

async function uiaShot(shot, { max = 700, timeoutMs = 4500, includeText = false } = {}) {
  if (shot.uia) return shot.uia;
  const t0 = Date.now();
  const wins = visibleWindows(shot);
  const r = shot.rect;
  const items = [];
  const windows = [];
  let truncated = false;
  for (const wv of wins) {
    let res;
    const info = win32.describeWindow(wv.hwnd);
    try {
      res = await workers.uia.call('uia', { hwnd: wv.hwnd, max, timeoutMs, includeText }, timeoutMs + 8000);
      // Chrome/Edge/Brave/Electron budują drzewo dostępności dopiero po pierwszym pytaniu — pytamy drugi raz
      if ((res.items || []).length < 3 && /^Chrome_WidgetWin/.test(info.className)) {
        await new Promise((r) => setTimeout(r, 450));
        res = await workers.uia.call('uia', { hwnd: wv.hwnd, max, timeoutMs, includeText }, timeoutMs + 8000);
      }
    } catch (err) {
      windows.push({ hwnd: wv.hwnd, error: err.message });
      continue;
    }
    windows.push({ hwnd: wv.hwnd, title: info.title, process: info.process, items: (res.items || []).length });
    truncated = truncated || !!res.truncated;
    for (const it of res.items || []) {
      const x0 = Math.max(r.x, Math.round(it.x));
      const y0 = Math.max(r.y, Math.round(it.y));
      const x1 = Math.min(r.x + r.w, Math.round(it.x + it.w));
      const y1 = Math.min(r.y + r.h, Math.round(it.y + it.h));
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      // bardzo duże „przyciski” (cała strona jako link) nie pomagają w celowaniu
      if ((x1 - x0) * (y1 - y0) > 0.35 * r.w * r.h) continue;
      // zasłonięte przez inne okno? (środek kontrolki musi należeć do jej okna)
      if (!shot.window) {
        const top = win32.rootHwndAt((x0 + x1) / 2, (y0 + y1) / 2);
        if (top && top !== wv.hwnd) continue;
      }
      items.push({
        x: x0, y: y0, w: x1 - x0, h: y1 - y0,
        role: it.type, rolePl: ROLE_PL[it.type] || it.type, name: (it.name || '').trim(),
        automationId: it.id || '', enabled: it.enabled !== false, hwnd: wv.hwnd,
      });
    }
  }
  const main = windows.find((w) => !w.error) || null;
  shot.uia = { items, windows, window: main, truncated, ms: Date.now() - t0 };
  return shot.uia;
}

async function elementAtPoint(x, y) {
  return workers.uia.call('element_at', { x, y }, 8000);
}

module.exports = { uiaShot, elementAtPoint, visibleWindows, ROLE_PL };
