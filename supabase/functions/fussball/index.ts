// Supabase Edge Function „fussball“: Datenquelle des Fussball-Bereichs der Seite (fussball/index.html, fussball.js).
// Getrennt von der Funktion „euroleague“; gleiche Herkunftsprüfung (antwortet nur der eigenen Seite).
//
//   GET ?fb=1 → Spielübersicht: Spiele ±2 Wochen um heute aus allen Ligen
//   → { updated, season, leagues: [{ id, name, country, short, color, status: 'ok'|'nokey'|'error', message }],
//       matches: [{ id, l, utc, round, h, a, hl, al, hs, as, st: 'pre'|'live'|'ht'|'ft'|'off', min, ht, goals? }] }
//     Champions League, Bundesliga/2. Bundesliga: OpenLigaDB (frei, mit Torschützen). Premier League, Super League, Challenge League:
//     live-football-api.com (Secret LIVEFOOTBALL_KEY, 1 Credit pro Abfrage; Tagesgrenze Secret LIVEFOOTBALL_DAILY, sonst 150):
//     Spielplan pro Liga alle 6 Std. (/league_fixtures), während Spielen jede Minute die Tagesliste (/matches, eine Abfrage für alle
//     Ligen), alles in der Tabelle el_fb_cache. API-Football (Secret APIFOOTBALL_KEY) bleibt als Ersatz im Code (src: 'af').
//   GET ?lfprobe=1 → Test von live-football-api.com (Secret LIVEFOOTBALL_KEY): Rohform von Spielplan/Spieldetails, höchstens alle 30 Min. neu
//   GET ?fbgame=lf-123 | af-123456 → Torschützen eines live-football-api- bzw. API-Football-Spiels → { goals: [{ m, s, n }] } (nach Spielende dauerhaft gespeichert)
//
// Secrets (Supabase → Edge Functions → Secrets, gelten für alle Funktionen des Projekts): LIVEFOOTBALL_KEY, LIVEFOOTBALL_DAILY, APIFOOTBALL_KEY;
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
  { id: 'ucl', name: 'Champions League', country: 'Europa', short: 'UCL', color: '#0E1E5B', src: 'oldb', key: 'ucl' },
  { id: 'pl', name: 'Premier League', country: 'England', short: 'PL', color: '#3D195B', src: 'lf', key: 1008 },
  { id: 'bl1', name: 'Bundesliga', country: 'Deutschland', short: 'BL', color: '#D20515', src: 'oldb', key: 'bl1' },
  { id: 'bl2', name: '2. Bundesliga', country: 'Deutschland', short: '2B', color: '#5B6170', src: 'oldb', key: 'bl2' },
  { id: 'chsl', name: 'Super League', country: 'Schweiz', short: 'SL', color: '#E30613', src: 'lf', key: 8571 },
  { id: 'chcl', name: 'Challenge League', country: 'Schweiz', short: 'CL', color: '#1F6FB2', src: 'lf', key: 8565 },
];
const FB_IMG = /^https:\/\/(upload\.wikimedia\.org|i\.imgur\.com|assets\.dfb\.de|media\.api-sports\.io|(www\.)?live-football-api\.com|img\.uefa\.com|derivates\.kicker\.de|s\.hs-data\.com)\//;
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
// ---------- live-football-api.com (Premier League, Schweizer Ligen) ----------
const LF_BASE = 'https://live-football-api.com/api/v1';
const lfDailyMax = () => Number(Deno.env.get('LIVEFOOTBALL_DAILY')) || 150;
async function lfAllowed() {
  const k = `lfcount:${new Date().toISOString().slice(0, 10)}`;
  const n = Number((await cacheGet(k))?.data) || 0;
  if (n >= lfDailyMax()) return false;
  await cacheSet(k, n + 1);
  return true;
}
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
    const d = await lfGet('league_fixtures', { league_id: String(lg.key) });
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
    const ids = new Set(FB_LEAGUES.filter((lg) => lg.src === 'lf').map((lg) => Number(lg.key)));
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
      const i = list.findIndex((lg) => Number(lg.key) === Number(m.league?.id));
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
  const lfList = FB_LEAGUES.filter((lg) => lg.src === 'lf');
  const [other, lfRes] = await Promise.all([
    Promise.all(FB_LEAGUES.map((lg) => (lg.src === 'af' ? afLeague(lg, season, now) : lg.src === 'oldb' ? oldbLeague(lg, season, now) : null)).map((p) => p && p.catch(fail))),
    lfLeagues(lfList, now).catch(() => lfList.map(fail)),
  ]);
  const res = FB_LEAGUES.map((lg, i) => (lg.src === 'lf' ? lfRes[lfList.indexOf(lg)] : other[i]));
  const from = now - 14 * 864e5, to = now + 15 * 864e5;
  return { updated: new Date(now).toISOString(), season,
    leagues: FB_LEAGUES.map((lg, i) => ({ id: lg.id, name: lg.name, country: lg.country, short: lg.short, color: lg.color, status: res[i].status, message: res[i].message })),
    matches: res.flatMap((r) => r.matches.filter((m) => { const t = Date.parse(m.utc); return t >= from && t <= to; })) };
}
async function fbGame(id) {
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

async function handle(req) {
  const cors = corsFor(req);
  const headers = { ...cors, 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'nur GET' }), { status: 405, headers });
  const params = new URL(req.url).searchParams;
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
