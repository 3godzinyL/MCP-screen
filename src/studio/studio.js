// MPC Studio — interfejs.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const call = (ch, arg) => window.mpc.call(ch, arg);

const TOOL_PL = {
  screen_info: 'Stan ekranu', list_windows: 'Lista okien', focus_window: 'Przełącz okno', screenshot: 'Zrzut ekranu',
  zoom: 'Zbliżenie', detect_elements: 'Wykryj elementy', find_text: 'Znajdź napis', label_elements: 'Nazwij elementy',
  list_elements: 'Lista elementów', show_elements: 'Pokaż elementy', locate_element: 'Znajdź element', remove_element: 'Usuń element',
  use_profile: 'Profil', click: 'Kliknij', move_mouse: 'Najedź', drag: 'Przeciągnij', scroll: 'Przewiń', type_text: 'Wpisz tekst',
  press_keys: 'Klawisze', wait: 'Czekaj', sequence_record: 'Nagrywanie sekwencji', sequence_save: 'Zapisz sekwencję',
  sequence_list: 'Sekwencje', sequence_run: 'Uruchom sekwencję', sequence_delete: 'Usuń sekwencję', settings: 'Ustawienia',
};

const TOOL_GROUPS = [
  ['Obserwacja', [
    ['screen_info', 'monitory, skala DPI, aktywne okno, tryb, profil'],
    ['list_windows', 'okna widoczne na pasku zadań'],
    ['focus_window', 'wyciąga okno na wierzch'],
    ['screenshot', 'zrzut ekranu/okna z id i mapowaniem pikseli, opcjonalnie siatka'],
    ['zoom', 'ostre zbliżenie fragmentu do precyzyjnego celowania'],
    ['detect_elements', 'ponumerowane niebieskie strefy: UI Automation + OCR + piksele'],
    ['find_text', 'szuka napisu na ekranie (OCR po polsku i angielsku)'],
  ]],
  ['Elementy (niebieskie strefy)', [
    ['label_elements', 'zapisuje strefy pod nazwami — wycinek, okno, podgląd'],
    ['list_elements', 'lista elementów profilu'],
    ['show_elements', 'zrzut ze wszystkimi elementami na niebiesko'],
    ['locate_element', 'odnajduje element po wyglądzie, gdy okno się przesunęło'],
    ['remove_element', 'usuwa albo zmienia nazwę'],
    ['use_profile', 'profil = jedna aplikacja'],
  ]],
  ['Działanie (jak człowiek)', [
    ['click', 'ruch nagrany od człowieka + klik; weryfikacja zmiany ekranu'],
    ['move_mouse', 'najechanie bez klikania'],
    ['drag', 'przeciąganie (suwaki, przenoszenie)'],
    ['scroll', 'kółko myszy'],
    ['type_text', 'pisanie z naturalnym rytmem, polskie litery'],
    ['press_keys', 'skróty: Ctrl+S, Alt+F4, Enter…'],
    ['wait', 'czas, pojawienie się napisu/elementu, uspokojenie ekranu'],
  ]],
  ['Sekwencje', [
    ['sequence_record', 'nagrywa działania AI jako sekwencję'],
    ['sequence_save', 'zapis kroków ze zmiennymi {{…}}'],
    ['sequence_list', 'lista i szczegóły'],
    ['sequence_run', 'odtwarzanie z raportem kroków (też próbnie)'],
    ['sequence_delete', 'usuwa sekwencję'],
    ['settings', 'tryb próbny, rodzaj ruchu, tempo, OCR'],
  ]],
];

let S = null; // stan z procesu głównego
let elFilter = 'all';
let elSearch = '';
let selectedSeq = null;
const session = { tools: 0, clicks: 0, labeled: 0, errors: 0 };

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'bad' : '';
  t.style.display = 'block';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.style.display = 'none'; }, bad ? 7000 : 4000);
}

async function safe(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; } catch (e) { toast(e.message, true); return null; }
}

// ── Nawigacja ─────────────────────────────────────────────────────────────
function go(page) {
  document.querySelectorAll('nav#side button[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'elements') loadElements();
  if (page === 'sequences') loadSequences();
  if (page === 'paths') loadRecordings();
  try { localStorage.setItem('mpc-page', page); } catch { /* ignore */ }
}
document.querySelectorAll('nav#side button[data-page]').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));
document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

