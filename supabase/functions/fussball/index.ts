// Supabase Edge Function „fussball“: Datenquelle des Fussball-Bereichs der Seite (fussball/index.html, fussball.js).
// Getrennt von der Funktion „euroleague“; gleiche Herkunftsprüfung (antwortet nur der eigenen Seite).
//
//   GET ?fb=1 → Spielübersicht: Spiele ±2 Wochen um heute aus allen Ligen
//   → { updated, season, leagues: [{ id, name, country, short, color, status: 'ok'|'nokey'|'error', message }],
//       matches: [{ id, l, utc, round, h, a, hl, al, hs, as, st: 'pre'|'live'|'ht'|'ft'|'off', min, ht, goals? }] }
//     Bundesliga/2. Bundesliga: OpenLigaDB (frei, mit Torschützen). Premier League, Super League, Challenge League:
//     API-Football (Secret APIFOOTBALL_KEY; Gratis-Plan 100 Abfragen/Tag) – eine Abfrage pro Liga und ganze Saison,
//     zwischengespeichert in der Tabelle el_fb_cache (alle 15 Min. während Spielen, sonst alle 6 Std.).
//   GET ?fbgame=af-123456 → Torschützen eines API-Football-Spiels → { goals: [{ m, s, n }] } (nach Spielende dauerhaft gespeichert)
//
// Secrets (Supabase → Edge Functions → Secrets, gelten für alle Funktionen des Projekts): APIFOOTBALL_KEY;
// SUPABASE_SERVICE_ROLE_KEY stellt Supabase selbst bereit (für die Tabelle el_fb_cache).

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

const FB_LEAGUES = [
  { id: 'pl', name: 'Premier League', country: 'England', short: 'PL', color: '#3D195B', src: 'af', key: 39 },
  { id: 'bl1', name: 'Bundesliga', country: 'Deutschland', short: 'BL', color: '#D20515', src: 'oldb', key: 'bl1' },
  { id: 'bl2', name: '2. Bundesliga', country: 'Deutschland', short: '2B', color: '#5B6170', src: 'oldb', key: 'bl2' },
  { id: 'chsl', name: 'Super League', country: 'Schweiz', short: 'SL', color: '#E30613', src: 'af', key: 207 },
  { id: 'chcl', name: 'Challenge League', country: 'Schweiz', short: 'CL', color: '#1F6FB2', src: 'af', key: 208 },
];
const FB_IMG = /^https:\/\/(upload\.wikimedia\.org|i\.imgur\.com|assets\.dfb\.de|media\.api-sports\.io)\//;
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
// Zähler gegen das Tageslimit von API-Football
async function afAllowed() {
  const k = `afcount:${new Date().toISOString().slice(0, 10)}`;
  const n = Number((await cacheGet(k))?.data) || 0;
  if (n >= AF_DAILY_MAX) return false;
  await cacheSet(k, n + 1);
  return true;
}
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
  const img = (u) => (FB_IMG.test(u || '') ? u : '');
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
  const ttl = hit && liveWindow(hit.data.matches || [], now) ? 15 * 60 * 1000 : 6 * 3600 * 1000;
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
// OpenLigaDB (Bundesligen): ganze Saison mit Torschützen
export function mapOldb(lg, m, now) {
  const rs = {}; for (const r of m.matchResults || []) rs[r.resultTypeID] = r;
  const utc = new Date(m.matchDateTimeUTC || m.matchDateTime).toISOString();
  const goals = [];
  let prev = [0, 0];
  for (const g of [...(m.goals || [])].sort((x, y) => (x.matchMinute || 0) - (y.matchMinute || 0))) {
    const side = g.scoreTeam1 > prev[0] ? 1 : 2; prev = [g.scoreTeam1, g.scoreTeam2];
    goals.push({ m: g.matchMinute ?? '', s: side, n: String(g.goalGetterName || '').trim() });
  }
  const kick = Date.parse(utc), running = !m.matchIsFinished && now >= kick && now - kick < 130 * 60 * 1000;
  const fin = m.matchIsFinished && rs[2];
  const last = goals.at(-1);
  const img = (u) => (FB_IMG.test(u || '') ? u : '');
  return { id: `${lg.id}-${m.matchID}`, l: lg.id, utc, round: String(m.group?.groupName || ''), h: String(m.team1?.shortName || ''), a: String(m.team2?.shortName || ''),
    hl: img(m.team1?.teamIconUrl), al: img(m.team2?.teamIconUrl),
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
  const res = await Promise.all(FB_LEAGUES.map((lg) => (lg.src === 'af' ? afLeague(lg, season, now) : oldbLeague(lg, season, now)).catch(() => ({ status: 'error', message: 'Fehler', matches: [] }))));
  const from = now - 14 * 864e5, to = now + 15 * 864e5;
  return { updated: new Date(now).toISOString(), season,
    leagues: FB_LEAGUES.map((lg, i) => ({ id: lg.id, name: lg.name, country: lg.country, short: lg.short, color: lg.color, status: res[i].status, message: res[i].message })),
    matches: res.flatMap((r) => r.matches.filter((m) => { const t = Date.parse(m.utc); return t >= from && t <= to; })) };
}
async function fbGame(id) {
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

async function handle(req) {
  const cors = corsFor(req);
  const headers = { ...cors, 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'nur GET' }), { status: 405, headers });
  const params = new URL(req.url).searchParams;
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
