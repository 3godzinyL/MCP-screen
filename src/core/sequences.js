// Sekwencje kliknięć: zapis (JSON), odtwarzanie krok po kroku i nagrywanie tego, co robi AI.
// Plik: data/sequences/<nazwa>.json
//
// Kroki (pole "action"):
//   click   {element|text|x,y, button?, double?}      move  {element|text|x,y}
//   type    {text, element?/text_target?, clear?, enter?}
//   keys    {keys:"Ctrl+S", repeat?}                    scroll {direction, amount, element?}
//   drag    {from:{...}, to:{...}}                      wait  {ms}
//   wait_for {element|text, gone?, timeout_ms?}         wait_stable {timeout_ms?}
//   focus   {window}                                    run   {sequence, variables?}
// W polach tekstowych działa {{zmienna}} — wartości z "variables" albo podane przy uruchomieniu.
const fs = require('fs');
const path = require('path');
const { SEQUENCES_DIR } = require('./paths');
const { readJson, writeJson, ensureDir, safeName } = require('./json');
const actions = require('./actions');
const input = require('./input');
const elements = require('./elements');
const capture = require('./capture');
const { getSettings, withDryRun } = require('./settings');
const { emit } = require('./events');
const { rand } = require('./humanizer');

const ACTIONS = ['click', 'move', 'type', 'keys', 'scroll', 'drag', 'wait', 'wait_for', 'wait_stable', 'focus', 'run'];

function file(name) { return path.join(SEQUENCES_DIR, `${safeName(name)}.json`); }

function list() {
  try {
    return fs.readdirSync(SEQUENCES_DIR).filter((f) => f.endsWith('.json')).map((f) => {
      const d = readJson(path.join(SEQUENCES_DIR, f), null);
      if (!d) return null;
      return {
        name: d.name || f.replace(/\.json$/, ''), description: d.description || '', steps: (d.steps || []).length,
        profile: d.profile || '', createdBy: d.createdBy || '', variables: Object.keys(d.variables || {}),
        updatedAt: d.updatedAt || d.createdAt || null, runs: d.stats ? d.stats.runs : 0,
      };
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  } catch {
    return [];
  }
}

function get(name) {
  const d = readJson(file(name), null);
  if (!d) {
    const names = list().map((s) => s.name);
    throw new Error(`Nie ma sekwencji „${name}”. Dostępne: ${names.join(', ') || '(brak)'}`);
  }
  return d;
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('Sekwencja potrzebuje co najmniej jednego kroku');
  steps.forEach((s, i) => {
    if (!s || !ACTIONS.includes(s.action)) throw new Error(`Krok ${i + 1}: nieznana akcja „${s && s.action}”. Dozwolone: ${ACTIONS.join(', ')}`);
    if (s.mark !== undefined) throw new Error(`Krok ${i + 1}: numer strefy (mark) żyje tylko do następnego zrzutu — zapisz element (label_elements) i użyj "element"`);
  });
  return steps;
}

function save(def) {
  const name = safeName(def.name);
  if (!name) throw new Error('Sekwencja musi mieć nazwę');
  const prev = readJson(file(name), null);
  const data = {
    version: 1,
    name,
    description: def.description || (prev && prev.description) || '',
    profile: def.profile || (prev && prev.profile) || elements.activeProfile(),
    createdBy: def.createdBy || (prev && prev.createdBy) || 'ai',
    variables: def.variables || (prev && prev.variables) || {},
    steps: validateSteps(def.steps),
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stats: prev && prev.stats ? prev.stats : { runs: 0, ok: 0, lastRun: null },
  };
  ensureDir(SEQUENCES_DIR);
  writeJson(file(name), data);
  emit('sequence-saved', { name, steps: data.steps.length, createdBy: data.createdBy });
  return data;
}

function remove(name) {
  const f = file(name);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  emit('sequence-deleted', { name });
  return true;
}

function substitute(value, vars) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = substitute(v, vars);
    return o;
  }
  return value;
}

function targetOf(step) {
  const t = {};
  for (const k of ['element', 'x', 'y', 'space', 'offset_x', 'offset_y', 'profile', 'occurrence', 'window', 'exact']) {
    if (step[k] !== undefined) t[k] = step[k];
  }
  // w kroku "type" pole "text" to tekst do wpisania; cel-napis podaje się jako "text_target"
  if (step.action !== 'type' && step.text !== undefined) t.text = step.text;
  if (step.text_target !== undefined) t.text = step.text_target;
  if (t.x !== undefined && !t.space) t.space = 'screen';
  return t;
}

