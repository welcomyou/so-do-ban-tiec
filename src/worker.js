// Sơ đồ bàn tiệc — Cloudflare Worker API
// Auth: PBKDF2 password hashing + HMAC-signed session cookie.

const enc = new TextEncoder();
const MAX_BG_CHARS = 1_400_000; // ~1MB base64 (~750KB ảnh)

// ---------- helpers ----------

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replaceAll('-', '+').replaceAll('_', '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function pbkdf2(password, salt, iterations = 100_000) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt);
  return `pbkdf2$100000$${b64url(salt)}$${b64url(hash)}`;
}
async function verifyPassword(password, stored) {
  const [alg, iters, saltB64, hashB64] = stored.split('$');
  if (alg !== 'pbkdf2') return false;
  const salt = b64urlDecode(saltB64);
  const hash = await pbkdf2(password, salt, Number(iters));
  return timingSafeEq(hash, b64urlDecode(hashB64));
}

async function makeSessionToken(env, uid, username) {
  const payload = b64url(enc.encode(JSON.stringify({ uid, username, exp: Date.now() + 7 * 864e5 })));
  const key = await hmacKey(env.SESSION_SECRET || 'insecure-dev-secret');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}
async function readSession(request, env) {
  const cookie = request.headers.get('cookie') || '';
  const m = /(?:^|;\s*)s=([^;]+)/.exec(cookie);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  try {
    const key = await hmacKey(env.SESSION_SECRET || 'insecure-dev-secret');
    const ok = await crypto.subtle.verify('HMAC', key, b64urlDecode(sig), enc.encode(payload));
    if (!ok) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `s=${token}; Path=/; Max-Age=${7 * 86400}; HttpOnly; SameSite=Lax;${secure}`;
}
function clearCookie() {
  return 's=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax';
}

function parseBody(request) {
  return request.json().catch(() => { throw new Response('{"error":"JSON không hợp lệ"}', { status: 400, headers: { 'content-type': 'application/json' } }); });
}

// ---------- validation ----------

function sanitizeTables(raw) {
  if (!Array.isArray(raw) || raw.length > 600) return null;
  const seen = new Set();
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') return null;
    const id = String(t.id || '').slice(0, 40);
    const label = String(t.label ?? '').slice(0, 8).trim();
    const total = Math.max(0, Math.min(30, Number(t.total) || 0));
    const x = Number(t.x), y = Number(t.y), r = Number(t.r);
    if (!id || !label || !Number.isFinite(x) || !Number.isFinite(y) || !(r > 0) || seen.has(id)) return null;
    seen.add(id);
    out.push({ id, label, total: Math.round(total), x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, r: Math.round(r * 10) / 10 });
  }
  return out;
}

function parseBg(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(dataUrl);
  if (!m) throw { status: 400, message: 'Ảnh nền không hợp lệ (chỉ nhận PNG/JPEG/WebP)' };
  if (m[2].length > MAX_BG_CHARS) throw { status: 413, message: 'Ảnh nền quá lớn — hãy giảm dung lượng' };
  return { mime: m[1], data: m[2] };
}

// ---------- handlers ----------

async function handleLoginRoutes(req, env, url) {
  const db = env.DB;
  const path = url.pathname;

  if (path === '/api/auth-status' && req.method === 'GET') {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    return json({ hasUsers: row.n > 0 });
  }

  if (path === '/api/setup' && req.method === 'POST') {
    const body = await parseBody(req);
    const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
    if (row.n > 0) return json({ error: 'Đã có tài khoản admin. Hãy đăng nhập.' }, 403);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) return json({ error: 'Tên đăng nhập 3-30 ký tự (a-z, 0-9, _ . -)' }, 400);
    if (password.length < 6) return json({ error: 'Mật khẩu tối thiểu 6 ký tự' }, 400);
    await db.prepare('INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)')
      .bind(username, await hashPassword(password), Date.now()).run();
    const token = await makeSessionToken(env, 1, username);
    return json({ ok: true, user: { username } }, 200, { 'set-cookie': sessionCookie(req, token) });
  }

  if (path === '/api/login' && req.method === 'POST') {
    const body = await parseBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = await db.prepare('SELECT id, username, pw_hash FROM users WHERE username = ?').bind(username).first();
    if (!user || !(await verifyPassword(password, user.pw_hash))) {
      return json({ error: 'Sai tên đăng nhập hoặc mật khẩu' }, 401);
    }
    const token = await makeSessionToken(env, user.id, user.username);
    return json({ ok: true, user: { username: user.username } }, 200, { 'set-cookie': sessionCookie(req, token) });
  }

  if (path === '/api/logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (path === '/api/me' && req.method === 'GET') {
    const session = await readSession(req, env);
    return session ? json({ user: { username: session.username } }) : json({ user: null });
  }

  return null;
}

