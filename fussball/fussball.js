// Fussball-Bereich: Spielübersicht (Resultate und anstehende Spiele) pro Tag, nach Liga gruppiert, eigene Teams oben.
// Daten über die eigene Supabase-Funktion „fussball“ (?fb=1): grosse Ligen, Champions League und Nationalteams aus Big Balls,
// 2. Bundesliga aus OpenLigaDB, Schweizer Ligen aus Sportradar. Premier League mit Aufstellung und Teamstatistik (?fbdetail=). Zugang und Profil wie im Basketball-Bereich (gate.js, Profil aus dem Speicher).

import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config.js';

const DATA_URL = `${SUPABASE_URL}/functions/v1/fussball`;
const LIVE_POLL_MS = 60 * 1000;
const IDLE_POLL_MS = 10 * 60 * 1000;
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MON = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sept.', 'Okt.', 'Nov.', 'Dez.'];

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};
// Ohne Profil zurück zum Basketball-Bereich (dort Anmeldung)
if (!store.get('el-profile-name', '')) location.replace('../');

// Lieblingsteams: Stichwörter im Teamnamen (lokal gespeichert)
const FAV = (() => {
  try { const v = JSON.parse(store.get('el-fb-fav', 'null')); if (Array.isArray(v) && v.length) return v; } catch { /* kaputt */ }
  return ['liverpool', 'chelsea', 'basel', 'mainz'];
})();

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zParts = (d, opts) => {
  const o = {};
  try { new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hourCycle: 'h23', ...opts }).formatToParts(d).forEach((x) => { o[x.type] = x.value; }); } catch { /* alter Browser */ }
  return o;
};
const zDate = (d) => { const o = zParts(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${o.year}-${o.month}-${o.day}`; };
const zTime = (d) => { const o = zParts(d, { hour: '2-digit', minute: '2-digit' }); return `${o.hour}:${o.minute}`; };
const isFavName = (n) => FAV.some((k) => String(n).toLowerCase().includes(k));
const isFav = (m) => isFavName(m.h) || isFavName(m.a);
const logo = (u) => `<span class="fb-logo">${/^(https:\/\/(upload\.wikimedia\.org|i\.imgur\.com|assets\.dfb\.de|media\.api-sports\.io|(www\.)?live-football-api\.com|img\.uefa\.com|derivates\.kicker\.de|s\.hs-data\.com|api\.bigballsdata\.com\/v1\/assets)\/|data:image\/(png|jpeg|gif|webp);base64,)/.test(u || '') ? `<img src="${esc(u)}" alt="" loading="lazy">` : ''}</span>`;

let data = null, error = '', sel = '', mineOnly = false, timer = 0;
const open = new Set();
const goalsCache = new Map();
const detailTab = new Map(); // Premier League aufgeklappt: 'goals' | 'lineup' | 'stats'
const detailCache = new Map(); // `${id}|${kind}` → Antwort von ?fbdetail=
const lastFlaps = new Map();
// Blatt von unten mit Tabelle und Torschützen (grosse Ligen)
const ZONE_NAME = { cl: 'Champions League', clq: 'CL-Qualifikation', el: 'Europa League', co: 'Conference League', rel: 'Relegation', ab: 'Abstieg' };
const TABLE_LEAGUES = new Set(['pl', 'bl1', 'laliga', 'seriea', 'ligue1']);
const leagueCache = new Map(); // `${id}|${kind}` → Antwort von ?fbleague=
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
  const goals = m.goals || goalsCache.get(m.id);
  if (m.st === 'pre') return `<p>Anpfiff ${zTime(new Date(m.utc))} Uhr${m.round ? ` · ${esc(/^\d+$/.test(m.round) ? `${m.round}. Runde` : m.round)}` : ''}</p>`;
  if (!goals) return '<p>Lade Torschützen …</p>';
  if (!goals.length) return `<p>${m.hs || m.as ? 'Keine Angaben zu den Torschützen.' : 'Keine Tore.'}</p>${m.ht ? `<span class="fb-ht">Halbzeit ${esc(m.ht)}</span>` : ''}`;
  const h = goals.filter((g) => g.s === 1), a = goals.filter((g) => g.s === 2);
  return Array.from({ length: Math.max(h.length, a.length) }, (_, i) => `<span>${h[i] ? `<span class="fb-m">${esc(h[i].m)}'</span>${esc(h[i].n)}` : ''}</span><span class="fb-a">${a[i] ? `${esc(a[i].n)}<span class="fb-m">${esc(a[i].m)}'</span>` : ''}</span>`).join('')
    + (m.ht ? `<span class="fb-ht">Halbzeit ${esc(m.ht)}</span>` : '');
}

// Premier League: Reiter Tore · Aufstellung · Statistik im aufgeklappten Spiel
const hasExtra = (m) => m.l === 'pl';
function lineupHtml(m) {
  const d = detailCache.get(`${m.id}|lineup`);
  if (!d) return '<p class="fb-x-note">Lade Aufstellung …</p>';
  if (!d.available || !d.home || !d.away) return `<p class="fb-x-note">${esc(d.message || 'Keine Aufstellung verfügbar.')}</p>`;
  const n = Math.max(d.home.start.length, d.away.start.length);
  const rows = Array.from({ length: n }, (_, i) => { const h = d.home.start[i], a = d.away.start[i];
    return `<div class="fb-lu-row"><span>${h ? `<b>${esc(h.no)}</b>${esc(h.n)}<i>${esc(h.pos)}</i>` : ''}</span><span>${a ? `<i>${esc(a.pos)}</i>${esc(a.n)}<b>${esc(a.no)}</b>` : ''}</span></div>`; }).join('');
  return `<div class="fb-lu"><div class="fb-lu-head"><span>${logo(m.hl)}${esc(d.home.formation)}</span><span>${esc(d.away.formation)}${logo(m.al)}</span></div>${rows}
    <div class="fb-bench"><b>Ersatz</b><span>${esc(d.home.bench.join(', '))}</span><span class="r">${esc(d.away.bench.join(', '))}</span></div>
    <p class="fb-x-src">${d.home.coach || d.away.coach ? `Trainer: ${esc(d.home.coach)} · ${esc(d.away.coach)} · ` : ''}Aufstellung: Sportradar</p></div>`;
}
function statsHtml(m) {
  const d = detailCache.get(`${m.id}|stats`);
  if (!d) return '<p class="fb-x-note">Lade Statistik …</p>';
  if (!d.available || !d.home || !d.away) return `<p class="fb-x-note">${m.st === 'pre' ? 'Die Statistik gibt es nach dem Spiel.' : 'Statistik folgt etwa 30 Minuten nach Spielende.'}</p>`;
  const pct = (x) => (x.passes ? Math.round((x.acc / x.passes) * 100) : null);
  const lines = [['Ballbesitz', d.home.poss, d.away.poss, '%'], ['Schüsse', d.home.shots, d.away.shots], ['Aufs Tor', d.home.on, d.away.on], ['Ecken', d.home.corners, d.away.corners],
    ['Fouls', d.home.fouls, d.away.fouls], ['Gelbe Karten', d.home.yellow, d.away.yellow], ['Rote Karten', d.home.red, d.away.red], ['Pässe', d.home.passes, d.away.passes],
    ['Passquote', pct(d.home), pct(d.away), '%'], ['Paraden', d.home.saves, d.away.saves]].filter((l) => l[1] != null && l[2] != null && !(l[0] === 'Rote Karten' && !l[1] && !l[2]));
  return `<div class="fb-stats">${lines.map(([n, a, b, u = '']) => { const t = (Number(a) || 0) + (Number(b) || 0), p = t ? Math.round(((Number(a) || 0) / t) * 100) : 50;
    return `<div class="fb-st-row"><span class="v">${esc(a)}${u ? ` ${u}` : ''}</span><span class="n">${esc(n)}</span><span class="v r">${esc(b)}${u ? ` ${u}` : ''}</span><span class="bar"><i style="width:${p}%"></i><i class="b" style="width:${100 - p}%"></i></span></div>`; }).join('')}
    <p class="fb-x-src">Statistik: Big Balls</p></div>`;
}
function extraHtml(m) {
  const tab = detailTab.get(m.id) || 'goals';
  const seg = `<div class="fb-seg" role="tablist">${[['goals', 'Tore'], ['lineup', 'Aufstellung'], ['stats', 'Statistik']].map(([k, t]) => `<button type="button" role="tab" data-act="fb-tab" data-id="${esc(m.id)}" data-tab="${k}" aria-selected="${tab === k}">${t}</button>`).join('')}</div>`;
  const body = tab === 'lineup' ? lineupHtml(m) : tab === 'stats' ? statsHtml(m) : `<div class="fb-detail fb-detail-in">${goalsHtml(m)}</div>`;
  return `<div class="fb-x">${seg}${body}</div>`;
}
async function loadDetail(m, kind) {
  const k = `${m.id}|${kind}`;
  if (detailCache.has(k) && (m.st === 'ft' || detailCache.get(k)?.available)) return;
  try {
    const res = await fetch(`${DATA_URL}?fbdetail=${encodeURIComponent(m.id)}&kind=${kind}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(30000) });
    detailCache.set(k, await res.json());
  } catch { detailCache.set(k, { available: false, message: 'Gerade nicht erreichbar.' }); }
  render();
}

