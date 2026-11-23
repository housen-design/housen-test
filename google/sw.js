// 浩森工作 service worker
// 畫面檔案一律「網路優先」：有網路就拿最新版（略過瀏覽器快取），只有離線或網路太慢時才用手機裡的備份。
// 所以每次發布都會在下次開啟時生效，不再依賴手動改 VERSION；只有修改這個檔案本身時才需要把 VERSION 加一。
const VERSION = 'v1.2.0';
const SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/logo.png'];
const NET_WAIT = 4000;   // 網路超過 4 秒沒回應，先用備份顯示

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;   // 資料一律走網路，不快取
  e.respondWith(netFirst(e.request));
});
async function netFirst(req) {
  const cache = await caches.open(VERSION);
  const net = fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin' })).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  try {
    return await Promise.race([net, new Promise((_, no) => setTimeout(() => no(new Error('slow')), NET_WAIT))]);
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return net;   // 沒有備份就繼續等網路
  }
}
