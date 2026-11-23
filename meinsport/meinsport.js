// Mein Sport: gemeinsame Startseite. Liest dieselben Daten wie die Bereiche Basketball und Fussball und führt für Details
// dorthin (basketball/euroleague/?game=, ?team=, fussball/?m=). Zugang und Profil wie dort (gate.js, Lieblingsteams im Gerät und im Profil).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';
import { tvOf } from '../fussball/tv.js';

const EL_URL = `${SUPABASE_URL}/functions/v1/euroleague`, FB_URL = `${SUPABASE_URL}/functions/v1/fussball`, CH_URL = `${SUPABASE_URL}/functions/v1/basket`;
const HEAD = { apikey: SUPABASE_ANON_KEY };
const LIVE_POLL_MS = 60 * 1000, IDLE_POLL_MS = 60 * 60 * 1000; // ohne Spiel: bis 20 Min. vor dem nächsten Anpfiff, höchstens 1 Std.
const TODAY_MAX = 5, WIDGET_MAX = 4, MISSED_DAYS = 7, FIRST_DAYS = 3, FEED_ALL = 40, RECENT_MS = 30 * 60 * 1000;

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
// Schweizer Basketball (SB League, BVN 2. Liga Herren): Spiele aus der Funktion „basket“, Teams als „sbl:MON“ bzw. „h2l:h2l-bc-arlesheim-2“.
// Dieselbe Liste nutzen die Seiten basketball/sbl/ und basketball/2liga/ (regio.js); am Profil hängt sie über ms_state.ch.
let sbl = null, h2l = null, chFailed = false;
const CH_DEFAULT = ['h2l:h2l-bc-arlesheim-2'], CH_FAV_MAX = 20;
let chFav = (() => { try { const v = JSON.parse(localStorage.getItem('el-ch-fav') || 'null'); return Array.isArray(v) ? v.map(String) : CH_DEFAULT; } catch { return CH_DEFAULT; } })();
const CH_LG = { sbl: 'SB League', h2l: '2. Liga Herren' };
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
  const msState = { seen: list, since, spoiler: spoilerOn(), ch: chFav }, text = JSON.stringify(msState);
  const name = store.get('el-profile-name', ''), pin = store.get('el-profile-pin', '');
  if (text === lastSent || !name || !pin) return;
  lastSent = text;
  // keepalive: die Anfrage läuft auch noch, wenn die Seite gerade geschlossen wird
  fetch(EL_URL, { method: 'POST', keepalive: leaving, headers: { ...HEAD, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'profile-mssave', name, pin, msState }) }).catch(() => { lastSent = ''; });
}
const gkey = (g) => `${g.sport}${g.id}`;

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
    // «live» 160 Min. nach Anpfiff mit Spielstand = beendet (die Quelle meldet das Ende nicht immer)
    const stale = (m.st === 'live' || m.st === 'ht') && Date.now() - Date.parse(m.utc) > 160 * 60 * 1000 && m.hs != null && m.as != null;
    const st = stale ? 'ft' : m.st === 'ht' ? 'live' : m.st;
    list.push({ sport: 'f', id: m.id, l: m.l, utc: m.utc, at: Date.parse(m.utc), st, h: m.h, a: m.a, hl: m.hl, al: m.al, hk: m.h, ak: m.a, hs: m.hs, as: m.as, goals: m.goals, min: m.min,
      label: m.st === 'ht' ? 'Halbzeit' : m.min ? `${m.min}. Minute` : 'Läuft', lg: lg.get(m.l) || '', href: `fussball/?m=${encodeURIComponent(m.id)}`, fav: names.has(m.h.toLowerCase()) || names.has(m.a.toLowerCase()) });
  }
  const chTeam = (lg, t) => ({ k: `${lg}:${t.c}`, n: lg === 'sbl' ? t.n : t.n.replace(/^(BC|CVJM|TSV|BBC|TV)\s+/, ''), logo: t.logo || chLogo(t), ab: String(t.k || t.c || '').replace(/^h2l-/, '').slice(0, 3).toUpperCase() });
  for (const [lg, d] of [['sbl', sbl], ['h2l', h2l]]) for (const g of d?.games || []) {
    if (!g.utc || !['pre', 'live', 'ft'].includes(g.st)) continue;
    const h = chTeam(lg, g.h), a = chTeam(lg, g.a);
    list.push({ sport: 'c', cl: lg, id: `${lg}${g.id}`, at: Date.parse(g.utc), st: g.st, h: h.n, a: a.n, hl: h.logo, al: a.logo, hab: h.ab, aab: a.ab, hk: h.k, ak: a.k,
      hs: g.hs, as: g.as, period: g.per ? String(g.per) : '', clock: g.clk || '', label: g.st === 'live' ? bkLabel({ period: String(g.per || ''), clock: g.clk || '' }) : '', lg: CH_LG[lg],
      href: lg === 'sbl' ? `basketball/sbl/?game=${g.id}` : 'basketball/2liga/', fav: chFav.includes(h.k) || chFav.includes(a.k) });
  }
  return list.sort((x, y) => x.at - y.at);
}

// Eigene Wappen für Schweizer Vereine ohne Logo in der Quelle (basketball/img); weisser Grund, weil die Linien dunkel sind
const chLogo = (t) => (/arlesheim/i.test(`${t?.c || ''} ${t?.n || ''}`) ? 'basketball/img/bca.png' : '');
const crest = (u, cls = '', ab = '') => (u ? `<img class="ms-logo ${cls}" src="${esc(u)}" alt="" loading="lazy">` : `<span class="ms-logo none${ab ? ' ab' : ''} ${cls}" aria-hidden="true">${esc(ab)}</span>`);
const TV_ICON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M9 2l3 4 3-4"/></svg>';
const tvText = (g) => (g.sport === 'f' && g.st !== 'ft' ? tvOf({ l: g.l, utc: g.utc, h: g.h, a: g.a }).ch : '');
const tvTag = (g) => { const t = tvText(g); return t ? ` · <span class="ms-tv">${TV_ICON}${esc(t)}</span>` : ''; };

// Spiel deiner Teams, dessen Resultat du noch nicht gesehen hast
const missed = (g) => g.fav && g.st === 'ft' && g.hs != null && g.at > since && g.at > Date.now() - MISSED_DAYS * 864e5 && !seen.has(gkey(g));
const hidden = (g) => spoilerOn() && missed(g) && !revealed.has(gkey(g));

