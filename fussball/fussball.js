// Fussball-Bereich: Spielübersicht (Resultate und anstehende Spiele) pro Tag, nach Liga gruppiert, eigene Teams oben.
// Daten über die eigene Supabase-Funktion „fussball“ (?fb=1): grosse Ligen, Champions League und Nationalteams aus Big Balls,
// 2. Bundesliga aus OpenLigaDB, Schweizer Ligen aus Sportradar. UCL/PL mit Sportradar-Aufstellungen und Live-Statistik (?fbdetail=). Zugang und Profil wie im Basketball-Bereich (gate.js, Profil aus dem Speicher).

import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC } from '../config.js';
import { tvOf } from './tv.js';

const DATA_URL = `${SUPABASE_URL}/functions/v1/fussball`;
const LIVE_POLL_MS = 60 * 1000;
const IDLE_POLL_MS = 10 * 60 * 1000;
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MON = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};
try { sessionStorage.setItem('el-started', '1'); } catch { /* privates Fenster */ } // siehe start-boot.js
// Ohne Profil zurück zum Basketball-Bereich (dort Anmeldung)
if (!store.get('el-profile-name', '')) { try { sessionStorage.setItem('el-next', location.pathname); } catch { /* privates Fenster */ } location.replace('../basketball/euroleague/'); }

// Lieblingsteams: genaue Teamnamen (lokal gespeichert, im Profilmenü wählbar). Ältere Geräte haben nur Stichwörter
// (el-fb-fav) – die werden beim ersten Laden der Spiele in Teamnamen umgewandelt.
const LEGACY_FAV = (() => {
  try { const v = JSON.parse(store.get('el-fb-fav', 'null')); if (Array.isArray(v) && v.length) return v.map(String); } catch { /* kaputt */ }
  return [];
})();
let FAV = (() => {
  try { const v = JSON.parse(store.get('el-fb-fav2', 'null')); if (Array.isArray(v)) return new Map(v.map((n) => [String(n).toLowerCase(), String(n)])); } catch { /* kaputt */ }
  return null;
})();
const saveFav = () => store.set('el-fb-fav2', JSON.stringify([...FAV.values()]));

// Wie im Basketball-Bereich: Teams hängen am Profil (Funktion „euroleague“), damit sie auf allen Geräten gelten.
// Lokal bleibt eine Kopie, damit die Seite sofort und auch ohne Netz die richtigen Teams zeigt.
async function profileCall(body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/euroleague`, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return (await res.json().catch(() => null)) || { ok: false };
  } catch { return { ok: false }; }
}
const profileAuth = () => ({ name: store.get('el-profile-name', ''), pin: store.get('el-profile-pin', '') });
let favSaveTimer = 0;
function pushFav() {
  clearTimeout(favSaveTimer);
  favSaveTimer = setTimeout(async () => {
    const a = profileAuth();
    if (!a.name || !a.pin || !FAV) return;
    const res = await profileCall({ kind: 'profile-fbsave', ...a, fbFavorites: [...FAV.values()] });
    if (!res.ok) toast('Teams nur auf diesem Gerät gespeichert – Profil gerade nicht erreichbar.');
  }, 800);
}
// Stand der Teams im Profil: undefined = Antwort steht aus, 'none' = keine gespeichert, 'offline' = nicht erreichbar, 'ok'
let profileFav;
async function pullFav() {
  const a = profileAuth();
  const res = a.name && a.pin ? await profileCall({ kind: 'profile-login', ...a }) : { ok: false };
  if (!res.ok) profileFav = 'offline';
  else if (Array.isArray(res.fbFavorites) && res.fbFavorites.length) {
    profileFav = 'ok';
    if (sheet?.id === 'fav') return; // gerade am Wählen: nicht dazwischenfunken
    FAV = new Map(res.fbFavorites.map((n) => [String(n).toLowerCase(), String(n)])); saveFav();
    render();
    if (menuOpen) renderMenu();
  } else profileFav = 'none';
  settleFav();
}
// Nach Profil-Antwort und Spielplan: Teams vom Gerät ins leere Profil übernehmen – oder, wenn es nirgends Teams gibt,
// die Auswahl öffnen (Pflicht, mindestens ein Team)
function settleFav() {
  if (!data || profileFav === undefined || profileFav === 'ok') return;
  if (FAV?.size) { if (profileFav === 'none') { pushFav(); profileFav = 'ok'; } return; }
  if (!sheet) openFav(true);
}

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zParts = (d, opts) => {
  const o = {};
  try { new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hourCycle: 'h23', ...opts }).formatToParts(d).forEach((x) => { o[x.type] = x.value; }); } catch { /* alter Browser */ }
  return o;
};
const zDate = (d) => { const o = zParts(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${o.year}-${o.month}-${o.day}`; };
const zTime = (d) => { const o = zParts(d, { hour: '2-digit', minute: '2-digit' }); return `${o.hour}:${o.minute}`; };
const isFavName = (n) => { const k = String(n ?? '').toLowerCase(); return FAV ? FAV.has(k) : LEGACY_FAV.some((w) => k.includes(w)); };
const isFav = (m) => isFavName(m.h) || isFavName(m.a);
const LOGO_OK = /^(https:\/\/(upload\.wikimedia\.org|i\.imgur\.com|assets\.dfb\.de|media\.api-sports\.io|(www\.)?live-football-api\.com|img\.uefa\.com|derivates\.kicker\.de|s\.hs-data\.com|api\.bigballsdata\.com\/v1\/assets)\/|data:image\/(png|jpeg|gif|webp);base64,)/;
const logo = (u) => `<span class="fb-logo">${LOGO_OK.test(u || '') ? `<img src="${esc(u)}" alt="" loading="lazy">` : ''}</span>`;

let data = null, error = '', sel = '', mineOnly = false, timer = 0;
const open = new Set();
const goalsCache = new Map(); // id → { goals, final } (nach Spielende nicht mehr neu laden)
const lastSum = new Map(); // id → Tore beim letzten Laden (neues Tor erkennen)
const goalsOf = (m) => m.goals || goalsCache.get(m.id)?.goals;
const detailTab = new Map(); // Premier League aufgeklappt: 'goals' | 'lineup' | 'stats'
const detailCache = new Map(); // `${id}|${kind}` → Antwort von ?fbdetail=
const lastFlaps = new Map();

// Blatt von unten mit Tabelle und Torschützen (grosse Ligen)
const ZONE_NAME = { cl: 'Champions League', clq: 'CL-Qualifikation', el: 'Europa League', co: 'Conference League', rel: 'Relegation', ab: 'Abstieg',
  'ucl-r16': 'Achtelfinale', 'ucl-playoff': 'Play-off-Runde', 'ucl-out': 'Ausgeschieden' };
const TABLE_LEAGUES = new Set(['ucl', 'pl', 'bl1', 'laliga', 'seriea', 'ligue1']);
const leagueCache = new Map(); // `${id}|${kind}` → Antwort von ?fbleague=
// Desktop-Dashboard (drei Spalten, Grenze wie in fussball.css): links Ligen und Teams, rechts Tabelle, Torschützen, letzte Tore
const DASH = matchMedia('(min-width:1100px)');
let focusLg = '', tableLg = ''; // Filter der Spielliste; gewählte Tabelle (leer = erste Liga des Tages)
let sheet = null; // { id, tab: 'table' | 'scorers' } // Spielstand-Zeichen der letzten Anzeige: geänderte Blätter klappen um

function dayLabel(key) {
  const today = zDate(new Date());
  const t = new Date(`${today}T12:00:00`), d = new Date(`${key}T12:00:00`);
  const diff = Math.round((d - t) / 864e5);
  return diff === 0 ? 'Heute' : diff === -1 ? 'Gestern' : diff === 1 ? 'Morgen' : WD[d.getDay()];
}

function status(m) {
  if (m.st === 'ft') return '<span class="fb-st ft">Ende</span>';
  if (m.st === 'ht') return '<span class="fb-st live">HZ</span>';
  if (m.st === 'live') return `<span class="fb-st live">${m.min ? `${m.min}'` : '<i class="live-dot" aria-hidden="true"></i>Live'}</span>`;
  if (m.st === 'off') return `<span class="fb-st off">${esc(/postpon/i.test(m.note) ? 'Verschoben' : /cancel/i.test(m.note) ? 'Abgesagt' : 'Unterbr.')}</span>`;
  return `<span class="fb-st">${zTime(new Date(m.utc))}</span>`;
}

function goalsHtml(m) {
  const goals = goalsOf(m);
  if (m.st === 'pre') return `<p>Anpfiff ${zTime(new Date(m.utc))} Uhr${m.round ? ` · ${esc(/^\d+$/.test(m.round) ? `${m.round}. Runde` : m.round)}` : ''}</p>`;
  if (!goals) return '<p>Lade Torschützen …</p>';
  if (!goals.length) return `<p>${m.hs || m.as ? 'Keine Angaben zu den Torschützen.' : 'Keine Tore.'}</p>${m.ht ? `<span class="fb-ht">Halbzeit ${esc(m.ht)}</span>` : ''}`;
  const h = goals.filter((g) => g.s === 1), a = goals.filter((g) => g.s === 2);
  // Torschütze antippbar: mit Sportradar-ID direkt (Schweiz), bei Premier/Champions League über die Aufstellung gesucht
  const who = (g) => (g.id ? `<button type="button" class="fb-lu-pl" data-act="fb-player" data-pid="${esc(g.id)}">${esc(g.n)}</button>`
    : hasExtra(m) ? `<button type="button" class="fb-lu-pl" data-act="fb-goal" data-mid="${esc(m.id)}" data-name="${esc(g.n)}">${esc(g.n)}</button>` : esc(g.n));
  return Array.from({ length: Math.max(h.length, a.length) }, (_, i) => `<span>${h[i] ? `<span class="fb-m">${esc(h[i].m)}'</span>${who(h[i])}` : ''}</span><span class="fb-a">${a[i] ? `${who(a[i])}<span class="fb-m">${esc(a[i].m)}'</span>` : ''}</span>`).join('')
    + (m.ht ? `<span class="fb-ht">Halbzeit ${esc(m.ht)}</span>` : '');
}

