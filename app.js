// Euroleague-Seite: holt alle Spiele der Saison (mit Live-Ständen) über die Supabase-Funktion „euroleague“ und die
// Meldungen aus news.json (täglich von einer Claude-Aufgabe geschrieben) und zeichnet daraus das Dashboard.
// Während ein Spiel läuft, fragt die Seite jede Minute nach, sonst alle 10 Minuten und beim Zurückkehren zur Seite.

import { SUPABASE_URL, SUPABASE_ANON_KEY, KI_NEWS_URL, RUBRIKEN } from './config.js';

const FAV = ['PAN', 'OLY', 'PAM', 'ULK']; // deine Teams
const FAV_COLOR = { PAN: '#4CC38A', OLY: '#EE5F68', PAM: '#E8935F', ULK: '#5B7CFA' };
const SHORT = { PAM: 'VAL', ULK: 'FEN', IST: 'EFS', MAD: 'RMB', TEL: 'MTA', RED: 'CZV', BAS: 'BKN', BES: 'BJK', MUN: 'FCB' };
const SHORTNAME = { PAN: 'Panathinaikos', OLY: 'Olympiacos', PAR: 'Partizan', ASV: 'ASVEL', ULK: 'Fenerbahce', BAR: 'Barcelona', ZAL: 'Zalgiris',
  MUN: 'Bayern', PAM: 'Valencia', DUB: 'Dubai', MAD: 'Real Madrid', BES: 'Besiktas', HTA: 'Hapoel TA', RED: 'Zvezda', IST: 'Efes', TEL: 'Maccabi',
  VIR: 'Virtus', MIL: 'Milano', BAS: 'Baskonia', PRS: 'Paris' };
const KEYS = { HTA: ['hapoel'], IST: ['efes'], PAN: ['panathinaikos'], OLY: ['olympiacos'], PAM: ['valencia'], ULK: ['fenerbah'],
  MAD: ['real madrid', 'real '], BAR: ['barcelona', 'barça'], RED: ['zvezda'], PAR: ['partizan'], ZAL: ['zalgiris'], VIR: ['virtus', 'bologna'],
  MIL: ['milano', 'milan', 'olimpia'], BAS: ['baskonia'], ASV: ['asvel'], MUN: ['bayern'], DUB: ['dubai'], BES: ['besiktas'], TEL: ['maccabi'], PRS: ['paris'] };
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const LIVE_POLL_MS = 60 * 1000;
const IDLE_POLL_MS = 10 * 60 * 1000;
const NEWS_POLL_MS = 30 * 60 * 1000;

// Zum Testen auf dem eigenen Rechner: ?data=datei.json statt der Supabase-Funktion
const params = new URLSearchParams(location.search);
const testData = /^[\w-]+\.json$/.test(params.get('data') || '') ? params.get('data') : '';
const DATA_URL = testData || `${SUPABASE_URL}/functions/v1/euroleague`;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};

