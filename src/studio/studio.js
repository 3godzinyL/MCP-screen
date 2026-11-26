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
  if (page === 'learn') loadLearn();
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

// ── Nauka: lekcje, edytor stref, AI uczy się sama ─────────────────────────
const CAT = { przycisk: '#2f6fed', pole: '#1f9d61', wybor: '#8b5cf6', menu: '#e07b24', link: '#0ea5b7', inne: '#d6409f' };
const CAT_PL = { przycisk: 'przycisk', pole: 'pole tekstowe', wybor: 'wybór / lista', menu: 'menu / zakładka', link: 'link / tekst', inne: 'inne' };
let lessonSel = null;   // { lesson, screens, elements }
let stepSel = null;     // numer kroku
let zoneEdit = null;    // { box (px obrazu kroku), orig }
let showMapZones = true;
let lessonRunning = false;
let stepImg = null;

function renderLegend() {
  $('cat-legend').innerHTML = Object.entries(CAT).map(([k, c]) => `<span><i style="background:${c}"></i>${CAT_PL[k]}</span>`).join('');
}

function updateLessonState(st) {
  lessonRunning = !!(st && st.running);
  const el = $('lesson-state');
  el.classList.toggle('on', lessonRunning);
  el.textContent = lessonRunning
    ? `nagrywam „${st.name}” · kroków ${st.steps} · kliknięć ${st.clicks}${st.pending ? ` · mapuję ${st.pending}…` : ''}`
    : 'gotowe';
  $('lesson-toggle').textContent = lessonRunning ? 'Zakończ nagrywanie' : 'Start nagrywania';
  $('lesson-toggle').classList.toggle('red', lessonRunning);
  $('nav-learn').textContent = lessonRunning ? '●' : '';
}

async function loadLearn() {
  renderLegend();
  const st = await call('lesson:status');
  updateLessonState(st);
  $('hotkey-btn').textContent = st.hotkey || st.wantedHotkey || '—';
  $('hotkey-msg').textContent = st.hotkey ? '' : `Skrót ${st.wantedHotkey} zajęty przez inny program — ustaw inny`;
  $('opt-keyboard').checked = !!S.settings.lessonKeyboard;
  $('opt-screens').checked = !!S.settings.lessonMapScreens;
  $('opt-motion').checked = !!S.settings.lessonMotion;
  await loadLessonList();
  await loadLearnApps();
}

$('lesson-toggle').addEventListener('click', async () => {
  if (lessonRunning) { await safe(() => call('lesson:stop')); return; }
  await call('lesson:goal', { goal: $('lesson-goal').value.trim() });
  await safe(() => call('lesson:start', {
    goal: $('lesson-goal').value.trim(),
    keyboard: $('opt-keyboard').checked, mapScreens: $('opt-screens').checked, motion: $('opt-motion').checked,
  }), 'Nagrywam lekcję — klikaj w aplikacjach. Skrót albo „Zakończ” w małym okienku kończy.');
});
$('lesson-goal').addEventListener('change', () => call('lesson:goal', { goal: $('lesson-goal').value.trim() }));
for (const [id, key] of [['opt-keyboard', 'lessonKeyboard'], ['opt-screens', 'lessonMapScreens'], ['opt-motion', 'lessonMotion']]) {
  $(id).addEventListener('change', (e) => safe(() => call('settings:set', { [key]: e.target.checked })));
}

