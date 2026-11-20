// Lets the logbook open with no signal, and on in-flight Wi-Fi that has no real internet.
// - The page itself: try the network for 3 seconds, otherwise use the copy saved on this device.
// - app.js / app.css carry a version in their URL, so the saved copy is used straight away.
// API and sign-in requests are never cached.
const VERSION = new URL(location.href).searchParams.get('v') || 'dev';
const CACHE = 'pilot-logbook-' + VERSION;
const SHELL = ['index.html', `app.js?v=${VERSION}`, `app.css?v=${VERSION}`, 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('pilot-logbook-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function timeout(ms) { return new Promise(res => setTimeout(() => res(null), ms)); }

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;                 // /api, /auth etc. go straight to the network
  const isPage = req.mode === 'navigate' || url.pathname === scope || url.pathname.endsWith('/index.html');

  e.respondWith((async () => {
   try {
    const cache = await caches.open(CACHE);
    if (isPage) {
      const net = fetch(req).then(res => {          // (no options: browsers reject options on page-load requests)
        const html = (res.headers.get('content-type') || '').includes('text/html');
        if (res.ok && html && !res.redirected) { cache.put('index.html', res.clone()); return res; }
        return null;                                            // Wi-Fi login page etc. - not our app
      }).catch(() => null);
      const first = await Promise.race([net, timeout(3000)]);
      if (first) return first;
      const saved = await cache.match('index.html');
      if (saved) return saved;
      return (await net) || fetch(req);
    }
    const saved = await cache.match(req);
    if (saved) return saved;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
   } catch (err) {
      return fetch(req);                                      // never worse than having no offline helper
    }
  })());
});
