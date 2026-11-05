// Service worker — PWA cài được lên màn hình chính, chạy offline một phần.
// Chiến lược:
// - /api/*  : luôn đi mạng
// - HTML/JS/CSS/manifest: network-first (cập nhật code ngay khi có bản mới),
//   fallback cache khi offline
// - icon + pdf.js vendor: cache-first (ít đổi, dùng offline)
const VERSION = 'v1.0.5';
const CACHE = `bandanhcupo-${VERSION}`;
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/api.js',
  './js/ui.js',
  './js/canvas-view.js',
  './js/viewer.js',
  './js/editor.js',
  './js/detect.js',
  './js/pdf-import.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(PRECACHE.map(u => cache.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const CACHE_FIRST = [/\/icons\//, /\/vendor\//];

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (CACHE_FIRST.some(re => re.test(url.pathname))) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      // khoá cache theo pathname (bỏ query) — tránh tích luỹ entry mỗi lần bust
      const cached = await cache.match(url.pathname);
      if (cached) return cached;
      let res = await fetch(url.pathname);
      // SPA fallback có thể trả text/html (200) khi asset router miss —
      // phát hiện và bust qua HTTP cache bằng query duy nhất
      let ct = res.headers.get('content-type') || '';
      if (!res.ok || ct.includes('text/html')) {
        res = await fetch(url.pathname + '?swb=' + Date.now());
        ct = res.headers.get('content-type') || '';
      }
      if (res.ok && !ct.includes('text/html')) {
        cache.put(url.pathname, res.clone());
        return res;
      }
      return cached || Response.error();
    })());
    return;
  }

  // HTML/JS/CSS: mạng trước để lấy code mới, offline thì dùng cache
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(e.request);
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    } catch {
      const cached = await cache.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('.html') });
      if (cached) return cached;
      if (e.request.mode === 'navigate') {
        return (await cache.match('./index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
});
