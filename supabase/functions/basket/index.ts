// Supabase Edge Function „basket“: Schweizer Basketball für den Basketball-Bereich der Seite
// (basketball/sbl/ und basketball/2liga/, gemeinsames Skript basketball/regio.js). Getrennt von „euroleague“ und „fussball“.
//
//   GET ?sbl=1 → SB League Men: { updated, games: [{ id, utc, round, h, a, hs, as, st: 'pre'|'live'|'ft', per, clk }], table }
//     Spielplan von swiss.basketball (Widget 2, nur ab heute), Live-Stände von FIBA LiveStats (Genius Sports, öffentlich).
//     Beendete Spiele werden in el_fb_cache (Schlüssel sbl-results) gesammelt, daraus Resultate. Tabelle offiziell von swiss.basketball
//     (swiss.basketball/basketplan/showRankingForLeague.do, alle 30 Min.), sonst aus den gesammelten Resultaten gerechnet.
//   GET ?sblleaders=1 → Spieler-Bestenlisten (Schnitt pro Spiel: Punkte, Rebounds, Assists, Steals, Blocks, Dreier, Bewertung), je Top 10
//   GET ?sblgame=<Spiel-Nr.> → Spielbericht: Stand, Viertel, Trainer, Spieler (Pkt/Reb/Ass/Min), letzte Körbe
//   GET ?bvn=<liga> → BVN-Liga (z. B. h2l = Herren 2. Liga): { updated, league, games, table } über die offene BVN-API (api.bvn.ch)
//
// Keine Secrets nötig. SUPABASE_SERVICE_ROLE_KEY stellt Supabase selbst bereit (für die Tabelle el_fb_cache).

const ALLOWED_ORIGINS = ['https://ccodel9876.github.io'];
const TIMEOUT_MS = 10000;
const SUPABASE_URL = 'https://vbipkljatgandplwould.supabase.co';

function corsFor(req) {
  const origin = req.headers.get('origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'apikey, authorization, content-type', 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } : { Vary: 'Origin' };
}
function serviceHeaders() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Speicher pro Instanz (kurze Zwischenspeicher) und Tabelle el_fb_cache (dauerhaft)
const mem = new Map();
async function memo(key, ms, fn) {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.data;
  const data = await fn();
  mem.set(key, { data, at: Date.now() });
  return data;
}
async function cacheGet(key) {
  if (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?key=eq.${encodeURIComponent(key)}&select=data`, { headers: serviceHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) return (await r.json())[0]?.data ?? null;
    } catch { /* Speicher */ }
  }
  return mem.get(`db:${key}`)?.data ?? null;
}
async function cacheSet(key, data) {
  mem.set(`db:${key}`, { data, at: Date.now() });
  if (!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return;
  await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?on_conflict=key`, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, data, at: new Date().toISOString() }), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {});
}

// Schweizer Ortszeit („2026-11-07 17:30“) → ISO-Zeit in UTC
function zurichUtc(date, time) {
  const [y, mo, d] = date.split('-').map(Number), [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asZurich = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess - (asZurich - guess)).toISOString();
}

