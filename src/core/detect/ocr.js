// OCR Windows (Windows.Media.Ocr) na zrzucie. Zwraca słowa, frazy i linie we współrzędnych EKRANU.
const fs = require('fs');
const { workers } = require('../psworker');
const { writeTempPng } = require('../image');
const { getSettings } = require('../settings');

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Linia OCR potrafi skleić odległe słowa z jednego wiersza (np. zakładki menu).
// Dzielimy ją na frazy tam, gdzie przerwa jest wyraźnie większa niż spacja.
function splitPhrases(words) {
  if (!words.length) return [];
  const sorted = [...words].sort((a, b) => a.x - b.x);
  const hAvg = sorted.reduce((s, w) => s + w.h, 0) / sorted.length;
  const gapMax = Math.max(hAvg * 0.85, 8);
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.x - (prev.x + prev.w);
    if (gap > gapMax || Math.abs((cur.y + cur.h / 2) - (prev.y + prev.h / 2)) > hAvg * 0.8) groups.push([cur]);
    else groups[groups.length - 1].push(cur);
  }
  return groups.map((g) => {
    const x0 = Math.min(...g.map((w) => w.x));
    const y0 = Math.min(...g.map((w) => w.y));
    const x1 = Math.max(...g.map((w) => w.x + w.w));
    const y1 = Math.max(...g.map((w) => w.y + w.h));
    return { text: g.map((w) => w.text).join(' '), x: x0, y: y0, w: x1 - x0, h: y1 - y0, words: g };
  });
}

async function ocrShot(shot, { lang, scale } = {}) {
  if (shot.ocr && (!lang || shot.ocr.langReq === lang)) return shot.ocr;
  const st = getSettings();
  const language = lang || st.ocrLanguage || 'auto';
  let k = scale || st.ocrScale || 2;
  // limit silnika OCR: 10 000 px na bok
  k = Math.max(1, Math.min(k, 9800 / shot.width, 9800 / shot.height));
  const t0 = Date.now();
  const file = await writeTempPng(shot.rgba, shot.width, shot.height, k);
  let res;
  try {
    res = await workers.ocr.call('ocr', { path: file, lang: language === 'auto' ? '' : language }, 30000);
  } finally {
    fs.unlink(file, () => {});
  }
  const toScreen = (b) => ({
    x: Math.round(shot.rect.x + b.x / k), y: Math.round(shot.rect.y + b.y / k),
    w: Math.max(1, Math.round(b.w / k)), h: Math.max(1, Math.round(b.h / k)),
  });
  const lines = [];
  const words = [];
  const phrases = [];
  for (const line of res.lines || []) {
    const ws = (line.words || []).map((w) => ({ text: w.t, ...toScreen(w) }));
    if (!ws.length) continue;
    words.push(...ws);
    const ps = splitPhrases(ws);
    phrases.push(...ps);
    const x0 = Math.min(...ws.map((w) => w.x));
    const y0 = Math.min(...ws.map((w) => w.y));
    const x1 = Math.max(...ws.map((w) => w.x + w.w));
    const y1 = Math.max(...ws.map((w) => w.y + w.h));
    lines.push({ text: line.text, x: x0, y: y0, w: x1 - x0, h: y1 - y0, words: ws });
  }
  shot.ocr = { langReq: lang, lang: res.lang, lines, words, phrases, ms: Date.now() - t0, scale: k };
  return shot.ocr;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 1;
}

function unionBox(ws) {
  const x0 = Math.min(...ws.map((w) => w.x));
  const y0 = Math.min(...ws.map((w) => w.y));
  const x1 = Math.max(...ws.map((w) => w.x + w.w));
  const y1 = Math.max(...ws.map((w) => w.y + w.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Szukanie napisu: dokładnie → zawiera → podobny (literówki OCR). Pudełko zawężane do pasujących słów.
function searchText(ocr, query, { exact = false, minScore = 0.72 } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const qWords = q.split(' ').length;
  const results = [];
  for (const line of ocr.lines) {
    const ws = line.words;
    const norm = ws.map((w) => normalize(w.text));
    for (let i = 0; i < ws.length; i++) {
      // od 1 słowa: OCR potrafi skleić „anna@firma.pl” w jedno słowo, które po normalizacji ma 3
      for (let len = 1; len <= Math.min(ws.length - i, qWords + 1); len++) {
        const slice = norm.slice(i, i + len).join(' ');
        if (!slice) continue;
        let score = 0;
        if (slice === q) score = 1;
        else if (!exact && slice.includes(q)) score = 0.93 - Math.min(0.2, (slice.length - q.length) / 60);
        else if (!exact) score = similarity(slice, q) * 0.92;
        if (score >= (exact ? 1 : minScore)) {
          results.push({ text: ws.slice(i, i + len).map((w) => w.text).join(' '), line: line.text, score, ...unionBox(ws.slice(i, i + len)) });
        }
      }
    }
  }
  results.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of results) {
    if (out.some((o) => Math.abs(o.x - r.x) < 6 && Math.abs(o.y - r.y) < 6)) continue;
    out.push(r);
  }
  return out;
}

module.exports = { ocrShot, searchText, normalize, similarity, splitPhrases };
