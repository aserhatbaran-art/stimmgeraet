/**
 * Erzeugt die App-Icons als PNG – ohne Zusatzpakete, nur mit Node-Bordmitteln.
 * Aufruf: node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const BG = [13, 17, 23];
const GREEN = [63, 220, 133];
const GREY = [110, 122, 137];
const WHITE = [230, 237, 243];

/**
 * Farbe eines Punktes im Einheitsquadrat (0…1). Rückgabe [r, g, b, alpha].
 * @param {number} scale Größe des Motivs (maskable-Icons brauchen mehr Rand)
 * @param {boolean} rounded abgerundete Ecken mit transparentem Hintergrund
 */
function shade(u, v, scale, rounded) {
  if (rounded) {
    const r = 0.22;
    const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
  }

  // Koordinaten relativ zum Drehpunkt der Nadel
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale - 0.3;
  const dist = Math.hypot(x, y);
  const angle = (Math.atan2(x, -y) * 180) / Math.PI; // 0° = senkrecht nach oben

  // Nadel, leicht nach rechts geneigt
  const na = (12 * Math.PI) / 180;
  const nx = Math.sin(na);
  const ny = -Math.cos(na);
  const along = Math.max(0, Math.min(0.56, x * nx + y * ny));
  if (Math.hypot(x - nx * along, y - ny * along) < 0.022) return [...WHITE, 1];
  if (dist < 0.06) return [...WHITE, 1];

  // Skalenbogen mit grünem Mittelbereich
  if (dist > 0.62 && dist < 0.7 && Math.abs(angle) < 58) {
    return [...(Math.abs(angle) < 14 ? GREEN : GREY), 1];
  }
  // Teilstriche
  if (dist > 0.5 && dist < 0.62) {
    for (const tick of [-45, -30, 30, 45]) {
      if (Math.abs(angle - tick) < 1.6) return [...GREY, 1];
    }
  }
  return [...BG, 1];
}

function render(size, { scale, rounded }) {
  const SS = 4; // Kantenglättung: 4 × 4 Unterpunkte je Pixel
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    const row = py * (size * 4 + 1);
    rows[row] = 0; // PNG-Filter „None“
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, scale, rounded);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = row + 1 + px * 4;
      rows[o] = a ? Math.round(r / a) : 0;
      rows[o + 1] = a ? Math.round(g / a) : 0;
      rows[o + 2] = a ? Math.round(b / a) : 0;
      rows[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return png(size, size, rows);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function png(width, height, rows) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit-Tiefe
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, { scale: 0.62, rounded: true }],
  ['icon-512.png', 512, { scale: 0.62, rounded: true }],
  ['icon-maskable-512.png', 512, { scale: 0.5, rounded: false }],
];
for (const [name, size, options] of icons) {
  writeFileSync(join(OUT, name), render(size, options));
  console.log(`${name} (${size} × ${size})`);
}
