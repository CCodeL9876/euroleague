// Mein Sport: gemeinsame Startseite. Liest dieselben Daten wie die Bereiche Basketball und Fussball und führt für Details
// dorthin (basketball/euroleague/?game=, ?team=, fussball/?m=). Zugang und Profil wie dort (gate.js, Lieblingsteams im Gerät und im Profil).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { tvOf } from '../fussball/tv.js';

const EL_URL = `${SUPABASE_URL}/functions/v1/euroleague`, FB_URL = `${SUPABASE_URL}/functions/v1/fussball`;
const HEAD = { apikey: SUPABASE_ANON_KEY };
const LIVE_POLL_MS = 60 * 1000, IDLE_POLL_MS = 10 * 60 * 1000;
const TODAY_MAX = 8, MISSED_MAX = 6, MISSED_DAYS = 7, FIRST_DAYS = 3, FEED_MAX = 8, FEED_ALL = 40, RECENT_MS = 30 * 60 * 1000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};
const readList = (k) => { try { const v = JSON.parse(store.get(k, 'null')); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
try { sessionStorage.setItem('el-started', '1'); } catch { /* privates Fenster */ } // siehe start-boot.js
// Ohne Profil zur Anmeldung im Basketball-Bereich, danach zurück hierher (el-next)
const leaving = !store.get('el-profile-name', '');
if (leaving) { try { sessionStorage.setItem('el-next', location.pathname); } catch { /* privates Fenster */ } location.replace('basketball/euroleague/'); }

let elFav = readList('el-fav-teams'), fbFav = readList('el-fb-fav2');
let el = null, fb = null, elFailed = false, fbFailed = false;
const flows = new Map(); // Spielcode → Spielverlauf der laufenden Basketball-Spiele, für den Feed
const show = { today: false, feed: false };
// Tore, die die Seite selbst am Spielstand erkennt: für Ligen, deren Quelle während des Spiels keine Torschützen liefert.
// Pro Sitzung gemerkt, damit sie nach dem Herunterziehen oder Zurückkehren nicht verschwinden.
const readSession = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || '{}') || {}; } catch { return {}; } };
const lastScore = readSession('el-ms-score'), seenGoals = readSession('el-ms-goals');
function trackGoals() {
  const now = Date.now();
  for (const m of fb?.matches || []) {
    if (!['live', 'ht', 'ft'].includes(m.st) || m.hs == null || m.as == null) continue;
    const prev = lastScore[m.id];
    if (prev) {
      // Mehrere Tore zwischen zwei Abrufen: in der Reihenfolge des Stands, das letzte zuoberst im Feed
      let k = 0;
      for (let n = prev[0]; n < m.hs; n++) (seenGoals[m.id] ||= []).push({ at: now + k++, s: 1, m: m.min ?? '', score: [n + 1, prev[1]] });
      for (let n = prev[1]; n < m.as; n++) (seenGoals[m.id] ||= []).push({ at: now + k++, s: 2, m: m.min ?? '', score: [m.hs, n + 1] });
    }
    lastScore[m.id] = [m.hs, m.as];
  }
  try { sessionStorage.setItem('el-ms-score', JSON.stringify(lastScore)); sessionStorage.setItem('el-ms-goals', JSON.stringify(seenGoals)); } catch { /* privates Fenster */ }
}
let editTeams = false; // × auf den Teamkarten sichtbar
const EL_FAV_MAX = 14, FB_FAV_MAX = 40, PICK_MAX = 12;
// Verpasste Resultate: gesehene Spiele bleiben im Gerät gespeichert. Beim allerersten Besuch zählen nur die letzten Tage.
// Der Stand hängt am Profil (Spalte ms_state); lokal bleibt pro Profil eine Kopie für den schnellen Start und ohne Netz.
const msKey = (k) => `el-ms-${k}:${store.get('el-profile-name', '').toLowerCase()}`;
const seen = new Set(readList(msKey('seen')));
const revealed = new Set(); // in dieser Sitzung aufgedeckt: bleibt bis zum nächsten Öffnen sichtbar
let since = Number(store.get(msKey('since'), '0'));
if (!since) { since = Date.now() - FIRST_DAYS * 864e5; store.set(msKey('since'), String(since)); }
const spoilerOn = () => store.get(msKey('spoiler'), '1') !== '0';
let lastSent = '';
function saveSeen(leaving = false) {
  const list = [...seen].slice(-300);
  store.set(msKey('seen'), JSON.stringify(list));
  const msState = { seen: list, since, spoiler: spoilerOn() }, text = JSON.stringify(msState);
  const name = store.get('el-profile-name', ''), pin = store.get('el-profile-pin', '');
  if (text === lastSent || !name || !pin) return;
  lastSent = text;
  // keepalive: die Anfrage läuft auch noch, wenn die Seite gerade geschlossen wird
  fetch(EL_URL, { method: 'POST', keepalive: leaving, headers: { ...HEAD, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'profile-mssave', name, pin, msState }) }).catch(() => { lastSent = ''; });
}
const gkey = (g) => `${g.sport}${g.id}`;
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
      hs: g.hs, as: g.as, period: g.period, clock: g.clock, round: g.round, label: st === 'live' ? bkLabel(g) : '', lg: 'EuroLeague', href: `basketball/euroleague/?game=${g.code}`, fav: elFav.includes(g.home) || elFav.includes(g.away) });
  }
  const names = new Set(fbFav.map((n) => n.toLowerCase())), lg = new Map((fb?.leagues || []).map((l) => [l.id, l.name]));
  for (const m of fb?.matches || []) {
    if (m.st === 'off') continue;
    const st = m.st === 'ht' ? 'live' : m.st;
    list.push({ sport: 'f', id: m.id, l: m.l, utc: m.utc, at: Date.parse(m.utc), st, h: m.h, a: m.a, hl: m.hl, al: m.al, hk: m.h, ak: m.a, hs: m.hs, as: m.as, goals: m.goals, min: m.min,
      label: m.st === 'ht' ? 'Halbzeit' : m.min ? `${m.min}. Minute` : 'Läuft', lg: lg.get(m.l) || '', href: `fussball/?m=${encodeURIComponent(m.id)}`, fav: names.has(m.h.toLowerCase()) || names.has(m.a.toLowerCase()) });
  }
  return list.sort((x, y) => x.at - y.at);
}

