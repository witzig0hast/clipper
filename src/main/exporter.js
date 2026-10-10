'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveFfmpeg() {
  if (process.env.CLIPPER_FFMPEG) return process.env.CLIPPER_FFMPEG; // z. B. für Tests/Entwicklung
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function run(ffmpeg, args, { onProgress, totalSeconds, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* egal */ }
    const timer = timeout ? setTimeout(() => proc.kill(), timeout) : null;
    let err = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && onProgress && totalSeconds) {
          // out_time_ms ist (historisch) in Mikrosekunden
          onProgress(Math.min(1, Number(m[1]) / 1e6 / totalSeconds));
        }
      }
    });
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg beendet mit Code ${code}\n${err.slice(-1500)}`));
    });
  });
}

/** Testet, welche H.264-Encoder wirklich auf diesem Rechner funktionieren. */
async function detectEncoder(ffmpeg) {
  const candidates = ['h264_nvenc', 'h264_amf', 'h264_qsv'];
  for (const enc of candidates) {
    try {
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
        '-frames:v', '10', '-c:v', enc, '-f', 'null', '-',
      ]);
      return enc;
    } catch { /* nicht verfügbar */ }
  }
  return 'libx264';
}

function videoArgs(encoder, { fps, bitrateMbps }) {
  const br = `${Math.round(bitrateMbps * 1000)}k`;
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', br, '-maxrate', br];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', br, '-maxrate', br];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'medium', '-b:v', br, '-maxrate', br];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', br, '-bufsize', `${Math.round(bitrateMbps * 2000)}k`];
  }
}

function q(p) { return p.replace(/\\/g, '/').replace(/'/g, "'\\''"); }

/** Zeitpunkte (s) aller Keyframes einer Datei – es werden nur I-Frames dekodiert (sehr billig). */
function keyframes(ffmpeg, file) {
  return new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'info', '-skip_frame', 'nokey', '-i', file, '-an', '-vf', 'showinfo', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', () => resolve([]));
    p.on('close', () => resolve([...err.matchAll(/pts_time:([\d.]+)/g)].map((m) => parseFloat(m[1]))));
  });
}

async function exportClipCopy(ffmpeg, plan, outFile, opts = {}) {
  let { parts, duration } = plan;
  if (!parts.length || duration < 0.2) throw new Error('Zu wenig Material im Puffer.');
  // Start auf den letzten Keyframe vor dem Wunschpunkt legen: Bild und Ton beginnen dann gemeinsam
  if (parts[0].inpoint > 0.01) {
    const kf = (await keyframes(ffmpeg, parts[0].file)).filter((t) => t <= parts[0].inpoint + 0.001);
    const snapped = kf.length ? Math.max(...kf) : 0;
    duration += parts[0].inpoint - snapped;
    parts = [{ ...parts[0], inpoint: snapped }, ...parts.slice(1)];
  }
  const list = parts.map((p) => `file '${q(p.file)}'${p.inpoint > 0.01 ? `\ninpoint ${p.inpoint.toFixed(3)}` : ''}`).join('\n');
  const lf = path.join(os.tmpdir(), `clipper-${process.pid}-${Date.now()}.txt`);
  await fs.promises.writeFile(lf, list);
  try {
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', lf,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', outFile,
    ], { onProgress: opts.onProgress, totalSeconds: duration });
  } finally { fs.promises.unlink(lf).catch(() => {}); }
  return duration;
}

/** Schneidet einen vorhandenen Clip (Re-Encode für exakte Schnitte). */
async function trimClip(ffmpeg, inFile, outFile, start, end, opts) {
  const { fps = 60, bitrateMbps = 12, encoder = 'libx264', onProgress } = opts || {};
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
    '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', inFile,
    '-vf', 'format=yuv420p',
    ...videoArgs(encoder, { fps, bitrateMbps }),
    '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart',
    outFile,
  ], { onProgress, totalSeconds: end - start });
}

/** Einzelbild als JPG-Vorschau. */
async function makeThumbnail(ffmpeg, inFile, outFile, at = 1) {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', String(at), '-i', inFile, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', outFile,
  ]);
}

module.exports = { keyframes, exportClipCopy, run, videoArgs, resolveFfmpeg, detectEncoder, trimClip, makeThumbnail };
