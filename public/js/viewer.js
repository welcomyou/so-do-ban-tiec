// Viewer — màn hình chính cho MC/người dẫn khách/người cập nhật (không cần login)
import { api, timeAgo, compareLabels, toast, clamp } from './api.js';
import { PanZoomCanvas } from './canvas-view.js';
import { openSheet, closeSheet, isSheetOpen } from './ui.js';

const POLL_MS = 3000;
const FLASH_MS = 4500;

let engine = null;
let scene = { active: false, layoutId: null, name: '', version: -1, tables: [], width: 1000, height: 700, bgUrl: null, feed: [] };
let bgImg = null, bgDim = null, bgUrlLoaded = null;
let selected = null;
let pollDelay = POLL_MS, pollTimer = null, lastOk = 0;
let wakeLock = null, wakeOn = localStorage.getItem('wake') === '1';
let nick = localStorage.getItem('nick') || '';
let lastSummaryText = '';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initViewer() {
  const canvas = $('cv');
  engine = new PanZoomCanvas(canvas, {
    draw,
    hitTest,
    onTap: (obj) => { if (obj) openUpdateSheet(obj); },
    onDoubleTap: (obj) => {
      if (obj) zoomToTable(obj);
      else fitView();
    },
    allowObjectDrag: false,
  });

  $('btn-fit').onclick = () => fitView();
  $('btn-list').onclick = () => { buildList(); openSheet($('sheet-list'), $('sheet-list-backdrop')); };
  $('list-close').onclick = () => closeSheet($('sheet-list'), $('sheet-list-backdrop'));
  $('list-filter').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    [...$('list-filter').children].forEach(c => c.classList.toggle('active', c === b));
    buildList(b.dataset.f);
  });
  $('upd-close').onclick = () => closeUpdateSheet();
  $('upd-minus').onclick = () => bumpSelected(-1);
  $('upd-plus').onclick = () => bumpSelected(+1);
  $('btn-menu').onclick = () => openMenu();
  $('menu-close').onclick = () => closeSheet($('sheet-menu'), $('sheet-menu-backdrop'));
  $('ios-install').hidden = !isIOS();
  $('inp-nick').value = nick;
  $('inp-nick').addEventListener('change', (e) => {
    nick = e.target.value.trim();
    localStorage.setItem('nick', nick);
    toast('Đã lưu tên của bạn', 'ok');
  });
  $('btn-wake').onclick = toggleWake;
  setWakeSwitch();
  $('btn-refresh').onclick = () => { schedulePoll(50); toast('Đang làm mới…'); };
  $('btn-install').onclick = installApp;

  ['sheet-update-backdrop', 'sheet-list-backdrop', 'sheet-menu-backdrop'].forEach(id => {
    $(id).addEventListener('click', () => {
      if (id === 'sheet-update-backdrop') closeUpdateSheet();
      if (id === 'sheet-list-backdrop') closeSheet($('sheet-list'), $(id));
      if (id === 'sheet-menu-backdrop') closeSheet($('sheet-menu'), $(id));
    });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { schedulePoll(150); if (wakeOn) acquireWake(); }
  });
  if (wakeOn) acquireWake();

  setInterval(uiSecondTick, 1000);
  startSync();
}

// ---------- đồng bộ thời gian thực: SSE trước, polling làm fallback ----------
let eventSource = null;

function startSync() {
  connectStream();
  schedulePoll(0); // lấy state đầu tiên ngay
}

function connectStream() {
  if (!('EventSource' in window)) return; // polling đảm nhiệm
  try {
    eventSource = new EventSource('/api/stream');
    eventSource.addEventListener('state', (e) => {
      const st = JSON.parse(e.data);
      lastOk = Date.now();
      setLiveDot('ok');
      if (st.active) applyState(st);
    });
    eventSource.addEventListener('empty', () => {
      lastOk = Date.now();
      setLiveDot('ok');
      if (!scene.active) showEmptyState(true);
    });
    eventSource.addEventListener('ping', () => {
      lastOk = Date.now();
      setLiveDot('ok');
    });
    eventSource.onerror = () => {
      setLiveDot('off');
      if (eventSource) { eventSource.close(); eventSource = null; }
      schedulePoll(200); // polling cứu thời điểm ngắn
      // thử nối lại SSE sau 8s (tránh vòng lặp lỗi dồn dập)
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectStream, 8000);
    };
  } catch {
    /* polling đảm nhiệm */
  }
}

