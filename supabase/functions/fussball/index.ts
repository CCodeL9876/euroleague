// Supabase Edge Function „fussball“: Datenquelle des Fussball-Bereichs der Seite (fussball/index.html, fussball.js).
// Getrennt von der Funktion „euroleague“; gleiche Herkunftsprüfung (antwortet nur der eigenen Seite).
//
//   GET ?fb=1 → Spielübersicht: Spiele ±2 Wochen um heute aus allen Ligen
//   → { updated, season, leagues: [{ id, name, country, short, color, status: 'ok'|'nokey'|'error', message }],
//       matches: [{ id, l, utc, round, h, a, hl, al, hs, as, st: 'pre'|'live'|'ht'|'ft'|'off', min, ht, goals? }] }
//     Champions League, Premier League, Bundesliga, La Liga, Serie A, Ligue 1, Nations League, Länderspiele: bigballsdata.com
//     (Secret BIGBALLS_KEY, Tagesgrenze Secret BIGBALLS_DAILY, sonst 230): Saison-Spielplan pro Wettbewerb alle 12 Std., Live-Stände
//     aus einer Tagesabfrage für alle Ligen (während Spielen alle 3 Min.), Tore pro Spiel beim Aufklappen. 2. Bundesliga: OpenLigaDB.
//     Super League, Challenge League:
//     Sportradar Soccer v4 (Secrets SPORTRADAR_KEY, SPORTRADAR_LEVEL = trial|production, SPORTRADAR_DAILY = Tagesgrenze, sonst 60):
//     Saison-Spielplan pro Liga alle 12 Std., während Spielen alle 5 Min. die Live-Timelines (eine Abfrage, mit Torschützen),
//     nach Spielende einmal die Timeline des Spiels; alles in el_fb_cache. Wappen aus Wikipedia (SR_LOGO, Neuaufsteiger dort ergänzen). Reserve im Code: live-football-api.com (Secret LIVEFOOTBALL_KEY, 1 Credit pro Abfrage; Tagesgrenze Secret LIVEFOOTBALL_DAILY, sonst 150):
//     Spielplan pro Liga alle 6 Std. (/league_fixtures), während Spielen jede Minute die Tagesliste (/matches, eine Abfrage für alle
//     Ligen), alles in der Tabelle el_fb_cache. API-Football (Secret APIFOOTBALL_KEY) bleibt als Ersatz im Code (src: 'af').
//   GET ?fbleague=pl|bl1|laliga|seriea|ligue1&kind=table|scorers → Tabelle bzw. Torschützenliste (Big Balls); Tabelle alle 30 Min. (Spieltag) bzw. 3 Std., Torschützen alle 6 Std.
//   GET ?fbdetail=bb-<uuid>&kind=lineup|stats → Aufstellung bzw. Teamstatistik (Big Balls) eines Spiels der grossen Ligen und der Champions League;
//     Aufstellung PL/CL von Sportradar (solange verfügbar), sonst von Big Balls
//   GET ?fbplayer=bb:<uuid> → Spielerprofil aus Big Balls (Steckbrief, Transfers, Saisonwerte) + Wikipedia
//   GET ?fbplayer=<Sportradar-Spieler-Nr.> → Spielerprofil: Steckbrief und Saisonwerte (Sportradar, 7 Tage gespeichert), letzte Spiele (6 Std.),
//     Karriere und Foto aus Wikipedia/Wikidata
//   POST { kind: 'push-sub'|'push-unsub', endpoint, name, pin } → Gerät für Tor-Mitteilungen an-/abmelden (Tabelle el_fb_push)
//   GET ?fbpushtick=1 → (Zeitplan, jede Minute) Tore der Lieblingsteams erkennen und Push senden; ?fbpushmsg=<endpoint> → Meldungen fürs Gerät
//   GET ?bbtest=1 → Test: Aufstellungen und Spielerdaten von Big Balls für Fussball (≈8 Abfragen), höchstens alle 30 Min.
//   GET ?bbusage=1 → Big-Balls-Konto: Plan, Tageslimit, GitHub verknüpft, heute verbraucht (/v1/user/me, /v1/usage), höchstens alle 10 Min.
//   GET ?bbprobe=1 → Test von bigballsdata.com (Secret BIGBALLS_KEY): Rohform von Spielen, Live-Feed, Toren, Tabelle, Statistik (≈7 Abfragen), höchstens alle 30 Min.
//   GET ?srprobe=1 → Test von Sportradar: Saisons der drei Wettbewerbe (3 Abfragen), höchstens alle 30 Min. neu
//   GET ?lfprobe=1 → Test von live-football-api.com (Secret LIVEFOOTBALL_KEY): Rohform von Spielplan/Spieldetails, höchstens alle 30 Min. neu
//   GET ?fbgame=bb-<uuid> | sr-123 | lf-123 | af-123456 → Torschützen eines live-football-api- bzw. API-Football-Spiels → { goals: [{ m, s, n }] } (nach Spielende dauerhaft gespeichert)
//
// Secrets (Supabase → Edge Functions → Secrets, gelten für alle Funktionen des Projekts): BIGBALLS_KEY, SPORTRADAR_KEY, SPORTRADAR_LEVEL, SPORTRADAR_DAILY, LIVEFOOTBALL_KEY, LIVEFOOTBALL_DAILY, APIFOOTBALL_KEY;
// SUPABASE_SERVICE_ROLE_KEY stellt Supabase selbst bereit (für die Tabelle el_fb_cache).

const ALLOWED_ORIGINS = ['https://ccodel9876.github.io'];
const TIMEOUT_MS = 10000;
const SUPABASE_URL = 'https://vbipkljatgandplwould.supabase.co';

