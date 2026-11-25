// Testy jednostkowe (node --test). Izolowany katalog danych — nie dotykają data/ właściciela.
process.noDeprecation = true;
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-unit-'));
process.env.MPC_DATA_DIR = TMP;
process.env.MPC_DRY_RUN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const humanizer = require('../src/core/humanizer');
const { matchTemplate, scoreAt, diffRatio } = require('../src/core/match');
const { detectCv, iou } = require('../src/core/detect/cv');
const { searchText, normalize, splitPhrases } = require('../src/core/detect/ocr');
const { Shot } = require('../src/core/capture');
const input = require('../src/core/input');
const sequences = require('../src/core/sequences');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('humanizer: ścieżka zaczyna się w starcie i kończy dokładnie w celu', () => {
  for (const motion of ['synthetic', 'direct']) {
    const p = humanizer.planMove({ x: 100, y: 900 }, { x: 1700, y: 200 }, { motion, noisePx: 3 });
    const last = p.samples[p.samples.length - 1];
    assert.deepEqual([last.x, last.y], [1700, 200]);
    if (motion !== 'direct') {
      assert.deepEqual([p.samples[0].x, p.samples[0].y], [100, 900]);
      assert.ok(p.samples.length > 20, 'płynny ruch ma wiele próbek');
      for (let i = 1; i < p.samples.length; i++) assert.ok(p.samples[i].t >= p.samples[i - 1].t, 'czas rośnie');
    }
  }
});

test('humanizer: nagrany ruch jest obracany i skalowany do nowego celu', () => {
  const samples = [];
  for (let i = 0; i <= 40; i++) samples.push({ t: i * 16, x: i * 10, y: Math.sin(i / 6) * 30 });
  const lib = [{ name: 'test', samples, len: 400, angle: 0, duration: 640 }];
  const p = humanizer.planMove({ x: 500, y: 500 }, { x: 500, y: 100 }, { library: lib, motion: 'recorded', noisePx: 0, speedJitter: 0 });
  assert.equal(p.method, 'recorded');
  assert.equal(p.recording, 'test');
  const last = p.samples[p.samples.length - 1];
  assert.deepEqual([last.x, last.y], [500, 100]);
  // za długie/krótkie nagranie (ponad ~5x) → krzywa syntetyczna
  const far = humanizer.planMove({ x: 0, y: 0 }, { x: 2500, y: 0 }, { library: [{ ...lib[0], len: 40 }], motion: 'recorded' });
  assert.equal(far.method, 'synthetic');
});

test('humanizer: obcina bezruch na początku i końcu nagrania', () => {
  const s = [{ t: 0, x: 5, y: 5 }, { t: 16, x: 5, y: 5 }, { t: 32, x: 5, y: 6 }, { t: 48, x: 50, y: 50 }, { t: 64, x: 100, y: 90 }, { t: 80, x: 100, y: 90 }];
  const out = humanizer.trimIdle(s);
  assert.equal(out[0].t, 0);
  assert.ok(out.length < s.length);
});

function noise(w, h, seed = 7) {
  let x = seed;
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = 40 + (x % 160);
    buf[i] = v; buf[i + 1] = (v * 3) % 255; buf[i + 2] = 255 - v; buf[i + 3] = 255;
  }
  return buf;
}

function cropRgba(buf, W, box) {
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let r = 0; r < box.h; r++) buf.copy(out, r * box.w * 4, ((box.y + r) * W + box.x) * 4, ((box.y + r) * W + box.x + box.w) * 4);
  return out;
}