// ── Stan ──────────────────────────────────────────────────────────────────
async function refresh() {
  S = await call('state');
  $('ver').textContent = `v${S.version}`;
  const m = S.mcp || {};
  const st = $('mcp-status');
  st.querySelector('.led').classList.toggle('on', !!m.connected);
  st.querySelector('span:last-child').textContent = m.connected
    ? `AI połączone${m.client && m.client.name ? ` · ${m.client.name}` : ''}${m.calls ? ` · ${m.calls} wywołań` : ''}`
    : 'AI: brak połączenia';
  document.querySelectorAll('#mode-seg button').forEach((b) => {
    const on = (b.dataset.dry === '1') === !!S.settings.dryRun;
    b.classList.toggle('on', on);
    b.classList.toggle('dry', on && b.dataset.dry === '1');
  });
  const sel = $('profile-select');
  const names = S.profiles.map((p) => p.name);
  if (!names.includes(S.profile)) names.unshift(S.profile);
  sel.innerHTML = names.map((n) => {
    const p = S.profiles.find((x) => x.name === n);
    return `<option value="${esc(n)}" ${n === S.profile ? 'selected' : ''}>${esc(n)}${p ? ` (${p.elements})` : ''}</option>`;
  }).join('');
  const stopped = S.control.stop;
  $('stop').textContent = stopped ? 'WZNÓW' : 'STOP';
  $('stop').classList.toggle('resume', !!stopped);
  $('stop').title = stopped ? `Zatrzymane: ${S.control.reason || ''}. Kliknij, żeby AI mogła działać dalej.` : 'Zatrzymaj AI (klawisz Pause albo Ctrl+Shift+F12)';
  const prof = S.profiles.find((p) => p.name === S.profile);
  $('nav-el').textContent = prof ? prof.elements : '';
  $('nav-seq').textContent = S.sequences.length || '';
  $('nav-rec').textContent = S.recordings.length || '';
  $('btn-import-bocik').style.display = S.bocikAvailable ? '' : 'none';
  $('set-motion').value = S.settings.motion;
  $('set-speed').value = S.settings.speed;
  $('set-speed-v').textContent = `×${S.settings.speed}`;
  $('set-noise').value = S.settings.noisePx;
  $('set-noise-v').textContent = S.settings.noisePx;
  await updateNumbers();
}

async function updateNumbers() {
  // liczby na stronie Pokaz — tylko z prawdziwych danych tego komputera
  const st = await call('stats');
  $('n-manual').textContent = st.manual;
  $('n-manual-avg').textContent = st.manualMs.length ? (st.manualMs.reduce((a, b) => a + b, 0) / st.manualMs.length / 1000).toFixed(1) : '–';
  $('n-ai').textContent = st.ai;
  $('n-human-seq').textContent = S.sequences.filter((s) => s.createdBy === 'human').length;
}

$('mode-seg').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  await safe(() => call('settings:set', { dryRun: b.dataset.dry === '1' }), b.dataset.dry === '1' ? 'Tryb próbny: AI planuje i rysuje, ale nic nie klika.' : 'Tryb na żywo: AI naprawdę klika.');
  refresh();
});
$('profile-select').addEventListener('change', async (e) => { await safe(() => call('profile:set', { name: e.target.value })); refresh(); if (isPage('elements')) loadElements(); });
$('stop').addEventListener('click', async () => {
  if (S && S.control.stop) await safe(() => call('control:resume'), 'Wznowiono — AI może działać.');
  else await safe(() => call('control:stop'), 'STOP — wszystkie akcje AI zablokowane do „Wznów”.');
  refresh();
});
$('open-data').addEventListener('click', () => call('open:data'));

function isPage(p) { return $(`page-${p}`).classList.contains('active'); }

// ── Akcje wspólne (przyciski data-act) ────────────────────────────────────
const ACTS = {
  manual: () => call('overlay:set', { mode: 'manual' }),
  scan: async () => {
    toast('Skanuję ekran… (Studio na chwilę się schowa)');
    const r = await call('scan:run', {});
    $('n-scan').textContent = r.count;
    $('n-scan-ms').textContent = (r.ms / 1000).toFixed(1);
    try { localStorage.setItem('mpc-scan', JSON.stringify({ count: r.count, ms: r.ms })); } catch { /* ignore */ }
  },
  demo: () => call('demo:open'),
  'ai-launch': () => call('ai:launch').then(() => toast('Otwieram terminal z Claude i serwerem MCP…')),
  'rec-path': () => call('recorder:prepare', { mode: 'path' }),
  'rec-seq': () => call('recorder:prepare', { mode: 'sequence' }),
  'import-bocik': async () => { const r = await call('import:bocik'); toast(`Wczytano ${r.count} stref z bocikmexik do profilu „${r.profile}” (bez wzorców — współrzędne na sztywno).`); refresh(); },
  'open-root': () => call('open:root'),
  'copy-prompt': async () => { await call('clipboard', { text: PROMPTS[0] }); toast('Skopiowano polecenie dla Claude.'); },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (b && ACTS[b.dataset.act]) safe(ACTS[b.dataset.act]);
  const c = e.target.closest('[data-copy]');
  if (c) safe(() => call('clipboard', { text: $(c.dataset.copy).textContent }), 'Skopiowano.');
});

