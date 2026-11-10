// Basketball: Titel im Kopf ist zugleich der Wechsel zwischen EuroLeague, SB League und 2. Liga (Variante A).
// Antippen öffnet eine Liste mit allen drei Wettbewerben und je einer Zeile, was dort heute läuft (Daten der Funktionen
// euroleague und basket, beim ersten Öffnen geladen und 2 Min. im Tab gemerkt). Seitlich wischen bleibt (swipe.js).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const PAGES = [
  { id: 'euroleague', name: 'EuroLeague' },
  { id: 'sbl', name: 'SB League' },
  { id: '2liga', name: '2. Liga' },
];
const here = (/\/basketball\/(euroleague|sbl|2liga)\//.exec(location.pathname) || [])[1];
const btn = document.getElementById('bbPick');

function logo(id) {
  if (id === 'euroleague') return '<svg viewBox="135 8 572 579" aria-hidden="true"><g fill="#F07C1E"><path d="M271.64,232.27h0.26c0,0,96.95,47.56,164.99,62.77c3.92,0.69,4.18,1.54,4.18,2.64l-2.88,2.23 c-64.32,13.4-166.35,62.01-166.61,62.13c-0.07,0.02-79.1,34.87-79.19,78.46c-0.07,25.38,18.49,47.42,25.31,55.26l3.76,4.14 c51.27,50.74,121.74,82.12,199.53,82.28c123.64,0.26,229.05-78.34,268.6-188.43c-0.93-4.63-9.72-5.51-18.7-4.54 C524.9,405.04,481.93,526.92,481.29,528.21c-122.78,37.46-113.97-32.11-113.97-32.11c-0.14-49.75,95.17-113.42,172.05-145.34 c10.05-4.16,75.08-28.88,159.24-38.57c5.4-0.43,7.27-5.06,7.53-9.55c0.36-6.56,0.31-10.93-0.67-16.68 c-1.26-5.61-6.11-6.96-9.84-7.32c-10.34-1.28-20.13-2.64-29.4-4.06c-29.35-5.06-75.96-15.59-126.73-36.22 c-55.59-22.55-170.34-81.19-171.34-139.59c0,0-8.53-69.62,114.11-31.63c0.62,1.26,43.09,123.35,188.98,139.8 c8.98,1.02,17.78,0.17,18.73-4.49C650.92,92.19,545.87,13.11,422.23,12.85c-77.82-0.17-148.41,30.92-199.91,81.43l-3.76,4.14 c-6.87,7.8-25.48,29.78-25.6,55.14C192.85,184.03,228.31,210.86,271.64,232.27"/><path d="M159.67,404.32c1.21,0,3.64-0.36,3.64-2.88c0.07-29.02,32.32-54.59,72.87-75.3c21.46-10.32,44.18-20.42,65.27-26.53 l3.02-2.23l-3.71-2.64c-18.16-6.44-44.09-16.92-66.07-27.5c-39.71-20.72-70.97-46.13-70.92-74.77c0.02-2.52-2.43-2.9-3.61-2.9 l-3.37,3.35c-12.72,32.18-19.73,67.26-19.82,103.98c-0.07,36.7,6.8,71.8,19.37,104.05L159.67,404.32z"/></g></svg>';
  if (id === 'sbl') return '<img class="bb-lg-img" src="../img/sbl.png" alt="">';
  return '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="16" fill="#E30613"/><path fill="#FFFFFF" d="M13.2 7h5.6v6.2H25v5.6h-6.2V25h-5.6v-6.2H7v-5.6h6.2z"/></svg>';
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const zDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(d);
const hhmm = (d) => new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }).format(d);
const dayName = (d) => new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', weekday: 'short', day: 'numeric', month: 'numeric' }).format(d);

