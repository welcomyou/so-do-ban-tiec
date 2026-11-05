// Admin — đăng nhập, quản lý sơ đồ, editor kéo thả, import PDF tự nhận diện bàn
import { api, toast, compareLabels } from './api.js';
import { PanZoomCanvas } from './canvas-view.js';
import { openSheet, closeSheet, confirmDialog, promptDialog } from './ui.js';
import { detectCircles } from './detect.js';
import { openPdf, renderPage, canvasToBgDataUrl } from './pdf-import.js';

const $ = (id) => document.getElementById(id);
const uid = () => 't' + crypto.randomUUID().slice(0, 8);

let user = null;
let layouts = [];
let engine = null;
let bgImgEl = null;
let selectedId = null;
let mode = 'edit';
let undoStack = [];
let dirty = false;
let autoSaveTimer = null;
let editingId = null;
let dragRef = null; // trạng thái kéo bàn hiện tại: { ox, oy, pushed }

// L = layout đang sửa
let L = null;

const DEFAULT_TOTAL = 10;

export async function initAdmin() {
  const root = $('view-admin');
  root.innerHTML = `
    <div id="ad-login" class="screen" hidden><div class="login-wrap"><div class="login-card" id="login-card"></div></div></div>
    <div id="ad-list" class="screen" hidden>
      <div class="admin-top"><div class="title">Sơ đồ tiệc</div><button class="btn sm ghost" id="btn-logout">Đăng xuất</button></div>
      <div class="page-pad" id="layout-list"></div>
    </div>
    <div id="ad-edit" class="screen" hidden>
      <div class="admin-top">
        <button class="icon-btn" id="ed-back" title="Danh sách">←</button>
        <input class="name-input" id="ed-name" maxlength="80" placeholder="Tên sơ đồ">
        <span class="dirty-dot" id="ed-dirty" hidden></span>
        <button class="btn sm" id="ed-save">Lưu</button>
        <button class="btn sm primary" id="ed-deploy">Xuất bản</button>
      </div>
      <div class="toolbar">
        <div class="seg" id="ed-mode">
          <button data-m="edit" class="active">✏️ Sửa</button>
          <button data-m="preview">👀 Xem thử</button>
        </div>
        <button class="btn sm" id="ed-add">＋ Bàn</button>
        <button class="btn sm" id="ed-number">1,2,3…</button>
        <button class="btn sm" id="ed-seats">Số ghế</button>
        <button class="btn sm" id="ed-import">📥 PDF</button>
        <button class="btn sm" id="ed-undo">↩︎</button>
      </div>
      <div class="admin-body">
        <div class="canvas-wrap" id="ed-wrap" style="flex:1;background:#070b14;position:relative;overflow:hidden">
          <canvas id="ed-cv" style="position:absolute;inset:0;width:100%;height:100%;touch-action:none;display:block"></canvas>
          <div class="editor-hint" id="ed-hint">Kéo bàn để di chuyển · chạm bàn để sửa · 2 ngón để thu phóng</div>
        </div>
      </div>
      <div class="sheet-backdrop" id="ed-props-bd" hidden></div>
      <div class="sheet" id="ed-props" hidden>
        <div class="sheet-grab"></div>
        <div class="sheet-head"><div><div class="sheet-title" id="pr-title">Bàn</div></div>
          <button class="icon-btn" id="pr-close">✕</button></div>
        <div class="field"><label>Số bàn</label><input id="pr-label" maxlength="4" inputmode="numeric" placeholder="1"></div>
        <div class="field"><label>Tên bàn (người đãi / nhóm khách)</label><input id="pr-name" maxlength="30" placeholder="VD: Bạn Quân · Nhà trai…"></div>
        <div class="slider-row"><label>Số ghế mỗi bàn</label>
          <button class="btn sm" id="pr-total-minus">−</button>
          <output id="pr-total">10</output>
          <button class="btn sm" id="pr-total-plus">＋</button></div>
        <div class="slider-row"><label>Cỡ bàn</label>
          <button class="btn sm" id="pr-size-minus">Nhỏ hơn</button>
          <button class="btn sm" id="pr-size-plus">To hơn</button></div>
        <button class="btn danger" id="pr-delete" style="width:100%;margin-top:8px">🗑 Xoá bàn này</button>
      </div>
    </div>`;
  bindAdmin();
  try {
    const me = await api('/api/me');
    user = me.user;
  } catch { user = null; }
}

export function adminRoute() {
  const m = /^#\/admin\/edit\/(\d+)$/.exec(location.hash);
  if (m && user) showEdit(Number(m[1]));
  else if (user) showList();
  else showLogin();
}

