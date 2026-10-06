/**
 * CloudDrop - CI 冒烟测试
 * 启动 wrangler dev → 验证首页 200 + 安全头 + WebSocket 能完成 join。
 * （真实浏览器渲染/CSP 字体等仍建议本地 playwright 复核）
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;

function waitWsMessage(ws, type, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', handleMessage);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting ${type}`));
    }, timeout);
    const handleMessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === type) {
          cleanup();
          resolve(message);
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    ws.addEventListener('message', handleMessage);
  });
}

function waitWsOpen(ws, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout opening WebSocket'));
    }, timeout);
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('open', handleOpen);
      ws.removeEventListener('error', handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error.error || new Error('WebSocket open failed'));
    };
    ws.addEventListener('open', handleOpen);
    ws.addEventListener('error', handleError);
  });
}

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch (e) { /* not ready */ }
    await sleep(1000);
  }
  throw new Error('wrangler dev 启动超时');
}

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const wrangler = spawn(npxCommand, ['wrangler', 'dev', '--port', String(PORT)], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // 独立进程组，便于连子进程一起清理
  // Windows 上 .cmd 不能直接 spawn（Node ≥18.20 出于安全考虑要求经 shell），
  // 否则本地 npm run smoke 直接 EINVAL 退出。Linux CI 保持原样。
  shell: process.platform === 'win32',
});

let wranglerOutput = '';
wrangler.stdout.on('data', (d) => { wranglerOutput += d.toString(); });
wrangler.stderr.on('data', (d) => { wranglerOutput += d.toString(); });
wrangler.on('error', (error) => { wranglerOutput += `${error.stack || error}\n`; });

/** 收掉 wrangler 进程树（Windows 不支持按进程组发信号，得用 taskkill /T） */
function killWranglerTree() {
  if (process.platform === 'win32') {
    // process.kill(-pid) 在 Windows 上会 ESRCH，只能靠 taskkill 连子进程一起收
    try {
      spawnSync('taskkill', ['/pid', String(wrangler.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (e) { /* already gone */ }
    return;
  }
  try { process.kill(-wrangler.pid, 'SIGTERM'); } catch (e) { /* already gone */ }
}

async function stopWrangler() {
  const hasExited = () => wrangler.exitCode !== null || wrangler.signalCode !== null;
  if (hasExited()) return;

  const gracefulExit = once(wrangler, 'exit');
  killWranglerTree();
  await Promise.race([gracefulExit, sleep(3000)]);

  if (!hasExited()) {
    const forcedExit = once(wrangler, 'exit');
    killWranglerTree();
    await Promise.race([forcedExit, sleep(1000)]);
  }
}

let exitCode = 0;
let ws;

try {
  await waitForServer();

  // 1. 首页与静态资源
  const checks = [];
  for (const f of ['/', '/js/app.js', '/vendor/qrcode.min.js']) {
    const res = await fetch(BASE + f);
    checks.push([f, res.status === 200]);
  }
  console.log('静态资源:', JSON.stringify(checks));

  // 2. 安全头（含字体真实域名 gstatic.loli.net）
  const css = await fetch(`${BASE}/style.css`);
  const csp = css.headers.get('content-security-policy') || '';
  const fontOk = csp.includes('https://gstatic.loli.net');
  const nosniff = css.headers.get('x-content-type-options') === 'nosniff';
  console.log('CSP 含字体域名:', fontOk, '| nosniff:', nosniff);

  // 3. WebSocket join
  const room = 'SMOKE1';
  ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
  await waitWsOpen(ws);
  const joinedPromise = waitWsMessage(ws, 'joined');
  ws.send(JSON.stringify({ type: 'join', data: { name: 'smoke', deviceType: 'desktop', deviceKey: 'SMK' } }));
  const joined = await joinedPromise;
  console.log('WebSocket joined:', joined.roomCode === room);

  // 3.5 心跳链路：客户端每 20s 发 'ping'，依赖 DO 的 setWebSocketAutoResponse 回
  // 'pong'。此路径是移动端半死连接自愈的前提，回归会让接收方永远收不到文件提示。
  // 用独立连接复刻 app 时序（join 后隔一会儿再 ping），避免复用上面带 joined
  // 监听器的连接；autoResponse 在 handleJoin 内配置，ping 需在其之后。
  const hb = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`);
  await waitWsOpen(hb);
  hb.send(JSON.stringify({ type: 'join', data: { name: 'hb', deviceType: 'desktop', deviceKey: 'HB' } }));
  await waitWsMessage(hb, 'joined');
  await sleep(1500);
  const pongOk = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 5000);
    // 注意：Node 风格 'message' 回调第一个参数直接是 data（Buffer），不是 event 对象
    hb.on('message', (data) => {
      if (String(data) === 'pong') { clearTimeout(t); resolve(true); }
    });
    hb.send('ping');
  });
  hb.close();
  console.log('心跳 ping→pong 自动应答:', pongOk);
  ws.close();

  // 4. 跨站 WS 门禁：带外部 Origin 的升级必须被拒绝（不带 Origin 的 CLI 连接已在
  //    上一步验证放行）。回归会导致恶意网页可枚举/劫持用户的自动分配房间。
  const crossOrigin = new WebSocket(`ws://localhost:${PORT}/ws?room=${room}`, {
    headers: { Origin: 'https://evil.example.com' },
  });
  const gate = await new Promise((resolve) => {
    const t = setTimeout(() => { crossOrigin.terminate(); resolve('timeout'); }, 5000);
    crossOrigin.on('open', () => { clearTimeout(t); crossOrigin.close(); resolve('accepted'); });
    crossOrigin.on('unexpected-response', (_req, res) => { clearTimeout(t); resolve(res.statusCode); });
    crossOrigin.on('error', () => { clearTimeout(t); resolve('error'); });
  });
  console.log('跨站 Origin 升级返回:', gate);
  ws = null;

  const failed = [
    ...checks.filter(([, ok]) => !ok).map(([f]) => `资源 ${f} 非 200`),
    ...(!fontOk ? ['CSP 缺 gstatic.loli.net'] : []),
    ...(!nosniff ? ['缺 nosniff'] : []),
    ...(joined.roomCode !== room ? ['WebSocket join 失败'] : []),
    ...(!pongOk ? ['心跳 pong 未收到（DO autoResponse 失效）'] : []),
    ...(gate !== 403 ? [`跨站 WS 未被拦截（得到 ${gate}，期望 403）`] : []),
  ];

  if (failed.length) {
    throw new Error(failed.join('; '));
  }
  console.log('SMOKE PASS');
} catch (e) {
  console.error('SMOKE FAIL:', e.message || String(e));
  console.error(wranglerOutput.slice(-2000));
  exitCode = 1;
} finally {
  ws?.terminate();
  await stopWrangler();
}

process.exitCode = exitCode;
