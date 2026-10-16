// Cache Storage is origin-wide; only prune this registration's cache namespace.
const PREFIX = `luba-shell:${encodeURIComponent(self.registration.scope)}:`;
const CACHE = PREFIX + 'ac7cf4f16b7704af';
const ASSETS = ['./', './index.html', './style.css', './manifest.webmanifest', './icon-192.png', './icon-512.png', './src/app.js', './src/domain.js', './src/repository.js'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll is atomic: a failed download never installs a partial shell.
    await cache.addAll(ASSETS);
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data === 'VERIFY') event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const complete = (await Promise.all(ASSETS.map(asset => cache.match(new URL(asset, self.registration.scope).href)))).every(Boolean);
    event.ports[0]?.postMessage(complete);
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const asset = ASSETS.some(path => new URL(path, self.registration.scope).href === url.href);
  if (asset) event.respondWith((async () => (await (await caches.open(CACHE)).match(event.request)) ?? fetch(event.request))());
});