async function runStep(step, vars, depth) {
  const s = substitute(step, vars);
  switch (s.action) {
    case 'click': return actions.doClick(targetOf(s), { button: s.button, double: s.double, verify: s.verify });
    case 'move': return actions.doMove(targetOf(s));
    case 'type': return actions.doType(s.text, { target: targetOf(s), clear: s.clear, enter: s.enter });
    case 'keys': return actions.doKeys(s.keys, { repeat: s.repeat });
    case 'scroll': return actions.doScroll({ target: targetOf(s), direction: s.direction, amount: s.amount });
    case 'drag': return actions.doDrag({ space: 'screen', ...s.from }, { space: 'screen', ...s.to });
    case 'wait': await input.sleep(Math.min(120000, Number(s.ms) || 500)); return { action: 'wait', ms: s.ms };
    case 'wait_for': {
      const r = await actions.doWaitFor({ element: s.element, text: s.text, gone: s.gone, timeout_ms: s.timeout_ms, window: s.window });
      if (!r.ok) throw new Error(`Nie doczekałem się: ${r.what}${r.gone ? ' (zniknięcia)' : ''} w ${r.ms} ms`);
      return r;
    }
    case 'wait_stable': return actions.doWaitStable({ timeout_ms: s.timeout_ms });
    case 'focus': return actions.doFocus({ window: s.window, maximize: s.maximize });
    case 'run': {
      if (depth > 4) throw new Error('Za głębokie zagnieżdżenie sekwencji');
      const r = await run(s.sequence, { variables: { ...vars, ...(s.variables || {}) }, depth: depth + 1 });
      if (!r.ok) throw new Error(`Podsekwencja ${s.sequence} padła na kroku ${r.failedStep}`);
      return { action: 'run', sequence: s.sequence, steps: r.steps.length };
    }
    default: throw new Error(`Nieznana akcja ${s.action}`);
  }
}

function stepLabel(s) {
  const t = s.element ? `„${s.element}”` : s.text_target ? `napis „${s.text_target}”` : (s.action !== 'type' && s.text) ? `napis „${s.text}”` : s.x !== undefined ? `(${s.x},${s.y})` : '';
  switch (s.action) {
    case 'click': return `${s.double ? 'dwuklik' : 'klik'} ${t}`;
    case 'type': return `wpisz „${String(s.text).slice(0, 40)}”${t ? ` w ${t}` : ''}`;
    case 'keys': return `klawisze ${s.keys}`;
    case 'wait': return `czekaj ${s.ms} ms`;
    case 'wait_for': return `czekaj na ${t}${s.gone ? ' (zniknięcie)' : ''}`;
    case 'focus': return `okno „${s.window}”`;
    case 'run': return `sekwencja ${s.sequence}`;
    default: return `${s.action} ${t}`;
  }
}

async function run(name, { variables = {}, dryRun, fromStep = 1, toStep, stopOnError = true, depth = 0 } = {}) {
  const def = get(name);
  const vars = { ...(def.variables || {}), ...variables };
  const missing = new Set();
  JSON.stringify(def.steps).replace(/\{\{\s*([\p{L}\p{N}_]+)\s*\}\}/gu, (m, k) => { if (vars[k] === undefined) missing.add(k); return m; });
  if (missing.size) throw new Error(`Sekwencja ${name} potrzebuje zmiennych: ${[...missing].join(', ')}`);

  return withDryRun(dryRun, async () => {
    const prevProfile = elements.activeProfile();
    const st = getSettings();
    const steps = def.steps;
    const last = Math.min(steps.length, toStep || steps.length);
    const report = [];
    const t0 = Date.now();
    emit('sequence-start', { name, steps: steps.length, from: fromStep, to: last, dry: !!st.dryRun, depth });
    let failedStep = null;
    for (let i = Math.max(1, fromStep); i <= last; i++) {
      const step = steps[i - 1];
      const label = stepLabel(substitute(step, vars));
      emit('sequence-step', { name, i, total: last, label, status: 'start', dry: !!st.dryRun });
      const ts = Date.now();
      try {
        const res = await runStep({ profile: def.profile, ...step }, vars, depth);
        report.push({ i, ok: true, label, ms: Date.now() - ts, ...(res && res.changed !== undefined && res.changed !== null ? { changed: res.changed } : {}), ...(res && res.info && res.info.moved ? { moved: true } : {}) });
        emit('sequence-step', { name, i, total: last, label, status: 'ok', ms: Date.now() - ts });
      } catch (err) {
        report.push({ i, ok: false, label, ms: Date.now() - ts, error: err.message });
        emit('sequence-step', { name, i, total: last, label, status: 'fail', error: err.message });
        if (err.stopped || stopOnError) { failedStep = i; break; }
      }
      if (i < last && step.action !== 'wait') await input.sleep(Math.round(rand(140, 420) / Math.max(0.3, st.speed)));
    }
    const ok = failedStep === null && report.every((r) => r.ok);
    if (depth === 0) {
      const d = readJson(file(name), null);
      if (d) {
        d.stats = { runs: ((d.stats && d.stats.runs) || 0) + 1, ok: ((d.stats && d.stats.ok) || 0) + (ok ? 1 : 0), lastRun: new Date().toISOString(), lastOk: ok };
        writeJson(file(name), d);
      }
    }
    emit('sequence-end', { name, ok, failedStep, ms: Date.now() - t0, dry: !!st.dryRun, depth });
    if (elements.activeProfile() !== prevProfile) elements.setActiveProfile(prevProfile);
    return { name, ok, failedStep, ms: Date.now() - t0, dry: !!st.dryRun, steps: report };
  });
}

