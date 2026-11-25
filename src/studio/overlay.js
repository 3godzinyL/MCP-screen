// Nakładka na cały ekran. Trzy tryby:
//   ai     — przepuszcza mysz; rysuje to, co AI właśnie robi (strefy, ścieżka myszy, kliknięcia, podpis)
//   manual — STARA WERSJA: człowiek przeciąga prostokąt nad każdym przyciskiem i go nazywa (jak bocikmexik)
//   scan   — „tak widzi AI”: ponumerowane strefy wykryte automatycznie; klik w strefę = nazwij ją
const $ = (id) => document.getElementById(id);
const fx = $('fx');
const ctx = fx.getContext('2d');

const TOOL_PL = {
  screen_info: 'sprawdza ekran', list_windows: 'przegląda okna', focus_window: 'przełącza okno', screenshot: 'robi zrzut ekranu',
  zoom: 'przybliża fragment', detect_elements: 'wykrywa elementy', find_text: 'szuka napisu', label_elements: 'nazywa elementy',
  list_elements: 'czyta listę elementów', show_elements: 'pokazuje elementy', locate_element: 'szuka elementu',
  remove_element: 'usuwa element', use_profile: 'wybiera profil', click: 'klika', move_mouse: 'najeżdża myszą', drag: 'przeciąga',
  scroll: 'przewija', type_text: 'pisze', press_keys: 'naciska klawisze', wait: 'czeka', sequence_record: 'nagrywa sekwencję',
  sequence_save: 'zapisuje sekwencję', sequence_list: 'przegląda sekwencje', sequence_run: 'odtwarza sekwencję',
  sequence_delete: 'usuwa sekwencję', settings: 'ustawienia',
};

const state = {
  mode: 'off',
  dpr: window.devicePixelRatio || 1,
  marks: [],          // tryb AI: strefy z ostatniego detect_elements
  marksUntil: 0,
  named: [],          // nazwane elementy (label / highlight)
  namedUntil: 0,
  trails: [],         // ruchy myszy
  ripples: [],        // kliknięcia
  anim: false,
  pending: null,
  manualStart: 0,
  scanFilter: { uia: true, ocr: true, cv: true },
  scanSummary: null,
};

function resize() {
  state.dpr = window.devicePixelRatio || 1;
  fx.width = Math.round(innerWidth * state.dpr);
  fx.height = Math.round(innerHeight * state.dpr);
  fx.style.width = `${innerWidth}px`;
  fx.style.height = `${innerHeight}px`;
  kick();
}
addEventListener('resize', resize);

function clearZones() { document.querySelectorAll('.zone, .mark').forEach((e) => e.remove()); }