function row(m) {
  const done = m.hs != null && m.as != null;
  const hw = m.st === 'ft' && m.hs > m.as, aw = m.st === 'ft' && m.as > m.hs;
  const ex = open.has(m.id);
  const live = m.st === 'live' || m.st === 'ht';
  return `<button type="button" class="fb-match${live ? ' is-live' : ''}" data-id="${esc(m.id)}" aria-expanded="${ex}">${status(m)}
    <span class="fb-teams"><span class="fb-t${hw ? ' win' : aw ? ' lose' : ''}${isFavName(m.h) ? ' fav' : ''}">${logo(m.hl)}<span>${esc(m.h)}</span></span>
      <span class="fb-t${aw ? ' win' : hw ? ' lose' : ''}${isFavName(m.a) ? ' fav' : ''}">${logo(m.al)}<span>${esc(m.a)}</span></span></span>
    <span class="fb-sc">${done ? `<span class="${aw ? 'lose' : ''}">${m.hs}</span><span class="${hw ? 'lose' : ''}">${m.as}</span>` : ''}</span>
    <span class="fb-chev" aria-hidden="true">›</span></button>${ex ? (hasExtra(m) ? extraHtml(m) : `<div class="fb-detail">${goalsHtml(m)}</div>`) : ''}`;
}