const favSide = (g) => (g.sport === 'b' ? [elFav.includes(g.hk), elFav.includes(g.ak)] : g.sport === 'c' ? [chFav.includes(g.hk), chFav.includes(g.ak)] : [fbFav.some((n) => n.toLowerCase() === g.h.toLowerCase()), fbFav.some((n) => n.toLowerCase() === g.a.toLowerCase())]);
// ---------- Als Nächstes: das nächste Spiel jedes Lieblingsteams als Karte zum Wischen ----------
// Pro Karte beide Teams mit Tabellenplatz, Bilanz und Form. Tabellenplatz: EuroLeague aus der Hauptrunde gerechnet
// (wie auf der EuroLeague-Seite), SB League und 2. Liga aus deren Tabelle; Fussball ohne Tabelle, nur die Form
// aus den geladenen Spielen (rund zwei Wochen).
const NEXT_MAX = 8;
const sideKey = (g, home) => (g.sport === 'f' ? `f:${String(home ? g.h : g.a).toLowerCase()}` : `${g.sport}:${home ? g.hk : g.ak}`);
function standings() {
  const rk = new Map(), st = {}, h2h = {};
  const duel = (x, y) => (h2h[`${x}|${y}`] ||= { n: 0, w: 0, d: 0 });
  for (const g of el?.games || []) {
    if (g.status !== 'final' || (g.ph || 'RS') !== 'RS' || g.hs === g.as) continue;
    for (const [c, o, us, them] of [[g.home, g.away, g.hs, g.as], [g.away, g.home, g.as, g.hs]]) {
      const s = (st[c] ||= { c, w: 0, l: 0, d: 0 }), x = duel(c, o);
      if (us > them) { s.w++; x.w++; } else s.l++;
      s.d += us - them; x.n++; x.d += us - them;
    }
  }
  const table = Object.values(st).sort((a, b) => b.w - a.w || a.l - b.l || b.d - a.d || a.c.localeCompare(b.c));
  // Gleichstand: Direktvergleich, sobald die Punktgleichen alle Spiele gegeneinander gespielt haben (wie app.js model())
  for (let i = 0; i < table.length;) {
    let j = i + 1;
    while (j < table.length && table[j].w === table[i].w && table[j].l === table[i].l) j++;
    const grp = table.slice(i, j);
    if (grp.length > 1 && grp.every((x) => grp.every((y) => x === y || (h2h[`${x.c}|${y.c}`]?.n || 0) >= 2))) {
      const mini = (x) => grp.reduce((m, y) => { const e = x === y ? null : h2h[`${x.c}|${y.c}`]; return e ? [m[0] + e.w, m[1] + e.d] : m; }, [0, 0]);
      const mm = new Map(grp.map((x) => [x.c, mini(x)]));
      grp.sort((a, b) => mm.get(b.c)[0] - mm.get(a.c)[0] || mm.get(b.c)[1] - mm.get(a.c)[1] || b.d - a.d);
      table.splice(i, grp.length, ...grp);
    }
    i = j;
  }
  table.forEach((s, i) => rk.set(`b:${s.c}`, { rank: i + 1, rec: `${s.w}–${s.l}` }));
  for (const [lg, d] of [['sbl', sbl], ['h2l', h2l]]) for (const r of d?.table || []) if (r?.t?.c) rk.set(`c:${lg}:${r.t.c}`, { rank: r.rank, rec: `${r.w}–${r.l}` });
  return rk;
}
// Form (S/N/U) der letzten 5 Spiele pro Team; Resultate unter Spoilerschutz zählen nicht
function forms(list) {
  const f = new Map();
  for (const g of list) {
    if (g.st !== 'ft' || g.hs == null || g.as == null || hidden(g)) continue;
    for (const home of [true, false]) {
      const us = home ? g.hs : g.as, them = home ? g.as : g.hs, k = sideKey(g, home);
      if (!f.has(k)) f.set(k, []);
      f.get(k).push(us > them ? 'w' : us < them ? 'l' : 'd');
    }
  }
  return f;
}
// Nächstes Spiel jedes Lieblingsteams (ein Spiel zweier Lieblingsteams nur einmal), nach Anpfiff sortiert
function nextGames(list) {
  const now = Date.now(), covered = new Set(), out = [];
  for (const g of list) {
    if (!g.fav || g.st !== 'pre' || g.at <= now) continue;
    const [fh, fa] = favSide(g), keys = [fh && sideKey(g, true), fa && sideKey(g, false)].filter(Boolean);
    if (!keys.length || keys.every((k) => covered.has(k))) continue;
    keys.forEach((k) => covered.add(k));
    out.push(g);
    if (out.length >= NEXT_MAX) break;
  }
  return out;
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
    } else if (g.sport === 'b') {
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
function teamCards(list) {
  const cards = [];
  const add = (sport, key, name, logo, mine, ab = '') => {
    const done = mine.filter((g) => g.st === 'ft' && g.hs != null), live = mine.find((g) => g.st === 'live'), next = mine.find((g) => g.st === 'pre' && g.at > Date.now());
    const home = (g) => g.hk === key || g.h === key, us = (g) => (home(g) ? g.hs : g.as), them = (g) => (home(g) ? g.as : g.hs), opp = (g) => (home(g) ? g.a : g.h);
    // Wappen-Leiste: Ring in der Sportfarbe (live rot), darunter Live-Stand, letztes Resultat oder – ohne Resultat – das nächste Spiel
    const last = done.filter((g) => !hidden(g)).at(-1);
    const href = sport === 'b' ? `basketball/euroleague/?team=${encodeURIComponent(key)}` : sport === 'c' ? (key.startsWith('sbl:') ? 'basketball/sbl/' : 'basketball/2liga/') : (live || next || last)?.href || 'fussball/';
    const wl = (g) => (us(g) > them(g) ? ['w', 'S', 'Sieg'] : us(g) < them(g) ? ['l', 'N', 'Niederlage'] : ['d', 'U', 'Unentschieden']);
    let tag, cls, say;
    if (live) { tag = `Live ${us(live) ?? 0}:${them(live) ?? 0}`; cls = 'on'; say = `spielt gerade, ${us(live) ?? 0}:${them(live) ?? 0} ${home(live) ? 'gegen' : 'bei'} ${opp(live)}`; }
    else if (last) { const [c, k, w] = wl(last); tag = `${k} ${us(last)}:${them(last)}`; cls = c; say = `zuletzt ${w} ${us(last)}:${them(last)} ${home(last) ? 'gegen' : 'bei'} ${opp(last)}`; }
    else if (next) { tag = whenText(next.at); cls = ''; say = `nächstes Spiel ${whenText(next.at)} ${home(next) ? 'gegen' : 'bei'} ${opp(next)}`; }
    else { tag = '–'; cls = ''; say = 'im Moment kein Spiel geplant'; }
    const x = editTeams ? `<button type="button" class="ms-x" data-act="team-x" data-s="${sport}" data-k="${esc(key)}" aria-label="${esc(name)} entfernen">×</button>` : '';
    cards.push({ rank: live ? 0 : next ? next.at : Infinity, html: `<div class="ms-av ${sport}${live ? ' live' : ''}"><a href="${esc(href)}" aria-label="${esc(`${name}: ${say}`)}" title="${esc(`${name}: ${say}`)}">
      <span class="ms-ring">${crest(logo, 'lg', ab)}</span><b>${esc(name)}</b><em class="num ${cls}">${esc(tag)}</em></a>${x}</div>` });
  };
  for (const c of elFav) add('b', c, el?.teams?.[c]?.short || c, el?.teams?.[c]?.crest, list.filter((g) => g.sport === 'b' && (g.hk === c || g.ak === c)));
  for (const n of fbFav) {
    const k = n.toLowerCase(), mine = list.filter((g) => g.sport === 'f' && (g.h.toLowerCase() === k || g.a.toLowerCase() === k));
    const g0 = mine[0];
    add('f', g0 ? (g0.h.toLowerCase() === k ? g0.h : g0.a) : n, n, g0 ? (g0.h.toLowerCase() === k ? g0.hl : g0.al) : '', mine);
  }
  for (const k of chFav) {
    const mine = list.filter((g) => g.sport === 'c' && (g.hk === k || g.ak === k)), g0 = mine[0], home = g0?.hk === k;
    const t = catalog().find((x) => x.k === k);
    add('c', k, g0 ? (home ? g0.h : g0.a) : t?.n || k.replace(/^\w+:(h2l-)?/, ''), g0 ? (home ? g0.hl : g0.al) : t?.logo || '', mine, g0 ? (home ? g0.hab : g0.aab) : '');
  }
  return cards.sort((x, y) => x.rank - y.rank).map((c) => c.html).join('');
}

// ---------- Matchplakat und Kacheln ----------
// Plakatfarbe pro Lieblingsteam (Vereinsfarbe); ohne Eintrag die Farbe der Sportart
const TINT = { 'fc basel': '#C8102E', liverpool: '#C8102E', chelsea: '#034694', arsenal: '#EF0107', 'manchester united': '#DA291C', 'manchester city': '#6CABDD',
  'young boys': '#F5C400', 'fc zürich': '#0072BC', 'fc luzern': '#1E4E9C', 'fc st. gallen': '#00843D', servette: '#8B1E3F', 'fc lugano': '#000000', 'bayern münchen': '#DC052D',
  'borussia dortmund': '#FDE100', 'real madrid': '#3D2B8F', barcelona: '#A50044', juventus: '#000000', 'inter milan': '#0068A8',
  PAN: '#0B7A3B', OLY: '#C8102E', MAD: '#3D2B8F', BAR: '#A50044', ULK: '#163962', IST: '#00349A', ZAL: '#006A44', MCO: '#E30613', RED: '#C8102E', TEL: '#F5C400',
  MIL: '#D50032', BAS: '#B3003A', ASV: '#003DA5', 'h2l:h2l-bc-arlesheim-2': '#1D3F8F' };
const SPORT_TINT = { b: 'var(--bk)', f: 'var(--fb)', c: 'var(--ch)' };
const favKeyOf = (g, home) => (g.sport === 'f' ? String(home ? g.h : g.a).toLowerCase() : home ? g.hk : g.ak);
const tintOf = (g) => { const [fh, fa] = favSide(g), home = fh || !fa; return TINT[favKeyOf(g, home)] || SPORT_TINT[g.sport]; };
// Fallblatt-Ziffern (Countdown bis Anpfiff)
const flapsHtml = (str) => `<span class="msx-flaps">${[...str].map((ch) => `<span class="msx-flap${ch === ':' ? ' sep' : ''}">${esc(ch)}</span>`).join('')}</span>`;
const cdText = (at) => { const m = Math.max(0, Math.ceil((at - Date.now()) / 60000)); return m >= 24 * 60 ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const goalLine = (g) => {
  if (g.sport !== 'f' || !g.goals?.length) return '';
  const side = (s) => g.goals.filter((x) => x.s === s).map((x) => `${esc(x.n || '')}${x.m !== '' && x.m != null ? ` ${esc(x.m)}'` : ''}`).join(', ');
  const h = side(1), a = side(2);
  return `⚽ ${h || '–'} <span class="msx-sep">|</span> ${a || '–'}`;
};
// Spiele fürs Plakat: laufende, heute noch kommende und eben beendete Spiele deiner Teams
function heroGames(list) {
  const now = Date.now(), today = dayKey(now);
  const out = list.filter((g) => g.fav && (g.st === 'live' || (g.st === 'pre' && g.at > now - 15 * 60e3 && dayKey(g.at) === today)
    || (g.st === 'ft' && g.hs != null && !hidden(g) && now - endsAt(g) < 2 * 3600e3 && dayKey(g.at) === today)));
  const rankSt = (g) => (g.st === 'live' ? 0 : g.st === 'pre' ? 1 : 2);
  return out.sort((x, y) => rankSt(x) - rankSt(y) || (x.st === 'ft' ? y.at - x.at : x.at - y.at));
}
// ---------- Live: Fallblatt-Tafel im Plakat (wie in den Bereichen), darunter Details der Sportart ----------
const lastFlaps = new Map(); // letzter Stand pro Spiel: geänderte Blätter klappen um
const liveStats = new Map(); // Fussball-Spiel → { at, d } Statistik der Funktion (Ballbesitz, Schüsse)
const STAT_LG = new Set(['pl', 'ucl', 'efl', 'bl1', 'laliga', 'seriea', 'ligue1', 'chsl', 'chcl']);
async function loadLiveStats(list) {
  const need = list.filter((g) => g.sport === 'f' && g.fav && g.st === 'live' && STAT_LG.has(g.l) && (!liveStats.has(g.id) || Date.now() - liveStats.get(g.id).at > 2 * 60e3));
  if (!need.length) return false;
  await Promise.all(need.map(async (g) => { const d = await getJson(`${FB_URL}?fbdetail=${encodeURIComponent(g.id)}&kind=stats`, 15000).catch(() => null); liveStats.set(g.id, { at: Date.now(), d }); }));
  return true;
}
// Viertel-Resultate aus dem Spielverlauf (ev: [Sekunde, Heim, Gast] fortlaufend); das laufende Viertel bis zum aktuellen Stand
function quarters(g) {
  const ev = flows.get(g.id)?.ev, n = Number((/\d+/.exec(g.period || '') || [])[0]) || 0;
  if (!ev?.length || !n) return null;
  const endOf = (q) => (q <= 4 ? q * 600 : 2400 + (q - 4) * 300);
  const at = (t) => { const e = ev.filter((x) => x[0] <= t).at(-1); return e ? [e[1], e[2]] : [0, 0]; };
  const list = [];
  let prev = [0, 0];
  for (let q = 1; q <= Math.max(4, n); q++) {
    if (q > n) { list.push({ q, s: null, cur: false }); continue; }
    const c = q === n ? [g.hs ?? 0, g.as ?? 0] : at(endOf(q));
    list.push({ q, s: [c[0] - prev[0], c[1] - prev[1]], cur: q === n });
    prev = c;
  }
  return { list };
}
function livePoster(g, rk) {
  const bk = g.sport !== 'f';
  const n = Number((/\d+/.exec(g.period || '') || [])[0]);
  const running = bk && n >= 1 && /^\d{1,2}:\d\d$/.test(g.clock || '') && g.clock !== '00:00';
  const clock = running ? g.clock.replace(/^0(?=\d:)/, '') : '';
  const hs = String(g.hs ?? 0), as = String(g.as ?? 0), key = gkey(g);
  const chars = [...hs.padStart(3), ...as.padStart(3), ...clock], before = lastFlaps.get(key) || [];
  lastFlaps.set(key, chars);
  let i = 0;
  const tiles = (str, pad) => { const p = pad ? str.padStart(pad) : str; return `<span class="flaps">${[...p].map((ch) => { const flip = before.length && before[i] !== ch; i += 1;
    return ch === ' ' ? '' : `<span class="flap${ch === ':' ? ' sep' : ''}${flip ? ' flip' : ''}">${esc(ch)}</span>`; }).join('')}</span>`; };
  const row1 = `<span class="flap-row">${crest(g.hl, 'flag', g.hab)}<span class="flap-name">${esc(g.h)}</span>${tiles(hs, 3)}</span>`;
  const row2 = `<span class="flap-row">${crest(g.al, 'flag', g.aab)}<span class="flap-name">${esc(g.a)}</span>${tiles(as, 3)}</span>`;
  const last = (g.goals || []).at(-1);
  const goal = !bk && last ? `Tor ${last.n || (last.s === 1 ? g.h : g.a)}${last.m !== '' && last.m != null ? ` ${last.m}'` : ''}` : '';
  const right = clock ? `<span class="flap-clock">${tiles(clock)}</span>` : goal ? `<span class="msx-goal">${esc(goal)}</span>` : '';
  const stateTxt = bk ? (running ? (n > 4 ? 'Verlängerung' : `${n}. Viertel`) : g.label) : g.label;
  // Details: Basketball die Viertel, Fussball Torschützen, Ballbesitz, Schüsse, Live-Tabellenplatz
  let det = '';
  if (g.sport === 'b') {
    const qs = quarters(g);
    if (qs) det = `<span class="msx-qs">${qs.list.map((x) => `<span class="${x.cur ? 'cur' : ''}">${x.q <= 4 ? `Q${x.q}` : `V${x.q - 4}`}<b class="num">${x.s ? `${x.s[0]}:${x.s[1]}` : '–'}</b></span>`).join('')}</span>`;
  } else if (!bk) {
    const sc = (s) => (g.goals || []).filter((x) => x.s === s).map((x) => `<b>${esc(String(x.n || '').replace(/\s*\(Pen\.\)$/, ' (P)'))}</b>${x.m !== '' && x.m != null ? ` ${esc(x.m)}'` : ''}`).join(', ') || '–';
    const st = liveStats.get(g.id)?.d, hm = st?.available ? st.home : null, aw = st?.available ? st.away : null;
    const [fh, fa] = favSide(g), r = rk(g, fh || !fa);
    const chips = [hm?.shots != null && aw?.shots != null ? `Schüsse <b class="num">${esc(hm.shots)}:${esc(aw.shots)}</b>` : '',
      hm?.on != null && aw?.on != null ? `aufs Tor <b class="num">${esc(hm.on)}:${esc(aw.on)}</b>` : '',
      r ? `Live-Tabelle <b>${esc(fh || !fa ? g.h : g.a)} ${esc(r.rank)}.${r.mv ? ` ${r.mv > 0 ? '▲' : '▼'}` : ''}</b>` : ''].filter(Boolean);
    det = `<span class="msx-scorers"><span>${sc(1)}</span><span>${sc(2)}</span></span>
      ${hm?.poss != null && aw?.poss != null ? `<span class="msx-poss"><span class="num">${esc(hm.poss)}%</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, Number(hm.poss)))}%"></i></span><span class="num">${esc(aw.poss)}%</span></span><span class="msx-poss-l">Ballbesitz</span>` : ''}
      ${chips.length ? `<span class="msx-chips">${chips.map((c) => `<span>${c}</span>`).join('')}</span>` : ''}`;
  }
  return `<a class="msx-poster ${g.sport}" href="${esc(g.href)}" style="--tc:${tintOf(g)}" aria-label="${esc(`${g.h} ${g.hs ?? 0}, ${g.a} ${g.as ?? 0}, ${stateTxt}`)}">
    <span class="msx-k"><span><i class="ms-dot"></i>Live</span><span>${esc(g.lg)}${g.sport === 'b' ? ` · Spieltag ${esc(g.round)}` : ''} ★</span></span>
    <span class="live-hero msx-board">${row1}${row2}<span class="flap-bar"><span class="flap-q"><i class="live-dot" aria-hidden="true"></i>${esc(stateTxt)}</span>${right}</span></span>
    ${det ? `<span class="msx-det">${det}</span>` : ''}</a>`;
}
// ---------- Beendet: Ticket mit Abriss (Endstand), darunter der Verlauf ----------
// Fussball: Tore auf der Zeitachse (Heim oben, Gast unten). Basketball (EuroLeague): Vorsprung über die Spielzeit aus dem Spielverlauf.
const goalMin = (m) => { const [a, b] = String(m ?? '').split('+').map((x) => parseInt(x, 10)); return Number.isFinite(a) ? a + (Number.isFinite(b) ? Math.min(b, 9) * 0.5 : 0) : null; };
function flowHtml(g) {
  if (g.sport === 'f') {
    const goals = (g.goals || []).map((x) => ({ ...x, t: goalMin(x.m) })).filter((x) => x.t != null);
    if (!goals.length) return '';
    const end = Math.max(95, ...goals.map((x) => x.t + 2)), pos = (t) => Math.max(2, Math.min(98, (t / end) * 100));
    return `<div class="msx-tl" aria-label="Torfolge">${'<span class="ax"></span>'}<span class="ht" style="left:${pos(45)}%"></span>
      ${goals.map((x) => `<span class="g ${x.s === 1 ? 'up' : 'dn'}" style="left:${pos(x.t).toFixed(1)}%" title="${esc(`${x.n || ''} ${x.m}'`)}">${crest(x.s === 1 ? g.hl : g.al, '', x.s === 1 ? g.hab : g.aab)}<small class="num">${esc(x.m)}'</small></span>`).join('')}
      <span class="lab" style="left:0">0'</span><span class="lab" style="left:${pos(45)}%;transform:translateX(-50%)">HZ</span><span class="lab" style="right:0">${end > 100 ? '120' : '90'}'</span></div>`;
  }
  const ev = flows.get(g.id)?.ev;
  if (g.sport !== 'b' || !ev?.length) return '';
  const end = Math.max(2400, ev.at(-1)[0]), max = Math.max(6, ...ev.map((e) => Math.abs(e[1] - e[2])));
  const pts = [[0, 0], ...ev.map((e) => [e[0], e[1] - e[2]])].map(([t, d]) => `${((t / end) * 300).toFixed(1)} ${(30 - (d / max) * 26).toFixed(1)}`);
  const lines = [600, 1200, 1800, ...(end > 2400 ? [2400] : [])].map((t) => `<line x1="${(t / end) * 300}" y1="2" x2="${(t / end) * 300}" y2="58" class="q"/>`).join('');
  return `<div class="msx-spark"><svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="Vorsprung im Spielverlauf"><line x1="0" y1="30" x2="300" y2="30" class="mid"/>${lines}<path d="M${pts.join(' L')}"/></svg>
    <span class="msx-spark-l"><span>▲ ${esc(g.h)} vorne</span><span>▼ ${esc(g.a)} vorne</span></span></div>`;
}
function ticketPoster(g) {
  const [fh, fa] = favSide(g), both = fh && fa, home = fh || !fa;
  const us = home ? g.hs : g.as, them = home ? g.as : g.hs;
  const res = both ? ['', 'Endstand'] : us > them ? ['w', 'Sieg'] : us < them ? ['l', 'Niederlage'] : ['d', 'Unentschieden'];
  const hw = g.hs > g.as, aw = g.as > g.hs;
  const d = zone(new Date(g.at), { weekday: 'short', day: 'numeric', month: 'numeric' });
  const date = `${(d.weekday || '').replace('.', '')} ${d.day}.${d.month}. · ${hhmm(g.at)}`;
  const row = (h) => `<span class="trow${(h ? aw : hw) ? ' lose' : ''}">${crest(h ? g.hl : g.al, '', h ? g.hab : g.aab)}<b>${esc(h ? g.h : g.a)}${(h ? fh : fa) ? ' <i class="star">★</i>' : ''}</b><em class="num">${esc(h ? g.hs : g.as)}</em></span>`;
  const sc = g.sport === 'f' && g.goals?.length ? g.goals.map((x) => { const n = String(x.n || ''), own = /\(Eigentor\)/.test(n), pen = /\(Pen\.\)/.test(n);
    return `${esc(n.replace(/\s*\(.*\)\s*$/, '').split(' ').pop() || (x.s === 1 ? g.h : g.a))}${own ? ' (ET)' : pen ? ' (P)' : ''} ${esc(x.m)}'`; }).join(' · ') : '';
  const flow = flowHtml(g);
  return `<a class="msx-fin" href="${esc(g.href)}" style="--tc:${tintOf(g)}" aria-label="${esc(`Endstand ${g.h} ${g.hs}, ${g.a} ${g.as}${res[0] ? `, ${res[1]}` : ''}`)}">
    <span class="msx-ticket"><span class="main"><span class="tline"><span>${esc(g.lg)}</span><span>${esc(date)}</span></span>${row(true)}${row(false)}${sc ? `<span class="tline sc">${sc}</span>` : ''}</span>
      <span class="stub"><small>Endstand</small><b class="num">${esc(g.hs)}:${esc(g.as)}</b>${res[0] ? `<small class="r ${res[0]}">${res[1]}</small>` : ''}</span></span>
    ${flow ? `<span class="msx-flow"><span class="h">So lief das Spiel</span>${flow}</span>` : ''}</a>`;
}
function heroCard(g, rk) {
  if (g.st === 'live') return livePoster(g, rk);
  if (g.st === 'ft') return ticketPoster(g);
  const live = false, pre = g.st === 'pre';
  const left = live ? `<i class="ms-dot"></i>${esc(g.label)}` : pre ? esc(whenText(g.at)) : 'Endstand';
  const cd = pre ? cdText(g.at) : '';
  const mid = pre ? (cd ? `<span class="msx-cd" data-cd="${g.at}">${flapsHtml(cd)}</span>` : '<span class="msx-vs">vs</span>') : `<span class="msx-sc num">${esc(g.hs ?? 0)}:${esc(g.as ?? 0)}</span>`;
  const r = (home) => rk(g, home);
  const ranks = pre && r(true) && r(false) ? `${r(true).rank}. gegen ${r(false).rank}.` : '';
  const sub = goalLine(g) || (g.sport !== 'f' && live ? '' : ranks) || (pre && tvText(g) ? `${TV_ICON}${esc(tvText(g))}` : '');
  const [fh, fa] = favSide(g);
  const team = (home) => `<span class="msx-tm${(home ? fh : fa) ? ' fav' : ''}">${crest(home ? g.hl : g.al, 'xl', home ? g.hab : g.aab)}<b>${esc(home ? g.h : g.a)}</b></span>`;
  return `<a class="msx-hero ${g.sport}${live ? ' live' : ''}" href="${esc(g.href)}" style="--tc:${tintOf(g)}" aria-label="${esc(`${g.h} gegen ${g.a}, ${live ? `live ${g.hs ?? 0}:${g.as ?? 0}` : pre ? whenText(g.at) : `Endstand ${g.hs}:${g.as}`}`)}">
    <span class="msx-k"><span>${left}</span><span>${esc(g.lg)} ★</span></span>
    <span class="msx-vsrow">${team(true)}${mid}${team(false)}</span>
    ${sub ? `<span class="msx-sub">${sub}</span>` : ''}</a>`;
}
// Tabellenplatz eines Teams: EuroLeague aus den Spielen, Schweizer Basketball aus dessen Tabelle, Fussball aus der Tabelle
// der Funktion (mit laufenden Spielen eingerechnet, wie die Live-Tabelle im Fussball-Bereich)
const fbTab = new Map(); // Liga → { at, rows }
const FB_TABLE_LG = new Set(['ucl', 'pl', 'efl', 'bl1', 'laliga', 'seriea', 'ligue1', 'chsl', 'chcl']);
const tkey = (n) => plain(n).replace(/&/g, '').replace(/\b(a?fc|cf|sc)\b/g, '').replace(/[^a-z]/g, '');
function fbRank(lgId, name, list) {
  const t = fbTab.get(lgId);
  if (!t?.rows?.length) return null;
  const rows = t.rows.map((r) => ({ ...r, old: r.rank }));
  const find = (n) => { const k = tkey(n); return rows.find((r) => tkey(r.team) === k) || (k.length >= 5 ? rows.find((r) => { const x = tkey(r.team); return x.startsWith(k.slice(0, 6)) || k.startsWith(x.slice(0, 6)); }) : null); };
  let live = false;
  // Laufende Spiele und solche, die die Tabelle laut Funktion noch nicht enthält (missing), einrechnen
  const miss = new Set(t.missing || []);
  for (const g of list) {
    if (g.sport !== 'f' || g.l !== lgId || !(g.st === 'live' || (g.st === 'ft' && miss.has(g.id))) || g.hs == null || g.as == null) continue;
    const H = find(g.h), A = find(g.a);
    if (!H || !A || H === A) continue;
    live = true;
    for (const [T, f, a] of [[H, g.hs, g.as], [A, g.as, g.hs]]) { T.p += 1; T.gf += f; T.ga += a; T.pts += f > a ? 3 : f === a ? 1 : 0; }
  }
  if (live) { rows.sort((x, y) => y.pts - x.pts || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf || x.old - y.old); rows.forEach((r, i) => { r.rank = i + 1; }); }
  const me = find(name);
  return me ? { rank: me.rank, rec: `${me.pts} Pkt`, mv: live ? me.old - me.rank : 0 } : null;
}
async function loadTables(list) {
  const need = [...new Set(list.filter((g) => g.sport === 'f' && g.fav && FB_TABLE_LG.has(g.l)).map((g) => g.l))].filter((l) => !fbTab.has(l) || Date.now() - fbTab.get(l).at > 30 * 60e3);
  if (!need.length) return false;
  await Promise.all(need.map(async (l) => { const d = await getJson(`${FB_URL}?fbleague=${l}`, 15000).catch(() => null); if (d?.available && Array.isArray(d.rows)) fbTab.set(l, { at: Date.now(), rows: d.rows, missing: d.missing || [] }); }));
  return true;
}
function render() {
  const list = games(), now = Date.now(), today = dayKey(now);
  const live = list.filter((g) => g.st === 'live');
  const pill = $('#msPill');
  pill.hidden = !live.length;
  pill.innerHTML = live.length ? `<i class="ms-dot"></i>${live.length} live` : '';
  $('#msDate').textContent = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());

  // Live gesehene Spiele deiner Teams brauchen keinen Spoilerschutz mehr
  let added = false;
  for (const g of live) if (g.fav && !seen.has(gkey(g))) { seen.add(gkey(g)); added = true; }
  if (added) saveSeen();

  const stand = standings();
  const rankOf = (g, home) => (g.sport === 'f' ? fbRank(g.l, home ? g.h : g.a, list) : stand.get(sideKey(g, home)) || null);

  // Plakat: mehrere Spiele zum Wischen; ohne Spiel deiner Teams heute eine ruhige Tageszeile
  const heroes = heroGames(list), heroIds = new Set(heroes.map(gkey));
  const upcoming = nextGames(list);
  const nx = upcoming.find((g) => !heroIds.has(gkey(g)));
  const favName = (g) => { const [fh, fa] = favSide(g); return fh || !fa ? g.h : g.a; };
  const hasFav = elFav.length || fbFav.length || chFav.length;
  const heroHtml = heroes.length
    ? `<section class="msx-heroes-wrap" aria-label="Deine Spiele heute"><div class="msx-heroes" data-keep="hero">${heroes.map((g) => heroCard(g, rankOf)).join('')}</div>
      ${heroes.length > 1 ? `<div class="msx-dots" aria-hidden="true">${heroes.map((_, i) => `<i${i === 0 ? ' class="on"' : ''}></i>`).join('')}</div>` : ''}</section>`
    : `<section class="msx-calm"><h2>Heute kein Spiel deiner Teams</h2><p>${hasFav ? (nx ? `Als Nächstes: ${esc(favName(nx))} ${esc(whenText(nx.at))}` : 'Im Moment ist kein Spiel geplant.') : 'Wähle deine Teams, dann erscheinen hier ihre Spiele.'}</p></section>`;

  // Kacheln: Countdown zu den nächsten Spielen, verpasste Resultate (Spoilerschutz), letzte Resultate; breit: Tabellen, Live-Feed, Heute sonst
  const small = [], wide = [];
  const vsTxt = (g) => { const [fh] = favSide(g); return `${fh ? 'gegen' : 'bei'} ${fh ? g.a : g.h}`; };
  const head = (g, txt) => `<span class="msx-wt">${crest(favSide(g)[0] || !favSide(g)[1] ? g.hl : g.al, '', favSide(g)[0] || !favSide(g)[1] ? g.hab : g.aab)}<span>${esc(txt)}</span></span>`;
  for (const g of upcoming.filter((x) => !heroIds.has(gkey(x))).slice(0, 3)) {
    const mins = Math.round((g.at - now) / 60000);
    const big = mins < 60 ? `${Math.max(1, mins)}′` : dayKey(g.at) === today ? hhmm(g.at) : (zone(new Date(g.at), { weekday: 'short' }).weekday || '').replace('.', '');
    small.push(`<a class="msx-w" href="${esc(g.href)}">${head(g, mins < 60 ? `${favName(g)} · Anpfiff in` : `${favName(g)} · ${g.lg}`)}<b class="msx-big num">${esc(big)}</b><small>${esc(dayKey(g.at) === today || mins < 60 ? vsTxt(g) : `${hhmm(g.at)} ${vsTxt(g)}`)}${tvText(g) ? ` · ${esc(tvText(g))}` : ''}</small></a>`);
  }
  for (const g of list.filter(hidden).reverse().slice(0, WIDGET_MAX)) {
    const wd = (zone(new Date(g.at), { weekday: 'short' }).weekday || '').replace('.', '');
    small.push(`<div class="msx-w spoil">${head(g, `${favName(g)} · ${wd}`)}<small>Seit deinem Besuch gespielt</small><button type="button" class="msx-chip" data-act="reveal" data-k="${esc(gkey(g))}" aria-label="Resultat von ${esc(favName(g))} zeigen">Resultat zeigen</button></div>`);
  }
  const doneTeams = new Set();
  for (const g of list.filter((x) => x.fav && x.st === 'ft' && x.hs != null && !hidden(x) && !heroIds.has(gkey(x)) && now - x.at < 4 * 864e5).reverse()) {
    const [fh, fa] = favSide(g), home = fh || !fa, k = sideKey(g, home);
    if (doneTeams.has(k) || doneTeams.size >= WIDGET_MAX) continue;
    doneTeams.add(k);
    const us = home ? g.hs : g.as, them = home ? g.as : g.hs, res = us > them ? ['w', 'Sieg'] : us < them ? ['l', 'Niederlage'] : ['d', 'Unentschieden'];
    const wd = dayKey(g.at) === today ? 'heute' : (zone(new Date(g.at), { weekday: 'short' }).weekday || '').replace('.', '');
    small.push(`<a class="msx-w res ${res[0]}" href="${esc(g.href)}">${head(g, `${favName(g)} · ${wd}`)}<b class="msx-big num">${esc(us)}:${esc(them)}</b><small>${res[1]} ${esc(vsTxt(g))}</small></a>`);
  }
  // Tabellen deiner Teams
  const tRows = [], tSeen = new Set();
  for (const g of list.filter((x) => x.fav)) {
    for (const home of [true, false]) {
      if (!favSide(g)[home ? 0 : 1]) continue;
      const k = sideKey(g, home);
      if (tSeen.has(k)) continue;
      const r = rankOf(g, home);
      if (!r) continue;
      tSeen.add(k);
      tRows.push({ name: home ? g.h : g.a, lg: g.lg, ...r });
    }
  }
  if (tRows.length) wide.push(`<div class="msx-w wide"><span class="msx-wt"><span>Deine Tabellen</span></span><div class="msx-tbl">${tRows.sort((a, b) => a.rank - b.rank).map((r) => `<div><span class="num">${esc(r.rank)}.</span><b>${esc(r.name)}<small> · ${esc(r.lg)}</small></b>${r.mv ? `<i class="${r.mv > 0 ? 'up' : 'down'}">${r.mv > 0 ? '▲' : '▼'}</i>` : ''}<span class="num">${esc(r.rec)}</span></div>`).join('')}</div></div>`);
  // Live-Feed (Tore, Läufe, Endstände)
  const feed = feedItems(list);
  if (feed.length) wide.push(`<div class="msx-w wide"><span class="msx-wt"><span>Live-Feed</span></span><ul class="ms-feed">${(show.feed ? feed : feed.slice(0, WIDGET_MAX)).map((f) => `<li class="${f.sport}"><span class="num">${esc(f.tag)}</span><p>${f.html}</p></li>`).join('')}</ul>
    ${feed.length > WIDGET_MAX ? `<button type="button" class="ms-more" data-act="more-feed">${show.feed ? 'Weniger zeigen' : `Alle ${feed.length} Ereignisse`}</button>` : ''}</div>`);
  // Heute sonst: die übrigen Spiele des Tages
  const others = list.filter((g) => !heroIds.has(gkey(g)) && dayKey(g.at) === today && !(g.fav && g.st === 'pre')).sort((x, y) => (x.st === 'live' ? -1 : 0) - (y.st === 'live' ? -1 : 0) || (x.st === 'ft') - (y.st === 'ft') || x.at - y.at);
  if (others.length) {
    const row = (g) => { const sc = g.hs != null && g.st !== 'pre' && !hidden(g);
      return `<a class="msx-row ${g.sport}" href="${esc(g.href)}"><span class="num${g.st === 'live' ? ' on' : ''}">${g.st === 'live' ? 'live' : g.st === 'ft' ? 'Ende' : hhmm(g.at)}</span><b>${esc(g.h)} – ${esc(g.a)}</b><span class="num">${sc ? `${esc(g.hs)}:${esc(g.as)}` : ''}</span></a>`; };
    wide.push(`<div class="msx-w wide"><span class="msx-wt"><span>Heute sonst</span></span><div class="msx-rows">${(show.today ? others : others.slice(0, TODAY_MAX)).map(row).join('')}</div>
      ${others.length > TODAY_MAX ? `<button type="button" class="ms-more" data-act="more-today">${show.today ? 'Weniger zeigen' : `Alle ${others.length} Spiele`}</button>` : ''}</div>`);
  }
  // Ungerade Zahl kleiner Kacheln: die letzte füllt die Zeile
  if (small.length % 2) small[small.length - 1] = small[small.length - 1].replace('class="msx-w', 'class="msx-w fill');
  const gridHtml = small.length || wide.length ? `<div class="msx-grid">${small.join('')}${wide.join('')}</div>` : '';

  const cards = teamCards(list);
  const teamsHtml = `<div class="ms-hrow"><h2 class="ms-h">Deine Teams</h2>${cards ? `<button type="button" class="ms-edit" data-act="edit-teams" aria-pressed="${editTeams}">${editTeams ? 'Fertig' : 'Bearbeiten'}</button>` : ''}</div>
    <div class="ms-teams" data-keep="teams">${cards}<button type="button" class="ms-add" data-act="add-team" aria-haspopup="dialog" aria-label="Team hinzufügen"><span aria-hidden="true">+</span>Team</button></div>`;

  const fails = [elFailed && 'EuroLeague', chFailed && 'Schweizer Basketball', fbFailed && 'Fussball'].filter(Boolean);
  const note = (fails.length ? `<p class="ms-note">${fails.join(' und ')} gerade nicht erreichbar, angezeigt wird der letzte Stand.</p>` : '')
    + (fb?.paused ? '<p class="ms-note">Fussball: Live-Stände pausiert, das Tageslimit der Datenquelle ist erreicht.</p>' : '');
  const main = $('#msMain');
  const keep = [...main.querySelectorAll('[data-keep]')].map((n) => [n.dataset.keep, n.scrollLeft]);
  main.classList.add('msx');
  main.innerHTML = `<div class="ms-col">${note}${heroHtml}${gridHtml}${teamsHtml}</div>`;
  for (const [k, x] of keep) { const n = main.querySelector(`[data-keep="${k}"]`); if (n) n.scrollLeft = x; }
  syncDots();
}
// Punkte unter dem Plakat: zeigen, welches Spiel gerade sichtbar ist
function syncDots() {
  const box = document.querySelector('.msx-heroes'), dots = document.querySelectorAll('.msx-dots i');
  if (!box || !dots.length) return;
  const i = Math.round(box.scrollLeft / Math.max(1, box.clientWidth));
  dots.forEach((d, k) => d.classList.toggle('on', k === i));
}
document.addEventListener('scroll', (e) => { if (e.target?.classList?.contains('msx-heroes')) syncDots(); }, true);
// Countdown im Plakat jede halbe Minute nachführen; bei 0 neu laden
setInterval(() => {
  for (const n of document.querySelectorAll('[data-cd]')) {
    const t = cdText(Number(n.dataset.cd));
    if (t === '00:00') { refresh(); continue; }
    if (t) n.innerHTML = flapsHtml(t);
  }
}, 30 * 1000);

const getJson = async (url, ms) => {
  const res = await fetch(url, { headers: HEAD, cache: 'no-store', signal: AbortSignal.timeout(ms) });
  const d = await res.json().catch(() => null);
  if (!res.ok || !d) throw new Error(`Fehler ${res.status}`);
  if (res.headers.get('x-offline')) Object.defineProperty(d, 'stale', { value: true }); // letzter Stand aus dem Service Worker
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
  const [a, b, c, d] = await Promise.allSettled([getJson(EL_URL, 20000), getJson(`${FB_URL}?fb=1`, 30000), getJson(`${CH_URL}?sbl=1`, 25000), getJson(`${CH_URL}?bvn=h2l`, 25000)]);
  if (c.status === 'fulfilled' && Array.isArray(c.value.games)) sbl = c.value;
  if (d.status === 'fulfilled' && Array.isArray(d.value.games)) h2l = d.value;
  const okv = (r) => r.status === 'fulfilled' && !r.value.stale;
  chFailed = !okv(c) && !okv(d);
  if (a.status === 'fulfilled' && Array.isArray(a.value.games)) el = a.value;
  elFailed = !okv(a);
  if (b.status === 'fulfilled' && Array.isArray(b.value.matches)) { fb = b.value; if (!b.value.stale) trackGoals(); }
  fbFailed = !okv(b);
  render();
  await Promise.all([loadFlows(), loadTables(games()), loadLiveStats(games())]);
  render();
  const now = Date.now();
  const soon = games().some((g) => g.st === 'live' || (g.st === 'pre' && Math.abs(g.at - now) < 20 * 60 * 1000));
  const nextAt = Math.min(...games().filter((g) => g.st === 'pre' && g.at > now).map((g) => g.at));
  timer = setTimeout(refresh, soon ? LIVE_POLL_MS : Math.max(LIVE_POLL_MS, Math.min(IDLE_POLL_MS, nextAt - 20 * 60 * 1000 - now)));
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
      if (Array.isArray(d.msState.ch)) { chFav = d.msState.ch.map(String).slice(0, CH_FAV_MAX); store.set('el-ch-fav', JSON.stringify(chFav)); }
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
  const ch = new Map();
  for (const g of games().filter((x) => x.sport === 'c')) for (const [k, n, logo, ab] of [[g.hk, g.h, g.hl, g.hab], [g.ak, g.a, g.al, g.aab]]) if (!ch.has(k)) ch.set(k, { s: 'c', k, n, logo, ab, lg: g.lg });
  for (const r of h2l?.table || []) { const k = `h2l:${r.t.c}`; if (!ch.has(k)) ch.set(k, { s: 'c', k, n: r.t.n.replace(/^(BC|CVJM|TSV|BBC|TV)\s+/, ''), logo: chLogo(r.t), ab: String(r.t.k || '').slice(0, 3), lg: CH_LG.h2l }); }
  return [...list, ...byName.values(), ...ch.values()].sort((a, b) => a.n.localeCompare(b.n, 'de'));
}
const isFavTeam = (t) => (t.s === 'b' ? elFav.includes(t.k) : t.s === 'c' ? chFav.includes(t.k) : fbFav.some((n) => n.toLowerCase() === t.k.toLowerCase()));
let saveTimer = 0;
const dirty = new Set(); // Sportarten mit ungespeicherten Änderungen
function saveFavs(sport) {
  if (sport === 'c') { store.set('el-ch-fav', JSON.stringify(chFav)); saveSeen(); return; }
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
  if (s === 'c') {
    if (chFav.includes(k)) chFav = chFav.filter((x) => x !== k);
    else if (chFav.length >= CH_FAV_MAX) return toast(`Höchstens ${CH_FAV_MAX} Schweizer Teams.`);
    else chFav = [...chFav, k];
  } else if (s === 'b') {
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
    : [...all.filter((t) => !isFavTeam(t) && t.s === 'f' && mine.has(t.lg)), ...all.filter((t) => !isFavTeam(t) && t.s === 'b'), ...all.filter((t) => !isFavTeam(t) && t.s === 'c'), ...all.filter((t) => !isFavTeam(t) && t.s === 'f' && !mine.has(t.lg))];
  const rows = list.slice(0, PICK_MAX).map((t) => `<button type="button" class="ms-pr" data-act="pick" data-s="${t.s}" data-k="${esc(t.k)}" aria-pressed="${isFavTeam(t)}">${crest(t.logo, '', t.ab)}<span>${esc(t.n)}<small>${esc(t.lg)}</small></span><i aria-hidden="true">★</i></button>`).join('');
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
  // Profil-Kürzel auf den Basketball-Seiten SB League / 2. Liga führt hierher (?me=1): gleich «Ich» öffnen
  if (new URLSearchParams(location.search).get('me') === '1') { history.replaceState(null, '', location.pathname); openMe(); }
  setupPullToRefresh();
  syncProfile();
  refresh();
}
