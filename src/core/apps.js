// Aplikacje = profile z „metryczką” programu (proces, tytuł okna, opis pliku) + wiedza + mapy ekranów.
// To jest „plik konfiguracyjny” aplikacji, z którego AI korzysta zamiast oglądać ekran od zera:
//   data/profiles/<app>/elements.json   nazwane elementy (pozycja względem okna, kotwice, wzorce, tożsamość UIA)
//   data/profiles/<app>/wiedza.md       czego AI się nauczyła (ekrany, pułapki, jak osiągnąć cele)
//   data/profiles/<app>/screens/*.json  mapa wszystkich stref każdego poznanego ekranu (+ zrzut .png)
//   data/sequences/*.json               przepisy (sekwencje z celem i zmiennymi) z polem profile = <app>
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const elements = require('./elements');
const win32 = require('./win32');
const { readJson, writeJson, ensureDir, safeName } = require('./json');
const { slug, categoryOf } = require('./categories');
const { normalize } = require('./detect/ocr');

const procInfoCache = new Map();
async function procInfo(pid) {
  if (!pid) return null;
  if (procInfoCache.has(pid)) return procInfoCache.get(pid);
  let info = null;
  try {
    const { workers } = require('./psworker');
    info = await workers.uia.call('proc_info', { pid }, 8000);
  } catch { info = null; }
  procInfoCache.set(pid, info);
  return info;
}

function appMeta(profile) {
  return elements.loadProfile(profile).app || null;
}

function listApps() {
  return elements.listProfiles().map((p) => {
    const d = elements.loadProfile(p.name);
    return { name: p.name, app: d.app || null, elements: p.elements, description: d.description || '' };
  });
}

// Który profil odpowiada temu oknu? Jeśli żaden — zakładamy nowy z nazwą z opisu programu.
const SHELL_CLASSES = { Shell_TrayWnd: 'pasek_zadan', Shell_SecondaryTrayWnd: 'pasek_zadan', Progman: 'pulpit', WorkerW: 'pulpit' };

async function identifyApp(win, { create = true } = {}) {
  if (!win) return null;
  const proc = String(win.process || '').toLowerCase();
  const title = String(win.title || '');
  let candidates = listApps().filter((a) => a.app && String(a.app.process || '').toLowerCase() === proc);
  // pasek zadań i pulpit to osobne „aplikacje”, choć proces jest ten sam co okna folderów
  const shell = SHELL_CLASSES[win.className];
  candidates = candidates.filter((a) => (SHELL_CLASSES[a.app.className] || null) === (shell || null));
  if (shell && candidates.length) return candidates[0].name;
  if (candidates.length === 1 && !candidates[0].app.titleHint) return candidates[0].name;
  if (candidates.length) {
    const hinted = candidates.find((a) => a.app.titleHint && title.toLowerCase().includes(a.app.titleHint.toLowerCase()));
    if (hinted) return hinted.name;
    const generic = candidates.find((a) => !a.app.titleHint);
    if (generic) return generic.name;
  }
  if (!create) return null;
  const info = await procInfo(win.pid);
  let base = shell || slug((info && (info.description || info.product)) || win.process || 'aplikacja', 30) || 'aplikacja';
  // przeglądarki i Electron: jedna „aplikacja” na stronę/program → bierzemy pierwszy człon tytułu
  if (/^(chrome|msedge|brave|firefox|opera|electron)$/i.test(win.process)) {
    const t = slug(title.split(/[—–|-]/)[0], 30);
    if (t) base = t;
  }
  const taken = new Set(elements.listProfiles().map((p) => p.name));
  let name = base;
  let i = 2;
  while (taken.has(name)) name = `${base}_${i++}`;
  const prev = elements.activeProfile();
  elements.setActiveProfile(name);
  const d = elements.loadProfile(name);
  d.app = {
    process: win.process, className: win.className, title,
    titleHint: /^(chrome|msedge|brave|firefox|opera|electron)$/i.test(win.process) ? title.split(/[—–|-]/)[0].trim().slice(0, 60) : '',
    description: (info && info.description) || '', product: (info && info.product) || '',
  };
  d.description = d.description || `${(info && info.description) || win.process} — okno „${title.slice(0, 60)}”`;
  elements.saveProfile(name, d);
  if (prev !== name) elements.setActiveProfile(prev);
  return name;
}

