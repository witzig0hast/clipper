'use strict';
/**
 * Aufnahme-Motor: OBS Studio (mitgeliefert) nimmt Bild + Ton auf (Game Capture / Display Capture,
 * Hardware-Encoder) und streamt NUR lokal (127.0.0.1) an den Segmentierer. Clipper steuert OBS
 * unsichtbar über obs-websocket. OBS läuft mit eigener, isolierter Konfiguration.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { ObsWs } = require('./obs-ws');
const { Segmenter } = require('./segmenter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** Sucht die OBS-Installation (mitgeliefert, Entwicklung oder Umgebungsvariable). */
function locateObs(extraRoots = []) {
  if (process.env.CLIPPER_OBS_BIN) {
    const exe = process.env.CLIPPER_OBS_BIN;
    return { exe, cwd: path.dirname(exe), root: null };
  }
  if (process.platform === 'win32') {
    const roots = [...extraRoots, path.join(__dirname, '..', '..', 'vendor', 'obs')];
    for (const root of roots) {
      const exe = path.join(root, 'bin', '64bit', 'obs64.exe');
      if (fs.existsSync(exe)) return { exe, cwd: path.dirname(exe), root };
    }
    return null;
  }
  for (const exe of ['/usr/bin/obs', '/usr/local/bin/obs']) if (fs.existsSync(exe)) return { exe, cwd: path.dirname(exe), root: null };
  return null;
}

/** Windows: Wächter-Prozess, der sichtbare Fenster von OBS sofort schließt (nie ein Fenster über dem Spiel!). */
function guardWindows(pid, seconds = 120) {
  if (process.platform !== 'win32' || !pid) return null;
  const ps = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class G { public delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
 public static void Sweep(uint pid){ EnumWindows((h,l)=>{uint p; GetWindowThreadProcessId(h,out p); if(p==pid && IsWindowVisible(h)){ PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero);} return true;}, IntPtr.Zero); } }
"@
$end = (Get-Date).AddSeconds(${seconds})
while ((Get-Date) -lt $end) { if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { break }; [G]::Sweep(${pid}); Start-Sleep -Milliseconds 400 }`;
  const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { windowsHide: true, stdio: 'ignore' });
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* egal */ }
  return p;
}

/** Windows: Fenster eines Prozesses (sichtbar/unsichtbar, mit Titel) – zur Fehlersuche und Fensterprüfung. */
function listWindows(pid) {
  if (process.platform !== 'win32' || !pid) return [];
  const ps = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class W { public delegate bool EP(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EP p, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 public static List<string> Get(uint pid){ var r=new List<string>(); EnumWindows((h,l)=>{uint p; GetWindowThreadProcessId(h,out p); if(p==pid){var sb=new StringBuilder(256); GetWindowText(h,sb,256); r.Add((IsWindowVisible(h)?"VISIBLE":"hidden")+"|"+sb.ToString());} return true;}, IntPtr.Zero); return r; } }
"@
[W]::Get(${pid}) | ForEach-Object { $_ }`;
  try {
    return require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 }).toString().split(/\r?\n/).filter(Boolean);
  } catch (e) { return [`(Fensterabfrage fehlgeschlagen: ${e.message})`]; }
}