function corsFor(req) {
  const origin = req.headers.get('origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'apikey, authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' } : { Vary: 'Origin' };
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

const FB_LEAGUES = [
  { id: 'ucl', name: 'Champions League', country: 'Europa', short: 'UCL', color: '#0E1E5B', src: 'bb', key: 'ucl', sr: 'sr:competition:7' },
  { id: 'pl', name: 'Premier League', country: 'England', short: 'PL', color: '#3D195B', src: 'bb', key: 'epl', sr: 'sr:competition:17', lf: 1008 },
  { id: 'bl1', name: 'Bundesliga', country: 'Deutschland', short: 'BL', color: '#D20515', src: 'bb', key: 'bundesliga', oldb: 'bl1' },
  { id: 'laliga', name: 'La Liga', country: 'Spanien', short: 'LL', color: '#E2342B', src: 'bb', key: 'laliga' },
  { id: 'seriea', name: 'Serie A', country: 'Italien', short: 'SA', color: '#0A5DB8', src: 'bb', key: 'seriea' },
  { id: 'ligue1', name: 'Ligue 1', country: 'Frankreich', short: 'L1', color: '#1B2A4A', src: 'bb', key: 'ligue1' },
  { id: 'bl2', name: '2. Bundesliga', country: 'Deutschland', short: '2B', color: '#5B6170', src: 'oldb', key: 'bl2' },
  { id: 'chsl', name: 'Super League', country: 'Schweiz', short: 'SL', color: '#E30613', src: 'sr', key: 'sr:competition:215', lf: 8571 },
  { id: 'chcl', name: 'Challenge League', country: 'Schweiz', short: 'CL', color: '#1F6FB2', src: 'sr', key: 'sr:competition:216', lf: 8565 },
  { id: 'unl', name: 'Nations League', country: 'Nationalteams', short: 'NL', color: '#00A0E4', src: 'bb', key: 'UEFA Nations League', season: 'cal' },
  { id: 'wcq', name: 'WM-Qualifikation', country: 'Nationalteams', short: 'WMQ', color: '#8A1538', src: 'bb', key: 'World Cup - Qualification Europe', season: 'cal' },
  { id: 'emq', name: 'EM-Qualifikation', country: 'Nationalteams', short: 'EMQ', color: '#143CDB', src: 'bb', key: 'Euro Championship - Qualification', season: 'cal' },
  { id: 'wc', name: 'Weltmeisterschaft', country: 'Nationalteams', short: 'WM', color: '#8A1538', src: 'bb', key: 'wc2026', season: 'cal' },
  { id: 'em', name: 'Europameisterschaft', country: 'Nationalteams', short: 'EM', color: '#143CDB', src: 'bb', key: 'Euro Championship', season: 'cal' },
  { id: 'fr', name: 'Länderspiele', country: 'Testspiele', short: 'TS', color: '#6B7280', src: 'bb', key: 'Friendlies', season: 'cal' },
];
const FB_IMG = /^https:\/\/(upload\.wikimedia\.org|i\.imgur\.com|assets\.dfb\.de|media\.api-sports\.io|(www\.)?live-football-api\.com|img\.uefa\.com|derivates\.kicker\.de|s\.hs-data\.com|api\.bigballsdata\.com\/v1\/assets)\//;
// Wappen: bekannte Bild-Server (http wird zu https), kleine eingebettete Bilder (OpenLigaDB liefert manche als data:-Adresse)
const fbImg = (u) => {
  const v = String(u || '').trim().replace(/^http:\/\/img\.uefa\.com\//, 'https://img.uefa.com/');
  return FB_IMG.test(v) || (/^data:image\/(png|jpeg|gif|webp);base64,[\w+/=]+$/.test(v) && v.length < 24000) ? v : '';
};
// OpenLigaDB-Kurznamen, die zu knapp oder schief sind (v. a. Champions League)
const OLDB_NAME = { "Man'City": 'Man City', ManU: 'Man United', LA: 'LASK', Madrid: 'Real Madrid', Villa: 'Aston Villa', Paris: 'Paris SG', 'Villarreal CF': 'Villarreal', 'SSC Napoli': 'Napoli' };
// Wappen, die OpenLigaDB nur von einem nicht erlaubten Server liefert
const OLDB_LOGO = { Liverpool: 'https://media.api-sports.io/football/teams/40.png' };
const oldbName = (t) => { const n = String(t?.shortName || '').trim() || String(t?.teamName || '').trim(); return OLDB_NAME[n] || n; };
const AF_DAILY_MAX = 90;
const fbSeason = (d) => (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
// Läuft gerade (oder gleich) ein Spiel dieser Liga? Dann öfter nachfragen
const liveWindow = (list, now) => list.some((m) => m.st === 'live' || m.st === 'ht' || (m.st === 'pre' && Math.abs(Date.parse(m.utc) - now) < 20 * 60 * 1000)
  || (m.st !== 'ft' && m.st !== 'off' && now > Date.parse(m.utc) && now - Date.parse(m.utc) < 130 * 60 * 1000));

// Kleiner Zwischenspeicher in der Datenbank (überlebt Neustarts der Funktion); ohne Tabelle nur im Speicher
const fbMem = new Map();
async function cacheGet(key) {
  if (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?key=eq.${encodeURIComponent(key)}&select=data,at`, { headers: serviceHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) { const row = (await r.json())[0]; if (row) return { data: row.data, at: Date.parse(row.at) }; return null; }
    } catch { /* Tabelle fehlt: Speicher */ }
  }
  return fbMem.get(key) || null;
}
async function cacheSet(key, data) {
  fbMem.set(key, { data, at: Date.now() });
  if (!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return;
  await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?on_conflict=key`, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, data, at: new Date().toISOString() }), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {});
}
// Tageszähler gegen die Kontingente der Anbieter. Atomar über die SQL-Funktion el_fb_incr (README / unten); fehlt sie,
// lesen + schreiben mit einem Zähler pro Instanz, damit gleichzeitige Abfragen derselben Instanz nicht alle denselben Stand lesen.
const memCount = new Map();
let rpcOk = true;
async function dailyAllowed(prefix, max) {
  const k = `${prefix}:${new Date().toISOString().slice(0, 10)}`;
  if (rpcOk && Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/el_fb_incr`, { method: 'POST', headers: serviceHeaders(), body: JSON.stringify({ k, lim: max }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) return (await r.json()) === true;
      if (r.status === 404) rpcOk = false;
    } catch { /* Datenbank kurz nicht erreichbar: Ersatz unten */ }
  }
  const local = (memCount.get(k) || 0) + 1;
  memCount.set(k, local);
  const n = Math.max(Number((await cacheGet(k))?.data) || 0, local - 1);
  if (n >= max) return false;
  await cacheSet(k, n + 1);
  return true;
}
const afAllowed = () => dailyAllowed('afcount', AF_DAILY_MAX);
async function afGet(path) {
  const key = Deno.env.get('APIFOOTBALL_KEY') || '';
  const res = await fetch(`https://v3.football.api-sports.io/${path}`, { headers: { 'x-apisports-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  const d = await res.json().catch(() => null);
  const errs = d?.errors && (Array.isArray(d.errors) ? d.errors : Object.values(d.errors));
  if (!res.ok || (errs && errs.length)) throw new Error(String((errs && errs[0]) || `HTTP ${res.status}`));
  return d;
}
const AF_LIVE = new Set(['1H', '2H', 'ET', 'P', 'LIVE', 'BT']);
const AF_DONE = new Set(['FT', 'AET', 'PEN']);
export function mapAf(lg, f) {
  const s = f?.fixture?.status?.short || 'NS';
  const st = AF_DONE.has(s) ? 'ft' : s === 'HT' ? 'ht' : AF_LIVE.has(s) ? 'live' : ['NS', 'TBD'].includes(s) ? 'pre' : 'off';
  const img = fbImg;
  const ht = f?.score?.halftime;
  return { id: `af-${f.fixture.id}`, l: lg.id, utc: new Date(f.fixture.date).toISOString(), round: String(f.league?.round || '').replace(/^Regular Season - /, '') ,
    h: String(f.teams?.home?.name || ''), a: String(f.teams?.away?.name || ''), hl: img(f.teams?.home?.logo), al: img(f.teams?.away?.logo),
    hs: f.goals?.home ?? null, as: f.goals?.away ?? null, st, min: st === 'live' ? Number(f.fixture.status.elapsed) || null : null,
    ht: ht && ht.home != null ? `${ht.home}:${ht.away}` : '', note: st === 'off' ? String(f.fixture.status.long || '') : '' };
}
async function afLeague(lg, season, now) {
  if (!Deno.env.get('APIFOOTBALL_KEY')) return { status: 'nokey', message: 'API-Football-Schlüssel fehlt', matches: [] };
  const ck = `af:${lg.key}:${season}`;
  const hit = await cacheGet(ck);
  // Fehler (z. B. Saison nicht im Plan) nur kurz merken, damit ein Plan-Wechsel schnell greift
  const ttl = hit && (hit.data.status !== 'ok' || liveWindow(hit.data.matches || [], now)) ? 15 * 60 * 1000 : 6 * 3600 * 1000;
  if (hit && now - hit.at < ttl) return hit.data;
  if (!(await afAllowed())) return hit?.data || { status: 'error', message: 'Tageslimit von API-Football erreicht', matches: [] };
  try {
    const d = await afGet(`fixtures?league=${lg.key}&season=${season}`);
    const data = { status: 'ok', message: '', matches: (d.response || []).map((f) => mapAf(lg, f)) };
    if (!data.matches.length) { data.status = 'error'; data.message = 'Keine Spiele für diese Saison (Gratis-Plan?)'; }
    await cacheSet(ck, data);
    return data;
  } catch (err) {
    const data = { status: 'error', message: String(err?.message || err).slice(0, 160), matches: hit?.data?.matches || [] };
    await cacheSet(ck, data);
    return data;
  }
}
// ---------- bigballsdata.com (grosse Ligen, Champions League, Nationalteams) ----------
const BB_BASE = 'https://api.bigballsdata.com/v1';
const bbDailyMax = () => Number(Deno.env.get('BIGBALLS_DAILY')) || 230;
const BB_LIVE_MS = 5 * 60 * 1000; // Tagesgrenze: Spieltage mit Spielen von 13 bis 23 Uhr bleiben so unter 230 Abfragen
const bbAllowed = () => dailyAllowed('bbcount', bbDailyMax());
async function bbGet(path, params = {}) {
  const q = new URLSearchParams(params);
  const res = await fetch(`${BB_BASE}/${path}${String(q) ? `?${q}` : ''}`, { headers: { 'x-api-key': Deno.env.get('BIGBALLS_KEY') || '' }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  const d = await res.json().catch(() => null);
  // Limits aus den Antwort-Headern merken (für ?bbusage)
  bbLimits = { day: res.headers.get('x-ratelimit-limit-day'), limit: res.headers.get('x-ratelimit-limit'), remaining: res.headers.get('x-ratelimit-remaining'),
    reset: res.headers.get('x-ratelimit-reset'), endsAt: res.headers.get('x-bbs-access-ends-at'), notice: res.headers.get('x-bbs-access-ending-notice'), at: new Date().toISOString() };
  if (!res.ok) throw new Error(String(d?.error?.message || `HTTP ${res.status}`));
  return d;
}
let bbLimits = null;
// Konto und Kontingent bei Big Balls (Plan, Tageslimit, GitHub verknüpft, heute verbraucht); höchstens alle 10 Min. neu
let bbUsage = null;
async function bbUsageRun(now) {
  if (!Deno.env.get('BIGBALLS_KEY')) return { error: 'Secret BIGBALLS_KEY fehlt' };
  if (bbUsage && now - bbUsage.at < 10 * 60 * 1000) return bbUsage.data;
  const [me, usage] = await Promise.all([bbGet('user/me').catch((e) => ({ error: String(e?.message || e) })), bbGet('usage').catch((e) => ({ error: String(e?.message || e) }))]);
  const k = `bbcount:${new Date(now).toISOString().slice(0, 10)}`;
  const data = { me: me?.data ?? me, usage: usage?.data ?? usage, headers: bbLimits, appCounterToday: (await cacheGet(k))?.data ?? null, appDailyMax: bbDailyMax() };
  bbUsage = { data, at: now };
  return data;
}
// Test: Was liefert Big Balls für Fussball an Aufstellungen und Spielerdaten? (≈8 Abfragen, gekürzte Rohdaten, höchstens alle 30 Min.)
let bbTest = null;
async function bbTestRun(now) {
  if (!Deno.env.get('BIGBALLS_KEY')) return { error: 'Secret BIGBALLS_KEY fehlt' };
  if (bbTest && now - bbTest.at < 30 * 60 * 1000) return bbTest.data;
  const cut = (v, n = 1600) => { const t = JSON.stringify(v); return t && t.length > n ? `${t.slice(0, n)}…` : v; };
  const get = async (path, params) => { if (!(await bbAllowed())) return { error: 'Tagesgrenze' }; try { return await bbGet(path, params); } catch (e) { return { error: String(e?.message || e) }; } };
  const out = {};
  // Letztes beendetes Spiel der Premier League und der Bundesliga aus dem gespeicherten Spielplan
  const last = async (key) => ((await cacheGet(`bb2:${key}`))?.data?.matches || []).filter((m) => m.st === 'ft').sort((a, b) => b.utc.localeCompare(a.utc))[0];
  const pl = await last('epl'), bl = await last('bundesliga');
  out.plMatch = pl && `${pl.h} – ${pl.a} ${pl.utc}`;
  const luPl = pl ? await get(`stored/matches/${pl.id.replace(/^bb-/, '')}/lineups`) : null;
  out.plLineups = cut(luPl, 2500);
  out.plStats = pl ? cut(await get(`stored/matches/${pl.id.replace(/^bb-/, '')}/stats`), 1500) : null;
  out.blMatch = bl && `${bl.h} – ${bl.a} ${bl.utc}`;
  out.blLineups = bl ? cut(await get(`stored/matches/${bl.id.replace(/^bb-/, '')}/lineups`), 1500) : null;
  // Spieler: Bester Torschütze der Premier League
  const ts = await get('leagues/epl/top-scorers', { limit: '1' });
  const pid = ts?.data?.[0]?.id;
  out.player = ts?.data?.[0] ? `${ts.data[0].player_name} (${pid})` : cut(ts, 400);
  if (pid) {
    out.profile = cut(await get(`players/${pid}`), 2000);
    out.stats = cut(await get(`players/${pid}/stats`, { league: 'epl', season: '2026' }), 1500);
    out.transfers = cut(await get(`players/${pid}/transfers`), 800);
    out.clubForm = cut(await get(`players/${pid}/club-form`), 800);
  }
  out.limits = bbLimits;
  bbTest = { data: out, at: now };
  return out;
}
// Nur Männer-Nationalteams (Länderspiele enthalten auch Frauen- und Juniorenspiele)
const BB_NOT_MEN = /\b(Women|Femenino|Féminine|Frauen)\b|\bU-?\d\d\b| W$/i;
export function mapBb(lg, m) {
  const raw = String(m.status || '').toLowerCase();
  // Uhr der Live-Liste, z. B. «83'», «45+2'» oder «HT» → Spielminute bzw. Halbzeit (Big Balls kennt keinen eigenen Pausen-Status)
  const clock = String(m.clock ?? '').trim();
  const cm = /^(\d{1,3}(?:\+\d{1,2})?)/.exec(clock);
  const sinceKo = Date.now() - Date.parse(m.kickoff_utc);
  const known = ['live', 'in_progress', 'scheduled', 'not_started', 'tbd', 'finished', 'ended', 'awarded', 'halftime', 'half_time', 'break', 'postponed', 'cancelled', 'canceled', 'suspended', 'abandoned'];
  let st = raw === 'finished' || raw === 'ended' || raw === 'awarded' ? 'ft' : raw === 'halftime' || raw === 'half_time' || raw === 'break' || /^(ht|half)/i.test(clock) ? 'ht'
    : ['postponed', 'cancelled', 'canceled', 'suspended', 'abandoned'].includes(raw) ? 'off'
    : raw === 'live' || raw === 'in_progress' ? 'live' : 'pre';
  // Unbekannter Status nach dem Anpfiff: bis 150 Min. als laufend werten (Spielstand sichtbar), danach mit Spielstand als beendet
  if (st === 'pre' && raw && !known.includes(raw) && sinceKo > 0) st = sinceKo < 150 * 60 * 1000 ? 'live' : m.score?.home != null ? 'ft' : 'pre';
  const ls = m.linescore;
  const ht = ls?.home?.length > 1 && ls.home[0] != null ? `${ls.home[0]}:${ls.away[0]}` : '';
  return { id: `bb-${m.id}`, l: lg.id, utc: new Date(m.kickoff_utc).toISOString(), round: String(m.round || '').replace(/^Regular Season - /, ''),
    h: String(m.home?.name || ''), a: String(m.away?.name || ''), hl: fbImg(m.home?.logo_url), al: fbImg(m.away?.logo_url),
    hs: st === 'pre' ? null : m.score?.home ?? null, as: st === 'pre' ? null : m.score?.away ?? null, st, min: st === 'live' && cm ? cm[1] : null, ht, note: st === 'off' ? raw : '' };
}
// Spielplan eines Wettbewerbs (Clubs: Saison = Startjahr; Nationalteams: Kalenderjahr), alle 12 Std.
// /matches ohne Filter liefert nur kommende Spiele – darum zusätzlich eine Seite beendeter Spiele, und der alte Stand bleibt
// erhalten (sonst fallen gespielte Partien beim Neuladen aus der Übersicht)
async function bbFixtures(lg, now) {
  const ck = `bb2:${lg.key}`; // bb2: Stand inkl. beendeter Spiele (ersetzt den alten Stand einmal)
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < (hit.data.status === 'ok' ? 12 * 3600 * 1000 : 30 * 60 * 1000)) return hit.data;
  try {
    const season = String(lg.season === 'cal' ? new Date(now).getUTCFullYear() : fbSeason(new Date(now)));
    const all = [];
    for (let offset = 0; offset < 1200; offset += 200) {
      if (!(await bbAllowed())) { if (!all.length) return hit?.data || { status: 'error', message: 'Tagesgrenze für Big Balls erreicht', matches: [] }; break; }
      const d = await bbGet('matches', { league: lg.key, season, limit: '200', offset: String(offset) });
      const list = (d?.data || []).filter((m) => m.sport === 'football' && !(BB_NOT_MEN.test(m.home?.name || '') || BB_NOT_MEN.test(m.away?.name || '')));
      all.push(...list.map((m) => mapBb(lg, m)));
      if ((d?.data || []).length < 200) break;
    }
    if (await bbAllowed()) {
      const d = await bbGet('matches', { league: lg.key, season, status: 'finished', limit: '200' }).catch(() => null);
      all.push(...(d?.data || []).filter((m) => m.sport === 'football' && !(BB_NOT_MEN.test(m.home?.name || '') || BB_NOT_MEN.test(m.away?.name || ''))).map((m) => mapBb(lg, m)));
    }
    // Zusammenführen: alter Stand (bis 3 Wochen zurück) < beendete < kommende; Torschützen übernehmen
    const byId = new Map();
    for (const m of hit?.data?.matches || []) if (now - Date.parse(m.utc) < 21 * 864e5) byId.set(m.id, m);
    for (const m of all) {
      const o = byId.get(m.id);
      if (o?.st === 'ft' && m.st !== 'ft') continue; // ein bekanntes Schlussresultat nicht durch einen älteren Stand ersetzen
      byId.set(m.id, o?.goals && !m.goals ? { ...m, goals: o.goals } : m);
    }
    const data = { status: 'ok', message: '', matches: [...byId.values()] };
    await cacheSet(ck, data);
    return data;
  } catch (err) {
    const data = { status: 'error', message: String(err?.message || err).slice(0, 160), matches: hit?.data?.matches || [] };
    await cacheSet(ck, data);
    return data;
  }
}
// Tagesliste aller Fussballspiele eines UTC-Tages (bis 2 Seiten à 200) für Live-Stände und Schlussresultate
async function bbDay(day, now, ttl) {
  const ck = `bbday:${day}`;
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < ttl) return hit.data;
  try {
    const list = [];
    for (let offset = 0; offset < 400; offset += 200) {
      if (!(await bbAllowed())) { if (!list.length) return hit?.data || null; break; }
      const d = await bbGet('scores', { sport: 'football', date: day, limit: '200', offset: String(offset) });
      // Gespeicherte Spiele kommen als Array; laut Dokumentation kann der Live-Feed als data.scores.value[] (mit match_id) kommen
      const arr = Array.isArray(d?.data) ? d.data : d?.data?.scores?.value || d?.scores?.value || d?.data?.value || [];
      list.push(...arr.map((x) => {
        const id = x.id || x.match_id;
        const score = x.score || (x.home_score != null ? { home: x.home_score, away: x.away_score } : undefined);
        return { id: `bb-${id}`, m: { ...x, id, score } };
      }).filter((x) => x.m.id));
      if (arr.length < 200) break;
    }
    const data = { list };
    await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || null; }
}
async function bbLeagues(list, now) {
  if (!Deno.env.get('BIGBALLS_KEY')) return list.map(() => ({ status: 'nokey', message: 'Big-Balls-Schlüssel fehlt', matches: [] }));
  const res = await Promise.all(list.map((lg) => bbFixtures(lg, now)));
  const open = (m) => m.st !== 'ft' && m.st !== 'off' && Date.parse(m.utc) < now && now - Date.parse(m.utc) < 30 * 3600e3;
  if (!res.some((r) => r.matches.some(open))) return res;
  // Jeden UTC-Tag mit offenen Spielen abfragen (Abendspiele von gestern stehen nicht in der Liste von heute)
  const days = [...new Set(res.flatMap((r) => r.matches.filter(open).map((m) => m.utc.slice(0, 10))))].sort().slice(-2);
  const liveDay = (d) => res.some((r) => liveWindow(r.matches.filter((m) => m.utc.slice(0, 10) === d), now));
  const lists = await Promise.all(days.map((d) => bbDay(d, now, liveDay(d) ? BB_LIVE_MS : 15 * 60 * 1000)));
  const byId = new Map(lists.flatMap((l) => (l?.list || []).map((x) => [x.id, x.m])));
  const changed = new Set();
  res.forEach((r, i) => r.matches.forEach((m, j) => {
    const x = byId.get(m.id);
    if (!x || !open(m)) return;
    const fresh = mapBb(list[i], { ...x, kickoff_utc: x.kickoff_utc || m.utc, home: x.home || { name: m.h }, away: x.away || { name: m.a } });
    if (fresh.st === 'ft') changed.add(i);
    r.matches[j] = { ...m, st: fresh.st, hs: fresh.hs, as: fresh.as, min: fresh.min, ht: fresh.ht || m.ht, note: fresh.note };
  }));
  for (const i of changed) await cacheSet(`bb2:${list[i].key}`, res[i]);
  return res;
}
// Tore eines Spiels; nach Spielende dauerhaft, sonst 2 Min. gespeichert
async function bbGame(id) {
  const uuid = String(id).replace(/^bb-/, '');
  const ck = `bbev:${uuid}`;
  const hit = await cacheGet(ck);
  if (hit && (hit.data.final || Date.now() - hit.at < BB_LIVE_MS)) return hit.data;
  if (!Deno.env.get('BIGBALLS_KEY') || !(await bbAllowed())) return hit?.data || { goals: [] };
  const [ev, mt] = await Promise.all([bbGet(`matches/${uuid}/events`, { type: 'goals' }), (async () => { try { return (await bbAllowed()) ? await bbGet(`matches/${uuid}`) : null; } catch { return null; } })()]);
  const match = mt?.data || {};
  const home = String(match.home?.name || '');
  const evs = (ev?.data || []).filter((e) => /goal/i.test(String(e.event_type || '')));
  // „team“ ist meist das Team, dem das Tor zählt; bei Eigentoren ist das je nach Quelle unklar.
  // Darum beide Lesarten prüfen und die nehmen, die zum Spielstand passt.
  const build = (ownFlip) => evs.map((e) => {
    const own = /own/i.test(String(e.event_detail || '')), pen = /penalty/i.test(String(e.event_detail || ''));
    const forHome = (home ? e.team === home : true) !== (own && ownFlip);
    return { m: `${e.elapsed ?? ''}${e.elapsed_extra ? `+${e.elapsed_extra}` : ''}`, s: forHome ? 1 : 2,
      n: `${String(e.player_name || '')}${pen ? ' (Pen.)' : own ? ' (Eigentor)' : ''}` };
  });
  const fits = (g) => match.score && g.filter((x) => x.s === 1).length === match.score.home && g.filter((x) => x.s === 2).length === match.score.away;
  const asIs = build(false), flipped = build(true);
  const goals = fits(asIs) || !fits(flipped) ? asIs : flipped;
  const data = { goals, final: match.status === 'finished' };
  await cacheSet(ck, data);
  return data;
}
// Tabelle und Torschützen einer Big-Balls-Liga (zurzeit Premier League)
// Zonen: [von, bis, Art] – cl/el/co = Europacup-Plätze, rel = Relegation, ab = Abstieg (Stand Saison 26/27, ohne Sonderfälle wie Pokalsieger)
const BB_TABLE = {
  pl: { key: 'epl', scorers: 'epl', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [18, 20, 'ab']] },
  bl1: { key: 'bundesliga', scorers: 'bundesliga', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [16, 16, 'rel'], [17, 18, 'ab']] },
  laliga: { key: 'laliga', scorers: 'laliga', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [18, 20, 'ab']] },
  seriea: { key: 'seriea', scorers: 'serie-a', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [18, 20, 'ab']] },
  ligue1: { key: 'ligue1', scorers: 'ligue-1', zones: [[1, 3, 'cl'], [4, 4, 'clq'], [5, 5, 'el'], [6, 6, 'co'], [16, 16, 'rel'], [17, 18, 'ab']] },
};
async function fbLeague(id, kind, now = Date.now()) {
  const cfg = BB_TABLE[id];
  if (!cfg || !Deno.env.get('BIGBALLS_KEY')) return { available: false };
  if (kind === 'scorers') {
    const ck = `bbsc:${cfg.key}`;
    const hit = await cacheGet(ck);
    if (hit && now - hit.at < 6 * 3600 * 1000) return hit.data;
    if (!(await bbAllowed())) return hit?.data || { available: false };
    const d = await bbGet(`leagues/${cfg.scorers}/top-scorers`, { limit: '20' });
    const data = { available: true, rows: (d?.data || []).map((r) => ({ rank: r.rank, n: String(r.player_name || ''), team: String(r.team || ''), g: r.goals ?? 0, a: r.assists ?? 0, mp: r.matches ?? null })) };
    await cacheSet(ck, data);
    return data;
  }
  const ck = `bbtab:${cfg.key}`;
  const hit = await cacheGet(ck);
  const today = new Date(now).toISOString().slice(0, 10);
  const ov = hit && now - hit.at < 30 * 60 * 1000 ? null : await fbOverview(now).catch(() => null);
  const playsToday = ov ? ov.matches.some((m) => m.l === id && zurichDay(m.utc) === zurichDay(today + 'T12:00:00Z')) : false;
  if (hit && now - hit.at < (playsToday ? 30 * 60 * 1000 : 3 * 3600 * 1000)) return hit.data;
  if (!(await bbAllowed())) return hit?.data || { available: false };
  const d = await bbGet('standings', { league: cfg.key });
  const t = d?.data?.standings?.[0];
  const rows = (t?.rows || []).map((r) => ({ rank: r.rank, team: String(r.team_name || ''), logo: fbImg(r.logo_url), p: r.games_played ?? 0, w: r.wins ?? 0, d: r.ties ?? 0, l: r.losses ?? 0,
    gf: r.points_for ?? 0, ga: r.points_against ?? 0, pts: (r.wins ?? 0) * 3 + (r.ties ?? 0) })).sort((a, b) => a.rank - b.rank);
  const data = { available: rows.length > 0, season: String(t?.season || ''), zones: cfg.zones, rows };
  await cacheSet(ck, data);
  return data;
}
const zurichDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date(iso));
// Premier League im Detail: Aufstellung von Sportradar (Spiel über Anstoss und Heimteam zugeordnet), Teamstatistik von Big Balls
const nameKey = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(fc|afc|cf)\b/g, '').replace(/[^a-z]/g, '').slice(0, 6);
async function srMatchFor(m, now) {
  const lg = FB_LEAGUES.find((l) => l.id === m.l);
  if (!lg?.sr || !Deno.env.get('SPORTRADAR_KEY')) return null;
  const sched = await srFixtures({ ...lg, key: lg.sr }, now);
  const t = Date.parse(m.utc);
  return sched.matches.find((x) => Math.abs(Date.parse(x.utc) - t) < 3 * 3600e3 && (nameKey(x.h) === nameKey(m.h) || nameKey(x.a) === nameKey(m.a))) || null;
}
// Ligen mit Aufstellung und Teamstatistik: Premier League und Champions League mit Sportradar-Aufstellung (genauer: Formation,
// Positionen links/rechts), sonst und als Ersatz die Aufstellung von Big Balls (nur Tor/Verteidigung/Mittelfeld/Sturm)
const DETAIL_LEAGUES = new Set(['pl', 'ucl', 'bl1', 'laliga', 'seriea', 'ligue1']);
async function bbLineup(m, now) {
  const uuid = m.id.replace(/^bb-/, '');
  const ck = `bblu:${uuid}`;
  const hit = await cacheGet(ck);
  if (hit && (hit.data.final || now - hit.at < 10 * 60 * 1000)) return hit.data;
  if (Date.parse(m.utc) - now > 90 * 60 * 1000) return { available: false, message: 'Die Aufstellung erscheint etwa eine Stunde vor Anpfiff.' };
  if (!(await bbAllowed())) return hit?.data || { available: false };
  const d = await bbGet(`stored/matches/${uuid}/lineups`);
  const ORDER = { G: 0, D: 1, M: 2, F: 3 }, POS = { G: 'TW', D: 'V', M: 'M', F: 'ST' };
  const team = (list) => {
    const pl = Array.isArray(list) ? list : [];
    const st = pl.filter((p) => p.starter).sort((a, b) => (ORDER[a.position] ?? 9) - (ORDER[b.position] ?? 9) || (a.jersey_number ?? 99) - (b.jersey_number ?? 99));
    const cnt = ['D', 'M', 'F'].map((k) => st.filter((p) => p.position === k).length);
    const ok = st.length === 11 && st[0]?.position === 'G' && cnt.every((c) => c > 0) && cnt.reduce((a, b) => a + b, 0) === 10;
    const bench = pl.filter((p) => !p.starter);
    return { formation: ok ? cnt.join('-') : '', coach: '', start: st.map((p) => ({ id: `bb:${p.player_id}`, n: String(p.name || ''), no: p.jersey_number ?? '', pos: POS[p.position] || '' })),
      bench: bench.map((p) => String(p.name || '')), benchIds: bench.map((p) => `bb:${p.player_id}`) };
  };
  const data = { available: (d?.data?.home || []).some((p) => p.starter), home: team(d?.data?.home), away: team(d?.data?.away), final: m.st === 'ft', src: 'bb' };
  await cacheSet(ck, data);
  return data;
}
async function fbDetail(id, kind, now = Date.now()) {
  const ov = await fbOverview(now);
  const m = ov.matches.find((x) => x.id === id);
  if (!m || !DETAIL_LEAGUES.has(m.l)) return { error: 'nicht verfügbar' };
  if (kind === 'stats') {
    const uuid = id.replace(/^bb-/, '');
    const ck = `bbst:${uuid}`;
    const hit = await cacheGet(ck);
    if (hit && (hit.data.final || now - hit.at < 15 * 60 * 1000)) return hit.data;
    if (m.st === 'pre') return { available: false };
    if (!(await bbAllowed())) return hit?.data || { available: false };
    const d = await bbGet(`matches/${uuid}/statistics`);
    const side = (x) => x && { poss: x.ball_possession, shots: x.total_shots, on: x.shots_on_target, corners: x.corner_kicks, fouls: x.fouls,
      yellow: x.yellow_cards, red: x.red_cards, passes: x.total_passes, acc: x.accurate_passes, saves: x.goalkeeper_saves, offsides: x.offsides };
    const data = { available: d?.meta?.available !== false && !!d?.data?.home, home: side(d?.data?.home), away: side(d?.data?.away), final: m.st === 'ft' };
    await cacheSet(ck, data);
    return data;
  }
  // Aufstellung: erst ab 90 Min. vor Anpfiff sinnvoll; nach Spielende dauerhaft. Sportradar, wo vorhanden, sonst Big Balls
  const sr = await srMatchFor(m, now).catch(() => null);
  if (!sr) return bbLineup(m, now);
  const ck = `srlu:${sr.id}`;
  const hit = await cacheGet(ck);
  // Vor dem Spielerprofil gespeicherte Aufstellungen haben keine Spieler-IDs: einmal neu laden
  const noIds = hit?.data?.available && !hit.data.home?.start?.[0]?.id;
  if (hit && !noIds && (hit.data.final || now - hit.at < 10 * 60 * 1000)) return hit.data;
  if (Date.parse(m.utc) - now > 90 * 60 * 1000) return { available: false, message: 'Die Aufstellung erscheint etwa eine Stunde vor Anpfiff.' };
  if (!(await srAllowed())) return hit?.data || bbLineup(m, now);
  const d = await srGet(`sport_events/${srUrn(sr.id)}/lineups`).catch(() => null);
  if (!d) return hit?.data || bbLineup(m, now);
  const flip = (n) => String(n || '').replace(/^(.+), (.+)$/, '$2 $1');
  const POS = { goalkeeper: 'TW', right_back: 'RV', left_back: 'LV', central_defender: 'IV', defensive_midfielder: 'DM', central_midfielder: 'ZM', right_winger: 'RA', left_winger: 'LA',
    attacking_midfielder: 'OM', striker: 'ST', right_midfielder: 'RM', left_midfielder: 'LM', midfielder: 'M', defender: 'V', forward: 'ST' };
  const team = (c) => c && { formation: c.formation?.type || '', coach: flip(c.manager?.name),
    start: (c.players || []).filter((p) => p.starter).sort((a, b) => (a.order || 0) - (b.order || 0)).map((p) => ({ id: String(p.id || '').split(':').pop(), n: flip(p.name), no: p.jersey_number ?? '', pos: POS[p.position] || POS[p.type] || '' })),
    bench: (c.players || []).filter((p) => !p.starter).map((p) => flip(p.name)), benchIds: (c.players || []).filter((p) => !p.starter).map((p) => String(p.id || '').split(':').pop()) };
  const comps = d?.lineups?.competitors || [];
  const data = { available: comps.some((c) => (c.players || []).some((p) => p.starter)),
    home: team(comps.find((c) => c.qualifier === 'home')), away: team(comps.find((c) => c.qualifier === 'away')), final: m.st === 'ft' };
  await cacheSet(ck, data);
  return data;
}

