// オフラインでも開けるように、アプリのファイルを端末に保存しておく（サービスワーカー）。
// ゲームのデータとセーブはブラウザの保存領域（OPFS）にあるので、ここでは扱わない。
// 保存してあるファイルをすぐに使い、裏で新しいものに入れ替える（更新は次に開いたときに反映される）。

// エンジンなど大事なファイルを変えたときは数字を上げる（保存しなおしを確実にする）
const CACHE = 'pocket-runner-v5';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './zip.js',
  './engine/butterscotch.mjs',
  './engine/butterscotch.wasm',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];
// ドット文字のフォント（一度読み込めば変わらない）
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;
  if (url.pathname.includes('/__devgame/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // ?touch などが付いていても、同じページとして扱う
    const cached = await cache.match(request, { ignoreSearch: sameOrigin });
    const fromNetwork = fetch(request)
      .then((response) => {
        if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(fromNetwork);
      return cached;
    }
    return (await fromNetwork) ?? Response.error();
  })());
});
