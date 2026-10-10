/**
 * 房间码生成回归：网段聚合语义不变 + 服务端盐阻断离线反推网段
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoomId } from '../src/index.ts';

test('同一 /24 生成相同房号；不同 /24 不同', async () => {
  const a = await generateRoomId('203.0.113.45');
  const b = await generateRoomId('203.0.113.200');
  const c = await generateRoomId('198.51.100.7');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('盐改变房号：不同部署/不同盐无法互相离线穷举反查网段', async () => {
  const unsalted = await generateRoomId('203.0.113.45');
  const s1 = await generateRoomId('203.0.113.45', 'salt-A');
  const s2 = await generateRoomId('203.0.113.45', 'salt-B');
  assert.notEqual(s1, unsalted);
  assert.notEqual(s1, s2);
  // 加盐不破坏同网段聚合语义
  assert.equal(s1, await generateRoomId('203.0.113.99', 'salt-A'));
});

test('无盐调用与旧实现一致（本地开发兼容回退）', async () => {
  const legacy = await generateRoomId('localhost');
  assert.equal(await generateRoomId('127.0.0.1'), legacy);
  assert.equal(await generateRoomId('::1'), legacy);
});
