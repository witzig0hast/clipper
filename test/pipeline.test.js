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

test('planWindow: letzte 12s', () => {
  const s = [seg(1, 0, 10500), seg(2, 10000, 10500), seg(3, 20000, 4000)];
  const { parts, firstFrom } = T.planWindow(s, 12000, 24000);
  assert.strictEqual(parts.length, 2);
  assert.strictEqual(firstFrom, 10000);
  assert.ok(Math.abs(parts[1].outpoint - 4) < 1e-9);
});

test('expiredSegments', () => {
  const s = [seg(1, 0, 10000), seg(2, 10000, 10000), seg(3, 100000, 10000)];
  const ex = T.expiredSegments(s, 30, 0);
  assert.deepStrictEqual(ex.map((x) => x.id), [1, 2]);
});

test('End-to-End: TS-Video + WebM-Ton → MP4 (Ton wanduhr-synchron)', async () => {
  const ff = E.resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-t-'));
  const mk = (args) => { const r = spawnSync(ff, ['-y', '-loglevel', 'error', ...args]); assert.strictEqual(r.status, 0, String(r.stderr)); };
  const base = 1_000_000;
  // Video: 3 Segmente à 4 s ab t=base (Ende = base+12000)
  const vsegs = [0, 1, 2].map((i) => {
    const f = path.join(dir, `v${i}.ts`);
    mk(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-f', 'mpegts', f]);
    return { id: i, file: f, startedAt: base + i * 4000, endedAt: base + (i + 1) * 4000 };
  });
  // Ton: Segmente starten 1 s nach Videobeginn, überlappen um 0.5 s
  const asegs = [0, 1].map((i) => {
    const f = path.join(dir, `a${i}.webm`);
    mk(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6.5', '-c:a', 'libopus', f]);
    return { id: i, file: f, startedAt: base + 1000 + i * 6000, endedAt: base + 1000 + i * 6000 + 6500 };
  });
  const we = base + 12000, ws = we - 9000;
  const v = T.planWindow(vsegs, ws, we);
  const a = T.planWindow(asegs, ws, we);
  const out = path.join(dir, 'out.mp4');
  let last = 0;
  const dur = await E.exportClip(ff, { ws, we, video: v, audio: a }, out, { fps: 30, bitrateMbps: 4, encoder: 'libx264', onProgress: (p) => { last = p; } });
  assert.ok(Math.abs(dur - 9) < 0.01);
  const probe = spawnSync(ff, ['-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr);
  const real = +m[1] * 3600 + +m[2] * 60 + +m[3];
  assert.ok(Math.abs(real - 9) < 0.3, `Dauer ${real}`);
  assert.ok(/Audio: aac/.test(probe.stderr) && /Video: h264/.test(probe.stderr));
  assert.ok(last > 0.9, 'Fortschritt gemeldet');
  // Ohne Ton
  const out3 = path.join(dir, 'silent.mp4');
  await E.exportClip(ff, { ws, we, video: v, audio: null }, out3, { fps: 30, bitrateMbps: 4, encoder: 'libx264' });
  assert.ok(!/Audio:/.test(spawnSync(ff, ['-i', out3], { encoding: 'utf8' }).stderr));
  // Trim + Thumbnail
  const out2 = path.join(dir, 'trim.mp4');
  await E.trimClip(ff, out, out2, 1, 4, { fps: 30, bitrateMbps: 4, encoder: 'libx264' });
  assert.ok(fs.statSync(out2).size > 1000);
  await E.makeThumbnail(ff, out, path.join(dir, 't.jpg'));
  assert.ok(fs.existsSync(path.join(dir, 't.jpg')));
});