// ---------- Spielerprofil: Sportradar (Steckbrief, Saisonwerte, letzte Spiele) + Wikipedia (Karriere, Foto) ----------
const WIKI_UA = 'euroleague-pwa/1.0 (https://github.com/CCodeL9876/euroleague)';
const FOOT = { left: 'Links', right: 'Rechts', both: 'Beidfüssig' };
const POS_DE = { goalkeeper: 'Torhüter', defender: 'Verteidigung', midfielder: 'Mittelfeld', forward: 'Sturm' };
function wikiClean(v) {
  return String(v || '').replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<[^>]+>/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '').replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/&nbsp;/g, ' ').trim();
}
// Infobox „football biography“: youth_years/youth_clubs, years/clubs/caps/goals, national_years/national_team/… (Nummern 1, 2, …;
// ältere Artikel ohne Unterstrich). Junioren-Nationalteams (U21 usw.) bleiben weg.
export function parseFootballCareer(wikitext) {
  const fields = {};
  const re = /\|\s*(youth_?years|youth_?clubs|years|clubs|caps|goals|national_?years|national_?team|national_?caps|national_?goals)(\d+)\s*=\s*((?:\[\[[^\]]*\]\]|\{\{[^}]*\}\}|<ref[\s\S]*?<\/ref>|[^|\n])*)/g;
  let m;
  while ((m = re.exec(String(wikitext || '')))) {
    const f = m[1].replace('_', ''), kind = f.startsWith('youth') ? 'youth' : f.startsWith('national') ? 'nat' : 'club';
    const prop = /years/.test(f) ? 'y' : /clubs|team/.test(f) ? 'c' : /caps/.test(f) ? 'gp' : 'g';
    (fields[`${kind}${m[2]}`] ||= { kind })[prop] = m[3];
  }
  const out = [];
  for (const v of Object.values(fields)) {
    const team = wikiClean(v.c).replace(/^→\s*/, ''), yrs = wikiClean(v.y);
    const y = /(\d{4})(?:\s*[–—-]\s*(\d{4})?)?/.exec(yrs);
    if (!team || !y || (v.kind === 'nat' && /\bU-?\d{2}\b|under-\d{2}|olympic/i.test(team))) continue;
    const n = (x) => { const k = parseInt(wikiClean(x), 10); return Number.isFinite(k) ? k : null; };
    out.push({ kind: v.kind, team, loan: String(v.c || '').trim().startsWith('→'), from: Number(y[1]), to: y[2] ? Number(y[2]) : /[–—-]\s*$/.test(yrs) ? null : Number(y[1]),
      gp: v.kind === 'youth' ? null : n(v.gp), g: v.kind === 'youth' ? null : n(v.g) });
  }
  return out.sort((a, b) => (a.kind === 'nat') - (b.kind === 'nat') || (b.to ?? 9999) - (a.to ?? 9999) || b.from - a.from);
}
async function sparql(q) {
  const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { accept: 'application/sparql-results+json', 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`sparql ${res.status}`);
  return (await res.json())?.results?.bindings || [];
}
const plainName = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
// Fussballer (Q937857) mit gleichem Geburtsdatum und passendem Namen → englischer Artikel, Karriere und Foto
async function wikiFootballer(name, birth) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return { career: [], img: '' };
  const rows = await sparql(`SELECT ?l ?a ?img WHERE { ?p wdt:P106 wd:Q937857 ; wdt:P569 ?b . FILTER(?b = "${birth}T00:00:00Z"^^xsd:dateTime)
    ?p rdfs:label ?l . FILTER(LANG(?l) = "en") ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> . OPTIONAL { ?p wdt:P18 ?img } }`);
  const want = plainName(name), last = want.split(' ').pop();
  // Artikel „… (footballer, born 1995)“ mit anderem Jahr verwerfen (Wikidata hat dort teils falsche Geburtsdaten)
  const ok = rows.filter((r) => { const y = /born_(\d{4})/.exec(r.a.value)?.[1]; return !y || y === birth.slice(0, 4); });
  const hit = ok.find((r) => plainName(r.l.value) === want) || ok.find((r) => plainName(r.l.value).split(' ').includes(last)) || (ok.length === 1 ? ok[0] : null);
  if (!hit) return { career: [], img: '' };
  const title = decodeURIComponent(hit.a.value.split('/wiki/')[1] || '');
  const wp = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`,
    { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()).catch(() => null);
  const career = parseFootballCareer(wp?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content);
  let img = '';
  if (hit.img?.value) {
    const file = decodeURIComponent(hit.img.value.split('/Special:FilePath/')[1] || '');
    const ii = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=240&format=json&formatversion=2&titles=${encodeURIComponent(`File:${file}`)}`,
      { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()).catch(() => null);
    const u = String(ii?.query?.pages?.[0]?.imageinfo?.[0]?.thumburl || '').replace(/\?.*$/, '');
    if (/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(u)) img = u;
  }
  return { career, img, article: title };
}
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
// Wikipedia-Suche über Nachname + Verein (wenn das Geburtsdatum fehlt, z. B. Big Balls mit «S. Guirassy»):
// Artikel des Fussballers → voller Name, Geburtsdatum, Grösse, Karriere, Foto, Nationalteam
async function wikiByName(name, club) {
  const last = String(name || '').split(/\s+/).pop();
  if (!last) return null;
  const api = 'https://en.wikipedia.org/w/api.php?format=json&formatversion=2&action=query';
  const get = (q) => fetch(`${api}&${q}`, { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()).catch(() => null);
  const sr = await get(`list=search&srlimit=5&srsearch=${encodeURIComponent(`${last} ${club || ''} footballer`)}`);
  const plainLast = plainName(last);
  const hit = (sr?.query?.search || []).find((r) => plainName(r.title).split(' ').includes(plainLast) && /footballer|football player/i.test(r.snippet || '') && !/season|list of/i.test(r.title));
  if (!hit) return null;
  const pg = (await get(`prop=revisions|pageimages&rvprop=content&rvslots=main&rvsection=0&piprop=thumbnail&pithumbsize=240&redirects=1&titles=${encodeURIComponent(hit.title)}`))?.query?.pages?.[0];
  const text = pg?.revisions?.[0]?.slots?.main?.content || '';
  const b = /birth_date\s*=\s*\{\{\s*birth date(?: and age)?\s*\|(?:\s*df=y\s*\|)?\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i.exec(text);
  const h = /\|\s*height\s*=\s*(?:\{\{\s*height\s*\|\s*m\s*=\s*)?([12][.,]\d{1,2})/i.exec(text);
  const thumb = String(pg?.thumbnail?.source || '').replace(/\?.*$/, '');
  const career = parseFootballCareer(text);
  return { name: hit.title.replace(/\s*\(.*\)$/, ''), birth: b ? `${b[1]}-${b[2].padStart(2, '0')}-${b[3].padStart(2, '0')}` : '',
    height: h ? Math.round(parseFloat(h[1].replace(',', '.')) * 100) : null, career, img: /^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(thumb) ? thumb : '',
    nation: career.find((c) => c.kind === 'nat')?.team || '', article: hit.title };
}
// Spielerprofil aus Big Balls (Spieler aus Big-Balls-Aufstellungen): Steckbrief, Transfers (7 Tage), Saisonwerte pro Wettbewerb (6 Std.)
const pick = (o, ...keys) => { for (const k of keys) { const v = k.split('.').reduce((x, y) => x?.[y], o); if (v != null && v !== '') return v; } return null; };
async function fbPlayerBb(uuid, now) {
  if (!Deno.env.get('BIGBALLS_KEY')) return { available: false };
  const ckP = `bbpl:${uuid}`, ckF = `bbpf:${uuid}`;
  let prof = await cacheGet(ckP);
  if (!prof || prof.data?.wv !== 2 || now - prof.at > 7 * 864e5) { // wv 2: Wikipedia-Suche über Name + Verein
    if (!(await bbAllowed())) { if (!prof) return { available: false, message: 'Tagesgrenze erreicht' }; }
    else {
      const [pr, tr] = await Promise.all([bbGet(`players/${uuid}/profile`).catch(() => null), (async () => ((await bbAllowed()) ? bbGet(`players/${uuid}/transfers`).catch(() => null) : null))()]);
      const P = pr?.data?.player || pr?.data?.players?.value?.[0] || pr?.data || {};
      const name = String(pick(P, 'name', 'full_name', 'display_name') || [P.first_name, P.last_name].filter(Boolean).join(' '));
      const birth = String(pick(P, 'birth_date', 'date_of_birth', 'birthdate', 'dob') || '').slice(0, 10);
      const cm = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? (n < 3 ? Math.round(n * 100) : Math.round(n)) : null; };
      const transfers = (tr?.data || []).slice(0, 8).map((t) => ({ date: String(t.date || ''), from: String(t.from_club || ''), to: String(t.to_club || ''), type: String(t.type || ''), fee: t.fee ?? null }));
      const club0 = String(pick(P, 'current_team.name', 'team.name', 'team_name', 'current_team') || '');
      const hasBirth = /^\d{4}-\d\d-\d\d$/.test(birth);
      // Mit Geburtsdatum über Wikidata, sonst über die Wikipedia-Suche (Nachname + Verein)
      const wiki = (hasBirth ? await wikiFootballer(name, birth).catch(() => null) : null) || (await wikiByName(name, club0).catch(() => null)) || { career: [], img: '' };
      const data = { available: Boolean(name), id: `bb:${uuid}`, name: wiki.name && /^\w\.\s/.test(name) ? wiki.name : name, birth: hasBirth ? birth : wiki.birth || '',
        nation: String(pick(P, 'nationality', 'country', 'nationality.name', 'country.name') || wiki.nation || ''),
        height: cm(pick(P, 'height', 'height_cm')) ?? wiki.height ?? null, weight: cm(pick(P, 'weight', 'weight_kg')), no: pick(P, 'jersey_number', 'number') ?? '', foot: '', pos: ({ g: 'Torhüter', goalkeeper: 'Torhüter', d: 'Verteidigung', defender: 'Verteidigung', m: 'Mittelfeld', midfielder: 'Mittelfeld', f: 'Sturm', attacker: 'Sturm', forward: 'Sturm' })[String(pick(P, 'position', 'position_name') || '').toLowerCase()] || String(pick(P, 'position', 'position_name') || ''),
        club: club0, transfers, wv: 2, career: wiki.career, img: wiki.img || (/^https:\/\/api\.bigballsdata\.com\//.test(String(P.headshot_url || '')) ? P.headshot_url : ''),
        _k: Object.keys(P).slice(0, 30) };
      await cacheSet(ckP, data);
      prof = { data, at: now };
    }
  }
  let form = await cacheGet(ckF);
  if ((!form || now - form.at > 6 * 3600e3) && prof.data.available && (await bbAllowed())) {
    const d = await bbGet(`players/${uuid}/club-form`).catch(() => null);
    if (d) {
      const rows = (Array.isArray(d.data) ? d.data : []).map((r) => ({ season: Number(r.season) || 0, comp: String(r.league || ''), team: String(r.team || ''),
        st: { gp: num(r.appearances), g: num(r.goals), a: num(r.assists), min: num(r.minutes), sh: null, on: num(r.shots_on), y: num(r.yellow_cards), r: num(r.red_cards) } }));
      await cacheSet(ckF, rows);
      form = { data: rows, at: now };
    }
  }
  // Saisonwerte: nur die jüngste Saison; Ligen als «26/27», Nationalteam-Wettbewerbe als Kalenderjahr
  const rows = form?.data || [];
  const top = Math.max(0, ...rows.map((r) => r.season));
  const seasons = rows.filter((r) => r.season === top && r.st.gp).map((r) => ({ ...r, cur: true,
    year: /nations|world|euro|friendl|qualif/i.test(r.comp) ? String(r.season) : `${String(r.season).slice(2)}/${String(r.season + 1).slice(2)}` }));
  if (!prof.data.club && seasons[0]?.team) prof.data.club = seasons.find((x) => !/nations|world|euro|friendl|qualif/i.test(x.comp))?.team || '';
  return { ...prof.data, seasons, games: [] };
}
// Steckbrief + Saisonwerte (7 Tage gespeichert), letzte Spiele (6 Std.)
async function fbPlayer(pid, now = Date.now()) {
  const bb = /^bb:([0-9a-f-]{36})$/i.exec(pid);
  if (bb) return fbPlayerBb(bb[1].toLowerCase(), now);
  if (!/^\d{1,12}$/.test(pid) || !Deno.env.get('SPORTRADAR_KEY')) return { available: false };
  const urn = `sr:player:${pid}`;
  const ckP = `srpl:${pid}`, ckS = `srps2:${pid}`; // srps2: letzte Spiele mit Saison- und Team-ID
  let prof = await cacheGet(ckP);
  if (!prof || prof.data?.wv !== 2 || now - prof.at > 7 * 864e5) { // wv 2: korrigierte Wikipedia-Zuordnung
    if (!(await srAllowed())) { if (!prof) return { available: false, message: 'Tagesgrenze erreicht' }; }
    else {
      const d = await srGet(`players/${urn}/profile`);
      const p = d?.player || {};
      const roles = (d?.roles || []).filter((r) => r.type === 'player');
      const club = roles.find((r) => r.active && r.competitor?.country_code !== p.country_code) || roles.find((r) => r.active) || null;
      const name = String(p.name || '').replace(/^(.+), (.+)$/, '$2 $1');
      const seasons = (d?.statistics?.seasons || []).map((x) => ({ season: String(x.name || x.year || ''), year: String(x.year || ''), comp: String(x.competition?.name || ''), team: String(x.competitor?.name || ''),
        st: { gp: num(x.statistics?.matches_played), g: num(x.statistics?.goals_scored), a: num(x.statistics?.assists), min: num(x.statistics?.minutes_played),
          sh: num(x.statistics?.shots_on_target != null || x.statistics?.shots_off_target != null ? (Number(x.statistics?.shots_on_target) || 0) + (Number(x.statistics?.shots_off_target) || 0) + (Number(x.statistics?.shots_blocked) || 0) : null),
          on: num(x.statistics?.shots_on_target), y: num(x.statistics?.yellow_cards), r: num((Number(x.statistics?.red_cards) || 0) + (Number(x.statistics?.yellow_red_cards) || 0)) } }));
      const wiki = await wikiFootballer(name, String(p.date_of_birth || '')).catch(() => ({ career: [], img: '' }));
      const data = { available: Boolean(p.id), id: pid, name, birth: String(p.date_of_birth || ''), place: String(p.place_of_birth || ''), nation: String(p.nationality || ''),
        height: num(p.height), weight: num(p.weight), no: p.jersey_number ?? club?.jersey_number ?? '', foot: FOOT[p.preferred_foot] || '', pos: POS_DE[p.type] || '',
        club: String(club?.competitor?.name || ''), clubSince: String(club?.start_date || '').slice(0, 10), seasons, career: wiki.career, img: wiki.img, article: wiki.article || '',
        wv: 2 };
      await cacheSet(ckP, data);
      prof = { data, at: now };
    }
  }
  let sums = await cacheGet(ckS);
  if ((!sums || now - sums.at > 6 * 3600e3) && prof.data.available && (await srAllowed())) {
    try {
      const d = await srGet(`players/${urn}/summaries`);
      const games = (d?.summaries || []).filter((x) => ['closed', 'ended'].includes(x.sport_event_status?.status)).slice(0, 10).map((x) => {
        const ev = x.sport_event || {}, cs = ev.competitors || [], st = x.sport_event_status || {};
        const mine = (x.statistics?.totals?.competitors || []).find((c) => (c.players || []).some((pl) => pl.id === urn));
        const ps = (mine?.players || []).find((pl) => pl.id === urn)?.statistics || {};
        const home = cs.find((c) => c.qualifier === 'home') || cs[0] || {}, away = cs.find((c) => c.qualifier === 'away') || cs[1] || {};
        const isHome = mine ? mine.id === home.id : null;
        const ctx = ev.sport_event_context || {};
        return { utc: String(ev.start_time || ''), comp: String(ctx.competition?.name || ''), sid: String(ctx.season?.id || ''), year: String(ctx.season?.year || ''), cid: String(mine?.id || ''),
          h: String(home.name || ''), a: String(away.name || ''),
          hs: st.home_score ?? null, as: st.away_score ?? null, home: isHome, g: num(ps.goals_scored) || 0, ast: num(ps.assists) || 0, min: num(ps.minutes_played),
          in: num(ps.substituted_in) || 0, out: num(ps.substituted_out) || 0, y: num(ps.yellow_cards) || 0, r: (num(ps.red_cards) || 0) + (num(ps.yellow_red_cards) || 0) };
      });
      await cacheSet(ckS, games);
      sums = { data: games, at: now };
    } catch { /* letzte Spiele fehlen dann */ }
  }
  // Saisonwerte: Das Profil enthält keine; darum die Teamstatistik der Saisons aus den letzten Spielen (Liga, Europacup).
  // Gespeichert pro Saison und Team (6 Std.) – gilt so für alle Spieler desselben Teams.
  const games = sums?.data || [];
  const pairs = [...new Map(games.filter((g) => g.sid && g.cid).map((g) => [`${g.sid}|${g.cid}`, g])).values()].slice(0, 2);
  const seasons = [];
  for (const g of pairs) {
    const ck = `srcs:${g.sid}:${g.cid}`;
    let hit = await cacheGet(ck);
    if (!hit || now - hit.at > 6 * 3600e3) {
      if (!(await srAllowed())) { if (!hit) continue; }
      else {
        try {
          const d = await srGet(`seasons/${g.sid}/competitors/${g.cid}/statistics`);
          const players = (d?.competitor?.players || []).map((x) => ({ id: x.id, st: x.statistics || {} }));
          await cacheSet(ck, players);
          hit = { data: players, at: now };
        } catch { if (!hit) continue; }
      }
    }
    const x = (hit.data || []).find((pl) => pl.id === urn)?.st;
    if (!x) continue;
    const shots = x.shots_on_target != null || x.shots_off_target != null ? (Number(x.shots_on_target) || 0) + (Number(x.shots_off_target) || 0) + (Number(x.shots_blocked) || 0) : null;
    seasons.push({ season: g.year, year: g.year, comp: g.comp, st: { gp: num(x.matches_played), g: num(x.goals_scored), a: num(x.assists), min: num(x.minutes_played),
      sh: shots, on: num(x.shots_on_target), y: num(x.yellow_cards), r: x.red_cards != null || x.yellow_red_cards != null ? (Number(x.red_cards) || 0) + (Number(x.yellow_red_cards) || 0) : null } });
  }
  return { ...prof.data, seasons: seasons.length ? seasons : prof.data.seasons || [], games: games.slice(0, 6).map(({ sid, cid, ...g }) => g) };
}

// ---------- Sportradar Soccer v4 (Schweizer Ligen; Aufstellungen Premier League und Champions League) ----------
const srBase = () => `https://api.sportradar.com/soccer/${Deno.env.get('SPORTRADAR_LEVEL') || 'trial'}/v4/en`;
const srDailyMax = () => Number(Deno.env.get('SPORTRADAR_DAILY')) || 60;
const SR_LIVE_MS = 7 * 60 * 1000; // Sonntage mit Spielen von 14 bis 19 Uhr bleiben so unter 60 Abfragen
const srAllowed = () => dailyAllowed('srcount', srDailyMax());
// Test-Zugang: höchstens 1 Abfrage pro Sekunde, darum nacheinander mit Abstand
let srLast = 0;
async function srGet(path, params = {}) {
  const wait = srLast + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  srLast = Date.now();
  const q = new URLSearchParams({ ...params, api_key: Deno.env.get('SPORTRADAR_KEY') || '' });
  const res = await fetch(`${srBase()}/${path}.json?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(String(d?.message || `HTTP ${res.status}`));
  return d;
}
const srId = (urn) => `sr-${String(urn || '').split(':').pop()}`;
const srUrn = (id) => `sr:sport_event:${String(id).replace(/^sr-/, '')}`;
// Status: closed/ended = Ende, live mit match_status halftime = Pause, abgesagt/verschoben = off
function srState(es) {
  const st = String(es?.status || ''), ms = String(es?.match_status || '');
  if (st === 'closed' || st === 'ended') return 'ft';
  if (['postponed', 'cancelled', 'abandoned', 'suspended'].includes(st)) return 'off';
  if (st === 'live' || st === 'started' || st === 'interrupted') return ms === 'halftime' || ms === 'extra_time_halftime' ? 'ht' : 'live';
  return 'pre';
}
const srMin = (es) => { const p = /^(\d+)/.exec(String(es?.clock?.played || '')); return p ? Number(p[1]) || null : null; };
// Tore aus einer Timeline (score_change), mit Torschütze, Elfmeter/Eigentor
function srGoals(timeline) {
  return (timeline || []).filter((e) => e.type === 'score_change').map((e) => {
    const sc = (e.players || []).find((p) => p.type === 'scorer');
    const extra = e.stoppage_time ? `+${e.stoppage_time}` : '';
    return { m: `${e.match_time ?? ''}${extra}`, s: e.competitor === 'away' ? 2 : 1, id: String(sc?.id || '').split(':').pop(),
      n: `${String(sc?.name || '').replace(/^(.+), (.+)$/, '$2 $1')}${e.method === 'penalty' ? ' (Pen.)' : e.method === 'own_goal' ? ' (Eigentor)' : ''}` };
  });
}
// Wappen der Sportradar-Teams (Sportradar liefert in der Soccer API keine Bilder): Wikipedia-Vorschaubilder, 120 px
const SR_LOGO = {
  'AFC Bournemouth': 'en/thumb/e/e5/AFC_Bournemouth_%282013%29.svg/120px-AFC_Bournemouth_%282013%29.svg.png',
  'Arsenal FC': 'en/thumb/5/53/Arsenal_FC.svg/120px-Arsenal_FC.svg.png',
  'Aston Villa': 'en/thumb/9/9a/Aston_Villa_FC_new_crest.svg/120px-Aston_Villa_FC_new_crest.svg.png',
  'Brentford FC': 'en/thumb/2/2a/Brentford_FC_crest.svg/120px-Brentford_FC_crest.svg.png',
  'Brighton & Hove Albion': 'en/thumb/d/d0/Brighton_and_Hove_Albion_FC_crest.svg/120px-Brighton_and_Hove_Albion_FC_crest.svg.png',
  'Chelsea FC': 'en/thumb/c/cc/Chelsea_FC.svg/120px-Chelsea_FC.svg.png',
  'Coventry City': 'en/thumb/7/7b/Coventry_City_FC_crest.svg/120px-Coventry_City_FC_crest.svg.png',
  'Crystal Palace': 'en/thumb/a/a2/Crystal_Palace_FC_logo_%282022%29.svg/120px-Crystal_Palace_FC_logo_%282022%29.svg.png',
  'Etoile Carouge FC': 'commons/thumb/5/55/%C3%89toile_Carouge_FC_2023_Logo.svg/120px-%C3%89toile_Carouge_FC_2023_Logo.svg.png',
  'Everton FC': 'en/thumb/7/7c/Everton_FC_logo.svg/120px-Everton_FC_logo.svg.png',
  'FC Aarau': 'en/thumb/3/3b/Wappen_FCAg.svg/120px-Wappen_FCAg.svg.png',
  'FC Basel 1893': 'commons/thumb/c/c1/FC_Basel_crest.svg/120px-FC_Basel_crest.svg.png',
  'FC Lugano': 'commons/thumb/1/1c/Logo_FC_Lugano_2025.svg/120px-Logo_FC_Lugano_2025.svg.png',
  'FC Luzern': 'en/thumb/1/12/FC_Luzern_crest.svg/120px-FC_Luzern_crest.svg.png',
  'FC Rapperswil-Jona': 'en/thumb/3/33/FC_Rapperswil-Jona_logo.svg/120px-FC_Rapperswil-Jona_logo.svg.png',
  'FC Sion': 'commons/thumb/d/d4/FC_Sion.svg/120px-FC_Sion.svg.png',
  'FC St. Gallen 1879': 'commons/thumb/e/e3/FC_St._Gallen_logo.svg/120px-FC_St._Gallen_logo.svg.png',
  'FC Stade Nyonnais': 'en/thumb/4/48/FC_Stade_Nyonnais_logo.svg/120px-FC_Stade_Nyonnais_logo.svg.png',
  'FC Thun': 'commons/thumb/2/24/FC_Thun_Logo_2011.svg/120px-FC_Thun_Logo_2011.svg.png',
  'FC Vaduz': 'en/thumb/c/c5/FC_Vaduz_logo.svg/120px-FC_Vaduz_logo.svg.png',
  'FC Wil 1900': 'en/thumb/5/5a/FC_Wil_logo.svg/120px-FC_Wil_logo.svg.png',
  'FC Winterthur': 'en/thumb/a/a9/FC_Winterthur_logo.svg/120px-FC_Winterthur_logo.svg.png',
  'FC Zurich': 'commons/thumb/6/68/FC_Zurich_Logo_2022.svg/120px-FC_Zurich_Logo_2022.svg.png',
  'Fulham FC': 'en/thumb/e/eb/Fulham_FC_%28shield%29.svg/120px-Fulham_FC_%28shield%29.svg.png',
  'Grasshopper Club Zurich': 'commons/thumb/f/ff/GC_Z%C3%BCrich_Logo.svg/120px-GC_Z%C3%BCrich_Logo.svg.png',
  'Hull City': 'en/thumb/5/54/Hull_City_A.F.C._logo.svg/120px-Hull_City_A.F.C._logo.svg.png',
  'Ipswich Town': 'en/thumb/4/43/Ipswich_Town.svg/120px-Ipswich_Town.svg.png',
  'Lausanne-Sport': 'commons/thumb/0/0d/FC_Lausanne-Sport_logo.svg/120px-FC_Lausanne-Sport_logo.svg.png',
  'Leeds United': 'en/thumb/5/54/Leeds_United_F.C._logo.svg/120px-Leeds_United_F.C._logo.svg.png',
  'Liverpool FC': 'en/thumb/0/0c/Liverpool_FC.svg/120px-Liverpool_FC.svg.png',
  'Manchester City': 'en/thumb/e/eb/Manchester_City_FC_badge.svg/120px-Manchester_City_FC_badge.svg.png',
  'Manchester United': 'en/thumb/7/7a/Manchester_United_FC_crest.svg/120px-Manchester_United_FC_crest.svg.png',
  'Neuchatel Xamax': 'en/thumb/6/6f/Neuch%C3%A2tel_Xamax_FCS_logo.svg/120px-Neuch%C3%A2tel_Xamax_FCS_logo.svg.png',
  'Newcastle United': 'en/thumb/8/87/Newcastle_United_FC_2026_crest.svg/120px-Newcastle_United_FC_2026_crest.svg.png',
  'Nottingham Forest': 'en/thumb/e/e5/Nottingham_Forest_F.C._logo.svg/120px-Nottingham_Forest_F.C._logo.svg.png',
  'SC Kriens': 'en/thumb/d/d6/SC_Kriens_logo.svg/120px-SC_Kriens_logo.svg.png',
  'Servette Geneva': 'en/thumb/f/f4/Servette_FC_crest.svg/120px-Servette_FC_crest.svg.png',
  'Stade Lausanne Ouchy': 'en/thumb/0/0e/FC_Stade_Lausanne_Ouchy_logo.svg/120px-FC_Stade_Lausanne_Ouchy_logo.svg.png',
  'Sunderland AFC': 'en/thumb/7/77/Logo_Sunderland.svg/120px-Logo_Sunderland.svg.png',
  'Tottenham Hotspur': 'en/thumb/b/b4/Tottenham_Hotspur.svg/120px-Tottenham_Hotspur.svg.png',
  'Young Boys Bern': 'commons/thumb/c/c2/BSC_Young_Boys.svg/120px-BSC_Young_Boys.svg.png',
  'Yverdon-Sport': 'commons/thumb/8/83/Logo_Yverdon_Sport_FC.png/120px-Logo_Yverdon_Sport_FC.png',
};
// Anzeigenamen: Sportradar-Namen kürzen (Zusätze wie FC/AFC und Gründungsjahre weg, Schweizer Namen wie üblich)
const SR_NAME = { 'Young Boys Bern': 'Young Boys', 'Servette Geneva': 'Servette', 'Grasshopper Club Zurich': 'GC Zürich', 'FC Zurich': 'FC Zürich',
  'Neuchatel Xamax': 'Xamax', 'Etoile Carouge FC': 'Étoile Carouge', 'Stade Lausanne Ouchy': 'Lausanne-Ouchy', 'FC Stade Nyonnais': 'Stade Nyonnais',
  'Brighton & Hove Albion': 'Brighton', 'Tottenham Hotspur': 'Tottenham', 'Manchester United': 'Man United', 'Manchester City': 'Man City', 'AFC Bournemouth': 'Bournemouth' };
const srName = (n) => SR_NAME[n] || String(n || '').replace(/ (19|18)\d\d$/, '').replace(/ A?FC$/, '');
const SR_LOGO_SHORT = Object.fromEntries(Object.keys(SR_LOGO).map((n) => [srName(n), SR_LOGO[n]]));
const srLogo = (n) => { const f = SR_LOGO[n] || SR_LOGO_SHORT[n]; return f ? `https://upload.wikimedia.org/wikipedia/${f}` : ''; };
export function mapSr(lg, sum) {
  const ev = sum.sport_event || {}, es = sum.sport_event_status || {};
  const comp = ev.competitors || [];
  const home = comp.find((c) => c.qualifier === 'home') || comp[0] || {}, away = comp.find((c) => c.qualifier === 'away') || comp[1] || {};
  const st = srState(es);
  const p1 = (es.period_scores || []).find((p) => p.number === 1);
  const rnd = ev.sport_event_context?.round;
  return { id: srId(ev.id), l: lg.id, utc: new Date(ev.start_time).toISOString(), round: rnd?.number ? String(rnd.number) : String(rnd?.name || ''),
    h: srName(home.name || home.short_name), a: srName(away.name || away.short_name), hl: srLogo(home.name), al: srLogo(away.name),
    hs: st === 'pre' ? null : es.home_score ?? null, as: st === 'pre' ? null : es.away_score ?? null,
    st, min: st === 'live' ? srMin(es) : null, ht: p1 ? `${p1.home_score}:${p1.away_score}` : '', note: st === 'off' ? String(es.status || '') : '' };
}
// Laufende (oder als nächste anstehende) Saison eines Wettbewerbs, einmal am Tag
async function srSeason(lg, now) {
  const ck = `srseason:${lg.key}`;
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < 24 * 3600 * 1000) return hit.data;
  if (!(await srAllowed())) return hit?.data || null;
  const d = await srGet(`competitions/${lg.key}/seasons`);
  const today = new Date(now).toISOString().slice(0, 10);
  const list = (d?.seasons || []).filter((x) => x.start_date && x.start_date <= today).sort((a, b) => b.start_date.localeCompare(a.start_date));
  const cur = list.find((x) => !x.end_date || x.end_date >= today) || list[0];
  const id = cur?.id || null;
  if (id) await cacheSet(ck, id);
  return id;
}
// Spielplan der Saison (bis 200 Spiele pro Abfrage), alle 12 Std.; Fehler nur 30 Min. merken
async function srFixtures(lg, now) {
  const ck = `sr:${lg.key}`;
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < (hit.data.status === 'ok' ? 12 * 3600 * 1000 : 30 * 60 * 1000)) return hit.data;
  try {
    const season = await srSeason(lg, now);
    if (!season) throw new Error('Keine laufende Saison gefunden');
    const all = [];
    for (let start = 0; start < 1000; start += 200) {
      if (!(await srAllowed())) { if (!all.length) return hit?.data || { status: 'error', message: 'Tagesgrenze für Sportradar erreicht', matches: [] }; break; }
      const d = await srGet(`seasons/${season}/summaries`, { start: String(start), limit: '200' });
      const sums = d?.summaries || [];
      all.push(...sums.map((x) => mapSr(lg, x)));
      if (sums.length < 200) break;
    }
    // Bekannte Torschützen und Schlussstände aus dem alten Stand übernehmen
    const old = new Map((hit?.data?.matches || []).map((m) => [m.id, m]));
    for (const m of all) { const o = old.get(m.id); if (o?.goals && !m.goals) m.goals = o.goals; }
    const data = { status: all.length ? 'ok' : 'error', message: all.length ? '' : 'Kein Spielplan erhalten', matches: all };
    await cacheSet(ck, data);
    return data;
  } catch (err) {
    const data = { status: 'error', message: String(err?.message || err).slice(0, 160), matches: hit?.data?.matches || [] };
    await cacheSet(ck, data);
    return data;
  }
}
// Live-Timelines aller laufenden Spiele weltweit (eine Abfrage): Stand, Minute und Tore
async function srLive(now) {
  const ck = 'srlive';
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < SR_LIVE_MS) return hit.data;
  if (!(await srAllowed())) return hit?.data || null;
  try {
    const d = await srGet('schedules/live/timelines');
    const data = { list: (d?.sport_event_timelines || []).map((t) => ({ id: srId(t.id), es: t.sport_event_status || {}, goals: srGoals(t.timeline) })) };
    await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || null; }
}
// Timeline eines Spiels: Torschützen; nach Spielende dauerhaft gespeichert
async function srTimeline(id, now = Date.now()) {
  const ck = `srev:${id}`;
  const hit = await cacheGet(ck);
  // Noch nicht angepfiffen / verschoben (z. B. Verspätung): nur stündlich nachfragen statt bei jedem Live-Durchgang
  const quiet = hit && ['pre', 'off'].includes(srState(hit.data.es));
  if (hit && (hit.data.final || now - hit.at < (quiet ? 60 * 60 * 1000 : SR_LIVE_MS))) return hit.data;
  if (!Deno.env.get('SPORTRADAR_KEY') || !(await srAllowed())) return hit?.data || null;
  const d = await srGet(`sport_events/${srUrn(id)}/timeline`);
  const es = d?.sport_event_status || {};
  const data = { goals: srGoals(d?.timeline), final: srState(es) === 'ft', es };
  await cacheSet(ck, data);
  return data;
}
async function srLeagues(list, now) {
  if (!Deno.env.get('SPORTRADAR_KEY')) return list.map(() => ({ status: 'nokey', message: 'Sportradar-Schlüssel fehlt', matches: [] }));
  const res = [];
  for (const lg of list) res.push(await srFixtures(lg, now)); // nacheinander (1 Abfrage/Sek.)
  const open = (m) => m.st !== 'ft' && m.st !== 'off' && Date.parse(m.utc) < now && now - Date.parse(m.utc) < 12 * 3600e3;
  if (!res.some((r) => r.matches.some(open))) return res;
  const live = res.some((r) => liveWindow(r.matches, now)) ? await srLive(now) : null;
  const byId = new Map((live?.list || []).map((x) => [x.id, x]));
  const changed = new Set();
  for (let i = 0; i < res.length; i++) {
    const arr = res[i].matches;
    for (let j = 0; j < arr.length; j++) {
      const m = arr[j];
      if (!open(m)) continue;
      let x = byId.get(m.id);
      // Nicht (mehr) in der Live-Liste und seit über 100 Min. angepfiffen: wohl beendet, einmal die Timeline holen
      if (!x && now - Date.parse(m.utc) > 100 * 60 * 1000) { const t = await srTimeline(m.id, now).catch(() => null); if (t) x = { es: t.es, goals: t.goals }; }
      if (!x) continue;
      const st = srState(x.es);
      const p1 = (x.es.period_scores || []).find((p) => p.number === 1);
      arr[j] = { ...m, st, hs: st === 'pre' ? null : x.es.home_score ?? m.hs, as: st === 'pre' ? null : x.es.away_score ?? m.as,
        min: st === 'live' ? srMin(x.es) : null, ht: p1 ? `${p1.home_score}:${p1.away_score}` : m.ht, goals: x.goals };
      if (st === 'ft' || st === 'off') changed.add(i);
    }
  }
  // Schlussresultate samt Torschützen (und Verschiebungen) in den Spielplan übernehmen
  for (const i of changed) await cacheSet(`sr:${list[i].key}`, res[i]);
  return res;
}
// Test von bigballsdata.com: Rohform der wichtigsten Antworten, gekürzt (≈7 Abfragen); dazu eine Sportradar-Aufstellung (1 Abfrage)
let bbProbe = null;
async function bbProbeRun(now) {
  const key = Deno.env.get('BIGBALLS_KEY') || '';
  if (!key) return { error: 'Secret BIGBALLS_KEY fehlt' };
  if (bbProbe && now - bbProbe.at < 30 * 60 * 1000) return bbProbe.data;
  const get = async (path) => {
    const res = await fetch(`https://api.bigballsdata.com/v1/${path}`, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
    return { status: res.status, body };
  };
  const cut = (r, n = 3) => ({ status: r.status, meta: r.body?.meta, pagination: r.body?.pagination, count: Array.isArray(r.body?.data) ? r.body.data.length : undefined,
    data: Array.isArray(r.body?.data) ? r.body.data.slice(0, n) : r.body?.data ?? r.body });
  const day = (d) => new Date(now - d * 864e5).toISOString().slice(0, 10);
  const out = {};
  const past = await get(`matches?league=epl&date=${day(2)}&limit=20`);
  out.eplPast = cut(past);
  out.eplSeason = cut(await get('matches?league=epl&season=2026&limit=200'), 2);
  out.scores = cut(await get('scores?sport=football&date=today&limit=200'), 4);
  const fin = (past.body?.data || []).find((m) => m.status === 'finished');
  if (fin) {
    out.events = cut(await get(`matches/${fin.id}/events?type=goals`), 6);
    out.stats = cut(await get(`matches/${fin.id}/statistics`), 2);
  }
  const st = await get('standings?league=epl');
  out.standings = { status: st.status, first: st.body?.data?.standings?.[0] && { ...st.body.data.standings[0], rows: st.body.data.standings[0].rows?.slice(0, 3) } };
  out.topScorers = cut(await get('leagues/epl/top-scorers?limit=5'), 5);
  out.leagues = cut(await get('leagues?sport=football'), 80);
  // Sportradar: Aufstellung des letzten beendeten Premier-League-Spiels
  try {
    const sr = (await cacheGet('sr:sr:competition:17'))?.data?.matches || [];
    const last = sr.filter((m) => m.st === 'ft').sort((a, b) => b.utc.localeCompare(a.utc))[0];
    if (last && Deno.env.get('SPORTRADAR_KEY')) {
      const lu = await srGet(`sport_events/${srUrn(last.id)}/lineups`);
      out.srLineups = { match: `${last.h} – ${last.a}`, keys: Object.keys(lu || {}), home: (lu?.lineups?.competitors || lu?.competitors || [])[0] };
    }
  } catch (err) { out.srLineups = { error: String(err?.message || err) }; }
  bbProbe = { data: out, at: now };
  return out;
}
// Test: Saisons der drei Wettbewerbe (prüft Schlüssel und Wettbewerbs-IDs)
let srProbe = null;
async function srProbeRun(now) {
  if (!Deno.env.get('SPORTRADAR_KEY')) return { error: 'Secret SPORTRADAR_KEY fehlt' };
  if (srProbe && now - srProbe.at < 30 * 60 * 1000) return srProbe.data;
  const out = {};
  for (const lg of FB_LEAGUES.filter((l) => l.src === 'sr')) {
    try { const d = await srGet(`competitions/${lg.key}/seasons`); out[lg.id] = (d?.seasons || []).slice(-3); }
    catch (err) { out[lg.id] = { error: String(err?.message || err) }; }
  }
  srProbe = { data: out, at: now };
  return out;
}

// ---------- live-football-api.com (Reserve) ----------
const LF_BASE = 'https://live-football-api.com/api/v1';
const lfDailyMax = () => Number(Deno.env.get('LIVEFOOTBALL_DAILY')) || 150;
const lfAllowed = () => dailyAllowed('lfcount', lfDailyMax());
async function lfGet(path, params = {}) {
  const q = new URLSearchParams({ ...params, api_key: Deno.env.get('LIVEFOOTBALL_KEY') || '' });
  const res = await fetch(`${LF_BASE}/${path}?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  const d = await res.json().catch(() => null);
  if (!res.ok || d?.success === false) throw new Error(String(d?.message || `HTTP ${res.status}`));
  return d?.data ?? d;
}
const lfNum = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
// Anstoss: volles Datum im Spiel, sonst Tagesdatum + „HH:MM“ (Antworten in UTC)
function lfUtc(m, day) {
  for (const v of [m.utc, m.datetime, m.date_time, m.start_time, m.starting_at, m.date]) {
    if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
    if (typeof v === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(v)) return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? v.replace(' ', 'T') : `${v.replace(' ', 'T')}Z`).toISOString();
  }
  const d = (typeof m.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(m.date) ? m.date : day) || '';
  const t = /^\d\d:\d\d$/.test(m.kickoff || '') ? m.kickoff : '00:00';
  return d ? new Date(`${d}T${t}:00Z`).toISOString() : '';
}
export function mapLf(lg, m, day) {
  const s = m.status || {};
  const raw = String(s.status || s || '').toLowerCase(), disp = String(s.display || ''), state = String(s.state || '');
  const live = s.is_live === true || state === 'inPlay' || raw === 'live';
  const st = raw === 'finished' || state === 'postGame' || /^(FT|AET|PEN|MS)$/i.test(disp) ? 'ft'
    : live ? (/^(HT|HZ|Pause|Halftime)/i.test(disp) || raw === 'halftime' ? 'ht' : 'live')
    : /cancel|postpon|abandon|suspend|interrupt/.test(raw) ? 'off' : 'pre';
  const ht = m.halftime && m.halftime.home != null ? `${m.halftime.home}:${m.halftime.away}` : '';
  return { id: `lf-${m.id}`, l: lg.id, utc: lfUtc(m, day), round: String(m.week || m.round || '').replace(/^Regular Season( - )?/i, ''),
    h: String(m.home?.name || ''), a: String(m.away?.name || ''), hl: fbImg(m.home?.logo), al: fbImg(m.away?.logo),
    hs: st === 'pre' ? null : lfNum(m.home?.score), as: st === 'pre' ? null : lfNum(m.away?.score),
    st, min: st === 'live' ? lfNum(String(disp).replace(/\D.*$/, '')) : null, ht, note: st === 'off' ? raw : '' };
}
// Spielplan einer Liga (ganze laufende Saison), alle 6 Std.; Fehler nur 15 Min. merken
async function lfFixtures(lg, now) {
  const ck = `lf:${lg.key}`;
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < (hit.data.status === 'ok' ? 6 * 3600 * 1000 : 15 * 60 * 1000)) return hit.data;
  if (!(await lfAllowed())) return hit?.data || { status: 'error', message: 'Tagesgrenze für live-football-api erreicht', matches: [] };
  try {
    const d = await lfGet('league_fixtures', { league_id: String(lg.lf ?? lg.key) });
    const weeks = Array.isArray(d?.weeks) ? d.weeks : [];
    const matches = weeks.flatMap((w) => (w.matches || []).map((m) => mapLf(lg, { week: w.week ?? w.name, ...m }, w.date))).filter((m) => m.utc);
    const data = { status: matches.length ? 'ok' : 'error', message: matches.length ? '' : 'Kein Spielplan erhalten', matches };
    await cacheSet(ck, data);
    return data;
  } catch (err) {
    const data = { status: 'error', message: String(err?.message || err).slice(0, 160), matches: hit?.data?.matches || [] };
    await cacheSet(ck, data);
    return data;
  }
}
// Tagesliste (alle Ligen weltweit, eine Abfrage) für Live-Stände: während Spielen jede Minute, danach alle 10 Min.
async function lfToday(now, ttl) {
  const day = new Date(now).toISOString().slice(0, 10);
  const ck = `lfday:${day}`;
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < ttl) return hit.data;
  if (!(await lfAllowed())) return hit?.data || null;
  try {
    const d = await lfGet('matches', { date: day });
    const ids = new Set(FB_LEAGUES.filter((lg) => lg.src === 'lf').map((lg) => Number(lg.lf ?? lg.key)));
    const data = { day, matches: (d?.matches || []).filter((m) => ids.has(Number(m.league?.id))) };
    await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || null; }
}
async function lfLeagues(list, now) {
  if (!Deno.env.get('LIVEFOOTBALL_KEY')) return list.map(() => ({ status: 'nokey', message: 'live-football-api-Schlüssel fehlt', matches: [] }));
  const res = await Promise.all(list.map((lg) => lfFixtures(lg, now)));
  // Angepfiffene, im Spielplan noch nicht beendete Spiele (letzte 12 Std.): Stand aus der Tagesliste holen
  const open = (m) => m.st !== 'ft' && m.st !== 'off' && Date.parse(m.utc) < now && now - Date.parse(m.utc) < 12 * 3600e3;
  if (res.some((r) => r.matches.some(open))) {
    const today = await lfToday(now, res.some((r) => liveWindow(r.matches, now)) ? 60 * 1000 : 10 * 60 * 1000);
    const changed = new Set();
    for (const m of today?.matches || []) {
      const i = list.findIndex((lg) => Number(lg.lf ?? lg.key) === Number(m.league?.id));
      if (i < 0) continue;
      const fresh = mapLf(list[i], m, today.day);
      const arr = res[i].matches;
      const j = arr.findIndex((x) => x.id === fresh.id || (x.h === fresh.h && x.a === fresh.a && Math.abs(Date.parse(x.utc) - Date.parse(fresh.utc)) < 36 * 3600e3));
      if (j < 0) continue;
      if (fresh.st === 'ft' && arr[j].st !== 'ft') changed.add(i);
      arr[j] = { ...arr[j], hs: fresh.hs, as: fresh.as, st: fresh.st, min: fresh.min, ht: fresh.ht || arr[j].ht, note: fresh.note };
    }
    // Schlussresultate in den Spielplan übernehmen, damit danach keine Tagesabfragen mehr nötig sind
    for (const i of changed) await cacheSet(`lf:${list[i].key}`, res[i]);
  }
  return res;
}
// Torschützen eines Spiels (/live_match_details); nach Spielende dauerhaft, sonst 2 Min. gespeichert
async function lfGame(id) {
  const ck = `lfev:${id}`;
  const hit = await cacheGet(ck);
  if (hit && (hit.data.final || Date.now() - hit.at < 2 * 60 * 1000)) return hit.data;
  if (!Deno.env.get('LIVEFOOTBALL_KEY') || !(await lfAllowed())) return hit?.data || { goals: [] };
  const d = await lfGet('live_match_details', { match_id: id });
  const prev = [0, 0];
  const goals = (d?.events || []).filter((e) => e.type === 'goal' || e.type === 'own_goal').map((e) => {
    const sc = /^(\d+)\s*[-:]\s*(\d+)$/.exec(String(e.detail?.score || ''));
    let side = e.side === 'away' ? 2 : 1;
    if (sc) { side = Number(sc[1]) > prev[0] ? 1 : 2; prev[0] = Number(sc[1]); prev[1] = Number(sc[2]); }
    else if (e.type === 'own_goal') side = side === 1 ? 2 : 1;
    const n = String(e.detail?.player?.name || '');
    return { m: String(e.time ?? ''), s: side, n: `${n}${e.detail?.is_penalty ? ' (Pen.)' : e.type === 'own_goal' ? ' (Eigentor)' : ''}` };
  });
  const hs = d?.header?.status || {};
  const data = { goals, final: hs.state === 'postGame' || String(hs.status || '').toLowerCase() === 'finished' };
  await cacheSet(ck, data);
  return data;
}
// OpenLigaDB (Bundesligen): ganze Saison mit Torschützen
export function mapOldb(lg, m, now) {
  const rs = {}; for (const r of m.matchResults || []) rs[r.resultTypeID] = r;
  const utc = new Date(m.matchDateTimeUTC || m.matchDateTime).toISOString();
  const goals = [];
  let prev = [0, 0];
  for (const g of [...(m.goals || [])].sort((x, y) => (x.matchMinute || 0) - (y.matchMinute || 0))) {
    const side = g.scoreTeam1 > prev[0] ? 1 : 2; prev = [g.scoreTeam1, g.scoreTeam2];
    goals.push({ m: g.matchMinute ?? '', s: side, n: `${String(g.goalGetterName || '').trim()}${g.isPenalty ? ' (Pen.)' : g.isOwnGoal ? ' (Eigentor)' : ''}` });
  }
  const kick = Date.parse(utc), running = !m.matchIsFinished && now >= kick && now - kick < 130 * 60 * 1000;
  const fin = m.matchIsFinished && rs[2];
  const last = goals.at(-1);
  const img = fbImg;
  return { id: `${lg.id}-${m.matchID}`, l: lg.id, utc, round: String(m.group?.groupName || '').replace(/^(\d+)\.\s*/, '$1. '), h: oldbName(m.team1), a: oldbName(m.team2),
    hl: img(m.team1?.teamIconUrl) || OLDB_LOGO[oldbName(m.team1)] || '', al: img(m.team2?.teamIconUrl) || OLDB_LOGO[oldbName(m.team2)] || '',
    hs: fin ? rs[2].pointsTeam1 : running ? (last ? prev[0] : 0) : null, as: fin ? rs[2].pointsTeam2 : running ? (last ? prev[1] : 0) : null,
    // OpenLigaDB kennt keine Spielminute: während des Spiels nur „Live“
    st: fin || m.matchIsFinished ? 'ft' : running ? 'live' : 'pre', min: null, ht: rs[1] ? `${rs[1].pointsTeam1}:${rs[1].pointsTeam2}` : '', goals };
}
async function oldbLeague(lg, season, now) {
  const ck = `oldb:${lg.key}:${season}`;
  const hit = fbMem.get(ck);
  if (hit && now - hit.at < (liveWindow(hit.data.matches, now) ? 60 * 1000 : 15 * 60 * 1000)) return hit.data;
  try {
    const raw = await getJson(`https://api.openligadb.de/getmatchdata/${lg.key}/${season}`);
    const data = { status: 'ok', message: '', matches: (Array.isArray(raw) ? raw : []).map((m) => mapOldb(lg, m, now)) };
    fbMem.set(ck, { data, at: now });
    return data;
  } catch {
    return hit?.data || { status: 'error', message: 'OpenLigaDB nicht erreichbar', matches: [] };
  }
}
async function fbOverview(now) {
  const season = fbSeason(new Date(now));
  const fail = () => ({ status: 'error', message: 'Fehler', matches: [] });
  const lfList = FB_LEAGUES.filter((lg) => lg.src === 'lf'), srList = FB_LEAGUES.filter((lg) => lg.src === 'sr'), bbList = FB_LEAGUES.filter((lg) => lg.src === 'bb');
  const [other, lfRes, srRes, bbRes] = await Promise.all([
    Promise.all(FB_LEAGUES.map((lg) => (lg.src === 'af' ? afLeague(lg, season, now) : lg.src === 'oldb' ? oldbLeague(lg, season, now) : null)).map((p) => p && p.catch(fail))),
    lfList.length ? lfLeagues(lfList, now).catch(() => lfList.map(fail)) : [],
    srList.length ? srLeagues(srList, now).catch(() => srList.map(fail)) : [],
    bbList.length ? bbLeagues(bbList, now).catch(() => bbList.map(fail)) : [],
  ]);
  const res = FB_LEAGUES.map((lg, i) => (lg.src === 'lf' ? lfRes[lfList.indexOf(lg)] : lg.src === 'sr' ? srRes[srList.indexOf(lg)] : lg.src === 'bb' ? bbRes[bbList.indexOf(lg)] : other[i]));
  const from = now - 14 * 864e5, to = now + 15 * 864e5;
  // Ein Wappen pro Klub über alle Ligen (z. B. Liverpool in Premier League und Champions League):
  // zuerst Sportradar-Ligen (Wikipedia, scharf), dann Bundesligen, zuletzt Champions League
  // Gespeicherte Sportradar-Spielpläne von früher: Namen kürzen und Wappen nachtragen
  FB_LEAGUES.forEach((lg, i) => { if (lg.src === 'sr') for (const m of res[i].matches || []) { m.hl = m.hl || srLogo(m.h); m.al = m.al || srLogo(m.a); m.h = srName(m.h); m.a = srName(m.a); } });
  const crest = new Map();
  const rank = (lg) => (lg.src === 'sr' ? 0 : lg.id === 'ucl' ? 2 : 1);
  [...FB_LEAGUES.keys()].sort((a, b) => rank(FB_LEAGUES[a]) - rank(FB_LEAGUES[b])).forEach((i) => {
    for (const m of res[i].matches || []) {
      if (m.hl && !crest.has(m.h)) crest.set(m.h, m.hl);
      if (m.al && !crest.has(m.a)) crest.set(m.a, m.al);
    }
  });
  for (const r of res) for (const m of r.matches || []) { m.hl = crest.get(m.h) || m.hl; m.al = crest.get(m.a) || m.al; }
  return { updated: new Date(now).toISOString(), season,
    leagues: FB_LEAGUES.map((lg, i) => ({ id: lg.id, name: lg.name, country: lg.country, short: lg.short, color: lg.color, status: res[i].status, message: res[i].message })),
    matches: res.flatMap((r) => r.matches.filter((m) => { const t = Date.parse(m.utc); return t >= from && t <= to; })) };
}
async function fbGame(id) {
  if (/^bb-[\w-]+$/.test(String(id))) return bbGame(id);
  if (/^sr-\d+$/.test(String(id))) { const t = await srTimeline(String(id)); return { goals: t?.goals || [], final: !!t?.final }; }
  if (/^lf-[\w-]+$/.test(String(id))) return lfGame(String(id).slice(3));
  const fx = Number(String(id).replace(/^af-/, ''));
  if (!Number.isInteger(fx) || fx <= 0) throw new Error('ungültig');
  const ck = `afev:${fx}`;
  const hit = await cacheGet(ck);
  if (hit && (hit.data.final || Date.now() - hit.at < 10 * 60 * 1000)) return hit.data;
  if (!Deno.env.get('APIFOOTBALL_KEY') || !(await afAllowed())) return hit?.data || { goals: [] };
  const [ev, fixt] = await Promise.all([afGet(`fixtures/events?fixture=${fx}`), afGet(`fixtures?id=${fx}`)]);
  const f = fixt.response?.[0];
  const homeId = f?.teams?.home?.id;
  const goals = (ev.response || []).filter((e) => e.type === 'Goal' && e.detail !== 'Missed Penalty').map((e) => ({
    m: `${e.time?.elapsed ?? ''}${e.time?.extra ? `+${e.time.extra}` : ''}`,
    s: (e.team?.id === homeId) !== (e.detail === 'Own Goal') ? 1 : 2,
    n: `${String(e.player?.name || '')}${e.detail === 'Penalty' ? ' (Pen.)' : e.detail === 'Own Goal' ? ' (Eigentor)' : ''}` }));
  const data = { goals, final: AF_DONE.has(f?.fixture?.status?.short || '') };
  await cacheSet(ck, data);
  return data;
}

// Test von live-football-api.com: Rohform von Spielplan und Spieldetails (2 Abfragen)
let lfProbe = null;
async function lfProbeRun(now) {
  const key = Deno.env.get('LIVEFOOTBALL_KEY') || '';
  if (!key) return { error: 'Secret LIVEFOOTBALL_KEY fehlt' };
  if (lfProbe && now - lfProbe.at < 30 * 60 * 1000) return lfProbe.data;
  const get = async (path) => {
    const res = await fetch(`https://live-football-api.com/api/v1/${path}${path.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
    const text = await res.text();
    try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text.slice(0, 500) }; }
  };
  // Rohform des Spielplans (Super League) und der Spieldetails eines beendeten Spiels, gekürzt
  const fx = await get('league_fixtures?league_id=8571');
  const weeks = fx.body?.data?.weeks || [];
  const done = weeks.flatMap((w) => w.matches || []).filter((m) => String(m.status?.status || m.status || '').toLowerCase() === 'finished' || /FT/.test(String(m.status?.display || m.status || '')));
  const det = done.length ? await get(`live_match_details?match_id=${encodeURIComponent(done.at(-1).id)}`) : null;
  const data = { fixturesStatus: fx.status, top: fx.body?.data ? Object.keys(fx.body.data) : fx.body, weeksCount: weeks.length,
    weekKeys: weeks[0] ? Object.keys(weeks[0]) : null, firstWeek: weeks[0] ? { ...weeks[0], matches: (weeks[0].matches || []).slice(0, 2) } : null,
    details: det && { status: det.status, keys: det.body?.data ? Object.keys(det.body.data) : null, header: det.body?.data?.header, events: (det.body?.data?.events || []).slice(0, 6) } };
  lfProbe = { data, at: now };
  return data;
}

// ---------- Push-Mitteilungen bei Toren der Lieblingsteams (Web Push, ohne Inhalt: das Gerät holt die Meldung danach ab) ----------
// Tabelle el_fb_push (endpoint, profile_key, created_at); Secrets VAPID_PUBLIC, VAPID_PRIVATE (base64url), VAPID_SUBJECT (mailto:…).
// Ein Zeitplan (pg_cron) ruft jede Minute ?fbpushtick=1 auf: Spielstände mit dem letzten Stand vergleichen, bei einem Tor
// die Geräte der Profile mit diesem Lieblingsteam anstossen. Die Meldungen liegen 30 Min. unter pushmsg:<Hash des Endpunkts>.
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sameString(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
let vapidKey = null;
async function vapidJwt(aud) {
  const pub = unb64u(Deno.env.get('VAPID_PUBLIC') || ''), d = Deno.env.get('VAPID_PRIVATE') || '';
  vapidKey ||= await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: Deno.env.get('VAPID_SUBJECT') || 'mailto:codeloru@gmail.com' })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64u(sig)}`;
}
// Leere Push-Nachricht an ein Gerät; 404/410 = Anmeldung ungültig (wird gelöscht)
async function pushPing(endpoint) {
  const aud = new URL(endpoint).origin;
  const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: `vapid t=${await vapidJwt(aud)}, k=${Deno.env.get('VAPID_PUBLIC')}`, TTL: '1800', Urgency: 'high', 'Content-Length': '0' },
    signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res.status;
}
const PUSH_URL = `${SUPABASE_URL}/rest/v1/el_fb_push`, PROFILES_URL = `${SUPABASE_URL}/rest/v1/el_profiles`;
async function pushProfile(name, pin) {
  const key = String(name || '').trim().slice(0, 40).toLowerCase();
  if (!key || !/^\d{4,8}$/.test(String(pin || ''))) return null;
  const r = await fetch(`${PROFILES_URL}?key=eq.${encodeURIComponent(key)}&select=key,pin_hash`, { headers: serviceHeaders() });
  const row = r.ok ? (await r.json())[0] : null;
  return row && sameString(await sha256Hex(`${pin}:${key}`), row.pin_hash) ? key : null;
}
async function handlePush(body) {
  const endpoint = String(body?.endpoint || '');
  if (body.kind !== 'push-test' && (!/^https:\/\/[\w.-]+\//.test(endpoint) || endpoint.length > 1000)) return { ok: false, error: 'ungültig' };
  if (body.kind === 'push-test') {
    // Testmeldung an alle Geräte des Profils (Name + PIN nötig)
    const key = await pushProfile(body.name, body.pin);
    if (!key) return { ok: false, error: 'profil' };
    const subs = await fetch(`${PUSH_URL}?profile_key=eq.${encodeURIComponent(key)}&select=endpoint`, { headers: serviceHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const now = Date.now(), res = [];
    for (const s of subs) {
      const hash = await sha256Hex(s.endpoint);
      const old = (await cacheGet(`pushmsg:${hash}`))?.data || [];
      await cacheSet(`pushmsg:${hash}`, [...old.filter((x) => now - x.at < 30 * 60 * 1000), { id: '', tag: `test-${now}`, at: now, title: '⚽ Testmeldung', body: 'So sieht eine Tor-Mitteilung aus: FC Basel 1:0 FC Lugano · 18\'' }].slice(-10));
      res.push(await pushPing(s.endpoint).catch((e) => String(e?.message || e)));
    }
    return { ok: subs.length > 0, devices: subs.length, status: res, error: subs.length ? '' : 'keine Geräte' };
  }
  if (body.kind === 'push-unsub') {
    await fetch(`${PUSH_URL}?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE', headers: serviceHeaders() });
    return { ok: true };
  }
  const key = await pushProfile(body.name, body.pin);
  if (!key) return { ok: false, error: 'profil' };
  const r = await fetch(`${PUSH_URL}?on_conflict=endpoint`, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ endpoint, profile_key: key, created_at: new Date().toISOString() }) });
  return { ok: r.ok, error: r.ok ? '' : `db ${r.status}` };
}
// Jede Minute: Tore seit dem letzten Lauf finden und die passenden Geräte anstossen
async function pushTick(now) {
  if (!Deno.env.get('VAPID_PRIVATE')) return { error: 'VAPID-Secrets fehlen' };
  const ov = await fbOverview(now);
  const prev = (await cacheGet('push:scores'))?.data || {};
  const cur = {}, events = [];
  for (const m of ov.matches) {
    if (m.hs == null || m.as == null || !['live', 'ht', 'ft'].includes(m.st)) continue;
    cur[m.id] = [m.hs, m.as];
    const p = prev[m.id];
    // Nur echte Änderungen (erster Stand nach dem Anpfiff = Ausgangslage, ausser es steht schon ein Tor und das Spiel ist frisch)
    if (!p) { if (m.hs + m.as > 0 && m.st !== 'ft' && now - Date.parse(m.utc) < 10 * 60 * 1000) events.push({ m, side: m.hs > 0 ? 1 : 2 }); continue; }
    if (m.hs > p[0]) events.push({ m, side: 1 });
    if (m.as > p[1]) events.push({ m, side: 2 });
  }
  // Beendete Spiele nach einem Tag aus dem Vergleich nehmen
  for (const [id, v] of Object.entries(prev)) if (!cur[id] && ov.matches.some((m) => m.id === id && now - Date.parse(m.utc) < 864e5)) cur[id] = v;
  await cacheSet('push:scores', cur);
  if (!events.length) return { events: 0 };
  const subs = await fetch(`${PUSH_URL}?select=endpoint,profile_key`, { headers: serviceHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  if (!subs.length) return { events: events.length, sent: 0 };
  const keys = [...new Set(subs.map((x) => x.profile_key))];
  const profs = await fetch(`${PROFILES_URL}?key=in.(${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})&select=key,fb_favorites`, { headers: serviceHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const fav = new Map(profs.map((p) => [p.key, new Set((Array.isArray(p.fb_favorites) ? p.fb_favorites : []).map((n) => String(n).toLowerCase()))]));
  let sent = 0;
  for (const s of subs) {
    const f = fav.get(s.profile_key);
    const mine = events.filter((e) => f && (f.has(e.m.h.toLowerCase()) || f.has(e.m.a.toLowerCase())));
    if (!mine.length) continue;
    const hash = await sha256Hex(s.endpoint);
    const old = (await cacheGet(`pushmsg:${hash}`))?.data || [];
    const msgs = mine.map(({ m, side }) => {
      const team = side === 1 ? m.h : m.a, last = (m.goals || []).filter((g) => g.s === side).at(-1);
      return { id: m.id, tag: `${m.id}-${m.hs}-${m.as}`, at: now, title: `⚽ Tor für ${team}`,
        body: `${m.h} ${m.hs}:${m.as} ${m.a}${last?.n ? ` · ${last.n}${last.m ? ` (${last.m}')` : ''}` : m.min ? ` · ${m.min}'` : ''}` };
    });
    await cacheSet(`pushmsg:${hash}`, [...old.filter((x) => now - x.at < 30 * 60 * 1000), ...msgs].slice(-10));
    const st = await pushPing(s.endpoint).catch(() => 0);
    if (st === 404 || st === 410) await fetch(`${PUSH_URL}?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
    else if (st >= 200 && st < 300) sent++;
  }
  return { events: events.length, sent };
}
// Das Gerät holt nach dem Anstoss seine Meldungen ab (nur die der letzten 30 Min.)
async function pushMessages(endpoint, now) {
  const hash = await sha256Hex(String(endpoint || ''));
  return ((await cacheGet(`pushmsg:${hash}`))?.data || []).filter((x) => now - x.at < 30 * 60 * 1000);
}

async function handle(req) {
  const cors = corsFor(req);
  const headers = { ...cors, 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method === 'POST') {
    let body = null;
    try { body = await req.json(); } catch { /* leer */ }
    if (!body || !['push-sub', 'push-unsub', 'push-test'].includes(body.kind)) return new Response(JSON.stringify({ ok: false }), { status: 400, headers });
    try { return new Response(JSON.stringify(await handlePush(body)), { headers }); }
    catch { return new Response(JSON.stringify({ ok: false, error: 'serverfehler' }), { status: 502, headers }); }
  }
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'nur GET oder POST' }), { status: 405, headers });
  const params = new URL(req.url).searchParams;
  if (params.has('fbpushtick')) {
    try { return new Response(JSON.stringify(await pushTick(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('fbpushmsg')) {
    try { return new Response(JSON.stringify(await pushMessages(params.get('fbpushmsg'), Date.now())), { headers }); }
    catch { return new Response('[]', { headers }); }
  }
  if (params.has('fbleague')) {
    try { return new Response(JSON.stringify(await fbLeague(String(params.get('fbleague')), params.get('kind') === 'scorers' ? 'scorers' : 'table')), { headers }); }
    catch { return new Response(JSON.stringify({ available: false, error: 'nicht erreichbar' }), { status: 502, headers }); }
  }
  if (params.has('fbdetail')) {
    try { return new Response(JSON.stringify(await fbDetail(String(params.get('fbdetail')), params.get('kind') === 'stats' ? 'stats' : 'lineup')), { headers }); }
    catch { return new Response(JSON.stringify({ available: false, error: 'nicht erreichbar' }), { status: 502, headers }); }
  }
  if (params.has('bbtest')) {
    try { return new Response(JSON.stringify(await bbTestRun(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('bbusage')) {
    try { return new Response(JSON.stringify(await bbUsageRun(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('fbplayer')) {
    try { return new Response(JSON.stringify(await fbPlayer(String(params.get('fbplayer')))), { headers }); }
    catch { return new Response(JSON.stringify({ available: false, error: 'nicht erreichbar' }), { status: 502, headers }); }
  }
  if (params.has('bbprobe')) {
    try { return new Response(JSON.stringify(await bbProbeRun(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('srprobe')) {
    try { return new Response(JSON.stringify(await srProbeRun(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('lfprobe')) {
    try { return new Response(JSON.stringify(await lfProbeRun(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('fbgame')) {
    try {
      return new Response(JSON.stringify(await fbGame(params.get('fbgame'))), { headers });
    } catch {
      return new Response(JSON.stringify({ goals: [], error: 'nicht erreichbar' }), { status: 502, headers });
    }
  }
  try {
    return new Response(JSON.stringify(await fbOverview(Date.now())), { headers: { ...headers, 'Cache-Control': 'public, max-age=30' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Die Fussball-Daten sind gerade nicht erreichbar.' }), { status: 502, headers });
  }
}

// Nur auf dem Server starten
if (typeof Deno !== 'undefined') Deno.serve(handle);
