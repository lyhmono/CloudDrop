/**
 * CloudDrop Service Worker - PWA shell cache
 * Network-first for everything (deploy 后立即生效), offline fallback to the
 * cached app shell. Signaling (/ws) and API (/api/) are NEVER intercepted.
 */
const CACHE = 'clouddrop-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/js/app.js',
  '/js/config.js',
  '/js/ui.js',
  '/js/webrtc.js',
  '/js/crypto.js',
  '/js/chat.js',
  '/js/chunkStore.js',
  '/js/i18n.js',
  '/js/logger.js',
  '/js/settings.js',
  '/js/sasWords.js',
  '/vendor/qrcode.min.js',
  '/logo.svg',
  '/favicon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // 信令与 API 直连网络：房间状态、ICE 凭据、密码检查结果一律不缓存
  if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/api/')) return;

  // 页面导航：网络优先，离线时回退缓存壳（PWA standalone 冷启动可打开）
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 静态资源：网络优先（保证发布后拿到新版本），失败回退缓存
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