async function handleAdminRoutes(req, env, url, session) {
  const db = env.DB;
  const path = url.pathname;
  const mLayout = /^\/api\/layouts(?:\/(\d+))?$/.exec(path);
  const mAction = /^\/api\/layouts\/(\d+)\/(deploy|unpublish|reset)$/.exec(path);

  // GET /api/layouts
  if (mLayout && !mLayout[1] && req.method === 'GET') {
    const { results } = await db.prepare(
      'SELECT id, name, deployed, has_bg, width, height, tables_json, updated_at, created_at FROM layouts ORDER BY updated_at DESC'
    ).all();
    return json({
      layouts: results.map(r => ({
        id: r.id, name: r.name, deployed: !!r.deployed, hasBg: !!r.has_bg,
        width: r.width, height: r.height,
        tableCount: (JSON.parse(r.tables_json || '[]')).length,
        updatedAt: r.updated_at, createdAt: r.created_at,
      })),
    });
  }

  // POST /api/layouts
  if (mLayout && !mLayout[1] && req.method === 'POST') {
    const body = await parseBody(req);
    const tables = sanitizeTables(body.tables);
    if (!tables) return json({ error: 'Danh sách bàn không hợp lệ' }, 400);
    const name = String(body.name || 'Sơ đồ không tên').slice(0, 80).trim();
    const width = Math.max(100, Math.min(6000, Number(body.width) || 1000));
    const height = Math.max(100, Math.min(6000, Number(body.height) || 700));
    let bg = null;
    try { bg = parseBg(body.background); } catch (e) { return json({ error: e.message }, e.status); }
    const now = Date.now();
    const res = await db.prepare(
      'INSERT INTO layouts (name, width, height, tables_json, has_bg, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(name, width, height, JSON.stringify(tables), bg ? 1 : 0, now, now).run();
    const id = res.meta.last_row_id;
    if (bg) await db.prepare('INSERT OR REPLACE INTO layout_bg (layout_id, mime, data) VALUES (?, ?, ?)').bind(id, bg.mime, bg.data).run();
    return json({ ok: true, id });
  }

  // GET /api/layouts/:id — chi tiết đầy đủ (kèm tables) cho editor
  if (mLayout && mLayout[1] && req.method === 'GET') {
    const id = Number(mLayout[1]);
    const r = await db.prepare(
      'SELECT id, name, width, height, tables_json, has_bg, deployed, updated_at FROM layouts WHERE id = ?'
    ).bind(id).first();
    if (!r) return json({ error: 'Không tìm thấy sơ đồ' }, 404);
    return json({
      id: r.id, name: r.name, width: r.width, height: r.height,
      tables: JSON.parse(r.tables_json || '[]'),
      hasBg: !!r.has_bg, deployed: !!r.deployed, updatedAt: r.updated_at,
    });
  }

  // PUT /api/layouts/:id
  if (mLayout && mLayout[1] && req.method === 'PUT') {
    const id = Number(mLayout[1]);
    const body = await parseBody(req);
    const tables = sanitizeTables(body.tables);
    if (!tables) return json({ error: 'Danh sách bàn không hợp lệ' }, 400);
    const existing = await db.prepare('SELECT id FROM layouts WHERE id = ?').bind(id).first();
    if (!existing) return json({ error: 'Không tìm thấy sơ đồ' }, 404);
    const name = String(body.name || 'Sơ đồ không tên').slice(0, 80).trim();
    const width = Math.max(100, Math.min(6000, Number(body.width) || 1000));
    const height = Math.max(100, Math.min(6000, Number(body.height) || 700));
    let hasBgSql = null;
    if (body.background === null) {
      await db.prepare('DELETE FROM layout_bg WHERE layout_id = ?').bind(id).run();
      hasBgSql = 0;
    } else if (body.background !== undefined) {
      let bg;
      try { bg = parseBg(body.background); } catch (e) { return json({ error: e.message }, e.status); }
      await db.prepare('INSERT OR REPLACE INTO layout_bg (layout_id, mime, data) VALUES (?, ?, ?)').bind(id, bg.mime, bg.data).run();
      hasBgSql = 1;
    }
    await db.prepare(
      `UPDATE layouts SET name = ?, width = ?, height = ?, tables_json = ?${hasBgSql !== null ? ', has_bg = ' + hasBgSql : ''}, updated_at = ? WHERE id = ?`
    ).bind(name, width, height, JSON.stringify(tables), Date.now(), id).run();
    return json({ ok: true });
  }

  // DELETE /api/layouts/:id
  if (mLayout && mLayout[1] && req.method === 'DELETE') {
    const id = Number(mLayout[1]);
    await db.batch([
      db.prepare('DELETE FROM layouts WHERE id = ?').bind(id),
      db.prepare('DELETE FROM layout_bg WHERE layout_id = ?').bind(id),
      db.prepare('DELETE FROM table_state WHERE layout_id = ?').bind(id),
      db.prepare('DELETE FROM update_log WHERE layout_id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  // POST /api/layouts/:id/deploy | unpublish | reset
  if (mAction && req.method === 'POST') {
    const id = Number(mAction[1]);
    const action = mAction[2];
    const layout = await db.prepare('SELECT * FROM layouts WHERE id = ?').bind(id).first();
    if (!layout) return json({ error: 'Không tìm thấy sơ đồ' }, 404);
    const tables = JSON.parse(layout.tables_json || '[]');

    if (action === 'deploy') {
      const now = Date.now();
      const stmts = [
        db.prepare('UPDATE layouts SET deployed = 0 WHERE deployed = 1'),
        db.prepare('UPDATE layouts SET deployed = 1, state_version = state_version + 1, updated_at = ? WHERE id = ?').bind(now, id),
        db.prepare('DELETE FROM table_state WHERE layout_id = ?').bind(id),
        db.prepare('DELETE FROM update_log WHERE layout_id = ?').bind(id),
      ];
      for (const t of tables) {
        stmts.push(db.prepare(
          'INSERT INTO table_state (layout_id, table_id, empty, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, t.id, t.total, null, now));
      }
      await db.batch(stmts);
      return json({ ok: true });
    }

    if (action === 'unpublish') {
      await db.prepare('UPDATE layouts SET deployed = 0 WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }

    if (action === 'reset') {
      const now = Date.now();
      const stmts = [
        db.prepare('UPDATE layouts SET state_version = state_version + 1 WHERE id = ?').bind(id),
        db.prepare('DELETE FROM update_log WHERE layout_id = ?').bind(id),
      ];
      for (const t of tables) {
        stmts.push(db.prepare(
          `INSERT INTO table_state (layout_id, table_id, empty, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (layout_id, table_id) DO UPDATE SET empty = excluded.empty, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
        ).bind(id, t.id, t.total, null, now));
      }
      await db.batch(stmts);
      return json({ ok: true });
    }
  }

  return null;
}

async function getActiveLayout(db) {
  return db.prepare('SELECT * FROM layouts WHERE deployed = 1 LIMIT 1').first();
}

async function buildState(db, layout, withFeed = true) {
  const { results: stateRows } = await db.prepare(
    'SELECT table_id, empty, updated_by, updated_at FROM table_state WHERE layout_id = ?'
  ).bind(layout.id).all();
  const stateMap = new Map(stateRows.map(r => [r.table_id, r]));
  const tables = JSON.parse(layout.tables_json || '[]').map(t => {
    const s = stateMap.get(t.id);
    return {
      id: t.id, label: t.label, total: t.total, x: t.x, y: t.y, r: t.r,
      empty: s ? s.empty : t.total,
      updatedBy: s?.updated_by || null,
      updatedAt: s?.updated_at || null,
    };
  });
  let feed = [];
  if (withFeed) {
    const { results: logRows } = await db.prepare(
      'SELECT label, empty, by_name, at FROM update_log WHERE layout_id = ? ORDER BY id DESC LIMIT 12'
    ).bind(layout.id).all();
    feed = logRows;
  }
  return {
    active: true,
    layoutId: layout.id,
    name: layout.name,
    version: layout.state_version,
    bgRev: layout.has_bg ? layout.updated_at : null,
    bgUrl: layout.has_bg ? `/api/bg/${layout.id}?v=${layout.updated_at}` : null,
    width: layout.width,
    height: layout.height,
    updatedAt: layout.updated_at,
    tables,
    feed,
    serverTime: Date.now(),
  };
}

async function handlePublicRoutes(req, env, url, ctx) {
  const db = env.DB;
  const path = url.pathname;

  if (path === '/api/stream' && req.method === 'GET') {
    return handleStream(req, env, ctx);
  }

  if (path === '/api/state' && req.method === 'GET') {
    const layout = await getActiveLayout(db);
    if (!layout) return json({ active: false });
    const clientV = Number(url.searchParams.get('v'));
    if (Number.isFinite(clientV) && clientV === layout.state_version) {
      return json({ active: true, changed: false, version: layout.state_version, serverTime: Date.now() });
    }
    const state = await buildState(db, layout);
    state.changed = true;
    return json(state);
  }

  const mBg = /^\/api\/bg\/(\d+)$/.exec(path);
  if (mBg && req.method === 'GET') {
    const row = await db.prepare('SELECT mime, data FROM layout_bg WHERE layout_id = ?').bind(Number(mBg[1])).first();
    if (!row) return new Response('Not found', { status: 404 });
    const bytes = b64decode(row.data);
    return new Response(bytes, {
      headers: {
        'content-type': row.mime,
        'cache-control': 'public, max-age=300, stale-while-revalidate=86400',
        'etag': `"${url.searchParams.get('v') || 'bg'}"`,
      },
    });
  }

  const mSeats = /^\/api\/tables\/([A-Za-z0-9_-]+)\/seats$/.exec(path);
  if (mSeats && req.method === 'POST') {
    if ((req.headers.get('x-requested-with') || '') !== 'fetch') {
      return json({ error: 'Yêu cầu không hợp lệ' }, 403);
    }
    const layout = await getActiveLayout(db);
    if (!layout) return json({ error: 'Chưa có sơ đồ nào được xuất bản' }, 404);
    const tableId = mSeats[1];
    const body = await parseBody(req);
    const by = String(body.by || '').slice(0, 24).trim() || null;
    const tables = JSON.parse(layout.tables_json || '[]');
    const table = tables.find(t => t.id === tableId);
    if (!table) return json({ error: 'Không tìm thấy bàn' }, 404);
    const total = table.total;

    let newEmpty;
    if (body.delta !== undefined) {
      const delta = Math.trunc(Number(body.delta));
      if (!Number.isFinite(delta) || Math.abs(delta) > 30) return json({ error: 'Giá trị thay đổi không hợp lệ' }, 400);
      newEmpty = Math.max(0, Math.min(total, (await currentEmpty(db, layout.id, tableId, total)) + delta));
    } else if (body.empty !== undefined) {
      newEmpty = Math.trunc(Number(body.empty));
      if (!Number.isFinite(newEmpty) || newEmpty < 0 || newEmpty > total) return json({ error: `Số ghế trống phải từ 0 đến ${total}` }, 400);
    } else {
      return json({ error: 'Thiếu dữ liệu' }, 400);
    }

    const now = Date.now();
    await db.batch([
      db.prepare(
        `INSERT INTO table_state (layout_id, table_id, empty, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (layout_id, table_id) DO UPDATE SET empty = excluded.empty, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      ).bind(layout.id, tableId, newEmpty, by, now),
      db.prepare('UPDATE layouts SET state_version = state_version + 1 WHERE id = ?').bind(layout.id),
      db.prepare('INSERT INTO update_log (layout_id, table_id, label, empty, by_name, at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(layout.id, tableId, table.label, newEmpty, by, now),
      db.prepare('DELETE FROM update_log WHERE layout_id = ? AND id NOT IN (SELECT id FROM update_log WHERE layout_id = ? ORDER BY id DESC LIMIT 100)')
        .bind(layout.id, layout.id),
    ]);
    const fresh = await db.prepare('SELECT state_version FROM layouts WHERE id = ?').bind(layout.id).first();
    return json({ ok: true, version: fresh.state_version, empty: newEmpty, updatedAt: now });
  }

  if (path === '/api/feed' && req.method === 'GET') {
    const layout = await getActiveLayout(db);
    if (!layout) return json({ feed: [] });
    const { results } = await db.prepare(
      'SELECT label, empty, by_name, at FROM update_log WHERE layout_id = ? ORDER BY id DESC LIMIT 30'
    ).bind(layout.id).all();
    return json({ feed: results });
  }

  return null;
}

async function currentEmpty(db, layoutId, tableId, fallback) {
  const row = await db.prepare('SELECT empty FROM table_state WHERE layout_id = ? AND table_id = ?').bind(layoutId, tableId).first();
  return row ? row.empty : fallback;
}

// SSE — đẩy state tới client ngay khi có người cập nhật (độ trễ ~1s)
function handleStream(req, env, ctx) {
  const db = env.DB;
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const write = (s) => writer.write(encoder.encode(s));
  const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  ctx.waitUntil((async () => {
    let lastVersion = -1;
    let ticks = 0;
    try {
      await write(`retry: 2000\n\n`);
      for (;;) {
        const layout = await getActiveLayout(db);
        if (layout && layout.state_version !== lastVersion) {
          lastVersion = layout.state_version;
          await send('state', { ...(await buildState(db, layout)), changed: true });
        } else if (!layout && lastVersion !== 0) {
          lastVersion = 0;
          await send('empty', { active: false });
        } else if (ticks % 5 === 0) {
          await send('ping', { t: Date.now() }); // giữ kết nối + báo client vẫn online
        }
        ticks++;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch {
      try { await writer.close(); } catch { /* client ngắt kết nối */ }
    }
  })());

  return new Response(readable, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
    },
  });
}

// ---------- entry ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        const loginRes = await handleLoginRoutes(request, env, url);
        if (loginRes) return loginRes;

        const publicRes = await handlePublicRoutes(request, env, url, ctx);
        if (publicRes) return publicRes;

        // Everything else under /api/ requires admin
        const session = await readSession(request, env);
        if (!session) return json({ error: 'Cần đăng nhập admin' }, 401);
        const adminRes = await handleAdminRoutes(request, env, url, session);
        if (adminRes) return adminRes;

        return json({ error: 'Không tìm thấy' }, 404);
      }

      // Request ngoài /api/ rơi vào worker (bình thường assets được phục vụ
      // trực tiếp; một số phiên bản wrangler dev định tuyến nhầm) → chuyển
      // tiếp tường minh sang static assets.
      try {
        return await env.ASSETS.fetch(request);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    } catch (e) {
      if (e instanceof Response) return e;
      const status = e.status || 500;
      return json({ error: e.message || 'Lỗi máy chủ' }, status);
    }
  },
};