test('dopasowanie wzorca: drobny tekst na dużym ekranie, co do piksela', async () => {
  const W = 1600; const H = 900;
  const words = ['Plik', 'Edycja', 'Widok', 'Zapisz', 'Otwórz', 'Wyślij', 'Anuluj', 'Pomoc', 'Ustawienia', 'Konto'];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#fbfaf7"/>`;
  let k = 0;
  for (let y = 30; y < H; y += 34) {
    for (let x = 20; x < W - 120; x += 150) {
      svg += `<rect x="${x}" y="${y - 20}" width="130" height="28" rx="4" fill="#fff" stroke="#cfcabf"/>` +
        `<text x="${x + 10}" y="${y}" font-family="Segoe UI" font-size="13" fill="#222">${words[k % words.length]} ${k}</text>`;
      k++;
    }
  }
  svg += '</svg>';
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const box = { x: 1069, y: 451, w: 132, h: 30 }; // jeden przycisk z unikalnym numerem
  const tpl = cropRgba(data, W, box);
  const m = matchTemplate(data, W, H, tpl, box.w, box.h);
  assert.equal(m.x, box.x);
  assert.equal(m.y, box.y);
  assert.ok(m.score > 0.99, `score ${m.score}`);
  assert.ok(scoreAt(data, W, H, tpl, box.w, box.h, 169, 79) < 0.95, 'sąsiedni przycisk z innym napisem ma niższy wynik');
});

test('dopasowanie wzorca: szum w małym obszarze („w pobliżu” oczekiwanej pozycji)', () => {
  const W = 320; const H = 200;
  const img = noise(W, H);
  const box = { x: 151, y: 87, w: 90, h: 30 };
  const tpl = cropRgba(img, W, box);
  const m = matchTemplate(img, W, H, tpl, box.w, box.h);
  assert.deepEqual([m.x, m.y], [box.x, box.y]);
  assert.ok(m.score > 0.99, `score ${m.score}`);
  assert.ok(scoreAt(img, W, H, tpl, box.w, box.h, 10, 10) < 0.5);
  assert.equal(diffRatio(img, img), 0);
});

test('detektor pikseli: znajduje przyciski i pole tekstowe na syntetycznym interfejsie', async () => {
  const W = 800; const H = 400;
  const buttons = [
    { x: 40, y: 40, w: 160, h: 44, fill: '#1f5f4a', text: 'Wyślij' },
    { x: 240, y: 40, w: 120, h: 44, fill: '#e8e3d8', text: 'Anuluj' },
    { x: 40, y: 140, w: 420, h: 40, fill: '#ffffff', text: '' },
  ];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f6f4ef"/>` +
    buttons.map((b) => `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5" fill="${b.fill}" stroke="#9a9488"/>` +
      (b.text ? `<text x="${b.x + 20}" y="${b.y + 28}" font-family="Segoe UI" font-size="16" fill="${b.fill === '#1f5f4a' ? '#fff' : '#222'}">${b.text}</text>` : '')).join('') +
    '<text x="40" y="250" font-family="Segoe UI" font-size="15" fill="#333">Zwykły tekst akapitu bez ramki</text></svg>';
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const r = detectCv(data, W, H, {});
  for (const b of buttons) {
    const hit = r.items.find((it) => iou(it, b) > 0.75);
    assert.ok(hit, `brak strefy dla ${JSON.stringify(b)}; mam ${JSON.stringify(r.items.map((i) => [i.x, i.y, i.w, i.h, i.kind]))}`);
  }
  assert.ok(r.items.some((it) => it.kind === 'content' && it.y > 220 && it.y < 260), 'tekst akapitu jako „treść”');
});

test('OCR: wyszukiwanie odporne na ogonki i literówki, zawężone do słów', () => {
  const w = (text, x) => ({ text, x, y: 100, w: text.length * 8, h: 14 });
  const line = [w('Wyczyść', 10), w('Wyślij', 120), w('zgłoszenie', 175)];
  const ocr = { lines: [{ text: 'Wyczyść Wyślij zgłoszenie', words: line }], phrases: splitPhrases(line), words: line };
  assert.equal(normalize('Zażółć Gęślą'), 'zazolc gesla');
  const hits = searchText(ocr, 'wyslij zgloszenie');
  assert.ok(hits.length);
  assert.equal(hits[0].text, 'Wyślij zgłoszenie');
  assert.equal(hits[0].x, 120);
  assert.ok(searchText(ocr, 'Wyślij zgloszenle').length, 'literówka OCR');
  assert.equal(searchText(ocr, 'Zapisz').length, 0);
  // duża przerwa = osobne frazy (zakładki menu w jednej linii OCR)
  const ph = splitPhrases([w('Plik', 10), w('Widok', 200), w('Pomoc', 400)]);
  assert.equal(ph.length, 3);
});

