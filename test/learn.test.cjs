// Nauka aplikacji: kotwice, lekcje → przepisy, nazwy/kolory, wiedza, rozpoznanie klikniętego elementu.
// Izolowany katalog danych; nic nie klika.
process.noDeprecation = true;
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-learn-'));
process.env.MPC_DATA_DIR = TMP;
process.env.MPC_DRY_RUN = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const elements = require('../src/core/elements');
const lessons = require('../src/core/lessons');
const apps = require('../src/core/apps');
const sequences = require('../src/core/sequences');
const { autoName, categoryOf, colorOf } = require('../src/core/categories');
const { Shot } = require('../src/core/capture');

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('kotwice: element jedzie z prawą/dolną krawędzią, gdy okno zmienia położenie i rozmiar', () => {
  const win0 = { x: 100, y: 100, w: 800, h: 600 };
  const okBtn = { x: 100 + 700, y: 100 + 550, w: 80, h: 30 }; // prawy dolny róg
  const toolbar = { x: 100 + 10, y: 100 + 10, w: 60, h: 24 }; // lewy górny
  const mk = (box) => ({ window: { rect: win0, rel: { x: box.x - win0.x, y: box.y - win0.y, w: box.w, h: box.h }, anchor: elements.computeAnchor(box, win0), scale: 1 } });
  const a = mk(okBtn);
  assert.deepEqual(a.window.anchor, { h: 'right', v: 'bottom' });
  const win1 = { x: 300, y: 50, w: 1000, h: 700 };
  const e = elements.expectedBox(a, win1, 1);
  assert.deepEqual(e, { x: 300 + 1000 - 100, y: 50 + 700 - 50, w: 80, h: 30 });
  const t = elements.expectedBox(mk(toolbar), win1, 1);
  assert.deepEqual(t, { x: 310, y: 60, w: 60, h: 24 });
  // skala DPI 100% → 150%: przesunięcia i rozmiar rosną
  const s = elements.expectedBox(mk(toolbar), { x: 0, y: 0, w: 1200, h: 900 }, 1.5);
  assert.deepEqual(s, { x: 15, y: 15, w: 90, h: 36 });
});