// Zmiana skrótu: klik w przycisk, potem nowa kombinacja (Esc anuluje)
$('hotkey-btn').addEventListener('click', () => {
  const b = $('hotkey-btn');
  const prev = b.textContent;
  b.classList.add('listen');
  b.textContent = 'naciśnij…';
  const onKey = async (e) => {
    e.preventDefault();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    window.removeEventListener('keydown', onKey, true);
    b.classList.remove('listen');
    if (e.key === 'Escape') { b.textContent = prev; return; }
    let key = '';
    if (/^F\d{1,2}$/.test(e.key)) key = e.key;
    else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (['Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Pause'].includes(e.key)) key = e.key;
    if (!key) { b.textContent = prev; toast('Ten klawisz nie może być skrótem — użyj F1–F24 albo Ctrl/Alt + litera.', true); return; }
    const acc = [e.ctrlKey ? 'Control' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+');
    const r = await safe(() => call('lesson:hotkey', { hotkey: acc }));
    if (r && r.ok) { b.textContent = acc; $('hotkey-msg').textContent = ''; toast(`Skrót nagrywania: ${acc}`); }
    else { b.textContent = prev; $('hotkey-msg').textContent = `${acc} jest zajęty przez inny program`; }
  };
  window.addEventListener('keydown', onKey, true);
});

async function loadLessonList() {
  const list = await call('lesson:list');
  $('lesson-list').innerHTML = list.map((l) => `<div class="it ${lessonSel && lessonSel.lesson.name === l.name ? 'sel' : ''}" data-lesson="${esc(l.name)}">
    <div class="n">${esc(l.name)}</div>
    <div class="s">${l.steps} kroków · ${esc((l.apps || []).join(', ') || '—')} · ${Math.round((l.durationMs || 0) / 1000)} s</div>
    ${l.goal ? `<div class="s">cel: ${esc(l.goal.slice(0, 90))}</div>` : ''}</div>`).join('') ||
    '<div class="it"><span class="muted">Brak lekcji. Wpisz cel i naciśnij Start albo skrót.</span></div>';
}
$('lesson-list').addEventListener('click', (e) => { const it = e.target.closest('[data-lesson]'); if (it) openLesson(it.dataset.lesson); });

async function openLesson(name, keepStep = false) {
  lessonSel = await call('lesson:get', { name });
  const l = lessonSel.lesson;
  if (!keepStep || !l.steps.some((s) => s.i === stepSel)) {
    const first = l.steps.find((s) => s.type === 'click' || s.type === 'drag') || l.steps[0];
    stepSel = first ? first.i : null;
  }
  document.querySelectorAll('#lesson-list .it').forEach((x) => x.classList.toggle('sel', x.dataset.lesson === name));
  renderLessonEditor();
}

function stepText(s) {
  if (s.type === 'click' || s.type === 'drag') return `${s.type === 'drag' ? 'przeciągnij' : s.double ? 'dwuklik' : 'klik'} ${s.element || '?'}${s.elementInfo && s.elementInfo.name ? ` „${s.elementInfo.name.slice(0, 30)}”` : ''}`;
  if (s.type === 'type') return s.secret ? 'hasło (ukryte)' : `wpisz „${String(s.text).slice(0, 40)}”${s.var ? ` → {{${s.var}}}` : ''}`;
  if (s.type === 'keys') return `klawisze ${s.keys}`;
  return s.type;
}

function renderLessonEditor() {
  const l = lessonSel.lesson;
  $('lesson-editor').innerHTML = `
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(l.name)}</h2>
      <span class="muted" style="font-size:12.5px">${l.steps.length} kroków · ${esc((l.apps || []).join(', '))} · ${Math.round((l.durationMs || 0) / 1000)} s</span></div>
    <label class="fld">Cel lekcji<textarea id="le-goal" rows="2">${esc(l.goal || '')}</textarea></label>
    <div class="row">
      <button class="btn small" id="le-save-goal">Zapisz cel</button>
      <button class="btn gold" id="le-seq">Zrób przepis (sekwencję)</button>
      <button class="btn blue" id="le-learn">Naucz AI z tej lekcji</button>
      <span class="grow"></span>
      <button class="btn small red" id="le-del">Usuń lekcję</button>
    </div>
    <div class="result" id="le-result"></div>
    <div class="lesson-grid">
      <div class="steps-strip" id="le-steps"></div>
      <div class="step-view" id="le-view"></div>
    </div>`;
  $('le-save-goal').onclick = () => safe(() => call('lesson:update', { name: l.name, goal: $('le-goal').value }), 'Zapisano cel.').then(loadLessonList);
  $('le-seq').onclick = async () => {
    const r = await safe(() => call('lesson:toSequence', { name: l.name, goal: $('le-goal').value }));
    if (!r) return;
    $('le-result').className = 'result ok';
    $('le-result').innerHTML = `Przepis „${esc(r.name)}”: ${r.steps} kroków · zmienne: ${esc(r.variables.join(', ') || 'brak')}${r.secrets && r.secrets.length ? ` · tajne (podaj przy uruchomieniu): ${esc(r.secrets.join(', '))}` : ''}. Zobacz zakładkę Sekwencje.`;
    refresh();
  };
  $('le-learn').onclick = () => safe(() => call('learn:launch', { app: (l.apps || [])[0], goal: $('le-goal').value, lessonNames: [l.name] }), 'Otwieram Claude z zadaniem nauki — zadanie zapisane w data\\learn.');
  $('le-del').onclick = async () => {
    if (!confirm(`Usunąć lekcję „${l.name}”? Elementy w profilach aplikacji zostają.`)) return;
    await safe(() => call('lesson:delete', { name: l.name }), 'Usunięto lekcję.');
    lessonSel = null;
    $('lesson-editor').innerHTML = '<span class="muted">Wybierz lekcję z listy.</span>';
    loadLessonList();
  };
  renderSteps();
  renderStepView();
}

function renderSteps() {
  const l = lessonSel.lesson;
  $('le-steps').innerHTML = l.steps.map((s) => {
    const c = s.elementInfo ? CAT[s.elementInfo.category] || CAT.inne : s.type === 'type' ? '#4a505c' : '#2c3038';
    return `<div class="stp ${s.i === stepSel ? 'sel' : ''} ${s.skip ? 'skip' : ''}" data-i="${s.i}"><span class="n">${s.i}</span><span class="c" style="background:${c}"></span><span>${esc(stepText(s))}</span></div>`;
  }).join('');
}
document.addEventListener('click', (e) => {
  const st = e.target.closest('#le-steps .stp');
  if (!st) return;
  stepSel = Number(st.dataset.i);
  renderSteps();
  renderStepView();
});

function currentStep() { return lessonSel && lessonSel.lesson.steps.find((s) => s.i === stepSel); }

function renderStepView() {
  const s = currentStep();
  const v = $('le-view');
  if (!s) { v.innerHTML = '<span class="muted">Brak kroków.</span>'; return; }
  if (s.type === 'click' || s.type === 'drag') {
    const el = lessonSel.elements[s.app] ? lessonSel.elements[s.app][s.element] : null;
    const scr = s.screen ? lessonSel.screens[`${s.app}/${s.screen}`] : null;
    v.innerHTML = `
      <div class="canvas-wrap"><canvas id="step-canvas"></canvas></div>
      <div class="step-tools">
        <label><input type="checkbox" id="sv-map" ${showMapZones ? 'checked' : ''}/> wszystkie strefy ekranu${scr ? ` (${scr.elements.length})` : ' (ekran niezmapowany)'}</label>
        <span class="muted">Przeciągnij strefę = przesuń · rogi = rozmiar · klik w cienką strefę = użyj jej</span>
      </div>
      <div class="zone-form">
        <label class="fld">Nazwa elementu<input id="zf-name" value="${esc(s.element || '')}" spellcheck="false"/></label>
        <label class="fld">Typ (kolor)<select id="zf-cat">${Object.keys(CAT).map((k) => `<option value="${k}" ${((el && el.category) || (s.elementInfo && s.elementInfo.category)) === k ? 'selected' : ''}>${CAT_PL[k]}</option>`).join('')}</select></label>
        <label class="fld" style="grid-column:1/-1">Opis (dla AI)<input id="zf-desc" value="${esc((el && el.description) || '')}"/></label>
      </div>
      <div class="row">
        <button class="btn gold" id="zf-save">Zapisz strefę</button>
        <button class="btn small" id="zf-reset">Cofnij</button>
        <label style="font-size:12.5px;color:var(--text-2)"><input type="checkbox" id="sv-skip" ${s.skip ? 'checked' : ''}/> pomiń krok w przepisie</label>
        <span class="muted" style="font-size:12px">${esc(s.window ? `okno „${(s.window.title || '').slice(0, 50)}” · ${s.window.process}` : '')} · źródło: ${esc(s.elementInfo ? s.elementInfo.source : '?')}</span>
      </div>`;
    zoneEdit = null;
    loadStepImage(s);
    $('sv-map').onchange = (e) => { showMapZones = e.target.checked; drawStep(); };
    $('zf-reset').onclick = () => { zoneEdit = null; renderStepView(); };
    $('sv-skip').onchange = (e) => saveStepPatch({ skip: e.target.checked });
    $('zf-save').onclick = saveZone;
    return;
  }
  if (s.type === 'type') {
    v.innerHTML = `
      <label class="fld">Wpisany tekst${s.field ? ` (pole: ${esc(s.field)})` : ''}<input id="ty-text" value="${esc(s.secret ? '' : s.text)}" ${s.secret ? 'disabled placeholder="hasło — nie zapisujemy"' : ''}/></label>
      <div class="row" style="font-size:13px;color:var(--text-2)">
        <label>Zmienna {{<input id="ty-var" value="${esc(s.var || '')}" placeholder="np. imie" style="width:110px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 6px;color:var(--text)"/>}}</label>
        <label><input type="checkbox" id="ty-secret" ${s.secret ? 'checked' : ''}/> hasło (nie zapisuj tekstu)</label>
        <label><input type="checkbox" id="ty-skip" ${s.skip ? 'checked' : ''}/> pomiń</label>
        <button class="btn small gold" id="ty-save">Zapisz</button>
      </div>
      <p class="muted" style="font-size:12.5px">W przepisie ten tekst stanie się zmienną {{…}} z tą wartością domyślną — AI albo Ty podacie inną przy uruchomieniu.</p>`;
    $('ty-save').onclick = () => saveStepPatch({ text: $('ty-secret').checked ? '' : $('ty-text').value, var: $('ty-var').value.trim() || undefined, secret: $('ty-secret').checked, skip: $('ty-skip').checked });
    return;
  }
  v.innerHTML = `
    <label class="fld">Klawisze<input id="ky-keys" value="${esc(s.keys || '')}"/></label>
    <div class="row"><label style="font-size:13px;color:var(--text-2)"><input type="checkbox" id="ky-skip" ${s.skip ? 'checked' : ''}/> pomiń</label><button class="btn small gold" id="ky-save">Zapisz</button></div>`;
  $('ky-save').onclick = () => saveStepPatch({ keys: $('ky-keys').value.trim(), skip: $('ky-skip').checked });
}

async function saveStepPatch(patch) {
  const l = lessonSel.lesson;
  await safe(() => call('lesson:update', { name: l.name, steps: [{ i: stepSel, ...patch }] }), 'Zapisano krok.');
  await openLesson(l.name, true);
}

function loadStepImage(s) {
  stepImg = null;
  if (!s.shot) return;
  const img = new Image();
  img.onload = () => { stepImg = img; drawStep(); };
  img.src = `mpc://data/lessons/${encodeURIComponent(lessonSel.lesson.name)}/${encodeURIComponent(s.shot)}?t=${Date.now()}`;
}

function stepBox(s) {
  if (zoneEdit) return zoneEdit.box;
  const b = s.elementInfo && s.elementInfo.box;
  if (!b || !s.window) return null;
  return { x: b.x - s.window.rect.x, y: b.y - s.window.rect.y, w: b.w, h: b.h };
}

function drawStep() {
  const s = currentStep();
  const cv = $('step-canvas');
  if (!cv || !s || !stepImg) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.parentElement.clientWidth;
  const k = Math.min(1, W / stepImg.naturalWidth);
  const H = Math.round(stepImg.naturalHeight * k);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  cv.style.height = `${H}px`;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#08090b'; g.fillRect(0, 0, W, H);
  g.drawImage(stepImg, 0, 0, stepImg.naturalWidth * k, H);
  cv._k = k;
  const scr = s.screen ? lessonSel.screens[`${s.app}/${s.screen}`] : null;
  if (showMapZones && scr) {
    g.lineWidth = 1.2;
    for (const z of scr.elements) {
      const c = CAT[z.category] || CAT.inne;
      g.strokeStyle = `${c}cc`;
      g.strokeRect(z.rel.x * k + 0.5, z.rel.y * k + 0.5, z.rel.w * k, z.rel.h * k);
    }
  }
  const b = stepBox(s);
  if (b) {
    const cat = $('zf-cat') ? $('zf-cat').value : (s.elementInfo && s.elementInfo.category);
    const c = CAT[cat] || CAT.inne;
    const x = b.x * k; const y = b.y * k; const w = b.w * k; const h = b.h * k;
    g.lineWidth = 5; g.strokeStyle = 'rgba(255,255,255,.75)'; g.strokeRect(x, y, w, h);
    g.lineWidth = 2.5; g.strokeStyle = c; g.fillStyle = `${c}2e`; g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h);
    const name = ($('zf-name') && $('zf-name').value) || s.element || '';
    g.font = '700 12px "Segoe UI", sans-serif';
    const tw = g.measureText(name).width + 12;
    const ly = y > 20 ? y - 19 : y + h + 1;
    g.fillStyle = c; g.fillRect(x - 1, ly, tw, 18);
    g.fillStyle = '#fff'; g.fillText(name, x + 5, ly + 13.5);
    g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1;
    for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) { g.fillRect(hx - 4, hy - 4, 8, 8); g.strokeRect(hx - 4, hy - 4, 8, 8); }
  }
  if (s.point && s.window) {
    const px = (s.point.x - s.window.rect.x) * k;
    const py = (s.point.y - s.window.rect.y) * k;
    g.strokeStyle = '#e5484d'; g.lineWidth = 2;
    g.beginPath(); g.arc(px, py, 7, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(px - 11, py); g.lineTo(px + 11, py); g.moveTo(px, py - 11); g.lineTo(px, py + 11); g.stroke();
  }
}

