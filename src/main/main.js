'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, dialog, shell,
  desktopCapturer, session, screen, nativeImage, Notification,
} = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const settingsStore = require('./settings');
const { detectGame, listProcesses, DEFAULT_GAMES } = require('./games');
const timeline = require('./timeline');
const exporter = require('./exporter');
const { VideoCapture } = require('./capture');

const APP_ID = 'de.hastnetwork.clipper';
const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

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
let video = null;

// ---- Zustand ---------------------------------------------------------------
const state = {
  game: null,          // erkannter Spiel-Prozess
  override: null,      // true/false = manuell erzwungen, null = automatisch
  rendererActive: false,   // Audio-Recorder im Renderer läuft
  videoActive: false,      // ffmpeg-Bildschirmaufnahme läuft
  videoKey: '',
  error: null,
  exports: 0,
  lastDesired: false,
};

/** @type {Map<number,{id:number,file:string,startedAt:number,endedAt:number,final:boolean,size:number}>} */
const segments = new Map();
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

function bufferBytes() {
  let n = 0;
  for (const s of segments.values()) n += s.size || 0;
  for (const v of video.segments()) { try { n += fs.statSync(v.file).size; } catch { /* egal */ } }
  return n;
}
const segList = () => [...segments.values()].filter((s) => s.endedAt > s.startedAt);

function publicState() {
  return {
    recording: state.videoActive,
    desired: desired(),
    mode: cfg().mode,
    override: state.override,
    game: state.game,
    bufferSeconds: timeline.bufferedSeconds(video.segments()),
    bufferBytes: bufferBytes(),
    bufferMax: cfg().bufferMinutes * 60,
    encoder,
    hwEncoder,
    capture: video.combo,
    diag: { combos: video.combos, stats: video.stats, cmd: video.cmd, ffmpegLog: video.lastError, hw: hwEncoder, platform: process.platform },
    audioActive: state.rendererActive,
    error: state.error,
    exports: state.exports,
    clipsDir: cfg().clipsDir,
  };
}
const broadcastState = () => { send('state', publicState()); updateTray(); };

const audioConfig = () => {
  const s = cfg();
  return { systemAudio: s.systemAudio, micAudio: s.micAudio, micDeviceId: s.micDeviceId, bitrateMbps: 0 };
};

/** Welcher Monitor (Index für Desktop Duplication + Rechteck für GDI)? */
async function resolveDisplay() {
  const displays = screen.getAllDisplays();
  let display = screen.getPrimaryDisplay();
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((x) => x.id === cfg().screenId);
    if (src) display = displays.find((d) => String(d.id) === String(src.display_id)) || display;
  } catch { /* Hauptbildschirm */ }
  let b = display.bounds;
  if (process.platform === 'win32' && screen.dipToScreenRect) b = screen.dipToScreenRect(null, b);
  return { outputIdx: Math.max(0, displays.findIndex((d) => d.id === display.id)), rect: { x: b.x, y: b.y, width: b.width, height: b.height } };
}
const videoConfig = async () => {
  const s = cfg();
  return { fps: s.fps, resolution: s.resolution, bitrateMbps: s.bitrateMbps, ...(await resolveDisplay()) };
};

// ---- Puffer ----------------------------------------------------------------
function clearBuffer() {
  video.clear();
  for (const s of segments.values()) fs.promises.unlink(s.file).catch(() => {});
  segments.clear();
}

function pruneBuffer() {
  const keep = cfg().bufferMinutes * 60;
  video.prune(keep, (f) => pinned.has(f));
  for (const s of timeline.expiredSegments(segList(), keep)) {
    if (pinned.has(s.file)) continue;
    segments.delete(s.id);
    fs.promises.unlink(s.file).catch(() => {});
  }
}

async function saveSegment(meta, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength);
  if (!buf.length) return;
  const existing = segments.get(meta.id);
  if (existing && existing.final && meta.partial) return; // fertige Version nicht durch Teilstück ersetzen
  const file = path.join(bufferDir, `seg-${meta.id}.webm`);
  if (pinned.has(file) && existing) return; // gerade im Export in Benutzung
  const tmp = `${file}.tmp`;
  try {
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
  } catch (e) {
    fs.promises.unlink(tmp).catch(() => {});
    return;
  }
  segments.set(meta.id, {
    id: meta.id, file, startedAt: meta.startedAt, endedAt: meta.endedAt,
    final: !meta.partial, size: buf.length,
  });
  pruneBuffer();
}

// Fordert den Recorder auf, laufende Segmente zu übergeben, damit der Clip bis "jetzt" reicht.
const flushWaiters = new Map();
function flushRecorder() {
  if (!state.rendererActive) return Promise.resolve();
  return new Promise((resolve) => {
    const token = crypto.randomUUID();
    const timer = setTimeout(() => { flushWaiters.delete(token); resolve(); }, 6000);
    flushWaiters.set(token, () => { clearTimeout(timer); resolve(); });
    send('flush', token);
  });
}

// ---- Aufnahme-Steuerung ----------------------------------------------------
let videoQueue = Promise.resolve();
function syncVideo(want) {
  videoQueue = videoQueue.then(async () => {
    const wantKey = want ? JSON.stringify([cfg().fps, cfg().resolution, cfg().bitrateMbps, cfg().screenId, cfg().encoder]) : '';
    if (wantKey === state.videoKey && video.running === want) return;
    if (video.running) await video.stop();
    state.videoKey = '';
    if (want) {
      try {
        await video.start(await videoConfig(), cfg().encoder === 'cpu');
        state.videoKey = wantKey; state.error = null;
      } catch (e) { state.error = e.message; toast(`Aufnahme-Fehler: ${e.message}`, 'error'); }
    }
    state.videoActive = video.running;
    broadcastState();
  }).catch(() => {});
  return videoQueue;
}

