// Sinh icon PWA (PNG) thuần Node — không cần thư viện ngoài.
// Vẽ: nền xanh đậm bo góc + vòng tròn bàn xanh lá + số ghế trung tâm.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- PNG encoder ----
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- vẽ ----
function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function makeIcon(size, { maskable = false } = {}) {
  const px = new Uint8ClampedArray(size * size * 4);
  const set = (x, y, [r, g, b, a]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const blend = (x, y, [r, g, b, a]) => {
    const i = (y * size + x) * 4;
    const pa = px[i + 3] / 255, na = a / 255;
    const outA = na + pa * (1 - na);
    if (outA === 0) return;
    px[i] = (r * na + px[i] * pa * (1 - na)) / outA;
    px[i + 1] = (g * na + px[i + 1] * pa * (1 - na)) / outA;
    px[i + 2] = (b * na + px[i + 2] * pa * (1 - na)) / outA;
    px[i + 3] = outA * 255;
  };
  const fillCircle = (cx, cy, r, color, AA = 1.5) => {
    for (let y = Math.max(0, cy - r - 2) | 0; y < Math.min(size, cy + r + 2); y++)
      for (let x = Math.max(0, cx - r - 2) | 0; x < Math.min(size, cx + r + 2); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= r - AA) set(x, y, color);
        else if (d <= r + AA) blend(x, y, color);
      }
  };
  const ring = (cx, cy, r, w, color) => {
    for (let y = Math.max(0, cy - r - w) | 0; y < Math.min(size, cy + r + w); y++)
      for (let x = Math.max(0, cx - r - w) | 0; x < Math.min(size, cx + r + w); x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (Math.abs(d - r) <= w / 2) blend(x, y, color);
      }
  };
  const roundedRect = (rad, color) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = Math.min(x, size - 1 - x), dy = Math.min(y, size - 1 - y);
        const cornerDist = Math.hypot(Math.max(rad - dx, 0), Math.max(rad - dy, 0));
        if (cornerDist <= rad - 1) set(x, y, color);
        else if (cornerDist <= rad + 1) blend(x, y, color);
      }
  };

  const BG = maskable ? [11, 16, 28, 255] : [11, 16, 28, 255];
  const scale = size / 512;
  if (maskable) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);
  } else {
    roundedRect(Math.round(96 * scale), BG);
  }

  const cx = size / 2, cy = size / 2;
  const R = 190 * scale;              // vòng bàn
  // vòng tròn bàn (đường viền xanh lá dày)
  ring(cx, cy, R, 34 * scale, [...hex('#22c55e'), 255]);
  // nền nhẹ bên trong
  fillCircle(cx, cy, R - 20 * scale, [34, 197, 94, 36]);
  // các "ghế" chấm trắng quanh vòng
  const chairs = 10;
  for (let i = 0; i < chairs; i++) {
    const a = (i / chairs) * Math.PI * 2 - Math.PI / 2;
    fillCircle(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 17 * scale, [235, 245, 255, 255]);
  }
  // số ghế trống ở tâm — vẽ số "8" dạng 2 khối tròn (ngắn gọn, nhận diện được)
  fillCircle(cx - 16 * scale, cy - 34 * scale, 17 * scale, [110, 242, 165, 255]);
  fillCircle(cx - 16 * scale, cy + 34 * scale, 17 * scale, [110, 242, 165, 255]);
  fillCircle(cx + 34 * scale, cy + 2 * scale, 30 * scale, [110, 242, 165, 255]);

  return encodePNG(size, size, Buffer.from(px));
}

mkdirSync(resolve(root, 'public/icons'), { recursive: true });
writeFileSync(resolve(root, 'public/icons/icon-192.png'), makeIcon(192));
writeFileSync(resolve(root, 'public/icons/icon-512.png'), makeIcon(512));
writeFileSync(resolve(root, 'public/icons/maskable-512.png'), makeIcon(512, { maskable: true }));
writeFileSync(resolve(root, 'public/icons/apple-touch-icon.png'), makeIcon(180));
console.log('OK — icons written to public/icons/');
