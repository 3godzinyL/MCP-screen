// Most między interfejsem a procesem głównym — tylko wymienione kanały.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'state', 'stats', 'history', 'settings:set', 'control:stop', 'control:resume', 'profile:set',
  'elements:list', 'elements:remove', 'elements:rename', 'elements:describe', 'elements:locate', 'elements:showAll',
  'sequences:list', 'sequences:get', 'sequences:delete', 'sequences:update', 'sequences:run',
  'recordings:list', 'recordings:delete', 'recordings:preview',
  'recorder:prepare', 'recorder:start', 'recorder:stop', 'recorder:cancel',
  'overlay:set', 'overlay:ai-toggle', 'scan:run', 'scan:name',
  'manual:save', 'manual:list', 'manual:remove',
  'demo:open', 'selftest', 'import:bocik', 'open:data', 'open:root', 'clipboard', 'ai:launch', 'window:restore',
  'lesson:status', 'lesson:start', 'lesson:stop', 'lesson:goal', 'lesson:hotkey', 'lesson:list', 'lesson:get', 'lesson:update',
  'lesson:delete', 'lesson:element', 'lesson:toSequence', 'apps:list', 'apps:knowledge', 'apps:map', 'windows:list', 'learn:launch',
]);
const LISTEN = new Set([
  'event', 'refresh', 'overlay-mode', 'lesson-status', 'lesson-saved',
  'overlay:mode', 'overlay:event', 'overlay:highlight', 'overlay:zones',
  'hud:init', 'hud:state', 'hud:tick', 'hud:click', 'hud:done', 'hud:lesson',
]);
const SEND = new Set(['overlay:toolbar', 'overlay:close', 'overlay:mode']);

contextBridge.exposeInMainWorld('mpc', {
  async call(channel, arg) {
    if (!INVOKE.has(channel)) throw new Error(`kanał ${channel} niedozwolony`);
    const r = await ipcRenderer.invoke(channel, arg);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  },
  on(channel, cb) {
    if (!LISTEN.has(channel)) throw new Error(`kanał ${channel} niedozwolony`);
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  send(channel, data) {
    if (!SEND.has(channel)) throw new Error(`kanał ${channel} niedozwolony`);
    ipcRenderer.send(channel, data);
  },
});