// ================= LOGIN =================
async function showLogin() {
  $('ad-login').hidden = false; $('ad-list').hidden = true; $('ad-edit').hidden = true;
  const card = $('login-card');
  const status = await api('/api/auth-status').catch(() => ({ hasUsers: true }));
  if (!status.hasUsers) {
    card.innerHTML = `
      <h1>Khởi tạo quản trị viên</h1>
      <p class="sub">Lần đầu dùng — hãy tạo tài khoản admin để quản lý sơ đồ.</p>
      <div class="field"><label>Tên đăng nhập</label><input id="lg-user" autocomplete="username"></div>
      <div class="field"><label>Mật khẩu (≥ 6 ký tự)</label><input id="lg-pass" type="password" autocomplete="new-password"></div>
      <button class="btn primary" id="lg-btn" style="width:100%">Tạo tài khoản</button>`;
    $('lg-btn').onclick = async () => {
      try {
        await api('/api/setup', { method: 'POST', body: { username: $('lg-user').value, password: $('lg-pass').value } });
        toast('Đã tạo tài khoản', 'ok');
        user = { username: $('lg-user').value };
        adminRoute();
      } catch (e) { toast(e.message, 'err'); }
    };
  } else {
    card.innerHTML = `
      <h1>Đăng nhập quản trị</h1>
      <p class="sub">Chỉ dùng cho người tạo &amp; xuất bản sơ đồ. Khách và MC không cần đăng nhập.</p>
      <div class="field"><label>Tên đăng nhập</label><input id="lg-user" autocomplete="username"></div>
      <div class="field"><label>Mật khẩu</label><input id="lg-pass" type="password" autocomplete="current-password"></div>
      <button class="btn primary" id="lg-btn" style="width:100%">Đăng nhập</button>`;
    $('lg-btn').onclick = async () => {
      try {
        await api('/api/login', { method: 'POST', body: { username: $('lg-user').value, password: $('lg-pass').value } });
        user = { username: $('lg-user').value };
        adminRoute();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
  $('lg-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lg-btn').click(); });
}

// ================= LIST =================
async function showList() {
  $('ad-login').hidden = true; $('ad-list').hidden = false; $('ad-edit').hidden = true;
  try {
    const res = await api('/api/layouts');
    layouts = res.layouts;
  } catch (e) {
    if (e.status === 401) { user = null; showLogin(); return; }
    toast(e.message, 'err'); layouts = [];
  }
  const box = $('layout-list');
  box.innerHTML = '';
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap';
  top.innerHTML = `
    <button class="btn primary" id="ls-new">＋ Tạo sơ đồ trống</button>
    <button class="btn" id="ls-import">📥 Tạo từ file PDF</button>`;
  box.appendChild(top);
  $('ls-new').onclick = () => { newLayout(); };
  $('ls-import').onclick = () => { newLayout(); openImport(); };

  if (!layouts.length) {
    const p = document.createElement('p');
    p.style.color = 'var(--text-dim)';
    p.textContent = 'Chưa có sơ đồ nào. Tạo mới hoặc nhập từ file PDF layout của nhà hàng.';
    box.appendChild(p);
  }
  for (const ly of layouts) {
    const card = document.createElement('div');
    card.className = 'layout-card';
    card.style.marginBottom = '10px';
    card.innerHTML = `
      <div style="flex:1">
        <div class="l-name">${ly.name}</div>
        <div class="l-sub">${ly.tableCount} bàn · cập nhật ${new Date(ly.updatedAt).toLocaleString('vi-VN')}</div>
      </div>
      <span class="badge ${ly.deployed ? 'live' : 'draft'}">${ly.deployed ? '● ĐANG CHẠY' : 'Bản nháp'}</span>
      <button class="btn sm edit">Sửa</button>
      <button class="btn sm ${ly.deployed ? 'ghost' : 'green'} dep">${ly.deployed ? 'Gỡ xuống' : 'Xuất bản'}</button>
      <button class="btn sm danger del">Xoá</button>`;
    card.querySelector('.edit').onclick = () => { location.hash = `#/admin/edit/${ly.id}`; };
    card.querySelector('.dep').onclick = async () => {
      if (ly.deployed) {
        if (await confirmDialog({ title: 'Gỡ sơ đồ xuống?', message: 'Sơ đồ sẽ không còn hiển thị với mọi người.', okText: 'Gỡ xuống', danger: true })) {
          await api(`/api/layouts/${ly.id}/unpublish`, { method: 'POST' });
          toast('Đã gỡ xuống', 'ok'); showList();
        }
      } else {
        if (await confirmDialog({
          title: 'Xuất bản sơ đồ?',
          message: 'Mọi người mở ứng dụng sẽ thấy ngay sơ đồ này. Toàn bộ bàn sẽ được đặt về trạng thái “còn đủ ghế trống”.',
          okText: 'Xuất bản',
        })) {
          await api(`/api/layouts/${ly.id}/deploy`, { method: 'POST' });
          toast('✔ Đã xuất bản — khách & MC đã thấy sơ đồ', 'ok'); showList();
        }
      }
    };
    card.querySelector('.del').onclick = async () => {
      if (await confirmDialog({ title: `Xoá “${ly.name}”?`, message: 'Không thể hoàn tác.', okText: 'Xoá', danger: true })) {
        await api(`/api/layouts/${ly.id}`, { method: 'DELETE' });
        toast('Đã xoá', 'ok'); showList();
      }
    };
    box.appendChild(card);
  }
}

// ================= EDITOR =================
function newLayout() {
  L = { id: null, name: 'Sơ đồ mới', width: 1000, height: 700, tables: [], hasBg: false, bgDataUrl: null };
  bgImgEl = null; bgUrlLoaded = null;
  editingId = null;
  undoStack = []; dirty = false; selectedId = null; mode = 'edit';
  showEditUI();
}

async function showEdit(id) {
  if (!L || L.id !== id) {
    try {
      // cần endpoint chi tiết — dùng list rồi lọc (tránh thêm API)
      const res = await api('/api/layouts');
      const meta = res.layouts.find(x => x.id === id);
      if (!meta) { toast('Không tìm thấy sơ đồ', 'err'); location.hash = '#/admin'; return; }
      // tables_json đầy đủ nằm trong list? — có: xem fetchTables dưới
      const full = await api(`/api/layouts/${id}`);
      L = { id, name: full.name, width: full.width, height: full.height, tables: full.tables, hasBg: full.hasBg, bgDataUrl: null };
      if (full.hasBg) {
        bgImgEl = await loadImage(`/api/bg/${id}?v=${full.updatedAt}`);
      } else bgImgEl = null;
      bgUrlLoaded = full.hasBg ? `bg:${id}:${full.updatedAt}` : null;
      L._bgFromServer = full.hasBg;
      editingId = id;
      undoStack = []; dirty = false; selectedId = null; mode = 'edit';
    } catch (e) {
      if (e.status === 401) { user = null; showLogin(); return; }
      toast(e.message || 'Lỗi tải sơ đồ', 'err'); location.hash = '#/admin'; return;
    }
  }
  showEditUI();
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

function showEditUI() {
  $('ad-login').hidden = true; $('ad-list').hidden = true; $('ad-edit').hidden = false;
  $('ed-name').value = L.name;
  $('ed-dirty').hidden = !dirty;
  $('ed-hint').textContent = mode === 'edit'
    ? 'Kéo bàn để di chuyển · chạm bàn để sửa · 2 ngón để thu phóng'
    : 'Chế độ xem thử — như khách sẽ thấy (đầy đủ chỗ)';
  if (!engine) {
    engine = new PanZoomCanvas($('ed-cv'), {
      draw: drawEditor,
      hitTest,
      onTap: (obj) => {
        if (mode === 'edit') { if (obj) { selectedId = obj.id; openProps(obj); } else closeProps(); }
        else toast('Đang ở chế độ xem thử — chuyển sang “Sửa” để chỉnh', '');
      },
      onDoubleTap: (obj) => { if (!obj) fitEditor(); },
      allowObjectDrag: true,
      onDragObject: (obj, wx, wy, phase) => {
        if (mode !== 'edit') return;
        if (phase === 'start') dragRef = { ox: obj.x, oy: obj.y, pushed: false };
        else if (dragRef && !dragRef.pushed &&
                 (Math.round(wx) !== dragRef.ox || Math.round(wy) !== dragRef.oy)) {
          pushUndo(); dragRef.pushed = true; // chỉ hoàn tác khi bàn thật sự rời chỗ
        }
        obj.x = Math.round(wx); obj.y = Math.round(wy);
        if (phase === 'end') { if (dragRef?.pushed) markDirty(); dragRef = null; }
      },
    });
    $('ed-props-bd').onclick = () => closeProps();
    $('pr-close').onclick = () => closeProps();
    $('pr-label').addEventListener('change', () => {
      const t = L.tables.find(x => x.id === selectedId); if (!t) return;
      pushUndo();
      t.label = $('pr-label').value.trim() || t.label;
      markDirty(); engine.requestRender();
    });
    $('pr-name').addEventListener('change', () => {
      const t = L.tables.find(x => x.id === selectedId); if (!t) return;
      pushUndo();
      t.name = $('pr-name').value.trim();
      markDirty(); engine.requestRender();
    });
    $('pr-total-minus').onclick = () => adjustSelected('total', -1);
    $('pr-total-plus').onclick = () => adjustSelected('total', +1);
    $('pr-size-minus').onclick = () => adjustSelected('r', -0.12);
    $('pr-size-plus').onclick = () => adjustSelected('r', +0.12);
    $('pr-delete').onclick = async () => {
      const t = L.tables.find(x => x.id === selectedId); if (!t) return;
      pushUndo();
      L.tables = L.tables.filter(x => x.id !== t.id);
      closeProps(); markDirty(); engine.requestRender();
      toast(`Đã xoá bàn ${t.label}`);
    };
  }
  engine.opts.allowObjectDrag = mode === 'edit';
  setTimeout(() => fitEditor(), 30);
  $('ed-mode').querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.m === mode);
  });
}