let dragZ = null;
document.addEventListener('mousedown', (e) => {
  const cv = e.target.closest('#step-canvas');
  if (!cv || !cv._k) return;
  const s = currentStep();
  const r = cv.getBoundingClientRect();
  const k = cv._k;
  const mx = (e.clientX - r.left) / k;
  const my = (e.clientY - r.top) / k;
  const b = stepBox(s);
  const tol = 8 / k;
  if (b) {
    const corners = { nw: [b.x, b.y], ne: [b.x + b.w, b.y], sw: [b.x, b.y + b.h], se: [b.x + b.w, b.y + b.h] };
    for (const [c, [cx, cy]] of Object.entries(corners)) {
      if (Math.abs(mx - cx) < tol && Math.abs(my - cy) < tol) { dragZ = { type: c, sx: mx, sy: my, orig: { ...b } }; zoneEdit = { box: { ...b } }; return; }
    }
    if (mx >= b.x && my >= b.y && mx <= b.x + b.w && my <= b.y + b.h) { dragZ = { type: 'move', sx: mx, sy: my, orig: { ...b } }; zoneEdit = { box: { ...b } }; return; }
  }
  // klik w cienką strefę z mapy ekranu = użyj jej jako strefy elementu
  const scr = s.screen ? lessonSel.screens[`${s.app}/${s.screen}`] : null;
  if (showMapZones && scr) {
    const hit = scr.elements.filter((z) => mx >= z.rel.x && my >= z.rel.y && mx <= z.rel.x + z.rel.w && my <= z.rel.y + z.rel.h)
      .sort((a, c) => a.rel.w * a.rel.h - c.rel.w * c.rel.h)[0];
    if (hit) {
      zoneEdit = { box: { ...hit.rel } };
      if ($('zf-cat') && hit.category) $('zf-cat').value = hit.category;
      drawStep();
    }
  }
});
document.addEventListener('mousemove', (e) => {
  if (!dragZ) return;
  const cv = $('step-canvas');
  if (!cv) return;
  const r = cv.getBoundingClientRect();
  const k = cv._k;
  const dx = (e.clientX - r.left) / k - dragZ.sx;
  const dy = (e.clientY - r.top) / k - dragZ.sy;
  const o = dragZ.orig;
  let n = { ...o };
  if (dragZ.type === 'move') n = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h };
  if (dragZ.type === 'nw') n = { x: o.x + dx, y: o.y + dy, w: o.w - dx, h: o.h - dy };
  if (dragZ.type === 'ne') n = { x: o.x, y: o.y + dy, w: o.w + dx, h: o.h - dy };
  if (dragZ.type === 'sw') n = { x: o.x + dx, y: o.y, w: o.w - dx, h: o.h + dy };
  if (dragZ.type === 'se') n = { x: o.x, y: o.y, w: o.w + dx, h: o.h + dy };
  n.w = Math.max(6, n.w); n.h = Math.max(6, n.h);
  zoneEdit = { box: { x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.w), h: Math.round(n.h) } };
  drawStep();
});
document.addEventListener('mouseup', () => { dragZ = null; });
document.addEventListener('input', (e) => { if (e.target.id === 'zf-name') drawStep(); });
document.addEventListener('change', (e) => { if (e.target.id === 'zf-cat') drawStep(); });
addEventListener('resize', () => { if (isPage('learn')) drawStep(); });