test('zrzut: mapowanie obraz ↔ ekran z przesunięciem i skalą', () => {
  const s = new Shot({ rgba: Buffer.alloc(4 * 10 * 10), width: 10, height: 10, rect: { x: 300, y: 200, w: 2560, h: 1440 } });
  s.setView(1400, 788);
  const p = s.toScreen(700, 394);
  assert.deepEqual(p, { x: 300 + 1280, y: 200 + 720 });
  const back = s.toImage(p.x, p.y);
  assert.ok(Math.abs(back.x - 700) <= 1 && Math.abs(back.y - 394) <= 1);
  const b = s.toScreenBox({ x: 100, y: 50, w: 70, h: 20 });
  assert.equal(b.w, Math.round(70 / s.view.scale));
});

test('strażnik zasłonięcia: blokuje klik w okno, które leży pod innym (tylko odczyt okien)', (t) => {
  const win32 = require('../src/core/win32');
  const { guardTarget } = require('../src/core/target');
  const scr = win32.primaryScreen();
  const p = { x: Math.round(scr.w / 2), y: Math.round(scr.h / 2) };
  const topHwnd = win32.rootHwndAt(p.x, p.y);
  const top = win32.describeWindow(topHwnd);
  const covered = win32.listWindows().find((w) => w.hwnd !== topHwnd && !w.minimized && w.pid !== top.pid &&
    p.x >= w.rect.x && p.x < w.rect.x + w.rect.w && p.y >= w.rect.y && p.y < w.rect.y + w.rect.h);
  // okno na wierzchu: przechodzi
  guardTarget({ point: p, expect: { hwnd: topHwnd, pid: top.pid, process: top.process, title: top.title } });
  if (!covered) { t.skip('brak zasłoniętego okna innej aplikacji pod środkiem ekranu'); return; }
  assert.throws(() => guardTarget({ point: p, expect: { hwnd: covered.hwnd, pid: covered.pid, process: covered.process, title: covered.title } }), /Klik zablokowany/);
});

test('klawisze: skróty zamieniane na kody klawiszy', () => {
  const c = input.parseCombo('Ctrl+Shift+S');
  assert.deepEqual(c.map((k) => k.vk), [0x11, 0x10, 0x53]);
  assert.equal(input.parseCombo('Enter')[0].vk, 0x0d);
  assert.equal(input.parseCombo('F5')[0].vk, 0x74);
  assert.throws(() => input.parseCombo('Ctrl+Zupa'), /Nieznany klawisz/);
});

test('sekwencje: zapis, zmienne {{…}}, odrzucenie numerów stref, odtwarzanie próbne', async () => {
  assert.throws(() => sequences.save({ name: 'zla', steps: [{ action: 'click', mark: 3 }] }), /mark/);
  assert.throws(() => sequences.save({ name: 'zla2', steps: [{ action: 'skacz' }] }), /nieznana akcja/);
  sequences.save({ name: 'prosta', variables: { imie: 'Ola' }, steps: [{ action: 'wait', ms: 10 }, { action: 'type', text: 'Cześć {{imie}}' }, { action: 'keys', keys: 'Enter' }] });
  const list = sequences.list();
  assert.equal(list[0].name, 'prosta');
  assert.deepEqual(list[0].variables, ['imie']);
  const r = await sequences.run('prosta', { variables: { imie: 'Hubert' }, dryRun: true });
  assert.equal(r.ok, true);
  assert.equal(r.steps[1].label, 'wpisz „Cześć Hubert”');
  sequences.save({ name: 'brak_zmiennej', steps: [{ action: 'type', text: '{{nieznana}}' }] });
  await assert.rejects(() => sequences.run('brak_zmiennej', {}), /potrzebuje zmiennych: nieznana/);
});
