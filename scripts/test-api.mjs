// E2E API test against local wrangler dev
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let cookie = '';
const results = [];
function check(name, cond, extra = '') {
  results.push(`${cond ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}
async function req(method, path, body, useCookie = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'fetch',
      ...(useCookie && cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

// 1. setup admin
let r = await req('POST', '/api/setup', { username: 'admin', password: 'matkhau123' }, false);
check('POST /api/setup', r.status === 200 && r.data.ok, JSON.stringify(r.data));

// 2. duplicate setup blocked
r = await req('POST', '/api/setup', { username: 'hack', password: 'xxx123' }, false);
check('setup blocked after init', r.status === 403);

// 3. login
r = await req('POST', '/api/login', { username: 'admin', password: 'matkhau123' }, false);
check('POST /api/login', r.status === 200 && !!cookie);

// 4. wrong password
r = await req('POST', '/api/login', { username: 'admin', password: 'sairoi' }, false);
check('wrong password rejected', r.status === 401);

// 5. me
r = await req('GET', '/api/me');
check('GET /api/me', r.status === 200 && r.data.user?.username === 'admin');

// 6. no active layout
r = await req('GET', '/api/state');
check('GET /api/state empty', r.status === 200 && r.data.active === false);

// 7. unauthenticated write blocked
const noAuth = await fetch(BASE + '/api/layouts', { method: 'GET' });
check('layouts require auth', noAuth.status === 401);

// 8. create layout (10 bàn)
const tables = [];
for (let i = 0; i < 10; i++) {
  tables.push({ id: 't' + i, label: String(i + 1), total: 10, x: 100 + (i % 5) * 180, y: 100 + Math.floor(i / 5) * 180, r: 60 });
}
r = await req('POST', '/api/layouts', { name: 'Test Topaz', width: 1000, height: 500, tables });
check('POST /api/layouts', r.status === 200 && r.data.id > 0, JSON.stringify(r.data));
const layoutId = r.data.id;

// 9. invalid tables rejected (label rỗng)
r = await req('POST', '/api/layouts', { name: 'bad', width: 100, height: 100, tables: [{ id: 'x', label: '', total: 10, x: 1, y: 1, r: 5 }] });
check('empty label rejected', r.status === 400);

// 10. deploy
r = await req('POST', `/api/layouts/${layoutId}/deploy`);
check('deploy', r.status === 200);

// 11. state now active, all tables empty=total
r = await req('GET', '/api/state');
const v1 = r.data.version;
check('state active after deploy', r.data.active === true && r.data.tables?.length === 10);
check('initial empty = total', r.data.tables.every(t => t.empty === 10));
check('state has name', r.data.name === 'Test Topaz');

// 12. unchanged version → changed:false
r = await req('GET', `/api/state?v=${v1}`);
check('poll returns changed:false', r.data.changed === false);

// 13. delta update -3
r = await req('POST', '/api/tables/t0/seats', { delta: -3, by: 'Lan' });
check('delta -3', r.status === 200 && r.data.empty === 7, JSON.stringify(r.data));
const v2 = r.data.version;

// 14. version bumped → state changed
r = await req('GET', `/api/state?v=${v1}`);
check('version bumped after update', r.data.changed === true && r.data.version === v2);
check('table t0 empty=7', r.data.tables.find(t => t.id === 't0')?.empty === 7);

// 15. clamp at 0 (delta vượt dưới)
r = await req('POST', '/api/tables/t0/seats', { delta: -8, by: 'Lan' });
check('clamp at 0', r.data.empty === 0);

// 16. clamp at total
r = await req('POST', '/api/tables/t0/seats', { delta: 15, by: 'Lan' });
check('clamp at total', r.data.empty === 10);

// 17. absolute set
r = await req('POST', '/api/tables/t5/seats', { empty: 4, by: 'Bảo' });
check('absolute set', r.data.empty === 4);

// 18. out of range absolute
r = await req('POST', '/api/tables/t5/seats', { empty: 11 });
check('absolute >total rejected', r.status === 400);

// 19. feed
r = await req('GET', '/api/feed');
check('feed has entries', r.data.feed?.length >= 2 && r.data.feed[0].by_name);

// 20. update nonexistent table
r = await req('POST', '/api/tables/nope/seats', { delta: -1 });
check('unknown table 404', r.status === 404);

// 21. CSRF: missing custom header
const csrf = await fetch(BASE + '/api/tables/t1/seats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"delta":-1}' });
check('CSRF header required', csrf.status === 403);

// 22. reset (admin)
r = await req('POST', `/api/layouts/${layoutId}/reset`);
check('reset ok', r.status === 200);
r = await req('GET', '/api/state');
check('after reset empty=total', r.data.tables.every(t => t.empty === 10));

// 23. layout detail for editor
r = await req('GET', `/api/layouts/${layoutId}`);
check('GET layout detail', r.status === 200 && r.data.tables.length === 10 && r.data.hasBg === false);

// 24. update layout (rename + change tables)
r = await req('PUT', `/api/layouts/${layoutId}`, { name: 'Topaz v2', width: 1000, height: 500, tables: tables.slice(0, 5) });
check('PUT layout', r.status === 200);
r = await req('GET', '/api/layouts');
check('list shows update', r.data.layouts[0].name === 'Topaz v2' && r.data.layouts[0].tableCount === 5);

// 25. unpublish
r = await req('POST', `/api/layouts/${layoutId}/unpublish`);
r = await req('GET', '/api/state');
check('unpublish → inactive', r.data.active === false);

// 26. delete layout
r = await req('DELETE', `/api/layouts/${layoutId}`);
check('DELETE layout', r.status === 200);

// 27. logout
r = await req('POST', '/api/logout');
r = await req('GET', '/api/me');
check('logout clears session', r.data.user === null);

console.log(results.join('\n'));
const pass = results.filter(x => x.startsWith('✔')).length;
console.log(`\n${pass}/${results.length} passed`);
