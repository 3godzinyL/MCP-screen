// Klient testowy MCP: uruchamia serwer jak zrobiłby to Claude Code (stdio) i woła narzędzia.
// Użycie: node test/mcp-client.cjs <katalog_danych> [--live] [scenariusz]
const path = require('path');
const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const ROOT = path.resolve(__dirname, '..');

async function connect(dataDir, { live = false } = {}) {
  const env = { ...process.env, MPC_DATA_DIR: dataDir };
  if (!live) env.MPC_DRY_RUN = '1';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'src', 'mcp', 'server.js')],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'mpc-test-client', version: '1.0.0' });
  await client.connect(transport);
  const stderr = [];
  if (transport.stderr) transport.stderr.on('data', (d) => stderr.push(d.toString()));
  return { client, transport, stderr };
}

function textOf(res) {
  return (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

function saveImages(res, dir, prefix) {
  const out = [];
  (res.content || []).filter((c) => c.type === 'image').forEach((c, i) => {
    const ext = c.mimeType === 'image/png' ? 'png' : 'jpg';
    const f = path.join(dir, `${prefix}${i ? `-${i}` : ''}.${ext}`);
    fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
    out.push(f);
  });
  return out;
}

module.exports = { connect, textOf, saveImages };
