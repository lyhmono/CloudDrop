/**
 * 前端小修回归：属性上下文转义、数值格式防护、发送端大小预检
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatFileSize, formatSpeed } from '../public/js/ui.js';
import { WebRTCManager } from '../public/js/webrtc.js';
import { MAX_FILE_SIZE, ERROR_CODES } from '../public/js/config.js';

// Node 无 DOM：模拟浏览器 textContent→innerHTML 的序列化语义（只转 & < >，
// 不转引号——正是被测函数额外补齐的部分）
globalThis.document = {
  createElement: () => ({
    set textContent(v) { this._t = String(v); },
    get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  }),
};

test('escapeHtml：文本与属性上下文均可安全插值（引号被转义）', () => {
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
  assert.equal(escapeHtml("a'b"), 'a&#39;b');
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('" onmouseover="x'), '&quot; onmouseover=&quot;x');
});

test('formatFileSize/formatSpeed：非有限值降级为占位符而非 NaN undefined', () => {
  assert.equal(formatFileSize(Infinity), '—');
  assert.equal(formatFileSize(NaN), '—');
  assert.equal(formatSpeed(Infinity), '—');
  assert.equal(formatSpeed(0), '0 B/s');
  assert.equal(formatFileSize(1024), '1.0 KB');
});

test('sendFile：超限文件在建立连接/请求确认前即抛 FILE_TOO_LARGE', async () => {
  const m = new WebRTCManager();
  let ensureCalled = false;
  m.ensureConnection = async () => { ensureCalled = true; };
  const fake = { name: 'big.bin', size: MAX_FILE_SIZE + 1 };

  await assert.rejects(m.sendFile('peer1', fake), (e) => e.message === ERROR_CODES.FILE_TOO_LARGE);
  assert.equal(ensureCalled, false, '预检必须短路，不得先发起连接');
  await assert.rejects(m.sendFiles('peer1', [{ name: 'ok.bin', size: 10 }, fake]), (e) => e.message === ERROR_CODES.FILE_TOO_LARGE);
});
