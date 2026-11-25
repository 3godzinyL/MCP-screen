// Klient trwałego workera PowerShell (OCR Windows + UI Automation).
// Dwa osobne procesy (ocr, uia), żeby wykrywanie mogło iść równolegle.
const { spawn } = require('child_process');
const { PS_WORKER } = require('./paths');

class PsWorker {
  constructor(label) {
    this.label = label;
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_WORKER,
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error(`worker ${this.label}: start > 15 s`)), 15000);
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this.buf += chunk;
        let nl;
        while ((nl = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line.replace(/^﻿/, '')); } catch { continue; }
          if (msg.id === 0 && msg.ready) { clearTimeout(timer); resolve(true); continue; }
          const p = this.pending.get(msg.id);
          if (!p) continue;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve({ ...msg.data, ms: msg.ms });
          else p.reject(new Error(msg.error || 'błąd workera'));
        }
      });
      let errBuf = '';
      proc.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-2000); });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        const err = new Error(`worker ${this.label} zakończył się (kod ${code}) ${errBuf.trim().slice(0, 300)}`);
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        this.proc = null;
        this.ready = null;
        reject(err);
      });
    });
    this.ready.catch(() => { this.ready = null; });
    return this.ready;
  }

  async call(cmd, args = {}, timeoutMs = 20000) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker ${this.label}: ${cmd} przekroczył ${timeoutMs} ms`));
        this.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  kill() {
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } }
    this.proc = null;
    this.ready = null;
  }
}

const workers = { ocr: new PsWorker('ocr'), uia: new PsWorker('uia') };

function shutdownWorkers() {
  for (const w of Object.values(workers)) w.kill();
}
process.on('exit', shutdownWorkers);

module.exports = { workers, shutdownWorkers };
