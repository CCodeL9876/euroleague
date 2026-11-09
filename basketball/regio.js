// Schweizer Basketball im Basketball-Bereich: SB League (basketball/sbl/) und BVN 2. Liga Herren (basketball/2liga/).
// Gemeinsames Skript; die Seite sagt über <body data-league="sbl|h2l">, welcher Wettbewerb. Daten: Supabase-Funktion „basket“.
// Umschalter oben (EuroLeague · SB League · 2. Liga) wie in der Mockup-Variante A; Live-Spiele als Fallblatt-Tafel.
import { SUPABASE_URL, SUPABASE_ANON_KEY, KI_NEWS_URL } from '../config.js';

const API = `${SUPABASE_URL}/functions/v1/basket`;
const LEAGUE = document.body.dataset.league === 'h2l' ? 'h2l' : 'sbl';
const IS_SBL = LEAGUE === 'sbl';
// Eigene Teams: gemeinsame Liste mit Mein Sport (el-ch-fav, Einträge „sbl:MON“ bzw. „h2l:h2l-bc-arlesheim-2“)
const FAV_KEY = 'el-ch-fav', CH_DEFAULT = ['h2l:h2l-bc-arlesheim-2'];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const tz = 'Europe/Zurich';
const dayKey = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);
const hm = (d) => new Intl.DateTimeFormat('de-CH', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
const dayName = (key) => {
  const today = dayKey(new Date()), tomorrow = dayKey(new Date(Date.now() + 864e5)), yesterday = dayKey(new Date(Date.now() - 864e5));
  if (key === today) return 'Heute';
  if (key === tomorrow) return 'Morgen';
  if (key === yesterday) return 'Gestern';
  return new Intl.DateTimeFormat('de-CH', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(`${key}T12:00:00Z`));
};

let data = null, error = '', view = 'spiele', onlyMine = true, timer = 0;
const lastFlaps = new Map();
let favs = (() => { try { const v = JSON.parse(localStorage.getItem(FAV_KEY) || 'null'); return Array.isArray(v) ? v.map(String) : CH_DEFAULT; } catch { return CH_DEFAULT; } })();
const favKey = (t) => `${LEAGUE}:${t?.c}`;
const isFav = (t) => favs.includes(favKey(t));
const myKeys = () => favs.filter((k) => k.startsWith(`${LEAGUE}:`));

async function api(q) {
  const res = await fetch(`${API}?${q}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.error) throw new Error(j?.error || `Fehler ${res.status}`);
  return j;
}

// Wappen: SBL-Logos von Genius Sports; BVN ohne Logos → Kürzel im Kreis
// Eigene Wappen für Vereine ohne Logo in der BVN-Quelle (Datei im Ordner basketball/img)
const CLUB_LOGO = [[/arlesheim/i, '../img/bca.png']];
function crest(t, size = 'xs') {
  const own = CLUB_LOGO.find(([re]) => re.test(`${t?.c || ''} ${t?.n || ''}`))?.[1];
  if (own) return `<span class="logo ${size} club"><img src="${own}" alt="" loading="lazy"></span>`;
  if (t?.logo) return `<span class="logo ${size}"><img src="${esc(t.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  const k = String(t?.k || t?.c || t?.n || '').replace(/^[a-z0-9]+-/, '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 5) || '?';
  return `<span class="logo ${size} rg-k" aria-hidden="true">${esc(k.replace(/-\d$/, ''))}</span>`;
}
const teamName = (t) => (IS_SBL ? t.n : t.n.replace(/^(BC|CVJM|TSV|BBC|TV)\s+/, ''));

function stateLabel(g) {
  if (g.st !== 'live') return '';
  const n = g.per || 1;
  const running = g.clk && g.clk !== '00:00';
  if (!running) return n === 2 ? 'Halbzeit' : n >= 4 ? 'Ende 4. Viertel' : `Ende ${n}. Viertel`;
  return n > 4 ? 'Verlängerung' : `${n}. Viertel`;
}

function liveCard(g) {
  const running = g.clk && g.clk !== '00:00';
  const clock = running ? g.clk.replace(/^0(?=\d:)/, '') : '';
  const chars = [...String(g.hs).padStart(3, ' '), ...String(g.as).padStart(3, ' '), ...clock];
  const before = lastFlaps.get(g.id) || [];
  lastFlaps.set(g.id, chars);
  let i = 0;
  const tiles = (s) => `<span class="flaps">${[...s].map((ch) => {
    const flip = before.length && before[i] !== ch; i += 1;
    return `<span class="flap${ch === ':' ? ' sep' : ''}${flip ? ' flip' : ''}">${ch === ' ' ? '' : esc(ch)}</span>`;
  }).join('')}</span>`;
  return `<section class="live-hero" data-game="${g.id}" role="button" tabindex="0" aria-label="${esc(`${g.h.n} ${g.hs}, ${g.a.n} ${g.as}, Spielbericht öffnen`)}">
    <div class="flap-row">${crest(g.h, 'sm')}<span class="flap-name">${esc(g.h.n)}</span>${tiles(String(g.hs).padStart(3, ' '))}</div>
    <div class="flap-row">${crest(g.a, 'sm')}<span class="flap-name">${esc(g.a.n)}</span>${tiles(String(g.as).padStart(3, ' '))}</div>
    <div class="flap-bar"><span class="flap-q"><i class="live-dot" aria-hidden="true"></i>${esc(stateLabel(g))}<span class="flap-round">&nbsp;· SB League${g.round ? ` · Runde ${g.round}` : ''}</span></span>
      <span class="flap-clock">${clock ? tiles(clock) : ''}<span class="flap-more" aria-hidden="true">›</span></span></div></section>`;
}

function row(g) {
  const t = g.utc ? new Date(g.utc) : null;
  const done = g.st === 'ft' && g.hs != null;
  const live = g.st === 'live';
  const win = (a, b) => (done && a > b ? ' win' : '');
  const when = live ? '<b class="rg-live">Live</b>' : done ? '<span class="rg-end">Ende</span>' : g.st === 'open' ? '<span class="rg-end">offen</span>' : t ? esc(hm(t)) : '–';
  const mine = !onlyMine && (isFav(g.h) || isFav(g.a));
  const tag = IS_SBL ? 'button' : 'div';
  const attrs = IS_SBL && g.st !== 'pre' && g.id > 0 ? ` type="button" data-game="${g.id}"` : IS_SBL ? ' type="button" disabled' : '';
  const where = !IS_SBL && g.gym && !done ? `<small class="rg-gym">${esc(g.gym)}</small>` : '';
  return `<${tag} class="rg-row${mine ? ' mine' : ''}${done ? ' done' : ''}"${attrs}>
    <span class="rg-t num">${when}</span>
    <span class="rg-tm${win(g.hs, g.as)}">${crest(g.h)}<b>${esc(teamName(g.h))}</b>${done || live ? `<em class="num">${g.hs}</em>` : ''}</span>
    <span class="rg-tm${win(g.as, g.hs)}">${crest(g.a)}<b>${esc(teamName(g.a))}</b>${done || live ? `<em class="num">${g.as}</em>` : ''}</span>${where}</${tag}>`;
}

function groupByDay(list) {
  const out = new Map();
  for (const g of list) { const k = g.utc ? dayKey(new Date(g.utc)) : 'offen'; if (!out.has(k)) out.set(k, []); out.get(k).push(g); }
  return out;
}

function gamesView() {
  const parts = [];
  if (!data) return `<p class="notice">${esc(error || 'Lade Spiele …')}</p>`;
  let games = data.games;
  const mineList = myKeys();
  const favTeam = mineList.length ? (data.table.find((r) => isFav(r.t))?.t || games.flatMap((g) => [g.h, g.a]).find(isFav)) : null;
  if (!favTeam) onlyMine = false;
  if (favTeam) {
    parts.push(`<div class="rg-filter" role="group" aria-label="Auswahl">
      <button type="button" data-mine="1" aria-pressed="${onlyMine}">${mineList.length > 1 ? 'Meine Teams' : esc(teamName(favTeam))}</button>
      <button type="button" data-mine="0" aria-pressed="${!onlyMine}">Alle Spiele</button></div>`);
  }
  if (onlyMine && favTeam) games = games.filter((g) => isFav(g.h) || isFav(g.a));
  const lives = games.filter((g) => g.st === 'live');
  if (lives.length) parts.push(`<div class="hero-scroll${lives.length > 1 ? ' multi' : ''}" aria-label="Live-Spiele">${lives.map(liveCard).join('')}</div>`);
  const today = dayKey(new Date());
  const upcoming = games.filter((g) => g.st !== 'ft' && g.st !== 'open' && (!g.utc || dayKey(new Date(g.utc)) >= today));
  const past = games.filter((g) => !upcoming.includes(g) && g.st !== 'live').reverse();
  const section = (title, list, limit) => {
    if (!list.length) return '';
    const days = [...groupByDay(list)].slice(0, limit);
    return `<section class="rg-sec"><h2>${esc(title)}</h2>${days.map(([k, l]) => `<h3>${esc(k === 'offen' ? 'Datum noch offen' : dayName(k))}</h3><div class="rg-list">${l.map(row).join('')}</div>`).join('')}</section>`;
  };
  // Immer zuerst die nächsten Spiele, darunter die Resultate (eigenes Team: alle, sonst die nächsten bzw. letzten Spieltage)
  const next = section('Nächste Spiele', upcoming.filter((g) => g.st !== 'live'), onlyMine && favTeam ? 99 : 6);
  const done = section(onlyMine && favTeam ? 'Letzte Resultate' : 'Resultate', past, onlyMine && favTeam ? 99 : 5);
  parts.push(next, done);
  if (!upcoming.length && !past.length && !lives.length) parts.push('<p class="notice">Keine Spiele gefunden.</p>');
  parts.push(`<p class="rg-src">${IS_SBL ? 'Spielplan und Resultate: swiss.basketball · Live-Stände und Statistik: FIBA LiveStats.' : 'Daten: BVN-API (Basketball Verband Nordwestschweiz). Resultate erscheinen, sobald sie erfasst sind; live gibt es keine Stände.'}${data.updated ? ` Stand ${esc(hm(new Date(data.updated)))}.` : ''}</p>`);
  return parts.join('');
}

function tableView() {
  if (!data) return `<p class="notice">${esc(error || 'Lade Tabelle …')}</p>`;
  if (!data.table.length) return `<p class="notice">Noch keine Tabelle${IS_SBL ? ': sie entsteht aus den Resultaten, sobald die ersten Spiele beendet sind.' : '.'}</p>`;
  // Punkte: 2. Liga immer; SB League, sobald die offizielle Tabelle von swiss.basketball kommt
  const hasPts = data.table.every((r) => r.pts != null);
  const official = IS_SBL && data.tableSrc === 'swiss.basketball';
  const rows = data.table.map((r) => `<tr class="${isFav(r.t) ? 'mine' : ''}" data-fav="${esc(favKey(r.t))}">
    <td class="num">${r.rank}</td><td class="team">${crest(r.t)}<span>${esc(teamName(r.t))}</span></td><td class="num">${r.gp}</td><td class="num">${r.w}–${r.l}</td>
    <td class="num">${r.pf - r.pa > 0 ? '+' : ''}${r.pf - r.pa}</td>${hasPts ? `<td class="num"><b>${r.pts}</b></td>` : ''}</tr>`).join('');
  return `<section class="rg-sec"><h2>Tabelle</h2><div class="rg-table-wrap"><table class="rg-table">
    <thead><tr><th>#</th><th>Team</th><th>Sp</th><th>S–N</th><th>Diff</th>${hasPts ? '<th>Pkt</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    <p class="rg-src">Tippe auf ein Team, um es zu deinen Teams hinzuzufügen oder zu entfernen (auch in Mein Sport)${IS_SBL ? (official ? '. Tabelle: swiss.basketball.' : '. Die Tabelle rechnet die App aus den gesammelten Resultaten.') : '.'}</p></section>`;
}

// ---------- Spieler-Bestenlisten (nur SB League; swiss.basketball, Schnitt pro Spiel) ----------
let leaders = null, leadersErr = '', leadersBusy = false, cat = 'POINTS';
async function loadLeaders() {
  if (leadersBusy || (leaders && Date.now() - leaders.at < 30 * 60 * 1000)) return;
  leadersBusy = true;
  try { leaders = { ...(await api('sblleaders=1')), at: Date.now() }; leadersErr = ''; } catch (e) { leadersErr = `Bestenlisten nicht erreichbar (${e.message}).`; }
  leadersBusy = false;
  if (view === 'spieler') render();
}
function leadersView() {
  if (!leaders) { loadLeaders(); return `<p class="notice">${esc(leadersErr || 'Lade Bestenlisten …')}</p>`; }
  if (!leaders.cats?.length) return '<p class="notice">Noch keine Bestenlisten.</p>';
  const c = leaders.cats.find((x) => x.id === cat) || leaders.cats[0];
  const top = Number(String(c.rows[0]?.avg).replace(',', '.')) || 1;
  return `<div class="rg-filter rg-cats" role="group" aria-label="Kategorie">${leaders.cats.map((x) => `<button type="button" data-cat="${esc(x.id)}" aria-pressed="${x.id === c.id}">${esc(x.name)}</button>`).join('')}</div>
    <section class="rg-sec"><h2>${esc(c.name)} pro Spiel</h2><ol class="rg-lead">${c.rows.map((r) => {
      const v = Number(String(r.avg).replace(',', '.')) || 0;
      return `<li class="${isFav(r.t) ? 'mine' : ''}"><span class="rk num">${esc(r.rank)}</span><span class="who"><b>${esc(r.n)}</b><small>${crest(r.t)}${esc(teamName(r.t))} · ${esc(r.gp)} ${r.gp === 1 ? 'Spiel' : 'Spiele'}</small></span>
        <span class="val num">${esc(r.avg)}</span><i style="--w:${Math.max(4, Math.round((v / top) * 100))}%"></i></li>`;
    }).join('')}</ol></section>
    <p class="rg-src">Quelle: swiss.basketball${leaders.phase ? ` · ${esc(/preliminary/i.test(leaders.phase) ? 'Qualifikation' : /play.?off/i.test(leaders.phase) ? 'Playoffs' : leaders.phase)}` : ''}. Eigene Teams hervorgehoben.</p>`;
}

function render() {
  const main = $('#rgMain');
  const keep = main.querySelector('.hero-scroll')?.scrollLeft || 0;
  main.innerHTML = view === 'tabelle' ? tableView() : view === 'spieler' && IS_SBL ? leadersView() : gamesView();
  const hs = main.querySelector('.hero-scroll'); if (hs) hs.scrollLeft = keep;
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
}

async function load() {
  try {
    data = await api(IS_SBL ? 'sbl=1' : `bvn=${LEAGUE}`);
    error = '';
  } catch (e) {
    error = `Daten nicht erreichbar (${e.message}).`;
  }
  render();
  clearTimeout(timer);
  const live = data?.games?.some((g) => g.st === 'live');
  const soon = data?.games?.some((g) => g.st === 'pre' && g.utc && Math.abs(Date.parse(g.utc) - Date.now()) < 20 * 60 * 1000);
  timer = setTimeout(() => { if (!document.hidden) load(); }, live || soon ? 20000 : 5 * 60 * 1000);
}

// ---------- Spielbericht (nur SB League, FIBA LiveStats) ----------
const dlg = $('#rgBox');
let openId = 0, boxTimer = 0, boxTab = 'h';
async function openGame(id) {
  openId = id;
  dlg.innerHTML = '<div class="box-in"><div class="box-top"><h2>Spielbericht</h2><button type="button" class="box-close" data-close aria-label="Schliessen">×</button></div><p class="notice">Lade …</p></div>';
  if (!dlg.open) dlg.showModal();
  await refreshGame();
}
async function refreshGame() {
  clearTimeout(boxTimer);
  if (!openId || !dlg.open) return;
  try {
    const g = await api(`sblgame=${openId}`);
    const sc = dlg.querySelector('.box-body')?.scrollTop || 0;
    dlg.innerHTML = gameHtml(g);
    const b = dlg.querySelector('.box-body'); if (b) b.scrollTop = sc;
    if (g.st === 'live') boxTimer = setTimeout(refreshGame, 20000);
  } catch (e) {
    dlg.querySelector('.notice')?.replaceChildren(`Spielbericht nicht verfügbar (${e.message}).`);
  }
}
function gameHtml(g) {
  const state = g.st === 'live' ? `<i class="live-dot" aria-hidden="true"></i>${esc(stateLabel(g))}${g.clk && g.clk !== '00:00' ? ` · ${esc(g.clk)}` : ''}` : g.st === 'ft' ? 'Schluss' : 'Noch nicht gestartet';
  const n = Math.max(g.hq.length, g.aq.length, 4);
  const qh = Array.from({ length: n }, (_, i) => `<th>${i < 4 ? `${i + 1}.` : `OT${n > 5 ? i - 3 : ''}`}</th>`).join('');
  const qr = (t, q) => `<tr><td class="team">${crest(t)}${esc(t.c || t.n)}</td>${Array.from({ length: n }, (_, i) => `<td class="num">${q[i] ?? ''}</td>`).join('')}<td class="num"><b>${t.score}</b></td></tr>`;
  const side = boxTab === 'a' ? g.a : g.h;
  const pl = [...side.pl].sort((x, y) => y.start - x.start || y.pts - x.pts);
  const box = pl.map((p) => `<tr${p.start ? ' class="st"' : ''}><td class="num no">${esc(p.no)}</td><td class="pn">${esc(p.n)}</td><td class="num">${esc(p.min || '–')}</td><td class="num"><b>${p.pts}</b></td><td class="num">${p.reb}</td><td class="num">${p.ast}</td><td class="num">${esc(p.fg)}</td><td class="num">${esc(p.p3)}</td><td class="num">${esc(p.ft)}</td><td class="num">${p.pf}</td></tr>`).join('');
  const feed = g.pbp.slice(0, 12).map((a) => `<li><span class="gt num">Q${a.per} ${esc(a.gt)}</span><span>${crest(a.side === 1 ? g.h : g.a)}${esc(a.n)} · ${a.v === 3 ? 'Dreier' : a.v === 2 ? 'Zweier' : 'Freiwurf'}</span><b class="num">${a.s1}:${a.s2}</b></li>`).join('');
  return `<div class="box-in"><div class="box-top"><h2>SB League${g.round ? ` · Runde ${g.round}` : ''}</h2><button type="button" class="box-close" data-close aria-label="Schliessen">×</button></div>
  <div class="box-body">
  <div class="box-score"><div class="box-team">${crest(g.h, 'lg')}<b>${esc(g.h.n)}</b>${g.h.coach ? `<small>Trainer ${esc(g.h.coach)}</small>` : ''}</div>
    <div class="rg-big num">${g.h.score} : ${g.a.score}</div>
    <div class="box-team">${crest(g.a, 'lg')}<b>${esc(g.a.n)}</b>${g.a.coach ? `<small>Trainer ${esc(g.a.coach)}</small>` : ''}</div></div>
  <p class="rg-state${g.st === 'live' ? ' is-live' : ''}">${state}</p>
  <div class="rg-table-wrap"><table class="rg-table rg-q"><thead><tr><th></th>${qh}<th>Total</th></tr></thead><tbody>${qr(g.h, g.hq)}${qr(g.a, g.aq)}</tbody></table></div>
  ${feed ? `<h3 class="rg-h">Letzte Körbe</h3><ul class="rg-pbp">${feed}</ul>` : ''}
  ${side.pl.length ? `<h3 class="rg-h">Box-Score</h3><div class="rg-filter" role="group" aria-label="Team"><button type="button" data-boxtab="h" aria-pressed="${boxTab === 'h'}">${esc(g.h.n)}</button><button type="button" data-boxtab="a" aria-pressed="${boxTab === 'a'}">${esc(g.a.n)}</button></div>
  <div class="rg-table-wrap"><table class="rg-table rg-box"><thead><tr><th>#</th><th>Spieler</th><th>Min</th><th>Pkt</th><th>Reb</th><th>Ass</th><th>FG</th><th>3P</th><th>FW</th><th>F</th></tr></thead><tbody>${box}</tbody></table></div>
  <p class="rg-src">Fett: Startfünf zuoberst. Teamwerte: ${side.tot.fg}% FG, ${side.tot.p3}% 3P, ${side.tot.ft}% FW, ${side.tot.reb} Rebounds, ${side.tot.ast} Assists, ${side.tot.to} Ballverluste.</p>` : ''}
  <p class="rg-src">Live-Statistik: FIBA LiveStats.</p></div></div>`;
}

// ---------- Ereignisse ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-game],[data-view],[data-mine],[data-fav],[data-close],[data-boxtab],[data-cat]');
  if (!t) { if (e.target === dlg) dlg.close(); return; }
  if (t.dataset.close !== undefined) { dlg.close(); return; }
  if (t.dataset.boxtab) { boxTab = t.dataset.boxtab; refreshGame(); return; }
  if (t.dataset.game) { if (IS_SBL) openGame(Number(t.dataset.game)); return; }
  if (t.dataset.view) { view = t.dataset.view; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.cat) { cat = t.dataset.cat; render(); return; }
  if (t.dataset.mine) { onlyMine = t.dataset.mine === '1'; render(); return; }
  if (t.dataset.fav !== undefined) {
    const k = t.dataset.fav;
    favs = favs.includes(k) ? favs.filter((x) => x !== k) : [...favs, k].slice(-20);
    try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch { /* privat */ }
    onlyMine = myKeys().length > 0;
    render();
  }
});
document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('.live-hero[data-game]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGame(Number(t.dataset.game)); }
});
dlg.addEventListener('close', () => { openId = 0; clearTimeout(boxTimer); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
// ---------- Kopf wie auf der EuroLeague-Seite: «Sport» führt zur KI-News-Seite, Hell/Dunkel, Profil-Kürzel ----------
const siteLink = $('#siteLink');
if (siteLink) siteLink.href = KI_NEWS_URL;
const ICON = { sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>' };
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function themeUi() {
  const btn = $('#themeBtn'); if (!btn) return;
  const dark = currentTheme() === 'dark';
  btn.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${dark ? ICON.sun : ICON.moon}</svg>`;
  btn.setAttribute('aria-label', dark ? 'Hellen Modus einschalten' : 'Dunklen Modus einschalten');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((mt) => { mt.content = bg; });
}
$('#themeBtn')?.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('el-theme', next); } catch { /* privat */ }
  themeUi();
});
themeUi();
const profName = (() => { try { return localStorage.getItem('el-profile-name') || ''; } catch { return ''; } })();
const pb = $('#profileBtn');
if (pb) { const w = profName.trim().split(/\s+/).filter(Boolean); pb.textContent = (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || '?').slice(0, 2)).toUpperCase(); }

// Direktlink aus Mein Sport: basketball/sbl/?game=<Spiel-Nr.> öffnet den Spielbericht
const linkGame = Number(new URLSearchParams(location.search).get('game'));
if (IS_SBL && Number.isInteger(linkGame) && linkGame > 0) { history.replaceState(null, '', location.pathname); openGame(linkGame); }
load();
