// Test na żywo (prawdziwa mysz i klawiatura!) na aplikacji ćwiczebnej „Biuro Pomocy”.
// Robi dokładnie to, co zrobiłaby AI przez MCP:
//   detect_elements → label_elements → nagrywanie sekwencji → wypełnienie formularza → weryfikacja OCR
//   → przeciągnięcie okna w inne miejsce → odtworzenie sekwencji (elementy szukane po wyglądzie).
// Użycie: node test/live-demo.cjs <katalog_danych> <katalog_wyników>
// Okno ćwiczebne jest „zawsze na wierzchu”, a test przerywa się, gdy człowiek ruszy myszą.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { connect, textOf, saveImages } = require('./mcp-client.cjs');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.resolve(process.argv[2] || path.join(ROOT, '.test-data-live'));
const OUT = path.resolve(process.argv[3] || path.join(DATA, 'out'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) { throw new Error(msg); }

function markFor(listText, re) {
  const line = listText.split('\n').find((l) => re.test(l));
  if (!line) return null;
  return Number(line.match(/^#(\d+)/)[1]);
}

(async () => {
  const electron = require(path.join(ROOT, 'node_modules', 'electron'));
  const studio = spawn(electron, [path.join(ROOT, 'src', 'studio', 'main.js'), '--demo', '--overlay'], {
    env: { ...process.env, MPC_DATA_DIR: DATA, MPC_DEMO_TOP: '1' }, stdio: 'ignore',
  });
  const { client } = await connect(DATA, { live: true });
  const log = [];
  const call = async (name, args = {}, { allowError = false } = {}) => {
    const t0 = Date.now();
    const r = await client.callTool({ name, arguments: args });
    const txt = textOf(r);
    const imgs = saveImages(r, OUT, `${String(log.length + 1).padStart(2, '0')}-${name}`);
    log.push({ name, args, ms: Date.now() - t0, error: !!r.isError, text: txt.slice(0, 3000), imgs });
    console.log(`\n=== ${name} ${JSON.stringify(args).slice(0, 140)} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}\n${txt.slice(0, 900)}`);
    if (r.isError && !allowError) fail(`${name}: ${txt}`);
    return txt;
  };
  try {
    // czekamy na okno ćwiczebne
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      const w = await call('list_windows', { filter: 'Biuro Pomocy' });
      ok = /Biuro Pomocy/.test(w);
      if (!ok) await sleep(500);
    }
    if (!ok) fail('Okno Biuro Pomocy nie wystartowało');
    await call('settings', { speed: 1.6, motion: 'recorded' });
    await call('use_profile', { name: 'biuro_pomocy', description: 'Aplikacja ćwiczebna z MPC Studio' });
    await call('focus_window', { window: 'Biuro Pomocy' });
    const info = await call('screen_info');
    if (!/Aktywne okno: ★ „Biuro Pomocy/.test(info)) fail('Biuro Pomocy nie jest na wierzchu — przerywam, żeby nie klikać w inne okno');

    // nakładka Studia nie może trafiać na zrzuty (setContentProtection)
    const full = await call('find_text', { text: 'AI na żywo' }, { allowError: true });
    const overlayVisibleToAi = /Znaleziono/.test(full);
    console.log(`\n>>> Nakładka widoczna na zrzucie AI: ${overlayVisibleToAi ? 'TAK (źle)' : 'NIE (dobrze)'}`);

    const det = await call('detect_elements', { window: 'Biuro Pomocy' });
    const shot = det.match(/Zrzut (s\d+)/)[1];
    const want = {
      pole_imie: /Edit "Imię i nazwisko/,
      pole_email: /Edit "E-mail/,
      lista_kategoria: /ComboBox/,
      opcja_pilny: /RadioButton "Pilny/,
      pole_opis: /Edit "Opis problemu/,
      zgoda_regulamin: /CheckBox/,
      przycisk_wyslij: /Button "Wyślij zgłoszenie/,
      zakladka_lista: /(TabItem|Button) "Lista zgłoszeń/,
    };
    const items = [];
    for (const [name, re] of Object.entries(want)) {
      const m = markFor(det, re);
      if (!m) fail(`Nie znalazłem strefy dla ${name} (${re})`);
      items.push({ name, mark: m, description: `Biuro Pomocy: ${name.replace(/_/g, ' ')}` });
    }
    await call('label_elements', { shot, items });

    // AI robi zadanie i jednocześnie nagrywa sekwencję
    await call('sequence_record', { action: 'start', name: 'zgloszenie', description: 'Wypełnia i wysyła zgłoszenie w Biurze Pomocy' });
    await call('type_text', { element: 'pole_imie', text: 'Anna Kowalska', clear: true });
    await call('type_text', { element: 'pole_email', text: 'anna@firma.pl', clear: true });
    await call('click', { element: 'lista_kategoria' });
    await call('type_text', { text: 'Rek' });
    await call('press_keys', { keys: 'Enter' });
    await call('click', { element: 'opcja_pilny' });
    await call('type_text', { element: 'pole_opis', text: 'Paczka przyszła uszkodzona — zażółć gęślą jaźń.', clear: true });
    await call('click', { element: 'zgoda_regulamin' });
    await call('click', { element: 'przycisk_wyslij', verify: true });
    const w1 = await call('wait', { for_text: 'Wysłano zgłoszenie', window: 'Biuro Pomocy', timeout_ms: 6000 });
    if (!/^OK/.test(w1)) fail('Brak potwierdzenia wysłania (1)');
    await call('sequence_record', { action: 'stop' });

    // odporność: przeciągamy okno za pasek tytułu w inne miejsce
    const wl = await call('list_windows', { filter: 'Biuro Pomocy' });
    const m = wl.match(/x=(-?\d+) y=(-?\d+) (\d+)x(\d+)/);
    const [wx, wy, ww] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const grab = { x: wx + Math.round(ww * 0.45), y: wy + 12, space: 'screen' };
    const dest = { x: grab.x + (wx > 600 ? -420 : 420), y: grab.y + 160, space: 'screen' };
    await call('drag', { from: grab, to: dest });
    await sleep(500);
    const wl2 = await call('list_windows', { filter: 'Biuro Pomocy' });
    const m2 = wl2.match(/x=(-?\d+) y=(-?\d+)/);
    const moved = Math.abs(Number(m2[1]) - wx) > 100;
    console.log(`\n>>> Okno przesunięte: ${moved ? 'TAK' : 'NIE'} (${wx},${wy} → ${m2[1]},${m2[2]})`);

    await call('show_elements', { locate: true, window: 'Biuro Pomocy' });
    const run = await call('sequence_run', { name: 'zgloszenie' });
    const w2 = await call('wait', { for_text: 'Wysłano zgłoszenie', window: 'Biuro Pomocy', timeout_ms: 6000 });
    if (!/^OK/.test(w2)) fail('Brak potwierdzenia wysłania (2)');
    await call('click', { element: 'zakladka_lista' });
    const list = await call('find_text', { text: '#1025', window: 'Biuro Pomocy' }, { allowError: true });
    console.log('\n>>> PODSUMOWANIE');
    console.log(`nakładka niewidoczna dla AI: ${!overlayVisibleToAi}`);
    console.log(`okno przesunięte: ${moved}`);
    console.log(`sekwencja po przesunięciu: ${/: OK w/.test(run) ? 'OK' : 'BŁĄD'}`);
    console.log(`drugie zgłoszenie na liście: ${/Znaleziono/.test(list)}`);
    fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
  } finally {
    await client.close().catch(() => {});
    if (process.env.KEEP_STUDIO !== '1') studio.kill();
  }
})().catch((e) => { console.error('\nTEST PRZERWANY:', e.message); process.exitCode = 1; setTimeout(() => process.exit(1), 500); });
