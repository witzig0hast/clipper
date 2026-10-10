'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../src/main/timeline');
const E = require('../src/main/exporter');

test('planTail: letzte 12 s aus 10/10/4,5 s', () => {
  const tl = [{ file: 'a', duration: 10 }, { file: 'b', duration: 10 }, { file: 'c', duration: 4.5 }];
  const p = T.planTail(tl, 12);
  assert.deepStrictEqual(p.parts.map((x) => x.file), ['b', 'c']);
  assert.ok(Math.abs(p.parts[0].inpoint - 2.5) < 1e-9);
  assert.ok(Math.abs(p.duration - 12) < 1e-9);
});

test('planTail: mehr gewünscht als vorhanden', () => {
  const p = T.planTail([{ file: 'a', duration: 5 }], 600);
  assert.strictEqual(p.parts.length, 1);
  assert.strictEqual(p.parts[0].inpoint, 0);
  assert.strictEqual(p.duration, 5);
});

test('planTail: leer', () => {
  assert.strictEqual(T.planTail([], 30).parts.length, 0);
});

test('verlustfreier Clip aus TS-Segmenten (Bild + Ton) startet auf Keyframe', async () => {
  const ff = E.resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-t-'));
  // 3 Segmente à 10 s mit 1-s-Keyframes, H.264 + AAC (wie der OBS-Strom)
  const csv = path.join(dir, 'l.csv');
  const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-f', 'segment', '-segment_time', '10', '-segment_format', 'mpegts', '-reset_timestamps', '1', '-muxdelay', '0', '-muxpreload', '0',
    '-segment_list', csv, '-segment_list_type', 'csv', path.join(dir, 's-%05d.ts')]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const tl = fs.readFileSync(csv, 'utf8').trim().split('\n').map((l) => { const [n, a, b] = l.split(','); return { file: path.join(dir, n), duration: b - a }; });
  assert.strictEqual(tl.length, 3);
  const plan = T.planTail(tl, 17.4);
  const out = path.join(dir, 'out.mp4');
  const dur = await E.exportClipCopy(ff, plan, out, {});
  const probe = spawnSync(ff, ['-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
  const real = +m[1] * 3600 + +m[2] * 60 + +m[3];
  assert.ok(real >= 17.3 && real <= 18.8, `Dauer ${real} (geplant ${dur})`);
  assert.ok(/Audio: aac/.test(probe.stderr) && /Video: h264/.test(probe.stderr));
  assert.ok(!/error|corrupt/i.test(probe.stderr.replace(/Error while/g, '')), probe.stderr.slice(-300));
  // Trim (Re-Encode) + Thumbnail
  const out2 = path.join(dir, 'trim.mp4');
  await E.trimClip(ff, out, out2, 1, 4, { fps: 30, bitrateMbps: 4, encoder: 'libx264' });
  assert.ok(fs.statSync(out2).size > 1000);
  await E.makeThumbnail(ff, out, path.join(dir, 't.jpg'));
  assert.ok(fs.existsSync(path.join(dir, 't.jpg')));
});
