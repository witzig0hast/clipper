'use strict';
// Erzeugt assets/icon.png (512) und assets/icon.ico (Multi-Size) ohne externe Abhängigkeiten.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed-Distance-Helfer (Einheitsquadrat 0..1)
const sdRoundRect = (x, y, r) => {
  const qx = Math.abs(x - 0.5) - (0.5 - r), qy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
function sdTriangle(px, py, a, b, c) {
  const e = [[b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]], [a[0] - c[0], a[1] - c[1]]];
  const v = [a, b, c];
  let d = Infinity, s = 1;
  for (let i = 0; i < 3; i++) {
    const wx = px - v[i][0], wy = py - v[i][1];
    const t = Math.max(0, Math.min(1, (wx * e[i][0] + wy * e[i][1]) / (e[i][0] ** 2 + e[i][1] ** 2)));
    d = Math.min(d, Math.hypot(wx - e[i][0] * t, wy - e[i][1] * t));
    const cr = e[i][0] * wy - e[i][1] * wx;
    if (i === 0) s = Math.sign(cr) || 1; else if (Math.sign(cr) !== s && cr !== 0) s = 0;
  }
  return s === 0 ? d : -d;
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size, v = (y + (sy + 0.5) / SS) / size;
      const body = sdRoundRect(u, v, 0.22);
      if (body > 0) continue;
      // Hintergrund-Verlauf violett -> cyan (diagonal)
      let col = mix([124, 58, 237], [34, 211, 238], Math.min(1, Math.max(0, (u + v) / 2)));
      let a = 1;
      const r = Math.hypot(u - 0.5, v - 0.5);
      // weißer Ring (Aufnahme-Ring)
      if (Math.abs(r - 0.30) < 0.032) col = [255, 255, 255];
      // Play-Dreieck
      if (sdTriangle(u, v, [0.43, 0.36], [0.43, 0.64], [0.66, 0.5]) < 0) col = [255, 255, 255];
      acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += a;
    }
    const n = SS * SS, i = (y * size + x) * 4;
    const al = acc[3];
    out[i] = al ? acc[0] / al : 0; out[i + 1] = al ? acc[1] / al : 0; out[i + 2] = al ? acc[2] / al : 0;
    out[i + 3] = Math.round((al / n) * 255);
  }
  return out;
}

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png(512, render(512)));
const sizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = sizes.map((s) => png(s, render(s)));
const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += imgs[i].length;
  return e;
});
fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([head, ...entries, ...imgs]));
console.log('Icons geschrieben nach', dir);
