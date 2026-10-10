/**
 * 安全回归测试：夺房防护（ROOM_OCCUPIED）与锁房 DoS 修复（正确口令永不被限流拒绝）
 * 用最小 Durable Object mock 直接驱动 Room 的私有方法（运行时可访问）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';

const HASH = 'ab'.repeat(32);

class MockStorage {
  constructor() { this.data = new Map(); this.putCount = 0; }
  async get(k) { return this.data.get(k); }
  async put(k, v) { this.putCount++; this.data.set(k, JSON.parse(JSON.stringify(v))); }
  async delete(k) { this.data.delete(k); }
  async setAlarm() {}
  async deleteAlarm() {}
  async getAlarm() { return null; }
}

function makeState(sockets = []) {
  return {
    storage: new MockStorage(),
    getWebSockets: () => sockets,
    blockConcurrencyWhile: (fn) => fn(),
    setWebSocketAutoResponse() {},
    getTags: () => ['TESTROOM'],
  };
}

function makeWs(attachment, readyState = 1) {
  return {
    readyState,
    sent: [],
    closeCode: null,
    _a: { ...attachment },
    serializeAttachment(v) { this._a = v; },
    deserializeAttachment() { return this._a; },
    send(f) { if (this.closeCode !== null) throw new Error('closed'); this.sent.push(JSON.parse(f)); },
    close(code) { this.closeCode = code; },
  };
}

const lastError = (ws) => [...ws.sent].reverse().find((m) => m.type === 'error');

// 构造函数里 blockConcurrencyWhile 是异步的：真实 DO 运行时保证处理任何
// 请求前初始化已完成，mock 需手动冲刷微任务（与运行时语义对齐）
const flush = () => new Promise((r) => setTimeout(r, 0));

async function makeRoom(state) {
  const room = new Room(state, {});
  await flush();
  return room;
}

async function authResponse(passwordHash, nonce) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passwordHash + nonce));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('set-password：房间内还有其他在线成员时被拒绝（防夺房）', async () => {
  const wsA = makeWs({ id: 'a', joinedAt: Date.now() - 4000 });
  const wsB = makeWs({ id: 'b', joinedAt: Date.now() - 4000 });
  const state = makeState([wsA, wsB]);
  const room = await makeRoom(state);

  await room.handleSetPasswordViaWs(wsA, { type: 'set-password', data: { passwordHash: HASH } });

  assert.equal(lastError(wsA)?.error, 'ROOM_OCCUPIED');
  assert.equal(room.passwordHash, null, '房间不得被加密');
  assert.equal(wsB.closeCode, null, '其他成员不得被踢');
});

test('set-password：唯一设备在场时正常成功', async () => {
  const wsA = makeWs({ id: 'a', joinedAt: Date.now() - 4000 });
  const state = makeState([wsA]);
  const room = await makeRoom(state);

  await room.handleSetPasswordViaWs(wsA, { type: 'set-password', data: { passwordHash: HASH } });

  assert.equal(room.passwordHash, HASH);
  assert.ok(wsA.sent.some((m) => m.type === 'set-password-result' && m.success === true));
});

test('锁房 DoS 修复：全局失败预算耗尽后，错误尝试被断连而正确口令仍可认证', async () => {
  const state = makeState([]);
  state.storage.data.set('authFailures', { count: Room.MAX_ROOM_AUTH_FAILURES, windowStart: Date.now() });
  state.storage.data.set('passwordHash', HASH);
  const room = await makeRoom(state);

  // 先错误：预算耗尽 → 拒绝并断连（且不再写存储，见下一用例）
  const bad = makeWs({ authChallenge: 'n1', clientBucket: 'atk', authAttempts: 0 });
  await room.handleAuth(bad, { type: 'auth', data: { response: 'wrong' } });
  assert.equal(lastError(bad)?.error, 'PASSWORD_INCORRECT');
  assert.equal(bad.closeCode, 4002, '耗尽预算后错误尝试应断连');

  // 后正确：新连接带正确口令仍必须通过（锁死路线封死）
  const good = makeWs({ authChallenge: 'n2', clientBucket: 'atk', authAttempts: 0 });
  await room.handleAuth(good, { type: 'auth', data: { response: await authResponse(HASH, 'n2') } });
  assert.ok(good.sent.some((m) => m.type === 'auth-success'), '预算耗尽不得阻止正确口令');
  assert.equal(good.closeCode, null);
});

test('锁房 DoS 修复：预算耗尽后不再写存储（防写放大）', async () => {
  const state = makeState([]);
  const before = state.storage.putCount;
  state.storage.data.set('authFailures', { count: Room.MAX_ROOM_AUTH_FAILURES, windowStart: Date.now() });
  state.storage.data.set('authFailuresByBucket', { b: { count: Room.MAX_IP_AUTH_FAILURES, windowStart: Date.now() } });
  state.storage.data.set('passwordHash', HASH);
  const room = await makeRoom(state);
  state.storage.putCount = 0;

  await room.handleAuth(makeWs({ authChallenge: 'n1', clientBucket: 'b', authAttempts: 0 }), { type: 'auth', data: { response: 'wrong' } });

  assert.equal(state.storage.putCount, 0, '两层计数均已耗尽，不应再有存储写');
  void before;
});

test('网段预算耗尽后，正确口令仍可认证（换连接即恢复）', async () => {
  const state = makeState([]);
  state.storage.data.set('authFailuresByBucket', { 'atk-bucket': { count: Room.MAX_IP_AUTH_FAILURES, windowStart: Date.now() } });
  state.storage.data.set('passwordHash', HASH);
  const room = await makeRoom(state);

  const bad = makeWs({ authChallenge: 'n1', clientBucket: 'atk-bucket', authAttempts: 0 });
  await room.handleAuth(bad, { type: 'auth', data: { response: 'wrong' } });
  assert.equal(bad.closeCode, 4002, '该网段错误尝试被节流');

  const good = makeWs({ authChallenge: 'n2', clientBucket: 'atk-bucket', authAttempts: 0 });
  await room.handleAuth(good, { type: 'auth', data: { response: await authResponse(HASH, 'n2') } });
  assert.ok(good.sent.some((m) => m.type === 'auth-success'));
});

test('正常限流仍有效：同一连接错误尝试 5 次后断连', async () => {
  const state = makeState([]);
  state.storage.data.set('passwordHash', HASH);
  const room = await makeRoom(state);

  const ws = makeWs({ authChallenge: 'n0', clientBucket: '', authAttempts: 0 });
  for (let i = 0; i < 5; i++) {
    const nonce = ws._a.authChallenge;
    await room.handleAuth(ws, { type: 'auth', data: { response: 'wrong' + i } });
    assert.equal(lastError(ws)?.error, 'PASSWORD_INCORRECT');
    assert.ok(nonce && ws._a.authChallenge !== nonce, '失败后应轮换 nonce');
  }
  assert.equal(ws.closeCode, 4002);
});