function bindAdmin() {
  $('btn-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); user = null; location.hash = '#/admin'; showLogin(); };
  $('ed-back').onclick = () => { flushSave(); location.hash = '#/admin'; };
  $('ed-name').addEventListener('change', () => { L.name = $('ed-name').value.trim() || 'Sơ đồ'; markDirty(); });
  $('ed-save').onclick = () => saveLayout(true);
  $('ed-deploy').onclick = deployCurrent;
  $('ed-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    mode = b.dataset.m;
    $('ed-mode').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    $('ed-hint').textContent = mode === 'edit'
      ? 'Kéo bàn để di chuyển · chạm bàn để sửa · 2 ngón để thu phóng'
      : 'Chế độ xem thử — như khách sẽ thấy (đầy đủ chỗ)';
    engine.opts.allowObjectDrag = mode === 'edit';
    closeProps();
    engine.requestRender();
  });
  $('ed-add').onclick = () => {
    if (mode !== 'edit') return;
    pushUndo();
    const c = engine.screenToWorld(engine.w / 2, engine.h / 2);
    const rs = L.tables.map(t => t.r).sort((a, b) => a - b);
    const r = rs.length ? rs[Math.floor(rs.length / 2)] : 40;
    const nextLabel = String(nextNumber());
    L.tables.push({ id: uid(), label: nextLabel, total: DEFAULT_TOTAL, x: Math.round(c.x), y: Math.round(c.y), r });
    selectedId = L.tables[L.tables.length - 1].id;
    markDirty(); engine.requestRender();
    openProps(L.tables[L.tables.length - 1]);
  };
  $('ed-number').onclick = autoNumber;
  $('ed-seats').onclick = setAllSeats;
  $('ed-undo').onclick = () => {
    const snap = undoStack.pop();
    if (!snap) { toast('Không còn gì để hoàn tác'); return; }
    L.tables = snap;
    markDirty(); engine.requestRender();
  };
  $('ed-import').onclick = () => openImport();
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}