// Live-Tafel zuoberst: alle laufenden Spiele (unabhängig vom gewählten Tag) als Fallblatt-Anzeige wie im Basketball-Bereich
const isLive = (m) => m.st === 'live' || m.st === 'ht';
function liveHtml() {
  const lives = data.matches.filter((m) => isLive(m) && (!mineOnly || isFav(m)))
    .sort((a, b) => isFav(b) - isFav(a) || a.utc.localeCompare(b.utc) || a.h.localeCompare(b.h));
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
    const last = (m.goals || goalsCache.get(m.id) || []).at(-1);
    const goal = last ? `Tor ${esc(last.n || (last.s === 1 ? m.h : m.a))}${last.m !== '' ? ` ${esc(last.m)}'` : ''}` : '';
    return `<button type="button" class="live-hero fb-live-card" data-act="fb-live" data-id="${esc(m.id)}" aria-label="${esc(m.h)} ${esc(hs)}, ${esc(m.a)} ${esc(as)}, ${esc(state)}">
      <span class="flap-row">${logo(m.hl).replace('fb-logo', 'fb-logo fb-logo-lg')}<span class="flap-name">${esc(m.h)}</span>${tiles(hs)}</span>
      <span class="flap-row">${logo(m.al).replace('fb-logo', 'fb-logo fb-logo-lg')}<span class="flap-name">${esc(m.a)}</span>${(i += 1, tiles(as))}</span>
      <span class="flap-bar"><span class="flap-q"><i class="live-dot" aria-hidden="true"></i>${esc(state)}${lg ? `<span class="flap-round">&nbsp;· ${esc(lg.name)}</span>` : ''}</span>
        <span class="flap-clock">${goal ? `<span class="fb-live-goal">${goal}</span>` : ''}<span class="flap-more" aria-hidden="true">›</span></span></span></button>`;
  }).join('');
  return `<section class="fb-live" aria-label="Live-Spiele"><div class="fb-live-head"><b><i class="live-dot" aria-hidden="true"></i>Live</b><small>${lives.length} ${lives.length === 1 ? 'Spiel' : 'Spiele'}</small></div>
    <div class="hero-scroll${lives.length > 1 ? ' multi' : ''}" data-keep-scroll="fb-live">${cards}</div>${tickerHtml(lives)}</section>`;
}