async function saveZone() {
  const s = currentStep();
  const l = lessonSel.lesson;
  const b = zoneEdit ? zoneEdit.box : null;
  const name = $('zf-name').value.trim();
  const payload = { name: l.name, i: s.i, category: $('zf-cat').value, description: $('zf-desc').value.trim() };
  if (name && name !== s.element) payload.rename = name;
  if (b) payload.box = { x: s.window.rect.x + b.x, y: s.window.rect.y + b.y, w: b.w, h: b.h };
  const r = await safe(() => call('lesson:element', payload), (x) => `Zapisano „${x.element}”${b ? ' — nowy wycinek-wzorzec z poprawionej strefy' : ''}.`);
  if (r) { zoneEdit = null; await openLesson(l.name, true); refresh(); }
}

// AI uczy się sama: aplikacje z mapą + otwarte okna
async function loadLearnApps() {
  const [appsList, wins, lessonsList] = await Promise.all([call('apps:list'), call('windows:list'), call('lesson:list')]);
  const sel = $('learn-app');
  const prev = sel.value;
  sel.innerHTML = `<optgroup label="Znane aplikacje">${appsList.filter((a) => a.app || a.elements > 0).map((a) => `<option value="app:${esc(a.name)}">${esc(a.name)} — ${a.elements} el.${a.screens ? `, ${a.screens} ekr.` : ''}${a.knowledge ? ', wiedza' : ''}</option>`).join('')}</optgroup>` +
    `<optgroup label="Otwarte okna (nowa aplikacja)">${wins.map((w) => `<option value="win:${w.hwnd}">${esc(w.title.slice(0, 70))} [${esc(w.process)}]</option>`).join('')}</optgroup>`;
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  sel._lessons = lessonsList;
  renderLearnLessons();
}

