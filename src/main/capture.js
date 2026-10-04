'use strict';
/**
 * Bildschirmaufnahme direkt über ffmpeg – möglichst komplett auf der Grafikkarte
 * (Desktop Duplication + NVENC/AMF/QuickSync), damit das Spiel nicht gebremst wird.
 * ffmpeg schreibt fortlaufend 10-s-MPEG-TS-Segmente; Segment i beginnt exakt bei t0 + i*10 s.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./exporter');

const SEG = 10;
const NAME = /^v-(\d{5})\.ts$/;

function inputArgs(src, c) {
  if (src === 'ddagrab') return ['-f', 'lavfi', '-i', `ddagrab=output_idx=${c.outputIdx || 0}:framerate=${c.fps}:draw_mouse=1`];
  if (src === 'gdigrab') {
    const r = c.rect;
    return ['-f', 'gdigrab', '-framerate', String(c.fps), '-draw_mouse', '1',
      ...(r ? ['-offset_x', String(r.x), '-offset_y', String(r.y), '-video_size', `${r.width}x${r.height}`] : []),
      '-i', 'desktop'];
  }
  return ['-f', 'x11grab', '-framerate', String(c.fps), '-i', process.env.DISPLAY || ':0']; // nur Linux/Entwicklung
}

function codecArgs(enc, c) {
  const br = `${Math.round(c.bitrateMbps * 1000)}k`;
  const g = ['-g', String(c.fps), '-bf', '0'];
  switch (enc) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', br, '-maxrate', br, ...g];
    case 'h264_amf': return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', br, '-maxrate', br, ...g];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', br, '-maxrate', br, ...g];
    default: return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23', '-maxrate', br,
      '-bufsize', `${Math.round(c.bitrateMbps * 2000)}k`, '-sc_threshold', '0', ...g];
  }
}

function filterArgs(src, enc, c) {
  const gpu = src === 'ddagrab';
  const scale = c.resolution && c.resolution !== 'native' ? `scale=-2:${c.resolution}` : null;
  let vf;
  if (enc === 'libx264' || scale) vf = [...(gpu ? ['hwdownload', 'format=bgra'] : []), ...(scale ? [scale] : []), 'format=yuv420p'];
  else if (enc === 'h264_qsv' && gpu) vf = ['hwmap=derive_device=qsv', 'format=qsv'];
  else if (gpu) vf = [];            // D3D11-Frames gehen direkt in den Hardware-Encoder
  else vf = ['format=yuv420p'];
  return vf.length ? ['-vf', vf.join(',')] : [];
}

function buildArgs(combo, c, sink) {
  return ['-hide_banner', '-loglevel', 'warning', '-y',
    ...inputArgs(combo.src, c), ...filterArgs(combo.src, combo.enc, c), ...codecArgs(combo.enc, c),
    '-fps_mode', 'cfr', '-an', ...sink];
}

class VideoCapture extends EventEmitter {
  constructor(ffmpeg, dir) {
    super();
    this.ffmpeg = ffmpeg; this.dir = dir;
    this.proc = null; this.t0 = null; this.running = false; this.stopping = false;
    this.combos = []; this.combo = null; this.lastError = '';
    this.ready = new Promise((r) => { this.markReady = r; }); // wird nach probe() erfüllt
  }

  /** Testet in dieser Reihenfolge, was auf dem Rechner wirklich funktioniert. */
  probe(hwEncoder) {
    return (async () => {
      const win = process.platform === 'win32';
      const srcs = win ? ['ddagrab', 'gdigrab'] : ['x11grab'];
      const encs = [...new Set([hwEncoder, 'libx264'].filter(Boolean))];
      const ok = [];
      for (const src of srcs) for (const enc of encs) {
        const cfg = { fps: 30, bitrateMbps: 6, resolution: 'native', outputIdx: 0 };
        try {
          await run(this.ffmpeg, buildArgs({ src, enc }, cfg, ['-t', '1', '-f', 'null', '-']), { timeout: 20000 });
          ok.push({ src, enc });
        } catch { /* Kombination geht nicht */ }
      }
      this.combos = ok;
      this.markReady();
      return ok;
    })();
  }

  /** Beste Kombination (Hardware zuerst, außer cpuOnly). */
  choose(cpuOnly) {
    const list = cpuOnly ? this.combos.filter((c) => c.enc === 'libx264') : this.combos;
    return list[0] || null;
  }

  async start(cfg, cpuOnly) {
    if (this.running) return;
    await this.ready;
    const combo = this.choose(cpuOnly);
    if (!combo) throw new Error('Keine Bildschirmaufnahme möglich (weder Desktop-Duplication noch GDI funktionieren).');
    this.combo = combo;
    this.clear();
    this.t0 = null; this.stopping = false; this.lastError = '';
    const args = buildArgs(combo, cfg, [
      '-f', 'segment', '-segment_time', String(SEG), '-segment_format', 'mpegts',
      '-reset_timestamps', '1', '-flush_packets', '1', '-muxdelay', '0', '-muxpreload', '0', path.join(this.dir, 'v-%05d.ts'),
    ]);
    const proc = spawn(this.ffmpeg, args, { windowsHide: true });
    this.proc = proc; this.running = true;
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* egal */ }
    proc.stderr.on('data', (d) => { this.lastError = (this.lastError + d.toString()).slice(-1500); });
    proc.stdin.on('error', () => {});
    proc.on('close', (code) => {
      this.running = false; this.proc = null; clearInterval(this.watch);
      if (!this.stopping) this.emit('crashed', `Bildschirmaufnahme beendet (Code ${code}). ${this.lastError.trim().split('\n').pop() || ''}`);
      this.emit('stopped');
    });
    // t0 = Entstehungszeit des ersten Segments (≈ erstes Bild)
    const first = path.join(this.dir, 'v-00000.ts');
    const began = Date.now();
    await new Promise((resolve, reject) => {
      this.watch = setInterval(() => {
        try { this.t0 = fs.statSync(first).birthtimeMs || fs.statSync(first).ctimeMs; clearInterval(this.watch); resolve(); } catch {
          if (!this.running) { clearInterval(this.watch); reject(new Error(this.lastError.trim().split('\n').pop() || 'Aufnahme konnte nicht starten.')); }
          else if (Date.now() - began > 15000) { clearInterval(this.watch); this.stop(); reject(new Error('Aufnahme startet nicht (Zeitüberschreitung).')); }
        }
      }, 40);
    });
    this.emit('started');
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    this.stopping = true;
    const closed = new Promise((r) => proc.once('close', r));
    try { proc.stdin.write('q'); } catch { /* egal */ }
    const t = setTimeout(() => proc.kill(), 4000);
    await closed;
    clearTimeout(t);
  }

  /** Aktuelle Segmente mit Wanduhr-Zeiten. Das letzte (laufende) endet bei "jetzt". */
  segments(now = Date.now()) {
    if (!this.t0) return [];
    let names;
    try { names = fs.readdirSync(this.dir).filter((n) => NAME.test(n)).sort(); } catch { return []; }
    const out = [];
    const last = names.length - 1;
    names.forEach((n, i) => {
      const id = Number(NAME.exec(n)[1]);
      const start = this.t0 + id * SEG * 1000;
      const end = i === last && this.running ? Math.min(now - 300, start + SEG * 1000) : start + SEG * 1000;
      if (end > start) out.push({ id, file: path.join(this.dir, n), startedAt: start, endedAt: end });
    });
    return out;
  }

  prune(keepSeconds, isPinned = () => false) {
    const segs = this.segments();
    if (!segs.length) return;
    const limit = segs[segs.length - 1].endedAt - (keepSeconds + 20) * 1000;
    for (const s of segs) if (s.endedAt < limit && !isPinned(s.file)) fs.promises.unlink(s.file).catch(() => {});
  }

  clear() {
    try { for (const n of fs.readdirSync(this.dir)) if (NAME.test(n)) fs.unlinkSync(path.join(this.dir, n)); } catch { /* egal */ }
  }
}

module.exports = { VideoCapture, SEG };