/** Liest aus OBS' Logdatei, welche Video-Encoder auf diesem PC verfügbar sind ("Available Encoders"). */
function parseEncoders(logText) {
  const out = [];
  const lines = String(logText).split(/\r?\n/);
  let inVideo = false;
  for (const l of lines) {
    if (/Video Encoders:/.test(l)) { inVideo = true; continue; }
    if (/Audio Encoders:/.test(l)) { inVideo = false; continue; }
    if (inVideo) { const m = /-\s+([a-z0-9_]+)\s+\(/i.exec(l); if (m) out.push(m[1]); }
  }
  return out;
}

/** Aus der Liste die besten H.264-Hardware-Encoder je Hersteller wählen. */
function pickHardware(ids) {
  const first = (re) => ids.find((i) => re.test(i)) || null;
  return {
    nvenc: ['obs_nvenc_h264_tex', 'jim_nvenc', 'ffmpeg_nvenc'].find((i) => ids.includes(i)) || null,
    amd: first(/^h264_texture_amf$|^amd_amf_h264$/),
    qsv: ['obs_qsv11_v2', 'obs_qsv11'].find((i) => ids.includes(i)) || null,
  };
}

const ENC_FALLBACK = { nvenc: 'NVIDIA NVENC', amd: 'AMD AMF', qsv: 'Intel QuickSync', x264: 'CPU (x264)' };

class ObsEngine extends EventEmitter {
  /**
   * @param {{ffmpeg:string, dir:string, configBase:string, obsRoots?:string[], log?:(m:string)=>void}} o
   * dir = Puffer-Ordner, configBase = Ordner für die isolierte OBS-Konfiguration
   */
  constructor(o) {
    super();
    this.ffmpeg = o.ffmpeg; this.dir = o.dir; this.configBase = o.configBase;
    this.obsRoots = o.obsRoots || [];
    this.pidFile = o.pidFile || null;
    this.log = o.log || (() => {});
    this.seg = new Segmenter(o.ffmpeg, o.dir);
    this.proc = null; this.ws = null;
    this.running = false;       // OBS + Stream laufen
    this.starting = false;
    this.encoder = null;        // 'nvenc' | 'amd' | 'qsv' | 'x264'
    this.degrade = 0;           // 0 = wie eingestellt, 1 = 30 FPS, 2 = 720p30
    this.stats = null;
    this.lastError = '';
    this.obs = locateObs(this.obsRoots);
    this.seg.on('ended', (code, msg) => { if (this.running && !this.stopping) this.emit('crashed', `Videoempfänger beendet (${code}) ${msg}`); });
  }

  /** Beim Start: von einem früheren (abgestürzten) Clipper übrig gebliebenes OBS beenden. */
  cleanupStale() {
    if (!this.pidFile) return;
    try {
      const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'), 10);
      fs.unlinkSync(this.pidFile);
      if (!pid) return;
      let isObs = false;
      if (process.platform === 'win32') {
        const out = require('child_process').execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }).toString().toLowerCase();
        isObs = out.includes('obs64.exe');
      } else {
        try { isObs = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().startsWith('obs'); } catch { /* weg */ }
      }
      if (isObs) { process.kill(pid); this.log(`Verwaistes OBS (${pid}) beendet.`); }
    } catch { /* keine Datei */ }
  }

  /** Ende von OBS' eigener Logdatei (zeigt z. B. Grafik-Initialisierungsfehler). */
  readObsLog(lines = 60) {
    try {
      const dir = path.join(this.obsConfigDir(), 'logs');
      const f = fs.readdirSync(dir).filter((n) => n.endsWith('.txt')).sort().pop();
      if (!f) return '';
      return fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).slice(-lines).join('\n');
    } catch { return ''; }
  }

  /** Zustand für die Fehlersuche festhalten (bevor OBS beendet wird). */
  snapshot() {
    this.failDiag = { obsLog: this.readObsLog(), windows: this.proc ? listWindows(this.proc.pid) : [] };
    this.log(`OBS-Log:\n${this.failDiag.obsLog}`);
    if (this.failDiag.windows.length) this.log(`OBS-Fenster: ${this.failDiag.windows.join('; ')}`);
  }

  get available() { return !!this.obs; }

  timeline() { return this.seg.timeline(); }
  bufferedSeconds() { return this.seg.bufferedSeconds(); }
  prune(keep, pinned) { this.seg.prune(keep, pinned); }
  bytes() { return this.seg.bytes(); }
  clear() { this.seg.clear(); }

  // ---- Konfiguration -------------------------------------------------------
  obsConfigDir() {
    // Windows (portabel): OBS liest ../../config relativ zu bin/64bit; sonst XDG_CONFIG_HOME/obs-studio
    if (this.obs && this.obs.root) return path.join(this.obs.root, 'config', 'obs-studio');
    return path.join(this.configBase, 'obs-studio');
  }

  /** Wirksame Einstellungen (inkl. automatischer Entlastung). */
  effective(cfg) {
    const e = { ...cfg };
    if (this.degrade >= 1) e.fps = Math.min(e.fps, 30);
    if (this.degrade >= 2) e.height = Math.min(e.height || 720, 720);
    return e;
  }

  writeConfig(c, ports, encoder) {
    const dir = this.obsConfigDir();
    const prof = path.join(dir, 'basic', 'profiles', 'Clipper');
    fs.mkdirSync(prof, { recursive: true });
    // Immer mit frischer Szene starten (alte Quellen würden das Anlegen blockieren)
    try { fs.rmSync(path.join(dir, 'basic', 'scenes'), { recursive: true, force: true }); fs.rmSync(path.join(dir, 'basic', 'scenes.json'), { force: true }); } catch { /* egal */ }
    fs.mkdirSync(path.join(dir, 'basic', 'scenes'), { recursive: true });
    const win = process.platform === 'win32';
    // Auflösung: Arbeitsfläche = Monitor, Ausgabe = gewünschte Höhe (GPU-Skalierung, gleiches Seitenverhältnis)
    const baseW = c.baseW || 1920, baseH = c.baseH || 1080;
    const outH = c.height && c.height < baseH ? c.height : baseH;
    const outW = Math.round((baseW * outH) / baseH / 2) * 2;
    const userIni = [
      '[General]', 'FirstRun=true', 'EnableAutoUpdates=false', 'ConfirmOnExit=false', 'MaxLogs=5',
      `ProcessPriority=${c.lowPriority === false ? 'Normal' : 'BelowNormal'}`, 'HotkeyFocusType=NeverDisableHotkeys', '',
      '[BasicWindow]', 'PreviewEnabled=false', 'SysTrayEnabled=true', 'SysTrayWhenStarted=true', 'SysTrayMinimizeToTray=true',
      'WarnBeforeStartingStream=false', 'WarnBeforeStoppingStream=false', 'WarnBeforeStoppingRecord=false', 'OpenStatsOnStartup=false', '',
      '[Basic]', 'Profile=Clipper', 'ProfileDir=Clipper', '',
      ...(win ? ['[Video]', 'Renderer=Direct3D 11', ''] : []),
      // obs-websocket ≤ 5.4 liest hier, neuere Versionen aus plugin_config/obs-websocket/config.json
      '[OBSWebSocket]', 'FirstLoad=false', 'ServerEnabled=true', `ServerPort=${ports.ws}`, 'AlertsEnabled=false', 'AuthRequired=true', `ServerPassword=${ports.password}`, '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'global.ini'), userIni);   // OBS <= 30
    fs.writeFileSync(path.join(dir, 'user.ini'), userIni);     // OBS >= 31
    const wsDir = path.join(dir, 'plugin_config', 'obs-websocket');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'config.json'), JSON.stringify({
      alerts_enabled: false, auth_required: true, first_load: false, server_enabled: true, server_password: ports.password, server_port: ports.ws,
    }));
    const hw = encoder.id !== 'obs_x264' && encoder.id !== 'x264';
    const br = Math.round(c.bitrateMbps * 1000);
    const common = [
      '[General]', 'Name=Clipper', '',
      '[Video]', `BaseCX=${baseW}`, `BaseCY=${baseH}`, `OutputCX=${outW}`, `OutputCY=${outH}`, 'FPSType=0', `FPSCommon=${c.fps}`,
      'ScaleType=bilinear', 'ColorFormat=NV12', 'ColorSpace=709', 'ColorRange=Partial', '',
      '[Audio]', 'SampleRate=48000', 'ChannelSetup=Stereo', '',
    ];
    if (encoder.mode === 'adv') {
      // Erweiterter Modus: erlaubt 1-s-Keyframes (sauberer Clip-Anfang)
      fs.writeFileSync(path.join(prof, 'basic.ini'), [...common,
        '[Output]', 'Mode=Advanced', '',
        '[AdvOut]', `Encoder=${encoder.id}`, 'ApplyServiceSettings=false', 'Rescale=false', 'TrackIndex=1',
        'Track1Bitrate=160', 'Track1Name=Clipper', '',
      ].join('\n'));
      const j = { bitrate: br, keyint_sec: 1, rate_control: 'CBR', profile: 'high' };
      if (encoder.id === 'obs_x264') Object.assign(j, { preset: 'ultrafast', tune: 'zerolatency', threads: 2 });
      else if (/nvenc/.test(encoder.id)) Object.assign(j, { preset2: 'p3', preset: 'p3', bf: 0, lookahead: false, psycho_aq: false });
      else if (/amf/.test(encoder.id)) Object.assign(j, { preset: 'speed' });
      else if (/qsv/.test(encoder.id)) Object.assign(j, { target_usage: 'speed' });
      fs.writeFileSync(path.join(prof, 'streamEncoder.json'), JSON.stringify(j));
    } else {
      fs.writeFileSync(path.join(prof, 'basic.ini'), [...common,
        '[Output]', 'Mode=Simple', '',
        '[SimpleOutput]', `StreamEncoder=${encoder.id}`, `VBitrate=${br}`, 'ABitrate=160', 'UseAdvanced=false',
        'EnforceBitrate=false', `Preset=${hw ? 'veryfast' : 'ultrafast'}`, 'NVENCPreset2=p3', 'RecQuality=Stream', '',
      ].join('\n'));
    }
    fs.writeFileSync(path.join(prof, 'service.json'), JSON.stringify({
      type: 'rtmp_custom',
      settings: { server: `rtmp://127.0.0.1:${ports.rtmp}/live`, key: 'clipper', use_auth: false, bwtest: false },
    }));
    if (this.obs.root) fs.writeFileSync(path.join(this.obs.root, 'portable_mode.txt'), 'Clipper');
  }

  // ---- OBS-Prozess ---------------------------------------------------------
  spawnObs(ports) {
    const args = ['--disable-shutdown-check', '--disable-missing-files-check', '--minimize-to-tray', '--profile', 'Clipper',
      '--websocket_port', String(ports.ws), '--websocket_password', ports.password];
    if (process.platform === 'win32') args.push('--portable', '--disable-updater', '--multi');
    const env = { ...process.env };
    if (process.platform !== 'win32') env.XDG_CONFIG_HOME = this.configBase;
    this.proc = spawn(this.obs.exe, args, { cwd: this.obs.cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (this.pidFile) { try { fs.writeFileSync(this.pidFile, String(this.proc.pid)); } catch { /* egal */ } }
    this.guard = guardWindows(this.proc.pid);
    this.proc.stdout.on('data', (d) => this.log(`[obs] ${d.toString().trim()}`));
    this.proc.stderr.on('data', (d) => this.log(`[obs!] ${d.toString().trim()}`));
    this.proc.on('close', (code) => {
      this.proc = null;
      if (this.pidFile) { try { fs.unlinkSync(this.pidFile); } catch { /* egal */ } }
      const was = this.running;
      this.running = false;
      if (was && !this.stopping) this.emit('crashed', `OBS wurde beendet (Code ${code}).`);
    });
  }

  async connectWs(ports, timeoutMs = 60000) {
    const began = Date.now();
    let last;
    while (Date.now() - began < timeoutMs) {
      if (!this.proc) throw new Error('OBS konnte nicht gestartet werden.');
      const ws = new ObsWs();
      try { await ws.connect(ports.ws, ports.password, 4000); this.ws = ws; ws.on('close', () => { if (this.ws === ws) this.ws = null; }); return; } catch (e) { last = e; ws.close(); }
      await sleep(600);
    }
    throw new Error(`OBS antwortet nicht (${last ? last.message : 'Zeitüberschreitung'}).`);
  }

  /** OBS nimmt Verbindungen schon während des Ladens an (Fehler 207 "not ready") – darauf warten. */
  async waitReady(timeoutMs = 60000) {
    const began = Date.now();
    for (;;) {
      if (!this.proc || !this.ws) throw new Error('OBS wurde beendet, bevor es bereit war.');
      try { await this.ws.request('GetSceneList', {}, 5000); return; } catch (e) {
        if (e.code !== 207 && !/not ready/i.test(e.message)) throw e;
        if (Date.now() - began > timeoutMs) throw new Error('OBS wird nicht fertig geladen (Zeitüberschreitung).');
        await sleep(400);
      }
    }
  }

  /** Einstellungen der Spielaufnahme: auf das erkannte Spiel (per EXE-Name) oder beliebiges Vollbild. */
  gameSettings(exe) {
    const base = { capture_cursor: true, allow_transparency: false, anti_cheat_hook: true };
    // priority 2 = nur nach Programmdatei suchen; OBS sucht das Fenster laufend selbst, auch wenn es erst später erscheint
    return exe ? { ...base, capture_mode: 'window', priority: 2, window: `::${exe}` } : { ...base, capture_mode: 'any_fullscreen' };
  }

  /** Spiel wechselt (z. B. im "Immer"-Modus): Spielaufnahme live umstellen, ohne Neustart. */
  async setGame(exe) {
    if (!this.running || !this.ws || !(this.sources || []).includes('clipper-game')) return;
    try { await this.ws.request('SetInputSettings', { inputName: 'clipper-game', inputSettings: this.gameSettings(exe), overlay: true }); } catch (e) { this.log(`Spielwechsel fehlgeschlagen: ${e.message}`); }
  }

  /** Quellen anlegen. Gibt zurück, welche Bildquellen aktiv sind. */
  async setupSources(c) {
    const r = (t, d) => this.ws.request(t, d);
    const kinds = (await r('GetInputKindList')).inputKinds || [];
    const scene = (await r('GetSceneList')).currentProgramSceneName;
    const existing = (await r('GetInputList')).inputs || [];
    for (const i of existing) if (String(i.inputName).startsWith('clipper-')) await r('RemoveInput', { inputName: i.inputName }).catch((e) => this.log(`Entfernen von ${i.inputName} fehlgeschlagen: ${e.message}`));
    const made = [];
    const add = async (name, kind, settings) => {
      if (!kinds.includes(kind)) return false;
      try { await r('CreateInput', { sceneName: scene, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: true }); made.push(name); return true; } catch (e) { this.log(`Quelle ${kind} fehlgeschlagen: ${e.message}`); return false; }
    };
    const win = process.platform === 'win32';
    let video = 0;
    if (c.testSource) {
      if (await add('clipper-test', 'color_source_v3', { color: 0xff3366aa, width: c.baseW || 1920, height: c.baseH || 1080 })) video++;
    } else if (win) {
      if (c.captureMode !== 'game') { if (await add('clipper-display', 'monitor_capture', { monitor: c.monitorIndex || 0, capture_cursor: true })) video++; }
      if (c.captureMode !== 'display') { if (await add('clipper-game', 'game_capture', this.gameSettings(c.gameExe))) video++; }
    } else if (await add('clipper-screen', 'xshm_input', { screen: 0 })) video++;
    if (!video) throw new Error('Keine Bildquelle in OBS verfügbar.');
    if (c.systemAudio) await add('clipper-desktop-audio', win ? 'wasapi_output_capture' : 'pulse_output_capture', { device_id: 'default' });
    if (c.micAudio) await add('clipper-mic', win ? 'wasapi_input_capture' : 'pulse_input_capture', { device_id: 'default' });
    return made;
  }

  /**
   * Startet die komplette Aufnahme. cfg: {fps,height,bitrateMbps,encoder:'auto'|'cpu',hw,systemAudio,micAudio,
   * captureMode,baseW,baseH,monitorIndex,testSource}
   */
  async start(cfg) {
    if (!this.obs) throw new Error('OBS wurde nicht gefunden (Installation unvollständig).');
    if (this.running || this.starting) return;
    this.starting = true; this.stopping = false; this.lastError = '';
    try {
      const c = this.effective(cfg);
      const order = this.encoderPlans(c);
      let lastErr;
      for (const plan of order) {
        try { await this.tryStart(c, plan); return; } catch (e) {
          lastErr = e; this.log(`Start mit ${plan.mode}/${plan.id} fehlgeschlagen: ${e.message}`);
          this.snapshot();
          await this.killAll();
          if (plan.id === 'obs_x264' || plan.id === 'x264') break;
          if (plan.last) {
            // Software-Fallback nur sanft: nie mehr als 30 FPS / 720p, damit der PC nicht leidet
            c.fps = Math.min(c.fps, 30); c.height = Math.min(c.height || 720, 720);
          }
        }
      }
      throw lastErr;
    } finally { this.starting = false; }
  }

  /**
   * Startet OBS kurz (ohne aufzunehmen), liest die verfügbaren Encoder aus dessen Log und beendet es wieder.
   * Ergebnis: { ids:[...], nvenc, amd, qsv } oder null (Erkennung fehlgeschlagen).
   */
  async detectEncoders(timeoutMs = 60000) {
    if (!this.obs) return null;
    if (this.running || this.starting || this.proc) return this.encoders || null;
    try {
      const ports = { ws: await freePort(), rtmp: await freePort(), password: crypto.randomBytes(8).toString('hex') };
      this.stopping = true;
      this.writeConfig({ fps: 30, bitrateMbps: 6, baseW: 1280, baseH: 720, height: 720 }, ports, { mode: 'adv', id: 'obs_x264', hw: 'x264' });
      this.spawnObs(ports);
      const began = Date.now();
      let text = '';
      while (Date.now() - began < timeoutMs) {
        if (!this.proc) break;
        text = this.readObsLog(400);
        if (/Startup complete/.test(text)) break;
        await sleep(300);
      }
      const ids = parseEncoders(text);
      await this.killAll();
      this.stopping = false;
      if (!/Startup complete/.test(text) || !ids.length) { this.log('OBS meldet keine Encoderliste – nutze bekannte IDs.'); return null; } // ältere OBS-Versionen
      this.encoders = { ids, ...pickHardware(ids) };
      this.log(`OBS-Encoder: ${ids.join(', ')}`);
      return this.encoders;
    } catch (e) {
      this.log(`Encoder-Erkennung fehlgeschlagen: ${e.message}`);
      await this.killAll().catch(() => {});
      this.stopping = false;
      return null;
    }
  }

  /** Reihenfolge der Versuche: Hardware (erweitert → einfach), zuletzt CPU. */
  encoderPlans(c) {
    const plans = [];
    if (c.encoder !== 'cpu') {
      const det = this.encoders;
      if (det) {
        // OBS selbst sagt, welche Hardware-Encoder hier funktionieren
        for (const vendor of ['nvenc', 'amd', 'qsv']) {
          if (!det[vendor]) continue;
          plans.push({ mode: 'adv', id: det[vendor], hw: vendor });
          plans.push({ mode: 'simple', id: vendor, hw: vendor, last: true });
          break;
        }
      } else if (c.hw) {
        // Erkennung fehlgeschlagen: bekannte IDs der Reihe nach probieren
        const newNv = this.obs.root && fs.existsSync(path.join(this.obs.root, 'obs-plugins', '64bit', 'obs-nvenc.dll'));
        const advIds = { nvenc: newNv ? ['obs_nvenc_h264_tex', 'jim_nvenc'] : ['jim_nvenc', 'obs_nvenc_h264_tex'], amd: ['h264_texture_amf'], qsv: newNv ? ['obs_qsv11_v2', 'obs_qsv11'] : ['obs_qsv11', 'obs_qsv11_v2'] }[c.hw] || [];
        for (const id of advIds) plans.push({ mode: 'adv', id, hw: c.hw });
        plans.push({ mode: 'simple', id: c.hw, hw: c.hw, last: true });
      }
    }
    plans.push({ mode: 'adv', id: 'obs_x264', hw: 'x264' });
    return plans;
  }

  async tryStart(c, enc) {
    const ports = { ws: await freePort(), rtmp: await freePort(), password: crypto.randomBytes(12).toString('hex') };
    this.ports = ports;
    // Puffer behalten, wenn die Videoparameter gleich bleiben (z. B. nach einem Neustart); sonst leeren,
    // weil verschiedene Auflösungen/Encoder nicht verlustfrei aneinandergehängt werden können.
    const sig = JSON.stringify([c.fps, c.baseW, c.baseH, c.height, c.bitrateMbps, enc.id, enc.mode, !!c.systemAudio, !!c.micAudio]);
    if (sig !== this.sig) this.seg.clear();
    this.sig = sig;
    const sess = this.seg.start(ports.rtmp);
    await sleep(400);                                   // ffmpeg lauscht
    this.writeConfig(c, ports, enc);
    this.spawnObs(ports);
    await this.connectWs(ports);
    await this.waitReady();
    const sources = await this.setupSources(c);
    await this.ws.request('StartStream', {}, 30000);
    // Schnell scheitern, wenn der Stream gar nicht erst läuft (z. B. Hardware-Encoder nicht nutzbar)
    {
      const began = Date.now(); const limit = enc.hw === 'x264' ? 30000 : 15000;
      for (;;) {
        if (this.seg.hasData(sess)) break;
        if (sess.exited) throw new Error(this.seg.lastLog.trim().split('\n').pop() || 'Videoempfänger beendet');
        if (Date.now() - began > 3500) {
          const st = await this.ws.request('GetStreamStatus', {}, 3000).catch(() => null);
          if (st && !st.outputActive && !st.outputReconnecting) throw new Error('OBS-Ausgabe wurde nicht gestartet (Encoder nicht nutzbar?).');
        }
        if (Date.now() - began > limit) throw new Error('Keine Videodaten von OBS empfangen (Zeitüberschreitung).');
        await sleep(400);
      }
    }
    // Prüfen, dass wirklich der gewünschte Encoder läuft (eine unbekannte ID würde sonst still auf CPU/x264 fallen)
    const olog = this.readObsLog(200);
    if (enc.hw !== 'x264' && /\[x264 encoder: '(advanced|simple)_video_stream'\]/.test(olog)) throw new Error(`Hardware-Encoder (${enc.id}) wurde von OBS nicht verwendet.`);
    this.encoder = enc.hw; this.encPlan = enc; this.running = true; this.sources = sources; this.cfgActive = c;
    this.startStats();
    this.emit('started', { encoder: enc.hw, mode: enc.mode, id: enc.id });
  }

  startStats() {
    clearInterval(this.statsTimer);
    let prev = null, bad = 0;
    const t0 = Date.now();
    this.statsTimer = setInterval(async () => {
      if (!this.ws || !this.running) return;
      try {
        const s = await this.ws.request('GetStats', {}, 5000);
        const st = await this.ws.request('GetStreamStatus', {}, 5000);
        this.stats = {
          cpu: s.cpuUsage, memMB: s.memoryUsage, fps: s.activeFps, renderMs: s.averageFrameRenderTime,
          renderSkipped: s.renderSkippedFrames, renderTotal: s.renderTotalFrames,
          outSkipped: st.outputSkippedFrames, outTotal: st.outputTotalFrames, congestion: st.outputCongestion,
        };
        if (prev) {
          const dT = s.renderTotalFrames - prev.renderTotal, dS = s.renderSkippedFrames - prev.renderSkipped;
          const dOT = st.outputTotalFrames - prev.outTotal, dOS = st.outputSkippedFrames - prev.outSkipped;
          const ratio = dT > 20 ? dS / dT : 0, oratio = dOT > 20 ? dOS / dOT : 0;
          // Anlaufphase (erste 25 s) zählt nicht – dort sind verpasste Frames normal
          bad = Date.now() - t0 > 25000 && (ratio > 0.03 || oratio > 0.05) ? bad + 1 : 0;
          if (bad >= 3) { bad = 0; this.emit('overload', { ratio, oratio }); }
        }
        prev = { renderTotal: s.renderTotalFrames, renderSkipped: s.renderSkippedFrames, outTotal: st.outputTotalFrames, outSkipped: st.outputSkippedFrames };
      } catch { /* nächstes Mal */ }
    }, 5000);
  }

  async killAll() {
    clearInterval(this.statsTimer);
    if (this.ws) { try { this.ws.close(); } catch { /* egal */ } this.ws = null; }
    if (this.guard) { try { this.guard.kill(); } catch { /* egal */ } this.guard = null; }
    const p = this.proc;
    if (p) {
      const closed = new Promise((r) => p.once('close', r));
      try { p.kill(); } catch { /* egal */ }
      await Promise.race([closed, sleep(5000)]);
      if (process.platform === 'win32' && this.proc) { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch { /* egal */ } }
    }
    this.proc = null;
    await this.seg.stop().catch(() => {});
    this.running = false;
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.statsTimer);
    if (this.ws && this.running) { try { await this.ws.request('StopStream', {}, 8000); } catch { /* egal */ } }
    await this.killAll();
    this.stats = null;
    this.emit('stopped');
  }

  /** Eine Stufe weniger Last (30 FPS → 720p). Gibt false zurück, wenn schon am Limit. */
  stepDown() {
    if (this.degrade >= 2) return false;
    this.degrade++;
    return true;
  }
}

module.exports = { ObsEngine, locateObs, listWindows, parseEncoders, pickHardware, ENC_FALLBACK };
