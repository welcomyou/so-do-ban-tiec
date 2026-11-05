// Test thuật toán detectCircles bằng ảnh tổng hợp: vẽ 32 bàn tròn
// mô phỏng layout Topaz (8 cột x 4 hàng + sân khấu + noise) rồi đếm kết quả.
import { detectCircles } from '../public/js/detect.js';

const W = 1500, H = 1000;
const data = new Uint8ClampedArray(W * H * 4).fill(255);

function strokeCircle(cx, cy, r, width = 3, dark = 30) {
  for (let a = 0; a < 3600; a++) {
    const rad = (a / 3600) * Math.PI * 2;
    for (let w = -width / 2; w <= width / 2; w += 0.5) {
      const x = Math.round(cx + Math.cos(rad) * (r + w));
      const y = Math.round(cy + Math.sin(rad) * (r + w));
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = dark;
    }
  }
}
function fillRect(x0, y0, x1, y1, dark = 60) {
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = dark;
    }
}

// Sân khấu (hình chữ nhật trên cùng) + bàn tròn 8x4
const truth = [];
fillRect(550, 30, 950, 130, 50);
for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 8; col++) {
    const cx = 130 + col * 170, cy = 260 + row * 200;
    strokeCircle(cx, cy, 62);
    truth.push([cx, cy]);
  }
}

const circles = detectCircles({ width: W, height: H, data }, { sensitivity: 6, rMin: 35, rMax: 100 });

let matched = 0;
for (const [tx, ty] of truth) {
  const hit = circles.find(c => Math.hypot(c.x - tx, c.y - ty) < c.r * 0.5);
  if (hit) matched++;
}
console.log(`Bàn thực tế: ${truth.length} | Phát hiện: ${circles.length} | Khớp đúng: ${matched}`);
for (const c of circles) console.log(`  (${c.x}, ${c.y}) r=${c.r} score=${c.score.toFixed(2)}`);
const ok = matched >= truth.length - 2 && circles.length <= truth.length + 4;
console.log(ok ? '✔ PASS' : '✘ FAIL');
process.exit(ok ? 0 : 1);