// ── AI na żywo ────────────────────────────────────────────────────────────
const calls = [];      // wywołania narzędzi (start+koniec scalone)
let selectedCall = null;
let seqView = null;

function shotUrl(file, ts) {
  if (!file) return null;
  const base = String(file).split(/[\\/]/).pop();
  return `mpc://data/shots/${encodeURIComponent(base)}?t=${ts || Date.now()}`;
}

function argsText(a) {
  if (!a) return '';
  const parts = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  return parts.join(' · ').slice(0, 160);
}

function onEvent(ev, { quiet = false } = {}) {
  if (ev.type === 'tool') {
    if (ev.status === 'start') {
      calls.unshift({ key: `${ev.pid}-${ev.n}`, pid: ev.pid, name: ev.name, args: ev.args, ts: ev.ts, status: 'run', src: ev.src });
      if (calls.length > 300) calls.pop();
      if (!quiet) { session.tools++; $('live-now').innerHTML = `<b>AI</b> · ${esc(TOOL_PL[ev.name] || ev.name)} ${esc(argsText(ev.args))}`; }
    } else {
      const c = calls.find((x) => x.pid === ev.pid && x.name === ev.name && x.status === 'run');
      if (c) {
        c.status = ev.status === 'ok' ? 'ok' : 'err';
        c.ms = ev.ms; c.summary = ev.summary; c.error = ev.error; c.image = ev.image; c.shot = ev.shot; c.endTs = ev.ts;
        if (!quiet && c.image) showCall(c);
        if (!quiet && ev.status === 'error') { session.errors++; $('live-now').innerHTML = `<b>AI</b> · ${esc(TOOL_PL[ev.name] || ev.name)}: <span style="color:var(--red-2)">${esc(ev.error)}</span>`; }
        if (!quiet && ev.name === 'click' && ev.status === 'ok') session.clicks++;
      }
    }
    renderTimeline();
  } else if (ev.type === 'label' && ev.elements) {
    if (!quiet) session.labeled += ev.elements.length;
    $('live-named').innerHTML = ev.elements.slice(0, 30).map((e) => `<span class="chip blue">${esc(e.name)}</span>`).join('') || '<span class="muted">—</span>';
  } else if (ev.type === 'scan' && !quiet) {
    $('n-scan').textContent = ev.count;
    $('n-scan-ms').textContent = (ev.ms / 1000).toFixed(1);
    showImage(ev.image, ev.ts, `Skan Studia: ${ev.count} stref w ${(ev.ms / 1000).toFixed(1)} s`);
  } else if (ev.type === 'sequence-start') {
    seqView = { name: ev.name, steps: [], total: ev.steps, dry: ev.dry };
    renderSeq();
  } else if (ev.type === 'sequence-step') {
    if (!seqView || seqView.name !== ev.name) seqView = { name: ev.name, steps: [], total: ev.total };
    seqView.steps[ev.i - 1] = { label: ev.label, status: ev.status === 'start' ? 'run' : ev.status, error: ev.error };
    renderSeq();
    if (isPage('sequences') && selectedSeq === ev.name) markSeqStep(ev);
  } else if (ev.type === 'sequence-end') {
    if (seqView) { seqView.done = ev.ok ? 'ok' : 'fail'; seqView.ms = ev.ms; renderSeq(); }
    if (!quiet) { refresh(); if (isPage('sequences')) loadSequences(); }
  } else if (ev.type === 'sequence-record') {
    $('live-rec').innerHTML = ev.status === 'start' ? `nagrywa <b>${esc(ev.name)}</b>`
      : ev.status === 'step' ? `nagrywa <b>${esc(ev.name)}</b> · krok ${ev.i}: ${esc(ev.label)}`
        : ev.status === 'stop' ? `zapisano <b>${esc(ev.name)}</b> (${ev.steps} kroków)` : 'anulowano';
  } else if ((ev.type === 'connect' || ev.type === 'server-start' || ev.type === 'server-stop' || ev.type === 'stop' || ev.type === 'resume' || ev.type === 'human-record' || ev.type === 'sequence-saved' || ev.type === 'profile') && !quiet) {
    refresh();
  }
  $('live-stats').innerHTML = `wywołań: ${session.tools}<br/>kliknięć: ${session.clicks}<br/>nazwanych elementów: ${session.labeled}<br/>błędów: ${session.errors}`;
  $('nav-live').textContent = calls.filter((c) => c.status === 'run').length ? '●' : '';
}