const crest = (u, cls = '') => (u ? `<img class="ms-logo ${cls}" src="${esc(u)}" alt="" loading="lazy">` : `<span class="ms-logo none ${cls}"></span>`);
const TV_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M9 2l3 4 3-4"/></svg>';
const tvText = (g) => (g.sport === 'f' && g.st !== 'ft' ? tvOf({ l: g.l, utc: g.utc, h: g.h, a: g.a }).ch : '');
const tvTag = (g) => { const t = tvText(g); return t ? ` · <span class="ms-tv">${TV_ICON}${esc(t)}</span>` : ''; };
function rowHtml(g) {
  const score = g.st === 'ft' && g.hs != null && !hidden(g);
  const side = (n, u, s) => `<span class="tm">${crest(u)}<b>${esc(n)}</b>${score ? `<em class="num">${s}</em>` : ''}</span>`;
  return `<a class="ms-row ${g.sport}${g.fav ? ' fav' : ''}" href="${esc(g.href)}"><span class="t num">${g.st === 'ft' ? 'Ende' : hhmm(g.at)}</span>${side(g.h, g.hl, g.hs)}${side(g.a, g.al, g.as)}<span class="lg">${esc(g.lg)}${tvTag(g)}</span></a>`;
}

// Spiel deiner Teams, dessen Resultat du noch nicht gesehen hast
const missed = (g) => g.fav && g.st === 'ft' && g.hs != null && g.at > since && g.at > Date.now() - MISSED_DAYS * 864e5 && !seen.has(gkey(g));
const hidden = (g) => spoilerOn() && missed(g) && !revealed.has(gkey(g));