// Premier League: Reiter Tore · Aufstellung · Statistik im aufgeklappten Spiel
const hasExtra = (m) => ['pl', 'ucl', 'bl1', 'laliga', 'seriea', 'ligue1'].includes(m.l);
// Aufstellung als Spielfeld: Heim unten (spielt nach oben), Gast oben. Sportradar liefert die Startelf in Reihenfolge
// Torwart, dann Linie für Linie von hinten nach vorne, innerhalb der Linie von rechts nach links (aus Sicht des Teams).
function formationRows(t) {
  const sizes = String(t.formation || '').split('-').map(Number);
  if (t.start.length !== 11 || sizes.some((x) => !x) || sizes.reduce((a, b) => a + b, 0) !== 10) return null;
  const out = [[t.start[0]]]; let i = 1;
  for (const n of sizes) { out.push(t.start.slice(i, i + n)); i += n; }
  return out;
}
// Torschützen pro Seite (1 Heim, 2 Gast) für die Aufstellung: über die Spieler-ID (Sportradar), sonst über den Nachnamen.
// Eigentore zählen nicht, sonst stünde der Ball beim falschen Team.
const plainLast = (n) => String(n || '').replace(/\s*\((Pen\.|Eigentor)\)\s*$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().split(/\s+/).pop() || '';
function scorerMap(m) {
  const sc = { 1: new Map(), 2: new Map() };
  const list = goalsOf(m) || [];
  // Manche Quellen vertauschen Heim und Gast (Teamnamen passen nicht): passt die Verteilung nur vertauscht zum Stand, tauschen
  const c1 = list.filter((g) => g.s === 1).length, c2 = list.length - c1;
  const swap = m.hs != null && (c1 !== m.hs || c2 !== m.as) && c1 === m.as && c2 === m.hs;
  for (const g0 of list) {
    const g = swap ? { ...g0, s: 3 - g0.s } : g0;
    if (/\(Eigentor\)/.test(g.n || '') || !sc[g.s]) continue;
    for (const k of [g.id ? `id:${g.id}` : '', g.n ? `n:${plainLast(g.n)}` : ''].filter(Boolean)) sc[g.s].set(k, (sc[g.s].get(k) || 0) + 1);
  }
  return sc;
}
const goalsBy = (sc, side, id, name) => (id && sc[side].get(`id:${String(id).replace(/^bb:/, '')}`)) || sc[side].get(`n:${plainLast(name)}`) || 0;
const BALL = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#14211A" stroke-width="1.4"/><path d="M12 7.2l4.2 3-1.6 4.9H9.4L7.8 10.2z" fill="#14211A"/><path d="M12 7.2V1.8M16.2 10.2l5-1.7M14.6 15.1l3.2 4.4M9.4 15.1l-3.2 4.4M7.8 10.2l-5-1.7" stroke="#14211A" stroke-width="1.3"/></svg>';
// Nationalität aus der Aufstellung (ISO-2 bzw. gb-eng/gb-sct/gb-wls/gb-nir) → Flagge, Name auf Deutsch im Titel
const UK_NAT = { 'gb-eng': ['England', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'], 'gb-sct': ['Schottland', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
  'gb-wls': ['Wales', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}'], 'gb-nir': ['Nordirland', '\u{1F1EC}\u{1F1E7}'] };
const regionName = (() => { try { return new Intl.DisplayNames(['de-CH'], { type: 'region' }); } catch { return null; } })();
function natInfo(cc) {
  const c = String(cc || '').toLowerCase();
  if (!/^([a-z]{2}|gb-(eng|sct|wls|nir))$/.test(c)) return null;
  const uk = UK_NAT[c];
  const em = uk ? uk[1] : String.fromCodePoint(...[...c.toUpperCase()].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
  let name = uk ? uk[0] : c.toUpperCase();
  if (!uk) { try { name = regionName?.of(c.toUpperCase()) || name; } catch { /* unbekannter Code */ } }
  return { em, name };
}
function natFlag(cc) {
  const n = natInfo(cc);
  return n ? `<span class="fl" role="img" aria-label="${esc(n.name)}" title="${esc(n.name)}">${n.em}</span>` : '';
}
const goalBadge = (n) => (n ? `<span class="gl" title="${n === 1 ? '1 Tor' : `${n} Tore`}">${BALL}${n > 1 ? `<b>${n}</b>` : ''}</span>` : '');
const lastName = (n) => { const w = String(n || '').trim().split(/\s+/); return w.length > 1 ? w.slice(1).join(' ') : w[0] || ''; };
function pitchHtml(m, d) {
  const hr = formationRows(d.home), ar = formationRows(d.away);
  if (!hr || !ar) return '';
  // yGoal: Torlinie, yMid: Mittellinie (in % der Feldhöhe); Gast gespiegelt
  const sc = scorerMap(m);
  const place = (rows, side, yGoal, yMid) => rows.map((line, li) => {
    const y = yGoal + (yMid - yGoal) * (li === 0 ? 0 : 0.24 + (li - 1) * (0.68 / Math.max(1, rows.length - 2)));
    return line.map((p, k) => {
      const f = (k + 1) * 100 / (line.length + 1), x = side === 'h' ? 100 - f : f;
      const g = goalsBy(sc, side === 'h' ? 1 : 2, p.id, p.n);
      // Kreis mit Nummer; Landesflagge klein oben rechts, Tor-Ball oben links
      const nat = natInfo(p.cc);
      const inner = `<span class="sh"><span class="no">${esc(p.no)}</span>${goalBadge(g)}${natFlag(p.cc)}</span><span class="nm">${esc(lastName(p.n))}</span>`, at = `style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%"`;
      const lbl = `${p.n}${nat ? `, ${nat.name}` : ''}${g ? `, ${g === 1 ? '1 Tor' : `${g} Tore`}` : ''}`;
      return p.id ? `<button type="button" class="fb-pl ${side}${li === 0 ? ' gk' : ''}" ${at} data-act="fb-player" data-pid="${esc(p.id)}" aria-label="Profil ${esc(lbl)}">${inner}</button>`
        : `<div class="fb-pl ${side}${li === 0 ? ' gk' : ''}" ${at}>${inner}</div>`;
    }).join('');
  }).join('');
  // Vereinswappen als Wasserzeichen in der jeweiligen Hälfte
  const wm = (u, pos) => (LOGO_OK.test(u || '') ? `<span class="wm ${pos}" aria-hidden="true"><img src="${esc(u)}" alt=""></span>` : '');
  return `<div class="fb-pitch" role="img" aria-label="Aufstellung ${esc(m.h)} ${esc(d.home.formation)} gegen ${esc(m.a)} ${esc(d.away.formation)}">${wm(m.al, 'top')}${wm(m.hl, 'bot')}
    <svg class="lines" viewBox="0 0 100 170" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="85" x2="100" y2="85"/><circle cx="50" cy="85" r="11"/>
      <rect x="22" y="0" width="56" height="20"/><rect x="36" y="0" width="28" height="7"/><rect x="22" y="150" width="56" height="20"/><rect x="36" y="163" width="28" height="7"/></svg>
    <span class="fm top">${logo(m.al)}${esc(d.away.formation)}</span><span class="fm bot">${logo(m.hl)}${esc(d.home.formation)}</span>
    ${place(hr, 'h', 94.5, 52)}${place(ar, 'a', 5.5, 48)}</div>`;
}
function lineupHtml(m) {
  const d = detailCache.get(`${m.id}|lineup`);
  if (!d) return '<p class="fb-x-note">Lade Aufstellung …</p>';
  if (!d.available || !d.home || !d.away) return `<p class="fb-x-note">${esc(d.message || 'Keine Aufstellung verfügbar.')}</p>`;
  const pitch = pitchHtml(m, d);
  let body = pitch;
  if (!pitch) { // ohne brauchbare Formation: Liste wie bisher
    const n = Math.max(d.home.start.length, d.away.start.length);
    body = `<div class="fb-lu-head"><span>${logo(m.hl)}${esc(d.home.formation)}</span><span>${esc(d.away.formation)}${logo(m.al)}</span></div>` + Array.from({ length: n }, (_, i) => { const h = d.home.start[i], a = d.away.start[i];
      const nm = (p) => (p.id ? `<button type="button" class="fb-lu-pl" data-act="fb-player" data-pid="${esc(p.id)}">${esc(p.n)}</button>` : esc(p.n));
      return `<div class="fb-lu-row"><span>${h ? `<b>${esc(h.no)}</b>${natFlag(h.cc)}${nm(h)}<i>${esc(h.pos)}</i>` : ''}</span><span>${a ? `<i>${esc(a.pos)}</i>${nm(a)}${natFlag(a.cc)}<b>${esc(a.no)}</b>` : ''}</span></div>`; }).join('');
  }
  return `<div class="fb-lu">${body}${benchHtml(m, d)}
    <p class="fb-x-src">Aufstellung: ${d.src === 'bb' ? 'Big Balls' : 'Sportradar'}</p></div>`;
}
// Ersatzbank und Trainer unter dem Feld: ein Team auf einmal, Umschalter Heim/Gast (gewählte Seite pro Spiel gemerkt)
const benchSide = new Map();
function benchHtml(m, d) {
  if (!d.home.bench?.length && !d.away.bench?.length && !d.home.coach && !d.away.coach) return '';
  const cur = benchSide.get(m.id) || 'h';
  const WHISTLE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="14" r="5"/><path d="M13 11l7-5v4l-5 3"/></svg>';
  const sc = scorerMap(m);
  const pane = (t, k) => `<div class="fb-bpane" data-side="${k}"${k === cur ? '' : ' hidden'}>
    ${t.coach ? `<div class="fb-coach">${WHISTLE}<span><small>Trainer</small>${esc(t.coach)}</span></div>` : ''}
    ${t.bench?.length ? `<div class="fb-bgrid">${t.bench.map((n, i) => { const no = t.benchNo?.[i]; const inner = `${no !== '' && no != null ? `<b class="num">${esc(no)}</b>` : ''}${natFlag(t.benchCc?.[i])}<span>${esc(n)}</span>${goalBadge(goalsBy(sc, k === 'h' ? 1 : 2, t.benchIds?.[i], n))}`;
      return t.benchIds?.[i] ? `<button type="button" class="fb-bpl" data-act="fb-player" data-pid="${esc(t.benchIds[i])}">${inner}</button>` : `<span class="fb-bpl">${inner}</span>`; }).join('')}</div>` : '<p class="fb-x-note">Keine Ersatzspieler gemeldet.</p>'}</div>`;
  const btn = (k, name, u) => `<button type="button" data-act="fb-bench-side" data-id="${esc(m.id)}" data-side="${k}" aria-pressed="${k === cur}">${logo(u)}<span>${esc(name)}</span></button>`;
  return `<div class="fb-benchbox"><h4>Ersatzbank</h4><div class="fb-bseg" role="group" aria-label="Team wählen">${btn('h', m.h, m.hl)}${btn('a', m.a, m.al)}</div>${pane(d.home, 'h')}${pane(d.away, 'a')}</div>`;
}
function statsHtml(m) {
  const d = detailCache.get(`${m.id}|stats`);
  if (!d) return '<p class="fb-x-note">Lade Statistik …</p>';
  if (!d.available || !d.home || !d.away) return `<p class="fb-x-note">${m.st === 'pre' ? 'Die Live-Statistik erscheint nach Anpfiff.' : 'Live-Statistik für dieses Spiel aktuell nicht verfügbar.'}</p>`;
  const pct = (x) => (x.passes ? Math.round((x.acc / x.passes) * 100) : null);
  const lines = [['Ballbesitz', d.home.poss, d.away.poss, '%'], ['Schüsse', d.home.shots, d.away.shots], ['Aufs Tor', d.home.on, d.away.on], ['Ecken', d.home.corners, d.away.corners],
    ['Fouls', d.home.fouls, d.away.fouls], ['Gelbe Karten', d.home.yellow, d.away.yellow], ['Rote Karten', d.home.red, d.away.red], ['Pässe', d.home.passes, d.away.passes],
    ['Passquote', pct(d.home), pct(d.away), '%'], ['Paraden', d.home.saves, d.away.saves], ['Abseits', d.home.offsides, d.away.offsides]].filter((l) => l[1] != null && l[2] != null && !(l[0] === 'Rote Karten' && !l[1] && !l[2]));
  return `<div class="fb-stats">${lines.map(([n, a, b, u = '']) => { const t = (Number(a) || 0) + (Number(b) || 0), p = t ? Math.round(((Number(a) || 0) / t) * 100) : 50;
    return `<div class="fb-st-row"><span class="v">${esc(a)}${u ? ` ${u}` : ''}</span><span class="n">${esc(n)}</span><span class="v r">${esc(b)}${u ? ` ${u}` : ''}</span><span class="bar"><i style="width:${p}%"></i><i class="b" style="width:${100 - p}%"></i></span></div>`; }).join('')}
    <p class="fb-x-src">Statistik: ${esc(d.src || 'Big Balls')}${d.final || d.ended ? ' · Endstand' : ' · Live'}</p></div>`;
}
function extraHtml(m) {
  const tab = detailTab.get(m.id) || 'goals';
  const seg = `<div class="fb-seg" role="tablist">${[['goals', 'Tore'], ['lineup', 'Aufstellung'], ['stats', 'Statistik']].map(([k, t]) => `<button type="button" role="tab" data-act="fb-tab" data-id="${esc(m.id)}" data-tab="${k}" aria-selected="${tab === k}">${t}</button>`).join('')}</div>`;
  const body = tab === 'lineup' ? lineupHtml(m) : tab === 'stats' ? statsHtml(m) : `<div class="fb-detail fb-detail-in">${goalsHtml(m)}</div>`;
  return `<div class="fb-x">${seg}${body}</div>`;
}
async function loadDetail(m, kind, refresh = false) {
  const k = `${m.id}|${kind}`;
  const cached = detailCache.get(k);
  if (!refresh && cached && (cached.final || cached.available)) return;
  try {
    const res = await fetch(`${DATA_URL}?fbdetail=${encodeURIComponent(m.id)}&kind=${kind}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(30000) });
    detailCache.set(k, await res.json());
  } catch { detailCache.set(k, { available: false, message: 'Gerade nicht erreichbar.' }); }
  render();
}

function tvHtml(m) {
  if (m.st !== 'pre' && !isLive(m)) return '';
  const t = tvOf(m);
  if (!t.ch && !t.de) return '';
  return `<small class="fb-tv"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M9 2l3 4 3-4"/></svg>${t.ch ? `<span><abbr title="Schweiz">CH</abbr> ${esc(t.ch)}</span>` : ''}${t.de ? `<span><abbr title="Deutschland">D</abbr> ${esc(t.de)}</span>` : ''}</small>`;
}

function row(m) {
  const done = m.hs != null && m.as != null;
  const hw = m.st === 'ft' && m.hs > m.as, aw = m.st === 'ft' && m.as > m.hs;
  const ex = open.has(m.id);
  const live = m.st === 'live' || m.st === 'ht';
  return `<button type="button" class="fb-match${live ? ' is-live' : ''}" data-id="${esc(m.id)}" aria-expanded="${ex}">${status(m)}
    <span class="fb-teams"><span class="fb-t${hw ? ' win' : aw ? ' lose' : ''}${isFavName(m.h) ? ' fav' : ''}">${logo(m.hl)}<span>${esc(m.h)}</span></span>
      <span class="fb-t${aw ? ' win' : hw ? ' lose' : ''}${isFavName(m.a) ? ' fav' : ''}">${logo(m.al)}<span>${esc(m.a)}</span></span>${tvHtml(m)}</span>
    <span class="fb-sc">${done ? `<span class="${aw ? 'lose' : ''}">${m.hs}</span><span class="${hw ? 'lose' : ''}">${m.as}</span>` : ''}</span>
    <span class="fb-chev" aria-hidden="true">›</span></button>${ex ? (hasExtra(m) ? extraHtml(m) : `<div class="fb-detail">${goalsHtml(m)}</div>`) : ''}`;
}

// Live-Tafel zuoberst: alle laufenden Spiele (unabhängig vom gewählten Tag) als Fallblatt-Anzeige wie im Basketball-Bereich
const isLive = (m) => m.st === 'live' || m.st === 'ht';
const livesNow = () => data.matches.filter((m) => isLive(m) && (!mineOnly || isFav(m)))
  .sort((a, b) => isFav(b) - isFav(a) || a.utc.localeCompare(b.utc) || a.h.localeCompare(b.h));
function liveHtml() {
  const lives = livesNow();
  if (!lives.length) return '';
  const cards = lives.map((m) => {
    const hs = String(m.hs ?? 0), as = String(m.as ?? 0);
    const chars = [...hs, '|', ...as];
    const before = lastFlaps.get(m.id) || [];
    lastFlaps.set(m.id, chars);
    let i = 0;
    const tiles = (str) => `<span class="flaps">${[...str].map((ch) => {
      const flip = before.length && before[i] !== ch; i += 1;
      return `<span class="flap${flip ? ' flip' : ''}">${ch === ' ' ? '' : esc(ch)}</span>`;
    }).join('')}</span>`;
    const lg = data.leagues.find((l) => l.id === m.l);
    const state = m.st === 'ht' ? 'Halbzeit' : m.min ? `${m.min}. Minute` : 'Läuft';
    const last = (goalsOf(m) || []).at(-1);
    const goal = last ? `Tor ${esc(last.n || (last.s === 1 ? m.h : m.a))}${last.m !== '' ? ` ${esc(last.m)}'` : ''}` : '';
    return `<button type="button" class="live-hero fb-live-card" data-act="fb-live" data-id="${esc(m.id)}" aria-label="${esc(m.h)} ${esc(hs)}, ${esc(m.a)} ${esc(as)}, ${esc(state)}">
      <span class="flap-row">${logo(m.hl).replace('fb-logo', 'fb-logo fb-logo-lg')}<span class="flap-name">${esc(m.h)}</span>${tiles(hs)}</span>
      <span class="flap-row">${logo(m.al).replace('fb-logo', 'fb-logo fb-logo-lg')}<span class="flap-name">${esc(m.a)}</span>${(i += 1, tiles(as))}</span>
      <span class="flap-bar"><span class="flap-q"><i class="live-dot" aria-hidden="true"></i>${esc(state)}${lg ? `<span class="flap-round">&nbsp;· ${esc(lg.name)}</span>` : ''}</span>
        <span class="flap-clock">${goal ? `<span class="fb-live-goal">${goal}</span>` : ''}<span class="flap-more" aria-hidden="true">›</span></span></span></button>`;
  }).join('');
  return `<section class="fb-live" aria-label="Live-Spiele"><div class="fb-live-head"><b><i class="live-dot" aria-hidden="true"></i>Live</b><small>${lives.length} ${lives.length === 1 ? 'Spiel' : 'Spiele'}</small></div>
    <div class="hero-scroll${lives.length > 1 ? ' multi' : ''}" data-keep-scroll="fb-live">${cards}</div>${DASH.matches ? '' : tickerHtml(lives)}</section>`;
}

// Konferenz: die letzten Tore aller laufenden Spiele, neustes zuoberst (Zeit = Anpfiff + Minute, nach der Pause 15 Minuten mehr)
function tickerHtml(lives) {
  const rows = [];
  for (const m of lives) {
    const sc = [0, 0];
    for (const g of goalsOf(m) || []) {
      sc[g.s === 1 ? 0 : 1] += 1;
      const [min, extra = 0] = String(g.m).split('+').map((x) => Number(x) || 0);
      rows.push({ m, g, sc: [...sc], at: Date.parse(m.utc) + (min + extra + (min > 45 ? 15 : 0)) * 60e3 });
    }
  }
  if (!rows.length) return '';
  rows.sort((a, b) => b.at - a.at);
  return `<div class="fb-group fb-ticker"><div class="fb-g-head"><b>Letzte Tore</b><small>alle laufenden Spiele</small></div>${rows.slice(0, 5).map((r, i) => {
    const team = r.g.s === 1 ? r.m.h : r.m.a;
    return `<button type="button" class="fb-tick${i === 0 ? ' new' : ''}" data-act="fb-live" data-id="${esc(r.m.id)}"><span class="fb-tick-min">${esc(r.g.m)}'</span>${logo(r.g.s === 1 ? r.m.hl : r.m.al)}
      <span class="fb-tick-who"><b>${esc(r.g.n || team)}</b><small>${esc(r.m.h)} – ${esc(r.m.a)}</small></span><span class="fb-tick-sc">${r.sc[0]}:${r.sc[1]}</span></button>`;
  }).join('')}</div>`;
}

function render() {
  const days = $('#fbDays'), list = $('#fbList');
  if (!data) { days.innerHTML = ''; list.innerHTML = `<p class="fb-empty">${esc(error || 'Lade Spiele …')}</p>`; return; }
  // Verschobene Spiele ohne neues Datum stehen bei Sportradar mit dem alten Termin: nach 2 Tagen ausblenden
  const matches = data.matches.filter((m) => (!mineOnly || isFav(m)) && !(m.st === 'off' && Date.now() - Date.parse(m.utc) > 2 * 864e5));
  const byDay = {};
  for (const m of matches) (byDay[zDate(new Date(m.utc))] ||= []).push(m);
  const keys = Object.keys(byDay).sort();
  const today = zDate(new Date());
  if (!sel || !byDay[sel]) sel = keys.find((k) => k >= today) || keys.at(-1) || today;
  days.innerHTML = keys.map((k) => { const d = new Date(`${k}T12:00:00`), live = byDay[k].some((m) => m.st === 'live' || m.st === 'ht');
    return `<button type="button" class="fb-day${live ? ' has-live' : ''}" data-d="${k}" aria-pressed="${k === sel}"><small>${dayLabel(k)}</small><b>${d.getDate()}. ${MON[d.getMonth()]}</b><i>${byDay[k].length} ${byDay[k].length === 1 ? 'Spiel' : 'Spiele'}</i></button>`; }).join('');
  const cur = days.querySelector('[aria-pressed="true"]');
  if (cur && !days.dataset.scrolled) { days.scrollLeft = cur.offsetLeft - days.clientWidth / 2 + cur.clientWidth / 2; days.dataset.scrolled = '1'; }

  const dayMs = (byDay[sel] || []).sort((a, b) => a.utc.localeCompare(b.utc) || a.h.localeCompare(b.h));
  if (focusLg && !dayMs.some((m) => m.l === focusLg)) focusLg = '';
  const lgOnly = DASH.matches ? focusLg : '';
  const ms = lgOnly ? dayMs.filter((m) => m.l === lgOnly) : dayMs;
  const groups = [];
  const fav = ms.filter(isFav);
  if (fav.length && !mineOnly && !lgOnly) groups.push({ star: true, name: 'Meine Spiele', sub: `${fav.length} ${fav.length === 1 ? 'Spiel' : 'Spiele'}`, list: fav });
  for (const lg of orderedLeagues()) {
    const l = ms.filter((m) => m.l === lg.id);
    if (l.length) groups.push({ ...lg, sub: l[0].round ? (/^\d+$/.test(l[0].round) ? `${l[0].round}. Runde` : l[0].round) : lg.country, list: l });
  }
  const head = (g) => {
    const inner = `<span class="fb-lg" style="--c:${g.star ? 'var(--gold)' : esc(g.color)}">${g.star ? '★' : esc(g.short)}</span><b>${esc(g.name)}</b><small>${esc(g.sub || '')}</small>`;
    return !g.star && TABLE_LEAGUES.has(g.id)
      ? `<button type="button" class="fb-g-head fb-g-link" data-act="fb-table" data-id="${esc(g.id)}" aria-haspopup="dialog">${inner}<span class="fb-g-more">Tabelle ›</span></button>`
      : `<div class="fb-g-head">${inner}</div>`;
  };
  const favBar = mineOnly ? `<button type="button" class="fb-fav-edit" data-act="fb-fav" aria-haspopup="dialog">${icon('star')}<span>${FAV?.size ? `${FAV.size} ${FAV.size === 1 ? 'Team' : 'Teams'}: ${esc([...FAV.values()].join(', '))}` : 'Noch keine Teams gewählt'}</span><b>Ändern ›</b></button>` : '';
  const strip = list.querySelector('[data-keep-scroll="fb-live"]'), keep = strip ? strip.scrollLeft : 0;
  list.innerHTML = favBar + liveHtml() + (groups.length ? groups.map((g) => `<section class="fb-group">${head(g)}${g.list.map(row).join('')}</section>`).join('') : '<p class="fb-empty">An diesem Tag keine Spiele.</p>')
    + data.leagues.filter((lg) => lg.status !== 'ok').map((lg) => `<p class="fb-warn"><span class="fb-lg" style="--c:${esc(lg.color)}">${esc(lg.short)}</span>${esc(lg.name)}: ${esc(lg.message || 'nicht verfügbar')}</p>`).join('');
  const strip2 = list.querySelector('[data-keep-scroll="fb-live"]'); if (strip2) strip2.scrollLeft = keep;
  renderDash(dayMs, matches);
  $('#fbFoot').textContent = `${data.paused ? 'Live-Stände pausiert: Tageslimit der Datenquelle erreicht (Big Balls). ' : ''}Stand ${zTime(new Date(data.updated))} · Big Balls · 2. Bundesliga: OpenLigaDB · Schweiz: Sportradar`;
}

// ---------- Desktop-Dashboard: Spalten links und rechts ----------
const LEAGUE_TTL = 30 * 60 * 1000;
const leagueBusy = new Set();
// Tabelle oder Torschützen laden (Blatt und Dashboard teilen sich den Speicher; am Desktop bleibt die Seite lange offen, darum nach 30 Minuten frisch)
async function fetchLeague(id, tab) {
  const k = `${id}|${tab}`, have = leagueCache.get(k);
  if ((have && Date.now() - have.at < LEAGUE_TTL) || leagueBusy.has(k)) return false;
  leagueBusy.add(k);
  try {
    const res = await fetch(`${DATA_URL}?fbleague=${encodeURIComponent(id)}&kind=${tab}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(30000) });
    leagueCache.set(k, { ...(await res.json()), at: Date.now() });
  } catch { leagueCache.set(k, have?.available ? { ...have, at: Date.now() } : { available: false, at: Date.now() }); } // alter Stand bleibt; nächster Versuch erst nach der Frist
  leagueBusy.delete(k);
  return true;
}
const countOf = (n) => `<small>${n}</small>`;
function sideLeftHtml(dayMs, matches) {
  const lgBtn = (lg, n) => `<button type="button" class="fb-nav-i" data-act="fb-dash-pick" data-id="${esc(lg.id)}"${focusLg === lg.id ? ' aria-current="true"' : ''}><span class="fb-lg" style="--c:${esc(lg.color)}">${esc(lg.short)}</span><span class="nm">${esc(lg.name)}</span>${n ? countOf(n) : ''}</button>`;
  const leagues = orderedLeagues();
  const today = leagues.filter((lg) => dayMs.some((m) => m.l === lg.id));
  const later = leagues.filter((lg) => !today.includes(lg) && matches.some((m) => m.l === lg.id));
  const teams = new Map(allTeams().map((t) => [t.n.toLowerCase(), t]));
  const mine = [...(FAV?.values() || [])];
  return `<section class="fb-card"><h3 class="fb-side-h">${esc(dayLabel(sel))} · ${new Date(`${sel}T12:00:00`).getDate()}. ${MON[new Date(`${sel}T12:00:00`).getMonth()]}</h3>
      <button type="button" class="fb-nav-i" data-act="fb-dash-pick" data-id=""${focusLg ? '' : ' aria-current="true"'}><span class="fb-lg" style="--c:var(--pitch)">≡</span><span class="nm">Alle Ligen</span>${countOf(dayMs.length)}</button>
      ${today.map((lg) => lgBtn(lg, dayMs.filter((m) => m.l === lg.id).length)).join('')}
      <h3 class="fb-side-h">Meine Teams<button type="button" class="fb-side-more" data-act="fb-fav" aria-haspopup="dialog">Ändern</button></h3>
      ${mine.map((n) => { const t = teams.get(n.toLowerCase());
        return `<button type="button" class="fb-nav-i" data-act="fb-dash-team" data-team="${esc(n)}"${teamGame(n) ? '' : ' disabled'}>${logo(t?.logo)}<span class="nm">${esc(n)}</span></button>`; }).join('') || '<p class="fb-side-note">Noch keine Teams gewählt.</p>'}
      ${later.length ? `<h3 class="fb-side-h">Weitere</h3>${later.map((lg) => lgBtn(lg, 0)).join('')}` : ''}</section>`;
}
function sideRightHtml(lg) {
  const lives = livesNow();
  const tick = lives.length ? tickerHtml(lives) : '';
  if (!lg) return tick;
  const tabs = orderedLeagues().filter((l) => TABLE_LEAGUES.has(l.id));
  const t = leagueCache.get(`${lg.id}|table`), s = leagueCache.get(`${lg.id}|scorers`);
  let table = '<p class="fb-x-note">Lade …</p>';
  if (t && !t.available) table = '<p class="fb-x-note">Gerade nicht verfügbar.</p>';
  else if (t) {
    const zone = (rank) => (t.zones || []).find(([a, b]) => rank >= a && rank <= b)?.[2] || '';
    const rows = t.rows.filter((r) => r.rank <= 12 || isFavName(r.team));
    table = `<table class="fb-tab"><thead><tr><th>#</th><th class="tm">Team</th><th><abbr title="Spiele">Sp</abbr></th><th><abbr title="Tordifferenz">+/-</abbr></th><th><abbr title="Punkte">Pkt</abbr></th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="${zone(r.rank) ? `z-${zone(r.rank)}` : ''}${isFavName(r.team) ? ' fav' : ''}"><td class="pos">${esc(r.rank)}</td><td class="tm"><span class="fb-tmw">${logo(r.logo).replace(' loading="lazy"', '')}<span class="nm">${esc(r.team)}</span></span></td>
        <td>${esc(r.p)}</td><td>${r.gf - r.ga > 0 ? '+' : ''}${esc(r.gf - r.ga)}</td><td class="pts">${esc(r.pts)}</td></tr>`).join('')}</tbody></table>`;
  }
  const scorers = s?.available && s.rows?.length ? `<section class="fb-card"><h3 class="fb-card-h"><b>Torschützen</b><small>${esc(lg.name)}</small></h3>
    <div class="fb-sc-list">${s.rows.slice(0, 8).map((r) => `<div class="fb-scr compact${isFavName(r.team) ? ' fav' : ''}"><span class="pos">${esc(r.rank)}</span><span class="who"><b>${esc(r.n)}</b>${r.team ? `<small>${esc(r.team)}</small>` : ''}</span><span class="g">${esc(r.g)}</span></div>`).join('')}</div></section>` : '';
  return `${tick}<section class="fb-card"><h3 class="fb-card-h"><span class="fb-lg" style="--c:${esc(lg.color)}">${esc(lg.short)}</span><b>${esc(lg.name)}</b>
      <button type="button" class="fb-side-more" data-act="fb-table" data-id="${esc(lg.id)}" aria-haspopup="dialog">Ganze Tabelle ›</button></h3>
    <div class="fb-dash-seg" role="group" aria-label="Tabelle wählen">${tabs.map((l) => `<button type="button" data-act="fb-dash-lg" data-id="${esc(l.id)}" aria-pressed="${l.id === lg.id}" title="${esc(l.name)}">${esc(l.short)}</button>`).join('')}</div>${table}</section>${scorers}`;
}
function renderDash(dayMs, matches) {
  const left = $('#fbSideL'), right = $('#fbSideR');
  if (!DASH.matches) { left.innerHTML = ''; right.innerHTML = ''; return; } // Handy: nichts anzeigen und nichts laden
  const tabs = orderedLeagues().filter((l) => TABLE_LEAGUES.has(l.id));
  const id = tableLg || (TABLE_LEAGUES.has(focusLg) ? focusLg : '') || tabs.find((l) => dayMs.some((m) => m.l === l.id))?.id || tabs[0]?.id;
  const lg = tabs.find((l) => l.id === id);
  const keepL = left.scrollTop, keepR = right.scrollTop;
  left.innerHTML = sideLeftHtml(dayMs, matches);
  right.innerHTML = sideRightHtml(lg);
  left.scrollTop = keepL; right.scrollTop = keepR;
  if (lg) Promise.all([fetchLeague(lg.id, 'table'), fetchLeague(lg.id, 'scorers')]).then((r) => { if (r.some(Boolean)) render(); });
}
// Liga links gewählt: Spielliste filtern, rechts die Tabelle zeigen; ohne Spiele am gewählten Tag zum nächsten Spieltag der Liga
function pickLeague(id) {
  focusLg = focusLg === id ? '' : id;
  if (TABLE_LEAGUES.has(focusLg)) tableLg = focusLg;
  if (focusLg) {
    const days = [...new Set(data.matches.filter((m) => m.l === focusLg && (!mineOnly || isFav(m))).map((m) => zDate(new Date(m.utc))))].sort();
    if (!days.includes(sel)) { const today = zDate(new Date()); sel = days.find((k) => k >= today) || days.at(-1) || sel; delete $('#fbDays').dataset.scrolled; }
  }
  open.clear(); render(); scrollTo(0, 0);
}
// Team links gewählt: laufendes Spiel, sonst das nächste, sonst das letzte
function teamGame(n) {
  const k = n.toLowerCase(), now = Date.now();
  const all = data.matches.filter((m) => [m.h, m.a].some((x) => x?.toLowerCase() === k)).sort((a, b) => a.utc.localeCompare(b.utc));
  return all.find(isLive) || all.find((m) => m.st === 'pre' && Date.parse(m.utc) >= now) || all.at(-1);
}
// Zu einem Spiel springen und aufklappen (Live-Tafel, Ticker, Team im Dashboard)
function openMatch(m) {
  mineOnly = false; focusLg = ''; sel = zDate(new Date(m.utc)); open.add(m.id);
  document.querySelectorAll('[data-view]').forEach((x) => { if (x.dataset.view === 'all') x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
  delete $('#fbDays').dataset.scrolled;
  render();
  if (m.st !== 'pre' && !m.goals) loadGoals(m);
  document.querySelector(`.fb-match[data-id="${CSS.escape(m.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- Blatt: Tabelle / Torschützen ----------
function sheetBody(id, tab) {
  const d = leagueCache.get(`${id}|${tab}`);
  if (!d) return '<p class="fb-x-note">Lade …</p>';
  if (!d.available) return '<p class="fb-x-note">Gerade nicht verfügbar.</p>';
  if (tab === 'scorers') {
    const openLiga = d.source === 'OpenLigaDB';
    return `<div class="fb-sc-head${openLiga ? ' compact' : ''}"><span></span><span>Spieler</span><span>Tore</span>${openLiga ? '' : '<span>Vorl.</span>'}</div><div class="fb-sc-list">${d.rows.map((r) => `<div class="fb-scr${openLiga ? ' compact' : ''}${isFavName(r.team) ? ' fav' : ''}"><span class="pos">${esc(r.rank)}</span>
      <span class="who"><b>${esc(r.n)}</b>${r.team ? `<small>${esc(r.team)}</small>` : ''}</span><span class="g">${esc(r.g)}</span>${openLiga ? '' : `<span class="a">${esc(r.a)}</span>`}</div>`).join('')}</div><p class="fb-x-src">Quelle: ${esc(d.source || 'Big Balls')}</p>`;
  }
  const zone = (rank) => (d.zones || []).find(([a, b]) => rank >= a && rank <= b)?.[2] || '';
  return `<table class="fb-tab"><thead><tr><th>#</th><th class="tm">Team</th><th><abbr title="Spiele">Sp</abbr></th><th><abbr title="Tore">Tore</abbr></th><th><abbr title="Tordifferenz">+/-</abbr></th><th><abbr title="Punkte">Pkt</abbr></th></tr></thead>
    <tbody>${d.rows.map((r) => `<tr class="${zone(r.rank) ? `z-${zone(r.rank)}` : ''}${isFavName(r.team) ? ' fav' : ''}"><td class="pos">${esc(r.rank)}</td><td class="tm"><span class="fb-tmw">${logo(r.logo).replace(' loading="lazy"', '')}<span class="nm">${esc(r.team)}</span></span></td>
      <td>${esc(r.p)}</td><td>${esc(r.gf)}:${esc(r.ga)}</td><td>${r.gf - r.ga > 0 ? '+' : ''}${esc(r.gf - r.ga)}</td><td class="pts">${esc(r.pts)}</td></tr>`).join('')}</tbody></table>
    <p class="fb-zones">${(d.zones || []).map((z) => `<span class="z-${z[2]}">${ZONE_NAME[z[2]] || ''}</span>`).join('')}</p><p class="fb-x-src">Quelle: Big Balls</p>`;
}
// ---------- Blatt: Teams wählen ----------
const NATION_LEAGUES = new Set(['unl', 'wcq', 'emq', 'wc', 'em', 'fr']);
const FAV_ORDER = ['chsl', 'chcl', 'pl', 'efl', 'bl1', 'bl2', 'laliga', 'seriea', 'ligue1', 'ucl'];
// Alle Teams aus dem Spielplan: je Name einmal, mit Wappen und der Liga, unter der es in der Auswahl erscheint
function allTeams() {
  const seen = new Map();
  const rank = (l) => (NATION_LEAGUES.has(l) ? 99 : FAV_ORDER.indexOf(l) < 0 ? 50 : FAV_ORDER.indexOf(l));
  for (const m of data?.matches || []) {
    for (const [n, lg] of [[m.h, m.hl], [m.a, m.al]]) {
      if (!n) continue;
      const k = n.toLowerCase(), cur = seen.get(k);
      if (!cur || rank(m.l) < rank(cur.l)) seen.set(k, { n, logo: lg || cur?.logo || '', l: m.l });
      else if (!cur.logo && lg) cur.logo = lg;
    }
  }
  return [...seen.values()];
}
function favSheetHtml() {
  const teams = allTeams(), groups = [];
  const name = (id) => data?.leagues.find((l) => l.id === id);
  for (const id of [...FAV_ORDER, ...(data?.leagues || []).map((l) => l.id).filter((id) => !FAV_ORDER.includes(id) && !NATION_LEAGUES.has(id))]) {
    const list = teams.filter((t) => t.l === id);
    if (list.length) groups.push({ lg: name(id), title: id === 'ucl' ? 'Weitere Teams (Champions League)' : name(id)?.name, list });
  }
  const nat = teams.filter((t) => NATION_LEAGUES.has(t.l));
  if (nat.length) groups.push({ lg: { short: 'NAT', color: '#64748B' }, title: 'Nationalteams', list: nat });
  const btn = (t) => `<button type="button" class="fb-pick" data-act="fb-fav-toggle" data-team="${esc(t.n)}" aria-pressed="${isFavName(t.n)}">${logo(t.logo)}<span>${esc(t.n)}</span><i aria-hidden="true">★</i></button>`;
  return `<div class="fb-sheet-dim" data-act="fb-sheet-close"></div>
    <section class="fb-sheet" role="dialog" aria-modal="true" aria-labelledby="fbSheetTitle"><span class="fb-grab" aria-hidden="true"></span>
      <div class="fb-sheet-h"><span class="fb-lg" style="--c:var(--gold)">★</span><b id="fbSheetTitle">${sheet?.required ? 'Deine Teams' : 'Meine Teams'}</b><small class="fb-fav-n" aria-live="polite"></small>
        ${sheet?.required ? '<button type="button" class="fb-fav-done" data-act="fb-sheet-close">Fertig</button>' : '<button type="button" class="fb-sheet-x" data-act="fb-sheet-close" aria-label="Fertig">✕</button>'}</div>
      ${sheet?.required ? '<p class="fb-fav-intro">Wähle mindestens ein Team. Seine Spiele erscheinen zuoberst unter «Meine Spiele» und in der Ansicht «Meine». Ändern kannst du die Auswahl jederzeit im Profilmenü.</p>' : ''}
      <div class="fb-fav-search"><input type="search" id="fbFavQ" placeholder="Team suchen" aria-label="Team suchen" autocomplete="off"></div>
      <div class="fb-sheet-body">${groups.map((g) => `<section class="fb-pick-g"><h3><span class="fb-lg" style="--c:${esc(g.lg?.color || '#555')}">${esc(g.lg?.short || '')}</span>${esc(g.title || '')}</h3>
        <div class="fb-pick-list">${g.list.sort((a, b) => a.n.localeCompare(b.n, 'de')).map(btn).join('')}</div></section>`).join('') || '<p class="fb-x-note">Lade …</p>'}
        <p class="fb-x-note fb-pick-none" hidden>Kein Team gefunden.</p></div></section>`;
}
function favCount() {
  const n = FAV?.size || 0, el = document.querySelector('.fb-fav-n'), done = document.querySelector('.fb-fav-done');
  if (el) el.textContent = n ? `${n} gewählt` : '';
  if (done) done.disabled = !n;
}
function filterFav(q) {
  const k = q.trim().toLowerCase();
  let any = false;
  document.querySelectorAll('.fb-pick-g').forEach((g) => {
    let vis = 0;
    g.querySelectorAll('.fb-pick').forEach((b) => { const on = !k || b.dataset.team.toLowerCase().includes(k); b.hidden = !on; if (on) vis++; });
    g.hidden = !vis; if (vis) any = true;
  });
  const none = document.querySelector('.fb-pick-none'); if (none) none.hidden = any;
}
function toggleFav(n) {
  if (!FAV) FAV = new Map();
  const k = n.toLowerCase();
  if (FAV.has(k) && FAV.size <= 1) { toast('Mindestens ein Team bleibt gewählt.'); return; }
  if (FAV.has(k)) FAV.delete(k); else FAV.set(k, n);
  saveFav(); pushFav();
  document.querySelectorAll('.fb-pick').forEach((b) => { if (b.dataset.team.toLowerCase() === k) b.setAttribute('aria-pressed', String(FAV.has(k))); });
  favCount();
}

function renderSheet() {
  let el = $('#fbSheet');
  if (!sheet) { if (el) { el.remove(); document.body.classList.remove('fb-sheet-open'); } return; }
  if (sheet.id === 'player') {
    if (!el) { el = document.createElement('div'); el.id = 'fbSheet'; el.className = 'fb-sheet-wrap'; document.body.appendChild(el); document.body.classList.add('fb-sheet-open'); }
    el.innerHTML = `<div class="fb-sheet-dim" data-act="fb-sheet-close"></div>
      <section class="fb-sheet" role="dialog" aria-modal="true" aria-labelledby="fbSheetTitle"><span class="fb-grab" aria-hidden="true"></span>
        <div class="fb-sheet-h fb-ps-bar"><button type="button" class="fb-sheet-x" data-act="fb-sheet-close" aria-label="Schliessen">✕</button></div>
        <div class="fb-sheet-body">${playerHtml(playerCache.get(sheet.pid))}</div></section>`;
    return;
  }
  if (sheet.id === 'order') {
    if (!el) { el = document.createElement('div'); el.id = 'fbSheet'; el.className = 'fb-sheet-wrap'; document.body.appendChild(el); document.body.classList.add('fb-sheet-open'); }
    const keepScroll = el.querySelector('.fb-sheet-body')?.scrollTop || 0;
    el.innerHTML = orderSheetHtml();
    el.querySelector('.fb-sheet-body').scrollTop = keepScroll;
    return;
  }
  if (sheet.id === 'fav') {
    if (!el) { el = document.createElement('div'); el.id = 'fbSheet'; el.className = 'fb-sheet-wrap'; document.body.appendChild(el); document.body.classList.add('fb-sheet-open'); }
    el.innerHTML = favSheetHtml(); favCount();
    el.querySelector('#fbFavQ').addEventListener('input', (e) => filterFav(e.target.value));
    return;
  }
  const lg = data?.leagues.find((l) => l.id === sheet.id);
  if (!el) {
    el = document.createElement('div'); el.id = 'fbSheet'; el.className = 'fb-sheet-wrap';
    document.body.appendChild(el); document.body.classList.add('fb-sheet-open');
  }
  const keep = el.querySelector('.fb-sheet-body')?.scrollTop || 0;
  const tabs = [['table', 'Tabelle'], ['scorers', 'Torschützen']];
  el.innerHTML = `<div class="fb-sheet-dim" data-act="fb-sheet-close"></div>
    <section class="fb-sheet" role="dialog" aria-modal="true" aria-labelledby="fbSheetTitle"><span class="fb-grab" aria-hidden="true"></span>
      <div class="fb-sheet-h"><span class="fb-lg" style="--c:${esc(lg?.color || '#555')}">${esc(lg?.short || '')}</span><b id="fbSheetTitle">${esc(lg?.name || '')}</b>
        <button type="button" class="fb-sheet-x" data-act="fb-sheet-close" aria-label="Schliessen">✕</button></div>
      <div class="fb-seg" role="tablist">${tabs.map(([k, t]) => `<button type="button" role="tab" data-act="fb-sheet-tab" data-tab="${k}" aria-selected="${sheet.tab === k}">${t}</button>`).join('')}</div>
      <div class="fb-sheet-body">${sheetBody(sheet.id, sheet.tab)}</div></section>`;
  el.querySelector('.fb-sheet-body').scrollTop = keep;
}
async function openSheet(id, tab) {
  sheet = { id, tab }; renderSheet();
  document.querySelector('.fb-sheet-x')?.focus();
  if (await fetchLeague(id, tab) && sheet && sheet.id === id && sheet.tab === tab) renderSheet();
}
// ---------- Blatt: Reihenfolge der Ligen (lokal gespeichert) ----------
let leagueOrder = (() => { try { const v = JSON.parse(store.get('el-fb-order', 'null')); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } })();
function orderedLeagues() {
  const list = data?.leagues || [], pos = (lg, i) => { const k = leagueOrder.indexOf(lg.id); return k < 0 ? 1000 + i : k; };
  return list.map((lg, i) => ({ lg, p: pos(lg, i) })).sort((a, b) => a.p - b.p).map((x) => x.lg);
}
function orderSheetHtml() {
  const list = orderedLeagues();
  return `<div class="fb-sheet-dim" data-act="fb-sheet-close"></div>
    <section class="fb-sheet" role="dialog" aria-modal="true" aria-labelledby="fbSheetTitle"><span class="fb-grab" aria-hidden="true"></span>
      <div class="fb-sheet-h"><span class="fb-lg" style="--c:var(--blue)">≡</span><b id="fbSheetTitle">Reihenfolge der Ligen</b>
        <button type="button" class="fb-order-reset" data-act="fb-order-reset"${leagueOrder.length ? '' : ' disabled'}>Standard</button>
        <button type="button" class="fb-sheet-x" data-act="fb-sheet-close" aria-label="Fertig">✕</button></div>
      <p class="fb-fav-intro">So erscheinen die Ligen in der Spielübersicht («Meine Spiele» bleibt immer zuoberst).</p>
      <div class="fb-sheet-body"><ol class="fb-order">${list.map((lg, i) => `<li><span class="fb-lg" style="--c:${esc(lg.color)}">${esc(lg.short)}</span><span class="nm">${esc(lg.name)}</span>
        <button type="button" class="fb-order-b" data-act="fb-order" data-id="${esc(lg.id)}" data-dir="-1" aria-label="${esc(lg.name)} nach oben"${i ? '' : ' disabled'}>↑</button>
        <button type="button" class="fb-order-b" data-act="fb-order" data-id="${esc(lg.id)}" data-dir="1" aria-label="${esc(lg.name)} nach unten"${i < list.length - 1 ? '' : ' disabled'}>↓</button></li>`).join('')}</ol></div></section>`;
}
function moveLeague(id, dir) {
  const ids = orderedLeagues().map((lg) => lg.id), i = ids.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  leagueOrder = ids; store.set('el-fb-order', JSON.stringify(ids));
  renderSheet(); render();
  document.querySelector(`.fb-order-b[data-id="${CSS.escape(id)}"][data-dir="${dir}"]:not(:disabled)`)?.focus();
}

// ---------- Blatt: Spielerprofil (Sportradar + Wikipedia) ----------
const playerCache = new Map();
const MON_S = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];
function ageOf(birth) {
  const b = new Date(`${birth}T12:00:00`); if (Number.isNaN(b.getTime())) return null;
  const n = new Date(); let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}
const dash = (v) => (v == null ? '–' : esc(v));
function playerHtml(d) {
  if (!d) return '<p class="fb-x-note">Lade Profil …</p>';
  if (!d.available) return `<p class="fb-x-note">${esc(d.message || 'Profil gerade nicht verfügbar.')}</p>`;
  d = { ...d, name: String(d.name || ''), seasons: d.seasons || [], games: d.games || [], career: d.career || [] };
  const age = ageOf(d.birth), [y, mo, da] = String(d.birth).split('-');
  const ini = d.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const facts = [['Alter', age != null ? `${age} (${Number(da)}.${Number(mo)}.${y})` : null], ['Nation', d.nation], ['Grösse / Gewicht', d.height ? `${d.height} cm${d.weight ? ` · ${d.weight} kg` : ''}` : null], ['Starker Fuss', d.foot]]
    .filter((f) => f[1]);
  // Saisonwerte: nur die jüngste Saison, pro Wettbewerb eine Zeile
  const year = d.seasons.map((x) => x.year).sort().at(-1);
  const seas = d.seasons.filter((x) => (x.cur || x.year === year) && x.st.gp);
  const fee = (t) => (t.fee ? `${t.fee >= 1e6 ? `${Math.round(t.fee / 1e5) / 10} Mio.` : `${Math.round(t.fee / 1e3)}'`} €` : /loan|leih/i.test(t.type) ? 'Leihe' : /free|ablösefrei/i.test(t.type) ? 'ablösefrei' : '');
  const transfers = (d.transfers || []).map((t) => `<div class="fb-ps-st"><span class="nm">${esc(t.from)} → ${esc(t.to)}${fee(t) ? ` <small>${esc(fee(t))}</small>` : ''}</span><span class="yrs">${esc(String(t.date).slice(0, 4))}</span></div>`).join('');
  const tiles = (st, full) => `<div class="fb-ps-tiles"><div><b>${dash(st.gp)}</b><small>Spiele</small></div><div class="hi"><b>${dash(st.g)}</b><small>Tore</small></div><div class="hi"><b>${dash(st.a)}</b><small>Vorlagen</small></div><div><b>${dash(st.min)}</b><small>Minuten</small></div></div>`
    + (full && (st.sh != null || st.y != null) ? `<div class="fb-ps-tiles"><div><b>${dash(st.sh)}</b><small>Schüsse</small></div><div><b>${dash(st.on)}</b><small>aufs Tor</small></div><div><b>${dash(st.y)}</b><small>Gelb</small></div><div><b>${dash(st.r)}</b><small>Rot</small></div></div>` : '');
  const games = d.games.map((g) => {
    const t = new Date(g.utc), opp = g.home === false ? `bei ${g.h}` : g.home ? `gegen ${g.a}` : `${g.h} – ${g.a}`;
    const my = g.home === false ? g.as : g.hs, ot = g.home === false ? g.hs : g.as;
    const res = g.home == null || my == null ? 'd' : my > ot ? 'w' : my < ot ? 'l' : 'd';
    const me = [g.g ? `<b>${g.g}</b> ${g.g === 1 ? 'Tor' : 'Tore'}` : '', g.ast ? `<b>${g.ast}</b> Vorl.` : ''].filter(Boolean).join(' · ') || (g.min != null ? `${g.min}'` : g.in ? 'eingewechselt' : '');
    return `<div class="fb-ps-g"><span class="dt">${t.getDate()}.${t.getMonth() + 1}.</span><span class="vs">${esc(opp)}${g.comp ? `<small>${esc(g.comp)}</small>` : ''}</span><span class="res ${res}">${dash(g.hs)}:${dash(g.as)}</span><span class="me">${me}</span></div>`;
  }).join('');
  const clubs = d.career.filter((c) => c.kind !== 'youth'), youth = d.career.filter((c) => c.kind === 'youth');
  const yrs = (c) => (c.to == null ? `seit ${c.from}` : c.to > c.from ? `${c.from}–${c.to}` : String(c.from));
  const career = clubs.map((c, i) => `<div class="fb-ps-st${c.to == null && c.kind === 'club' && i === 0 ? ' now' : ''}"><span class="nm">${esc(c.team)}${c.loan ? ' <small>Leihe</small>' : ''}${c.kind === 'nat' ? ' <small>Nationalteam</small>' : ''}</span>
    ${c.gp != null ? `<span class="cg">${c.gp} Sp.${c.g != null ? ` · ${c.g} T.` : ''}</span>` : ''}<span class="yrs">${yrs(c)}</span></div>`).join('');
  return `<div class="fb-ps-head"><span class="fb-ps-av">${d.img ? `<img src="${esc(d.img)}" alt="">` : esc(ini)}${d.no !== '' && d.no != null ? `<span class="no">${esc(d.no)}</span>` : ''}</span>
      <div><h3 id="fbSheetTitle">${esc(d.name)}</h3><p>${esc([d.club, d.pos].filter(Boolean).join(' · '))}</p></div></div>
    ${facts.length ? `<div class="fb-ps-sec"><div class="fb-ps-facts">${facts.map(([k, v]) => `<div><small>${k}</small><b>${esc(v)}</b></div>`).join('')}</div></div>` : ''}
    ${seas.map((x, i) => `<div class="fb-ps-sec"><h4>Saison ${esc(x.year || x.season)} · ${esc(x.comp)}</h4>${tiles(x.st, i === 0)}</div>`).join('')}
    ${games ? `<div class="fb-ps-sec"><h4>Letzte Spiele</h4><div class="fb-ps-games">${games}</div></div>` : ''}
    ${transfers ? `<div class="fb-ps-sec"><h4>Transfers</h4><div class="fb-ps-career">${transfers}</div></div>` : ''}
    ${career ? `<div class="fb-ps-sec"><h4>Karriere</h4><div class="fb-ps-career">${career}</div>${youth.length ? `<p class="fb-ps-youth">Jugend: ${esc(youth.map((c) => c.team).join(', '))}</p>` : ''}</div>` : ''}
    <p class="fb-x-src">Quellen: ${String(d.id).startsWith("bb:") ? "Big Balls" : "Sportradar"}${d.career.length || d.img ? ` · Karriere${d.img ? ' und Foto' : ''}: Wikipedia/Wikimedia` : ''}</p>`;
}
// Torschütze ohne ID (Big Balls): in der Aufstellung des Spiels (Sportradar) über den Namen suchen
const normName = (n) => String(n || '').replace(/\s*\((Pen\.|Eigentor)\)\s*$/, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
async function openScorer(mid, name) {
  const m = data?.matches.find((x) => x.id === mid);
  if (!m) return;
  const k = `${mid}|lineup`;
  if (!detailCache.get(k)?.available) await loadDetail(m, 'lineup');
  const d = detailCache.get(k);
  const want = normName(name), last = want.split(' ').pop(), first = want[0];
  const all = [];
  for (const t of [d?.home, d?.away]) {
    if (!t) continue;
    for (const p of t.start || []) all.push({ id: p.id, n: p.n });
    (t.bench || []).forEach((n, i) => all.push({ id: t.benchIds?.[i], n }));
  }
  const cand = all.filter((p) => p.id);
  const hit = cand.find((p) => normName(p.n) === want)
    || cand.filter((p) => normName(p.n).split(' ').pop() === last).find((p, _, arr) => arr.length === 1 || normName(p.n)[0] === first);
  if (hit) openPlayer(hit.id); else toast('Zu diesem Torschützen gibt es kein Profil.');
}
async function openPlayer(pid) {
  sheet = { id: 'player', pid }; renderSheet();
  document.querySelector('.fb-sheet-x')?.focus();
  if (playerCache.has(pid)) return;
  let d = null;
  try {
    const res = await fetch(`${DATA_URL}?fbplayer=${encodeURIComponent(pid)}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(45000) });
    d = await res.json();
    if (!res.ok || !d || typeof d !== 'object') d = null;
  } catch { /* Netz oder Zeitüberschreitung */ }
  // Nur gültige Profile merken; sonst Meldung zeigen und beim nächsten Antippen erneut versuchen
  if (d?.available) playerCache.set(pid, d);
  if (sheet?.id === 'player' && sheet.pid === pid) {
    if (!d?.available) playerCache.set(pid, { available: false, message: d?.message || 'Profil gerade nicht erreichbar – bitte nochmals antippen.' });
    try { renderSheet(); } catch { /* Darstellung fehlgeschlagen */ }
    if (!d?.available) playerCache.delete(pid);
  }
}

function closeSheet() {
  if (sheet?.id === 'player') { const back = document.querySelector(`[data-act="fb-player"][data-pid="${CSS.escape(sheet.pid)}"]`); sheet = null; renderSheet(); back?.focus(); return; }
  const fav = sheet?.id === 'fav';
  if (sheet?.id === 'order') { sheet = null; renderSheet(); $('#profileBtn')?.focus(); return; }
  if (fav && sheet.required && !FAV?.size) return; // Pflicht-Auswahl: erst mit mindestens einem Team
  const back = sheet && (fav ? document.querySelector('[data-act="fb-fav"]') || $('#profileBtn') : document.querySelector(`[data-act="fb-table"][data-id="${sheet.id}"]`));
  sheet = null; renderSheet();
  if (fav) render();
  back?.focus();
}
function openFav(required = false) { sheet = { id: 'fav', required }; renderSheet(); if (!required) document.querySelector('.fb-sheet-x')?.focus(); }

// ---------- Tor-Mitteilungen (Web Push) ----------
// Das Gerät meldet sich mit Profil (Name + PIN) bei der Funktion an; bei einem Tor eines Lieblingsteams stösst die Funktion
// das Gerät an, der Service Worker (sw.js) holt die Meldung ab und zeigt sie. iPhone: nur in der App vom Home-Bildschirm.
let pushOn = false;
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standaloneApp = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function pushState() {
  if (!pushSupported()) return;
  try { const reg = await navigator.serviceWorker.getRegistration('../'); pushOn = Boolean(await reg?.pushManager.getSubscription()) && Notification.permission === 'granted'; } catch { pushOn = false; }
  if (menuOpen) renderMenu();
}
async function pushCall(body) {
  const res = await fetch(DATA_URL, { method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  return res.json().catch(() => ({ ok: false }));
}
async function togglePush() {
  if (!pushSupported()) { toast(/iphone|ipad/i.test(navigator.userAgent) && !standaloneApp() ? 'Mitteilungen gehen nur in der App vom Home-Bildschirm.' : 'Dieser Browser kann keine Mitteilungen empfangen.'); return; }
  try {
    const reg = await navigator.serviceWorker.register('../sw.js', { scope: '../' });
    await navigator.serviceWorker.ready;
    const cur = await reg.pushManager.getSubscription();
    if (pushOn && cur) {
      await pushCall({ kind: 'push-unsub', endpoint: cur.endpoint }).catch(() => {});
      await cur.unsubscribe();
      pushOn = false; toast('Mitteilungen ausgeschaltet.'); return;
    }
    if ((await Notification.requestPermission()) !== 'granted') { toast('Mitteilungen sind in den Einstellungen nicht erlaubt.'); return; }
    const key = Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = cur || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const r = await pushCall({ kind: 'push-sub', endpoint: sub.endpoint, ...profileAuth() });
    if (!r.ok) { toast(r.error === 'profil' ? 'Profil nicht gefunden – bitte neu anmelden.' : /db 40[04]/.test(r.error || '') ? 'Server: Tabelle el_fb_push fehlt in Supabase.' : `Anmelden für Mitteilungen hat nicht geklappt (${r.error || 'Server'}).`); return; }
    pushOn = true; toast('Mitteilungen eingeschaltet: Tore und Aufstellungen deiner Lieblingsteams.');
  } catch (err) { toast(`Mitteilungen konnten nicht eingeschaltet werden (${String(err?.message || err).slice(0, 80)}).`); }
}

async function load() {
  try {
    const res = await fetch(`${DATA_URL}?fb=1`, { headers: { apikey: SUPABASE_ANON_KEY }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const d = await res.json();
    if (!res.ok || !Array.isArray(d?.matches)) throw new Error(d?.error || '');
    // Sicherheitsnetz (wie in der Funktion): «live» 160 Min. nach Anpfiff mit Spielstand = beendet; die Quelle meldet das Ende nicht immer
    const stale = Date.now() - 160 * 60 * 1000;
    for (const m of d.matches) if ((m.st === 'live' || m.st === 'ht') && Date.parse(m.utc) < stale && m.hs != null && m.as != null) { m.st = 'ft'; m.min = null; }
    data = d;
    error = '';
    if (!FAV) { FAV = new Map(allTeams().filter((t) => isFavName(t.n)).map((t) => [t.n.toLowerCase(), t.n])); saveFav(); }
    settleFav();
  } catch (err) {
    if (!data) error = err?.message || 'Die Fussball-Daten sind gerade nicht erreichbar.';
  }
  render();
  // Aufgeklappte Spiele: Torschützen nachführen, bis die Quelle das Spiel als beendet meldet
  for (const id of open) {
    const m = data?.matches.find((x) => x.id === id);
    if (m && m.st !== 'pre' && !m.goals && !goalsCache.get(id)?.final) loadGoals(m);
    if (m && document.visibilityState !== 'hidden' && detailTab.get(id) === 'stats' && m.st !== 'pre' && !detailCache.get(`${id}|stats`)?.final) loadDetail(m, 'stats', true);
  }
  // Spiele ohne mitgelieferte Tore (Big Balls): bei einem neuen Tor eines Lieblingsteams die Torschützen holen, damit
  // «Letzte Tore» und die Live-Tafel sie zeigen (nicht für alle Spiele – das kostet Abfragen)
  for (const m of data?.matches || []) {
    const sum = (m.hs ?? 0) + (m.as ?? 0), before = lastSum.get(m.id);
    lastSum.set(m.id, sum);
    if (isLive(m) && !m.goals && isFav(m) && sum > 0 && before !== sum) loadGoals(m);
  }
  clearTimeout(timer);
  // Nur nachladen, solange die Seite sichtbar ist (Hintergrund-Tab oder gesperrtes Handy: keine Abfragen)
  if (document.visibilityState === 'hidden') return;
  const live = data?.matches.some((m) => m.st === 'live' || m.st === 'ht');
  // Beim Anpfiff neu laden; falls die Quelle den Start noch nicht meldet, die ersten Minuten häufiger prüfen.
  const now = Date.now();
  const matches = data?.matches || [];
  const nextKo = Math.min(...matches.filter((m) => m.st === 'pre' && Date.parse(m.utc) > now).map((m) => Date.parse(m.utc)));
  const justStarted = matches.some((m) => m.st === 'pre' && now >= Date.parse(m.utc) && now - Date.parse(m.utc) <= 5 * 60 * 1000);
  const untilKo = Number.isFinite(nextKo) ? Math.max(5 * 1000, nextKo - now) : Infinity;
  timer = setTimeout(load, live ? LIVE_POLL_MS : justStarted ? 30 * 1000 : Math.min(IDLE_POLL_MS, untilKo));
}

async function loadGoals(m) {
  if (m.goals || goalsCache.get(m.id)?.final || loadGoals.busy.has(m.id)) return;
  loadGoals.busy.add(m.id);
  try {
    const res = await fetch(`${DATA_URL}?fbgame=${encodeURIComponent(m.id)}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    // Fehler nicht speichern (sonst bliebe «Keine Angaben» stehen); Schlussstand erst, wenn die Quelle das Spiel als beendet meldet
    if (res.ok && Array.isArray(d?.goals)) goalsCache.set(m.id, { goals: d.goals, final: d.final === true || (d.final == null && m.st === 'ft') });
  } catch { /* beim nächsten Nachladen erneut */ }
  loadGoals.busy.delete(m.id);
  render();
}

loadGoals.busy = new Set();

// ---------- Kopf: Hell/Dunkel und Profil-Menü (wie im Basketball-Bereich) ----------
const ICON = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  sort: '<path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  star: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
};
const icon = (n) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[n]}</svg>`;
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function themeUi() {
  const dark = currentTheme() === 'dark', btn = $('#themeBtn');
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.setAttribute('aria-label', dark ? 'Hellen Modus einschalten' : 'Dunklen Modus einschalten');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((mt) => { mt.content = bg; });
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('el-theme', next);
  themeUi();
}
let menuOpen = false;
const profileName = store.get('el-profile-name', '');
const initials = (n) => { const w = String(n || '').trim().split(/\s+/).filter(Boolean); return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase(); };
function renderMenu() {
  const btn = $('#profileBtn'), menu = $('#profileMenu');
  btn.textContent = initials(profileName);
  btn.setAttribute('aria-expanded', String(menuOpen));
  btn.setAttribute('aria-label', `Profil ${profileName}`);
  menu.hidden = !menuOpen;
  if (!menuOpen) return;
  const item = (act, ic, label) => `<button type="button" class="pm-item" role="menuitem" data-act="${act}">${icon(ic)}<span>${label}</span></button>`;
  menu.innerHTML = `<div class="pm-head"><span class="pm-avatar" aria-hidden="true">${esc(initials(profileName))}</span><span><b>${esc(profileName)}</b><small>Teams: ${esc(FAV ? [...FAV.values()].join(', ') || 'keine' : LEGACY_FAV.join(', ') || 'keine')}</small></span></div>
    ${item('fb-fav', 'star', 'Teams wählen')}${item('fb-order-open', 'sort', 'Reihenfolge der Ligen')}${item('fb-push', 'bell', pushOn ? 'Mitteilungen (Tore, Aufstellung): Ein' : 'Mitteilungen (Tore, Aufstellung): Aus')}${item('fb-push-test', 'bell', 'Testmeldung senden')}${item('copy-link', 'share', 'Link für Home-App kopieren')}<hr>${item('profile-logout', 'logout', 'Profil abmelden')}${item('logout', 'logout', 'Von diesem Gerät abmelden')}`;
  menu.querySelector('.pm-item')?.focus();
}
function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}
async function copyLink() {
  const key = store.get('el-gate-key', '');
  if (!key) { toast('Link nicht gespeichert – im Basketball-Bereich abmelden und mit dem Zugangslink neu anmelden.'); return; }
  const url = `${location.origin}${location.pathname.replace(/fussball\/?(index\.html)?$/, '')}?key=${encodeURIComponent(key)}`;
  try { await navigator.clipboard.writeText(url); toast('Link kopiert – in der Home-App bei «Zugang nötig» einfügen.'); }
  catch { window.prompt('Link kopieren:', url); }
}
function logout() {
  let key = '';
  try { key = localStorage.getItem('el-gate-key') || ''; localStorage.removeItem('el-gate-ok'); localStorage.removeItem('el-gate-key'); if (!key) sessionStorage.setItem('el-gate-relogin', '1'); } catch { /* privates Fenster */ }
  location.href = `../${key ? `?key=${encodeURIComponent(key)}` : ''}`;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet) closeSheet(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) { menuOpen = false; renderMenu(); $('#profileBtn')?.focus(); } });

document.addEventListener('click', (e) => {
  const d = e.target.closest('.fb-day');
  if (d) { sel = d.dataset.d; open.clear(); render(); return; }
  const tab = e.target.closest('[data-view]');
  if (tab) {
    mineOnly = tab.dataset.view === 'mine'; sel = ''; focusLg = ''; open.clear();
    document.querySelectorAll('[data-view]').forEach((x) => { if (x.dataset.view === tab.dataset.view) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    render(); scrollTo(0, 0); return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (menuOpen && !e.target.closest('#profileMenu, #profileBtn')) { menuOpen = false; renderMenu(); }
  if (act === 'theme') { toggleTheme(); return; }
  if (act === 'profile-menu') { menuOpen = !menuOpen; renderMenu(); return; }
  if (act === 'copy-link') { menuOpen = false; renderMenu(); copyLink(); return; }
  if (act === 'profile-logout') { store.set('el-profile-name', ''); store.set('el-profile-pin', ''); location.href = '../basketball/euroleague/'; return; }
  if (act === 'logout') { logout(); return; }
  if (act === 'fb-fav') { menuOpen = false; renderMenu(); openFav(); return; }
  if (act === 'fb-bench-side') {
    // Nur umschalten, nicht neu zeichnen (Scrollstand und aufgeklappte Spiele bleiben)
    const b = e.target.closest('[data-side]'), box = b.closest('.fb-benchbox');
    benchSide.set(b.dataset.id, b.dataset.side);
    box.querySelectorAll('.fb-bseg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    box.querySelectorAll('.fb-bpane').forEach((p) => { p.hidden = p.dataset.side !== b.dataset.side; });
    return;
  }
  if (act === 'fb-player') { openPlayer(e.target.closest('[data-pid]').dataset.pid); return; }
  if (act === 'fb-goal') { const b = e.target.closest('[data-mid]'); openScorer(b.dataset.mid, b.dataset.name); return; }
  if (act === 'fb-push-test') {
    menuOpen = false; renderMenu();
    // Zuerst prüfen, ob dieses Gerät überhaupt angemeldet ist – sonst sagen, woran es liegt
    if (!pushSupported()) { toast(/iphone|ipad/i.test(navigator.userAgent) && !standaloneApp() ? 'Mitteilungen gehen nur in der App vom Home-Bildschirm.' : 'Dieser Browser kann keine Mitteilungen empfangen.'); return; }
    if (Notification.permission !== 'granted') { toast(Notification.permission === 'denied' ? 'Mitteilungen sind blockiert – in den iPhone-Einstellungen für diese App erlauben.' : 'Zuerst «Mitteilungen» einschalten.'); return; }
    if (!pushOn) { toast('Dieses Gerät ist noch nicht angemeldet – «Tor-Mitteilungen» einschalten.'); return; }
    toast('Testmeldung kommt in etwa 10 Sekunden – jetzt das Handy sperren.');
    pushCall({ kind: 'push-test', ...profileAuth() }).then((r) => toast(r.ok ? `Testmeldung an ${r.devices} ${r.devices === 1 ? 'Gerät' : 'Geräte'} gesendet (Antwort Push-Dienst: ${(r.status || []).join(', ')}).` : r.error === 'keine Geräte' ? 'Kein Gerät angemeldet – Mitteilungen aus- und wieder einschalten.' : 'Testmeldung hat nicht geklappt.')).catch(() => toast('Testmeldung hat nicht geklappt.'));
    return;
  }
  if (act === 'fb-push') { menuOpen = false; renderMenu(); togglePush(); return; }
  if (act === 'fb-order-open') { menuOpen = false; renderMenu(); sheet = { id: 'order' }; renderSheet(); document.querySelector('.fb-sheet-x')?.focus(); return; }
  if (act === 'fb-order') { const b = e.target.closest('[data-id]'); moveLeague(b.dataset.id, Number(b.dataset.dir)); return; }
  if (act === 'fb-order-reset') { leagueOrder = []; store.set('el-fb-order', '[]'); renderSheet(); render(); return; }
  if (act === 'fb-fav-toggle') { toggleFav(e.target.closest('[data-team]').dataset.team); return; }
  if (act === 'fb-dash-pick') { pickLeague(e.target.closest('[data-id]').dataset.id); return; }
  if (act === 'fb-dash-lg') { tableLg = e.target.closest('[data-id]').dataset.id; render(); return; }
  if (act === 'fb-dash-team') { const m = teamGame(e.target.closest('[data-team]').dataset.team); if (m) openMatch(m); return; }
  if (act === 'fb-table') { openSheet(e.target.closest('[data-id]').dataset.id, 'table'); return; }
  if (act === 'fb-sheet-close') { closeSheet(); return; }
  if (act === 'fb-sheet-tab') { openSheet(sheet.id, e.target.closest('[data-tab]').dataset.tab); return; }
  if (act === 'fb-tab') {
    const el = e.target.closest('[data-tab]'), m = data?.matches.find((x) => x.id === el.dataset.id);
    if (!m) return;
    detailTab.set(m.id, el.dataset.tab); render();
    if (el.dataset.tab !== 'goals') loadDetail(m, el.dataset.tab);
    return;
  }
  if (act === 'fb-live') {
    // Zum Spiel in der Liste springen und Torschützen aufklappen
    const m = data?.matches.find((x) => x.id === e.target.closest('[data-id]').dataset.id);
    if (!m) return;
    openMatch(m);
    return;
  }
  const b = e.target.closest('.fb-match');
  if (b) {
    const id = b.dataset.id;
    if (open.has(id)) open.delete(id); else open.add(id);
    render();
    const m = data?.matches.find((x) => x.id === id);
    if (m && open.has(id) && m.st !== 'pre' && !m.goals) loadGoals(m);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { load(); pullFav(); } else clearTimeout(timer);
});
// Ganz oben nach unten ziehen lädt die Seite neu (wie im Basketball-Bereich)
function setupPullToRefresh() {
  const THRESHOLD = 70, MAX = 110;
  const ind = document.createElement('div');
  ind.className = 'ptr'; ind.innerHTML = icon('refresh'); ind.setAttribute('aria-hidden', 'true');
  document.body.append(ind);
  let startY = null, startX = 0, dy = 0, busy = false;
  const show = (d) => {
    const pos = Math.min(d, MAX);
    ind.style.transform = `translate(-50%, ${pos - 50}px) rotate(${pos * 3}deg)`;
    ind.style.opacity = String(Math.min(pos / THRESHOLD, 1));
    ind.classList.toggle('is-ready', d >= THRESHOLD);
  };
  const reset = () => { ind.style.transform = ''; ind.style.opacity = ''; ind.classList.remove('is-ready'); };
  window.addEventListener('touchstart', (e) => {
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || sheet) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const y = e.touches[0].clientY - startY, x = e.touches[0].clientX - startX;
    // Seitwärts wischen (Tage, Fallblätter) oder nach oben scrollen: kein Aktualisieren
    if (y <= 0 || Math.abs(x) > y || window.scrollY > 0) { startY = null; reset(); return; }
    dy = y * 0.6;
    show(dy);
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (startY == null) return;
    startY = null;
    if (dy < THRESHOLD) return reset();
    busy = true;
    ind.classList.add('is-loading');
    ind.style.transform = 'translate(-50%, 20px)';
    ind.style.opacity = '1';
    location.reload();
  });
  window.addEventListener('touchcancel', () => { startY = null; reset(); });
}
// Aus einer Mitteilung geöffnet (?m=<Spiel>): nach dem Laden zum Spiel springen und Torschützen aufklappen
const openFromPush = new URLSearchParams(location.search).get('m');
DASH.addEventListener('change', () => { if (data) render(); });
themeUi();
renderMenu();
load().then(() => {
  if (new URLSearchParams(location.search).get('fav') === '1') { history.replaceState(null, '', location.pathname); openFav(); }
  const m = openFromPush && data?.matches.find((x) => x.id === openFromPush);
  if (!m) return;
  mineOnly = false; sel = zDate(new Date(m.utc)); open.add(m.id);
  // Mitteilung «Aufstellung»: gleich den Reiter Aufstellung öffnen
  const tab = new URLSearchParams(location.search).get('tab') === 'lineup' ? 'lineup' : '';
  if (tab) detailTab.set(m.id, tab);
  render();
  if (tab) loadDetail(m, tab); else if (!m.goals) loadGoals(m);
  document.querySelector(`.fb-match[data-id="${CSS.escape(m.id)}"]`)?.scrollIntoView({ block: 'center' });
});
pushState();
pullFav();
setupPullToRefresh();

// Eigene Web-App „Fussball“ (fussball/manifest.webmanifest): derselbe Offline-Speicher wie der Basketball-Bereich
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
}

// Spielerfoto in der Aufstellung lädt nicht: zurück zum Kreis mit Nummer
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('ph')) return;
  img.parentElement?.classList.remove('photo');
  img.remove();
}, true);
