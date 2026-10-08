'use strict';

// Generates build/icon.ico (and build/icon.png) without any image library:
// renders the mark with signed-distance fields, encodes PNG by hand.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [256, 128, 64, 48, 32, 16];
const BIG = 1024;

function mix(a, b, t) {
  const k = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function roundRect(x, y, w, h, r) {
  // signed distance: negative inside
  const dx = Math.abs(x) - (w / 2 - r);
  const dy = Math.abs(y) - (h / 2 - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.sqrt(ax * ax + ay * ay) - r;
}

function shade(u, v) {
  // u,v in [-1,1] space of the 1x1 icon
  const bgA = [0x1d, 0x17, 0x12];
  const bgB = [0x3b, 0x2b, 0x1d];
  const accA = [0xff, 0xd3, 0x72];
  const accB = [0xe9, 0x97, 0x25];

  const plate = roundRect(u, v, 1.74, 1.74, 0.42);
  if (plate > 0.02) return [0, 0, 0, 0];

  const t = (u + v + 2) / 4;
  let col = mix(bgA, bgB, Math.max(0, Math.min(1, t)));
  let alpha = Math.max(0, Math.min(1, (0.02 - plate) / 0.03));

  // warm glow from the top left
  const gd = Math.hypot(u + 0.55, v + 0.6);
  col = mix(col, [0x5a, 0x40, 0x27], Math.max(0, 0.55 - gd) * 0.9);

  const put = (c, cov) => { col = mix(col, c, Math.max(0, Math.min(1, cov))); };

  // open book: two pages tilted away from a central spine
  const pageH = 0.60;
  const bookTop = -0.42;
  const spineW = 0.035;
  const lean = 0.17;

  for (const side of [-1, 1]) {
    // page body as a sheared rounded rect
    const px = u - side * 0.44;
    const py = v - 0.07;
    const sheared = px + side * lean * (py / pageH);
    const d = roundRect(sheared, py, 0.80, pageH * 2, 0.07);
    const cov = Math.max(0, Math.min(1, -d / 0.016));
    put(side < 0 ? [0xf6, 0xef, 0xe2] : [0xe4, 0xd8, 0xc4], cov);

    // ruled lines on the page
    for (let i = 0; i < 3; i++) {
      const ly = -0.30 + i * 0.22;
      const lineD = Math.max(Math.abs(py - ly) - 0.022, roundRect(sheared, py, 0.56, pageH * 1.5, 0.05));
      put([0xbb, 0xa8, 0x8c], Math.max(0, Math.min(1, -lineD / 0.014)) * 0.85);
    }
  }

  // spine
  const spine = roundRect(u, v - 0.07, spineW * 2, pageH * 2.08, 0.02);
  put(mix(accB, accA, (v + 0.7) / 1.4), Math.max(0, Math.min(1, -spine / 0.014)));

  // bookmark ribbon falling out of the book
  const ribX = u - 0.17;
  const ribY = v - 0.46;
  const rib = roundRect(ribX, ribY, 0.15, 0.56, 0.025);
  const notch = 0.085 - Math.hypot(ribX, ribY - 0.26);
  put(mix(accA, accB, (v + 1) / 2), Math.max(0, Math.min(1, -Math.max(rib, -notch * 3) / 0.016)));

  // sparks: the "second brain" accent
  for (const s of [[-0.60, -0.56, 0.17], [0.60, -0.62, 0.10]]) {
    const sx = u - s[0];
    const sy = v - s[1];
    const arm = s[2];
    const star = Math.min(
      Math.max(Math.abs(sx) - arm * 0.12, Math.abs(sy) - arm),
      Math.max(Math.abs(sx) - arm, Math.abs(sy) - arm * 0.12)
    );
    put(accA, Math.max(0, Math.min(1, -star / 0.02)));
  }

  // inner top highlight on the plate edge
  const edge = Math.abs(plate + 0.035) - 0.012;
  put([0xff, 0xff, 0xff], Math.max(0, Math.min(1, -edge / 0.02)) * 0.1);

  return [col[0], col[1], col[2], alpha * 255];
}

function renderRGBA(size) {
  const ss = size <= 48 ? 4 : 3;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / ss) / size) * 2 - 1;
          const c = shade(u, v);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      out[i] = a > 0 ? Math.round(r / a) : 0;
      out[i + 1] = a > 0 ? Math.round(g / a) : 0;
      out[i + 2] = a > 0 ? Math.round(b / a) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --- PNG encoding ---------------------------------------------------------

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function buildIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    header[p] = e.size >= 256 ? 0 : e.size;
    header[p + 1] = e.size >= 256 ? 0 : e.size;
    header[p + 2] = 0;
    header[p + 3] = 0;
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(e.png.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header].concat(entries.map((e) => e.png)));
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const entries = SIZES.map((size) => ({ size, png: encodePng(size, renderRGBA(size)) }));
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(entries));
fs.writeFileSync(path.join(outDir, 'icon.png'), entries[0].png);
fs.writeFileSync(path.join(outDir, 'icon-1024.png'), encodePng(BIG, renderRGBA(BIG)));
console.log('icon.ico written:', SIZES.join(', '), '-', fs.statSync(path.join(outDir, 'icon.ico')).size, 'bytes');
