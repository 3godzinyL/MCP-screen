// Wszystkie ścieżki projektu. MPC_DATA_DIR pozwala odpalić testy na izolowanym stanie.
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.MPC_DATA_DIR ? path.resolve(process.env.MPC_DATA_DIR) : path.join(ROOT, 'data');

module.exports = {
  ROOT,
  DATA_DIR,
  PROFILES_DIR: path.join(DATA_DIR, 'profiles'),
  RECORDINGS_DIR: path.join(DATA_DIR, 'recordings'),
  SEQUENCES_DIR: path.join(DATA_DIR, 'sequences'),
  SHOTS_DIR: path.join(DATA_DIR, 'shots'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  EVENTS_FILE: path.join(DATA_DIR, 'events.jsonl'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  CONTROL_FILE: path.join(DATA_DIR, 'control.json'),
  HEARTBEAT_FILE: path.join(DATA_DIR, 'mcp-heartbeat.json'),
  PS_WORKER: path.join(__dirname, 'psworker.ps1'),
};
