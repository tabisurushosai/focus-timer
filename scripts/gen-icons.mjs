// Generate icon16/48/128 PNGs for focus-timer.
// Design: rounded-square background (teal) with a stylized clock face
// (white ring, two hands). Pure Node + zlib, no external deps.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'icons');
mkdirSync(outDir, { recursive: true });

// CRC32 (PNG spec)
const crcTable = (() => {
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
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

// Build an RGBA pixel buffer of size `size`.
function buildPixels(size) {
  const px = new Uint8Array(size * size * 4); // RGBA
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2 - Math.max(1, size * 0.02); // outer radius
  const cornerR = size * 0.22; // rounded-square corner radius

  // Colors
  const BG = [0x14, 0xa3, 0x9b, 0xff];     // teal
  const BG_DARK = [0x0e, 0x7c, 0x76, 0xff]; // teal shadow (unused gradient skip)
  const RING = [0xff, 0xff, 0xff, 0xff];
  const FACE = [0xff, 0xff, 0xff, 0xff];
  const HAND = [0x14, 0x2a, 0x3e, 0xff];   // dark navy

  // Rounded-square test: inside if point within rect inset by cornerR or within
  // a quarter-circle at each corner.
  function inRoundedSquare(x, y) {
    const pad = Math.max(1, size * 0.04);
    const x0 = pad, y0 = pad, x1 = size - pad, y1 = size - pad;
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const inX = x >= x0 + cornerR && x <= x1 - cornerR;
    const inY = y >= y0 + cornerR && y <= y1 - cornerR;
    if (inX || inY) return true;
    const dx = x < x0 + cornerR ? x - (x0 + cornerR) : x - (x1 - cornerR);
    const dy = y < y0 + cornerR ? y - (y0 + cornerR) : y - (y1 - cornerR);
    return dx * dx + dy * dy <= cornerR * cornerR;
  }

  // Clock geometry
  const faceR = size * 0.36;
  const ringInner = faceR - Math.max(1, size * 0.06);
  const minuteHandLen = size * 0.28;
  const hourHandLen = size * 0.20;
  // Hands point to 12 (up) and 2 (upper-right) for a "starting timer" look.
  // Angle measured clockwise from 12.
  const a1 = 0;                 // straight up
  const a2 = (Math.PI * 2) * (10 / 60); // 10-minute mark
  const handW = Math.max(1, size * 0.07);

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cxh = x1 + t * dx, cyh = y1 + t * dy;
    const ex = px - cxh, ey = py - cyh;
    return Math.sqrt(ex * ex + ey * ey);
  }

  const hand1End = [cx + Math.sin(a1) * minuteHandLen, cy - Math.cos(a1) * minuteHandLen];
  const hand2End = [cx + Math.sin(a2) * hourHandLen, cy - Math.cos(a2) * hourHandLen];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let color = [0, 0, 0, 0]; // transparent
      if (inRoundedSquare(x + 0.5, y + 0.5)) {
        color = BG.slice();
        const dxc = x + 0.5 - cx;
        const dyc = y + 0.5 - cy;
        const dist = Math.sqrt(dxc * dxc + dyc * dyc);
        // White ring (clock face) — fill inside faceR
        if (dist <= faceR) color = FACE.slice();
        // Carve back to teal inside ringInner to create ring
        if (dist <= ringInner) color = BG.slice();
        // Hands (only inside face area to avoid drawing on bezel)
        if (dist <= ringInner + size * 0.02) {
          const d1 = distToSegment(x + 0.5, y + 0.5, cx, cy, hand1End[0], hand1End[1]);
          const d2 = distToSegment(x + 0.5, y + 0.5, cx, cy, hand2End[0], hand2End[1]);
          if (d1 <= handW / 2 || d2 <= handW / 2) color = HAND.slice();
          // Center dot
          if (dist <= Math.max(1.2, size * 0.05)) color = HAND.slice();
        }
      }
      px[i] = color[0];
      px[i + 1] = color[1];
      px[i + 2] = color[2];
      px[i + 3] = color[3];
    }
  }
  return px;
}

function encodePng(size, pixels) {
  // Signature
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // IDAT: filter byte 0 per row + raw pixels
  const rowLen = size * 4;
  const raw = Buffer.alloc((rowLen + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (rowLen + 1)] = 0;
    raw.set(pixels.subarray(y * rowLen, (y + 1) * rowLen), y * (rowLen + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  const px = buildPixels(size);
  const png = encodePng(size, px);
  const outPath = resolve(outDir, `icon${size}.png`);
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${png.length} bytes)`);
}