// ── Nagrywanie tego, co robi AI ───────────────────────────────────────────
const rec = { active: false, name: '', description: '', profile: '', steps: [], startedAt: 0, autoCount: 0 };

function recordStart(name, description = '') {
  const n = safeName(name);
  if (!n) throw new Error('Podaj nazwę nagrywanej sekwencji');
  Object.assign(rec, { active: true, name: n, description, profile: elements.activeProfile(), steps: [], startedAt: Date.now(), autoCount: 0 });
  emit('sequence-record', { status: 'start', name: n });
  return { ...rec };
}

function recordStatus() {
  return { active: rec.active, name: rec.name, steps: rec.steps.length, list: rec.steps.map(stepLabel), since: rec.startedAt };
}

function recordCancel() {
  const n = rec.steps.length;
  rec.active = false;
  rec.steps = [];
  emit('sequence-record', { status: 'cancel', name: rec.name });
  return n;
}

function recordStop({ save: doSave = true, name, description } = {}) {
  if (!rec.active) throw new Error('Nagrywanie nie jest włączone');
  rec.active = false;
  const steps = rec.steps;
  rec.steps = [];
  emit('sequence-record', { status: 'stop', name: name || rec.name, steps: steps.length });
  if (!doSave) return { saved: false, steps };
  if (!steps.length) throw new Error('Nagranie jest puste — nic nie zostało wykonane');
  return { saved: true, sequence: save({ name: name || rec.name, description: description || rec.description, profile: rec.profile, steps, createdBy: 'ai' }) };
}

// Cel „ulotny” (numer strefy, współrzędne z obrazka) zamieniamy na trwały element z wycinkiem,
// żeby nagrana sekwencja zadziałała jutro, gdy okno będzie gdzie indziej.
async function persistTarget(t, resolved) {
  if (t.element) return { element: t.element };
  if (t.text && resolved.kind === 'text') return { text: t.text, ...(t.occurrence ? { occurrence: t.occurrence } : {}) };
  const shotId = resolved.info && resolved.info.shot;
  let shot = null;
  try { shot = shotId ? capture.getShot(shotId) : null; } catch { shot = null; }
  let box = resolved.box;
  if (box.w < 8 || box.h < 8) box = { x: resolved.point.x - 22, y: resolved.point.y - 14, w: 44, h: 28 };
  if (!shot || !shot.containsScreen(box.x, box.y) || !shot.containsScreen(box.x + box.w - 1, box.y + box.h - 1)) {
    shot = await capture.capture({ rect: actions.around(box, 0) });
  }
  rec.autoCount++;
  const name = `${rec.name}_k${rec.steps.length + 1}`.slice(0, 64);
  const text = resolved.info && resolved.info.text ? resolved.info.text : '';
  await elements.saveFromShot(shot, { name, box, description: `auto z nagrania ${rec.name}${text ? `: ${text}` : ''}`, source: 'ai-record', text, profile: rec.profile });
  // "at" to tylko informacja dla człowieka — odtwarzanie szuka elementu po wyglądzie
  return { element: name, at: { x: resolved.point.x, y: resolved.point.y } };
}

async function recordAction(step, { target, resolved } = {}) {
  if (!rec.active) return null;
  let s = { ...step };
  if (target && resolved) {
    const persisted = await persistTarget(target, resolved);
    if (step.action === 'type' && persisted.text) { s.text_target = persisted.text; delete persisted.text; }
    s = { ...s, ...persisted };
  }
  rec.steps.push(s);
  emit('sequence-record', { status: 'step', name: rec.name, i: rec.steps.length, label: stepLabel(s) });
  return s;
}

function isRecording() { return rec.active; }

module.exports = { list, get, save, remove, run, recordStart, recordStop, recordCancel, recordStatus, recordAction, isRecording, stepLabel, ACTIONS };
