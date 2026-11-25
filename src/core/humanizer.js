// Ruch myszy jak u człowieka.
// 1) recorded  — bierzemy NAGRANY ruch człowieka najbardziej podobny długością i kierunkiem,
//                obracamy/skalujemy go do nowego celu i dodajemy szum (port z bocikmexik).
// 2) synthetic — krzywa Béziera + profil min-jerk + czas z prawa Fittsa + czasem lekkie przestrzelenie.
// 3) direct    — skok (testy, tryb szybki).

function gaussian(stdev) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * stdev;
}

function rand(min, max) { return min + Math.random() * (max - min); }

function rotate(p, theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// Z bocikmexik: mapuje ścieżkę tak, by start trafił w newStart, a koniec w newEnd.
function transformPath(samples, newStart, newEnd) {
  if (!samples || samples.length < 2) return [];
  const a = samples[0];
  const b = samples[samples.length - 1];
  const recVec = { x: b.x - a.x, y: b.y - a.y };
  const newVec = { x: newEnd.x - newStart.x, y: newEnd.y - newStart.y };
  const recLen = Math.hypot(recVec.x, recVec.y);
  const newLen = Math.hypot(newVec.x, newVec.y);
  if (recLen < 1) {
    return samples.map((s, i) => {
      const t = i / (samples.length - 1);
      return { t: s.t, x: newStart.x + newVec.x * t, y: newStart.y + newVec.y * t };
    });
  }
  const scale = newLen / recLen;
  const theta = Math.atan2(newVec.y, newVec.x) - Math.atan2(recVec.y, recVec.x);
  return samples.map((s) => {
    const rot = rotate({ x: s.x - a.x, y: s.y - a.y }, theta);
    return { t: s.t, x: newStart.x + rot.x * scale, y: newStart.y + rot.y * scale };
  });
}

// Z bocikmexik: szum pozycji (największy w środku drogi) + rozrzut tempa.
function addNoise(samples, { noisePx = 2, speedJitter = 0.15 } = {}) {
  if (!samples || samples.length === 0) return [];
  const n = samples.length;
  let prevT = samples[0].t;
  let acc = 0;
  return samples.map((s, i) => {
    const k = n > 1 ? i / (n - 1) : 1;
    const center = 4 * k * (1 - k);
    const scale = 0.1 + 0.9 * center;
    const dx = noisePx > 0 ? gaussian(noisePx) * scale : 0;
    const dy = noisePx > 0 ? gaussian(noisePx) * scale : 0;
    const dt = s.t - prevT;
    prevT = s.t;
    acc += dt * (1 + (Math.random() * 2 - 1) * speedJitter);
    return { t: Math.round(acc), x: s.x + dx, y: s.y + dy };
  });
}

// Obcina „czekanie” na początku i końcu nagrania (człowiek zwykle zastyga przed ruchem).
function trimIdle(samples, eps = 2) {
  if (!samples || samples.length < 3) return samples || [];
  const first = samples[0];
  const last = samples[samples.length - 1];
  let i0 = 0;
  while (i0 < samples.length - 2 && Math.hypot(samples[i0 + 1].x - first.x, samples[i0 + 1].y - first.y) < eps) i0++;
  let i1 = samples.length - 1;
  while (i1 > i0 + 1 && Math.hypot(samples[i1 - 1].x - last.x, samples[i1 - 1].y - last.y) < eps) i1--;
  const cut = samples.slice(i0, i1 + 1);
  const t0 = cut[0].t;
  return cut.map((s) => ({ t: s.t - t0, x: s.x, y: s.y }));
}

function describePath(samples) {
  const a = samples[0];
  const b = samples[samples.length - 1];
  return {
    len: Math.hypot(b.x - a.x, b.y - a.y),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    duration: b.t - a.t,
  };
}

function angleDiff(a, b) {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

// Wybór nagrania: długość ważniejsza niż kierunek (obrót zachowuje kształt, skala zmienia tempo).
function pickRecording(library, len, angle) {
  if (!library || !library.length || len < 4) return null;
  const scored = library
    .filter((r) => r.samples && r.samples.length >= 5 && r.len >= 8)
    .map((r) => ({ r, cost: Math.abs(Math.log(r.len / len)) + 0.18 * angleDiff(r.angle, angle) }))
    .sort((a, b) => a.cost - b.cost);
  if (!scored.length || scored[0].cost > 1.7) return null;
  const top = scored.filter((s) => s.cost <= scored[0].cost + 0.25).slice(0, 3);
  return top[Math.floor(Math.random() * top.length)];
}

function minJerk(t) { return t * t * t * (10 - 15 * t + 6 * t * t); }

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function fittsMs(dist, width, speed = 1) {
  const w = Math.max(8, width || 24);
  return (90 + 135 * Math.log2(dist / w + 1)) / Math.max(0.2, speed);
}

function syntheticSegment(start, end, durationMs, { curve = 0.12, stepMs = 8 } = {}) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  const perp = dist > 0 ? { x: -dy / dist, y: dx / dist } : { x: 0, y: 0 };
  const side = Math.random() < 0.5 ? -1 : 1;
  const o1 = side * Math.abs(gaussian(curve * dist));
  const o2 = side * Math.abs(gaussian(curve * dist * 0.6)) * (Math.random() < 0.8 ? 1 : -1);
  const p1 = { x: start.x + dx * 0.3 + perp.x * o1, y: start.y + dy * 0.3 + perp.y * o1 };
  const p2 = { x: start.x + dx * 0.72 + perp.x * o2, y: start.y + dy * 0.72 + perp.y * o2 };
  const n = Math.max(4, Math.round(durationMs / stepMs));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const tau = i / n;
    const p = bezier(start, p1, p2, end, minJerk(tau));
    out.push({ t: Math.round(tau * durationMs), x: p.x, y: p.y });
  }
  return out;
}

