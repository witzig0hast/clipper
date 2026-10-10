'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell,
  session, screen, nativeImage, Notification,
} = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const settingsStore = require('./settings');
const { detectGame, listProcesses, DEFAULT_GAMES } = require('./games');
const timeline = require('./timeline');
const exporter = require('./exporter');
const { ObsEngine } = require('./obs');

const APP_ID = 'de.hastnetwork.clipper';
const SELFTEST = process.argv.includes('--selftest');   // CI: komplette App mit Testquelle durchspielen
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

// Unerwartete Fehler nie als Dialog zeigen (das könnte ein Spiel in den Hintergrund holen) – nur protokollieren.
process.on('uncaughtException', (e) => { logLines.push(`uncaughtException: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); });
process.on('unhandledRejection', (e) => { logLines.push(`unhandledRejection: ${e && e.message ? e.message : e}`); });

// Die Oberfläche braucht keine GPU – so konkurriert Clipper nie mit dem Spiel um die Grafikkarte.
app.disableHardwareAcceleration();
app.setAppUserModelId(APP_ID);
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let tray = null;
let quitting = false;
let ffmpeg = null;
let encoder = 'libx264';
let hwEncoder = null;
let engine = null;
let hwReady = Promise.resolve();
const logLines = [];

// ---- Zustand ---------------------------------------------------------------
const state = {
  game: null,          // erkannter Spiel-Prozess
  override: null,      // true/false = manuell erzwungen, null = automatisch
  engineKey: '',       // Konfiguration, mit der die Aufnahme gerade läuft
  error: null,
  notice: null,        // z. B. automatische Entlastung
  exports: 0,
  lastDesired: false,
  crashes: 0,
};
const pinned = new Set();
let bufferDir = null;

// ---- Hilfsfunktionen -------------------------------------------------------
const cfg = () => settingsStore.get();
const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};
const toast = (message, kind = 'info') => send('toast', { message, kind });

function modeWantsRecording() {
  const m = cfg().mode;
  if (m === 'always') return true;
  if (m === 'auto') return !!state.game;
  return false;
}
const desired = () => (state.override !== null ? state.override : modeWantsRecording());

function publicState() {
  return {
    recording: !!engine.running,
    starting: !!engine.starting,
    desired: desired(),
    mode: cfg().mode,
    override: state.override,
    game: state.game,
    bufferSeconds: engine.bufferedSeconds(),
    bufferBytes: engine.bytes(),
    bufferMax: cfg().bufferMinutes * 60,
    encoder,
    hwEncoder,
    gpuEncoder: engine.encoders ? (['nvenc', 'amd', 'qsv'].find((v) => engine.encoders[v]) || null) : undefined,
    capture: engine.running ? { enc: engine.encoder, mode: engine.encPlan && engine.encPlan.mode, id: engine.encPlan && engine.encPlan.id } : null,
    degrade: engine.degrade,
    notice: state.notice,
    obsAvailable: engine.available,
    diag: {
      platform: process.platform, hw: hwEncoder, plan: engine.encPlan || null, stats: engine.stats, degrade: engine.degrade,
      obs: engine.obs ? engine.obs.exe : null, log: logLines.slice(-25).join('\n'),
    },
    error: state.error,
    exports: state.exports,
    clipsDir: cfg().clipsDir,
  };
}
const broadcastState = () => { send('state', publicState()); updateTray(); };

const HW_MAP = { h264_nvenc: 'nvenc', h264_amf: 'amd', h264_qsv: 'qsv' };

function displays() {
  return screen.getAllDisplays().map((d, i) => ({
    index: i, id: d.id, primary: d.id === screen.getPrimaryDisplay().id,
    name: d.label || `Bildschirm ${i + 1}`,
    width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor),
  }));
}

/** Einstellungen für die OBS-Engine. */
function engineConfig() {
  const s = cfg();
  const list = displays();
  const d = list.find((x) => x.index === s.screenIndex) || list.find((x) => x.primary) || list[0];
  return {
    fps: s.fps, height: s.resolution === 'native' ? null : Number(s.resolution), bitrateMbps: s.bitrateMbps,
    encoder: s.encoder, hw: HW_MAP[hwEncoder] || null, systemAudio: s.systemAudio, micAudio: s.micAudio,
    captureMode: s.captureMode, baseW: d ? d.width : 1920, baseH: d ? d.height : 1080, monitorIndex: d ? d.index : 0,
    gameExe: state.game || null,
    testSource: SELFTEST,
  };
}
const engineKeyOf = (c) => JSON.stringify([c.fps, c.height, c.bitrateMbps, c.encoder, c.hw, c.systemAudio, c.micAudio, c.captureMode, c.baseW, c.baseH, c.monitorIndex]); // gameExe bewusst nicht enthalten: Spielwechsel läuft live (setGame)

// ---- Puffer ----------------------------------------------------------------
function pruneBuffer() { engine.prune(cfg().bufferMinutes * 60, (f) => pinned.has(f)); }

// ---- Aufnahme-Steuerung ----------------------------------------------------
let engineQueue = Promise.resolve();
function syncEngine() {
  engineQueue = engineQueue.then(async () => {
    const want = desired();
    if (want) await hwReady;
    const c = want ? engineConfig() : null;
    const key = want ? engineKeyOf(c) : '';
    if (want && engine.running && key === state.engineKey) return;
    if (!want && !engine.running && !engine.starting) { state.engineKey = ''; broadcastState(); return; }
    if (engine.running) await engine.stop();
    state.engineKey = '';
    if (want) {
      try {
        if (!state.lastDesired) engine.clear();
        await engine.start(c);
        state.engineKey = key; state.error = null; state.crashes = 0;
      } catch (e) { state.error = e.message; toast(`Aufnahme-Fehler: ${e.message}`, 'error'); }
    }
    state.lastDesired = want;
    broadcastState();
  }).catch((e) => { logLines.push(`syncEngine: ${e.message}`); });
  return engineQueue;
}

function applyRecording() {
  const want = desired();
  if (want && !state.lastDesired) { state.error = null; state.notice = null; engine.degrade = 0; }
  syncEngine();
  broadcastState();
}

async function pollGame() {
  const s = cfg();
  const found = await detectGame(s.games).catch(() => null);
  if (found !== state.game) {
    state.game = found;
    state.override = null; // neues Spiel / Spielende -> wieder automatisch
    if (engine.running && found) engine.setGame(found);
    applyRecording();
  }
}

// ---- Clips -----------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
const safeName = (n) => n.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
function uniquePath(dir, base, ext = '.mp4') {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');
function thumbPath(file, mtimeMs) {
  const h = crypto.createHash('md5').update(`${file}|${mtimeMs}`).digest('hex');
  return path.join(thumbsDir(), `${h}.jpg`);
}
async function ensureThumb(file) {
  const st = await fs.promises.stat(file);
  const tp = thumbPath(file, st.mtimeMs);
  if (!fs.existsSync(tp)) {
    await fs.promises.mkdir(thumbsDir(), { recursive: true });
    await exporter.makeThumbnail(ffmpeg, file, tp, 1).catch(() => exporter.makeThumbnail(ffmpeg, file, tp, 0));
  }
  return tp;
}
const exportOpts = (onProgress) => {
  const s = cfg();
  return { fps: s.fps, bitrateMbps: s.bitrateMbps, encoder, onProgress };
};

function notifyClip(title, body) {
  if (!cfg().notify || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: true });
  n.on('click', () => showWindow('clips'));
  n.show();
}

async function createClip(seconds) {
  const s = cfg();
  seconds = Math.max(3, Math.min(Number(seconds) || s.hotkeySeconds, s.bufferMinutes * 60));
  state.exports++; broadcastState();
  const id = crypto.randomUUID();
  const pin = [];
  try {
    const tl = await engine.timeline();
    const plan = timeline.planTail(tl, seconds);
    if (!plan.parts.length) throw new Error('Der Puffer ist noch leer – es läuft noch keine Aufnahme.');
    for (const p of plan.parts) { pinned.add(p.file); pin.push(p.file); }
    await fs.promises.mkdir(s.clipsDir, { recursive: true });
    const game = state.game ? ` ${state.game.replace(/\.exe$/i, '')}` : '';
    const out = uniquePath(s.clipsDir, `Clip ${stamp()}${game}`);
    const label = 'Clip wird gespeichert …';
    send('export:progress', { id, label, progress: 0 });
    const duration = await exporter.exportClipCopy(ffmpeg, plan, out, { onProgress: (p) => send('export:progress', { id, label, progress: p }) });
    send('export:progress', { id, done: true });
    ensureThumb(out).then(() => send('clips:changed')).catch(() => {});
    const info = { file: out, name: path.basename(out), duration };
    send('clip:saved', info);
    send('clips:changed');
    notifyClip('Clip gespeichert', `${path.basename(out)} (${Math.round(duration)} s)`);
    return info;
  } catch (e) {
    send('export:progress', { id, done: true });
    toast(`Clip fehlgeschlagen: ${e.message.split('\n')[0]}`, 'error');
    notifyClip('Clip fehlgeschlagen', e.message.split('\n')[0]);
    throw e;
  } finally {
    for (const f of pin) pinned.delete(f);
    state.exports--; broadcastState();
  }
}

async function listClips() {
  const dir = cfg().clipsDir;
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out = [];
  const missing = [];
  for (const n of names) {
    if (!/\.mp4$/i.test(n)) continue;
    const file = path.join(dir, n);
    let st; try { st = await fs.promises.stat(file); } catch { continue; }
    const tp = thumbPath(file, st.mtimeMs);
    const has = fs.existsSync(tp);
    if (!has) missing.push(file);
    out.push({
      file, name: n.replace(/\.mp4$/i, ''), size: st.size, mtime: st.mtimeMs,
      url: pathToFileURL(file).href, thumb: has ? pathToFileURL(tp).href : null,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  if (missing.length) {
    (async () => {
      for (const f of missing.slice(0, 40)) await ensureThumb(f).catch(() => {});
      send('clips:changed');
    })();
  }
  return out;
}

// ---- Fenster / Tray --------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 940, minHeight: 620,
    show: false, backgroundColor: '#0b0d14', title: 'Clipper', icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d14', symbolColor: '#c9cfe3', height: 40 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') && !cfg().startHidden) win.show();
  });
}

function showWindow(page) {
  if (!win) return;
  win.show(); win.focus();
  if (page) send('navigate', page);
}

function updateTray() {
  if (!tray) return;
  const rec = engine.running;
  tray.setToolTip(rec ? `Clipper – nimmt auf${state.game ? ` (${state.game})` : ''}` : 'Clipper – Aufnahme pausiert');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Clipper öffnen', click: () => showWindow() },
    { label: `Clip speichern (letzte ${cfg().hotkeySeconds} s)`, enabled: rec, click: () => createClip(cfg().hotkeySeconds).catch(() => {}) },
    { type: 'separator' },
    { label: desired() ? 'Aufnahme pausieren' : 'Aufnahme starten', click: toggleRecording },
    { type: 'separator' },
    { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
  ]));
}

function toggleRecording() {
  state.override = !desired();
  applyRecording();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const acc = cfg().hotkey;
  if (!acc) return true;
  try {
    const ok = globalShortcut.register(acc, () => { createClip(cfg().hotkeySeconds).catch(() => {}); });
    if (!ok) toast(`Hotkey ${acc} ist bereits belegt.`, 'error');
    return ok;
  } catch {
    toast(`Ungültiger Hotkey: ${acc}`, 'error');
    return false;
  }
}

function applyStartup() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: cfg().openAtLogin, args: ['--hidden'] });
}

// ---- IPC -------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('settings:get', () => cfg());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const before = cfg();
    const next = settingsStore.update(patch);
    if ('hotkey' in patch) registerHotkey();
    if ('openAtLogin' in patch) applyStartup();
    if ('encoder' in patch) encoder = next.encoder === 'cpu' ? 'libx264' : (hwEncoder || 'libx264');
    if ('bufferMinutes' in patch) pruneBuffer();
    if ('clipsDir' in patch) send('clips:changed');
    if ('mode' in patch && patch.mode !== before.mode) { state.override = null; await pollGame(); }
    if (['mode', 'fps', 'resolution', 'bitrateMbps', 'systemAudio', 'micAudio', 'screenIndex', 'captureMode', 'encoder']
      .some((k) => k in patch)) applyRecording();
    else broadcastState();
    return next;
  });
  ipcMain.handle('games:defaults', () => DEFAULT_GAMES);
  ipcMain.handle('state:get', () => publicState());
  ipcMain.handle('recording:toggle', () => { toggleRecording(); return publicState(); });
  ipcMain.handle('clip:create', (_e, seconds) => createClip(seconds));
  ipcMain.handle('clips:list', () => listClips());
  ipcMain.handle('clips:delete', async (_e, file) => {
    if (path.dirname(file) !== path.resolve(cfg().clipsDir)) throw new Error('Datei liegt nicht im Clip-Ordner.');
    await shell.trashItem(file);
    send('clips:changed');
  });
  ipcMain.handle('clips:rename', async (_e, file, name) => {
    const base = safeName(name);
    if (!base) throw new Error('Ungültiger Name.');
    const dir = path.dirname(file);
    if (dir !== path.resolve(cfg().clipsDir)) throw new Error('Datei liegt nicht im Clip-Ordner.');
    const dest = path.join(dir, base + '.mp4');
    if (dest !== file && fs.existsSync(dest)) throw new Error('Es gibt schon einen Clip mit diesem Namen.');
    await fs.promises.rename(file, dest);
    send('clips:changed');
    return dest;
  });
  ipcMain.handle('clips:show', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('clips:open-folder', async () => {
    await fs.promises.mkdir(cfg().clipsDir, { recursive: true });
    return shell.openPath(cfg().clipsDir);
  });
  ipcMain.handle('clips:trim', async (_e, { file, start, end, name }) => {
    const dir = path.dirname(file);
    const base = safeName(name || `${path.basename(file, '.mp4')} (gekürzt)`);
    const out = uniquePath(dir, base);
    const id = crypto.randomUUID();
    state.exports++; broadcastState();
    try {
      send('export:progress', { id, label: 'Schnitt wird exportiert …', progress: 0 });
      await exporter.trimClip(ffmpeg, file, out, start, end, exportOpts((p) => send('export:progress', { id, label: 'Schnitt wird exportiert …', progress: p })));
      send('export:progress', { id, done: true });
      await ensureThumb(out).catch(() => {});
      send('clips:changed');
      toast('Neuer Clip gespeichert', 'success');
      return { file: out };
    } catch (e) {
      send('export:progress', { id, done: true });
      toast(`Schnitt fehlgeschlagen: ${e.message.split('\n')[0]}`, 'error');
      throw e;
    } finally { state.exports--; broadcastState(); }
  });
  ipcMain.handle('screens:list', () => displays());
  ipcMain.handle('processes:list', () => listProcesses());
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cfg().clipsDir });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.on('renderer:ready', () => { applyRecording(); });
}

function setupSecurity() {
  // Die Oberfläche braucht weder Kamera/Mikro noch Bildschirmzugriff – alles verweigern.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
}

// ---- Start -----------------------------------------------------------------
app.on('second-instance', () => showWindow());
let shuttingDown = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (!shuttingDown && engine && (engine.running || engine.starting || engine.proc)) {
    e.preventDefault(); shuttingDown = true;
    Promise.race([engine.stop(), new Promise((r) => setTimeout(r, 8000))]).finally(() => app.quit());
  }
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { fs.rmSync(bufferDir, { recursive: true, force: true }); } catch { /* egal */ }
});
app.on('window-all-closed', () => { /* im Tray weiterlaufen */ });

app.whenReady().then(async () => {
  ffmpeg = exporter.resolveFfmpeg();
  bufferDir = path.join(app.getPath('userData'), 'buffer');
  fs.rmSync(bufferDir, { recursive: true, force: true });
  fs.mkdirSync(bufferDir, { recursive: true });
  engine = new ObsEngine({
    ffmpeg, dir: bufferDir, configBase: path.join(app.getPath('userData'), 'obs'),
    obsRoots: [path.join(process.resourcesPath || '', 'obs')],
    pidFile: path.join(app.getPath('userData'), 'obs.pid'),
    log: (m) => { logLines.push(m.slice(0, 300)); if (logLines.length > 200) logLines.splice(0, 100); },
  });
  engine.cleanupStale();
  engine.on('started', () => broadcastState());
  engine.on('stopped', () => broadcastState());
  engine.on('crashed', (msg) => {
    logLines.push(`CRASH: ${msg}`);
    if (!desired() || state.crashes >= 3) { state.error = `${msg} Aufnahme wurde beendet.`; toast(state.error, 'error'); broadcastState(); return; }
    state.crashes++;
    toast(`${msg} Neustart (${state.crashes}/3) …`, 'error');
    state.engineKey = '';
    setTimeout(() => syncEngine(), 3000 * state.crashes);
  });
  engine.on('overload', ({ ratio }) => {
    if (engine.stepDown()) {
      state.notice = engine.degrade === 1 ? 'PC stark ausgelastet – Clipper hat auf höchstens 30 FPS reduziert.' : 'PC stark ausgelastet – Clipper hat auf 720p/30 FPS reduziert.';
      toast(state.notice, 'info');
      state.engineKey = '';
      syncEngine();
    } else if (!state.notice || !/Notbremse/.test(state.notice)) {
      state.notice = 'Notbremse: Der PC ist trotz minimaler Einstellungen stark ausgelastet. Aufnahme pausiert.';
      toast(state.notice, 'error');
      state.override = false; applyRecording();
    }
  });
  settingsStore.get();
  setupIpc();
  setupSecurity();
  createWindow();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', () => showWindow());
  updateTray();
  registerHotkey();
  applyStartup();

  // Grafikkarten-Encoder im Hintergrund testen (vor dem ersten Aufnahmestart abgewartet)
  hwReady = Promise.all([
    exporter.detectEncoder(ffmpeg).then((enc) => {
      hwEncoder = enc === 'libx264' ? null : enc;
      encoder = cfg().encoder === 'cpu' ? 'libx264' : enc;
      broadcastState();
    }).catch(() => {}),
    // OBS meldet selbst, welche Hardware-Encoder auf diesem PC funktionieren
    engine.detectEncoders().then(() => broadcastState()).catch(() => {}),
  ]);

  setInterval(() => pollGame().catch(() => {}), 8000);
  setInterval(() => { if (win && win.isVisible() && !win.isMinimized()) broadcastState(); }, 1000);
  setInterval(() => { if (engine.running) pruneBuffer(); }, 15000);
  pollGame().catch(() => {});
  if (SELFTEST) runSelftest().catch(() => app.exit(1));
});

/** Selbsttest der kompletten (installierten) App: aufnehmen -> Clip -> prüfen -> Ergebnis als JSON. */
async function runSelftest() {
  const out = process.env.CLIPPER_SELFTEST_OUT || path.join(app.getPath('userData'), 'selftest.json');
  const res = { ok: false, steps: [], version: app.getVersion(), packaged: app.isPackaged, obs: engine.obs && engine.obs.exe, ffmpeg };
  const step = (m) => { res.steps.push(`${new Date().toISOString()} ${m}`); };
  try {
    cfgPatchForSelftest();
    state.override = true;
    applyRecording();
    await engineQueue;
    if (!engine.running) throw new Error(state.error || 'Aufnahme startet nicht');
    step(`Aufnahme läuft (${engine.encPlan.mode}/${engine.encPlan.id})`);
    await new Promise((r) => setTimeout(r, 26000));
    step(`Puffer ${engine.bufferedSeconds().toFixed(1)} s, Stats ${JSON.stringify(engine.stats)}`);
    const info = await createClip(10);
    step(`Clip ${info.file} (${info.duration.toFixed(1)} s)`);
    const probe = require('child_process').spawnSync(ffmpeg, ['-i', info.file, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
    const real = m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0;
    res.clipSeconds = real;
    if (!(real >= 9 && real <= 14)) throw new Error(`Clip-Länge unplausibel: ${real}`);
    if (!/Video: h264/.test(probe.stderr) || !/Audio: aac/.test(probe.stderr)) throw new Error('Clip ohne H.264/AAC');
    res.ok = true;
  } catch (e) { res.error = e.message; res.log = logLines.slice(-80); }
  try { await engine.stop(); } catch { /* egal */ }
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  app.exit(res.ok ? 0 : 1);
}
function cfgPatchForSelftest() { settingsStore.update({ mode: 'manual', systemAudio: true, micAudio: false, encoder: 'cpu', fps: 30, resolution: '720', clipsDir: path.join(app.getPath('temp'), 'clipper-selftest-clips') }); }