// Okno aplikacji teraz (wg metryczki profilu)
function windowForApp(profile) {
  const meta = appMeta(profile);
  if (!meta || !meta.process) return null;
  let wins = win32.listWindows({ includeUntitled: true, includeTool: true }).filter((w) => w.process.toLowerCase() === meta.process.toLowerCase() && !w.minimized);
  if (meta.className) {
    const same = wins.filter((w) => w.className === meta.className);
    if (same.length || SHELL_CLASSES[meta.className]) wins = same;
  }
  if (!wins.length) return null;
  const hinted = meta.titleHint ? wins.filter((w) => w.title.toLowerCase().includes(meta.titleHint.toLowerCase())) : wins;
  return (hinted.length ? hinted : wins).sort((a, b) => a.z - b.z)[0];
}

// ── Wiedza (markdown) ─────────────────────────────────────────────────────
function knowledgeFile(profile) { return path.join(elements.profileDir(profile), 'wiedza.md'); }

function readKnowledge(profile) {
  try { return fs.readFileSync(knowledgeFile(profile), 'utf8'); } catch { return ''; }
}

// Zapis sekcji „## Tytuł” — nowa sekcja albo podmiana istniejącej o tym samym tytule.
function writeKnowledge(profile, text, section = '') {
  const file = knowledgeFile(profile);
  ensureDir(path.dirname(file));
  let md = readKnowledge(profile);
  if (!md) md = `# ${profile}\n\nWiedza o aplikacji zebrana przez AI i ludzi (MPC Ekran).\n`;
  const body = String(text || '').trim();
  if (section) {
    const head = `## ${section.trim()}`;
    const re = new RegExp(`\\n## ${section.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=\\n## |$)`);
    if (re.test(md)) md = md.replace(re, `\n${head}\n${body}\n`);
    else md = `${md.trimEnd()}\n\n${head}\n${body}\n`;
  } else {
    md = `${md.trimEnd()}\n\n${body}\n`;
  }
  fs.writeFileSync(file, md, 'utf8');
  return md;
}

// ── Mapy ekranów ──────────────────────────────────────────────────────────
function screensDir(profile) { return path.join(elements.profileDir(profile), 'screens'); }

function listScreens(profile) {
  try {
    return fs.readdirSync(screensDir(profile)).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(screensDir(profile), f), null)).filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  } catch {
    return [];
  }
}

function signatureOf(marks) {
  const words = new Set();
  for (const m of marks) {
    for (const w of normalize(m.text || '').split(' ')) if (w.length >= 3 && !/^\d+$/.test(w)) words.add(w);
  }
  return [...words].slice(0, 80);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return A.size + B.size ? inter / (A.size + B.size - inter) : 0;
}

function bestScreen(profile, signature) {
  let best = null;
  for (const s of listScreens(profile)) {
    const j = jaccard(signature, s.signature || []);
    if (!best || j > best.score) best = { screen: s, score: j };
  }
  return best;
}

