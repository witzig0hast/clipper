'use strict';
/**
 * Integrationstest mit ECHTEM OBS: startet die Engine (Testquelle, ohne Grafikkarte nötig), nimmt ~35 s auf,
 * erzeugt einen verlustfreien Clip und prüft ihn. Läuft in CI (Windows) und lokal (Linux/Xvfb).
 * Aufruf: node scripts/obs-integration.js   (Umgebung: CLIPPER_OBS_BIN, CLIPPER_FFMPEG optional)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { ObsEngine } = require('../src/main/obs');
const T = require('../src/main/timeline');
const E = require('../src/main/exporter');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { console.log(`::error::${m}`); process.exitCode = 1; };

/** Windows: Fenster eines Prozesses auflisten (sichtbar/unsichtbar). */
function windowsOf(pid) {
  if (process.platform !== 'win32') return [];
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
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 }).toString().split(/\r?\n/).filter(Boolean);
  } catch (e) { return [`(Fensterabfrage fehlgeschlagen: ${e.message})`]; }
}

async function scenario(name, cfg, { clip = true } = {}) {
  console.log(`\n=== Szenario: ${name} ===`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-int-'));
  const dir = path.join(base, 'buf'); fs.mkdirSync(dir);
  const ff = E.resolveFfmpeg();
  const logs = [];
  const eng = new ObsEngine({ ffmpeg: ff, dir, configBase: path.join(base, 'cfg'), log: (m) => logs.push(m) });
  if (!eng.available) { fail('OBS wurde nicht gefunden'); return false; }
  console.log('OBS:', eng.obs.exe);
  const t0 = Date.now();
  try {
    await eng.start({ fps: 30, height: 720, bitrateMbps: 6, encoder: 'cpu', hw: null, systemAudio: true, micAudio: false, captureMode: 'auto', baseW: 1280, baseH: 720, monitorIndex: 0, ...cfg });
  } catch (e) {
    console.log(`Start fehlgeschlagen: ${e.message}`);
    console.log('--- OBS-Log (Ende) ---\n' + logs.slice(-40).join('\n'));
    await eng.stop().catch(() => {});
    return false;
  }
  console.log(`gestartet nach ${Date.now() - t0} ms | Plan ${eng.encPlan.mode}/${eng.encPlan.id} | Quellen: ${(eng.sources || []).join(', ')}`);
  const wins = windowsOf(eng.proc && eng.proc.pid);
  if (wins.length) {
    console.log('Fenster von OBS:\n  ' + wins.join('\n  '));
    const vis = wins.filter((w) => w.startsWith('VISIBLE|') && w.length > 8);
    if (vis.length) { console.log(`::warning::OBS zeigt sichtbare Fenster: ${vis.join('; ')}`); if (process.env.STRICT_WINDOWS) fail('OBS-Fenster sichtbar'); }
  }
  await sleep(clip ? 33000 : 15000);
  console.log('Stats:', JSON.stringify(eng.stats));
  console.log(`Puffer: ${eng.bufferedSeconds().toFixed(1)} s`);
  let ok = true;
  if (clip) {
    const tl = await eng.timeline();
    console.log('Zeitleiste:', tl.map((x) => x.duration.toFixed(2)).join(' '));
    const plan = T.planTail(tl, 15);
    const out = path.join(base, 'clip.mp4');
    const dur = await E.exportClipCopy(ff, plan, out, {});
    const p = spawnSync(ff, ['-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(p.stderr);
    const real = m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0;
    console.log(`Clip: geplant ${dur.toFixed(1)} s, real ${real.toFixed(1)} s`);
    if (!(real >= 14 && real <= 19)) { fail(`Clip-Länge unplausibel: ${real}`); ok = false; }
    if (!/Video: h264/.test(p.stderr)) { fail('Clip ohne H.264-Video'); ok = false; }
    if (!/Audio: aac/.test(p.stderr)) { fail('Clip ohne AAC-Ton'); ok = false; }
    if (/(corrupt|Invalid data|error while decoding)/i.test(p.stderr)) { fail('Decode-Fehler im Clip'); ok = false; }
  } else if (eng.bufferedSeconds() < 5) { fail('Keine Daten im Puffer'); ok = false; }
  await eng.stop();
  console.log('gestoppt; OBS-Prozess beendet:', !eng.proc);
  if (!ok) console.log('--- OBS-Log (Ende) ---\n' + logs.slice(-40).join('\n'));
  return ok;
}

(async () => {
  const a = await scenario('Testquelle (muss funktionieren)', { testSource: true });
  if (!a) fail('Szenario A fehlgeschlagen');
  if (process.platform === 'win32') {
    // Echte Quellen: auf Runnern ohne Grafikkarte evtl. nicht möglich -> nur informativ
    const b = await scenario('Echte Quellen (Display + Spiel + Systemton) – informativ', { testSource: false }, { clip: false });
    console.log(`Szenario B (informativ): ${b ? 'OK' : 'nicht möglich auf diesem Rechner'}`);
  }
})().catch((e) => { console.log(e.stack); process.exit(1); });