function nextNumber() {
  let max = 0;
  for (const t of L.tables) {
    const n = parseInt(t.label, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function adjustSelected(field, d) {
  const t = L.tables.find(x => x.id === selectedId); if (!t) return;
  pushUndo();
  if (field === 'total') t.total = Math.max(0, Math.min(30, t.total + d));
  if (field === 'r') t.r = Math.max(8, Math.round(t.r * (1 + d) * 10) / 10);
  markDirty();
  if (field === 'total') $('pr-total').textContent = t.total;
  engine.requestRender();
}

function openProps(t) {
  $('pr-title').textContent = `Bàn ${t.label}`;
  $('pr-label').value = t.label;
  $('pr-name').value = t.name || '';
  $('pr-total').textContent = t.total;
  openSheet($('ed-props'), $('ed-props-bd'));
  engine.requestRender();
}
function closeProps() {
  closeSheet($('ed-props'), $('ed-props-bd'));
  selectedId = null;
  engine?.requestRender();
}

function pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify(L.tables)));
  if (undoStack.length > 30) undoStack.shift();
}
function markDirty() {
  dirty = true;
  $('ed-dirty').hidden = false;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveLayout(false), 2000);
}

async function saveLayout(verbose = true) {
  if (!L) return;
  const body = {
    name: L.name,
    width: L.width,
    height: L.height,
    tables: L.tables,
  };
  if (L.bgDataUrl !== null) body.background = L.bgDataUrl;
  try {
    if (L.id) {
      await api(`/api/layouts/${L.id}`, { method: 'PUT', body });
    } else {
      const res = await api('/api/layouts', { method: 'POST', body });
      L.id = res.id;
      editingId = res.id;
      history.replaceState(null, '', `#/admin/edit/${L.id}`);
      L._bgFromServer = !!L.bgDataUrl;
    }
    if (L.bgDataUrl !== null) { L._bgFromServer = true; bgUrlLoaded = 'local:' + L.bgDataUrl.length; }
    L.bgDataUrl = null;
    dirty = false;
    $('ed-dirty').hidden = true;
    if (verbose) toast('Đã lưu ✓', 'ok');
  } catch (e) {
    if (e.status === 401) { user = null; showLogin(); return; }
    toast(e.message || 'Lưu thất bại', 'err');
  }
}
function flushSave() { if (dirty) { clearTimeout(autoSaveTimer); saveLayout(false); } }

