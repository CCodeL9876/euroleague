// Mein Sport: gemeinsame Startseite. Liest dieselben Daten wie die Bereiche Basketball und Fussball und führt für Details
// dorthin (../?game=, ../?team=, ../fussball/?m=). Zugang und Profil wie dort (gate.js, Lieblingsteams im Gerät und im Profil).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const EL_URL = `${SUPABASE_URL}/functions/v1/euroleague`, FB_URL = `${SUPABASE_URL}/functions/v1/fussball`;
const HEAD = { apikey: SUPABASE_ANON_KEY };
const LIVE_POLL_MS = 60 * 1000, IDLE_POLL_MS = 10 * 60 * 1000;
const TODAY_MAX = 8, FEED_MAX = 6, RECENT_MS = 30 * 60 * 1000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};
const readList = (k) => { try { const v = JSON.parse(store.get(k, 'null')); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
// Ohne Profil zur Anmeldung im Basketball-Bereich, danach zurück hierher (el-next)
if (!store.get('el-profile-name', '')) { try { sessionStorage.setItem('el-next', location.pathname); } catch { /* privates Fenster */ } location.replace('../'); }

let elFav = readList('el-fav-teams'), fbFav = readList('el-fb-fav2');
let el = null, fb = null, elFailed = false, fbFailed = false;
const flows = new Map(); // Spielcode → Spielverlauf der laufenden Basketball-Spiele, für den Feed
const show = { today: false };
const lastFlaps = new Map(); // letzter Stand pro Spiel: geänderte Blätter klappen um, wie in den Bereichen

const zone = (d, o) => Object.fromEntries(new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', ...o }).formatToParts(d).map((p) => [p.type, p.value]));
const dayKey = (ms) => { const o = zone(new Date(ms), { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${o.year}-${o.month}-${o.day}`; };
const hhmm = (ms) => { const o = zone(new Date(ms), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); return `${o.hour}:${o.minute}`; };
function whenText(ms) {
  const d = dayKey(ms), now = Date.now();
  if (d === dayKey(now)) return `Heute ${hhmm(ms)}`;
  if (d === dayKey(now + 864e5)) return `Morgen ${hhmm(ms)}`;
  const w = zone(new Date(ms), { weekday: 'short' }).weekday?.replace('.', '') || '';
  return ms - now < 6 * 864e5 ? `${w} ${hhmm(ms)}` : `${w} ${Number(d.slice(8))}.${Number(d.slice(5, 7))}. ${hhmm(ms)}`;
}

function bkLabel(g) {
  const n = Number((/\d+/.exec(g.period || '') || [])[0]);
  const part = n >= 1 && n <= 4 ? `${n}. Viertel` : n > 4 ? 'Verlängerung' : '';
  const clock = /^\d{1,2}:\d\d$/.test(g.clock || '') && g.clock !== '00:00' ? g.clock.replace(/^0(?=\d:)/, '') : '';
  if (part && g.clock === '00:00') return n === 2 ? 'Halbzeit' : `Ende ${n}. Viertel`;
  if (!part && g.clock === '00:00') return 'Pause';
  return [part, clock].filter(Boolean).join(' · ') || 'Live';
}

// Beide Sportarten in dieselbe Form bringen
function games() {
  const list = [];
  const t = el?.teams || {};
  for (const g of el?.games || []) {
    const at = Date.parse(g.utc), st = g.status === 'final' ? 'ft' : g.status;
    list.push({ sport: 'b', id: g.code, at, st, h: t[g.home]?.short || g.home, a: t[g.away]?.short || g.away, hl: t[g.home]?.crest, al: t[g.away]?.crest, hk: g.home, ak: g.away,
      hs: g.hs, as: g.as, period: g.period, clock: g.clock, round: g.round, label: st === 'live' ? bkLabel(g) : '', lg: 'EuroLeague', href: `../?game=${g.code}`, fav: elFav.includes(g.home) || elFav.includes(g.away) });
  }
  const names = new Set(fbFav.map((n) => n.toLowerCase())), lg = new Map((fb?.leagues || []).map((l) => [l.id, l.name]));
  for (const m of fb?.matches || []) {
    if (m.st === 'off') continue;
    const st = m.st === 'ht' ? 'live' : m.st;
    list.push({ sport: 'f', id: m.id, at: Date.parse(m.utc), st, h: m.h, a: m.a, hl: m.hl, al: m.al, hk: m.h, ak: m.a, hs: m.hs, as: m.as, goals: m.goals, min: m.min,
      label: m.st === 'ht' ? 'Halbzeit' : m.min ? `${m.min}. Minute` : 'Läuft', lg: lg.get(m.l) || '', href: `../fussball/?m=${encodeURIComponent(m.id)}`, fav: names.has(m.h.toLowerCase()) || names.has(m.a.toLowerCase()) });
  }
  return list.sort((x, y) => x.at - y.at);
}

const crest = (u, cls = '') => (u ? `<img class="ms-logo ${cls}" src="${esc(u)}" alt="" loading="lazy">` : `<span class="ms-logo none ${cls}"></span>`);
function rowHtml(g) {
  const score = g.st === 'ft' && g.hs != null;
  const side = (n, u, s) => `<span class="tm">${crest(u)}<b>${esc(n)}</b>${score ? `<em class="num">${s}</em>` : ''}</span>`;
  return `<a class="ms-row ${g.sport}${g.fav ? ' fav' : ''}" href="${esc(g.href)}"><span class="t num">${g.st === 'ft' ? 'Ende' : hhmm(g.at)}</span>${side(g.h, g.hl, g.hs)}${side(g.a, g.al, g.as)}<span class="lg">${esc(g.lg)}</span></a>`;
}
// Fallblatt-Tafel wie auf den Seiten Basketball und Fussball; die ganze Tafel führt zum Spiel
function liveCard(g) {
  const bk = g.sport === 'b';
  const n = Number((/\d+/.exec(g.period || '') || [])[0]);
  const running = bk && n >= 1 && /^\d{1,2}:\d\d$/.test(g.clock || '') && g.clock !== '00:00';
  const state = running ? (n > 4 ? 'Verlängerung' : `${n}. Viertel`) : g.label;
  const clock = running ? g.clock.replace(/^0(?=\d:)/, '') : '';
  const hs = bk ? String(g.hs ?? 0).padStart(3, ' ') : String(g.hs ?? 0), as = bk ? String(g.as ?? 0).padStart(3, ' ') : String(g.as ?? 0);
  const key = `${g.sport}${g.id}`, chars = [...hs, ...as, ...clock], before = lastFlaps.get(key) || [];
  lastFlaps.set(key, chars);
  let i = 0;
  const tiles = (str) => `<span class="flaps">${[...str].map((ch) => {
    const flip = before.length && before[i] !== ch; i += 1;
    return `<span class="flap${ch === ':' ? ' sep' : ''}${flip ? ' flip' : ''}">${ch === ' ' ? '' : esc(ch)}</span>`;
  }).join('')}</span>`;
  const last = (g.goals || []).at(-1);
  const goal = last ? `Tor ${last.n || (last.s === 1 ? g.h : g.a)}${last.m !== '' ? ` ${last.m}'` : ''}` : '';
  const row1 = `<span class="flap-row">${crest(g.hl, 'flag')}<span class="flap-name">${esc(g.h)}</span>${tiles(hs)}</span>`;
  const row2 = `<span class="flap-row">${crest(g.al, 'flag')}<span class="flap-name">${esc(g.a)}</span>${tiles(as)}</span>`;
  return `<a class="live-hero ${g.sport}" href="${esc(g.href)}" aria-label="${esc(`${g.h} ${g.hs ?? 0}, ${g.a} ${g.as ?? 0}, ${state}`)}">${row1}${row2}
    <span class="flap-bar"><span class="flap-q"><i class="live-dot" aria-hidden="true"></i>${esc(state)}<span class="flap-round">&nbsp;· ${esc(bk ? `Spieltag ${g.round}` : g.lg)}</span>${g.fav ? '<span class="ms-fv" title="Dein Team">★</span>' : ''}</span>
      <span class="flap-clock">${goal ? `<span class="ms-goal">${esc(goal)}</span>` : ''}${clock ? tiles(clock) : ''}<span class="flap-more" aria-hidden="true">›</span></span></span></a>`;
}

// Feed: Tore laufender Fussballspiele, Läufe und Viertelenden laufender Basketballspiele, Endstände der letzten halben Stunde.
// Die Zeit ist nur für die Reihenfolge geschätzt: die Quellen nennen Spielminuten, keine Uhrzeiten.
function feedItems(list) {
  const out = [], now = Date.now();
  const recent = (g) => g.st === 'ft' && now - g.at < 3.5 * 3600e3 && now - endsAt(g) < RECENT_MS;
  for (const g of list.filter((x) => x.st === 'live' || recent(x))) {
    if (g.sport === 'f') {
      let h = 0, a = 0;
      for (const x of g.goals || []) {
        if (x.s === 1) h++; else a++;
        const min = parseInt(x.m, 10) || 0;
        out.push({ at: g.at + (min + (min > 45 ? 15 : 0)) * 60e3, sport: 'f', tag: `${x.m}'`, html: `<b>Tor für ${esc(x.s === 1 ? g.h : g.a)}</b> · ${esc(g.h)} ${h}:${a} ${esc(g.a)}` });
      }
    } else {
      const f = flows.get(g.id);
      for (const r of f?.runs || []) {
        const own = r.s > 0 ? r.ra : r.rb, opp = r.s > 0 ? r.rb : r.ra;
        out.push({ at: g.at + r.t1 * 3000, sport: 'b', tag: quarterTag(r.t1), html: `<b>${own}:${opp}-Lauf von ${esc(r.s > 0 ? g.h : g.a)}</b> · ${r.to[0]}:${r.to[1]}` });
      }
      for (const [q, name] of [[600, '1. Viertel'], [1200, 'Halbzeit'], [1800, '3. Viertel']]) {
        const last = f?.ev?.filter((e) => e[0] <= q).at(-1);
        if (last && f.ev.at(-1)[0] > q) out.push({ at: g.at + q * 3000, sport: 'b', tag: quarterTag(q - 1), html: `${name === 'Halbzeit' ? 'Halbzeit' : `Ende ${name}`} · ${esc(g.h)} ${last[1]}:${last[2]} ${esc(g.a)}` });
      }
    }
    if (g.st === 'ft') out.push({ at: endsAt(g), sport: g.sport, tag: 'Ende', html: `<b>Endstand</b> · ${esc(g.h)} ${g.hs}:${g.as} ${esc(g.a)}` });
  }
  return out.sort((x, y) => y.at - x.at).slice(0, FEED_MAX);
}
const endsAt = (g) => g.at + (g.sport === 'f' ? 115 : 125) * 60e3;
const quarterTag = (t) => (t >= 2400 ? 'V' : `Q${Math.floor(t / 600) + 1}`);

// Karte pro Lieblingsteam: laufendes oder nächstes Spiel, sonst das letzte
function teamCards(list) {
  const cards = [];
  const add = (sport, key, name, logo, mine) => {
    const done = mine.filter((g) => g.st === 'ft' && g.hs != null), live = mine.find((g) => g.st === 'live'), next = mine.find((g) => g.st === 'pre' && g.at > Date.now());
    const home = (g) => g.hk === key || g.h === key, us = (g) => (home(g) ? g.hs : g.as), them = (g) => (home(g) ? g.as : g.hs), opp = (g) => (home(g) ? g.a : g.h);
    const form = done.slice(-5).map((g) => (us(g) > them(g) ? 'w' : us(g) < them(g) ? 'l' : 'd'));
    const shown = live || next || done.at(-1);
    if (!shown) return;
    const href = sport === 'b' ? `../?team=${encodeURIComponent(key)}` : shown.href;
    const sub = `${home(shown) ? 'gegen' : 'bei'} ${opp(shown)}`;
    cards.push({ rank: live ? 0 : next ? next.at : Infinity, html: `<a class="ms-tc ${sport}${live ? ' on' : ''}" href="${esc(href)}"><div class="th">${crest(logo, 'lg')}<div><b>${esc(name)}</b><span class="ms-form" aria-hidden="true">${form.map((x) => `<i class="${x}"></i>`).join('')}</span></div></div>
      <span class="k">${live ? '<i class="ms-dot"></i>Live' : next ? 'Nächstes' : 'Zuletzt'}</span><span class="v num">${live ? `${us(live) ?? 0}:${them(live) ?? 0}` : next ? esc(whenText(next.at)) : `${us(shown)}:${them(shown)}`}</span><span class="s">${esc(sub)}</span></a>` });
  };
  for (const c of elFav) add('b', c, el?.teams?.[c]?.short || c, el?.teams?.[c]?.crest, list.filter((g) => g.sport === 'b' && (g.hk === c || g.ak === c)));
  for (const n of fbFav) {
    const k = n.toLowerCase(), mine = list.filter((g) => g.sport === 'f' && (g.h.toLowerCase() === k || g.a.toLowerCase() === k));
    const g0 = mine[0];
    add('f', g0 ? (g0.h.toLowerCase() === k ? g0.h : g0.a) : n, n, g0 ? (g0.h.toLowerCase() === k ? g0.hl : g0.al) : '', mine);
  }
  return cards.sort((x, y) => x.rank - y.rank).map((c) => c.html).join('');
}

function render() {
  const list = games(), now = Date.now(), today = dayKey(now);
  const live = list.filter((g) => g.st === 'live').sort((x, y) => y.fav - x.fav || (x.sport === 'b' ? -1 : 0) - (y.sport === 'b' ? -1 : 0) || x.at - y.at);
  const pill = $('#msPill');
  pill.hidden = !live.length;
  pill.innerHTML = live.length ? `<i class="ms-dot"></i>${live.length} live` : '';
  $('#msDate').textContent = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  const feed = feedItems(list);
  const liveHtml = live.length ? `<section class="ms-live" aria-label="Live-Spiele"><div class="ms-live-h"><b><i class="live-dot" aria-hidden="true"></i>Live</b><small>${live.length} ${live.length === 1 ? 'Spiel' : 'Spiele'}</small></div>
    <div class="hero-scroll${live.length > 1 ? ' multi' : ''}" data-keep="live">${live.map(liveCard).join('')}</div>
    ${feed.length ? `<div class="ms-feedbox"><h3>Live-Feed</h3><ul class="ms-feed">${feed.map((f) => `<li class="${f.sport}"><span class="num">${esc(f.tag)}</span><p>${f.html}</p></li>`).join('')}</ul></div>` : ''}</section>` : '';

  const cards = teamCards(list);
  const teamsHtml = `<h2 class="ms-h">Deine Teams</h2>${cards ? `<div class="ms-teams" data-keep="teams">${cards}</div>` : '<p class="ms-note">Noch keine Teams gewählt. Tippe unten auf «Ich».</p>'}`;

  // Heute, oder der nächste Tag mit Spielen
  const open = list.filter((g) => g.st !== 'live');
  let day = today, rows = open.filter((g) => dayKey(g.at) === today);
  if (!rows.length) { const nx = open.find((g) => g.st === 'pre' && g.at > now); if (nx) { day = dayKey(nx.at); rows = open.filter((g) => dayKey(g.at) === day); } }
  rows = [...rows].sort((x, y) => (x.st === 'ft') - (y.st === 'ft') || y.fav - x.fav || x.at - y.at);
  const shown = show.today ? rows : rows.slice(0, TODAY_MAX);
  const title = day === today ? 'Heute' : whenText(rows[0]?.at ?? now).replace(/ \d\d:\d\d$/, '');
  const todayHtml = `<h2 class="ms-h">${esc(title)}</h2>${rows.length ? `<div class="ms-list">${shown.map(rowHtml).join('')}</div>` : '<p class="ms-note">Keine Spiele.</p>'}
    ${rows.length > TODAY_MAX ? `<button type="button" class="ms-more" data-act="more-today">${show.today ? 'Weniger zeigen' : `Alle ${rows.length} Spiele`}</button>` : ''}`;

  const fails = [elFailed && 'Basketball', fbFailed && 'Fussball'].filter(Boolean);
  const note = fails.length ? `<p class="ms-note">${fails.join(' und ')} gerade nicht erreichbar, angezeigt wird der letzte Stand.</p>` : '';
  const main = $('#msMain');
  const keep = [...main.querySelectorAll('[data-keep]')].map((n) => [n.dataset.keep, n.scrollLeft]);
  main.classList.toggle('solo', !live.length);
  main.innerHTML = live.length ? `<div class="ms-col">${liveHtml}</div><div class="ms-col">${note}${teamsHtml}${todayHtml}</div>` : `<div class="ms-col">${note}${teamsHtml}${todayHtml}</div>`;
  for (const [k, x] of keep) { const n = main.querySelector(`[data-keep="${k}"]`); if (n) n.scrollLeft = x; }
}

const getJson = async (url, ms) => {
  const res = await fetch(url, { headers: HEAD, cache: 'no-store', signal: AbortSignal.timeout(ms) });
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) throw new Error(`Fehler ${res.status}`);
  return d;
};
async function loadFlows() {
  const now = Date.now();
  const need = (el?.games || []).filter((g) => g.status === 'live' || (g.status === 'final' && now - Date.parse(g.utc) < 3 * 3600e3));
  await Promise.all(need.map(async (g) => { const d = await getJson(`${EL_URL}?game=${g.code}`, 15000).catch(() => null); if (d?.flow) flows.set(g.code, d.flow); }));
}
let timer = 0;
async function refresh() {
  clearTimeout(timer);
  const [a, b] = await Promise.allSettled([getJson(EL_URL, 20000), getJson(`${FB_URL}?fb=1`, 30000)]);
  if (a.status === 'fulfilled' && Array.isArray(a.value.games)) { el = a.value; elFailed = false; } else elFailed = true;
  if (b.status === 'fulfilled' && Array.isArray(b.value.matches)) { fb = b.value; fbFailed = false; } else fbFailed = true;
  render();
  await loadFlows();
  render();
  const now = Date.now();
  const soon = games().some((g) => g.st === 'live' || (g.st === 'pre' && Math.abs(g.at - now) < 20 * 60 * 1000));
  timer = setTimeout(refresh, soon ? LIVE_POLL_MS : IDLE_POLL_MS);
}

// Lieblingsteams vom Profil holen, falls sie auf einem anderen Gerät geändert wurden
async function syncProfile() {
  const name = store.get('el-profile-name', ''), pin = store.get('el-profile-pin', '');
  if (!name || !pin) return;
  try {
    const res = await fetch(EL_URL, { method: 'POST', headers: { ...HEAD, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'profile-login', name, pin }), signal: AbortSignal.timeout(10000) });
    const d = await res.json().catch(() => null);
    if (!d?.ok) return;
    if (Array.isArray(d.favorites)) { elFav = d.favorites.map(String); store.set('el-fav-teams', JSON.stringify(elFav)); }
    if (Array.isArray(d.fbFavorites)) { fbFav = d.fbFavorites.map(String); store.set('el-fb-fav2', JSON.stringify(fbFav)); }
    if (el || fb) render();
  } catch { /* ohne Netz bleibt die lokale Kopie */ }
}

function openMe() {
  const dlg = $('#msMe');
  dlg.innerHTML = `<h2 id="msMeT">${esc(store.get('el-profile-name', 'Profil'))}</h2><p>Deine Teams gelten für Basketball und Fussball.</p>
    <a href="../?fav=1">Basketball-Teams wählen</a><a href="../fussball/?fav=1">Fussball-Teams wählen</a>
    <button type="button" data-act="theme">Hell oder dunkel</button><button type="button" class="x" data-act="me-close">Schliessen</button>`;
  dlg.showModal();
}
function toggleTheme() {
  const r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  r.dataset.theme = next; store.set('el-theme', next);
}
document.addEventListener('click', (e) => {
  const act = e.target.closest?.('[data-act]')?.dataset.act;
  if (act === 'me') openMe();
  else if (act === 'me-close') $('#msMe').close();
  else if (act === 'theme') toggleTheme();
  else if (act === 'more-today') { show.today = !show.today; render(); }
  else if (e.target === $('#msMe')) $('#msMe').close();
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});

syncProfile();
refresh();