// Zapisuje mapę ekranu (wszystkie strefy wykryte na zrzucie okna). Ten sam ekran = aktualizacja.
async function saveScreen(profile, shot, marks, { title = '' } = {}) {
  const sig = signatureOf(marks);
  const match = bestScreen(profile, sig);
  const dir = ensureDir(screensDir(profile));
  const rect = shot.rect;
  let id;
  let isNew = false;
  if (match && match.score >= 0.55) {
    id = match.screen.id;
  } else {
    const n = listScreens(profile).length + 1;
    const top = marks.filter((m) => m.text && m.text.length >= 3).sort((a, b) => a.y - b.y)[0];
    id = safeName(`ekran_${n}${top ? `_${slug(top.text, 18)}` : ''}`);
    isNew = true;
  }
  const data = {
    id, profile, title: title || (shot.window && shot.window.title) || '',
    createdAt: isNew ? new Date().toISOString() : (match.screen.createdAt || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    window: { w: rect.w, h: rect.h },
    signature: sig,
    shot: `${id}.png`,
    elements: marks.map((m) => ({
      role: m.role, text: (m.text || '').slice(0, 80), source: m.source, category: categoryOf(m.role),
      rel: { x: m.x - rect.x, y: m.y - rect.y, w: m.w, h: m.h },
    })),
  };
  writeJson(path.join(dir, `${id}.json`), data);
  await sharp(shot.rgba, { raw: { width: shot.width, height: shot.height, channels: 4 } }).png({ compressionLevel: 6 }).toFile(path.join(dir, `${id}.png`));
  return { id, isNew, elements: data.elements.length };
}

// ── Zwarta mapa dla AI (tekst, bez obrazów = mało tokenów) ────────────────
function anchorShort(a) {
  if (!a) return '';
  return `${{ left: 'L', right: 'P', prop: '~' }[a.h] || ''}${{ top: 'G', bottom: 'D', prop: '~' }[a.v] || ''}`;
}

function compactMap(profile, { maxElements = 120, maxKnowledge = 1800 } = {}) {
  const d = elements.loadProfile(profile);
  const win = windowForApp(profile);
  const lines = [];
  const meta = d.app || {};
  lines.push(`APLIKACJA „${profile}”${meta.process ? ` · proces ${meta.process}` : ''}${meta.description ? ` · ${meta.description}` : ''}`);
  if (win) lines.push(`Okno teraz: „${win.title}” x=${win.rect.x} y=${win.rect.y} ${win.rect.w}x${win.rect.h} · skala ${Math.round((win32.windowDpi(win.hwnd) / 96) * 100)}%${win.foreground ? ' · aktywne' : ''}`);
  else lines.push('Okno: nie znaleziono otwartego okna tej aplikacji (uruchom ją albo focus_window).');
  const know = readKnowledge(profile).replace(/^# .*\n+/, '').trim();
  if (know) lines.push(`WIEDZA:\n${know.length > maxKnowledge ? `${know.slice(0, maxKnowledge)}… (pełna: app action=knowledge)` : know}`);
  const els = Object.values(d.elements || {});
  if (els.length) {
    lines.push(`ELEMENTY (${els.length}; x,y względem okna; kotwica L/P/~ G/D/~):`);
    for (const e of els.slice(0, maxElements)) {
      const r = e.window && e.window.rel ? e.window.rel : e.box;
      lines.push(`${e.name} [${e.category || e.kind || '?'}]${e.text ? ` „${e.text.slice(0, 40)}”` : ''}${e.description ? ` — ${e.description.slice(0, 70)}` : ''} @${r.x},${r.y} ${r.w}x${r.h} ${anchorShort(e.window && e.window.anchor)}${e.important ? ' ★' : ''}`);
    }
    if (els.length > maxElements) lines.push(`… i ${els.length - maxElements} więcej (list_elements)`);
  } else {
    lines.push('ELEMENTY: brak — detect_elements(window=…) i label_elements, albo nagraj lekcję w MPC Studio (F9).');
  }
  const screens = listScreens(profile);
  if (screens.length) lines.push(`EKRANY (${screens.length}): ${screens.map((s) => `${s.id} (${s.elements.length} stref)`).join(', ')}`);
  const sequences = require('./sequences');
  const recipes = sequences.list().filter((s) => s.profile === profile);
  if (recipes.length) {
    lines.push(`PRZEPISY (${recipes.length}):`);
    for (const r of recipes) lines.push(`${r.name}(${r.variables.join(',')}) — ${r.goal || r.description || ''} · ${r.steps} kroków${r.runs ? ` · udane ${r.ok || 0}/${r.runs}` : ''}`);
  }
  const lessons = require('./lessons');
  const ls = lessons.list().filter((l) => (l.apps || []).includes(profile));
  if (ls.length) lines.push(`LEKCJE CZŁOWIEKA (${ls.length}): ${ls.map((l) => `${l.name} (${l.steps} kroków${l.goal ? `, cel: ${l.goal.slice(0, 60)}` : ''})`).join('; ')}`);
  return { text: lines.join('\n'), window: win };
}

module.exports = {
  identifyApp, windowForApp, appMeta, listApps, procInfo,
  readKnowledge, writeKnowledge, knowledgeFile,
  listScreens, saveScreen, bestScreen, signatureOf, compactMap, screensDir,
};
