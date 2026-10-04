'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveFfmpeg() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function run(ffmpeg, args, { onProgress, totalSeconds } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
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

/**
 * Baut aus geplanten Segment-Teilen eine MP4-Datei.
 * @param parts [{file,inpoint,outpoint}]
 */
async function exportClip(ffmpeg, parts, outFile, opts) {
  const { fps = 60, bitrateMbps = 12, encoder = 'libx264', onProgress } = opts || {};
  const total = parts.reduce((s, p) => s + (p.outpoint - p.inpoint), 0);
  // Der concat-Demuxer kann bei MediaRecorder-WebM (ohne Seek-Index) kein "inpoint".
  // Nur das erste Segment hat einen Anfangs-Versatz -> der wird per Output-Seek verworfen.
  const skip = parts.length ? parts[0].inpoint : 0;
  const list = parts
    .map((p) => `file '${q(p.file)}'\noutpoint ${p.outpoint.toFixed(3)}`)
    .join('\n');
  const listFile = path.join(os.tmpdir(), `clipper-${process.pid}-${Date.now()}.txt`);
  await fs.promises.writeFile(listFile, list);
  try {
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      ...(skip > 0.001 ? ['-ss', skip.toFixed(3)] : []),
      '-vf', `fps=${fps},format=yuv420p`,
      ...videoArgs(encoder, { fps, bitrateMbps }),
      '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
      '-movflags', '+faststart',
      outFile,
    ], { onProgress, totalSeconds: total });
  } finally {
    fs.promises.unlink(listFile).catch(() => {});
  }
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

module.exports = { resolveFfmpeg, detectEncoder, exportClip, trimClip, makeThumbnail };
