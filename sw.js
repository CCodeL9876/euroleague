// Offline-Modus: Die Seite und die letzten Daten bleiben im Zwischenspeicher. Immer zuerst aus dem Netz (damit alles
// aktuell ist); ohne Netz kommt der letzte Stand – bei den Spieldaten mit Kopfzeile „x-offline“, damit die Seite
// „Offline – Stand von …“ anzeigt. Logos und Spielerfotos: zuerst aus dem Zwischenspeicher (ändern sich kaum).

const CACHE = 'euroleague-v30';
const IMAGES = /^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const DATA = /\/functions\/v1\/euroleague/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'gate.js', 'app.js', 'style.css', 'config.js', 'theme-boot.js', 'news.json', 'icon.svg', 'manifest.webmanifest'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function networkFirst(req, markOffline) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (!hit) throw err;
    if (!markOffline) return hit;
    const headers = new Headers(hit.headers);
    headers.set('x-offline', '1');
    return new Response(await hit.blob(), { status: 200, headers });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = req.url;
  if (DATA.test(url)) e.respondWith(networkFirst(req, true));
  else if (IMAGES.test(url) || FONTS.test(url)) e.respondWith(cacheFirst(req));
  else if (new URL(url).origin === self.location.origin) e.respondWith(networkFirst(req, false));
});
