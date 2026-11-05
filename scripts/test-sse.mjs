// Test SSE: nghe /api/stream rồi POST cập nhật — đo độ trễ đến khi nhận event
const BASE = 'http://127.0.0.1:8787';

const st = await fetch(BASE + '/api/state').then(r => r.json());
if (!st.active) { console.log('Chưa có layout active'); process.exit(1); }
const target = st.tables.find(t => t.empty > 0) || st.tables[0];
console.log('Stream status OK — đích: bàn', target.label, '(id ' + target.id + ', empty=' + target.empty + ')');

const res = await fetch(BASE + '/api/stream');
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
const t0 = Date.now();
let gotFirst = false, gotUpdate = false, exit = false, postAt = 0;

(async () => {
  for (;;) {
    if (exit) return;
    const { done, value } = await reader.read();
    if (done) return;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /event: (\w+)/.exec(chunk)?.[1];
      const ms = Math.round(Date.now() - t0);
      if (ev === 'state' && !gotFirst) { gotFirst = true; console.log(`+${ms}ms  state đầu tiên`); }
      if (ev === 'ping') console.log(`+${ms}ms  ping`);
      if (ev === 'state' && gotFirst && postAt) {
        const d = JSON.parse(chunk.split('data: ')[1]);
        const t = d.tables.find(x => x.id === target.id);
        const dt = Date.now() - postAt;
        console.log(`⚡ +${ms}ms  NHẬN CẬP NHẬT sau POST ${Math.round(dt)}ms: Bàn ${t.label} → ${t.empty} trống`);
        gotUpdate = true;
        exit = true;
        return;
      }
    }
  }
})();

await new Promise(r => setTimeout(r, 1500));
postAt = Date.now();
const post = await fetch(BASE + `/api/tables/${target.id}/seats`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
  body: JSON.stringify({ delta: -1, by: 'SSE-Test' }),
});
console.log('POST trả:', JSON.stringify(await post.json()));
await new Promise(r => setTimeout(r, 4000));
exit = true;
// hoàn tác
await fetch(BASE + `/api/tables/${target.id}/seats`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
  body: JSON.stringify({ delta: 1, by: 'SSE-Test' }),
});
console.log(gotUpdate ? '✔ PASS — cập nhật đẩy tới client trong ' : '✘ FAIL');
process.exit(gotUpdate ? 0 : 1);
