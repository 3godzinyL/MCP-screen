// Integracja: serwer MCP przez stdio (jak Claude Code), tryb próbny, izolowane dane.
// Nic nie klika naprawdę — sprawdza protokół, narzędzia, obrazy, zapis elementów i sekwencji.
process.noDeprecation = true;
const os = require('os');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { connect, textOf } = require('./mcp-client.cjs');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-mcp-'));
let client;

test.before(async () => { ({ client } = await connect(DATA)); });
test.after(async () => { await client.close().catch(() => {}); fs.rmSync(DATA, { recursive: true, force: true }); });

const call = async (name, args = {}) => client.callTool({ name, arguments: args });
const img = (r) => (r.content || []).find((c) => c.type === 'image');

test('serwer: 29 narzędzi, instrukcja pracy dla AI, prompty', async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 29);
  for (const t of tools.tools) assert.ok(t.description && t.description.length > 20, `opis ${t.name}`);
  for (const n of ['app', 'lesson', 'act', 'edit_element']) assert.ok(tools.tools.some((t) => t.name === n), n);
  assert.match(client.getInstructions(), /app\(action="open"/);
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === 'automate_app'));
  assert.ok(prompts.prompts.some((p) => p.name === 'learn_app'));
});

test('aplikacja: open zakłada mapę dla okna, note zapisuje wiedzę, mapa to sam tekst', async () => {
  const w = textOf(await call('list_windows'));
  const first = w.split('\n')[0];
  const proc = (first.match(/\[([^\]]+)\]/) || [])[1];
  assert.ok(proc, first);
  const o = await call('app', { action: 'open', window: proc });
  assert.ok(!o.isError, textOf(o));
  assert.match(textOf(o), /^APLIKACJA „/);
  assert.equal((o.content || []).filter((c) => c.type === 'image').length, 0, 'mapa bez obrazów');
  const app = textOf(o).match(/APLIKACJA „([^”]+)”/)[1];
  await call('app', { action: 'note', app, section: 'Ekrany', text: 'Test wiedzy.' });
  const o2 = await call('app', { action: 'open', app });
  assert.match(textOf(o2), /Test wiedzy\./);
  const list = await call('app', { action: 'list' });
  assert.match(textOf(list), new RegExp(app));
});

test('act: kilka kroków w jednym wywołaniu (próbnie), zatrzymanie na błędzie', async () => {
  const r = await call('act', { steps: [{ action: 'keys', keys: 'Ctrl+A' }, { action: 'type', text: 'Zażółć' }, { action: 'wait', ms: 20 }] });
  assert.match(textOf(r), /OK · 3\/3 kroków/);
  const bad = await call('act', { steps: [{ action: 'keys', keys: 'Enter' }, { action: 'click', element: 'nie_ma' }, { action: 'keys', keys: 'Tab' }] });
  assert.match(textOf(bad), /PRZERWANE na kroku 2/);
});

test('detect_elements(image=false) zwraca sam tekst; edit_element poprawia strefę', async () => {
  await call('use_profile', { name: 'edycja' });
  const d = await call('detect_elements', { max_marks: 30, image: false });
  assert.equal((d.content || []).filter((c) => c.type === 'image').length, 0);
  const shot = textOf(d).match(/Zrzut (s\d+)/)[1];
  await call('label_elements', { shot, items: [{ x: 10, y: 10, w: 60, h: 30, name: 'strefa_a' }] });
  const u = await call('edit_element', { action: 'update', names: ['strefa_a'], shot, x: 12, y: 12, w: 80, h: 34, category: 'menu', important: true });
  assert.ok(!u.isError, textOf(u));
  assert.match(textOf(u), /menu ★ ważny/);
  const rn = await call('edit_element', { action: 'rename', names: ['strefa_a'], rename_to: 'strefa_b' });
  assert.match(textOf(rn), /strefa_a → strefa_b/);
  const rm = await call('edit_element', { action: 'remove', names: ['strefa_b'] });
  assert.match(textOf(rm), /Usunięto: strefa_b/);
});