const favSide = (g) => (g.sport === 'b' ? [elFav.includes(g.hk), elFav.includes(g.ak)] : [fbFav.some((n) => n.toLowerCase() === g.h.toLowerCase()), fbFav.some((n) => n.toLowerCase() === g.a.toLowerCase())]);
const nextGame = (list, live) => (live.some((g) => g.fav) ? null : list.find((x) => x.fav && x.st === 'pre' && x.at > Date.now()));
function nextHtml(list, live) {
  const g = nextGame(list, live);
  if (!g) return '';
  const [fh, fa] = favSide(g), mins = Math.max(1, Math.round((g.at - Date.now()) / 60000));
  const left = mins < 60 ? `in ${mins} Min.` : mins < 36 * 60 ? `in ${Math.round(mins / 60)} Std.` : `in ${Math.round(mins / 1440)} Tagen`;
  const title = fh ? `${g.h} gegen ${g.a}` : `${g.a} bei ${g.h}`;
  return `<a class="ms-next" href="${esc(g.href)}"><span class="k">Als Nächstes</span><span class="r">${crest(fh || !fa ? g.hl : g.al, 'lg')}<span class="n"><b>${esc(title)}</b><small>${esc(whenText(g.at))} · ${esc(g.lg)}${tvTag(g)}</small></span><span class="cd num">${left}</span></span></a>`;
}
function missedHtml(list) {
  const rows = list.filter(missed).reverse().slice(0, MISSED_MAX);
  if (!rows.length) return '';
  const off = !spoilerOn();
  const item = (g) => {
    const [fh, fa] = favSide(g), home = fh, both = fh && fa, k = gkey(g);
    const title = both ? `${g.h} – ${g.a}` : home ? g.h : g.a;
    const wd = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', weekday: 'short' }).format(new Date(g.at)).replace('.', '');
    const sub = both ? `${g.lg} · ${wd}` : `${home ? 'gegen' : 'bei'} ${home ? g.a : g.h} · ${wd}`;
    const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
    const res = us > them ? ['w', 'S'] : us < them ? ['l', 'N'] : ['d', 'U'];
    const show = off || revealed.has(k);
    return `<div class="ms-res">${crest(fh || !fa ? g.hl : g.al)}<span class="n"><b>${esc(title)}</b><small>${esc(sub)}</small></span>${show ? `${both ? '' : `<i class="${res[0]}">${res[1]}</i>`}<strong class="num">${both ? `${g.hs}:${g.as}` : `${us}:${them}`}</strong>` : `<button type="button" class="ms-show" data-act="reveal" data-k="${esc(k)}" aria-label="Resultat von ${esc(title)} zeigen">Zeigen</button>`}</div>`;
  };
  return `<section class="ms-missed" aria-label="Seit deinem letzten Besuch"><div class="h"><b>Seit deinem letzten Besuch</b>${off ? '' : '<span>Spoilerschutz an</span>'}</div>${rows.map(item).join('')}</section>`;
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
  for (const g of list.filter((x) => x.st === 'live' || (recent(x) && !hidden(x)))) {
    if (g.sport === 'f') {
      let h = 0, a = 0;
      for (const x of g.goals || []) {
        if (x.s === 1) h++; else a++;
        const min = parseInt(x.m, 10) || 0;
        out.push({ at: g.at + (min + (min > 45 ? 15 : 0)) * 60e3, sport: 'f', tag: `${x.m}'`, html: `<b>Tor für ${esc(x.s === 1 ? g.h : g.a)}</b>${x.n ? ` · ${esc(x.n)}` : ''} · ${esc(g.h)} ${h}:${a} ${esc(g.a)}` });
      }
      // Ohne Torschützen von der Quelle: die selbst erkannten Tore (nur die, die über die gelieferten hinausgehen)
      const own = (seenGoals[g.id] || []).filter((x) => x.score[0] + x.score[1] > (g.goals || []).length);
      for (const x of own) out.push({ at: x.at, sport: 'f', tag: x.m !== '' ? `${x.m}'` : 'Tor', html: `<b>Tor für ${esc(x.s === 1 ? g.h : g.a)}</b> · ${esc(g.h)} ${x.score[0]}:${x.score[1]} ${esc(g.a)}` });
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
  return out.sort((x, y) => y.at - x.at).slice(0, FEED_ALL);
}
const endsAt = (g) => g.at + (g.sport === 'f' ? 115 : 125) * 60e3;
const quarterTag = (t) => (t >= 2400 ? 'V' : `Q${Math.floor(t / 600) + 1}`);

// Karte pro Lieblingsteam: laufendes oder nächstes Spiel, sonst das letzte
function teamCards(list, skip) {
  const cards = [];
  const add = (sport, key, name, logo, mine) => {
    const done = mine.filter((g) => g.st === 'ft' && g.hs != null), live = mine.find((g) => g.st === 'live'), next = mine.find((g) => g.st === 'pre' && g.at > Date.now());
    const home = (g) => g.hk === key || g.h === key, us = (g) => (home(g) ? g.hs : g.as), them = (g) => (home(g) ? g.as : g.hs), opp = (g) => (home(g) ? g.a : g.h);
    const form = done.filter((g) => !hidden(g)).slice(-5).map((g) => (us(g) > them(g) ? 'w' : us(g) < them(g) ? 'l' : 'd'));
    const shown = live || next || done.filter((g) => !hidden(g)).at(-1);
    const href = sport === 'b' ? `basketball/euroleague/?team=${encodeURIComponent(key)}` : shown?.href || 'fussball/';
    const sub = shown ? `${home(shown) ? 'gegen' : 'bei'} ${opp(shown)}` : 'im Moment kein Spiel geplant';
    const x = editTeams ? `<button type="button" class="ms-x" data-act="team-x" data-s="${sport}" data-k="${esc(key)}" aria-label="${esc(name)} entfernen">×</button>` : '';
    cards.push({ dup: !!skip && next === skip, rank: live ? 0 : next ? next.at : Infinity, html: `<div class="ms-tcw"><a class="ms-tc ${sport}${live ? ' on' : ''}" href="${esc(href)}"><div class="th">${crest(logo, 'lg')}<div><b>${esc(name)}</b><span class="ms-form" aria-hidden="true">${form.map((x) => `<i class="${x}"></i>`).join('')}</span></div></div>
      <span class="k">${live ? '<i class="ms-dot"></i>Live' : next ? 'Nächstes' : shown ? 'Zuletzt' : 'Spielplan'}</span><span class="v num">${live ? `${us(live) ?? 0}:${them(live) ?? 0}` : next ? esc(whenText(next.at)) : shown ? `${us(shown)}:${them(shown)}` : '–'}</span><span class="s">${esc(sub)}</span></a>${x}</div>` });
  };
  for (const c of elFav) add('b', c, el?.teams?.[c]?.short || c, el?.teams?.[c]?.crest, list.filter((g) => g.sport === 'b' && (g.hk === c || g.ak === c)));
  for (const n of fbFav) {
    const k = n.toLowerCase(), mine = list.filter((g) => g.sport === 'f' && (g.h.toLowerCase() === k || g.a.toLowerCase() === k));
    const g0 = mine[0];
    add('f', g0 ? (g0.h.toLowerCase() === k ? g0.h : g0.a) : n, n, g0 ? (g0.h.toLowerCase() === k ? g0.hl : g0.al) : '', mine);
  }
  // Teams, die oben schon unter «Als Nächstes» stehen, nicht doppelt zeigen (im Bearbeiten-Modus und wenn sonst nichts bliebe: alle)
  const rest = cards.filter((c) => !c.dup);
  return (editTeams || !rest.length ? cards : rest).sort((x, y) => x.rank - y.rank).map((c) => c.html).join('');
}

function render() {
  const list = games(), now = Date.now(), today = dayKey(now);
  const live = list.filter((g) => g.st === 'live').sort((x, y) => y.fav - x.fav || (x.sport === 'b' ? -1 : 0) - (y.sport === 'b' ? -1 : 0) || x.at - y.at);
  const pill = $('#msPill');
  pill.hidden = !live.length;
  pill.innerHTML = live.length ? `<i class="ms-dot"></i>${live.length} live` : '';
  $('#msDate').textContent = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  // Live gesehene Spiele deiner Teams brauchen keinen Spoilerschutz mehr
  let added = false;
  for (const g of live) if (g.fav && !seen.has(gkey(g))) { seen.add(gkey(g)); added = true; }
  if (added) saveSeen();
  const feed = feedItems(list);
  const liveHtml = live.length ? `<section class="ms-live" aria-label="Live-Spiele"><div class="ms-live-h"><b><i class="live-dot" aria-hidden="true"></i>Live</b><small>${live.length} ${live.length === 1 ? 'Spiel' : 'Spiele'}</small></div>
    <div class="hero-scroll${live.length > 1 ? ' multi' : ''}" data-keep="live">${live.map(liveCard).join('')}</div>
    ${feed.length ? `<div class="ms-feedbox"><h3>Live-Feed</h3><ul class="ms-feed">${(show.feed ? feed : feed.slice(0, FEED_MAX)).map((f) => `<li class="${f.sport}"><span class="num">${esc(f.tag)}</span><p>${f.html}</p></li>`).join('')}</ul>
      ${feed.length > FEED_MAX ? `<button type="button" class="ms-more" data-act="more-feed">${show.feed ? 'Weniger zeigen' : `Alle ${feed.length} Ereignisse`}</button>` : ''}</div>` : ''}</section>` : '';

  const topHtml = `${nextHtml(list, live)}${missedHtml(list)}`;
  const cards = teamCards(list, nextGame(list, live));
  const teamsHtml = `<div class="ms-hrow"><h2 class="ms-h">Deine Teams</h2>${cards ? `<button type="button" class="ms-edit" data-act="edit-teams" aria-pressed="${editTeams}">${editTeams ? 'Fertig' : 'Bearbeiten'}</button>` : ''}</div>
    <div class="ms-teams" data-keep="teams">${cards}<button type="button" class="ms-add" data-act="add-team" aria-haspopup="dialog"><b aria-hidden="true">+</b>Team hinzufügen</button></div>`;

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
  main.innerHTML = live.length ? `<div class="ms-col">${liveHtml}</div><div class="ms-col">${note}${topHtml}${teamsHtml}${todayHtml}</div>` : `<div class="ms-col">${note}${topHtml}${teamsHtml}${todayHtml}</div>`;
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
let timer = 0, running = null;
function refresh() {
  if (!running) running = load().finally(() => { running = null; });
  return running;
}
async function load() {
  clearTimeout(timer);
  const [a, b] = await Promise.allSettled([getJson(EL_URL, 20000), getJson(`${FB_URL}?fb=1`, 30000)]);
  if (a.status === 'fulfilled' && Array.isArray(a.value.games)) { el = a.value; elFailed = false; } else elFailed = true;
  if (b.status === 'fulfilled' && Array.isArray(b.value.matches)) { fb = b.value; fbFailed = false; trackGoals(); } else fbFailed = true;
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
    if (d.msState) {
      for (const k of d.msState.seen || []) seen.add(String(k));
      if (Number(d.msState.since) > 0) { since = Number(d.msState.since); store.set(msKey('since'), String(since)); }
      store.set(msKey('spoiler'), d.msState.spoiler === false ? '0' : '1');
    }
    saveSeen();
    if (el || fb) render();
  } catch { /* ohne Netz bleibt die lokale Kopie */ }
}

// ---------- Teamwahl ----------
const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function catalog() {
  const list = Object.entries(el?.teams || {}).map(([k, t]) => ({ s: 'b', k, n: t.short || k, logo: t.crest, lg: 'EuroLeague' }));
  const lg = new Map((fb?.leagues || []).map((l) => [l.id, l.name])), byName = new Map();
  for (const m of fb?.matches || []) {
    for (const [n, logo] of [[m.h, m.hl], [m.a, m.al]]) {
      const old = byName.get(n);
      // Liga vor Champions League, damit der Verein unter seiner Liga steht
      if (!old || (old.l === 'ucl' && m.l !== 'ucl')) byName.set(n, { s: 'f', k: n, n, logo: logo || old?.logo, lg: lg.get(m.l) || '', l: m.l });
    }
  }
  return [...list, ...byName.values()].sort((a, b) => a.n.localeCompare(b.n, 'de'));
}
const isFavTeam = (t) => (t.s === 'b' ? elFav.includes(t.k) : fbFav.some((n) => n.toLowerCase() === t.k.toLowerCase()));
let saveTimer = 0;
const dirty = new Set(); // Sportarten mit ungespeicherten Änderungen
function saveFavs(sport) {
  store.set('el-fav-teams', JSON.stringify(elFav));
  store.set('el-fb-fav2', JSON.stringify(fbFav));
  dirty.add(sport);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const name = store.get('el-profile-name', ''), pin = store.get('el-profile-pin', '');
    const todo = [...dirty]; dirty.clear();
    const send = (body) => fetch(EL_URL, { method: 'POST', headers: { ...HEAD, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }).then((r) => r.json()).then((d) => d?.ok).catch(() => false);
    const ok = await Promise.all(todo.map((sp) => send(sp === 'b' ? { kind: 'profile-save', name, pin, favorites: elFav } : { kind: 'profile-fbsave', name, pin, fbFavorites: fbFav })));
    if (ok.includes(false)) toast('Teams nur auf diesem Gerät gespeichert, das Profil ist gerade nicht erreichbar.');
  }, 500);
}
let toastTimer = 0;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
// Die Bereiche Basketball und Fussball brauchen je mindestens ein Team, darum bleibt das letzte gewählt
function toggleTeam(s, k) {
  if (s === 'b') {
    if (elFav.includes(k)) { if (elFav.length <= 1) return toast('Mindestens ein Basketball-Team bleibt gewählt.'); elFav = elFav.filter((c) => c !== k); }
    else if (elFav.length >= EL_FAV_MAX) return toast(`Höchstens ${EL_FAV_MAX} Basketball-Teams.`);
    else elFav = [...elFav, k];
  } else {
    const low = k.toLowerCase();
    if (fbFav.some((n) => n.toLowerCase() === low)) { if (fbFav.length <= 1) return toast('Mindestens ein Fussball-Team bleibt gewählt.'); fbFav = fbFav.filter((n) => n.toLowerCase() !== low); }
    else if (fbFav.length >= FB_FAV_MAX) return toast(`Höchstens ${FB_FAV_MAX} Fussball-Teams.`);
    else fbFav = [...fbFav, k];
  }
  saveFavs(s);
  render();
  if ($('#msPick').open) renderPick();
}
function renderPick() {
  const all = catalog(), q = plain($('#msQ')?.value.trim());
  const mine = new Set(all.filter((t) => t.s === 'f' && isFavTeam(t)).map((t) => t.lg));
  const list = q ? all.filter((t) => plain(t.n).includes(q) || plain(t.lg).includes(q))
    : [...all.filter((t) => !isFavTeam(t) && t.s === 'f' && mine.has(t.lg)), ...all.filter((t) => !isFavTeam(t) && t.s === 'b'), ...all.filter((t) => !isFavTeam(t) && t.s === 'f' && !mine.has(t.lg))];
  const rows = list.slice(0, PICK_MAX).map((t) => `<button type="button" class="ms-pr" data-act="pick" data-s="${t.s}" data-k="${esc(t.k)}" aria-pressed="${isFavTeam(t)}">${crest(t.logo)}<span>${esc(t.n)}<small>${esc(t.lg)}</small></span><i aria-hidden="true">★</i></button>`).join('');
  $('#msPickH').textContent = q ? 'Treffer' : 'Vorschläge';
  $('#msRes').innerHTML = rows || '<p class="ms-note">Kein Team gefunden.</p>';
}
function openPick() {
  const dlg = $('#msPick');
  dlg.innerHTML = `<div class="ms-pick-h"><h2 id="msPickT">Team hinzufügen</h2><button type="button" class="ms-close" data-act="pick-close">Fertig</button></div>
    <input class="ms-q" id="msQ" type="search" placeholder="Team suchen, zum Beispiel Basel" aria-label="Team suchen" autocomplete="off">
    <h3 id="msPickH">Vorschläge</h3><div class="ms-results" id="msRes"></div>`;
  if (!dlg.open) dlg.showModal();
  $('#msQ').addEventListener('input', renderPick);
  renderPick();
}

const START_NAME = { meinsport: 'Mein Sport', basketball: 'Basketball', fussball: 'Fussball' };
const startPage = () => { const v = store.get('el-start', 'meinsport'); return START_NAME[v] ? v : 'meinsport'; };

function openMe() {
  const dlg = $('#msMe');
  dlg.innerHTML = `<h2 id="msMeT">${esc(store.get('el-profile-name', 'Profil'))}</h2><p>Deine Teams gelten für Basketball und Fussball.</p>
    <button type="button" data-act="add-team">Teams wählen</button>
    <button type="button" data-act="start" id="msStart">Start der App: ${START_NAME[startPage()]}</button>
    <button type="button" data-act="spoiler" id="msSpoiler">Spoilerschutz: ${spoilerOn() ? 'Ein' : 'Aus'}</button><button type="button" data-act="theme">Hell oder dunkel</button><button type="button" class="x" data-act="me-close">Schliessen</button>`;
  dlg.showModal();
}
function toggleTheme() {
  const r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  r.dataset.theme = next; store.set('el-theme', next);
}
document.addEventListener('click', (e) => {
  // «Heute» auf «Heute»: die Seite nicht neu laden (die Leiste würde dabei springen), nur nach oben und frische Daten holen
  if (e.target.closest?.('.ms-tabs a[aria-current="page"]')) {
    e.preventDefault();
    scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    refresh();
    return;
  }
  const act = e.target.closest?.('[data-act]')?.dataset.act;
  if (act === 'me') openMe();
  else if (act === 'me-close') $('#msMe').close();
  else if (act === 'theme') toggleTheme();
  else if (act === 'spoiler') { store.set(msKey('spoiler'), spoilerOn() ? '0' : '1'); $('#msSpoiler').textContent = `Spoilerschutz: ${spoilerOn() ? 'Ein' : 'Aus'}`; saveSeen(); render(); }
  else if (act === 'reveal') { const k = e.target.closest('[data-k]').dataset.k; revealed.add(k); render(); }
  else if (act === 'add-team') { if ($('#msMe').open) $('#msMe').close(); openPick(); }
  else if (act === 'start') {
    const keys = Object.keys(START_NAME), next = keys[(keys.indexOf(startPage()) + 1) % keys.length];
    store.set('el-start', next); $('#msStart').textContent = `Start der App: ${START_NAME[next]}`;
  } else if (act === 'pick-close') $('#msPick').close();
  else if (act === 'pick' || act === 'team-x') { const d = e.target.closest('[data-k]').dataset; e.preventDefault(); toggleTeam(d.s, d.k); }
  else if (act === 'edit-teams') { editTeams = !editTeams; render(); }
  else if (act === 'more-feed') { show.feed = !show.feed; render(); }
  else if (act === 'more-today') { show.today = !show.today; render(); }
  else if (e.target === $('#msMe')) $('#msMe').close();
  else if (e.target === $('#msPick')) $('#msPick').close();
});
// Herunterziehen lädt neu wie in den Bereichen. Nur die Daten, nicht die ganze Seite: so bleibt die Leiste ruhig.
function setupPullToRefresh() {
  const THRESHOLD = 70, MAX = 110;
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>`;
  document.body.append(ind);
  let startY = null, startX = 0, dy = 0, busy = false;
  const show = (d) => {
    const pos = Math.min(d, MAX);
    ind.style.transform = `translate(-50%, ${pos - 50}px) rotate(${pos * 3}deg)`;
    ind.style.opacity = String(Math.min(pos / THRESHOLD, 1));
    ind.classList.toggle('is-ready', d >= THRESHOLD);
  };
  const reset = () => { ind.style.transform = ''; ind.style.opacity = ''; ind.classList.remove('is-ready', 'is-loading'); };
  addEventListener('touchstart', (e) => {
    if (busy || e.touches.length !== 1 || scrollY > 0 || $('#msMe').open || $('#msPick').open) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; dy = 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const y = e.touches[0].clientY - startY, x = e.touches[0].clientX - startX;
    // Seitwärts wischen (Tafeln, Teamkarten) oder nach oben scrollen: kein Aktualisieren
    if (y <= 0 || Math.abs(x) > y || scrollY > 0) { startY = null; reset(); return; }
    dy = y * 0.6;
    show(dy);
  }, { passive: true });
  addEventListener('touchend', async () => {
    if (startY == null) return;
    startY = null;
    if (dy < THRESHOLD) return reset();
    busy = true;
    ind.classList.add('is-loading');
    ind.style.transform = 'translate(-50%, 20px)';
    ind.style.opacity = '1';
    await Promise.all([refresh(), syncProfile()]).catch(() => {});
    busy = false;
    reset();
  });
  addEventListener('touchcancel', () => { startY = null; reset(); });
}

// Beim Verlassen merken, was gesehen wurde: es erscheint beim nächsten Öffnen nicht mehr
function rememberSeen() {
  for (const k of revealed) seen.add(k);
  if (!spoilerOn()) for (const g of games().filter(missed)) seen.add(gkey(g));
  saveSeen(true);
}
addEventListener('pagehide', rememberSeen);
document.addEventListener('visibilitychange', () => { if (document.hidden) rememberSeen(); else refresh(); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});

if (!leaving) {
  setupPullToRefresh();
  syncProfile();
  refresh();
  revealTabs();
}
// Leiste erst einblenden, wenn Schrift und Abstand zum Home-Balken feststehen. In der Home-App des iPhones kommt dieser
// Abstand nach einem Seitenwechsel manchmal erst einen Moment später: die Leiste würde sonst sichtbar nach oben springen.
function revealTabs() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;bottom:0;left:0;width:1px;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom, 0px)';
  document.body.append(probe);
  const inset = () => parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const start = Date.now();
  const fonts = Promise.race([document.fonts?.ready, new Promise((r) => { setTimeout(r, 250); })]).catch(() => {});
  const nav = document.querySelector('.ms-tabs');
  let last = -1, same = 0;
  fonts.then(function wait() {
    // Position der Leiste selbst messen (deckt Abstand zum Home-Balken und Fensterhöhe ab): erst zeigen, wenn sie 3 Messungen lang ruht
    const y = nav.getBoundingClientRect().top;
    same = y === last ? same + 1 : 0;
    last = y;
    const elapsed = Date.now() - start;
    // shortcut: Geräte ohne Home-Balken zeigen die Leiste in der Home-App erst nach 1,2 s; harte Grenze 1,5 s
    if (elapsed < 1500 && (same < 3 || (standalone && inset() === 0 && elapsed < 1200))) { setTimeout(wait, 60); return; }
    probe.remove();
    document.body.classList.add('ms-ready');
  });
}
