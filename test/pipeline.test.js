'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../src/main/timeline');
const E = require('../src/main/exporter');

const seg = (id, start, len) => ({ id, file: `/x/${id}.webm`, startedAt: start, endedAt: start + len });

test('überlappende Segmente werden zurechtgeschnitten', () => {
  const s = [seg(1, 0, 10500), seg(2, 10000, 10500), seg(3, 20000, 4000)];
  const iv = T.usableIntervals(s);
  assert.deepStrictEqual(iv.map((x) => [x.from, x.to]), [[0, 10000], [10000, 20000], [20000, 24000]]);
  assert.strictEqual(T.bufferedSeconds(s), 24);
});

test('planClip: letzte 12s', () => {
  const s = [seg(1, 0, 10500), seg(2, 10000, 10500), seg(3, 20000, 4000)];
  const { parts, duration } = T.planClip(s, 12);
  assert.strictEqual(parts.length, 2);
  assert.ok(Math.abs(parts[0].inpoint - 2) < 1e-9);
  assert.ok(Math.abs(duration - 12) < 1e-6);
});

test('planClip: mehr gewünscht als vorhanden', () => {
  const { duration } = T.planClip([seg(1, 0, 5000)], 600);
  assert.ok(Math.abs(duration - 5) < 1e-6);
});

test('expiredSegments', () => {
  const s = [seg(1, 0, 10000), seg(2, 10000, 10000), seg(3, 100000, 10000)];
  const ex = T.expiredSegments(s, 30, 0);
  assert.deepStrictEqual(ex.map((x) => x.id), [1, 2]);
});

test('End-to-End: WebM-Segmente → MP4', async () => {
  const ff = E.resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-t-'));
  const files = [];
  for (let i = 0; i < 3; i++) {
    const f = path.join(dir, `s${i}.webm`);
    const r = spawnSync(ff, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4.5', '-c:v', 'libvpx', '-c:a', 'libopus', f]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    files.push(f);
  }
  const segs = files.map((f, i) => ({ id: i, file: f, startedAt: i * 4000, endedAt: i * 4000 + 4500 }));
  const { parts, duration } = T.planClip(segs, 9);
  const out = path.join(dir, 'out.mp4');
  let last = 0;
  await E.exportClip(ff, parts, out, { fps: 30, bitrateMbps: 4, encoder: 'libx264', onProgress: (p) => { last = p; } });
  assert.ok(fs.statSync(out).size > 10000);
  const probe = spawnSync(ff, ['-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
  const dur = +m[1] * 3600 + +m[2] * 60 + +m[3];
  assert.ok(Math.abs(dur - duration) < 0.5, `Dauer ${dur} vs ${duration}`);
  assert.ok(/Audio: aac/.test(probe.stderr) && /Video: h264/.test(probe.stderr));
  assert.ok(last > 0.9, 'Fortschritt gemeldet');
  // Trim + Thumbnail
  const out2 = path.join(dir, 'trim.mp4');
  await E.trimClip(ff, out, out2, 1, 4, { fps: 30, bitrateMbps: 4, encoder: 'libx264' });
  assert.ok(fs.statSync(out2).size > 1000);
  await E.makeThumbnail(ff, out, path.join(dir, 't.jpg'));
  assert.ok(fs.existsSync(path.join(dir, 't.jpg')));
});