function renderSeq() {
  if (!seqView) return;
  const items = [];
  for (let i = 0; i < seqView.total; i++) {
    const s = seqView.steps[i];
    items.push(`<li class="${s ? s.status : ''}">${i + 1}. ${esc(s ? s.label : '…')}${s && s.error ? ` — ${esc(s.error)}` : ''}</li>`);
  }
  $('live-seq').innerHTML = `<div style="margin-bottom:6px"><b>${esc(seqView.name)}</b>${seqView.dry ? ' <span class="chip blue">próba</span>' : ''}${seqView.done ? ` · ${seqView.done === 'ok' ? '<span class="ok-t">OK</span>' : '<span class="bad-t">przerwana</span>'} ${(seqView.ms / 1000).toFixed(1)} s` : ''}</div><ul class="seqsteps">${items.join('')}</ul>`;
}

function renderTimeline() {
  const html = calls.slice(0, 160).map((c) => {
    const ic = c.status === 'run' ? 'run' : c.status === 'ok' ? (c.src === 'studio' ? 'studio' : 'ok') : 'err';
    const time = new Date(c.ts).toLocaleTimeString('pl-PL');
    return `<div class="ev ${selectedCall === c.key ? 'sel' : ''}" data-key="${c.key}"><span class="ic ${ic}"></span>` +
      `<div><div class="t">${esc(TOOL_PL[c.name] || c.name)}${c.image ? '<span class="img-dot" title="ma obraz"></span>' : ''}</div>` +
      `<div class="a">${esc(c.error || c.summary || argsText(c.args))}</div></div>` +
      `<span class="m">${time}${c.ms !== undefined ? `<br/>${c.ms} ms` : ''}</span></div>`;
  }).join('');
  $('timeline').innerHTML = html || '<div class="ev"><span></span><div class="a">Brak wywołań. Gdy AI użyje narzędzi MPC, pojawią się tutaj.</div><span></span></div>';
}

function showImage(file, ts, caption) {
  const url = shotUrl(file, ts);
  if (!url) return;
  $('viewer-img').innerHTML = `<img src="${url}" alt="" />`;
  $('viewer-cap').textContent = caption || '';
}

function showCall(c) {
  selectedCall = c.key;
  showImage(c.image, c.endTs || c.ts, `${TOOL_PL[c.name] || c.name}${c.shot ? ` · ${c.shot}` : ''} · ${c.summary || ''}`);
  renderTimeline();
}

$('timeline').addEventListener('click', (e) => {
  const row = e.target.closest('.ev');
  if (!row) return;
  const c = calls.find((x) => x.key === row.dataset.key);
  if (!c) return;
  if (c.image) showCall(c);
  else { selectedCall = c.key; renderTimeline(); $('viewer-cap').textContent = `${TOOL_PL[c.name] || c.name}: ${c.error || c.summary || argsText(c.args)}`; }
});
$('live-clear').addEventListener('click', () => { calls.length = 0; renderTimeline(); });
$('live-overlay').addEventListener('change', (e) => safe(() => call('overlay:set', { mode: e.target.checked ? 'ai' : 'off' })));
window.mpc.on('overlay-mode', (m) => { $('live-overlay').checked = m === 'ai'; });

// ── Elementy ──────────────────────────────────────────────────────────────
function srcClass(s) {
  if (!s) return '';
  if (s.startsWith('ai')) return 'ai';
  if (s.startsWith('human')) return 'human';
  return '';
}
function srcLabel(s) {
  return { 'ai-mark': 'AI · strefa', 'ai-box': 'AI · ramka', 'ai-record': 'AI · nagranie', human: 'człowiek', 'human-scan': 'człowiek · skan', 'human-record': 'człowiek · nagranie', bocikmexik: 'import bocikmexik' }[s] || s || '—';
}

