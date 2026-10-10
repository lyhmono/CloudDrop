/**
 * 信令转发/限流回归：offer/relay-data 转发、from 覆写、 oversized 帧拒绝、
 * ICE 与 relay 预算隔离（此前 relay-data/file 路径无任何回归保护）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';

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

class MockStorage {
  constructor() { this.data = new Map(); }
  async get(k) { return this.data.get(k); }
  async put(k, v) { this.data.set(k, JSON.parse(JSON.stringify(v))); }
  async delete(k) { this.data.delete(k); }
  async setAlarm() {}
  async deleteAlarm() {}
  async getAlarm() { return null; }
}

function makeRoom(sockets) {
  const state = {
    storage: new MockStorage(),
    getWebSockets: () => sockets,
    blockConcurrencyWhile: (fn) => fn(),
    setWebSocketAutoResponse() {},
    getTags: () => ['TESTROOM'],
  };
  return new Room(state, {});
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const peer = (id, connId) => ({ id, connId, isAuthenticated: true, joinedAt: Date.now() });

test('offer/answer/ice-candidate 经 webSocketMessage 转发给目标 peer，from 由服务端覆写', async () => {
  const wsA = makeWs(peer('a', 'ca'));
  const wsB = makeWs(peer('b', 'cb'));
  const room = makeRoom([wsA, wsB]);
  await flush();

  await room.webSocketMessage(wsA, JSON.stringify({ type: 'offer', to: 'b', from: 'SPOOFED', data: { sdp: 'x' } }));

  const got = wsB.sent.find((m) => m.type === 'offer');
  assert.ok(got, '目标应收到转发消息');
  assert.equal(got.from, 'a', 'from 必须覆写为真实发送者 id');
  assert.equal(wsA.sent.find((m) => m.type === 'error'), undefined);
});

test('未知 to / 未 join 的连接：消息被静默忽略，不泄露错误', async () => {
  const ghost = makeWs({ connId: 'cg' }); // 无 id（未 join）
  const wsB = makeWs(peer('b', 'cb'));
  const room = makeRoom([ghost, wsB]);
  await flush();

  await room.webSocketMessage(ghost, JSON.stringify({ type: 'offer', to: 'b', data: {} }));
  await room.webSocketMessage(wsB, JSON.stringify({ type: 'offer', to: 'nobody', data: {} }));
  assert.equal(wsB.sent.length, 0);
});

test('超大二进制帧：解析前即按 byteLength 拒绝（MESSAGE_TOO_LARGE）', async () => {
  const wsA = makeWs(peer('a', 'ca'));
  const wsB = makeWs(peer('b', 'cb'));
  const room = makeRoom([wsA, wsB]);
  await flush();

  await room.webSocketMessage(wsA, new ArrayBuffer(262145));
  assert.equal(wsA.sent.at(-1)?.error, 'MESSAGE_TOO_LARGE');
});

test('relay 洪灌耗尽 2MB/s 预算后，ICE 候选仍走独立预算正常转发', async () => {
  const wsA = makeWs(peer('a', 'ca'));
  const wsB = makeWs(peer('b', 'cb'));
  const room = makeRoom([wsA, wsB]);
  await flush();

  // 灌 20×240KB relay 数据（单帧低于 256KB 上限；总量超 4MB burst → 尾部被丢弃）。
  // relay-data 不受控制消息条数配额限制，只受字节预算。
  const pad = JSON.stringify({ type: 'relay-data', to: 'b', data: { pad: 'x'.repeat(240_000) } });
  for (let i = 0; i < 20; i++) await room.webSocketMessage(wsA, pad);
  assert.ok(wsA.sent.some((m) => m.error === 'RATE_LIMIT_EXCEEDED'), 'relay 超预算应告警');

  // 同一连接随后的小 ICE 候选：独立预算必须放行
  const before = wsB.sent.length;
  await room.webSocketMessage(wsA, JSON.stringify({ type: 'ice-candidate', to: 'b', data: { candidate: 'c' } }));
  assert.ok(wsB.sent.length > before, 'ICE 不得被 relay 洪水挤占');
  assert.equal(wsB.sent.at(-1).type, 'ice-candidate');
});

test('控制消息速率限制：1 秒窗口超 10 条被拒并给出错误码', async () => {
  const wsA = makeWs(peer('a', 'ca'));
  const wsB = makeWs(peer('b', 'cb'));
  const room = makeRoom([wsA, wsB]);
  await flush();

  for (let i = 0; i < 12; i++) {
    await room.webSocketMessage(wsA, JSON.stringify({ type: 'name-changed', data: { name: 'n' + i } }));
  }
  assert.ok(wsA.sent.some((m) => m.error === 'RATE_LIMIT_EXCEEDED'), '第 11 条起应被限流');
  // 前 10 条内至少有一条广播到达 B
  assert.ok(wsB.sent.some((m) => m.type === 'name-changed'));
});
