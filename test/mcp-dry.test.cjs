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

test('serwer: 26 narzędzi, instrukcja pracy dla AI, prompt', async () => {
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 26);
  for (const t of tools.tools) assert.ok(t.description && t.description.length > 20, `opis ${t.name}`);
  assert.match(client.getInstructions(), /detect_elements/);
  const prompts = await client.listPrompts();
  assert.ok(prompts.prompts.some((p) => p.name === 'automate_app'));
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