async function loadElements() {
  const list = await call('elements:list', { profile: S ? S.profile : undefined });
  const q = elSearch.toLowerCase();
  const filtered = list.filter((e) => {
    const cls = srcClass(e.source);
    if (elFilter === 'ai' && cls !== 'ai') return false;
    if (elFilter === 'human' && cls !== 'human') return false;
    if (elFilter === 'import' && cls !== '') return false;
    if (q && !`${e.name} ${e.description} ${e.text}`.toLowerCase().includes(q)) return false;
    return true;
  });
  $('el-sub').textContent = `profil „${S ? S.profile : ''}” · ${list.length} elementów`;
  if (!list.length) {
    $('el-grid').innerHTML = `<div class="empty-box" style="grid-column:1/-1">Ten profil jest pusty.<br/>Zaznacz elementy ręcznie (stara wersja), zrób skan AI i kliknij strefy, albo poproś Claude: „wykryj elementy w oknie … i nazwij je”.</div>`;
    return;
  }
  $('el-grid').innerHTML = filtered.map((e) => {
    const seen = e.lastSeen ? (e.lastSeen.found === false ? '<span class="seen-bad">ostatnio nie znaleziony</span>' : `znaleziony ${e.lastSeen.method === 'saved' ? 'przy zapisie' : `(${e.lastSeen.method}${e.lastSeen.score ? ` ${e.lastSeen.score}` : ''})`}`) : '';
    return `<div class="el" data-name="${esc(e.name)}">
      <div class="crop">${e.crop ? `<img src="${e.crop}" alt="" />` : '<span class="none">bez wycinka — stare współrzędne na sztywno</span>'}</div>
      <div class="body">
        <div class="row" style="justify-content:space-between"><span class="name">${esc(e.name)}</span><span class="src ${srcClass(e.source)}">${esc(srcLabel(e.source))}</span></div>
        <div class="desc" contenteditable="true" spellcheck="false" data-desc="${esc(e.name)}">${esc(e.description || '')}</div>
        <div class="meta">${e.kind ? `${esc(e.kind)} · ` : ''}${e.text ? `„${esc(e.text.slice(0, 40))}” · ` : ''}x ${e.box.x} y ${e.box.y} · ${e.box.w}×${e.box.h}${e.window ? ` · ${esc(e.window.process)}` : ''}${e.manualMs ? ` · ${(e.manualMs / 1000).toFixed(1)} s ręcznie` : ''}</div>
        <div class="meta">${seen}${e.uses ? ` · użyty ${e.uses}×` : ''}</div>
      </div>
      <div class="acts"><button class="btn small blue" data-el="locate">Pokaż na ekranie</button><button class="btn small" data-el="rename">Zmień nazwę</button><button class="btn small red" data-el="remove">Usuń</button></div>
    </div>`;
  }).join('') || '<div class="empty-box" style="grid-column:1/-1">Nic nie pasuje do filtra.</div>';
  // małe przyciski (np. 28×28) powiększamy, żeby było widać, co AI wycięła
  document.querySelectorAll('#el-grid .crop img').forEach((img) => {
    const fit = () => {
      const k = Math.min(3, 80 / img.naturalHeight, 220 / img.naturalWidth);
      if (k > 1) { img.style.width = `${Math.round(img.naturalWidth * k)}px`; img.style.imageRendering = 'pixelated'; }
    };
    if (img.complete) fit(); else img.addEventListener('load', fit);
  });
}