// Konferenz: die letzten Tore aller laufenden Spiele, neustes zuoberst (Zeit = Anpfiff + Minute, nach der Pause 15 Minuten mehr)
function tickerHtml(lives) {
  const rows = [];
  for (const m of lives) {
    const sc = [0, 0];
    for (const g of m.goals || goalsCache.get(m.id) || []) {
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
  const matches = data.matches.filter((m) => !mineOnly || isFav(m));
  const byDay = {};
  for (const m of matches) (byDay[zDate(new Date(m.utc))] ||= []).push(m);
  const keys = Object.keys(byDay).sort();
  const today = zDate(new Date());
  if (!sel || !byDay[sel]) sel = keys.find((k) => k >= today) || keys.at(-1) || today;
  days.innerHTML = keys.map((k) => { const d = new Date(`${k}T12:00:00`), live = byDay[k].some((m) => m.st === 'live' || m.st === 'ht');
    return `<button type="button" class="fb-day${live ? ' has-live' : ''}" data-d="${k}" aria-pressed="${k === sel}"><small>${dayLabel(k)}</small><b>${d.getDate()}. ${MON[d.getMonth()]}</b><i>${byDay[k].length} ${byDay[k].length === 1 ? 'Spiel' : 'Spiele'}</i></button>`; }).join('');
  const cur = days.querySelector('[aria-pressed="true"]');
  if (cur && !days.dataset.scrolled) { days.scrollLeft = cur.offsetLeft - days.clientWidth / 2 + cur.clientWidth / 2; days.dataset.scrolled = '1'; }

  const ms = (byDay[sel] || []).sort((a, b) => a.utc.localeCompare(b.utc) || a.h.localeCompare(b.h));
  const groups = [];
  const fav = ms.filter(isFav);
  if (fav.length && !mineOnly) groups.push({ star: true, name: 'Meine Spiele', sub: `${fav.length} ${fav.length === 1 ? 'Spiel' : 'Spiele'}`, list: fav });
  for (const lg of data.leagues) {
    const l = ms.filter((m) => m.l === lg.id);
    if (l.length) groups.push({ ...lg, sub: l[0].round ? (/^\d+$/.test(l[0].round) ? `${l[0].round}. Runde` : l[0].round) : lg.country, list: l });
  }
  const head = (g) => {
    const inner = `<span class="fb-lg" style="--c:${g.star ? 'var(--gold)' : esc(g.color)}">${g.star ? '★' : esc(g.short)}</span><b>${esc(g.name)}</b><small>${esc(g.sub || '')}</small>`;
    return !g.star && TABLE_LEAGUES.has(g.id)
      ? `<button type="button" class="fb-g-head fb-g-link" data-act="fb-table" data-id="${esc(g.id)}" aria-haspopup="dialog">${inner}<span class="fb-g-more">Tabelle ›</span></button>`
      : `<div class="fb-g-head">${inner}</div>`;
  };
  const strip = list.querySelector('[data-keep-scroll="fb-live"]'), keep = strip ? strip.scrollLeft : 0;
  list.innerHTML = liveHtml() + (groups.length ? groups.map((g) => `<section class="fb-group">${head(g)}${g.list.map(row).join('')}</section>`).join('') : '<p class="fb-empty">An diesem Tag keine Spiele.</p>')
    + data.leagues.filter((lg) => lg.status !== 'ok').map((lg) => `<p class="fb-warn"><span class="fb-lg" style="--c:${esc(lg.color)}">${esc(lg.short)}</span>${esc(lg.name)}: ${esc(lg.message || 'nicht verfügbar')}</p>`).join('');
  const strip2 = list.querySelector('[data-keep-scroll="fb-live"]'); if (strip2) strip2.scrollLeft = keep;
  $('#fbFoot').textContent = `Stand ${zTime(new Date(data.updated))} · Big Balls · 2. Bundesliga: OpenLigaDB · Schweiz: Sportradar`;
}

// ---------- Blatt: Tabelle / Torschützen ----------
function sheetBody(id, tab) {
  const d = leagueCache.get(`${id}|${tab}`);
  if (!d) return '<p class="fb-x-note">Lade …</p>';
  if (!d.available) return '<p class="fb-x-note">Gerade nicht verfügbar.</p>';
  if (tab === 'scorers') {
    return `<div class="fb-sc-head"><span></span><span>Spieler</span><span>Tore</span><span>Vorl.</span></div><div class="fb-sc-list">${d.rows.map((r) => `<div class="fb-scr${isFavName(r.team) ? ' fav' : ''}"><span class="pos">${esc(r.rank)}</span>
      <span class="who"><b>${esc(r.n)}</b><small>${esc(r.team)}</small></span><span class="g">${esc(r.g)}</span><span class="a">${esc(r.a)}</span></div>`).join('')}</div><p class="fb-x-src">Quelle: Big Balls</p>`;
  }
  const zone = (rank) => (d.zones || []).find(([a, b]) => rank >= a && rank <= b)?.[2] || '';
  return `<table class="fb-tab"><thead><tr><th>#</th><th class="tm">Team</th><th><abbr title="Spiele">Sp</abbr></th><th><abbr title="Tore">Tore</abbr></th><th><abbr title="Tordifferenz">+/-</abbr></th><th><abbr title="Punkte">Pkt</abbr></th></tr></thead>
    <tbody>${d.rows.map((r) => `<tr class="${zone(r.rank) ? `z-${zone(r.rank)}` : ''}${isFavName(r.team) ? ' fav' : ''}"><td class="pos">${esc(r.rank)}</td><td class="tm"><span class="fb-tmw">${logo(r.logo).replace(' loading="lazy"', '')}<span class="nm">${esc(r.team)}</span></span></td>
      <td>${esc(r.p)}</td><td>${esc(r.gf)}:${esc(r.ga)}</td><td>${r.gf - r.ga > 0 ? '+' : ''}${esc(r.gf - r.ga)}</td><td class="pts">${esc(r.pts)}</td></tr>`).join('')}</tbody></table>
    <p class="fb-zones">${(d.zones || []).map((z) => `<span class="z-${z[2]}">${ZONE_NAME[z[2]] || ''}</span>`).join('')}</p><p class="fb-x-src">Quelle: Big Balls</p>`;
}
function renderSheet() {
  let el = $('#fbSheet');
  if (!sheet) { if (el) { el.remove(); document.body.classList.remove('fb-sheet-open'); } return; }
  const lg = data?.leagues.find((l) => l.id === sheet.id);
  if (!el) {
    el = document.createElement('div'); el.id = 'fbSheet'; el.className = 'fb-sheet-wrap';
    document.body.appendChild(el); document.body.classList.add('fb-sheet-open');
  }
  const keep = el.querySelector('.fb-sheet-body')?.scrollTop || 0;
  el.innerHTML = `<div class="fb-sheet-dim" data-act="fb-sheet-close"></div>
    <section class="fb-sheet" role="dialog" aria-modal="true" aria-labelledby="fbSheetTitle"><span class="fb-grab" aria-hidden="true"></span>
      <div class="fb-sheet-h"><span class="fb-lg" style="--c:${esc(lg?.color || '#555')}">${esc(lg?.short || '')}</span><b id="fbSheetTitle">${esc(lg?.name || '')}</b>
        <button type="button" class="fb-sheet-x" data-act="fb-sheet-close" aria-label="Schliessen">✕</button></div>
      <div class="fb-seg" role="tablist">${[['table', 'Tabelle'], ['scorers', 'Torschützen']].map(([k, t]) => `<button type="button" role="tab" data-act="fb-sheet-tab" data-tab="${k}" aria-selected="${sheet.tab === k}">${t}</button>`).join('')}</div>
      <div class="fb-sheet-body">${sheetBody(sheet.id, sheet.tab)}</div></section>`;
  el.querySelector('.fb-sheet-body').scrollTop = keep;
}
async function openSheet(id, tab) {
  sheet = { id, tab }; renderSheet();
  document.querySelector('.fb-sheet-x')?.focus();
  const k = `${id}|${tab}`;
  if (leagueCache.has(k)) return;
  try {
    const res = await fetch(`${DATA_URL}?fbleague=${encodeURIComponent(id)}&kind=${tab}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(30000) });
    leagueCache.set(k, await res.json());
  } catch { leagueCache.set(k, { available: false }); }
  if (sheet && sheet.id === id && sheet.tab === tab) renderSheet();
}
function closeSheet() { const back = sheet && document.querySelector(`[data-act="fb-table"][data-id="${sheet.id}"]`); sheet = null; renderSheet(); back?.focus(); }

async function load() {
  try {
    const res = await fetch(`${DATA_URL}?fb=1`, { headers: { apikey: SUPABASE_ANON_KEY }, cache: 'no-store', signal: AbortSignal.timeout(30000) });
    const d = await res.json();
    if (!res.ok || !Array.isArray(d?.matches)) throw new Error(d?.error || '');
    data = d; error = '';
  } catch (err) {
    if (!data) error = err?.message || 'Die Fussball-Daten sind gerade nicht erreichbar.';
  }
  render();
  clearTimeout(timer);
  // Nur nachladen, solange die Seite sichtbar ist (Hintergrund-Tab oder gesperrtes Handy: keine Abfragen)
  if (document.visibilityState === 'hidden') return;
  const live = data?.matches.some((m) => m.st === 'live' || m.st === 'ht');
  timer = setTimeout(load, live ? LIVE_POLL_MS : IDLE_POLL_MS);
}

async function loadGoals(m) {
  if (m.goals || (goalsCache.has(m.id) && m.st === 'ft')) return;
  try {
    const res = await fetch(`${DATA_URL}?fbgame=${encodeURIComponent(m.id)}`, { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    goalsCache.set(m.id, Array.isArray(d?.goals) ? d.goals : []);
  } catch { goalsCache.set(m.id, []); }
  render();
}

// ---------- Kopf: Hell/Dunkel und Profil-Menü (wie im Basketball-Bereich) ----------
const ICON = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
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
  menu.innerHTML = `<div class="pm-head"><span class="pm-avatar" aria-hidden="true">${esc(initials(profileName))}</span><span><b>${esc(profileName)}</b><small>Teams: ${esc(FAV.map((k) => k[0].toUpperCase() + k.slice(1)).join(', '))}</small></span></div>
    ${item('copy-link', 'share', 'Link für Home-App kopieren')}<hr>${item('profile-logout', 'logout', 'Profil abmelden')}${item('logout', 'logout', 'Von diesem Gerät abmelden')}`;
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
  const tab = e.target.closest('.fb-tabs [data-view]');
  if (tab) {
    mineOnly = tab.dataset.view === 'mine'; sel = ''; open.clear();
    document.querySelectorAll('.fb-tabs [data-view]').forEach((x) => { if (x === tab) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    render(); scrollTo(0, 0); return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (menuOpen && !e.target.closest('#profileMenu, #profileBtn')) { menuOpen = false; renderMenu(); }
  if (act === 'theme') { toggleTheme(); return; }
  if (act === 'profile-menu') { menuOpen = !menuOpen; renderMenu(); return; }
  if (act === 'copy-link') { menuOpen = false; renderMenu(); copyLink(); return; }
  if (act === 'profile-logout') { store.set('el-profile-name', ''); store.set('el-profile-pin', ''); location.href = '../'; return; }
  if (act === 'logout') { logout(); return; }
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
    mineOnly = false; sel = zDate(new Date(m.utc)); open.add(m.id);
    document.querySelectorAll('.fb-tabs [data-view]').forEach((x) => { if (x.dataset.view === 'all') x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
    render();
    if (!m.goals) loadGoals(m);
    document.querySelector(`.fb-match[data-id="${CSS.escape(m.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (document.visibilityState === 'visible') load(); else clearTimeout(timer);
});
themeUi();
renderMenu();
load();