test('lekcja człowieka: list, get (tekst), to_sequence → przepis ze zmiennymi', async () => {
  const lessonsDir = path.join(DATA, 'lessons', 'lekcja_mcp');
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.writeFileSync(path.join(lessonsDir, 'lesson.json'), JSON.stringify({
    name: 'lekcja_mcp', goal: 'Wyślij zgłoszenie', apps: ['biuro'], createdAt: new Date().toISOString(), durationMs: 9000,
    steps: [
      { i: 1, t: 0, type: 'click', app: 'biuro', element: 'pole_imie', window: { process: 'electron', title: 'Biuro Pomocy', rect: { x: 0, y: 0, w: 900, h: 700 } }, elementInfo: { category: 'pole', name: 'Imię', box: { x: 40, y: 180, w: 350, h: 38 }, source: 'uia' } },
      { i: 2, t: 600, type: 'type', text: 'Anna', field: 'pole_imie' },
      { i: 3, t: 1500, type: 'click', app: 'biuro', element: 'przycisk_wyslij', window: { process: 'electron', title: 'Biuro Pomocy', rect: { x: 0, y: 0, w: 900, h: 700 } }, elementInfo: { category: 'przycisk', name: 'Wyślij', box: { x: 600, y: 500, w: 140, h: 40 }, source: 'uia' } },
    ],
  }));
  assert.match(textOf(await call('lesson', { action: 'list' })), /lekcja_mcp — 3 kroków/);
  const g = await call('lesson', { action: 'get', name: 'lekcja_mcp' });
  assert.match(textOf(g), /2\. \[0\.6s\] wpisz „Anna” w pole_imie/);
  const s = await call('lesson', { action: 'to_sequence', name: 'lekcja_mcp', sequence_name: 'zgloszenie_z_lekcji' });
  assert.match(textOf(s), /pole_imie="Anna"/);
  assert.match(textOf((await call('sequence_list', { name: 'zgloszenie_z_lekcji' }))), /\{\{pole_imie\}\}/);
});

test('zrzut ekranu: obraz + mapowanie obraz→ekran', async () => {
  const r = await call('screenshot', { grid: true });
  assert.ok(!r.isError, textOf(r));
  assert.match(textOf(r), /Zrzut s\d+: ekran x=\d+ y=\d+ \d+x\d+ → obraz \d+x\d+/);
  const i = img(r);
  assert.ok(i && i.data.length > 1000);
  assert.ok(['image/jpeg', 'image/png'].includes(i.mimeType));
});

test('wykrywanie → nazwanie → odnalezienie → klik próbny → sekwencja', async () => {
  await call('use_profile', { name: 'test_mcp' });
  const d = await call('detect_elements', { max_marks: 60 });
  assert.ok(!d.isError, textOf(d));
  const txt = textOf(d);
  const shot = txt.match(/Zrzut (s\d+)/)[1];
  const first = Number(txt.match(/^#(\d+) /m)[1]);
  const lab = await call('label_elements', { shot, items: [{ mark: first, name: 'pierwszy', description: 'test' }, { x: 5, y: 5, w: 80, h: 30, name: 'rog' }] });
  assert.match(textOf(lab), /zapisano 2\/2/);
  assert.ok(img(lab));
  const loc = await call('locate_element', { element: 'pierwszy' });
  assert.ok(!loc.isError, textOf(loc));
  assert.match(textOf(loc), /dopasowanie (0\.9\d*|1)/);
  const c = await call('click', { element: 'pierwszy', verify: true });
  assert.match(textOf(c), /\[PRÓBA\]/);
  await call('sequence_record', { action: 'start', name: 'nagrana' });
  await call('click', { mark: first, shot });
  await call('press_keys', { keys: 'Ctrl+S' });
  const stop = await call('sequence_record', { action: 'stop' });
  assert.match(textOf(stop), /2 kroków/);
  const run = await call('sequence_run', { name: 'nagrana' });
  assert.match(textOf(run), /: OK w/);
});

test('błędy są czytelne dla AI (isError + podpowiedź)', async () => {
  const r = await call('click', { element: 'nie_istnieje' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /nie ma elementu/);
  const k = await call('press_keys', { keys: 'Ctrl+Zupa' });
  assert.equal(k.isError, true);
  const s = await call('sequence_save', { name: 'zla', steps: [{ action: 'click', mark: 2 }] });
  assert.equal(s.isError, true);
});