test('nazwy i kolory: typ kontrolki → kolor i czytelna nazwa bez kolizji', () => {
  assert.equal(categoryOf('Button'), 'przycisk');
  assert.equal(categoryOf('Edit'), 'pole');
  assert.equal(categoryOf('ComboBox'), 'wybor');
  assert.equal(categoryOf('TabItem'), 'menu');
  assert.equal(categoryOf('przycisk?'), 'przycisk');
  assert.match(colorOf('pole'), /^#/);
  const taken = new Set(['przycisk_wyslij_zgloszenie']);
  assert.equal(autoName('przycisk', 'Wyślij zgłoszenie', taken), 'przycisk_wyslij_zgloszenie_2');
  assert.equal(autoName('pole', 'E-mail', new Set()), 'pole_e_mail');
  assert.equal(autoName('inne', '', new Set()), 'element');
});

test('lekcja → przepis: okno, kliknięcia, tekst jako zmienna, hasło jako tajna zmienna, czekanie', () => {
  const lesson = {
    name: 'lekcja_test', goal: 'Zaloguj i wyślij', apps: ['biuro'],
    steps: [
      { i: 1, t: 0, type: 'click', app: 'biuro', element: 'pole_login', window: { process: 'electron', title: 'Biuro Pomocy — test', rect: { x: 0, y: 0, w: 800, h: 600 } }, elementInfo: { category: 'pole' } },
      { i: 2, t: 400, type: 'type', text: 'anna', field: 'pole_login' },
      { i: 3, t: 900, type: 'click', app: 'biuro', element: 'pole_haslo', window: { process: 'electron', title: 'Biuro Pomocy — test', rect: { x: 0, y: 0, w: 800, h: 600 } } },
      { i: 4, t: 1200, type: 'type', text: '', secret: true, var: 'haslo' },
      { i: 5, t: 1500, type: 'keys', keys: 'Enter' },
      { i: 6, t: 4200, type: 'click', app: 'biuro', element: 'przycisk_wyslij', window: { process: 'electron', title: 'Biuro Pomocy — test', rect: { x: 0, y: 0, w: 800, h: 600 } } },
      { i: 7, t: 4400, type: 'click', app: 'biuro', element: 'zbedny', skip: true, window: { process: 'electron', title: 'Biuro Pomocy — test', rect: { x: 0, y: 0, w: 800, h: 600 } } },
    ],
  };
  const def = lessons.toSequenceDef(lesson, {});
  const actionsList = def.steps.map((s) => s.action);
  assert.deepEqual(actionsList, ['focus', 'click', 'type', 'click', 'type', 'keys', 'wait_stable', 'click']);
  assert.equal(def.steps[0].window, 'Biuro Pomocy');
  assert.equal(def.steps[2].text, '{{pole_login}}');
  assert.equal(def.variables.pole_login, 'anna');
  assert.deepEqual(def.secrets, ['haslo']);
  assert.equal(def.steps[4].text, '{{haslo}}');
  assert.equal(def.goal, 'Zaloguj i wyślij');
  const seq = sequences.save(def);
  assert.equal(seq.goal, 'Zaloguj i wyślij');
  const listed = sequences.list().find((s) => s.name === seq.name);
  assert.ok(listed.variables.includes('haslo') && listed.variables.includes('pole_login'));
});

test('wiedza aplikacji: sekcje dopisywane i podmieniane, mapa zawiera elementy i przepisy', async () => {
  const name = 'testowa_app';
  elements.setActiveProfile(name);
  const d = elements.loadProfile(name);
  d.app = { process: 'nieistniejacy', title: 'Test' };
  elements.saveProfile(name, d);
  apps.writeKnowledge(name, 'Formularz na zakładce Nowe.', 'Ekrany');
  apps.writeKnowledge(name, 'Enter wysyła.', 'Skróty');
  apps.writeKnowledge(name, 'Formularz i lista.', 'Ekrany');
  const md = apps.readKnowledge(name);
  assert.equal((md.match(/## Ekrany/g) || []).length, 1);
  assert.match(md, /Formularz i lista\./);
  assert.doesNotMatch(md, /zakładce Nowe/);
  assert.match(md, /## Skróty\nEnter wysyła\./);
  // element do mapy
  const W = 300; const H = 200;
  const shot = new Shot({ rgba: Buffer.alloc(W * H * 4, 200), width: W, height: H, rect: { x: 0, y: 0, w: W, h: H } });
  await elements.saveFromShot(shot, { name: 'przycisk_ok', box: { x: 200, y: 150, w: 60, h: 24 }, role: 'Button', text: 'OK', profile: name, uia: { role: 'Button', name: 'OK', automationId: 'okBtn' } });
  const el = elements.loadProfile(name).elements.przycisk_ok;
  assert.equal(el.category, 'przycisk');
  assert.equal(el.uia.automationId, 'okBtn');
  sequences.save({ name: 'wyslij_test', goal: 'Wysyła formularz', profile: name, steps: [{ action: 'click', element: 'przycisk_ok' }] });
  const map = apps.compactMap(name).text;
  assert.match(map, /APLIKACJA „testowa_app”/);
  assert.match(map, /przycisk_ok \[przycisk\] „OK”/);
  assert.match(map, /wyslij_test\(\) — Wysyła formularz/);
  assert.match(map, /WIEDZA:/);
});

test('rozpoznanie klikniętego elementu bez AI: przycisk z samych pikseli', async () => {
  const W = 700; const H = 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f6f4ef"/>
    <rect x="60" y="60" width="300" height="38" rx="5" fill="#fff" stroke="#bbb"/>
    <rect x="420" y="250" width="150" height="40" rx="6" fill="#1f5f4a"/><text x="440" y="276" font-family="Segoe UI" font-size="16" fill="#fff">Wyślij</text></svg>`;
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const shot = new Shot({ rgba: data, width: W, height: H, rect: { x: 1000, y: 500, w: W, h: H } });
  const btn = await lessons.analyzeClick({ shot, point: { x: 1000 + 480, y: 500 + 268 } });
  assert.equal(btn.source, 'cv');
  assert.ok(Math.abs(btn.box.x - 1420) <= 3 && Math.abs(btn.box.y - 750) <= 3 && Math.abs(btn.box.w - 150) <= 6, JSON.stringify(btn.box));
  assert.equal(btn.category, 'przycisk');
  const field = await lessons.analyzeClick({ shot, point: { x: 1000 + 200, y: 500 + 78 } });
  assert.equal(field.category, 'pole');
  // UIA ma pierwszeństwo, gdy podało sensowny element
  const u = await lessons.analyzeClick({ shot, point: { x: 1100, y: 520 }, uiaPromise: Promise.resolve({ found: true, type: 'Button', name: 'Zapisz', id: 'save', x: 1090, y: 510, w: 80, h: 30 }) });
  assert.equal(u.source, 'uia');
  assert.equal(u.name, 'Zapisz');
  assert.equal(u.automationId, 'save');
});

test('pole z podpowiedzią to pole (nie przycisk); klik w napis przy checkboxie trafia w checkbox', async () => {
  const W = 760; const H = 300;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#ffffff"/>
    <rect x="40.5" y="40.5" width="349" height="38" rx="5" fill="#fff" stroke="#d9d5cb"/><text x="56" y="65" font-family="Segoe UI" font-size="15" fill="#8a8a8a">np. Anna Kowalska</text>
    <rect x="460" y="40" width="150" height="40" rx="6" fill="#fff" stroke="#cfcabf"/><text x="500" y="66" font-family="Segoe UI" font-size="15" fill="#222">Wyczyść</text>
    <rect x="40.5" y="180.5" width="15" height="15" rx="2" fill="#fff" stroke="#777"/>
    <text x="66" y="193" font-family="Segoe UI" font-size="14" fill="#222">Akceptuję regulamin obsługi zgłoszeń</text></svg>`;
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const shot = new Shot({ rgba: data, width: W, height: H, rect: { x: 0, y: 0, w: W, h: H }, window: { rect: { x: 0, y: 0, w: W, h: H } } });
  assert.equal((await lessons.analyzeClick({ shot, point: { x: 120, y: 60 } })).category, 'pole');
  assert.equal((await lessons.analyzeClick({ shot, point: { x: 535, y: 60 } })).category, 'przycisk');
  // UIA zwraca checkbox „przez etykietę” (via=label): przyjmujemy tylko klik w sam napis, nie w puste miejsce obok
  const cb = { found: true, type: 'CheckBox', name: 'Akceptuję regulamin obsługi zgłoszeń', id: 'f-terms', via: 'label', x: 40, y: 180, w: 16, h: 16 };
  const onText = await lessons.analyzeClick({ shot, point: { x: 150, y: 188 }, uiaPromise: Promise.resolve(cb) });
  assert.equal(onText.source, 'uia');
  assert.equal(onText.category, 'wybor');
  const onEmpty = await lessons.analyzeClick({ shot, point: { x: 560, y: 188 }, uiaPromise: Promise.resolve(cb) });
  assert.notEqual(onEmpty.source, 'uia');
});

test('lekcje: zapis, lista, obraz kroku', async () => {
  const W = 40; const H = 30;
  const shot = new Shot({ rgba: Buffer.alloc(W * H * 4, 128), width: W, height: H, rect: { x: 0, y: 0, w: W, h: H } });
  const file = await lessons.saveStepImage('lekcja_zapis', 1, shot);
  lessons.save({ name: 'lekcja_zapis', goal: 'test', apps: ['x'], createdAt: new Date().toISOString(), steps: [{ i: 1, t: 0, type: 'keys', keys: 'Enter', shot: file }] });
  const l = lessons.list().find((x) => x.name === 'lekcja_zapis');
  assert.equal(l.steps, 1);
  assert.ok(fs.existsSync(lessons.stepImagePath('lekcja_zapis', file)));
  assert.equal(lessons.remove('lekcja_zapis'), true);
});
