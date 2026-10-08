/**
 * 安全修复回归测试：basename 清洗、聊天历史上限、口令校验值派生、E2EE 往返
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basename } from '../public/js/ui.js';
import { ChatMixin } from '../public/js/chat.js';
import { CryptoManager } from '../public/js/crypto.js';

test('basename：剥路径（含反斜杠）、空名回退 file', () => {
  assert.equal(basename('a/b/c.pdf'), 'c.pdf');
  assert.equal(basename('C:\\evil\\report.exe'), 'report.exe');
  assert.equal(basename(''), 'file');
  assert.equal(basename(123), 'file');
});

test('basename：剥离控制字符与 Bidi 覆盖符（U+202E 换序钓鱼）', () => {
  assert.equal(basename('evil\u202Efpj.pdf'), 'evilfpj.pdf');
  assert.equal(basename('a\nb\tc.txt'), 'abc.txt');
  assert.ok(basename('正常文件名.docx').includes('正常'));
});

test('basename：超长截断到 200', () => {
  assert.equal(basename('x'.repeat(300)).length, 200);
});

test('saveMessage：500 条环形上限且掐头后重置增量渲染计数', () => {
  const ctx = { messageHistory: new Map(), renderedChatCounts: new Map([['p', 3]]) };
  for (let i = 0; i < 602; i++) {
    ChatMixin.saveMessage.call(ctx, 'p', { type: 'received', text: 'm' + i });
  }
  const h = ctx.messageHistory.get('p');
  assert.equal(h.length, 500);
  assert.equal(h[499].text, 'm601');
  assert.equal(h[0].text, 'm102');
  assert.equal(ctx.renderedChatCounts.has('p'), false);
});

test('hashPasswordForServer：PBKDF2 校验值为 64 位十六进制、确定且随房间号变化', async () => {
  const cm = new CryptoManager();
  const a = await cm.hashPasswordForServer('secret123', 'ABCDEF');
  const b = await cm.hashPasswordForServer('secret123', 'ABCDEF');
  const c = await cm.hashPasswordForServer('secret123', 'XYZ123');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('E2EE：ECDH+HKDF 双向密钥一致，加密文本可互解（协议 v2）', async () => {
  const A = new CryptoManager();
  const B = new CryptoManager();
  await A.generateKeyPair();
  await B.generateKeyPair();
  const pubA = await A.exportPublicKey();
  const pubB = await B.exportPublicKey();
  await A.importPeerPublicKey('B', pubB);
  await B.importPeerPublicKey('A', pubA);
  const cipher = await A.encryptText('B', 'hello-v2');
  const plain = await B.decryptText('A', cipher);
  assert.equal(plain, 'hello-v2');
});
