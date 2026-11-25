// Łączenie trzech źródeł w jedną listę ponumerowanych stref (Set-of-Mark):
//   UIA (nazwy i typy kontrolek) > piksele (przyciski, pola, ikony) > OCR (napisy).
// AI widzi obraz z numerami i mówi „#12 to przycisk Zapisz” — numer zamienia się w piksele.
const { detectCv, iou } = require('./cv');
const { ocrShot, normalize, similarity } = require('./ocr');
const { uiaShot } = require('./uia');
const win32 = require('../win32');

function centerIn(b, c) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h;
}

function readingOrder(items, rowTol) {
  const sorted = [...items].sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [];
  for (const it of sorted) {
    const cy = it.y + it.h / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) <= rowTol);
    if (row) { row.items.push(it); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; }
    else rows.push({ cy, items: [it] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

// Limit znaczników rozdzielany po obszarach ekranu (siatka 6×4), na zmianę od najlepszych.
// Bez tego 140 kart przeglądarki zjadłoby cały limit, a środek strony zostałby pusty.
function fairPick(list, max, rect) {
  const gx = 6;
  const gy = 4;
  const cells = new Map();
  for (const m of [...list].sort((a, b) => b.score - a.score)) {
    const cx = Math.min(gx - 1, Math.max(0, Math.floor(((m.x + m.w / 2 - rect.x) / rect.w) * gx)));
    const cy = Math.min(gy - 1, Math.max(0, Math.floor(((m.y + m.h / 2 - rect.y) / rect.h) * gy)));
    const key = cy * gx + cx;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(m);
  }
  const queues = [...cells.values()];
  const out = [];
  while (out.length < max) {
    queues.sort((a, b) => (b[0] ? b[0].score : -1) - (a[0] ? a[0].score : -1));
    let took = false;
    for (const q of queues) {
      if (!q.length) continue;
      out.push(q.shift());
      took = true;
      if (out.length >= max) break;
    }
    if (!took) break;
  }
  return out;
}

async function detectElements(shot, { sources = ['uia', 'ocr', 'cv'], maxMarks = 150, query = '', includeText = true } = {}) {
  const t0 = Date.now();
  const scale = win32.monitorScaleAt(shot.rect.x + shot.rect.w / 2, shot.rect.y + shot.rect.h / 2);
  const want = new Set(sources);
  const timings = {};
  const errors = {};

  const jobs = [];
  if (want.has('uia')) {
    jobs.push(uiaShot(shot).then((r) => { timings.uia = r.ms; return r; }).catch((e) => { errors.uia = e.message; return null; }));
  } else jobs.push(Promise.resolve(null));
  if (want.has('ocr')) {
    jobs.push(ocrShot(shot).then((r) => { timings.ocr = r.ms; return r; }).catch((e) => { errors.ocr = e.message; return null; }));
  } else jobs.push(Promise.resolve(null));
  let cv = null;
  if (want.has('cv')) {
    // CV liczy się w tym procesie — puszczamy po wystartowaniu workerów, żeby szły równolegle
    await new Promise((r) => setImmediate(r));
    const res = detectCv(shot.rgba, shot.width, shot.height, { scale });
    timings.cv = res.ms;
    cv = res.items.map((b) => ({ ...b, x: b.x + shot.rect.x, y: b.y + shot.rect.y }));
  }
  const [uia, ocr] = await Promise.all(jobs);

  const marks = [];
  // 1) UIA — najpewniejsze: znamy typ i nazwę
  if (uia) {
    for (const it of uia.items) {
      if (marks.some((m) => iou(m, it) > 0.85)) continue;
      marks.push({ x: it.x, y: it.y, w: it.w, h: it.h, source: 'uia', role: it.role, text: it.name, score: it.name ? 6 : 4.5, enabled: it.enabled });
    }
  }
  // 2) piksele — pojemniki (przyciski, pola), pomijamy duplikaty UIA
  if (cv) {
    for (const c of cv.filter((x) => x.kind !== 'content')) {
      if (marks.some((m) => iou(m, c) > 0.5 || (centerIn(c, m) && c.w * c.h < 1.6 * m.w * m.h && c.w * c.h > 0.4 * m.w * m.h))) continue;
      marks.push({ x: c.x, y: c.y, w: c.w, h: c.h, source: 'cv', role: c.kind === 'field' ? 'pole?' : 'przycisk?', text: '', score: c.score });
    }
  }
  // 3) OCR — napisy dopisujemy do stref, w których leżą; wolne napisy stają się strefami
  if (ocr && includeText) {
    for (const p of ocr.phrases) {
      const host = marks
        .filter((m) => centerIn(p, m) && m.w * m.h >= p.w * p.h * 0.6)
        .sort((a, b) => a.w * a.h - b.w * b.h)[0];
      if (host) {
        if (!host.text) host.text = p.text;
        else if (host.source !== 'uia' && !host.text.includes(p.text) && host.text.length < 60) host.text += ` ${p.text}`;
        // pojemnik z czytelnym napisem to prawie na pewno przycisk/zakładka
        if (host.source === 'cv' && !host.boosted) { host.score += 1.6; host.boosted = true; }
        continue;
      }
      if (p.w < 4 || p.h < 4) continue;
      const letters = (p.text.match(/[\p{L}\p{N}]/gu) || []).length;
      if (letters < 1) continue;
      marks.push({ x: p.x, y: p.y, w: p.w, h: p.h, source: 'ocr', role: 'tekst', text: p.text, score: 3.2 + Math.min(1, letters / 16) });
    }
  }
  // 4) piksele — treść bez ramki (ikony, linki), jeśli nie pokrywa jej nic powyżej
  if (cv) {
    for (const c of cv.filter((x) => x.kind === 'content')) {
      if (marks.some((m) => iou(m, c) > 0.3 || centerIn(c, m))) continue;
      marks.push({ x: c.x, y: c.y, w: c.w, h: c.h, source: 'cv', role: 'ikona/tekst?', text: '', score: c.score });
    }
  }

  let list = marks;
  if (query) {
    const q = normalize(query);
    list = list
      .map((m) => {
        const t = normalize(m.text);
        let s = 0;
        if (t && t === q) s = 1;
        else if (t && t.includes(q)) s = 0.9;
        else if (t) s = similarity(t, q) * 0.85;
        if (normalize(m.role).includes(q)) s = Math.max(s, 0.7);
        return { ...m, match: s };
      })
      .filter((m) => m.match >= 0.6)
      .sort((a, b) => b.match - a.match);
  }

  let truncated = 0;
  if (list.length > maxMarks) {
    truncated = list.length - maxMarks;
    list = query ? list.slice(0, maxMarks) : fairPick(list, maxMarks, shot.rect);
  }
  const ordered = readingOrder(list, Math.max(8, 10 * scale));
  shot.marks = new Map();
  ordered.forEach((m, i) => {
    m.id = i + 1;
    delete m.boosted;
    shot.marks.set(m.id, m);
  });

  // Kontrola zdrowia: UI Automation opisuje okno, a na obrazie nie ma żadnego z jego napisów?
  // Wtedy piksele nie pokazują tego okna (zasłonięte, nieodświeżone) — AI musi to wiedzieć.
  let warning = null;
  if (uia && ocr) {
    const named = uia.items.filter((it) => it.name && it.name.replace(/\W/g, '').length >= 3 && /Button|Text|TabItem|MenuItem|Hyperlink|CheckBox|RadioButton/.test(it.role));
    if (named.length >= 5) {
      const seen = normalize(ocr.phrases.map((p) => p.text).join(' '));
      const hit = named.filter((it) => seen.includes(normalize(it.name).split(' ').slice(0, 2).join(' '))).length;
      if (hit / named.length < 0.15) {
        warning = 'Obraz nie pokazuje treści okna opisanego przez UI Automation (okno zasłonięte albo nieodświeżone). Zrób focus_window(window, maximize=true) albo przesuń okno i wykryj ponownie.';
      }
    }
  }

  return {
    marks: ordered,
    truncated,
    warning,
    timings: { ...timings, total: Date.now() - t0 },
    errors,
    window: uia && uia.window ? { title: uia.window.title, process: uia.window.process } : null,
    windows: uia ? uia.windows : [],
    counts: {
      uia: uia ? uia.items.length : 0,
      cv: cv ? cv.length : 0,
      ocr: ocr ? ocr.phrases.length : 0,
    },
  };
}

module.exports = { detectElements, readingOrder };
