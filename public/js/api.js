// API client — wrapper chung cho mọi request
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'fetch',
      ...(method !== 'GET' ? {} : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Lỗi ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'vừa xong';
  if (s < 60) return `${s} giây trước`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} giờ trước`;
  return `${Math.round(h / 24)} ngày trước`;
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Bấm số bàn: 3 → "Bàn 3", số support "10A"
export function tableSortKey(label) {
  const m = /^(\d+)(.*)$/.exec(String(label).trim());
  if (!m) return [1e9, String(label)];
  return [Number(m[1]), m[2]];
}
export function compareLabels(a, b) {
  const [na, sa] = tableSortKey(a), [nb, sb] = tableSortKey(b);
  return na - nb || sa.localeCompare(sb);
}

export function toast(msg, type = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => el.remove(), 3000);
}