async function deployCurrent() {
  if (!L.tables.length) { toast('Thêm ít nhất 1 bàn trước khi xuất bản', 'err'); return; }
  flushSave();
  if (!L.id) { toast('Lưu trước khi xuất bản', 'err'); return; }
  const ok = await confirmDialog({
    title: 'Xuất bản sơ đồ này?',
    message: `“${L.name}” — ${L.tables.length} bàn. Mọi người sẽ thấy ngay; toàn bộ bàn đặt về “còn đủ ghế trống”.`,
    okText: 'Xuất bản ngay',
  });
  if (!ok) return;
  try {
    await api(`/api/layouts/${L.id}/deploy`, { method: 'POST' });
    toast('✔ Đã xuất bản — khách & MC đã thấy sơ đồ', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// Đánh số lại tự động: theo hàng (trái→phải, trên→dưới)
function autoNumber() {
  if (!L.tables.length) return;
  pushUndo();
  const rs = L.tables.map(t => t.r).sort((a, b) => a - b);
  const medR = rs[Math.floor(rs.length / 2)];
  const rows = [];
  const sorted = [...L.tables].sort((a, b) => a.y - b.y);
  for (const t of sorted) {
    const row = rows.find(rw => Math.abs(rw.y - t.y) < medR * 0.9);
    if (row) row.items.push(t);
    else rows.push({ y: t.y, items: [t] });
  }
  let n = 1;
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    for (const t of row.items) t.label = String(n++);
  }
  markDirty(); engine.requestRender();
  toast(`Đã đánh số lại ${L.tables.length} bàn`, 'ok');
}

async function setAllSeats() {
  const v = await promptDialog({ title: 'Số ghế mỗi bàn (áp cho tất cả)', value: String(DEFAULT_TOTAL), type: 'number' });
  if (v === null) return;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 30) { toast('Nhập số từ 0 đến 30', 'err'); return; }
  pushUndo();
  for (const t of L.tables) t.total = n;
  markDirty(); engine.requestRender();
  toast(`Đã đặt ${n} ghế cho mọi bàn`, 'ok');
}

function hitTest(wx, wy) {
  let best = null, bestD = Infinity;
  for (const t of L?.tables || []) {
    const d = Math.hypot(wx - t.x, wy - t.y);
    if (d <= t.r * 1.15 && d < bestD) { best = t; bestD = d; }
  }
  return best;
}

function medianR() {
  const rs = (L?.tables || []).map(t => t.r).sort((a, b) => a - b);
  return rs.length ? rs[Math.floor(rs.length / 2)] : 40;
}

function fitEditor() {
  if (bgImgEl) {
    engine.fit({ minX: 0, minY: 0, maxX: L.width, maxY: L.height });
  } else if (L.tables.length) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of L.tables) {
      minX = Math.min(minX, t.x - t.r); minY = Math.min(minY, t.y - t.r);
      maxX = Math.max(maxX, t.x + t.r); maxY = Math.max(maxY, t.y + t.r);
    }
    engine.fit({ minX, minY, maxX, maxY });
  } else {
    engine.fit({ minX: 0, minY: 0, maxX: L.width, maxY: L.height });
  }
}

// ---------- vẽ editor ----------
let bgUrlLoaded = null;

