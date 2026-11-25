#!/usr/bin/env node
// MPC Ekran — wiersz poleceń.
//   node src/cli.js                → serwer MCP (stdio) — tak uruchamia go Claude
//   node src/cli.js studio         → MPC Studio (program do pokazu)
//   node src/cli.js selftest       → sprawdza zrzut, OCR, UI Automation, piksele i serwer MCP
//   node src/cli.js stop | resume  → STOP / wznowienie AI (gdy Studio nie jest otwarte)
//   node src/cli.js import-bocik   → wczytuje starą kalibrację z ..\bocikmexik
//   node src/cli.js config         → gotowe polecenia do podłączenia Claude Code / Desktop
const path = require('path');
const { spawn } = require('child_process');

const cmd = (process.argv[2] || 'mcp').toLowerCase();
const ROOT = path.resolve(__dirname, '..');

async function selftest() {
  process.removeAllListeners('warning');
  process.on('warning', () => {});
  const win32 = require('./core/win32');
  const capture = require('./core/capture');
  const { ocrShot } = require('./core/detect/ocr');
  const { uiaShot } = require('./core/detect/uia');
  const { detectCv } = require('./core/detect/cv');
  const { shutdownWorkers } = require('./core/psworker');
  const rows = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try { rows.push([true, name, await fn(), Date.now() - t0]); } catch (e) { rows.push([false, name, e.message, Date.now() - t0]); }
  };
  let shot = null;
  await step('DPI procesu', async () => `${win32.dpiMode}; monitory: ${win32.listMonitors().map((m) => `${m.w}x${m.h} ${Math.round(m.scale * 100)}%`).join(', ')}`);
  await step('Zrzut ekranu', async () => { shot = await capture.capture(); return `${shot.width}x${shot.height}`; });
  await step('OCR Windows', async () => { const o = await ocrShot(shot); return `język ${o.lang}, ${o.phrases.length} fraz`; });
  await step('UI Automation', async () => { const u = await uiaShot(shot); return `${u.items.length} kontrolek w ${u.windows.length} oknach`; });
  await step('Analiza pikseli', async () => `${detectCv(shot.rgba, shot.width, shot.height, {}).items.length} kandydatów`);
  await step('Serwer MCP (stdio)', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const os = require('os');
    const fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-selftest-'));
    const t = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'mcp', 'server.js')], env: { ...process.env, MPC_DATA_DIR: tmp, MPC_DRY_RUN: '1' }, stderr: 'ignore' });
    const c = new Client({ name: 'mpc-selftest', version: '1' });
    await c.connect(t);
    const tools = await c.listTools();
    await c.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    return `${tools.tools.length} narzędzi`;
  });
  shutdownWorkers();
  for (const [ok, name, info, ms] of rows) console.log(`${ok ? '✓' : '✗'} ${name.padEnd(20)} ${info}  (${ms} ms)`);
  process.exit(rows.every((r) => r[0]) ? 0 : 1);
}

function config() {
  const server = path.join(ROOT, 'src', 'mcp', 'server.js');
  console.log('Claude Code (każdy projekt):');
  console.log(`  claude mcp add mpc-ekran -s user -- node "${server}"\n`);
  console.log('Claude Desktop (%APPDATA%\\Claude\\claude_desktop_config.json):');
  console.log(JSON.stringify({ mcpServers: { 'mpc-ekran': { command: 'node', args: [server] } } }, null, 2));
}

(async () => {
  switch (cmd) {
    case 'mcp':
    case 'server':
      require('./mcp/server');
      break;
    case 'studio': {
      const electron = require('electron');
      spawn(electron, [path.join(__dirname, 'studio', 'main.js'), ...process.argv.slice(3)], { stdio: 'inherit', detached: true }).unref();
      break;
    }
    case 'selftest':
      await selftest();
      break;
    case 'stop':
    case 'resume': {
      const { setControl } = require('./core/settings');
      const { emit } = require('./core/events');
      setControl(cmd === 'stop' ? { stop: true, reason: 'node src/cli.js stop', pauseUntil: 0 } : { stop: false, reason: '', pauseUntil: 0 });
      emit(cmd, { reason: 'cli' });
      console.log(cmd === 'stop' ? 'STOP — akcje AI zablokowane.' : 'Wznowiono — AI może działać.');
      break;
    }
    case 'import-bocik': {
      const r = require('./core/bocik').importBocik();
      console.log(`Wczytano ${r.count} stref do profilu „${r.profile}”.`);
      break;
    }
    case 'config':
      config();
      break;
    default:
      console.log('Polecenia: mcp | studio | selftest | stop | resume | import-bocik | config');
      process.exit(1);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
