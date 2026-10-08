/**
 * 线上信令协议黑盒冒烟（手动运行，不进 CI）：
 * node tests/live-smoke.mjs [wss-base]
 * 验证：deviceType 服务端白名单 / name 控制字符剥离 / from 字段服务器覆写 /
 *      未 join 连接的消息被忽略 / 跨站 Origin 403（HTTP 层已在外部验证，此处跳过）
 */
const BASE = process.argv[2] || 'wss://cs.nnaa.us.ci/ws';
const ROOM = 'LT' + Math.floor(Math.random() * 100000).toString().padStart(4, '0').replace(/[OIL]/g, 'X').slice(0, 4);
const URL_ROOM = `${BASE}?room=${ROOM.toUpperCase()}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const once = (ws, pred, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  const h = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (!pred(msg)) return;
    clearTimeout(t); ws.removeEventListener('message', h); res(msg);
  };
  ws.addEventListener('message', h);
});

const connect = () => new Promise((res, rej) => {
  const ws = new WebSocket(URL_ROOM);
  const t = setTimeout(() => rej(new Error('connect timeout')), 8000);
  ws.addEventListener('open', () => { clearTimeout(t); res(ws); });
  ws.addEventListener('error', (e) => { clearTimeout(t); rej(e); });
});

const main = async () => {
  // B 先入房（合法 mobile），随后 A 用恶意 deviceType/name 入房
  const B = await connect();
  B.send(JSON.stringify({ type: 'join', data: { name: 'PeerB', deviceType: 'mobile', browserInfo: 'node', deviceKey: 'KB' } }));
  const bJoined = await once(B, (m) => m.type === 'joined');
  const bId = bJoined.peerId;
  check('B joined 返回自身 id 与房间号', !!bId && String(bJoined.roomCode).toUpperCase() === ROOM.toUpperCase(), JSON.stringify({ bId, code: bJoined.roomCode }));

  const A = await connect();
  A.send(JSON.stringify({ type: 'join', data: { name: 'Evil\u0000Name\nX', deviceType: '<script>x</script>', browserInfo: 'ok', deviceKey: 'KA' } }));

  const aPeerOnB = await once(B, (m) => m.type === 'peer-joined' && m.data?.deviceKey === 'KA');
  check('服务端 deviceType 白名单生效（恶意值→desktop）', aPeerOnB.data.deviceType === 'desktop', 'got=' + JSON.stringify(aPeerOnB.data.deviceType));
  check('服务端剥离 name 控制字符（无 \\u0000 / \\n）', !/[\u0000\n]/.test(aPeerOnB.data.name), 'got=' + JSON.stringify(aPeerOnB.data.name));

  const aJoined = await once(A, (m) => m.type === 'joined');
  const seenB = (aJoined.peers || []).find((p) => p.deviceKey === 'KB');
  check('合法 deviceType(mobile) 原样保留', seenB?.deviceType === 'mobile', JSON.stringify(seenB));

  // from 覆写：A 伪造 from=HACKED 给 B 发 key-exchange，B 应看到 A 的真实 id
  A.send(JSON.stringify({ type: 'key-exchange', to: bId, from: 'HACKED', data: { publicKey: 'fake-pub' } }));
  const kx = await once(B, (m) => m.type === 'key-exchange');
  check('from 字段由服务器覆写为真实 peerId', kx.from === aJoined.peerId && kx.from !== 'HACKED', 'from=' + kx.from);

  // 未 join 的幽灵连接：发的信令应被忽略（B 5 秒内收不到其转发）
  const G = await connect();
  G.send(JSON.stringify({ type: 'key-exchange', to: bId, data: { publicKey: 'ghost' } }));
  let ghostGot = false;
  const gh = (e) => { try { const m = JSON.parse(e.data); if (m.type === 'key-exchange' && m.data?.publicKey === 'ghost') ghostGot = true; } catch {} };
  B.addEventListener('message', gh);
  await new Promise((r) => setTimeout(r, 5000));
  B.removeEventListener('message', gh);
  check('未 join 连接的消息被服务器忽略', !ghostGot);

  A.close(); B.close(); G.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${results.length - fails.length}/${results.length} passed`);
  process.exit(fails.length ? 1 : 0);
};

main().catch((e) => { console.error('SMOKE ERROR:', e.message || e); process.exit(2); });
