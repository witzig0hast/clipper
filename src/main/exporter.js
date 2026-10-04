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

async function writeList(parts) {
  const list = parts.map((p) => `file '${q(p.file)}'\noutpoint ${p.outpoint.toFixed(3)}`).join('\n');
  const f = path.join(os.tmpdir(), `clipper-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
  await fs.promises.writeFile(f, list);
  return f;
}

/**
 * Baut aus Video-Segmenten (.ts) und Audio-Segmenten (.webm) eine MP4-Datei.
 * plan = { ws, we, video:{parts,firstFrom}, audio:{parts,firstFrom}|null }  (Zeiten in ms, Wanduhr)
 * Der Ton wird anhand der Wanduhrzeiten exakt zum Bild ausgerichtet.
 */
async function exportClip(ffmpeg, plan, outFile, opts) {
  const { fps = 60, bitrateMbps = 12, encoder = 'libx264', onProgress } = opts || {};
  const { ws, we, video, audio } = plan;
  const T = Math.max(ws, video.firstFrom);          // Nullpunkt des Clips
  const dur = (we - T) / 1000;
  if (dur < 0.2) throw new Error('Zu wenig Material im Puffer.');
  const vSkip = (T - video.firstFrom) / 1000;
  const lists = [await writeList(video.parts)];
  const inputs = ['-f', 'concat', '-safe', '0', '-i', lists[0]];
  let graph = `[0:v]trim=start=${vSkip.toFixed(3)}:duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[v]`;
  const maps = ['-map', '[v]'];
  if (audio && audio.parts.length) {
    lists.push(await writeList(audio.parts));
    inputs.push('-f', 'concat', '-safe', '0', '-i', lists[1]);
    const aSkip = Math.max(0, T - audio.firstFrom) / 1000;
    const delay = Math.max(0, Math.round(audio.firstFrom - T));
    graph += `;[1:a]atrim=start=${aSkip.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000`
      + (delay ? `,adelay=${delay}|${delay}` : '') + ',apad[a]';
    maps.push('-map', '[a]', '-c:a', 'aac', '-b:a', '160k');
  } else {
    maps.push('-an');
  }
  try {
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
      ...inputs, '-filter_complex', graph, ...maps,
      ...videoArgs(encoder, { fps, bitrateMbps }),
      '-t', dur.toFixed(3), '-movflags', '+faststart', outFile,
    ], { onProgress, totalSeconds: dur });
  } finally {
    for (const l of lists) fs.promises.unlink(l).catch(() => {});
  }
  return dur;
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

module.exports = { run, videoArgs, resolveFfmpeg, detectEncoder, exportClip, trimClip, makeThumbnail };
