'use strict';
/**
 * Empfängt den lokalen Videostrom von OBS (RTMP auf 127.0.0.1) und schreibt ihn OHNE Neu-Kodierung
 * (-c copy) in kurze MPEG-TS-Segmente. Das kostet praktisch keine Leistung.
 * Segmentgrenzen liegen auf Keyframes; die exakten Zeiten stehen in der CSV-Liste von ffmpeg.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SEG_SECONDS = 10;

class Segmenter extends EventEmitter {
  constructor(ffmpeg, dir) {
    super();
    this.ffmpeg = ffmpeg; this.dir = dir;
    this.sessions = [];       // [{n, t0, csv, prefix, proc}]
    this.counter = 0;
    this.current = null;
    this.stopping = false;
    this.lastLog = '';
  }

  /** Startet einen Empfänger. Gibt die Session zurück (läuft, sobald ffmpeg lauscht). */
  start(port, key = 'clipper') {
    const n = ++this.counter;
    const prefix = `s${n}-`;
    const csv = path.join(this.dir, `${prefix}list.csv`);
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-nostats', '-y',
      '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/${key}`,
      '-c', 'copy', '-f', 'segment', '-segment_time', String(SEG_SECONDS), '-segment_format', 'mpegts',
      '-reset_timestamps', '1', '-muxdelay', '0', '-muxpreload', '0', '-segment_list', csv, '-segment_list_type', 'csv',
      path.join(this.dir, `${prefix}%05d.ts`),
    ];
    const proc = spawn(this.ffmpeg, args, { windowsHide: true });
    try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* egal */ }
    const sess = { n, prefix, csv, proc, t0: null, closed: false, exited: false };
    this.sessions.push(sess); this.current = sess; this.stopping = false;
    proc.stderr.on('data', (d) => { this.lastLog = (this.lastLog + d.toString()).slice(-1500); });
    proc.stdin.on('error', () => {});
    proc.on('close', (code) => {
      sess.exited = true;
      if (this.current === sess) this.current = null;
      if (!this.stopping) this.emit('ended', code, this.lastLog.trim().split('\n').pop() || '');
    });
    return sess;
  }

  async stop() {
    this.stopping = true;
    const sess = this.current;
    if (!sess || sess.exited) return;
    const closed = new Promise((r) => sess.proc.once('close', r));
    try { sess.proc.stdin.write('q'); } catch { /* egal */ }
    const t = setTimeout(() => sess.proc.kill(), 4000);
    await closed;
    clearTimeout(t);
  }

  /** Wartet, bis das erste Segment der aktuellen Session existiert (= Daten fließen). */
  waitForData(sess, timeoutMs) {
    const first = path.join(this.dir, `${sess.prefix}00000.ts`);
    const began = Date.now();
    return new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        try {
          const st = fs.statSync(first);
          sess.t0 = st.birthtimeMs || st.ctimeMs;
          clearInterval(iv); resolve();
        } catch {
          if (sess.exited) { clearInterval(iv); reject(new Error(this.lastLog.trim().split('\n').pop() || 'Videoempfänger beendet')); }
          else if (Date.now() - began > timeoutMs) { clearInterval(iv); reject(new Error('Keine Videodaten von OBS empfangen (Zeitüberschreitung).')); }
        }
      }, 100);
    });
  }

  /** Fertige Segmente (exakte Längen aus ffmpegs Liste), in zeitlicher Reihenfolge. */
  finalized() {
    const out = [];
    for (const s of this.sessions) {
      let lines = [];
      try { lines = fs.readFileSync(s.csv, 'utf8').split(/\r?\n/).filter(Boolean); } catch { continue; }
      for (const l of lines) {
        const [name, a, b] = l.split(',');
        const m = /-(\d{5})\.ts$/.exec(name || '');
        const dur = parseFloat(b) - parseFloat(a);
        if (m && dur > 0) out.push({ sess: s, idx: m[1], file: path.join(this.dir, path.basename(name)), duration: dur, final: true });
      }
    }
    return out;
  }

  /** Datei des gerade geschriebenen Segments (oder null). */
  openSegment() {
    const s = this.sessions[this.sessions.length - 1];
    if (!s || s.exited || !s.t0) return null;
    const done = new Set(this.finalized().filter((f) => f.sess === s).map((f) => f.idx));
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((f) => f.startsWith(s.prefix) && f.endsWith('.ts')).sort(); } catch { return null; }
    const open = names.filter((f) => !done.has(/-(\d{5})\.ts$/.exec(f)[1])).pop();
    return open ? { sess: s, file: path.join(this.dir, open) } : null;
  }

  /** Länge einer (noch wachsenden) Datei – ffmpeg liest die Dauer vom Dateiende. */
  measure(file) {
    return new Promise((resolve) => {
      const p = spawn(this.ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', () => resolve(0));
      p.on('close', () => {
        const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
        resolve(m ? +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]) : 0);
      });
    });
  }

  /** Zeitleiste für einen Clip: fertige Segmente + das laufende (gemessen). [{file,duration}] */
  async timeline() {
    const list = this.finalized().map((f) => ({ file: f.file, duration: f.duration }));
    const open = this.openSegment();
    if (open) {
      const d = await this.measure(open.file);
      if (d > 0.2) list.push({ file: open.file, duration: d });
    }
    return list;
  }

  /** Grobe Puffer-Länge für die Anzeige (Sekunden). */
  bufferedSeconds(now = Date.now()) {
    const fin = this.finalized();
    let total = fin.reduce((a, f) => a + f.duration, 0);
    const s = this.sessions[this.sessions.length - 1];
    if (s && !s.exited && s.t0) {
      let since = s.t0;
      try { since = Math.max(s.t0, fs.statSync(s.csv).mtimeMs); } catch { /* noch keine Liste */ }
      total += Math.min(Math.max(0, (now - since) / 1000), 12);
    }
    return total;
  }

  /** Löscht Segmente, die über die Puffer-Länge hinausgehen. */
  prune(keepSeconds, isPinned = () => false) {
    const fin = this.finalized();
    let acc = this.openSegment() ? 5 : 0;
    for (let i = fin.length - 1; i >= 0; i--) {
      if (acc > keepSeconds + 25 && !isPinned(fin[i].file)) fs.promises.unlink(fin[i].file).catch(() => {});
      acc += fin[i].duration;
    }
  }

  bytes() {
    let n = 0;
    try { for (const f of fs.readdirSync(this.dir)) if (/^s\d+-\d{5}\.ts$/.test(f)) n += fs.statSync(path.join(this.dir, f)).size; } catch { /* egal */ }
    return n;
  }

  clear() {
    try { for (const f of fs.readdirSync(this.dir)) if (/^s\d+-/.test(f)) fs.unlinkSync(path.join(this.dir, f)); } catch { /* egal */ }
    this.sessions = [];
  }
}

module.exports = { Segmenter, SEG_SECONDS };
