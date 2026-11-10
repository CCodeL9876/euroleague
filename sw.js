// Offline-Modus: Die Seite und die letzten Daten bleiben im Zwischenspeicher. Immer zuerst aus dem Netz (damit alles
// aktuell ist); ohne Netz kommt der letzte Stand – bei den Spieldaten mit Kopfzeile „x-offline“, damit die Seite
// „Offline – Stand von …“ anzeigt. Logos und Spielerfotos: zuerst aus dem Zwischenspeicher (ändern sich kaum).

const CACHE = 'euroleague-v155';
const IMAGES = /^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//;
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const DATA = /\/functions\/v1\/euroleague/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'index.html', 'gate.js', 'basketball/euroleague/', 'basketball/euroleague/app.js', 'basketball/sbl/', 'basketball/2liga/', 'basketball/regio.js', 'basketball/swipe.js', 'basketball/switch.js', 'basketball/img/bca.png', 'basketball/regio.css', 'meinsport/meinsport.js', 'meinsport/meinsport.css', 'fussball/tv.js', 'style.css', 'config.js', 'theme-boot.js', 'start-boot.js', 'news.json', 'icon.svg', 'manifest.webmanifest', 'fussball/', 'fussball/fussball.js', 'fussball/fussball.css', 'fussball/manifest.webmanifest', 'fussball/icon.svg'])).catch(() => {}));
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

// Tor-Mitteilungen: Die Funktion „fussball“ stösst das Gerät ohne Inhalt an; hier die Meldungen abholen und zeigen
const FB_FN = 'https://vbipkljatgandplwould.supabase.co/functions/v1/fussball';
const FB_ANON = 'sb_publishable_dg4tPjjsYOGRHxuf0Is43Q_LZRRzfs4';
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    // Meldungen abholen; klappt es nicht gleich (Handy eben erst aufgewacht, Netz langsam), bis zu dreimal kurz warten und neu versuchen,
    // damit der richtige Text («⚽ Vamooooos! - Tor für …») kommt statt der allgemeinen Meldung
    let list = [];
    const sub = await self.registration.pushManager.getSubscription().catch(() => null);
    for (let i = 0; i < 4 && !list.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500 * i));
      try {
        const res = await fetch(`${FB_FN}?fbpushmsg=${encodeURIComponent(sub?.endpoint || '')}`, { headers: { apikey: FB_ANON }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
        const msgs = await res.json();
        list = (Array.isArray(msgs) ? msgs : []).filter((m) => Date.now() - m.at < 30 * 60 * 1000);
      } catch { /* ohne Netz: nochmals versuchen, sonst allgemeine Meldung */ }
    }
    // Nur die neueste Meldung pro Spiel (bei mehreren Toren kurz hintereinander) – Testmeldungen nur die letzte
    const byGame = new Map(list.map((m) => [`${m.kind || 'goal'}:${m.id || 'test'}`, m]));
    const fresh = [...byGame.values()].slice(-3);
    if (!fresh.length) return self.registration.showNotification('⚽ Vamooooos!', { body: 'Neues von deinen Teams – tippen für den Spielstand.', tag: 'fb-goal', icon: 'fussball/icon-180.png', data: { url: 'fussball/' } });
    // Gleiche Meldung (tag = Spiel + Stand) ersetzt sich selbst, darum keine Doppelten
    await Promise.all(fresh.map((m) => self.registration.showNotification(m.title, { body: m.body, tag: m.tag, icon: m.kind === 'el' ? 'icon-180.png' : 'fussball/icon-180.png', data: { url: /^(fussball\/\?m=[\w%-]+(&tab=lineup)?|basketball\/euroleague\/\?game=\d{1,3})$/.test(m.url || '') ? m.url : m.id ? `fussball/?m=${encodeURIComponent(m.id)}` : 'fussball/' } })));
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || 'fussball/', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Fenster des passenden Bereichs weiterverwenden (EuroLeague-Mitteilung → EuroLeague-Seite)
    const dir = url.includes('/basketball/') ? '/basketball/euroleague/' : '/fussball/';
    const w = wins.find((c) => c.url.includes(dir));
    if (w) { await w.navigate(url).catch(() => {}); return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