function drawEditor(ctx, view) {
  if (!L) return;
  const s = view.scale;
  ctx.save();
  ctx.translate(view.tx, view.ty);
  ctx.scale(s, s);

  if (bgImgEl) {
    ctx.globalAlpha = mode === 'edit' ? 0.85 : 0.55;
    ctx.drawImage(bgImgEl, 0, 0, L.width, L.height);
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1 / s;
    for (let x = 0; x <= L.width; x += 100) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, L.height); ctx.stroke(); }
    for (let y = 0; y <= L.height; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(L.width, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.strokeRect(0, 0, L.width, L.height);
  }

  const preview = mode === 'preview';
  for (const t of L.tables) {
    const rpx = t.r * s;
    const selected = t.id === selectedId && !preview;
    // màu như viewer khi preview (đầy chỗ = xanh), editor = xanh dương trung tính
    let fill = 'rgba(79,140,255,0.16)', ring = '#4f8cff', num = '#cfe0ff';
    if (preview) { fill = 'rgba(34,197,94,0.20)'; ring = '#2fdd6f'; num = '#6ef2a5'; }
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = Math.max(2 / s, t.r * 0.04);
    ctx.strokeStyle = ring;
    ctx.stroke();
    if (selected) {
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r * 1.16, 0, Math.PI * 2);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5 / s;
      ctx.setLineDash([6 / s, 5 / s]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // bàn quá nhỏ chỉ bỏ bớt chi tiết khi đang sửa; chế độ xem thử vẽ y như
    // viewer — tên và số ghế hiện ở mọi mức zoom
    if (rpx < 15 && !preview) continue;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const FONT = "-apple-system, 'Segoe UI', Roboto, sans-serif";
    if (preview) {
      // xem thử = đúng những gì khách/MC thấy: tên bàn phía trên vòng
      // (mọi mức zoom) + số ghế trống to ở chính giữa
      const nameText = t.name || `Bàn ${t.label}`;
      let nameFont = t.r * 0.63;
      ctx.font = `700 ${nameFont}px ${FONT}`;
      const maxNameW = t.r * 3.6;
      const nameW = ctx.measureText(nameText).width;
      if (nameW > maxNameW) {
        nameFont *= maxNameW / nameW;
        ctx.font = `700 ${nameFont}px ${FONT}`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(2,5,12,0.62)';
      ctx.lineWidth = nameFont * 0.18;
      ctx.strokeText(nameText, t.x, t.y - t.r * 1.45);
      ctx.fillStyle = 'rgba(169,245,201,0.9)';
      ctx.fillText(nameText, t.x, t.y - t.r * 1.45);
      ctx.font = `800 ${t.r * 0.98}px ${FONT}`;
      ctx.fillStyle = num;
      ctx.fillText(String(t.total), t.x, t.y);
    } else if (t.total < 8) {
      // bàn ít ghế (< 8): số chỗ ngồi là con số chính giữa vòng tròn để nhìn
      // là biết bàn này còn bao nhiêu chỗ để dắt khách tới
      if (rpx >= 30) {
        ctx.font = `700 ${t.r * (rpx >= 44 ? 0.26 : 0.38)}px ${FONT}`;
        ctx.fillStyle = 'rgba(207,224,255,0.65)';
        ctx.fillText(rpx >= 44 ? `Bàn ${t.label}` : t.label, t.x, t.y - t.r * (rpx >= 44 ? 0.48 : 0.6));
      }
      ctx.font = `800 ${t.r * (rpx >= 44 ? 0.62 : 0.8)}px ${FONT}`;
      ctx.fillStyle = num;
      ctx.fillText(String(t.total), t.x, t.y + (rpx >= 44 ? t.r * 0.08 : 0));
      if (rpx >= 44) {
        ctx.font = `600 ${t.r * 0.2}px ${FONT}`;
        ctx.fillStyle = 'rgba(207,224,255,0.5)';
        ctx.fillText(t.name || 'ghế', t.x, t.y + t.r * 0.52);
      }
    } else {
      // bàn thường: số bàn ở giữa; số ghế luôn hiện ngay dưới số bàn kể cả
      // khi zoom xa (trước đây chỉ hiện khi vòng tròn vẽ đủ lớn)
      ctx.fillStyle = num;
      if (rpx >= 44) {
        ctx.font = `800 ${t.r * 0.6}px ${FONT}`;
        ctx.fillText(t.label, t.x, t.y + t.r * 0.05);
        ctx.font = `600 ${t.r * 0.26}px ${FONT}`;
        ctx.fillStyle = 'rgba(207,224,255,0.6)';
        ctx.fillText(t.name || `${t.total} ghế`, t.x, t.y + t.r * 0.52);
      } else {
        ctx.font = `800 ${t.r * 0.72}px ${FONT}`;
        ctx.fillText(t.label, t.x, t.y - t.r * 0.3);
        ctx.font = `700 ${t.r * 0.42}px ${FONT}`;
        ctx.fillStyle = 'rgba(207,224,255,0.75)';
        ctx.fillText(String(t.total), t.x, t.y + t.r * 0.45);
      }
    }
  }
  ctx.restore();
}

// ================= IMPORT PDF =================
let impState = null;

async function openImport() {
  if (mode !== 'edit') return;
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.innerHTML = `
    <div class="modal">
      <h3>📥 Nhập sơ đồ từ PDF</h3>
      <p class="hint">Chọn file PDF layout nhà hàng — app tự nhận diện các bàn tròn. Sau đó chỉnh số bàn/số ghế rồi lưu.</p>
      <div class="dropzone" id="im-drop">👆 Bấm để chọn file PDF (hoặc kéo thả vào đây)</div>
      <input type="file" id="im-file" accept="application/pdf" hidden>
      <div id="im-work" hidden>
        <div class="slider-row">
          <button class="btn sm" id="im-prev-page">‹</button>
          <output id="im-page" style="min-width:70px;text-align:center">1/1</output>
          <button class="btn sm" id="im-next-page">›</button>
          <span style="flex:1"></span>
          <output id="im-count"></output>
        </div>
        <canvas id="im-canvas"></canvas>
        <div class="slider-row"><label>Độ nhạy quét</label><input type="range" id="im-sens" min="1" max="10" value="6"><output id="im-sens-v">6</output></div>
        <div class="slider-row"><label>Bàn nhỏ nhất</label><input type="range" id="im-rmin" min="1" max="12" value="3"><output id="im-rmin-v">3%</output></div>
        <div class="slider-row"><label>Bàn lớn nhất</label><input type="range" id="im-rmax" min="4" max="30" value="9"><output id="im-rmax-v">9%</output></div>
        <div class="slider-row"><label>Số ghế mỗi bàn</label><input type="range" id="im-seats" min="6" max="16" value="10"><output id="im-seats-v">10</output></div>
        <div class="slider-row"><label>Trạng thái</label><output id="im-status">—</output></div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn ghost" id="im-cancel" style="flex:1">Huỷ</button>
          <button class="btn primary" id="im-apply" style="flex:2">Dùng kết quả</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(bd);
  requestAnimationFrame(() => bd.querySelector('.modal').classList.add('show'));
  const $i = (id) => bd.querySelector('#' + id);
  let scanTimer = null;

  $i('im-drop').onclick = () => $i('im-file').click();
  $i('im-drop').ondragover = (e) => { e.preventDefault(); };
  $i('im-drop').ondrop = (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
  $i('im-file').onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => runScan(), 350);
  }
  for (const [id, key] of [['im-sens', 'sens'], ['im-rmin', 'rmin'], ['im-rmax', 'rmax'], ['im-seats', 'seats']]) {
    $i(id).addEventListener('input', () => {
      impState[key] = Number($i(id).value);
      updateLabels();
      if (key !== 'seats') scheduleScan();
      else drawOverlay();
    });
  }
  function updateLabels() {
    $i('im-sens-v').value = impState.sens;
    $i('im-rmin-v').value = impState.rmin + '%';
    $i('im-rmax-v').value = impState.rmax + '%';
    $i('im-seats-v').value = impState.seats;
  }

  async function handleFile(file) {
    if (!/pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Chọn file PDF', 'err'); return; }
    $i('im-status').value = 'Đang mở PDF…';
    $i('im-drop').classList.add('has-file');
    $i('im-drop').textContent = `📄 ${file.name}`;
    try {
      const pdf = await openPdf(file);
      impState = { pdf, numPages: pdf.numPages, pageNo: 1, sens: 6, rmin: 3, rmax: 9, seats: 10, render: null, circles: [] };
      $i('im-work').hidden = false;
      await renderCurrent();
    } catch (e) {
      toast('Không đọc được PDF: ' + (e.message || e), 'err');
      $i('im-status').value = 'Lỗi đọc PDF';
    }
  }

  async function renderCurrent() {
    $i('im-status').value = 'Đang dựng trang…';
    const canvas = await renderPage(impState.pdf, impState.pageNo, 1500);
    impState.render = canvas;
    const view = $i('im-canvas');
    view.width = canvas.width; view.height = canvas.height;
    $i('im-page').value = `${impState.pageNo}/${impState.numPages}`;
    await runScan();
  }

  async function runScan() {
    if (!impState?.render) return;
    const canvas = impState.render;
    $i('im-status').value = 'Đang quét…';
    await new Promise(r => setTimeout(r, 20));
    const t0 = performance.now();
    // Giới hạn theo DIỆN TÍCH (≈3.2MP): với PDF khổ dọc (ví dụ 1500×3000) vẫn giữ
    // đủ phân giải để bàn có r≈50px — thu nhỏ theo cạnh dài sẽ làm sai số lớn.
    const s = Math.min(1, Math.sqrt(3_200_000 / (canvas.width * canvas.height)));
    let img;
    if (s < 1) {
      const small = document.createElement('canvas');
      small.width = Math.round(canvas.width * s);
      small.height = Math.round(canvas.height * s);
      const sc = small.getContext('2d', { willReadFrequently: true });
      sc.fillStyle = '#fff';
      sc.fillRect(0, 0, small.width, small.height);
      sc.drawImage(canvas, 0, 0, small.width, small.height);
      img = sc.getImageData(0, 0, small.width, small.height);
    } else {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    const minDim = Math.min(img.width, img.height);
    let circles = detectCircles(img, {
      rMin: minDim * impState.rmin / 100,
      rMax: minDim * impState.rmax / 100,
      sensitivity: impState.sens,
    });
    if (s < 1) circles = circles.map(c => ({ x: c.x / s, y: c.y / s, r: c.r / s, score: c.score }));
    // Bàn tiệc thường ĐỒNG CỠ — chỉ giữ cụm bán kính chủ đạo (quanh median),
    // loại nhiễu lệch cỡ (ghế, viền khu vực, chữ tròn…)
    if (circles.length > 4) {
      const rs = circles.map(c => c.r).sort((a, b) => a - b);
      const med = rs[Math.floor(rs.length / 2)];
      circles = circles.filter(c => Math.abs(c.r - med) / med < 0.22);
    }
    // Bàn thật có độ phủ viền gần như hoàn hảo và đồng nhất — loại vòng có
    // điểm thấp hẳn so với mặt bằng chung (vòng trang trí trên lối đi, v.v.)
    if (circles.length > 4) {
      const ss = circles.map(c => c.score).sort((a, b) => a - b);
      const medS = ss[Math.floor(ss.length / 2)];
      circles = circles.filter(c => c.score >= medS * 0.8);
    }
    // sắp theo hàng để đánh số hợp lý
    circles.sort((a, b) => (Math.abs(a.y - b.y) > a.r * 0.9) ? a.y - b.y : a.x - b.x);
    impState.circles = circles;
    $i('im-status').value = `Quét xong ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    $i('im-count').value = `${circles.length} bàn`;
    drawOverlay();
  }

  function drawOverlay() {
    if (!impState?.render) return;
    const canvas = impState.render;
    const view = $i('im-canvas');
    const ctx = view.getContext('2d');
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.drawImage(canvas, 0, 0);
    circlesOrder();
    ctx.lineWidth = Math.max(2, canvas.width / 400);
    ctx.font = `800 ${Math.max(14, canvas.width / 45)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    impState.circles.forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
      ctx.strokeStyle = '#22c55e';
      ctx.stroke();
      ctx.fillStyle = '#22c55e';
      ctx.fillText(String(i + 1), c.x, c.y);
    });
  }
  function circlesOrder() {
    impState.circles.sort((a, b) => (Math.abs(a.y - b.y) > Math.max(a.r, b.r) * 0.9) ? a.y - b.y : a.x - b.x);
  }

  $i('im-prev-page').onclick = async () => { if (impState.pageNo > 1) { impState.pageNo--; await renderCurrent(); } };
  $i('im-next-page').onclick = async () => { if (impState.pageNo < impState.numPages) { impState.pageNo++; await renderCurrent(); } };
  $i('im-cancel').onclick = () => { impState = null; bd.remove(); };
  bd.addEventListener('click', (e) => { if (e.target === bd) { impState = null; bd.remove(); } });
  $i('im-apply').onclick = () => {
    if (!impState?.render || !impState.circles.length) { toast('Chưa nhận diện được bàn nào — thử chỉnh độ nhạy / cỡ bàn', 'err'); return; }
    const canvas = impState.render;
    pushUndo();
    L.width = canvas.width;
    L.height = canvas.height;
    L.tables = impState.circles.map((c, i) => ({
      id: uid(), label: String(i + 1), total: impState.seats,
      x: c.x, y: c.y, r: c.r,
    }));
    const bgUrl = canvasToBgDataUrl(canvas);
    L.bgDataUrl = bgUrl;
    loadImage(bgUrl).then(img => {
      bgImgEl = img;
      engine.requestRender();
      fitEditor();
    });
    markDirty();
    impState = null;
    bd.remove();
    toast(`Đã nhập ${L.tables.length} bàn — kiểm tra & bấm Lưu`, 'ok');
  };
}