const str = (v, n = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const LOGO_OK = /^https:\/\/images\.statsengine\.playbyplay\.api\.geniussports\.com\/[\w.-]+$/;
const logo = (u) => (LOGO_OK.test(String(u || '')) ? String(u) : '');
// Kurznamen für die Anzeige (Spielplan liefert die langen Vereinsnamen)
const SBL_SHORT = { MON: 'Monthey', STA: 'Starwings', UNB: 'Neuchâtel', NYO: 'Nyon', LDG: 'Lions de Genève', MAS: 'Massagno', FOB: 'Fribourg', PLF: 'Pully Lausanne', GCZ: 'GC Zürich', LUG: 'Lugano', SAM: 'Massagno', BBC: 'Boncourt', VEV: 'Vevey', SWI: 'Swiss Central' };
const team = (name, code, lg) => ({ n: SBL_SHORT[str(code, 6)] || str(name, 40), full: str(name, 60), c: str(code, 6), logo: logo(lg) });

// ---------- SB League ----------
const SBL_WIDGET = 2;
async function sblSchedule() {
  return memo('sbl-sched', 60 * 1000, async () => {
    const raw = await getJson(`https://swiss.basketball/app-basketball/schedule?widget=${SBL_WIDGET}`);
    const out = [];
    for (const day of Object.values(raw || {})) for (const g of Array.isArray(day) ? day : []) {
      const id = num(g?.match_id); const at = String(g?.starting_at || '');
      if (!id || !/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(at) || g.is_hidden) continue;
      out.push({ id, utc: zurichUtc(at.slice(0, 10), at.slice(11, 16)), round: num(g.round_number), status: str(g.status, 20),
        h: team(g.home_team_name, g.home_team_code, g.home_team_logo), a: team(g.guest_team_name, g.guest_team_code, g.guest_team_logo),
        ended: Boolean(g.ended_at), tv: /^https:\/\//.test(String(g.livestream_url || '')) ? String(g.livestream_url) : '' });
    }
    return out;
  });
}
// Rohdaten eines Spiels von FIBA LiveStats (öffentlich, 30 Sek. Cache bei Genius Sports)
async function liveRaw(id) {
  return memo(`fls:${id}`, 20 * 1000, () => getJson(`https://fibalivestats.dcd.shared.geniussports.com/data/${id}/data.json`).catch(() => null));
}
function liveState(d) {
  if (!d?.tm?.['1'] || !d?.tm?.['2']) return null;
  const pbp = Array.isArray(d.pbp) ? d.pbp : [];
  const started = pbp.length > 0;
  const ended = pbp.some((a) => a.actionType === 'game' && a.subType === 'end');
  const per = num(d.period) || 0, clk = /^\d\d:\d\d$/.test(String(d.clock || '')) ? String(d.clock) : '';
  const max = num(d.periodsMax) || 4;
  const q = (t) => Array.from({ length: Math.max(per, max) }, (_, i) => num(t[`p${i + 1}_score`]));
  return { started, ended, per, clk, ot: num(d.inOT) ? 1 : 0, hs: num(d.tm['1'].score) ?? 0, as: num(d.tm['2'].score) ?? 0, hq: q(d.tm['1']), aq: q(d.tm['2']) };
}
const DONE = /^(COMPLETE|COMPLETED|FINISHED|FINAL|ENDED|CLOSED)$/i;
async function sbl() {
  const sched = await sblSchedule();
  const results = (await cacheGet('sbl-results')) || {};
  const now = Date.now();
  let changed = false;
  const games = await Promise.all(sched.map(async (g) => {
    const t = Date.parse(g.utc);
    const base = { id: g.id, utc: g.utc, round: g.round, h: g.h, a: g.a, tv: g.tv };
    if (results[g.id]) return results[g.id];
    const maybe = g.status !== 'SCHEDULED' || (now > t - 10 * 60 * 1000 && now < t + 5 * 3600 * 1000);
    if (!maybe) return { ...base, st: 'pre' };
    const s = liveState(await liveRaw(g.id));
    if (!s || !s.started) return { ...base, st: 'pre' };
    // Ohne Spielende-Meldung: 4 Std. nach Beginn, im letzten Viertel (oder Verlängerung) bei abgelaufener Uhr als beendet werten
    const done = s.ended || DONE.test(g.status) || g.ended || (now - t > 4 * 3600 * 1000 && s.per >= 4 && (s.clk === '00:00' || !s.clk));
    const out = { ...base, st: done ? 'ft' : 'live', per: s.per, clk: s.clk, ot: s.ot, hs: s.hs, as: s.as, hq: s.hq, aq: s.aq };
    if (done) { results[g.id] = out; changed = true; }
    return out;
  }));
  if (changed) await cacheSet('sbl-results', results);
  // Gespeicherte Resultate (nicht mehr im Spielplan) dazu
  const seen = new Set(games.map((g) => g.id));
  for (const r of Object.values(results)) if (!seen.has(r.id)) { games.push(r); seen.add(r.id); }
  // Ganzer Spielplan der Saison von swiss.basketball (Resultate seit Saisonstart, Halle, Video); laufende/eigene Stände haben Vorrang
  const season = await sblSeasonGames(games).catch(() => []);
  const byId = new Map(games.map((g) => [g.id, g]));
  // Künftige Spiele haben bei basketplan oft noch keine FIBA-Nr.: zusätzlich über Tag und Teams abgleichen (sonst doppelt)
  const pair = (g) => `${String(g.utc).slice(0, 10)}|${g.h?.c || g.h?.n}|${g.a?.c || g.a?.n}`;
  const byPair = new Map(games.map((g) => [pair(g), g]));
  for (const x of season) {
    const g = byId.get(x.id) || byPair.get(pair(x));
    if (g) { if (x.video) g.video = x.video; if (x.venue) g.venue = x.venue; continue; }
    games.push(x); seen.add(x.id);
  }
  games.sort((x, y) => x.utc.localeCompare(y.utc) || x.id - y.id);
  const own = tableOf(games.filter((g) => g.st === 'ft'), (g) => g.h.c, (g) => g.a.c, (g) => g.h, (g) => g.a);
  // Offizielle Tabelle des Verbands (alle Spiele der Saison); sonst die aus den gesammelten Resultaten gerechnete
  const official = await sblOfficialTable(games).catch(() => null);
  return { updated: new Date().toISOString(), games, table: official?.length ? official : own, tableSrc: official?.length ? 'swiss.basketball' : 'eigene Rechnung' };
}

// ---------- Offizielle Tabelle SB League (swiss.basketball, Daten von basketplan über swiss.basketball/basketplan/) ----------
// Eine Abfrage für die Liste der Wettbewerbe (einmal am Tag), eine für die Tabelle (alle 30 Min.). robots.txt von swiss.basketball erlaubt.
const SB_UA = 'SportPWA/1.0 (private, non-commercial)';
async function sbXml(path) {
  const res = await fetch(`https://swiss.basketball/basketplan/${path}`, { headers: { 'user-agent': SB_UA, accept: 'text/xml' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
const xmlAttrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, k, v]) => [k, v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")]));
// Saison-Nummer bei basketplan: 31 = 2026/27 (Saison beginnt im Juli)
const sbSeasonId = () => { const d = new Date(); return 31 + (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1) - 2026; };
async function sblHoldingId() {
  return memo('sbl-holding', 24 * 3600 * 1000, async () => {
    const xml = await sbXml(`findAllLeagueHoldings.do?lang=de&xmlView=rss&federationId=12&seasonId=${sbSeasonId()}`);
    const today = new Date().toISOString().slice(0, 10);
    // SB League Men (leagueId 1): die laufende Phase, sonst die zuletzt begonnene
    const list = [...xml.matchAll(/<LeagueHoldingRSS [^>]*>/g)].map((m) => xmlAttrs(m[0])).filter((h) => h.leagueId === '1' && h.from <= today)
      .sort((a, b) => b.from.localeCompare(a.from));
    return list.find((h) => !h.to || h.to >= today) || list[0] || null;
  });
}
const tKey = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
async function sblOfficialTable(games) {
  return memo('sbl-official', 30 * 60 * 1000, async () => {
    const id = (await sblHoldingId())?.id;
    if (!id) return null;
    const xml = await sbXml(`showRankingForLeague.do?lang=de&xmlView=rss&leagueId=1&leagueHoldingId=${encodeURIComponent(id)}&resultType=big`);
    const rows = [...xml.matchAll(/<RankingRSS [^>]*>/g)].map((m) => xmlAttrs(m[0]));
    if (!rows.length) return null;
    // Teams des Spielplans (Kürzel, Kurzname, Logo) über den vollen Vereinsnamen zuordnen
    const teams = new Map();
    for (const g of games) for (const t of [g.h, g.a]) if (t?.full) teams.set(tKey(t.full), t);
    const find = (n) => { const k = tKey(n); return teams.get(k) || [...teams.entries()].find(([tk]) => tk.startsWith(k.slice(0, 8)) || k.startsWith(tk.slice(0, 8)))?.[1]; };
    return rows.map((r) => {
      const t = find(r.teamName) || { n: str(r.teamName, 40), full: str(r.teamName, 60), c: '', logo: '' };
      const a = num(r.pointsMade) ?? 0, b = num(r.pointsReceived) ?? 0, diff = num(r.difference);
      // basketplan vertauscht die Namen: «difference» = pointsReceived − pointsMade = eigene minus erhaltene Punkte
      const [pf, pa] = diff != null && diff === b - a ? [b, a] : [a, b];
      return { t, gp: num(r.gamesCount) ?? 0, w: num(r.gamesWon) ?? 0, l: num(r.gamesLost) ?? 0, pf, pa, pts: num(r.points) ?? 0, rank: num(r.ranking) ?? 0 };
    }).sort((x, y) => x.rank - y.rank);
  });
}
// Tabelle aus Resultaten: Siege, Niederlagen, Punkte für/gegen; Rang nach Siegen, dann Differenz
function tableOf(done, hk, ak, ht, at) {
  const m = new Map();
  const row = (k, t) => m.get(k) || m.set(k, { t, gp: 0, w: 0, l: 0, pf: 0, pa: 0 }).get(k);
  for (const g of done) {
    const h = row(hk(g), ht(g)), a = row(ak(g), at(g));
    h.gp++; a.gp++; h.pf += g.hs; h.pa += g.as; a.pf += g.as; a.pa += g.hs;
    if (g.hs > g.as) { h.w++; a.l++; } else if (g.as > g.hs) { a.w++; h.l++; }
  }
  return [...m.values()].sort((x, y) => y.w - x.w || x.l - y.l || (y.pf - y.pa) - (x.pf - x.pa) || y.pf - x.pf).map((r, i) => ({ ...r, rank: i + 1 }));
}

// Teams des Spielplans (Kürzel, Kurzname, Logo) über den vollen Vereinsnamen finden
function teamFinder(games) {
  const teams = new Map();
  for (const g of games) for (const t of [g.h, g.a]) if (t?.full) teams.set(tKey(t.full), t);
  return (n) => { const k = tKey(n); return teams.get(k) || [...teams.entries()].find(([tk]) => tk.startsWith(k.slice(0, 8)) || k.startsWith(tk.slice(0, 8)))?.[1]
    || { n: SBL_SHORT_BY_NAME(n), full: str(n, 60), c: '', logo: '' }; };
}
const SBL_SHORT_BY_NAME = (n) => str(String(n || '').replace(/\s+pwd by.*$/i, '').replace(/^(BBC|A\+\+)\s+/, ''), 40);
// Alle Spiele der laufenden Phase (eine Abfrage, 30 Min.): Nr. = FIBA-LiveStats-Nr. (wie im Spielplan-Widget), sonst negative basketplan-Nr.
async function sblSeasonGames(known) {
  return memo('sbl-season', 30 * 60 * 1000, async () => {
    const h = await sblHoldingId();
    if (!h?.id) return [];
    const xml = await sbXml(`showLeagueSchedule.do?lang=de&xmlView=rss&leagueId=1&leagueHoldingId=${encodeURIComponent(h.id)}&daysBack=2500&daysFuture=2250&totalGames=200&resultType=big`);
    const find = teamFinder(known);
    const out = [];
    for (const m of xml.matchAll(/<GameRSS ([^>]*)>([\s\S]*?)<\/GameRSS>/g)) {
      const g = xmlAttrs(`<x ${m[1]}>`);
      const ht = xmlAttrs((/<homeTeam [^>]*>/.exec(m[2]) || [''])[0]), gt = xmlAttrs((/<guestTeam [^>]*>/.exec(m[2]) || [''])[0]);
      if (!/^\d{4}-\d\d-\d\d$/.test(g.date || '') || !ht.name || !gt.name) continue;
      const fiba = num((/\/u\/SUI\/(\d+)/.exec(g.liveStatsLink || '') || [])[1]);
      const hs = num(ht.result), as = num(gt.result);
      const done = hs != null && as != null && (hs > 0 || as > 0);
      out.push({ id: fiba || -(num(g.id) || 0), utc: zurichUtc(g.date, /^\d\d:\d\d/.test(g.time || '') ? g.time.slice(0, 5) : '12:00'), round: num(g.round),
        h: find(ht.name), a: find(gt.name), st: done ? 'ft' : 'pre', ...(done ? { hs, as } : {}),
        venue: str(g.locationName, 60), video: /^https:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]{6,20}$/.test(g.videoLink || '') ? g.videoLink : '' });
    }
    return out;
  });
}
// Spieler-Bestenlisten (Schnitt pro Spiel), je Kategorie eine Abfrage, 60 Min. gemerkt; je die besten 10
const LEADER_TYPES = [['POINTS', 'Punkte'], ['REBOUNDS_TOTAL', 'Rebounds'], ['ASSISTS', 'Assists'], ['RECAPTURED_BALLES', 'Steals'], ['BLOCKS', 'Blocks'], ['THREE_POINTS_SUCCESS', 'Dreier'], ['EVALUATION', 'Bewertung']];
async function sblLeaders() {
  return memo('sbl-leaders', 60 * 60 * 1000, async () => {
    const h = await sblHoldingId();
    if (!h?.id) return { cats: [] };
    const find = teamFinder((await sblSchedule().catch(() => [])).concat(Object.values((await cacheGet('sbl-results')) || {})));
    const cats = [];
    for (const [type, name] of LEADER_TYPES) {
      try {
        const xml = await sbXml(`showAverageHoldingPlayer.do?lang=de&xmlView=rss&cmd=searchAfterLeagueHolding&leagueId=1&federationId=12&searchLevel=LEAGUEHOLDING&fromDate=${h.from}&toDate=${h.to || ''}&leagueHoldingId=${h.id}&satisticType=${type}`);
        const rows = [...xml.matchAll(/<AverageHoldingPlayerGuiRow [^>]*>/g)].map((m) => xmlAttrs(m[0])).slice(0, 10).map((r) => ({
          rank: num(r.rank), n: str(`${String(r.playerFirstName || '').split(' ')[0]} ${r.playerLastName || ''}`.trim() || r.playerName, 40),
          t: find(r.teamName), avg: str(r.average, 8), gp: num(r.gameCount) }));
        if (rows.length) cats.push({ id: type, name, rows });
      } catch { /* Kategorie fehlt dann */ }
    }
    return { updated: new Date().toISOString(), phase: str(h.name, 40), cats };
  });
}

async function sblGame(id) {
  const d = await liveRaw(id);
  const s = liveState(d);
  if (!s) return { error: 'keine Daten' };
  const sched = (await sblSchedule().catch(() => [])).find((g) => g.id === id) || (((await cacheGet('sbl-results')) || {})[id]) || null;
  const side = (k) => {
    const t = d.tm[k];
    const pl = Object.values(t.pl || {}).map((p) => ({
      no: str(p.shirtNumber, 3), n: str(p.name || `${p.firstName || ''} ${p.familyName || ''}`, 40), start: p.starter ? 1 : 0,
      min: str(p.sMinutes, 6), pts: num(p.sPoints) ?? 0, reb: num(p.sReboundsTotal) ?? 0, ast: num(p.sAssists) ?? 0,
      fg: `${num(p.sFieldGoalsMade) ?? 0}/${num(p.sFieldGoalsAttempted) ?? 0}`, p3: `${num(p.sThreePointersMade) ?? 0}/${num(p.sThreePointersAttempted) ?? 0}`,
      ft: `${num(p.sFreeThrowsMade) ?? 0}/${num(p.sFreeThrowsAttempted) ?? 0}`, pf: num(p.sFoulsPersonal) ?? 0,
    })).filter((p) => p.n);
    const sc = sched?.[k === '1' ? 'h' : 'a'];
    return { n: sc?.n || str(t.shortName || t.name, 40), full: str(t.name, 60), c: str(t.code, 6), logo: sc?.logo || '', coach: str(t.coach, 50), score: num(t.score) ?? 0, pl,
      tot: { reb: num(t.tot_sReboundsTotal) ?? 0, ast: num(t.tot_sAssists) ?? 0, to: num(t.tot_sTurnovers) ?? 0, fg: num(t.tot_sFieldGoalsPercentage) ?? 0, p3: num(t.tot_sThreePointersPercentage) ?? 0, ft: num(t.tot_sFreeThrowsPercentage) ?? 0 } };
  };
  const KIND = { '2pt': 2, '3pt': 3, freethrow: 1 };
  const pbp = (Array.isArray(d.pbp) ? d.pbp : []).filter((a) => a.scoring && a.success && KIND[a.actionType])
    .slice(0, 40).map((a) => ({ per: num(a.period), gt: str(a.gt, 6), s1: num(a.s1), s2: num(a.s2), side: num(a.tno), n: str(a.player, 40), v: KIND[a.actionType] }));
  return { id, utc: sched?.utc || '', round: sched?.round ?? null, st: s.ended ? 'ft' : s.started ? 'live' : 'pre', per: s.per, clk: s.clk, ot: s.ot, hq: s.hq, aq: s.aq,
    h: side('1'), a: side('2'), pbp };
}

// ---------- BVN (Basketball Verband Nordwestschweiz) ----------
async function bvn(league) {
  return memo(`bvn:${league}`, 5 * 60 * 1000, async () => {
    const [ms, rk] = await Promise.all([
      getJson(`https://api.bvn.ch/v1/matches.php?format=json&realm=liga&id=${encodeURIComponent(league)}`),
      getJson(`https://api.bvn.ch/v1/ranking.php?format=json&league_id=${encodeURIComponent(league)}`).catch(() => []),
    ]);
    if (!Array.isArray(ms)) throw new Error('BVN: keine Spiele');
    const pad = (v) => String(v ?? '').padStart(2, '0');
    const now = Date.now();
    const games = ms.map((g) => {
      const date = `${g.gameYear}-${pad(g.gameMonth)}-${pad(g.gameDay)}`, time = `${pad(g.gameHour)}:${pad(g.gameMin)}`;
      const open = Number(g.gameYear) < 2024; // Platzhalter 01.01.2023 = Datum noch offen
      const utc = open ? '' : zurichUtc(date, time);
      const hs = num(g.homescore) ?? 0, as = num(g.awayscore) ?? 0;
      const played = hs + as > 0;
      return { id: num(g.matchNr), utc, h: { n: str(g.homeName, 50), c: str(g.homeCanon, 60), k: str(g.homeTeam5lc, 8) }, a: { n: str(g.awayName, 50), c: str(g.awayCanon, 60), k: str(g.awayTeam5lc, 8) },
        gym: str(g.gymName, 60), hs: played ? hs : null, as: played ? as : null, st: played ? 'ft' : (utc && now > Date.parse(utc) + 2 * 3600 * 1000 ? 'open' : 'pre') };
    }).filter((g) => g.id).sort((x, y) => (x.utc || '9').localeCompare(y.utc || '9') || x.id - y.id);
    const table = (Array.isArray(rk) ? rk : []).map((r) => ({ rank: num(r.rank), t: { n: str(r.teamName, 50), c: `${str(r.canonical_league, 10)}-${str(r.canonical_team, 50)}`, k: str(r.team5lc, 8) },
      gp: num(r.games) ?? 0, w: num(r.win) ?? 0, l: num(r.lost) ?? 0, pf: num(r.scored) ?? 0, pa: num(r.received) ?? 0, pts: num(r.points) ?? 0 }));
    return { updated: new Date().toISOString(), league: { id: league, name: str(ms[0]?.leagueName, 40) }, games, table };
  });
}

async function handle(req) {
  const cors = corsFor(req);
  const headers = { ...cors, 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'nur GET' }), { status: 405, headers });
  const p = new URL(req.url).searchParams;
  try {
    if (p.has('sblleaders')) return new Response(JSON.stringify(await sblLeaders()), { headers: { ...headers, 'Cache-Control': 'max-age=600' } });
    if (p.has('sbl')) return new Response(JSON.stringify(await sbl()), { headers: { ...headers, 'Cache-Control': 'max-age=15' } });
    if (p.has('sblgame')) {
      const id = Number(p.get('sblgame'));
      if (!Number.isInteger(id) || id <= 0) return new Response(JSON.stringify({ error: 'ungültig' }), { status: 400, headers });
      return new Response(JSON.stringify(await sblGame(id)), { headers: { ...headers, 'Cache-Control': 'max-age=15' } });
    }
    if (p.has('bvn')) {
      const league = String(p.get('bvn') || '');
      if (!/^[a-z0-9]{2,12}$/.test(league)) return new Response(JSON.stringify({ error: 'ungültig' }), { status: 400, headers });
      return new Response(JSON.stringify(await bvn(league)), { headers: { ...headers, 'Cache-Control': 'max-age=120' } });
    }
    return new Response(JSON.stringify({ error: 'unbekannt' }), { status: 400, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e).slice(0, 160) }), { status: 502, headers });
  }
}

if (typeof Deno !== 'undefined') Deno.serve(handle);
