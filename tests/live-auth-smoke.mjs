/**
 * 线上认证协议黑盒冒烟（手动运行）：set-password → room-locked/4001 撤权 →
 * challenge/auth-success → 错口令拒绝 → 重复设密拒绝 → 未认证消息拒绝
 * node tests/live-auth-smoke.mjs [wss-base]
 */
// base 必填：脚本会在房间内真实设密/发消息，不能默认指向生产环境
// （本地示例）node tests/live-auth-smoke.mjs ws://localhost:8787/ws
const BASE = process.argv[2];
if (!BASE) { console.error('用法: node tests/live-auth-smoke.mjs <ws-base，如 ws://localhost:8787/ws>'); process.exit(1); }
// 全随机房间号：避免固定前缀模式在共享环境被猜到残留锁房
const ROOM = Array.from(crypto.getRandomValues(new Uint8Array(6)))
  .map((b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[b % 62]).join('');
const URL = `${BASE}?room=${ROOM}`;
// 随机 64 hex 校验值格式占位（非真实口令），不用公开写死的常量
const HASH = Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256hex = async (s) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const openOnce = () => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  const frames = [];
  const waiters = [];
  const record = (e) => {
    let m = null; try { m = JSON.parse(e.data); } catch {}
    frames.push({ m, raw: e.data });
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) waiters.splice(i, 1)[0].res(m);
  };
  ws.addEventListener('message', record);
  ws.addEventListener('error', rej);
  ws.addEventListener('close', (e) => { ws._closeCode = e.code; ws._closed = true; });
  ws._wait = (pred, ms = 9000) => new Promise((res2, rej2) => {
    const hit = frames.find((f) => pred(f.m));
    if (hit) return res2(hit.m);
    const w = { pred, res: res2 };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); rej2(new Error('wait timeout')); } }, ms);
  });
  ws._waitClosed = (ms = 9000) => new Promise((res2) => {
    const t = setInterval(() => { if (ws._closed) { clearInterval(t); res2(ws._closeCode); } }, 80);
    setTimeout(() => { clearInterval(t); res2(-1); }, ms);
  });
  ws.addEventListener('open', () => res(ws));
});

const main = async () => {
  const A = await open();
  A.send(JSON.stringify({ type: 'join', data: { name: 'Owner', deviceType: 'desktop', deviceKey: 'KD-A' } }));
  const ja = await A._wait((m) => m?.type === 'joined');
  check('A join 成功', !!ja.peerId);

  const E = await open();
  E.send(JSON.stringify({ type: 'join', data: { name: 'Witness', deviceType: 'mobile', deviceKey: 'KD-E' } }));
  await E._wait((m) => m?.type === 'joined');

  await new Promise((r) => setTimeout(r, 3300)); // 设密在场要求 >3s
  A.send(JSON.stringify({ type: 'set-password', data: { passwordHash: HASH } }));
  const occupied = await A._wait((m) => m?.type === 'error' && m.error === 'ROOM_OCCUPIED');
  check('有他人在场时设密被拒（防夺房 ROOM_OCCUPIED）', !!occupied);

  E.close();
  await new Promise((r) => setTimeout(r, 800)); // 等待服务端处理 E 的离开
  A.send(JSON.stringify({ type: 'set-password', data: { passwordHash: HASH } }));
  const sp = await A._wait((m) => m?.type === 'set-password-result');
  check('清场后 A 设密收到 success 回执', sp.success === true, JSON.stringify(sp));

  const B = await open();
  const ch = await B._wait((m) => m?.type === 'challenge');
  check('新连接先收到 challenge(nonce)', !!ch.data?.nonce);
  const good = await sha256hex(HASH + ch.data.nonce);
  B.send(JSON.stringify({ type: 'auth', data: { response: good } }));
  const authMsg = await B._wait((m) => m?.type === 'auth-success');
  check('正确 response 通过认证 (auth-success)', authMsg?.type === 'auth-success');
  B.send(JSON.stringify({ type: 'join', data: { name: 'PeerB', deviceType: 'tablet', deviceKey: 'KD-B' } }));
  const jb = await B._wait((m) => m?.type === 'joined');
  check('认证后 join 成功', !!jb.peerId);

  B.send(JSON.stringify({ type: 'set-password', data: { passwordHash: 'cd'.repeat(32) } }));
  const dup = await B._wait((m) => m?.type === 'error' && /ALREADY/i.test(m.error || ''));
  check('重复设密被拒 (PASSWORD_ALREADY_SET)', !!dup);

  const C = await open();
  const ch2 = await C._wait((m) => m?.type === 'challenge');
  C.send(JSON.stringify({ type: 'auth', data: { response: 'wrong-value' } }));
  const bad = await C._wait((m) => m?.type === 'error' && m.error === 'PASSWORD_INCORRECT');
  check('错误口令被拒 (PASSWORD_INCORRECT)', !!bad);
  C.send(JSON.stringify({ type: 'join', data: { name: 'x' } }));
  const rej = await C._wait((m) => m?.type === 'error' && m.error !== 'PASSWORD_INCORRECT');
  check('未认证连接的 join 被拒', !!rej, rej?.error);

  [A, E, B, C].forEach((w) => { try { w.close(); } catch {} });
  const fails = results.filter((r) => !r.ok).length;
  console.log(`\nSUMMARY: ${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
};

const open = async () => {
  let last;
  for (let i = 0; i < 3; i++) { try { return await openOnce(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1200)); } }
  throw last;
};

main().catch((e) => { console.error('AUTH-SMOKE ERROR:', e?.message || e); process.exit(2); });