function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function zoneEl({ x, y, w, h }, name, sub = '', cls = 'named') {
  const d = document.createElement('div');
  d.className = `zone ${cls}${y < 26 ? ' below' : ''}`;
  Object.assign(d.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  d.innerHTML = `<span class="tag">${esc(name)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  d.dataset.name = name;
  document.body.appendChild(d);
  return d;
}

function sendBar() {
  const r = $('bar').getBoundingClientRect();
  window.mpc.send('overlay:toolbar', { x: Math.floor(r.left - 6), y: Math.floor(r.top - 6), w: Math.ceil(r.width + 12), h: Math.ceil(r.height + 12) });
}

// ── Pasek narzędzi ────────────────────────────────────────────────────────
function setBar(title, info, buttons = []) {
  $('title').innerHTML = title;
  $('info').textContent = info || '';
  const tools = $('tools');
  tools.innerHTML = '';
  for (const b of buttons) {
    if (b.chip) {
      const c = document.createElement('span');
      c.className = `chip ${b.cls || ''}`;
      c.textContent = b.label;
      if (b.onClick) { c.style.cursor = 'pointer'; c.addEventListener('click', b.onClick); }
      tools.appendChild(c);
      continue;
    }
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.cls) btn.className = b.cls;
    if (b.title) btn.title = b.title;
    btn.addEventListener('click', b.onClick);
    tools.appendChild(btn);
    tools.appendChild(document.createTextNode(' '));
  }
  setTimeout(sendBar, 30);
}

function help(text) {
  $('help').textContent = text || '';
  $('help').style.display = text ? 'block' : 'none';
}

$('btn-close').addEventListener('click', () => window.mpc.send('overlay:close'));

// ── Tryb AI: zdarzenia z serwera MCP ──────────────────────────────────────
function caption(html, ms = 4000) {
  const c = $('cap');
  c.innerHTML = html;
  c.style.display = 'block';
  clearTimeout(caption.t);
  caption.t = setTimeout(() => { c.style.display = 'none'; }, ms);
}

function onAiEvent(ev) {
  if (state.mode !== 'ai' && state.mode !== 'observe') return;
  const who = ev.src === 'studio' ? 'Studio' : 'AI';
  switch (ev.type) {
    case 'tool':
      if (ev.status === 'start') {
        const a = ev.args || {};
        const what = a.element ? `„${a.element}”` : a.text ? `„${a.text}”` : a.mark ? `strefa #${a.mark}` : a.keys ? a.keys : a.window ? `„${a.window}”` : a.name ? `„${a.name}”` : '';
        caption(`<span class="who">${who}</span>${esc(TOOL_PL[ev.name] || ev.name)} ${esc(what)}`, 6000);
      } else if (ev.status === 'error') {
        caption(`<span class="who">${who}</span><span style="color:#ff9b9e">${esc(ev.error || 'błąd')}</span>`, 7000);
      } else if (ev.summary && ['detect_elements', 'label_elements', 'find_text', 'sequence_run'].includes(ev.name)) {
        caption(`<span class="who">${who}</span>${esc(TOOL_PL[ev.name] || ev.name)}: ${esc(ev.summary)}`, 5000);
      }
      break;
    case 'detect':
      state.marks = ev.marks || [];
      state.marksUntil = performance.now() + 9000;
      kick();
      break;
    case 'label':
      if (ev.elements) {
        state.named = ev.elements.filter((e) => e.box).map((e) => ({ name: e.name, box: e.box }));
        state.namedUntil = performance.now() + 15000;
        state.marksUntil = Math.min(state.marksUntil, performance.now() + 1500);
        kick();
      }
      break;
    case 'move':
      if (ev.path && ev.path.length > 1) {
        state.trails.push({ path: ev.path, dur: Math.max(120, ev.dry ? Math.min(ev.durationMs || 400, 450) : ev.durationMs || 400), start: performance.now(), dry: ev.dry, method: ev.method });
        if (state.trails.length > 6) state.trails.shift();
        kick();
      }
      break;
    case 'click':
      if (ev.at) { state.ripples.push({ at: ev.at, start: performance.now(), dry: ev.dry, double: ev.double }); kick(); }
      break;
    case 'human-click':
      if (ev.at) { state.ripples.push({ at: ev.at, start: performance.now(), human: true }); kick(); }
      break;
    case 'type':
      caption(`<span class="who">${who}</span>pisze: „${esc(ev.text)}”${ev.dry ? '<span class="dry">próba</span>' : ''}`, 4000);
      break;
    case 'keys':
      caption(`<span class="who">${who}</span>klawisze ${esc(ev.keys)}${ev.dry ? '<span class="dry">próba</span>' : ''}`, 2500);
      break;
    case 'sequence-step':
      if (ev.status === 'start') caption(`<span class="who">Sekwencja</span>${esc(ev.name)} · krok ${ev.i}/${ev.total}: ${esc(ev.label)}${ev.dry ? '<span class="dry">próba</span>' : ''}`, 8000);
      if (ev.status === 'fail') caption(`<span class="who">Sekwencja</span><span style="color:#ff9b9e">krok ${ev.i}: ${esc(ev.error)}</span>`, 9000);
      break;
    case 'stop':
      caption('<span class="who" style="color:#ff9b9e">STOP</span>AI zatrzymana', 6000);
      break;
    default:
      break;
  }
}

function kick() {
  if (state.anim) return;
  state.anim = true;
  requestAnimationFrame(draw);
}

function roundRect(x, y, w, h) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

