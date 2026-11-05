// Seed demo: layout 32 bàn kiểu Topaz + xuất bản + vài lượt cập nhật
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let cookie = '';
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return res.json();
}

const user = process.env.ADMIN_USER || 'admin';
const pass = process.env.ADMIN_PASS || 'matkhau123';

// đăng nhập (hoặc tạo mới nếu chưa có)
let r = await req('POST', '/api/login', { username: user, password: pass });
if (!r.ok && r.error?.includes('Sai')) {
  console.log('Login failed:', r.error);
  process.exit(1);
}

// tạo layout 32 bàn: 8 cột x 4 hàng
const tables = [];
let n = 1;
for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 8; col++) {
    tables.push({
      id: 'seed' + n,
      label: String(n),
      total: 10,
      x: 130 + col * 170,
      y: 320 + row * 200,
      r: 62,
    });
    n++;
  }
}
r = await req('POST', '/api/layouts', { name: 'Tiệc Topaz — 32 bàn', width: 1500, height: 1100, tables });
const id = r.id;
console.log('Layout created:', id);

await req('POST', `/api/layouts/${id}/deploy`);
console.log('Deployed');

// mô phỏng người cập nhật đi một vòng
const updates = [
  ['seed1', 6, 'Lan'], ['seed2', 10, 'Lan'], ['seed3', 0, 'Lan'], ['seed4', 8, 'Lan'],
  ['seed5', 3, 'Bảo'], ['seed9', 2, 'Bảo'], ['seed10', 0, 'Bảo'], ['seed17', 5, 'Hùng'],
  ['seed25', 1, 'Hùng'], ['seed31', 4, 'MC Tuấn'], ['seed32', 9, 'MC Tuấn'], ['seed12', 0, 'Lan'],
];
for (const [tid, empty, by] of updates) {
  await req('POST', `/api/tables/${tid}/seats`, { empty, by });
}
console.log('Seeded', updates.length, 'updates. Mở', BASE, 'để xem.');