let reconnectTimer = null;

// ---------- polling (fallback) ----------
// ---------- polling (fallback khi SSE không khả dụng) ----------
function schedulePoll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, delay);
}
async function tick() {
  // đang có SSE hoạt động thì polling chỉ giữ vai trò dự phòng thưa
  const idle = !!eventSource;
  try {
    const st = await api(`/api/state?v=${scene.version}`);
    lastOk = Date.now();
    setLiveDot('ok');
    pollDelay = idle ? 10000 : POLL_MS;
    if (st.active && st.changed) applyState(st);
    if (!st.active && !scene.active) showEmptyState(true);
  } catch {
    setLiveDot('off');
    pollDelay = Math.min(Math.round(pollDelay * 1.8), 15000);
  }
  schedulePoll(document.hidden ? 12000 : pollDelay);
}

function applyState(st) {
  const oldMap = new Map(scene.tables.map(t => [t.id, t]));
  const firstLoad = scene.layoutId !== st.layoutId;
  scene = { ...scene, ...st };
  scene.tables = st.tables.map(t => {
    const old = oldMap.get(t.id);
    const flashUntil = (old && old.empty !== t.empty) ? Date.now() + FLASH_MS : (old?.flashUntil || 0);
    return { ...t, flashUntil };
  });
  showEmptyState(false);
  loadBg(st.bgUrl);
  if (firstLoad) fitView();
  updateSummary();
  if (isSheetOpen($('sheet-update')) && selected) {
    const fresh = scene.tables.find(t => t.id === selected.id);
    if (fresh) { selected = fresh; renderUpdateSheet(); }
  }
  engine?.requestRender();
}

function loadBg(url) {
  if (!url || url === bgUrlLoaded) { if (!url) { bgDim = null; } return; }
  bgUrlLoaded = url; bgDim = null;
  const img = new Image();
  img.onload = () => {
    // Tối ảnh nền: giảm độ sáng/độ bão hoà để các vòng bàn nổi bật
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const cx = c.getContext('2d');
    cx.filter = 'brightness(0.55) saturate(0.8)';
    cx.drawImage(img, 0, 0);
    bgDim = c;
    bgImg = img;
    engine?.requestRender();
  };
  img.src = url;
}

// ---------- vẽ ----------
function hitTest(wx, wy) {
  if (!scene.tables.length) return null;
  let best = null, bestD = Infinity;
  for (const t of scene.tables) {
    const d = Math.hypot(wx - t.x, wy - t.y);
    if (d <= t.r * 1.18 && d < bestD) { best = t; bestD = d; }
  }
  return best;
}

function classOf(t) {
  if (t.total === 0) return 'amber';
  const ratio = t.empty / t.total;
  if (t.empty <= 0) return 'red';
  if (ratio < 0.35) return 'amber';
  return 'green';
}

const PALETTE = {
  green: { fill: 'rgba(34,197,94,0.20)', ring: '#2fdd6f', num: '#6ef2a5', label: '#a9f5c9' },
  amber: { fill: 'rgba(245,165,36,0.20)', ring: '#f5a524', num: '#ffd07a', label: '#ffe2b0' },
  red:   { fill: 'rgba(244,86,78,0.14)',  ring: '#c04b44', num: '#ff9c96', label: '#f0b7b3' },
};