function draw(now) {
  const d = state.dpr;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  let alive = false;

  // strefy z wykrywania (cienkie, z numerami)
  if (state.marks.length && now < state.marksUntil) {
    alive = true;
    const fade = Math.min(1, (state.marksUntil - now) / 1200);
    ctx.globalAlpha = fade;
    ctx.font = '700 11px "Segoe UI", sans-serif';
    for (const m of state.marks) {
      const col = m.source === 'ocr' ? '#0284c7' : m.source === 'cv' ? '#4f46e5' : '#2563eb';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.6)'; roundRect(m.x, m.y, m.w, m.h); ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.fillStyle = `${col}18`; roundRect(m.x, m.y, m.w, m.h); ctx.fill(); ctx.stroke();
      const label = String(m.id);
      const tw = ctx.measureText(label).width + 6;
      const ly = m.y > 15 ? m.y - 15 : m.y + m.h;
      ctx.fillStyle = col; ctx.fillRect(m.x - 1, ly, tw, 14);
      ctx.fillStyle = '#fff'; ctx.fillText(label, m.x + 2, ly + 11);
    }
    ctx.globalAlpha = 1;
  }

  // nazwane elementy (grube, z nazwą)
  if (state.named.length && now < state.namedUntil) {
    alive = true;
    const fade = Math.min(1, (state.namedUntil - now) / 1500);
    ctx.globalAlpha = fade;
    ctx.font = '700 13px "Segoe UI", sans-serif';
    for (const e of state.named) {
      const b = e.box;
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,.75)'; roundRect(b.x, b.y, b.w, b.h); ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#1d4ed8'; ctx.fillStyle = 'rgba(29,78,216,.16)'; roundRect(b.x, b.y, b.w, b.h); ctx.fill(); ctx.stroke();
      const tw = ctx.measureText(e.name).width + 12;
      const ly = b.y > 22 ? b.y - 22 : b.y + b.h + 2;
      ctx.fillStyle = '#1d4ed8'; ctx.fillRect(b.x - 1, ly, tw, 20);
      ctx.fillStyle = '#fff'; ctx.fillText(e.name, b.x + 5, ly + 15);
    }
    ctx.globalAlpha = 1;
  }

  // ścieżki ruchu myszy
  state.trails = state.trails.filter((t) => now - t.start < t.dur + 2200);
  for (const t of state.trails) {
    alive = true;
    const k = Math.min(1, (now - t.start) / t.dur);
    const n = Math.max(2, Math.round(t.path.length * k));
    const age = Math.max(0, now - t.start - t.dur);
    ctx.globalAlpha = Math.max(0, 1 - age / 2200);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = t.method === 'recorded' ? '#dfbd68' : '#f3f0e8';
    ctx.setLineDash(t.dry ? [6, 5] : []);
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const p = t.path[i]; if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
    ctx.stroke();
    ctx.setLineDash([]);
    const head = t.path[n - 1];
    if (k < 1 || t.dry) {
      // kursor-duch (w trybie próbnym prawdziwy kursor stoi w miejscu)
      ctx.fillStyle = t.dry ? '#9cbcff' : '#dfbd68';
      ctx.beginPath(); ctx.moveTo(head.x, head.y); ctx.lineTo(head.x + 2, head.y + 17); ctx.lineTo(head.x + 6.5, head.y + 12.5); ctx.lineTo(head.x + 13, head.y + 13); ctx.closePath();
      ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // kliknięcia
  state.ripples = state.ripples.filter((r) => now - r.start < 900);
  for (const r of state.ripples) {
    alive = true;
    const k = (now - r.start) / 900;
    const col = r.human ? '#dfbd68' : r.dry ? '#9cbcff' : '#e5484d';
    ctx.globalAlpha = 1 - k;
    ctx.lineWidth = 3;
    ctx.strokeStyle = col;
    ctx.setLineDash(r.dry ? [4, 4] : []);
    ctx.beginPath(); ctx.arc(r.at.x, r.at.y, 8 + 28 * k, 0, Math.PI * 2); ctx.stroke();
    if (r.double) { ctx.beginPath(); ctx.arc(r.at.x, r.at.y, 4 + 16 * k, 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  if (alive) requestAnimationFrame(draw);
  else { state.anim = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
}

// ── Okno „Nazwij element” ─────────────────────────────────────────────────
function ask({ title, sub, suggest = '' }) {
  return new Promise((resolve) => {
    $('ask-title').textContent = title;
    $('ask-sub').textContent = sub || '';
    $('ask-name').value = suggest;
    $('ask-desc').value = '';
    $('ask-err').textContent = '';
    $('ask').style.display = 'flex';
    setTimeout(() => { $('ask-name').focus(); $('ask-name').select(); }, 20);
    const done = (val) => {
      $('ask').style.display = 'none';
      $('ask-ok').onclick = null; $('ask-cancel').onclick = null; $('ask-name').onkeydown = null; $('ask-desc').onkeydown = null;
      resolve(val);
    };
    const ok = () => {
      const name = $('ask-name').value.trim();
      if (!/^[\p{L}\p{N}_\-.]{1,64}$/u.test(name)) { $('ask-err').textContent = 'Same litery, cyfry i _ (bez spacji).'; return; }
      done({ name, description: $('ask-desc').value.trim() });
    };
    $('ask-ok').onclick = ok;
    $('ask-cancel').onclick = () => done(null);
    const key = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') done(null); e.stopPropagation(); };
    $('ask-name').onkeydown = key;
    $('ask-desc').onkeydown = key;
  });
}

function slug(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
}

// ── Tryb ręczny (stara wersja) ────────────────────────────────────────────
const sel = $('sel');
let drag = null;
let manualCount = 0;
let manualTimes = [];

async function loadManual() {
  clearZones();
  const list = await window.mpc.call('manual:list');
  for (const e of list) addManualZone(e);
  manualCount = list.length;
  updateManualBar();
}

function addManualZone(e) {
  const d = zoneEl(e.box, e.name, e.source === 'human' ? 'ręcznie' : e.source && e.source.startsWith('ai') ? 'AI' : '');
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'Usuń';
  del.addEventListener('mousedown', (ev) => ev.stopPropagation());
  del.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    await window.mpc.call('manual:remove', { name: e.name });
    d.remove();
    manualCount--;
    updateManualBar();
  });
  d.appendChild(del);
}

function updateManualBar() {
  const avg = manualTimes.length ? (manualTimes.reduce((a, b) => a + b, 0) / manualTimes.length / 1000).toFixed(1) : '–';
  setBar('<b>Stara wersja</b> · ręczna kalibracja', `Profil „${state.profile}” · ${manualCount} stref · średnio ${avg} s na element (ta sesja)`, [
    { label: 'Rysuj', cls: state.mode === 'manual' ? 'on' : '', onClick: () => window.mpc.send('overlay:mode', 'manual') },
    { label: 'Klikaj w aplikacji', cls: state.mode === 'observe' ? 'on' : '', title: 'Nakładka przepuszcza mysz — np. żeby otworzyć menu', onClick: () => window.mpc.send('overlay:mode', 'observe') },
  ]);
  help(state.mode === 'manual'
    ? 'Przeciągnij prostokąt nad przyciskiem → nadaj nazwę. Esc zamyka. Każdy element trzeba zaznaczyć ręcznie — tak działał bocikmexik.'
    : 'Tryb klikania: obsłuż aplikację (np. otwórz okno dialogowe), potem wróć do „Rysuj”.');
}

document.addEventListener('mousedown', (e) => {
  if (state.mode !== 'manual') return;
  if (e.target.closest('#bar') || e.target.closest('#ask') || e.target.closest('.zone')) return;
  drag = { x: e.clientX, y: e.clientY };
  if (!state.manualStart) state.manualStart = performance.now();
  Object.assign(sel.style, { left: `${e.clientX}px`, top: `${e.clientY}px`, width: '0px', height: '0px', display: 'block' });
});

document.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const x = Math.min(drag.x, e.clientX);
  const y = Math.min(drag.y, e.clientY);
  const w = Math.abs(e.clientX - drag.x);
  const h = Math.abs(e.clientY - drag.y);
  Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  sel.querySelector('.size').textContent = `${Math.round(w * state.dpr)}×${Math.round(h * state.dpr)}`;
});

document.addEventListener('mouseup', async (e) => {
  if (!drag) return;
  const x = Math.min(drag.x, e.clientX);
  const y = Math.min(drag.y, e.clientY);
  const w = Math.abs(e.clientX - drag.x);
  const h = Math.abs(e.clientY - drag.y);
  drag = null;
  if (w < 6 || h < 6) { sel.style.display = 'none'; state.manualStart = 0; return; }
  const ans = await ask({ title: 'Nazwij zaznaczony element', sub: `Prostokąt ${Math.round(w)}×${Math.round(h)} px. Człowiek musi wiedzieć, co to jest — AI zrobiłaby to sama.` });
  sel.style.display = 'none';
  if (!ans) { state.manualStart = 0; return; }
  const ms = Math.round(performance.now() - state.manualStart);
  state.manualStart = 0;
  try {
    const el = await window.mpc.call('manual:save', { name: ans.name, description: ans.description, rect: { x, y, w, h }, ms });
    addManualZone({ ...el, source: 'human' });
    manualCount++;
    manualTimes.push(ms);
    updateManualBar();
  } catch (err) {
    help(`Błąd: ${err.message}`);
  }
});

// ── Tryb skanu („tak widzi AI”) ───────────────────────────────────────────
function renderScan(marks) {
  clearZones();
  for (const m of marks) {
    const d = document.createElement('div');
    d.className = `mark ${m.source}`;
    Object.assign(d.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
    d.title = `#${m.id} ${m.role}${m.text ? ` „${m.text}”` : ''} — kliknij, żeby nazwać`;
    d.innerHTML = `<span class="n">${m.id}</span>`;
    d.dataset.src = m.source;
    d.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ans = await ask({ title: `Strefa #${m.id}`, sub: `${m.role}${m.text ? ` · „${m.text}”` : ''} — wykryta automatycznie (${m.source === 'uia' ? 'UI Automation' : m.source === 'ocr' ? 'OCR' : 'analiza pikseli'}).`, suggest: slug(m.text) || `element_${m.id}` });
      if (!ans) return;
      try {
        const el = await window.mpc.call('scan:name', { id: m.id, name: ans.name, description: ans.description });
        d.classList.add('done');
        zoneEl(el.box, el.name, 'zapisany');
      } catch (err) { help(`Błąd: ${err.message}`); }
    });
    document.body.appendChild(d);
  }
  applyScanFilter();
}