function renderLearnLessons() {
  const sel = $('learn-app');
  const v = sel.value || '';
  const app = v.startsWith('app:') ? v.slice(4) : null;
  const ls = (sel._lessons || []).filter((l) => app && (l.apps || []).includes(app));
  $('learn-lessons').innerHTML = ls.length
    ? `<span class="muted">Lekcje do wykorzystania:</span>${ls.map((l) => `<label><input type="checkbox" data-learn-lesson="${esc(l.name)}" checked/> ${esc(l.name)} (${l.steps})</label>`).join('')}`
    : `<span class="muted">${app ? 'Brak lekcji dla tej aplikacji — AI pozna ją samodzielnie.' : 'Nowe okno: AI założy mapę aplikacji i pozna ją od zera.'}</span>`;
  $('learn-map-pre').style.display = 'none';
}
$('learn-app').addEventListener('change', renderLearnLessons);
$('learn-refresh').addEventListener('click', () => safe(loadLearnApps));
$('learn-map').addEventListener('click', async () => {
  const v = $('learn-app').value || '';
  const pre = $('learn-map-pre');
  if (!v.startsWith('app:')) { pre.style.display = 'block'; pre.textContent = 'Mapa powstanie, gdy AI albo lekcja pozna tę aplikację.'; return; }
  const text = await safe(() => call('apps:map', { app: v.slice(4) }));
  if (text === null) return;
  pre.style.display = 'block';
  pre.textContent = `${text}\n\n— około ${Math.round(text.length / 3.6)} tokenów (jeden zrzut ekranu to ok. 1500)`;
});
$('learn-go').addEventListener('click', async () => {
  const v = $('learn-app').value || '';
  const goal = $('learn-goal').value.trim();
  if (!goal) { toast('Wpisz cel — czego AI ma się nauczyć.', true); return; }
  const lessonNames = [...document.querySelectorAll('[data-learn-lesson]:checked')].map((c) => c.dataset.learnLesson);
  const arg = v.startsWith('app:') ? { app: v.slice(4) } : { hwnd: Number(v.slice(4)) };
  await safe(() => call('learn:launch', { ...arg, goal, lessonNames }), (r) => `Otwieram Claude: nauka „${r.app}”. Zadanie: ${r.file}`);
  loadLearnApps();
});

window.mpc.on('lesson-status', (st) => { updateLessonState(st); });
window.mpc.on('lesson-saved', async (r) => {
  toast(`Zapisano lekcję „${r.name}” (${r.steps} kroków). Popraw strefy i zrób przepis.`);
  go('learn');
  await loadLessonList();
  await openLesson(r.name);
  refresh();
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