$('el-grid').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-el]');
  if (!b) return;
  const name = b.closest('.el').dataset.name;
  if (b.dataset.el === 'locate') await safe(() => call('elements:locate', { name }), (r) => `„${name}”: ${r.score !== null && r.score !== undefined ? `dopasowanie ${r.score}` : 'zapisane współrzędne'}${r.moved ? ' — element był przesunięty' : ''}`);
  if (b.dataset.el === 'remove') { await safe(() => call('elements:remove', { name }), `Usunięto ${name}`); loadElements(); refresh(); }
  if (b.dataset.el === 'rename') {
    const card = b.closest('.el');
    const nameEl = card.querySelector('.name');
    const input = document.createElement('input');
    input.value = name;
    input.style.cssText = 'background:var(--bg);border:1px solid var(--gold);border-radius:6px;padding:3px 6px;width:100%';
    nameEl.replaceWith(input);
    input.focus(); input.select();
    const done = async (save) => {
      if (save && input.value.trim() && input.value.trim() !== name) await safe(() => call('elements:rename', { name, to: input.value.trim() }), 'Zmieniono nazwę.');
      loadElements();
    };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  }
});
$('el-grid').addEventListener('focusout', async (e) => {
  const d = e.target.closest('[data-desc]');
  if (!d) return;
  await safe(() => call('elements:describe', { name: d.dataset.desc, description: d.textContent.trim() }));
});
$('el-grid').addEventListener('keydown', (e) => { if (e.target.closest('[data-desc]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('el-search').addEventListener('input', (e) => { elSearch = e.target.value; loadElements(); });
document.querySelectorAll('.filters .f').forEach((b) => b.addEventListener('click', () => {
  elFilter = b.dataset.src;
  document.querySelectorAll('.filters .f').forEach((x) => x.classList.toggle('on', x === b));
  loadElements();
}));
$('btn-show-all').addEventListener('click', () => safe(() => call('elements:showAll', {}), (r) => `Na ekranie: ${r.shown}${r.missing.length ? ` · nie znaleziono: ${r.missing.join(', ')}` : ''}`));
$('btn-new-profile').addEventListener('click', async () => {
  const name = $('new-profile').value.trim();
  if (!name) return;
  await safe(() => call('profile:set', { name }), `Profil „${name}” aktywny.`);
  $('new-profile').value = '';
  await refresh();
  loadElements();
});

// ── Sekwencje ─────────────────────────────────────────────────────────────
async function loadSequences() {
  const list = await call('sequences:list');
  $('seq-list').innerHTML = list.map((s) => `<div class="it ${selectedSeq === s.name ? 'sel' : ''}" data-seq="${esc(s.name)}">
    <div class="row" style="justify-content:space-between"><span class="n">${esc(s.name)}</span><span class="badge ${s.createdBy === 'human' ? 'human' : 'ai'}">${s.createdBy === 'human' ? 'człowiek' : 'AI'}</span></div>
    <div class="s">${s.steps} kroków${s.variables.length ? ` · zmienne: ${esc(s.variables.join(', '))}` : ''}${s.runs ? ` · uruchomień ${s.runs}` : ''}</div></div>`).join('') ||
    '<div class="it"><span class="muted">Brak sekwencji. Nagraj je albo poproś AI (sequence_record).</span></div>';
  if (selectedSeq && list.some((s) => s.name === selectedSeq)) showSequence(selectedSeq);
}

async function showSequence(name) {
  selectedSeq = name;
  document.querySelectorAll('#seq-list .it').forEach((x) => x.classList.toggle('sel', x.dataset.seq === name));
  const s = await call('sequences:get', { name });
  const vars = Object.entries(s.variables || {});
  const used = new Set();
  JSON.stringify(s.steps).replace(/\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu, (m, k) => used.add(k));
  for (const k of used) if (!vars.some(([n]) => n === k)) vars.push([k, '']);
  $('seq-detail').innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(s.name)}</h2><span class="badge ${s.createdBy === 'human' ? 'human' : 'ai'}">${s.createdBy === 'human' ? 'nagrana przez człowieka' : 'zrobiona przez AI'}</span></div>
    <textarea class="desc-edit" id="seq-desc" placeholder="Opis sekwencji">${esc(s.description || '')}</textarea>
    <div class="muted" style="font-size:12px">profil ${esc(s.profile)} · uruchomień ${s.stats ? s.stats.runs : 0}, udanych ${s.stats ? s.stats.ok : 0}${s.stats && s.stats.lastRun ? ` · ostatnio ${new Date(s.stats.lastRun).toLocaleString('pl-PL')}` : ''}</div>
    ${vars.length ? `<div class="vars">${vars.map(([k, v]) => `<label>{{${esc(k)}}}<input data-var="${esc(k)}" value="${esc(v)}" /></label>`).join('')}</div>` : '<div style="height:12px"></div>'}
    <div class="row" style="margin-bottom:12px">
      <button class="btn blue" id="seq-dry">Próba (bez klikania)</button>
      <button class="btn gold" id="seq-run">Uruchom naprawdę</button>
      <button class="btn small" id="seq-save">Zapisz opis i zmienne</button>
      <span class="grow"></span>
      <button class="btn small red" id="seq-del">Usuń</button>
    </div>
    <ol class="st" id="seq-steps">${s.steps.map((st, i) => `<li data-i="${i + 1}"><span class="lbl">${esc(stepLabel(st))}</span><span class="raw" title="${esc(JSON.stringify(st))}">${esc(JSON.stringify(st))}</span></li>`).join('')}</ol>
    <div class="result" id="seq-result"></div>`;
  const varsNow = () => Object.fromEntries([...document.querySelectorAll('[data-var]')].map((i) => [i.dataset.var, i.value]));
  $('seq-dry').onclick = () => runSeq(name, varsNow(), true);
  $('seq-run').onclick = () => {
    if (!confirm(`Uruchomić „${name}” naprawdę? Mysz i klawiatura zaczną działać. STOP: klawisz Pause albo kursor w lewy górny róg.`)) return;
    runSeq(name, varsNow(), false);
  };
  $('seq-save').onclick = () => safe(() => call('sequences:update', { name, description: $('seq-desc').value, variables: varsNow() }), 'Zapisano.');
  $('seq-del').onclick = async () => {
    if (!confirm(`Usunąć sekwencję „${name}”?`)) return;
    await safe(() => call('sequences:delete', { name }), 'Usunięto.');
    selectedSeq = null;
    $('seq-detail').innerHTML = '<span class="muted">Wybierz sekwencję z listy.</span>';
    loadSequences(); refresh();
  };
}

function stepLabel(s) {
  const t = s.element ? `„${s.element}”` : s.text_target ? `napis „${s.text_target}”` : (s.action !== 'type' && s.text) ? `napis „${s.text}”` : s.x !== undefined ? `(${s.x}, ${s.y})` : '';
  switch (s.action) {
    case 'click': return `${s.double ? 'Dwuklik' : 'Klik'} ${t}`;
    case 'type': return `Wpisz „${String(s.text).slice(0, 40)}”${t ? ` w ${t}` : ''}${s.enter ? ' + Enter' : ''}`;
    case 'keys': return `Klawisze ${s.keys}`;
    case 'wait': return `Czekaj ${s.ms} ms`;
    case 'wait_for': return `Czekaj na ${t}${s.gone ? ' (zniknięcie)' : ''}`;
    case 'focus': return `Okno „${s.window}”`;
    case 'run': return `Sekwencja ${s.sequence}`;
    case 'scroll': return `Przewiń ${s.direction || 'down'} ×${s.amount || 3}`;
    default: return `${s.action} ${t}`;
  }
}

function markSeqStep(ev) {
  const li = document.querySelector(`#seq-steps li[data-i="${ev.i}"]`);
  if (!li) return;
  li.classList.remove('run', 'ok', 'fail');
  li.classList.add(ev.status === 'start' ? 'run' : ev.status);
}

async function runSeq(name, variables, dry) {
  document.querySelectorAll('#seq-steps li').forEach((li) => li.classList.remove('run', 'ok', 'fail'));
  $('seq-result').className = 'result';
  $('seq-result').textContent = dry ? 'Próba w toku — zobacz nakładkę na ekranie…' : 'Działa…';
  const r = await safe(() => call('sequences:run', { name, variables, dry }));
  if (!r) { $('seq-result').textContent = ''; return; }
  $('seq-result').className = `result ${r.ok ? 'ok' : 'bad'}`;
  $('seq-result').innerHTML = r.ok ? `${dry ? 'Próba' : 'Sekwencja'} zakończona w ${(r.ms / 1000).toFixed(1)} s.` : `Przerwana na kroku ${r.failedStep}: ${esc((r.steps.find((s) => !s.ok) || {}).error || '')}`;
}

$('seq-list').addEventListener('click', (e) => { const it = e.target.closest('[data-seq]'); if (it) showSequence(it.dataset.seq); });

// ── Ruchy myszy ───────────────────────────────────────────────────────────
let recs = [];
let selRec = null;
let pick = [];
let preview = null;

async function loadRecordings() {
  recs = await call('recordings:list');
  $('rec-list').innerHTML = recs.map((r) => `<div class="it ${selRec === r.name ? 'sel' : ''}" data-rec="${esc(r.name)}">
    <div class="row" style="justify-content:space-between"><span class="n">${esc(r.name)}</span><button class="btn small red" data-del-rec="${esc(r.name)}">Usuń</button></div>
    <div class="s">${r.len} px · ${r.duration} ms · ${r.source === 'human-sequence' ? 'z sekwencji' : r.source === 'human' ? 'nagrany' : esc(r.source)}</div></div>`).join('') ||
    '<div class="it"><span class="muted">Brak nagrań. Nagraj kilka ruchów (krótkie, średnie, długie, w różne strony) — AI będzie ich używać.</span></div>';
  drawPaths();
}

$('rec-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-rec]');
  if (del) { e.stopPropagation(); await safe(() => call('recordings:delete', { name: del.dataset.delRec }), 'Usunięto nagranie.'); loadRecordings(); refresh(); return; }
  const it = e.target.closest('[data-rec]');
  if (it) { selRec = it.dataset.rec; preview = null; pick = []; loadRecordings(); }
});

function drawPaths() {
  const cv = $('paths-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#16181d'; g.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const screenW = (S && S.monitors && S.monitors[0] && S.monitors[0].w) || 1920;
  const screenH = (S && S.monitors && S.monitors[0] && S.monitors[0].h) || 1080;
  const k = Math.min(W / screenW, H / screenH);
  const ox = (W - screenW * k) / 2;
  const oy = (H - screenH * k) / 2;
  const P = (p) => [ox + p.x * k, oy + p.y * k];
  g.strokeStyle = '#262a32'; g.strokeRect(ox, oy, screenW * k, screenH * k);
  const line = (pts, color, width, dash = []) => {
    if (!pts || pts.length < 2) return;
    g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash);
    g.beginPath();
    pts.forEach((p, i) => { const [x, y] = P(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke(); g.setLineDash([]);
  };
  for (const r of recs) line(r.samples, r.name === selRec ? '#8a8270' : '#2c3038', r.name === selRec ? 2 : 1);
  if (preview) {
    line(preview.synthetic.samples, '#f3f0e8', 1.6, [6, 5]);
    line(preview.plan.samples, '#dfbd68', 3);
  }
  for (const p of pick) {
    const [x, y] = P(p);
    g.fillStyle = '#2f6fed'; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
  }
  g.fillStyle = '#a39c8e'; g.font = '12px "Segoe UI"';
  const info = preview ? `${preview.plan.method === 'recorded' ? `nagranie „${preview.plan.recording}” dopasowane do nowej drogi` : 'brak pasującego nagrania — krzywa syntetyczna'} · ${preview.plan.samples.length} próbek · ${preview.plan.samples[preview.plan.samples.length - 1].t} ms`
    : pick.length === 1 ? 'teraz kliknij cel' : 'kliknij start, potem cel — zobaczysz, jak AI poprowadzi kursor';
  g.fillText(info, 12, H - 12);
  cv._map = { k, ox, oy };
}

$('paths-canvas').addEventListener('click', async (e) => {
  const cv = $('paths-canvas');
  const m = cv._map;
  if (!m) return;
  const r = cv.getBoundingClientRect();
  const p = { x: Math.round((e.clientX - r.left - m.ox) / m.k), y: Math.round((e.clientY - r.top - m.oy) / m.k) };
  if (pick.length >= 2) { pick = []; preview = null; }
  pick.push(p);
  if (pick.length === 2) preview = await safe(() => call('recordings:preview', { from: pick[0], to: pick[1], motion: S.settings.motion }));
  drawPaths();
});
addEventListener('resize', () => { if (isPage('paths')) drawPaths(); });
$('set-motion').addEventListener('change', (e) => safe(() => call('settings:set', { motion: e.target.value })).then(refresh));
$('set-speed').addEventListener('change', (e) => safe(() => call('settings:set', { speed: Number(e.target.value) })).then(refresh));
$('set-noise').addEventListener('change', (e) => safe(() => call('settings:set', { noisePx: Number(e.target.value) })).then(refresh));

// ── Podłącz AI ────────────────────────────────────────────────────────────
const PROMPTS = [
  'Użyj narzędzi MPC Ekran. Otwórz okno „Biuro Pomocy”, wykryj elementy i nazwij pola formularza oraz przyciski (profil biuro_pomocy). ' +
  'Wypełnij zgłoszenie: Anna Kowalska, anna@firma.pl, kategoria Reklamacja, priorytet Pilny, opis „Paczka przyszła uszkodzona”, zaakceptuj regulamin i wyślij. ' +
  'Sprawdź, że pojawiło się „Wysłano zgłoszenie”. Nagraj to jako sekwencję zgloszenie ze zmiennymi imie, email i opis.',
  'Użyj MPC Ekran: pokaż mi, jakie elementy widzisz w aktywnym oknie (detect_elements), nazwij 5 najważniejszych przycisków i pokaż podgląd niebieskich stref.',
];

function fillConnect() {
  const server = `${S.root}\\src\\mcp\\server.js`;
  $('cmd-add').textContent = `claude mcp add mpc-ekran -s user -- node "${server}"`;
  $('cmd-desktop').textContent = JSON.stringify({ mcpServers: { 'mpc-ekran': { command: 'node', args: [server] } } }, null, 2);
  $('prompt-1').textContent = PROMPTS[0];
  $('prompt-2').textContent = PROMPTS[1];
  $('tools-grid').innerHTML = TOOL_GROUPS.map(([g, tools]) => `<div class="g">${esc(g)}</div>${tools.map(([n, d]) => `<div class="t"><code>${n}</code><span>${esc(d)}</span></div>`).join('')}`).join('');
}

$('btn-selftest').addEventListener('click', async () => {
  $('selftest').innerHTML = '<tr><td class="muted">Sprawdzam…</td></tr>';
  const r = await safe(() => call('selftest'));
  if (!r) return;
  $('selftest').innerHTML = r.map((x) => `<tr><td class="${x.ok ? 'ok-t' : 'bad-t'}">${x.ok ? '✓' : '✗'}</td><td>${esc(x.name)}</td><td class="muted">${esc(x.info)}</td><td class="muted">${x.ms} ms</td></tr>`).join('');
});

// ── Start ─────────────────────────────────────────────────────────────────
window.mpc.on('event', (ev) => onEvent(ev));
window.mpc.on('refresh', () => { refresh(); if (isPage('elements')) loadElements(); if (isPage('sequences')) loadSequences(); if (isPage('paths')) loadRecordings(); });

(async () => {
  await refresh();
  fillConnect();
  try {
    const sc = JSON.parse(localStorage.getItem('mpc-scan') || 'null');
    if (sc) { $('n-scan').textContent = sc.count; $('n-scan-ms').textContent = (sc.ms / 1000).toFixed(1); }
  } catch { /* ignore */ }
  const hist = await call('history');
  for (const ev of hist) onEvent(ev, { quiet: true });
  const lastImg = calls.find((c) => c.image);
  if (lastImg) showCall(lastImg);
  renderTimeline();
  let page = 'show';
  try { page = localStorage.getItem('mpc-page') || 'show'; } catch { /* ignore */ }
  if (location.hash) page = location.hash.slice(1);
  go(page);
  setInterval(refresh, 5000);
})();