function synthetic(start, end, { speed = 1, targetW = 24 } = {}) {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  if (dist < 2) return [{ t: 0, x: end.x, y: end.y }];
  const total = fittsMs(dist, targetW, speed) * rand(0.88, 1.12);
  // daleki ruch: często lekkie przestrzelenie i korekta (tak robi ręka)
  if (dist > 320 && Math.random() < 0.55) {
    const dir = { x: (end.x - start.x) / dist, y: (end.y - start.y) / dist };
    const over = rand(0.015, 0.045) * dist;
    const aim = { x: end.x + dir.x * over + gaussian(3), y: end.y + dir.y * over + gaussian(3) };
    const main = syntheticSegment(start, aim, total * 0.86, { curve: 0.1 });
    const fix = syntheticSegment(aim, end, Math.max(90, total * 0.22) / Math.max(0.5, speed), { curve: 0.25 });
    const t0 = main[main.length - 1].t + Math.round(rand(20, 60));
    return main.concat(fix.slice(1).map((s) => ({ ...s, t: s.t + t0 })));
  }
  return syntheticSegment(start, end, total, { curve: 0.12 });
}

// Główna funkcja: plan ruchu ze start do end.
function planMove(start, end, { library = [], motion = 'recorded', speed = 1, noisePx = 2, speedJitter = 0.15, targetW = 24 } = {}) {
  const dist = Math.hypot(end.x - start.x, end.y - start.y);
  if (motion === 'direct' || dist < 3) {
    return { samples: [{ t: 0, x: end.x, y: end.y }], method: 'direct', recording: null };
  }
  let samples = null;
  let method = 'synthetic';
  let recording = null;
  if (motion === 'recorded') {
    const pick = pickRecording(library, dist, Math.atan2(end.y - start.y, end.x - start.x));
    if (pick) {
      const rec = pick.r;
      const mapped = transformPath(rec.samples, start, end);
      // tempo: dłuższa droga trwa dłużej, ale nie proporcjonalnie (jak w prawie Fittsa)
      const k = Math.pow(dist / rec.len, 0.35) / Math.max(0.2, speed);
      samples = mapped.map((s) => ({ ...s, t: s.t * k }));
      method = 'recorded';
      recording = rec.name;
    }
  }
  if (!samples) samples = synthetic(start, end, { speed, targetW });
  samples = addNoise(samples, { noisePx: method === 'recorded' ? noisePx : noisePx * 0.5, speedJitter });
  // cel musi być trafiony dokładnie
  samples[samples.length - 1] = { ...samples[samples.length - 1], x: end.x, y: end.y };
  samples[0] = { ...samples[0], x: start.x, y: start.y };
  return { samples: samples.map((s) => ({ t: Math.max(0, Math.round(s.t)), x: Math.round(s.x), y: Math.round(s.y) })), method, recording };
}

module.exports = { planMove, transformPath, addNoise, trimIdle, describePath, pickRecording, synthetic, fittsMs, gaussian, rand };