function draw(ctx, view, now) {
  const s = view.scale;
  ctx.save();
  ctx.translate(view.tx, view.ty);
  ctx.scale(s, s);

  // nền
  if (bgDim) {
    ctx.drawImage(bgDim, 0, 0, scene.width, scene.height);
  } else if (scene.active) {
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1 / s;
    const step = 100;
    for (let x = 0; x <= scene.width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, scene.height); ctx.stroke(); }
    for (let y = 0; y <= scene.height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(scene.width, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.strokeRect(0, 0, scene.width, scene.height);
  }

  for (const t of scene.tables) {
    const rpx = t.r * s;
    if (t.x * s + view.tx < -t.r * s - 40 || t.x * s + view.tx > view.w + t.r * s + 40) continue;
    const cls = classOf(t);
    const p = PALETTE[cls];

    // flash khi vừa thay đổi
    let flashAlpha = 0;
    if (t.flashUntil > now) {
      flashAlpha = 0.5 + 0.5 * Math.sin((now / 180) % (Math.PI * 2));
    }
    if (flashAlpha > 0) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r * 1.22, 0, Math.PI * 2);
      ctx.strokeStyle = cls === 'red' ? 'rgba(255,120,110,' + (0.55 * flashAlpha) + ')' : 'rgba(255,255,255,' + (0.5 * flashAlpha) + ')';
      ctx.lineWidth = 3.5 / s;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fillStyle = p.fill;
    ctx.fill();
    ctx.lineWidth = Math.min(3.5, 3 / s * 1) / s * (rpx < 40 ? 1.4 : 1);
    ctx.lineWidth = Math.max(2 / s, t.r * 0.045);
    ctx.strokeStyle = p.ring;
    ctx.stroke();

    // số ghế trống — giữa vòng bàn, hiện ở mọi mức zoom
    ctx.font = `800 ${t.r * 0.98}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = p.num;
    ctx.fillText(String(t.empty), t.x, t.y);

    // tên bàn — phía trên vòng bàn, hiện ở mọi mức zoom; tên dài thì thu chữ
    // lại vừa khung bàn để không đè sang tên của bàn kế bên
    const nameText = t.name || `Bàn ${t.label}`;
    const NAME_FONT = `-apple-system, 'Segoe UI', Roboto, sans-serif`;
    let nameFont = t.r * 0.63;
    ctx.font = `700 ${nameFont}px ${NAME_FONT}`;
    const maxNameW = t.r * 3.6;
    const nameW = ctx.measureText(nameText).width;
    if (nameW > maxNameW) {
      nameFont *= maxNameW / nameW;
      ctx.font = `700 ${nameFont}px ${NAME_FONT}`;
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(2,5,12,0.62)';
    ctx.lineWidth = nameFont * 0.18;
    ctx.strokeText(nameText, t.x, t.y - t.r * 1.45);
    ctx.fillStyle = p.label;
    ctx.fillText(nameText, t.x, t.y - t.r * 1.45);
  }
  ctx.restore();
}

// ---------- cập nhật ghế ----------
function openUpdateSheet(t) {
  selected = t;
  renderUpdateSheet();
  openSheet($('sheet-update'), $('sheet-update-backdrop'));
}
function closeUpdateSheet() {
  closeSheet($('sheet-update'), $('sheet-update-backdrop'));
  selected = null;
}
function renderUpdateSheet() {
  const t = selected; if (!t) return;
  $('upd-title').textContent = `Bàn ${t.label}`;
  $('upd-sub').textContent = (t.name ? t.name + ' · ' : '') + `${t.total} chỗ · còn trống:`;
  const numEl = $('upd-number');
  numEl.textContent = t.empty;
  numEl.className = 'upd-number ' + classOf(t);
  $('upd-minus').disabled = t.empty <= 0;
  $('upd-plus').disabled = t.empty >= t.total;
  // nút đặt nhanh
  const qs = $('quick-set');
  qs.innerHTML = '';
  const maxQuick = Math.min(t.total, 12);
  for (let v = 0; v <= maxQuick; v++) {
    const b = document.createElement('button');
    b.textContent = v;
    if (v === t.empty) b.classList.add('current');
    b.onclick = () => setEmpty(v);
    qs.appendChild(b);
  }
  $('upd-meta').textContent = t.updatedBy ? `Cập nhật cuối bởi ${t.updatedBy} · ${timeAgo(t.updatedAt)}` : '';
}

async function bumpSelected(delta) {
  const t = selected; if (!t) return;
  const target = clamp(t.empty + delta, 0, t.total);
  await sendUpdate(t, { delta });
  t.empty = target;
  t.flashUntil = Date.now() + 1500;
  renderUpdateSheet();
  engine.requestRender();
}

async function setEmpty(v) {
  const t = selected; if (!t) return;
  await sendUpdate(t, { empty: v });
  t.empty = v;
  t.flashUntil = Date.now() + 1500;
  renderUpdateSheet();
  engine.requestRender();
}

async function sendUpdate(t, body) {
  try {
    const res = await api(`/api/tables/${t.id}/seats`, {
      method: 'POST',
      body: { ...body, by: nick || null },
    });
    scene.version = res.version - 1; // ép poll lần tới lấy state mới
    updateSummary();
  } catch (e) {
    toast(e.message || 'Cập nhật thất bại', 'err');
    schedulePoll(100);
  }
}

// ---------- tổng quan ----------
function updateSummary() {
  const tables = scene.tables;
  if (!scene.active || !tables.length) { lastSummaryText = ''; return; }
  const empty = tables.reduce((a, t) => a + t.empty, 0);
  const total = tables.reduce((a, t) => a + t.total, 0);
  const open = tables.filter(t => t.empty > 0).length;
  const line = $('summary-line');
  line.textContent = '';
  if (scene.name) { line.append(scene.name + ' · '); }
  const b = document.createElement('b');
  b.textContent = `${empty}`;
  line.append(b, `/${total} ghế trống · ${open}/${tables.length} bàn còn chỗ`);
  lastSummaryText = line.textContent;
}

function uiSecondTick() {
  // trạng thái kết nối
  const stale = lastOk === 0 || Date.now() - lastOk > 9000;
  $('offline-banner').hidden = !(scene.active && stale);
  if (stale && lastOk) setLiveDot('stale');
}

function setLiveDot(mode) {
  const d = $('live-dot');
  d.classList.toggle('off', mode === 'off');
  d.classList.toggle('stale', mode === 'stale');
}

// ---------- danh sách bàn ----------
function buildList(filter = 'all') {
  const list = $('table-list');
  list.innerHTML = '';
  const tables = [...scene.tables].sort((a, b) => compareLabels(a.label, b.label));
  for (const t of tables) {
    if (filter === 'open' && t.empty <= 0) continue;
    if (filter === 'full' && t.empty > 0) continue;
    const row = document.createElement('div');
    row.className = 'table-row';
    const cls = classOf(t);
    const sub = (t.name ? esc(t.name) + ' · ' : '') + `${t.empty}/${t.total} trống`;
    row.innerHTML = `
      <span class="dot ${cls === 'green' ? 'g' : cls === 'amber' ? 'a' : 'r'}"></span>
      <span class="t-label">Bàn ${esc(String(t.label))}</span>
      <span class="t-sub">${sub}</span>
      <span class="t-empty" style="color:var(--${cls === 'green' ? 'green' : cls === 'amber' ? 'amber' : 'red'})">${t.empty}</span>`;
    row.onclick = () => {
      closeSheet($('sheet-list'), $('sheet-list-backdrop'));
      zoomToTable(t);
      setTimeout(() => openUpdateSheet(t), 350); // nhảy tới bàn rồi mở bảng cập nhật
    };
    list.appendChild(row);
  }
}

function zoomToTable(t) {
  t.flashUntil = Date.now() + FLASH_MS;
  const targetScale = clamp(Math.min(engine.w, engine.h) / (t.r * 2 * 3.2), 0.2, 4);
  engine.centerOn(t.x, t.y, targetScale);
  engine.requestRender();
}

function fitView() {
  if (bgDim || scene.bgUrl) {
    engine.fit({ minX: 0, minY: 0, maxX: scene.width, maxY: scene.height });
  } else if (scene.tables.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of scene.tables) {
      minX = Math.min(minX, t.x - t.r); minY = Math.min(minY, t.y - t.r);
      maxX = Math.max(maxX, t.x + t.r); maxY = Math.max(maxY, t.y + t.r);
    }
    engine.fit({ minX, minY, maxX, maxY });
  } else {
    engine.fit({ minX: 0, minY: 0, maxX: scene.width, maxY: scene.height });
  }
}

function showEmptyState(show) {
  $('empty-state').hidden = !show;
  if (show) $('summary-line').textContent = 'Chưa có sơ đồ';
}

// ---------- menu ----------
function openMenu() {
  openSheet($('sheet-menu'), $('sheet-menu-backdrop'));
}

async function acquireWake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => { wakeLock = null; setWakeSwitch(); });
    setWakeSwitch();
  } catch { /* không hỗ trợ */ }
}
function setWakeSwitch() {
  $('wake-sw').classList.toggle('on', !!wakeLock || (wakeOn && !navigator.wakeLock));
}
async function toggleWake() {
  wakeOn = !wakeOn;
  localStorage.setItem('wake', wakeOn ? '1' : '0');
  if (wakeOn) await acquireWake();
  else { await wakeLock?.release(); wakeLock = null; setWakeSwitch(); }
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function installApp() {
  const ev = window.__installPrompt;
  if (ev) { ev.prompt(); ev.userChoice.then(() => { window.__installPrompt = null; }); }
  else if (isIOS()) { $('ios-install').hidden = false; }
  else toast('Mở trang này trong Chrome/Safari rồi chọn "Cài đặt ứng dụng"');
}