// Einheitliche Form: [{ utc, live, done }]; «live» = läuft gerade
async function getJson(path) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${path}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
const LOADERS = {
  euroleague: async () => (await getJson('euroleague')).games.map((g) => ({ utc: g.utc, live: !['pre', 'final'].includes(g.status), done: g.status === 'final' })),
  sbl: async () => (await getJson('basket?sbl=1')).games.map((g) => ({ utc: g.utc, live: !['pre', 'ft'].includes(g.st), done: g.st === 'ft' })),
  '2liga': async () => (await getJson('basket?bvn=h2l')).games.filter((g) => !String(g.utc).startsWith('2023')).map((g) => ({ utc: g.utc, live: false, done: g.st === 'ft' })),
};
// Eine Zeile pro Wettbewerb: live / heute / nächster Spieltag
function summary(all) {
  // Spiele ohne gültiges Datum (2. Liga: «Datum offen») nicht mitzählen
  const games = all.filter((g) => g.utc && !Number.isNaN(Date.parse(g.utc)));
  const now = new Date(), today = zDay(now);
  // Sicherheitsnetz: «live» länger als 3 Std. nach Spielbeginn gilt als beendet
  const live = games.filter((g) => g.live && now - new Date(g.utc) < 3 * 3600e3);
  const todayG = games.filter((g) => zDay(new Date(g.utc)) === today);
  if (live.length) return { live: true, text: `${live.length} live${todayG.length > live.length ? ` · heute ${todayG.length} Spiele` : ''}` };
  const next = games.filter((g) => !g.done && new Date(g.utc) > now).sort((a, b) => a.utc.localeCompare(b.utc))[0];
  if (todayG.length) {
    const open = todayG.filter((g) => !g.done && new Date(g.utc) > now);
    return { text: open.length ? `Heute ${todayG.length} ${todayG.length === 1 ? 'Spiel' : 'Spiele'} · ab ${hhmm(new Date(open[0].utc))}` : `Heute ${todayG.length} ${todayG.length === 1 ? 'Spiel' : 'Spiele'} · beendet` };
  }
  if (next) return { text: `Nächster Spieltag ${dayName(new Date(next.utc))}, ${hhmm(new Date(next.utc))}` };
  return { text: 'Keine Spiele angesetzt' };
}
const sums = new Map();
async function loadAll() {
  let cached = null;
  try { cached = JSON.parse(sessionStorage.getItem('bb-switch') || 'null'); } catch { /* ohne Speicher */ }
  if (cached && Date.now() - cached.at < 2 * 60 * 1000) { for (const [k, v] of Object.entries(cached.s)) sums.set(k, v); draw(); return; }
  await Promise.all(PAGES.map(async (p) => {
    try { sums.set(p.id, summary(await LOADERS[p.id]())); } catch { sums.set(p.id, { text: '' }); }
    draw();
  }));
  try { sessionStorage.setItem('bb-switch', JSON.stringify({ at: Date.now(), s: Object.fromEntries(sums) })); } catch { /* ohne Speicher */ }
}

let menu = null, loaded = false;
function draw() {
  if (!menu) return;
  menu.innerHTML = PAGES.map((p) => {
    const cur = p.id === here, s = sums.get(p.id);
    const href = cur ? './' : `../${p.id}/`;
    return `<a role="menuitem" href="${href}"${cur ? ' aria-current="page"' : ''}><span class="bb-lg">${logo(p.id)}</span>
      <span><b>${esc(p.name)}</b><small>${s ? esc(s.text) || '&nbsp;' : 'Lade …'}</small></span>${cur ? '<span class="bb-ok" aria-label="aktuell">✓</span>' : s?.live ? '<span class="bb-live">LIVE</span>' : '<span></span>'}</a>`;
  }).join('');
}
function setOpen(open) {
  btn.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
  if (open) {
    draw();
    if (!loaded) { loaded = true; loadAll(); }
    menu.querySelector('a[aria-current]')?.focus();
  }
}
function init() {
  menu = document.createElement('div');
  menu.className = 'bb-menu'; menu.id = 'bbMenu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Wettbewerb wählen'); menu.hidden = true;
  btn.closest('.brand').appendChild(menu);
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') { setOpen(false); btn.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...menu.querySelectorAll('a')], i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); e.preventDefault();
    }
  });
  // Zurück aus dem Verlauf: Liste geschlossen
  addEventListener('pageshow', () => setOpen(false));
}

if (btn && here) init();