function applyScanFilter() {
  document.querySelectorAll('.mark').forEach((d) => d.classList.toggle('hidden', !state.scanFilter[d.dataset.src]));
}

function scanBar() {
  const s = state.scanSummary || { count: 0, by: {}, ms: 0 };
  const chip = (k, label) => ({
    chip: true, cls: `${k}${state.scanFilter[k] ? '' : ' off'}`, label: `${label} ${s.by[k] || 0}`,
    onClick: () => { state.scanFilter[k] = !state.scanFilter[k]; applyScanFilter(); scanBar(); },
  });
  setBar('<b>Tak widzi AI</b>', `${s.count} stref w ${(s.ms / 1000).toFixed(1)} s — bez klikania przez człowieka`, [
    chip('uia', 'UI Automation'), chip('ocr', 'OCR'), chip('cv', 'piksele'),
  ]);
  help('Każda niebieska strefa to coś, w co AI może kliknąć. Kliknij strefę, żeby nadać jej nazwę (zapisze się jako element). Esc zamyka.');
}

// ── Przełączanie trybów ───────────────────────────────────────────────────
window.mpc.on('overlay:mode', async (p) => {
  state.mode = p.mode;
  state.profile = p.profile;
  document.body.className = p.mode === 'manual' ? 'manual' : p.mode === 'scan' ? 'scan' : '';
  $('cap').style.display = 'none';
  if (p.mode === 'ai') {
    clearZones();
    setBar('<b>AI na żywo</b>', 'Nakładka przepuszcza mysz — widać, co AI wykrywa, nazywa i klika', [
      { label: 'Stara wersja: zaznacz ręcznie', onClick: () => window.mpc.send('overlay:mode', 'manual') },
    ]);
    help('');
  } else if (p.mode === 'manual' || p.mode === 'observe') {
    await loadManual();
  } else if (p.mode === 'scan') {
    state.scanSummary = p.summary;
    state.scanFilter = { uia: true, ocr: true, cv: true };
    renderScan(p.marks || []);
    scanBar();
  }
  resize();
});

window.mpc.on('overlay:event', onAiEvent);

window.mpc.on('overlay:highlight', ({ elements, ms }) => {
  state.named = elements.filter((e) => e.box).map((e) => ({ name: e.name, box: e.box }));
  state.namedUntil = performance.now() + (ms || 5000);
  kick();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('ask').style.display !== 'flex') window.mpc.send('overlay:close');
});

resize();
