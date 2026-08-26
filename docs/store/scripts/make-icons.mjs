#!/usr/bin/env node
// Dayflow brand icons — generated, never downloaded. No external assets, no image dependency:
// the mark is drawn analytically (rounded-square tile + a geometric "D" made of a bar and a half-ring),
// supersampled 4x4 for anti-aliasing, and written as 8-bit RGBA PNG with node:zlib.
//
// Usage: node docs/store/scripts/make-icons.mjs [outDir]      (default: extension/public/icon)
// Colours are the panel's own tokens (extension/src/ui/styles.css): accent oklch(0.7 0.19 292).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? resolve(here, '../../../extension/public/icon'));
const SIZES = [16, 32, 48, 96, 128];
const SS = 4; // supersampling factor per axis

// ---------- colour ----------
/** oklch → sRGB [0..255]; out-of-gamut components are clamped (the accent sits just inside sRGB). */
function oklch(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  });
}

const TOP = oklch(0.74, 0.185, 292); // accent, lifted
const BOTTOM = oklch(0.56, 0.19, 292); // deeper violet for the diagonal gradient
const GLYPH = oklch(0.985, 0.006, 292); // near-white, faintly violet

// ---------- geometry (unit coordinates, 0..1 of the tile) ----------
const R_TILE = 0.225; // corner radius
const T = 0.098; // stroke thickness of the mark
const LEFT = 0.322; // left edge of the stem
const CX = LEFT + T; // centre of the bowl
const RO = 0.262; // outer radius of the bowl
const CY = 0.5;

/** Signed distance to a rounded square covering [0,1]² (negative inside). */
function sdRoundedTile(x, y) {
  const qx = Math.abs(x - 0.5) - (0.5 - R_TILE);
  const qy = Math.abs(y - 0.5) - (0.5 - R_TILE);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - R_TILE;
}

/** Signed distance to the "D": stem (rounded bar) ∪ bowl (right half-annulus). Negative inside. */
function sdMark(x, y) {
  // stem: rounded box centred at (LEFT + T/2, CY), half-extents (T/2, RO), corner radius T/2
  const qx = Math.abs(x - (LEFT + T / 2)); // half-extent T/2 minus radius T/2 = 0
  const qy = Math.abs(y - CY) - (RO - T / 2);
  const stem = Math.hypot(qx, Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - T / 2;
  // bowl: annulus of radius RO-T/2 and thickness T, intersected with the half-plane x >= CX
  const ring = Math.abs(Math.hypot(x - CX, y - CY) - (RO - T / 2)) - T / 2;
  const bowl = Math.max(ring, CX - x);
  return Math.min(stem, bowl);
}

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer of size*size*4 → PNG bytes (8-bit RGBA, filter 0 per row). */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- render ----------
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (sdRoundedTile(x, y) > 0) continue; // outside the tile → transparent
          const t = (x + y) / 2; // diagonal gradient
          const inMark = sdMark(x, y) <= 0;
          const c = inMark ? GLYPH : [TOP[0] + (BOTTOM[0] - TOP[0]) * t, TOP[1] + (BOTTOM[1] - TOP[1]) * t, TOP[2] + (BOTTOM[2] - TOP[2]) * t];
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const i = (py * size + px) * 4;
      if (a === 0) continue;
      const cover = a / samples / 255; // premultiply-free: average the covered samples only
      rgba[i] = Math.round(r / (a / 255));
      rgba[i + 1] = Math.round(g / (a / 255));
      rgba[i + 2] = Math.round(b / (a / 255));
      rgba[i + 3] = Math.round(cover * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const png = render(size);
  const file = resolve(outDir, `${size}.png`);
  writeFileSync(file, png);
  console.log(`${file} — ${size}x${size}, ${png.length} bytes`);
}