// ---------- Hilfen ----------
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ICON = {
  ball: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M6 6c3 3 3 9 0 12M18 6c-3 3-3 9 0 12"/>',
  chat: '<path d="M4 5h16v12H8l-4 4z"/>',
  star: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5"/>',
};
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// Datum in der Schweiz (JJJJ-MM-TT, HH:MM)
const zParts = (d, opts) => {
  const o = {};
  try { new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hourCycle: 'h23', ...opts }).formatToParts(d).forEach((x) => { o[x.type] = x.value; }); } catch { /* alter Browser */ }
  return o;
};
const zDate = (d) => { const o = zParts(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${o.year}-${o.month}-${o.day}`; };
const zTime = (d) => { const o = zParts(d, { hour: '2-digit', minute: '2-digit' }); return `${o.hour}:${o.minute}`; };
function rel(dateKey) {
  const today = zDate(new Date()), tomorrow = zDate(new Date(Date.now() + 864e5));
  if (dateKey === today) return 'heute';
  if (dateKey === tomorrow) return 'morgen';
  const [y, m, d] = dateKey.split('-');
  return `${WD[new Date(Date.UTC(+y, +m - 1, +d, 12)).getUTCDay()]} ${d}.${m}.`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Zustand ----------
let data = null;       // Antwort der Funktion
let news = null;       // news.json
let dataError = '';
let sel = FAV.includes(store.get('el-team')) ? store.get('el-team') : FAV[0];
let tab = ['spiel', 'news', 'teams'].includes(store.get('el-tab')) ? store.get('el-tab') : 'spiel';
const open = { table: false, next: false };
const feedState = { q: '', src: '', expanded: new Set() };

// ---------- Ableitungen aus den Spielen ----------
function model() {
  const teams = data?.teams || {};
  const games = (data?.games || []).map((g) => ({ ...g, at: new Date(g.utc), date: zDate(new Date(g.utc)), time: zTime(new Date(g.utc)) }));
  const st = {}, hist = {};
  Object.keys(teams).forEach((c) => { st[c] = { c, s: 0, n: 0, d: 0 }; hist[c] = []; });
  games.filter((g) => g.status === 'final' && g.hs !== g.as).sort((a, b) => a.at - b.at).forEach((g) => {
    const h = st[g.home], a = st[g.away]; if (!h || !a) return;
    h.d += g.hs - g.as; a.d += g.as - g.hs;
    if (g.hs > g.as) { h.s++; a.n++; } else { a.s++; h.n++; }
    hist[g.home].push({ r: g.round, d: g.hs - g.as, w: g.hs > g.as }); hist[g.away].push({ r: g.round, d: g.as - g.hs, w: g.as > g.hs });
  });
  const table = Object.values(st).filter((t) => t.s + t.n > 0 || teams[t.c])
    .sort((x, y) => (y.s - x.s) || (x.n - y.n) || (y.d - x.d) || x.c.localeCompare(y.c));
  table.forEach((t, i) => { t.rank = i + 1; });
  const rounds = {};
  games.forEach((g) => { (rounds[g.round] = rounds[g.round] || []).push(g); });
  const roundNrs = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  // Letzter Spieltag mit Resultaten (läuft schon der nächste, aber ohne Resultat, bleibt der vorherige stehen)
  const lastPlayed = [...roundNrs].reverse().find((r) => rounds[r].some((g) => g.status === 'final'));
  const upcoming = games.filter((g) => g.status === 'pre' && g.at > Date.now() - 4 * 3600e3);
  return { teams, games, st, hist, table, rounds, lastPlayed, upcoming };
}

const name = (m, c) => m.teams[c]?.short || m.teams[c]?.name || c;
const fullName = (m, c) => m.teams[c]?.name || c;
const short = (c) => SHORT[c] || c;
const shortName = (m, c) => SHORTNAME[c] || name(m, c);
const rec = (m, c) => (m.st[c] ? `${m.st[c].s}–${m.st[c].n}` : '');
function logo(m, c, cls = '') {
  const crest = m.teams[c]?.crest || '';
  return `<span class="logo${cls ? ` ${cls}` : ''}">${/^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//.test(crest) ? `<img src="${esc(crest)}" alt="" loading="lazy">` : esc(short(c))}</span>`;
}

// „3. Viertel · 4:12“, „Halbzeit“
function liveLabel(g) {
  const n = Number((/\d+/.exec(g.period || '') || [])[0]);
  const part = n >= 1 && n <= 4 ? `${n}. Viertel` : n > 4 ? 'Verlängerung' : '';
  const clock = /^\d{1,2}:\d\d$/.test(g.clock || '') && g.clock !== '00:00' ? g.clock.replace(/^0(?=\d:)/, '') : '';
  if (part && g.clock === '00:00') return n === 2 ? 'Halbzeit' : `Ende ${n}. Viertel`;
  return [part, clock].filter(Boolean).join(' · ');
}

// Antippen öffnet den Spielbericht (openBox)
function boxTarget(node, m, g) {
  node.dataset.act = 'box'; node.dataset.code = g.code;
  node.setAttribute('role', 'button'); node.tabIndex = 0;
  node.setAttribute('aria-label', `Spielbericht ${name(m, g.home)} gegen ${name(m, g.away)}`);
}
const boxAttrs = (m, g) => `data-act="box" data-code="${g.code}" role="button" tabindex="0" aria-label="Spielbericht ${esc(name(m, g.home))} gegen ${esc(name(m, g.away))}"`;

// Eine Spielzeile: Heim | Resultat, Live-Stand oder Anspielzeit | Gast
function gameRow(m, g, hl) {
  const done = g.status === 'final';
  const side = (c, win, away) => {
    const cls = `side${away ? ' away' : ''}${done ? (win ? ' win' : ' lose') : ''}${FAV.includes(c) ? ' fav' : ''}`;
    return `<div class="${cls}">${logo(m, c)}<span class="nm"><span class="full">${esc(name(m, c))}</span><span class="short">${esc(shortName(m, c))}</span><small>${esc(rec(m, c))}</small></span></div>`;
  };
  const mid = g.status === 'final' ? `<span class="result num${hl ? ' hl' : ''}">${g.hs} : ${g.as}</span>`
    : g.status === 'live' ? `<span class="result live num"><small><i class="live-dot" aria-hidden="true"></i>${esc(liveLabel(g) || 'Live')}</small>${g.hs} : ${g.as}</span>`
    : `<span class="result open num"><small>${esc(rel(g.date))}</small>${esc(g.time)}</span>`;
  const row = el('div', `game${g.status === 'live' ? ' is-live' : ''}`, side(g.home, g.hs > g.as, false) + mid + side(g.away, g.as > g.hs, true));
  boxTarget(row, m, g);
  return row;
}

// ---------- Linke Spalte: deine Teams ----------
function niceStep(range) { for (const s of [5, 10, 20, 25, 50, 100, 200]) if (range / s <= 4) return s; return 500; }
function chartHtml(m, c) {
  const cum = []; let s = 0;
  (m.hist[c] || []).forEach((x) => { s += x.d; cum.push({ v: s, w: x.w }); });
  const total = m.st[c]?.d || 0;
  const head = `<div class="chart-head"><span class="chart-title">Korbdifferenz ${esc(short(c))}</span><span class="chart-value num">${total > 0 ? '+' : ''}${total}</span></div>`;
  if (!cum.length) return `${head}<p class="label">Noch keine Spiele.</p>`;
  const vals = cum.map((p) => p.v).concat([0]);
  const step = niceStep((Math.max(...vals) - Math.min(...vals)) || 10);
  const lo = Math.floor(Math.min(...vals) / step) * step;
  let hi = Math.ceil(Math.max(...vals) / step) * step; if (hi === lo) hi = lo + step;
  const X0 = 42, X1 = 248, Y0 = 18, Y1 = 140;
  const y = (v) => Y1 - (v - lo) / (hi - lo) * (Y1 - Y0);
  const x = (i) => (cum.length === 1 ? (X0 + X1) / 2 : X0 + 8 + i * (X1 - X0 - 8) / (cum.length - 1));
  let grid = '', labels = '';
  for (let v = lo; v <= hi; v += step) {
    grid += `<line x1="${X0}" y1="${y(v).toFixed(1)}" x2="${X1}" y2="${y(v).toFixed(1)}"/>`;
    labels += `<text x="${X0 - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`;
  }
  const pts = cum.map((p, i) => `${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`);
  const base = y(Math.max(lo, Math.min(0, hi))).toFixed(1);
  const dots = cum.map((p, i) => (i === cum.length - 1 ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.5" fill="#ECEDFA"/>`
    : p.w ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="#EE5F68"/>`)).join('');
  return `${head}<svg viewBox="0 0 260 150" role="img" aria-label="Kumulierte Korbdifferenz nach Spieltag: ${cum.map((p) => (p.v > 0 ? '+' : '') + p.v).join(', ')}. Rote Punkte sind Niederlagen.">
    <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5B7CFA" stop-opacity="0.55"/><stop offset="1" stop-color="#5B7CFA" stop-opacity="0"/></linearGradient></defs>
    <g stroke="#41446F" stroke-width="1">${grid}</g>${labels}
    <path d="M${pts.join(' L')} L${x(cum.length - 1).toFixed(1)} ${base} L${x(0).toFixed(1)} ${base} Z" fill="url(#area)"/>
    <path d="M${pts.join(' L')}" fill="none" stroke="#8FA6FF" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
}

function nextHtml(m, c) {
  const g = m.games.find((x) => x.status !== 'final' && (x.home === c || x.away === c) && x.at > Date.now() - 4 * 3600e3);
  if (!g) return `<div class="who">${logo(m, c)}<div><span class="label">Nächstes Spiel</span><strong>Noch nicht im Spielplan</strong></div></div>`;
  const home = g.home === c, opp = home ? g.away : g.home;
  const when = g.status === 'live' ? `<span class="live-text"><i class="live-dot" aria-hidden="true"></i>${g.hs}:${g.as}</span><small>${esc(liveLabel(g) || 'Live')}</small>`
    : `${esc(rel(g.date))} ${esc(g.time)}<small>Spieltag ${g.round} · ${home ? 'Heimspiel' : 'Auswärts'}</small>`;
  return `<div class="who"><span class="pair" aria-hidden="true">${logo(m, c)}${logo(m, opp)}</span>
      <div><span class="label">${g.status === 'live' ? 'Läuft gerade' : 'Nächstes Spiel'} · ${esc(short(c))}</span><strong>${home ? 'gegen ' : 'bei '}${esc(name(m, opp))}</strong></div></div>
    <div class="next-foot"><button type="button" class="btn-ghost" data-act="open-next">Spielplan</button><div class="when num">${when}</div></div>`;
}

function renderLeft(m) {
  const left = $('#left');
  const chips = FAV.map((c) => `<button type="button" class="chip" style="--c:${FAV_COLOR[c]}" data-team="${c}" aria-pressed="${c === sel}" aria-label="${esc(fullName(m, c))}, ${esc(rec(m, c))}"><b>${esc(short(c))}</b><span>${esc(rec(m, c))}</span></button>`).join('');
  const star = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 3 6.5 7 .8-5.2 4.8 1.4 7L12 17.6 5.8 21l1.4-7L2 9.3l7-.8z"/></svg>';
  const cards = [...FAV].sort((a, b) => (m.st[a]?.rank || 99) - (m.st[b]?.rank || 99)).filter((c) => m.st[c]).map((c) => {
    const t = m.st[c], form = (m.hist[c] || []).slice(-5);
    return `<article class="team-card"><span class="rank">${t.rank === 1 ? star : ''}Platz ${t.rank}</span><span class="tname">${esc(name(m, c))}</span>
      <span class="rec num">${esc(rec(m, c))}</span>
      <span class="form" role="img" aria-label="Form: ${form.map((f) => (f.w ? 'Sieg' : 'Niederlage')).join(', ')}">${form.map((f) => `<i${f.w ? '' : ' class="l"'}></i>`).join('')}</span></article>`;
  }).join('');
  left.innerHTML = `<section class="panel chart" aria-label="${esc(fullName(m, sel))}, Korbdifferenz über die Saison">${chartHtml(m, sel)}</section>
    <div class="chips" role="group" aria-label="Team wählen">${chips}</div>
    <section class="panel next" aria-label="Nächstes Spiel">${nextHtml(m, sel)}</section>
    <div class="sec-head"><h2>Deine Teams</h2><span class="label">Form · letzte 5</span></div>
    <div class="teams">${cards}</div>`;
}

// ---------- Mitte: Spieltag ----------
function cardFor(g) {
  const kh = KEYS[g.home] || [], ka = KEYS[g.away] || [];
  return (news?.items || []).findIndex((it) => {
    const t = (it.title || '').toLowerCase();
    return kh.some((k) => t.includes(k)) && ka.some((k) => t.includes(k));
  });
}

function renderCenter(m) {
  const center = $('#center');
  const now = Date.now();
  const today = zDate(new Date());
  const nx = m.upcoming[0];
  const day = m.games.some((g) => g.date === today) ? today : (nx ? nx.date : '');
  const dayGames = m.games.filter((g) => g.date === day);
  const parts = [];

  // Heute
  const label = day ? (day === today ? 'Heute' : cap(rel(day))) : 'Keine Spiele angesetzt';
  const chips = dayGames.map((g) => {
    const mid = g.status === 'final' ? `${g.hs}:${g.as}` : g.status === 'live' ? `${g.hs}:${g.as}` : g.time;
    const sub = g.status === 'live' ? `<small><i class="live-dot" aria-hidden="true"></i>${esc(liveLabel(g) || 'Live')}</small>` : '';
    const fav = FAV.includes(g.home) || FAV.includes(g.away);
    return `<div class="day-game${g.status === 'final' ? ' done' : ''}${g.status === 'live' ? ' live' : ''}${fav ? ' fav' : ''}" ${boxAttrs(m, g)} title="${esc(fullName(m, g.home))} – ${esc(fullName(m, g.away))}">
      <span class="t">${logo(m, g.home, 'xs')}<b>${esc(short(g.home))}</b></span><span class="mid num">${sub}${esc(mid)}</span><span class="t away"><b>${esc(short(g.away))}</b>${logo(m, g.away, 'xs')}</span></div>`;
  }).join('');
  const liveNow = dayGames.some((g) => g.status === 'live');
  parts.push(`<section class="today" aria-label="Spiele ${day === today ? 'von heute' : 'am nächsten Spieltag'}">
    <div class="today-head"><h2>${esc(label)}${dayGames.length ? ` <span>· Spieltag ${dayGames[0].round} · ${dayGames.length} ${dayGames.length === 1 ? 'Spiel' : 'Spiele'}</span>` : ''}</h2>
      ${data ? `<span class="stand${liveNow ? ' is-live' : ''}">${liveNow ? 'Live · ' : ''}Stand ${esc(zTime(new Date(data.updated)))}</span>` : ''}</div>
    ${dayGames.length ? `<div class="day-games" data-keep-scroll="today">${chips}</div>` : ''}</section>`);

  if (dataError) parts.push(`<p class="notice">${esc(dataError)}</p>`);

  // Spiel des Tages: höchster Sieg im letzten Spieltag mit Resultaten
  const finals = m.lastPlayed ? m.rounds[m.lastPlayed].filter((g) => g.status === 'final') : [];
  const big = [...finals].sort((a, b) => Math.abs(b.hs - b.as) - Math.abs(a.hs - a.as) || b.at - a.at)[0];
  if (big) {
    const ci = cardFor(big);
    parts.push(`<section class="hero" aria-label="Spiel des Tages">
      <div class="hero-art" aria-hidden="true"><svg viewBox="0 0 300 240"><path d="M70 170a95 95 0 1 1 170 -40" fill="none" stroke="#5B7CFA" stroke-width="10" stroke-linecap="round" opacity="0.9"/><path d="M60 150a95 95 0 0 0 40 50" fill="none" stroke="#5B7CFA" stroke-width="10" stroke-linecap="round" opacity="0.5"/><ellipse cx="150" cy="212" rx="70" ry="10" fill="#1B1C38" opacity="0.6"/><circle cx="150" cy="118" r="72" fill="#E8935F"/><circle cx="150" cy="118" r="72" fill="none" stroke="#C86F3B" stroke-width="3"/><path d="M78 118h144M150 46v144M100 66c22 26 22 78 0 104M200 66c-22 26-22 78 0 104" fill="none" stroke="#4A2210" stroke-width="5" stroke-linecap="round"/><ellipse cx="124" cy="86" rx="22" ry="12" fill="#FFFFFF" opacity="0.18" transform="rotate(-30 124 86)"/></svg></div>
      <div class="hero-info"><h2>Spiel des Tages</h2><div class="score" ${boxAttrs(m, big)}>
        <div class="team"><span class="pts num">${big.hs}</span><span class="tn">${logo(m, big.home, 'xs')}${esc(name(m, big.home))}</span></div>
        <span class="arrow" aria-hidden="true">»</span>
        <div class="team"><span class="pts num">${big.as}</span><span class="tn">${logo(m, big.away, 'xs')}${esc(name(m, big.away))}</span></div></div>
        <div class="hero-actions"><span class="pill-dark num">+${Math.abs(big.hs - big.as)} <span class="dim">für ${esc(short(big.hs > big.as ? big.home : big.away))} · Spieltag ${big.round}</span></span>
        ${ci >= 0 ? `<button type="button" class="btn-accent" data-act="show-news" data-i="${ci}">Zur Meldung <span aria-hidden="true">↓</span></button>` : ''}</div></div></section>`);
  }

  // Kacheln
  const [leader, second] = m.table;
  const same = second ? m.table.filter((t) => t !== leader && t.s === second.s && t.n === second.n).length : 0;
  const tabTxt = leader && leader.s + leader.n ? `${esc(name(m, leader.c))} führt mit ${leader.s}–${leader.n}${second ? `, dahinter ${same > 1 ? `${same} Teams` : esc(name(m, second.c))} mit ${second.s}–${second.n}` : ''}.` : 'Rangliste der EuroLeague.';
  let nextTxt = 'Keine weiteren Spiele im Spielplan.';
  if (nx) {
    const started = m.rounds[nx.round].some((g) => g.status !== 'pre');
    nextTxt = started ? `Spieltag ${nx.round} läuft, nächstes Spiel ${esc(rel(nx.date))} um ${esc(nx.time)}.`
      : `Spieltag ${nx.round} startet ${esc(rel(nx.date))} um ${esc(nx.time)} mit ${esc(name(m, nx.home))} gegen ${esc(name(m, nx.away))}.`;
  }
  const avg = finals.length ? Math.round(finals.reduce((s, g) => s + g.hs + g.as, 0) / finals.length) : 0;
  parts.push(`<div class="tiles">
    <button type="button" class="tile t-blue" data-act="toggle-table" aria-expanded="${open.table}" aria-controls="tableBox"><svg viewBox="0 0 120 120" aria-hidden="true"><path d="M34 18h52v22c0 18-12 30-26 30S34 58 34 40z" fill="#8FA6FF"/><path d="M34 26H18c0 16 8 24 18 26M86 26h16c0 16-8 24-18 26" fill="none" stroke="#8FA6FF" stroke-width="8" stroke-linecap="round"/><rect x="52" y="68" width="16" height="18" fill="#7D96FF"/><rect x="36" y="86" width="48" height="14" rx="5" fill="#A9BBFF"/></svg><strong>Tabelle</strong><p>${tabTxt}</p></button>
    <button type="button" class="tile t-violet" data-act="toggle-next" aria-expanded="${open.next}" aria-controls="nextBox"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="58" r="44" fill="#9C78FF"/><path d="M16 58h88M60 14v88M30 26c14 16 14 48 0 64M90 26c-14 16-14 48 0 64" fill="none" stroke="#5A2BD6" stroke-width="6" stroke-linecap="round"/></svg><strong>Nächste Spiele</strong><p>${nextTxt}</p></button>
    <a class="tile t-coral" href="https://www.euroleaguebasketball.net/en/euroleague/stats/" target="_blank" rel="noopener"><svg viewBox="0 0 120 120" aria-hidden="true"><rect x="18" y="62" width="20" height="38" rx="6" fill="#FF9AA0"/><rect x="50" y="40" width="20" height="60" rx="6" fill="#FFB4B8"/><rect x="82" y="18" width="20" height="82" rx="6" fill="#FF9AA0"/></svg><strong>Stats ↗</strong><p>${avg ? `Ø ${avg} Punkte pro Spiel an Spieltag ${m.lastPlayed}. ` : ''}Alle Statistiken der Liga.</p></a>
  </div>`);
  center.innerHTML = parts.join('');

  // Tabelle (aus allen Resultaten berechnet)
  const tableBox = el('section', 'standings-wrap'); tableBox.id = 'tableBox'; tableBox.hidden = !open.table;
  tableBox.innerHTML = `<p class="standings-note">Rangliste EuroLeague Männer, aus allen Resultaten berechnet. Bei gleicher Bilanz entscheidet hier die Korbdifferenz.</p>
    <table class="standings-table"><thead><tr><th>#</th><th class="team-h">Team</th><th><abbr title="Spiele">Sp</abbr></th><th><abbr title="Siege">S</abbr></th><th><abbr title="Niederlagen">N</abbr></th><th class="pts"><abbr title="Korbdifferenz">+/-</abbr></th></tr></thead>
    <tbody>${m.table.map((t) => `<tr${FAV.includes(t.c) ? ' class="fav"' : ''}><td class="pos">${t.rank}</td><td class="team">${logo(m, t.c, 'xxs')}${esc(name(m, t.c))}</td><td>${t.s + t.n}</td><td>${t.s}</td><td>${t.n}</td><td class="pts">${t.d > 0 ? '+' : ''}${t.d}</td></tr>`).join('')}</tbody></table>`;
  center.appendChild(tableBox);

  // Nächste Spiele
  const nextBox = el('section', 'next-box'); nextBox.id = 'nextBox'; nextBox.hidden = !open.next; nextBox.setAttribute('aria-label', 'Nächste Spiele');
  const upRounds = [...new Set(m.games.filter((g) => g.status !== 'final' && g.at > now - 4 * 3600e3).map((g) => g.round))].slice(0, 2);
  if (!upRounds.length) nextBox.appendChild(el('p', 'label', 'Keine weiteren Spiele im Spielplan.'));
  upRounds.forEach((r) => {
    nextBox.appendChild(el('h3', '', `Spieltag ${r} · Nächste Spiele`));
    const l = el('div', 'games');
    m.rounds[r].filter((g) => g.status !== 'final').forEach((g) => l.appendChild(gameRow(m, g, false)));
    nextBox.appendChild(l);
  });
  center.appendChild(nextBox);

  // Resultate des letzten Spieltags
  if (m.lastPlayed) {
    const gs = m.rounds[m.lastPlayed];
    const pl = gs.filter((g) => g.status === 'final');
    center.appendChild(el('div', 'stats-head', `<h2>Spieltag ${m.lastPlayed} · Resultate</h2>
      <div class="facts num"><span title="Gespielte Spiele">${icon('ball')}${pl.length}<span class="sr-only"> Spiele</span></span>
      ${avg ? `<span title="Punkte pro Spiel">${icon('bars')}Ø ${avg}<span class="sr-only"> Punkte pro Spiel</span></span>` : ''}
      ${big ? `<span title="Höchster Sieg">${icon('trend')}+${Math.abs(big.hs - big.as)}<span class="sr-only"> höchster Sieg</span></span>` : ''}</div>`));
    const list = el('div', 'games');
    gs.forEach((g) => list.appendChild(gameRow(m, g, g === big)));
    center.appendChild(list);
  }

  // Ganz unten: Links zu den anderen Sport-Seiten
  center.appendChild(el('section', 'rubriken', `<h2>Weitere Rubriken</h2><nav class="rubrik-nav" aria-label="Weitere Rubriken">${RUBRIKEN.map((r) =>
    `<a class="rubrik-btn${r.active ? ' active' : ''}${r.disabled ? ' disabled' : ''}" href="${esc(r.url)}"${r.disabled ? ' aria-disabled="true" tabindex="-1"' : ''}>${esc(r.name)}</a>`).join('')}</nav>`));
}

// ---------- Rechts: News ----------
function dkey(s) { const p = String(s || '').split('.'); return p.length === 3 ? p[2] + p[1] + p[0] : ''; }
const SRC_COLOR = ['#5B7CFA', '#EE5F68', '#4CC38A', '#E8935F', '#6E3CF0'];

function renderBrand() {
  $('#issue').textContent = news ? `Ausgabe Nr. ${news.issue} · Erscheint täglich` : 'Erscheint täglich';
  $('#updated').textContent = news?.updated ? `Zuletzt aktualisiert: ${news.updated}` : '';
}

function renderFeed() {
  const items = news?.items || [];
  const newest = items.map((i) => i.firstShown).sort((a, b) => dkey(b).localeCompare(dkey(a)))[0] || '';
  const todayCH = zDate(new Date()).split('-').reverse().join('.');
  const nNew = items.filter((i) => i.firstShown === newest).length;
  const srcs = [...new Set(items.map((i) => i.source).filter(Boolean))];
  $('#feedHead').innerHTML = `<span><span class="live" aria-hidden="true"></span>${newest === todayCH ? 'Neu heute' : `Neu am ${esc(newest)}`} · ${nNew}</span><span class="num">${icon('chat')}${items.length} Meldungen</span>`;
  $('#src').innerHTML = ['', ...srcs].map((s) => `<button type="button" data-src="${esc(s)}" aria-pressed="${feedState.src === s}">${esc(s || 'Alle')}</button>`).join('');
  const q = feedState.q.trim().toLowerCase();
  let shown = 0, divided = false;
  const html = items.map((it, i) => {
    const ok = (!feedState.src || it.source === feedState.src) && (!q || `${it.tag} ${it.title} ${it.text}`.toLowerCase().includes(q));
    if (!ok) return '';
    shown++;
    const divider = !divided && !q && !feedState.src && it.firstShown !== newest ? (divided = true, '<h3 class="feed-divider">Frühere Meldungen</h3>') : '';
    const color = SRC_COLOR[srcs.indexOf(it.source) % SRC_COLOR.length] || SRC_COLOR[0];
    const openTxt = feedState.expanded.has(i);
    return `${divider}<article class="card${openTxt ? ' is-open' : ''}" id="news-${i}">
      <span class="src-avatar" style="--ac:${color}" aria-hidden="true">${esc((it.source || '?').charAt(0))}</span>
      <div class="card-top"><span class="tag">${esc(it.tag)}</span></div>
      <h2>${esc(it.title)}</h2><p>${esc(it.text)}</p>
      <button type="button" class="more" data-act="more" data-i="${i}" aria-expanded="${openTxt}">${openTxt ? 'Weniger' : 'Weiterlesen'}</button>
      <div class="card-foot"><span>${esc(it.time)}</span><div class="foot-actions">
        <button type="button" class="share-btn" data-act="share" data-i="${i}" aria-label="Meldung teilen: ${esc(it.title)}">${icon('share', '')}Teilen</button>
        <a href="${esc(/^https:\/\//.test(it.url) ? it.url : '#')}" target="_blank" rel="noopener">${esc(it.source)} ↗</a></div></div></article>`;
  }).join('');
  $('#feed').innerHTML = html + (shown ? '' : '<p class="feed-empty">Keine Meldung passt zur Suche.</p>');
  const badge = $('#newsBadge');
  if (badge) { badge.textContent = nNew; badge.hidden = !nNew; badge.setAttribute('aria-label', `${nNew} neue Meldungen`); }
}

// ---------- Zeichnen ----------
function render() {
  const m = model();
  const keep = [...document.querySelectorAll('[data-keep-scroll]')].map((n) => [n.dataset.keepScroll, n.scrollLeft]);
  renderBrand();
  renderLeft(m);
  renderCenter(m);
  for (const [k, x] of keep) { const n = document.querySelector(`[data-keep-scroll="${k}"]`); if (n) n.scrollLeft = x; }
}

function setTab(t, scroll = true) {
  tab = t;
  $('#app').dataset.tab = t;
  document.querySelectorAll('.mtabs button').forEach((b) => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  store.set('el-tab', t);
  if (scroll) window.scrollTo(0, 0);
}

function showNews(i) {
  feedState.q = ''; feedState.src = ''; $('#newsSearch').value = '';
  renderFeed();
  setTab('news', false);
  const card = document.getElementById(`news-${i}`);
  if (!card) return;
  card.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('is-flash'); void card.offsetWidth; card.classList.add('is-flash');
}

async function share(i) {
  const it = news?.items?.[i]; if (!it) return;
  const text = `${it.title}\nQuelle (${it.source}): ${it.url}\n\nGefunden auf Sport-News Euroleague: ${location.href.split('?')[0]}`;
  try {
    if (navigator.share) { await navigator.share({ title: it.title, text, url: it.url }); return; }
  } catch { return; /* abgebrochen */ }
  try { await navigator.clipboard.writeText(text); toast('Text und Link kopiert'); } catch { toast('Kopieren nicht möglich'); }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- Spielbericht ----------
const boxState = { code: 0, data: null, error: '', team: 0, timer: null };
const pct = (a) => (a[1] ? `${Math.round(a[0] / a[1] * 100)}%` : '–');
const ratio = (a) => `${a[0]}/${a[1]}`;

async function loadBox(code) {
  try {
    const url = testData ? `box-${code}.json` : `${DATA_URL}?game=${code}`;
    const res = await fetch(url, { headers: testData ? {} : { apikey: SUPABASE_ANON_KEY }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const d = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(d?.teams)) throw new Error(d?.error || `Fehler ${res.status}`);
    if (boxState.code !== code) return;
    boxState.data = d; boxState.error = '';
  } catch {
    if (boxState.code === code) boxState.error = 'Der Spielbericht ist gerade nicht erreichbar.';
  }
}

function openBox(code) {
  const dlg = $('#box');
  boxState.code = code; boxState.data = null; boxState.error = ''; boxState.team = 0;
  clearInterval(boxState.timer);
  renderBox();
  if (!dlg.open) dlg.showModal();
  const g = (data?.games || []).find((x) => x.code === code);
  if (!g || g.status === 'pre') return;
  loadBox(code).then(renderBox);
  if (g.status === 'live') boxState.timer = setInterval(async () => {
    await loadBox(code); await loadData(); renderBox(); render();
  }, 30000);
}

// Inhalt in einen inneren Rahmen: ein Klick auf den Rand des Fensters (dialog selbst) schliesst es
const setBox = (dlg, html) => { dlg.innerHTML = `<div class="box-in">${html}</div>`; };

function renderBox() {
  const dlg = $('#box');
  const m = model();
  const g = m.games.find((x) => x.code === boxState.code);
  if (!g) { dlg.textContent = ''; return; }
  const b = boxState.data;
  const status = g.status === 'live' ? `<span class="live-text"><i class="live-dot" aria-hidden="true"></i>Live${liveLabel(g) ? ` · ${esc(liveLabel(g))}` : ''}</span>`
    : g.status === 'final' ? 'Endstand' : `${esc(cap(rel(g.date)))} ${esc(g.time)}`;
  const head = `<div class="box-top"><h2 id="boxTitle">Spielbericht · Spieltag ${g.round}</h2><button type="button" class="box-close" data-act="box-close" aria-label="Schliessen">×</button></div>
    <div class="box-score">
      <div class="box-team">${logo(m, g.home)}<b>${esc(name(m, g.home))}</b><small>${esc(rec(m, g.home))}</small></div>
      <div class="box-mid"><span class="num">${g.status === 'pre' ? '–:–' : `${g.hs} : ${g.as}`}</span><small>${status}</small></div>
      <div class="box-team">${logo(m, g.away)}<b>${esc(name(m, g.away))}</b><small>${esc(rec(m, g.away))}</small></div>
    </div>`;
  if (g.status === 'pre') { setBox(dlg, `${head}<p class="box-note">Die Statistik erscheint, sobald das Spiel läuft.</p>`); return; }
  if (!b) { setBox(dlg, `${head}<p class="box-note">${esc(boxState.error || 'Lade Statistik …')}</p>`); return; }
  const [th, ta] = b.teams;
  if (!th || !ta) { setBox(dlg, `${head}<p class="box-note">Für dieses Spiel gibt es noch keine Statistik.</p>`); return; }

  // Viertel
  const qn = Math.max(b.quarters[0]?.length || 0, b.quarters[1]?.length || 0);
  const qLabel = (i) => (i < 4 ? `${i + 1}.` : `V${i > 4 ? i - 3 : ''}`);
  const qRow = (code, q) => `<tr><th scope="row">${esc(short(code))}</th>${Array.from({ length: qn }, (_, i) => `<td>${q?.[i] ?? '–'}</td>`).join('')}</tr>`;
  const quarters = qn ? `<table class="box-q num"><thead><tr><th></th>${Array.from({ length: qn }, (_, i) => `<th scope="col">${qLabel(i)}</th>`).join('')}</tr></thead>
    <tbody>${qRow(g.home, b.quarters[0])}${qRow(g.away, b.quarters[1])}</tbody></table>` : '';

  // Teamvergleich: Balken anteilig, bessere Seite hervorgehoben (bei Ballverlusten und Fouls ist weniger besser)
  const T = (t) => t.totals;
  const rows = [
    ['2-Punkte-Würfe', (t) => T(t).fg2[1] ? T(t).fg2[0] / T(t).fg2[1] : 0, (t) => `${pct(T(t).fg2)} <small>${ratio(T(t).fg2)}</small>`],
    ['3-Punkte-Würfe', (t) => T(t).fg3[1] ? T(t).fg3[0] / T(t).fg3[1] : 0, (t) => `${pct(T(t).fg3)} <small>${ratio(T(t).fg3)}</small>`],
    ['Freiwürfe', (t) => T(t).ft[1] ? T(t).ft[0] / T(t).ft[1] : 0, (t) => `${pct(T(t).ft)} <small>${ratio(T(t).ft)}</small>`],
    ['Rebounds', (t) => T(t).reb], ['Offensiv-Rebounds', (t) => T(t).oreb], ['Assists', (t) => T(t).ast],
    ['Steals', (t) => T(t).stl], ['Blocks', (t) => T(t).blk], ['Ballverluste', (t) => T(t).tov, null, true], ['Fouls', (t) => T(t).pf, null, true],
    ['Effizienz (PIR)', (t) => T(t).pir],
  ];
  const compare = rows.map(([label, val, show, lessBetter]) => {
    const a = val(th), c = val(ta), sum = Math.abs(a) + Math.abs(c) || 1;
    const better = a === c ? 0 : (a > c) !== Boolean(lessBetter) ? 1 : 2;
    return `<div class="cmp"><span class="cmp-v${better === 1 ? ' is-best' : ''}">${show ? show(th) : a}</span><span class="cmp-l">${label}</span><span class="cmp-v away${better === 2 ? ' is-best' : ''}">${show ? show(ta) : c}</span>
      <span class="cmp-bar" aria-hidden="true"><i style="width:${(Math.abs(a) / sum * 100).toFixed(1)}%"></i><i class="away" style="width:${(Math.abs(c) / sum * 100).toFixed(1)}%"></i></span></div>`;
  }).join('');

  // Spieler eines Teams
  const team = b.teams[boxState.team] || th;
  const top = Math.max(...team.players.map((p) => p.pts), 0);
  const players = team.players.map((p) => `<tr class="${p.on && b.live ? 'on' : ''}">
      <td class="no">${esc(p.no)}</td><th scope="row" class="pl">${p.on && b.live ? '<i class="live-dot" aria-label="auf dem Feld"></i>' : ''}${esc(p.name)}${p.start ? '<small>S5</small>' : ''}</th>
      <td>${esc(p.min || '–')}</td><td class="${p.pts === top && top ? 'is-top' : ''}"><b>${p.pts}</b></td><td>${p.reb}</td><td>${p.ast}</td>
      <td>${ratio(p.fg2)}</td><td>${ratio(p.fg3)}</td><td>${ratio(p.ft)}</td><td>${p.stl}</td><td>${p.tov}</td><td>${p.blk}</td><td>${p.pf}</td><td><b>${p.pir}</b></td><td>${p.pm > 0 ? '+' : ''}${p.pm}</td></tr>`).join('');
  setBox(dlg, `${head}${quarters}
    <h3>Teamvergleich</h3><div class="cmp-head"><span>${esc(short(g.home))}</span><span>${esc(short(g.away))}</span></div><div class="cmp-list">${compare}</div>
    <h3>Spieler</h3>
    <div class="seg" role="group" aria-label="Team wählen">${b.teams.map((t, i) => `<button type="button" data-act="box-team" data-i="${i}" aria-pressed="${i === boxState.team}">${esc(name(m, i === 0 ? g.home : g.away))}</button>`).join('')}</div>
    ${team.coach ? `<p class="box-coach">Trainer: ${esc(team.coach)}</p>` : ''}
    <div class="pl-wrap"><table class="pl-table num"><thead><tr><th scope="col">#</th><th scope="col" class="pl">Spieler</th><th scope="col">Min</th><th scope="col">Pkt</th><th scope="col"><abbr title="Rebounds">Reb</abbr></th><th scope="col"><abbr title="Assists">Ass</abbr></th><th scope="col"><abbr title="2-Punkte-Würfe">2P</abbr></th><th scope="col"><abbr title="3-Punkte-Würfe">3P</abbr></th><th scope="col"><abbr title="Freiwürfe">FW</abbr></th><th scope="col"><abbr title="Steals">St</abbr></th><th scope="col"><abbr title="Ballverluste">BV</abbr></th><th scope="col"><abbr title="Blocks">Bl</abbr></th><th scope="col"><abbr title="Fouls">F</abbr></th><th scope="col"><abbr title="Effizienz">PIR</abbr></th><th scope="col">+/-</th></tr></thead>
    <tbody>${players}</tbody></table></div>
    <p class="box-note small">Quelle: EuroLeague. S5 = Startformation${b.live ? ', roter Punkt = gerade auf dem Feld. Aktualisiert sich alle 30 Sekunden' : ''}.</p>`);
}

// ---------- Daten holen ----------
async function loadData() {
  try {
    const headers = testData ? {} : { apikey: SUPABASE_ANON_KEY };
    const res = await fetch(DATA_URL, { headers, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const d = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(d?.games)) throw new Error(d?.error || `Fehler ${res.status}`);
    data = d; dataError = '';
  } catch {
    dataError = data ? 'Live-Daten gerade nicht erreichbar – angezeigt wird der letzte Stand.' : 'Resultate und Spielplan sind gerade nicht erreichbar. Bitte später nochmals öffnen.';
  }
}

async function loadNews() {
  try {
    const res = await fetch('news.json', { cache: 'no-cache' });
    const n = await res.json();
    if (Array.isArray(n?.items)) { const changed = JSON.stringify(n) !== JSON.stringify(news); news = n; return changed; }
  } catch { /* behalten, was da ist */ }
  return false;
}

function liveSoon() {
  const now = Date.now();
  return (data?.games || []).some((g) => g.status === 'live' || (g.status === 'pre' && new Date(g.utc) - now < 20 * 60000 && now - new Date(g.utc) < 4 * 3600e3));
}

let dataTimer, newsAt = 0;
async function refresh({ withNews = false } = {}) {
  clearTimeout(dataTimer);
  const [, newsChanged] = await Promise.all([loadData(), withNews || Date.now() - newsAt > NEWS_POLL_MS ? loadNews() : Promise.resolve(false)]);
  if (withNews || newsChanged) { newsAt = Date.now(); renderFeed(); }
  render();
  if (document.visibilityState === 'visible') dataTimer = setTimeout(refresh, liveSoon() ? LIVE_POLL_MS : IDLE_POLL_MS);
}

// ---------- Bedienung ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act], [data-team], [data-src], .mtabs button');
  if (!t) return;
  if (t.matches('.mtabs button')) return setTab(t.dataset.tab);
  if (t.dataset.team) { sel = t.dataset.team; store.set('el-team', sel); return render(); }
  if (t.hasAttribute('data-src')) { feedState.src = t.dataset.src; return renderFeed(); }
  const act = t.dataset.act;
  if (act === 'toggle-table' || act === 'toggle-next') {
    const k = act === 'toggle-table' ? 'table' : 'next';
    open[k] = !open[k]; render();
  } else if (act === 'open-next') {
    open.next = true; setTab('spiel', false); render();
    $('#nextBox')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  } else if (act === 'show-news') showNews(Number(t.dataset.i));
  else if (act === 'more') {
    const i = Number(t.dataset.i);
    if (feedState.expanded.has(i)) feedState.expanded.delete(i); else feedState.expanded.add(i);
    renderFeed();
  } else if (act === 'share') share(Number(t.dataset.i));
  else if (act === 'box') openBox(Number(t.dataset.code));
  else if (act === 'box-close') $('#box').close();
  else if (act === 'box-team') { boxState.team = Number(t.dataset.i); renderBox(); }
});
// Spielzeilen auch mit der Tastatur öffnen
document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('[data-act="box"]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openBox(Number(t.dataset.code)); }
});
$('#newsSearch').addEventListener('input', (e) => { feedState.q = e.target.value; renderFeed(); });
$('#box').addEventListener('close', () => { clearInterval(boxState.timer); boxState.code = 0; });
// Klick neben das Fenster schliesst es
$('#box').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); else clearTimeout(dataTimer); });

// Ganz oben nach unten ziehen lädt die Seite neu (wie in iPhone-Apps) – vor allem für die Web-App vom
// Home-Bildschirm, die keinen Neu-laden-Knopf hat. Bringt neueste Spielstände, News und Version der Seite.
function setupPullToRefresh() {
  const THRESHOLD = 70, MAX = 110;
  const ind = el('div', 'ptr', icon('refresh'));
  ind.setAttribute('aria-hidden', 'true');
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
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || $('#box').open) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const y = e.touches[0].clientY - startY, x = e.touches[0].clientX - startX;
    // Seitwärts wischen (Spiele von heute) oder nach oben scrollen: kein Aktualisieren
    if (y <= 0 || Math.abs(x) > y || window.scrollY > 0) { startY = null; reset(); return; }
    dy = y * 0.6; // etwas Widerstand, wie bei iOS
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

// Marke: „Sport“ führt zur KI-News-Seite
$('#siteLink').href = KI_NEWS_URL;
setTab(tab, false);
setupPullToRefresh();
refresh({ withNews: true });
