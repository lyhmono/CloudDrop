/**
 * CloudDrop - data:URL 转 Blob 回归测试
 *
 * 线上 CSP 的 connect-src 'self' 会拦截 fetch(dataUrl)（已在生产页面实测 BLOCKED），
 * 复制图片路径原先正是 fetch(dataUrl)，部署后即 100% 失败。
 * 改为手工解码后，本测试锁定解码正确性与"不再依赖 fetch"这一不变量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// chat.js -> ui.js/i18n.js 需要最小 DOM stub（模式与 modal.test.mjs 一致）
class El {
  constructor(id = '', tag = 'div') {
    this.id = id; this.tagName = tag.toUpperCase(); this._classes = new Set();
    this.children = []; this.style = {}; this.textContent = ''; this.innerHTML = '';
    this.classList = { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} };
  }
  addEventListener() {} removeEventListener() {} querySelector() { return null; }
  querySelectorAll() { return []; } closest() { return null; } appendChild() {}
}
globalThis.document = {
  body: { style: {}, appendChild() {}, removeChild() {} },
  documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} } },
  getElementById: () => null,
  createElement: (tag) => new El('', tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = globalThis;
if (!globalThis.navigator) globalThis.navigator = {};
if (!globalThis.localStorage) {
  const m = new Map();
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
}
// fetch 装个"必然失败"探针：解码路径若还敢碰 fetch 会直接暴露
globalThis.fetch = async () => { throw new Error('fetch must not be used for data: URLs (CSP connect-src blocks data:)'); };

const { ChatMixin } = await import('../public/js/chat.js');
const dataUrlToBlob = ChatMixin.dataUrlToBlob;

test('base64 data URL 解码：字节内容与 MIME 正确，且不经过 fetch', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

  const blob = dataUrlToBlob(dataUrl);

  assert.equal(blob.type, 'image/png');
  const out = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(Array.from(out), Array.from(bytes));
});

test('percent-encoded（非 base64）data URL 也能解码', async () => {
  const dataUrl = 'data:text/plain,hello%20world';
  const blob = dataUrlToBlob(dataUrl);
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), 'hello world');
});

test('缺 MIME 的 data URL 回退 image/png（调用方均为图片路径）', async () => {
  const dataUrl = 'data:;base64,' + Buffer.from('ab').toString('base64');
  const blob = dataUrlToBlob(dataUrl);
  assert.equal(blob.type, 'image/png');
});

test('非法 data URL 抛错（由调用方 try/catch 兜住）', () => {
  assert.throws(() => dataUrlToBlob('not-a-data-url'));
});
