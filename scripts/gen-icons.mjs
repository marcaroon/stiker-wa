// Generates the PWA icons (PNG) without any image library.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const OUT = path.resolve('public/icons');
fs.mkdirSync(OUT, { recursive: true });

const GREEN = [31, 174, 87];
const DARK = [11, 74, 38];
const WHITE = [255, 255, 255];
const FOLD = [205, 238, 217];

function roundRectInside(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Colour at normalised coords (0..1). bgRound: draw rounded background (non-maskable). */
function shade(u, v, { bgRound, inset }) {
  if (bgRound && !roundRectInside(u, v, 0, 0, 1, 1, 0.22)) return null;
  // sticker body
  const a = inset, b = 1 - inset;
  const s = b - a;
  const cut = a + s * 1.62; // diagonal for peeled corner (u + v > cut)
  const inBody = roundRectInside(u, v, a, a, b, b, s * 0.2) && u + v <= cut;
  // fold triangle
  const inFold = u + v > cut && u <= b - 0.0 && v <= b && u + v <= cut + s * 0.26 && u > a + s * 0.62 && v > a + s * 0.62;
  if (inFold) return FOLD;
  if (inBody) {
    // smile + eyes
    const lx = (u - a) / s, ly = (v - a) / s;
    const eye = (ex) => (lx - ex) ** 2 + (ly - 0.38) ** 2 < 0.075 ** 2;
    if (eye(0.34) || eye(0.66)) return DARK;
    const d = Math.hypot(lx - 0.5, ly - 0.48);
    if (ly > 0.55 && d > 0.22 && d < 0.3 && lx > 0.22 && lx < 0.78) return DARK;
    return WHITE;
  }
  return GREEN;
}

function png(size, opts) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, al = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; al++; }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const n = SS * SS;
      raw[o] = al ? r / al : 0;
      raw[o + 1] = al ? g / al : 0;
      raw[o + 2] = al ? b / al : 0;
      raw[o + 3] = (255 * al) / n;
    }
  }
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(path.join(OUT, 'icon-192.png'), png(192, { bgRound: true, inset: 0.2 }));
fs.writeFileSync(path.join(OUT, 'icon-512.png'), png(512, { bgRound: true, inset: 0.2 }));
fs.writeFileSync(path.join(OUT, 'maskable-512.png'), png(512, { bgRound: false, inset: 0.28 }));
fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), png(180, { bgRound: false, inset: 0.22 }));
console.log('icons written to', OUT);