function applyRecording() {
  const want = desired();
  if (want && !state.lastDesired) { clearBuffer(); state.error = null; }
  state.lastDesired = want;
  send('recording:set', { on: want, config: audioConfig() });
  syncVideo(want);
  broadcastState();
}

async function pollGame() {
  const s = cfg();
  const found = await detectGame(s.games).catch(() => null);
  if (found !== state.game) {
    state.game = found;
    state.override = null; // neues Spiel / Spielende -> wieder automatisch
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
    await flushRecorder();
    const vsegs = video.segments();
    if (!vsegs.length) throw new Error('Der Puffer ist noch leer – es läuft noch keine Aufnahme.');
    const we = timeline.bufferEnd(vsegs);
    const ws = Math.max(we - seconds * 1000, Math.min(...vsegs.map((x) => x.startedAt)));
    const v = timeline.planWindow(vsegs, ws, we);
    const a = timeline.planWindow(segList(), ws, we);
    if (!v.parts.length) throw new Error('Der Puffer ist noch leer.');
    for (const p of [...v.parts, ...a.parts]) { pinned.add(p.file); pin.push(p.file); }
    await fs.promises.mkdir(s.clipsDir, { recursive: true });
    const game = state.game ? ` ${state.game.replace(/\.exe$/i, '')}` : '';
    const out = uniquePath(s.clipsDir, `Clip ${stamp()}${game}`);
    const label = 'Clip wird erstellt …';
    send('export:progress', { id, label, progress: 0 });
    const duration = await exporter.exportClip(ffmpeg, { ws, we, video: v, audio: a.parts.length ? a : null }, out,
      exportOpts((p) => send('export:progress', { id, label, progress: p })));
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
      backgroundThrottling: false, // Aufnahme muss auch bei verstecktem Fenster flüssig laufen
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
  const rec = state.videoActive;
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
    if ('clipsDir' in patch) send('clips:changed');
    if ('mode' in patch && patch.mode !== before.mode) { state.override = null; await pollGame(); }
    if (['mode', 'fps', 'resolution', 'bitrateMbps', 'systemAudio', 'micAudio', 'micDeviceId', 'screenId', 'bufferMinutes', 'encoder']
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
  ipcMain.handle('screens:list', async () => {
    const primary = screen.getPrimaryDisplay().id;
    const src = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    return src.map((s, i) => ({
      id: s.id, name: s.name || `Bildschirm ${i + 1}`,
      primary: String(s.display_id) === String(primary),
    }));
  });
  ipcMain.handle('processes:list', () => listProcesses());
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: cfg().clipsDir });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('segment:save', (_e, meta, buf) => saveSegment(meta, buf));
  ipcMain.on('recorder:status', (_e, st) => {
    state.rendererActive = !!st.active;
    if (st.error) toast(`Ton-Aufnahme nicht möglich: ${st.error}`, 'error'); // Video läuft trotzdem weiter
    broadcastState();
  });
  ipcMain.on('renderer:ready', () => { applyRecording(); });
  ipcMain.on('flush:done', (_e, token) => { const f = flushWaiters.get(token); if (f) { flushWaiters.delete(token); f(); } });
}

function setupCapture() {
  // Bildschirm + System-Audio (Loopback) für getDisplayMedia im Renderer
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = cfg().screenId;
      const primary = String(screen.getPrimaryDisplay().id);
      const src = sources.find((s) => s.id === wanted) || sources.find((s) => String(s.display_id) === primary) || sources[0];
      callback(cfg().systemAudio ? { video: src, audio: 'loopback' } : { video: src });
    } catch { callback({}); }
  }, { useSystemPicker: false });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(['media', 'display-capture'].includes(permission)));
}

// ---- Start -----------------------------------------------------------------
app.on('second-instance', () => showWindow());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { if (video && video.proc) video.proc.kill(); } catch { /* egal */ }
  try { fs.rmSync(bufferDir, { recursive: true, force: true }); } catch { /* egal */ }
});
app.on('window-all-closed', () => { /* im Tray weiterlaufen */ });

app.whenReady().then(async () => {
  ffmpeg = exporter.resolveFfmpeg();
  bufferDir = path.join(app.getPath('userData'), 'buffer');
  fs.rmSync(bufferDir, { recursive: true, force: true });
  fs.mkdirSync(bufferDir, { recursive: true });
  video = new VideoCapture(ffmpeg, bufferDir);
  video.on('crashed', (msg) => { state.videoActive = false; state.error = msg; toast(msg, 'error'); broadcastState(); });
  video.on('stopped', () => { state.videoActive = video.running; broadcastState(); });
  settingsStore.get();
  setupIpc();
  setupCapture();
  createWindow();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on('click', () => showWindow());
  updateTray();
  registerHotkey();
  applyStartup();

  setInterval(() => pollGame().catch(() => {}), 8000);
  setInterval(() => { if (win && win.isVisible() && !win.isMinimized()) broadcastState(); }, 1000);
  pollGame().catch(() => {});

  // Grafikkarten-Encoder im Hintergrund testen
  exporter.detectEncoder(ffmpeg).then((enc) => {
    hwEncoder = enc === 'libx264' ? null : enc;
    encoder = cfg().encoder === 'cpu' ? 'libx264' : enc;
    broadcastState();
    return video.probe(hwEncoder);
  }).then(() => { broadcastState(); }).catch(() => {});
});
