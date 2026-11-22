// Supabase Edge Function „fussball“: Datenquelle des Fussball-Bereichs der Seite (fussball/index.html, fussball.js).
// Getrennt von der Funktion „euroleague“; gleiche Herkunftsprüfung (antwortet nur der eigenen Seite).
//
//   GET ?fb=1 → Spielübersicht: Spiele ±2 Wochen um heute aus allen Ligen
//   → { updated, season, leagues: [{ id, name, country, short, color, status: 'ok'|'nokey'|'error', message }],
//       matches: [{ id, l, utc, round, h, a, hl, al, hs, as, st: 'pre'|'live'|'ht'|'ft'|'off', min, ht, goals? }] }
//     Premier League live zuerst über Fantasy Premier League (fantasy.premierleague.com/api, gratis, inoffiziell), sonst wie unten.
//     Champions League, Premier League, Bundesliga, La Liga, Serie A, Ligue 1, Nations League, Länderspiele: bigballsdata.com
//     (Secret BIGBALLS_KEY, Tagesgrenze Secret BIGBALLS_DAILY, sonst 230): Saison-Spielplan pro Wettbewerb täglich, Live-Stände
//     aus einer Tagesabfrage für alle Ligen (während Spielen alle 5 Min.), Tore pro Spiel beim Aufklappen. 2. Bundesliga: OpenLigaDB.
//     Super League, Challenge League:
//     Sportradar Soccer v4 (Secrets SPORTRADAR_KEY, SPORTRADAR_LEVEL = trial|production, SPORTRADAR_DAILY = Tagesgrenze, sonst 60):
//     Saison-Spielplan pro Liga täglich, während Spielen alle 7 Min. die Live-Timelines (eine Abfrage, mit Torschützen),
//     nach Spielende einmal die Timeline des Spiels; alles in el_fb_cache. Wappen aus Wikipedia (SR_LOGO, EN_CREST; Neuaufsteiger dort ergänzen).
//   GET ?fbleague=ucl|pl|efl|bl1|laliga|seriea|ligue1&kind=table|scorers → Tabelle bzw. Torschützenliste; nach letztem Spiel am Tag vorgewärmt, sonst Cache bis zu 24 Std.
//   GET ?fbdetail=bb-<uuid>&kind=lineup|stats → Aufstellung (Startelf, Ersatzbank mit Rückennummern benchNo, Trainer) bzw. Teamstatistik eines Spiels;
//     Aufstellung PL/CL von Sportradar (solange verfügbar), sonst Big Balls; Statistik nach Spielende von Big Balls, Sportradar (PL/CL/Championship) während des Spiels und als Ersatz
//   GET ?fbplayer=bb:<uuid> → Spielerprofil aus Big Balls (Steckbrief, Transfers, Saisonwerte) + Wikipedia
//   GET ?fbplayer=<Sportradar-Spieler-Nr.> → Spielerprofil: Steckbrief und Saisonwerte (Sportradar, 7 Tage gespeichert), letzte Spiele (6 Std.),
//     Karriere und Foto aus Wikipedia/Wikidata
//   POST { kind: 'push-sub'|'push-unsub', endpoint, name, pin } → Gerät für Tor-Mitteilungen an-/abmelden (Tabelle el_fb_push)
//   GET ?usage=1 → Verbrauch der letzten 7 Tage pro Quelle, Datenelement und Liga (gezählt in el_fb_cache «use:<Tag>»)
//   GET ?fbpushtick=1 → (Zeitplan, jede Minute) Tore der Lieblingsteams erkennen und Push senden; ?fbpushmsg=<endpoint> → Meldungen fürs Gerät
//   GET ?bbusage=1 → Big-Balls-Konto: Plan, Tageslimit, GitHub verknüpft, heute verbraucht (/v1/user/me, /v1/usage), höchstens alle 10 Min.
//   GET ?fbgame=bb-<uuid> | sr-123 → Torschützen eines Spiels → { goals: [{ m, s, n }], final } (nach Spielende dauerhaft gespeichert)
//
// Secrets (Supabase → Edge Functions → Secrets, gelten für alle Funktionen des Projekts): BIGBALLS_KEY, SPORTRADAR_KEY, SPORTRADAR_LEVEL, SPORTRADAR_DAILY, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT;
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
  { id: 'pl', name: 'Premier League', country: 'England', short: 'PL', color: '#3D195B', src: 'bb', key: 'epl', sr: 'sr:competition:17' },
  // Championship (2. Liga England): Big Balls führt sie nicht, darum Sportradar wie die Schweizer Ligen (Spielplan, Live, Tabelle)
  { id: 'efl', name: 'Championship', country: 'England', short: 'EFL', color: '#1C2D5A', src: 'sr', key: 'sr:competition:18' },
  { id: 'bl1', name: 'Bundesliga', country: 'Deutschland', short: 'BL', color: '#D20515', src: 'bb', key: 'bundesliga', oldb: 'bl1' },
  { id: 'laliga', name: 'La Liga', country: 'Spanien', short: 'LL', color: '#E2342B', src: 'bb', key: 'laliga' },
  { id: 'seriea', name: 'Serie A', country: 'Italien', short: 'SA', color: '#0A5DB8', src: 'bb', key: 'seriea' },
  { id: 'ligue1', name: 'Ligue 1', country: 'Frankreich', short: 'L1', color: '#1B2A4A', src: 'bb', key: 'ligue1' },
  { id: 'bl2', name: '2. Bundesliga', country: 'Deutschland', short: '2B', color: '#5B6170', src: 'oldb', key: 'bl2' },
  // Schweizer Ligen: GOAL API (goal-api.com, Secret GOAL_KEY, gratis 1000/Tag); sr = alte Sportradar-Kennung (Namen/Wappen aus dem alten Stand)
  { id: 'chsl', name: 'Super League', country: 'Schweiz', short: 'SL', color: '#E30613', src: 'goal', key: 'cmr77dvyx00egrx06pta3wmnc', sr: 'sr:competition:215' },
  { id: 'chcl', name: 'Challenge League', country: 'Schweiz', short: 'CL', color: '#1F6FB2', src: 'goal', key: 'cmr77dvyx00ekrx064z74pcl5', sr: 'sr:competition:216' },
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
const fbSeason = (d) => (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);
// Läuft gerade (oder gleich) ein Spiel dieser Liga? Dann öfter nachfragen
const liveWindow = (list, now) => list.some((m) => m.st === 'live' || m.st === 'ht' || (m.st === 'pre' && Math.abs(Date.parse(m.utc) - now) < 20 * 60 * 1000)
  || (m.st !== 'ft' && m.st !== 'off' && now > Date.parse(m.utc) && now - Date.parse(m.utc) < 130 * 60 * 1000));
const kickoffJustStarted = (m, now) => m.st === 'pre' && now >= Date.parse(m.utc) && now - Date.parse(m.utc) <= 3 * 60 * 1000;
// Sportradar-Live-Liste um den Anpfiff nur für Spiele der Lieblingsteams sofort neu holen (sonst gilt der normale Abstand von 7 Min.)
const favKickoff = (res, now) => res.some((r) => r.matches.some((m) => kickoffJustStarted(m, now) && (liveFavs.has(String(m.h).toLowerCase()) || liveFavs.has(String(m.a).toLowerCase()))));

// Kleiner Zwischenspeicher in der Datenbank (überlebt Neustarts der Funktion); ohne Tabelle nur im Speicher.
// Gegen Datenverkehr (Egress): Liegt der Eintrag schon im Speicher dieser Instanz, zuerst nur den Zeitstempel lesen
// (wenige Bytes) und die Daten nur neu holen, wenn ein anderer Aufruf sie inzwischen geändert hat. Der Minuten-Tick
// liest sonst jede Minute die ganzen Tabellen und Spielpläne (rund 1 MB) aus der Datenbank.
const fbMem = new Map();
async function cacheGet(key) {
  if (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    const url = `${SUPABASE_URL}/rest/v1/el_fb_cache?key=eq.${encodeURIComponent(key)}`;
    try {
      const mem = fbMem.get(key);
      if (mem) {
        const r = await fetch(`${url}&select=at`, { headers: serviceHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (r.ok) {
          const row = (await r.json())[0];
          if (!row) { fbMem.delete(key); return null; }
          if (Date.parse(row.at) === mem.at) return mem;
        }
      }
      const r = await fetch(`${url}&select=data,at`, { headers: serviceHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) {
        const row = (await r.json())[0];
        if (!row) return null;
        const hit = { data: row.data, at: Date.parse(row.at) };
        fbMem.set(key, hit);
        return hit;
      }
    } catch { /* Tabelle fehlt: Speicher */ }
  }
  return fbMem.get(key) || null;
}
async function cacheSet(key, data) {
  const at = Date.now();
  fbMem.set(key, { data, at });
  if (!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return;
  await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?on_conflict=key`, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, data, at: new Date(at).toISOString() }), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {});
}
// Tageszähler gegen die Kontingente der Anbieter. Atomar über die SQL-Funktion el_fb_incr (supabase/el_fb_incr.sql); fehlt sie,
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
// ---------- bigballsdata.com (grosse Ligen, Champions League, Nationalteams) ----------
const BB_BASE = 'https://api.bigballsdata.com/v1';
const bbDailyMax = () => Number(Deno.env.get('BIGBALLS_DAILY')) || 230;
// Abstand der Live-Abfragen: mit grosser Tagesgrenze (Secret BIGBALLS_DAILY ab 1000, Plan mit 2000/Tag) alle 2 Min., sonst alle 5 Min.
// (Spieltage mit Spielen von 13 bis 23 Uhr: rund 3 Abfragen pro Durchgang)
// Sparsam: 2 Min. nur, solange jemand die Seite offen hat (Abruf ?fb=1 in den letzten 10 Min.) oder ein Lieblingsteam eines
// Mitteilungs-Abos spielt; sonst 5 Min. (liveEager setzt der Abruf bzw. pushTick)
let liveEager = true;
// Lieblingsteams der Mitteilungs-Abos (setzt pushTick). Bei ihren Spielen fragen Super League und Challenge League jede Minute ab,
// die Premier League (FPL) alle 25 Sek. – von kurz vor dem Anpfiff bis Spielende
let liveFavs = new Set();
const isFavGame = (m, now) => (liveFavs.has(String(m.h).toLowerCase()) || liveFavs.has(String(m.a).toLowerCase()))
  && m.st !== 'ft' && m.st !== 'off' && Date.parse(m.utc) - now < 2 * 60 * 1000 && now - Date.parse(m.utc) < 3 * 3600e3;
// Ohne Zuschauer und ohne Spiel eines Lieblingsteams: 10 Min. (fremde Spiele, spart Abfragen)
const BB_LIVE_MS_FN = () => (liveEager ? (bbDailyMax() >= 1000 ? 2 : 5) : 10) * 60 * 1000;
// Tagesgrenze erreicht: Zeitpunkt merken, damit die Seite «Live-Stände pausiert» zeigen kann statt still alte Stände
let bbPausedAt = 0;
const bbAllowed = async () => { const ok = await dailyAllowed('bbcount', bbDailyMax()); if (!ok) bbPausedAt = Date.now(); return ok; };
async function bbGet(path, params = {}) {
  countUse('bb', path, params);
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
  // Big Balls hat für Fussball keinen echten Live-Feed: ein «laufendes» Spiel 180 Min. nach Anpfiff (inkl. Verlängerung und
  // Penaltyschiessen) ist vorbei; mit Spielstand als beendet werten, sonst bliebe es für immer live
  if ((st === 'live' || st === 'ht') && sinceKo > 180 * 60 * 1000 && m.score?.home != null) st = 'ft';
  const ls = m.linescore;
  const ht = ls?.home?.length > 1 && ls.home[0] != null ? `${ls.home[0]}:${ls.away[0]}` : '';
  return { id: `bb-${m.id}`, l: lg.id, utc: new Date(m.kickoff_utc).toISOString(), round: String(m.round || '').replace(/^Regular Season - /, ''),
    h: String(m.home?.name || ''), a: String(m.away?.name || ''), hl: fbImg(m.home?.logo_url), al: fbImg(m.away?.logo_url),
    hs: st === 'pre' ? null : m.score?.home ?? null, as: st === 'pre' ? null : m.score?.away ?? null, st, min: st === 'live' && cm ? cm[1] : null, ht, note: st === 'off' ? raw : '' };
}
// Spielplan eines Wettbewerbs (Clubs: Saison = Startjahr; Nationalteams: Kalenderjahr), täglich.
// /matches ohne Filter liefert nur kommende Spiele – darum zusätzlich eine Seite beendeter Spiele, und der alte Stand bleibt
// erhalten (sonst fallen gespielte Partien beim Neuladen aus der Übersicht)
async function bbFixtures(lg, now) {
  const ck = `bb2:${lg.key}`; // bb2: Stand inkl. beendeter Spiele (ersetzt den alten Stand einmal)
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < (hit.data.status === 'ok' ? 24 * 3600 * 1000 : 30 * 60 * 1000)) return hit.data;
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
// Live-Feed (ohne ?date=; mit Datum liefert /scores nur die gespeicherte, während Spielen nicht nachgeführte Liste):
// Spielstände pro match_id, home/away sind dort Zahlen. Während Live-Fenstern alle BB_LIVE_MS.
const bbNorm = (x) => {
  const id = x.match_id || x.id || x.game_id;
  const num2 = (v) => (typeof v === 'number' ? v : v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
  const score = x.score && typeof x.score === 'object' ? x.score
    : num2(x.home) != null || num2(x.away) != null ? { home: num2(x.home), away: num2(x.away) }
    : x.home_score != null ? { home: num2(x.home_score), away: num2(x.away_score) } : undefined;
  return { id: `bb-${id}`, m: { ...x, id, score, status: x.status ?? x.state ?? x.match_status, clock: x.clock ?? x.minute ?? x.elapsed ?? x.time,
    home: typeof x.home === 'object' ? x.home : undefined, away: typeof x.away === 'object' ? x.away : undefined } };
};
async function bbLive(now) {
  const ck = 'bblive';
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < BB_LIVE_MS_FN()) return hit.data;
  if (!(await bbAllowed())) return hit?.data || null;
  try {
    const d = await bbGet('scores', { sport: 'football', limit: '200' });
    const arr = Array.isArray(d?.data) ? d.data : d?.data?.scores?.value || d?.data?.value || d?.scores?.value || [];
    const data = { list: arr.map(bbNorm).filter((x) => x.m.id), source: String(d?.meta?.source || '') };
    await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || null; }
}
// Namen über Wortanfänge vergleichen («Internazionale» ~ «Inter Milan», «Bodo/Glimt» ~ «FK Bodø/Glimt»)
const nameTok = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ø/gi, 'o').toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 4 || /^(psg|lask|roma|ac|as|psv)$/.test(w)).map((w) => w.slice(0, 4));
const sameTeam = (a, b) => { const x = nameTok(a), y = new Set(nameTok(b)); return x.some((w) => y.has(w)); };
// ---------- Fantasy Premier League (inoffizielle, öffentliche Schnittstelle der Premier League; gratis, ohne Schlüssel) ----------
// Live-Stand, Minute und Torschützen der Premier League: eine Abfrage pro Spielrunde für alle Spiele (während Live alle 60 Sek.).
// Die Torminute liefert FPL nicht: sie wird beim ersten Erkennen des Tors gemerkt (auf etwa 1–2 Min. genau).
const FPL = 'https://fantasy.premierleague.com/api';
const FPL_UA = 'SportPWA/1.0 (private, non-commercial)';
async function fplJson(path) {
  const r = await fetch(`${FPL}/${path}`, { headers: { accept: 'application/json', 'user-agent': FPL_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`FPL HTTP ${r.status}`);
  return r.json();
}
async function fplBoot(now) {
  const hit = await cacheGet('fplboot');
  if (hit && now - hit.at < 24 * 3600 * 1000) return hit.data;
  try {
    const d = await fplJson('bootstrap-static/');
    const data = { teams: Object.fromEntries((d.teams || []).map((t) => [t.id, t.name])), players: Object.fromEntries((d.elements || []).map((p) => [p.id, p.web_name])),
      events: (d.events || []).map((e) => ({ id: e.id, dl: e.deadline_time })) };
    if (Object.keys(data.teams).length) await cacheSet('fplboot', data);
    return data;
  } catch { return hit?.data || null; }
}
async function fplFixtures(ev, now, live) {
  const ck = `fplfx:${ev}`;
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < (live ? (typeof live === 'number' ? live : 60 * 1000) : 15 * 60 * 1000)) return hit.data;
  try { const d = await fplJson(`fixtures/?event=${ev}`); const data = Array.isArray(d) ? d : []; await cacheSet(ck, data); return data; }
  // Bei einem FPL-Ausfall nur ganz frische Daten weiterverwenden, sonst übernehmen die anderen Quellen
  catch { return hit && now - hit.at < 3 * 60 * 1000 ? hit.data : []; }
}
const FPL_ALIAS = { manutd: 'manchesterunited', mancity: 'manchestercity', spurs: 'tottenhamhotspur', nottmforest: 'nottinghamforest', wolves: 'wolverhamptonwanderers', sheffieldutd: 'sheffieldunited' };
export const fplSame = (fplName, ours) => {
  const a0 = teamKey(fplName), a = FPL_ALIAS[a0] || a0, b = teamKey(ours);
  return a.length >= 4 && b.length >= 4 && (a === b || a.startsWith(b.slice(0, 6)) || b.startsWith(a.slice(0, 6)));
};
// Torschützen aus den Statistiken; neue Tore bekommen die aktuelle Spielminute, bekannte behalten ihre
async function fplGoals(f, boot) {
  const ck = `fplg:${f.id}`;
  const hit = await cacheGet(ck);
  const old = hit?.data?.list || [];
  const stat = (id) => (f.stats || []).find((x) => x.identifier === id) || { h: [], a: [] };
  const keys = [];
  const add = (arr, side, pre, suffix) => { for (const g of arr || []) for (let k = 0; k < (g.value || 0); k++) keys.push({ key: `${pre}${g.element}#${k}`, s: side, n: `${boot.players[g.element] || ''}${suffix}` }); };
  add(stat('goals_scored').h, 1, 'g', ''); add(stat('goals_scored').a, 2, 'g', '');
  add(stat('own_goals').h, 2, 'o', ' (Eigentor)'); add(stat('own_goals').a, 1, 'o', ' (Eigentor)');
  const prev = new Map(old.map((g) => [g.key, g]));
  // Erstmals gesehen (z. B. nach einem Neustart mitten im Spiel): Minute unbekannt
  const list = keys.map((g) => prev.get(g.key) || { ...g, m: hit ? (f.minutes ? String(f.minutes) : '') : '' });
  list.sort((x, y) => (Number(String(x.m).split('+')[0]) || 0) - (Number(String(y.m).split('+')[0]) || 0));
  if (!hit || JSON.stringify(list) !== JSON.stringify(old)) await cacheSet(ck, { list });
  return list.map(({ m, s: side, n }) => ({ m, s: side, n }));
}
// Premier-League-Spiele mit FPL nachführen; zurück: IDs der Spiele, die FPL abdeckt (für die keine andere Quelle mehr nötig ist)
async function fplApply(list, res, now, open) {
  const done = new Set();
  let ft = false;
  const i = list.findIndex((l) => l.id === 'pl');
  if (i < 0) return { done, ft };
  const todo = res[i].matches.map((m, j) => [m, j]).filter(([m]) => open(m) || (m.st === 'pre' && now >= Date.parse(m.utc)));
  if (!todo.length) return { done, ft };
  const boot = await fplBoot(now);
  if (!boot?.events?.length) return { done, ft };
  const evOf = (t) => boot.events.filter((e) => Date.parse(e.dl) <= t).at(-1)?.id;
  const evs = [...new Set(todo.map(([m]) => evOf(Date.parse(m.utc))).filter(Boolean))];
  const fx = (await Promise.all(evs.map((e) => fplFixtures(e, now, todo.some(([m]) => isFavGame(m, now)) ? 25 * 1000 : 60 * 1000)))).flat();
  for (const [m, j] of todo) {
    const t = Date.parse(m.utc);
    const f = fx.find((x) => x.kickoff_time && Math.abs(Date.parse(x.kickoff_time) - t) < 40 * 60 * 1000 && (fplSame(boot.teams[x.team_h], m.h) && fplSame(boot.teams[x.team_a], m.a)));
    if (!f) continue;
    // Noch nicht angepfiffen laut FPL: nur kurz nach der Anstosszeit glauben, danach die anderen Quellen fragen
    if (!f.started) { if (now - t < 10 * 60 * 1000) done.add(m.id); continue; }
    const st = f.finished || f.finished_provisional ? 'ft' : 'live';
    const hs = f.team_h_score ?? 0, as = f.team_a_score ?? 0;
    const goals = await fplGoals(f, boot).catch(() => null);
    // Unbekannte Minuten (Kaltstart) aus einer anderen Quelle übernehmen: gleiche Seite, Nachname passt
    const last = (n) => teamKey(String(n || '').replace(/\(.*\)/, '').split(/[\s.]+/).filter(Boolean).at(-1));
    if (goals && m.goals?.length) for (const g of goals) if (g.m === '') { const o = m.goals.find((x) => x.s === g.s && x.m !== '' && last(x.n) && last(x.n) === last(g.n)); if (o) g.m = String(o.m); }
    // Torschützen nur übernehmen, wenn sie zum Stand passen (FPL trägt sie manchmal eine Minute nach dem Tor ein)
    const g = goals && goals.length === hs + as ? goals : m.goals?.length === hs + as ? m.goals : undefined;
    res[i].matches[j] = { ...m, st, hs, as, min: st === 'live' ? (f.minutes ? String(f.minutes) : null) : null, goals: g, src: 'fpl' };
    if (st === 'ft') ft = true;
    done.add(m.id);
  }
  return { done, ft };
}

async function bbLeagues(list, now) {
  if (!Deno.env.get('BIGBALLS_KEY')) return list.map(() => ({ status: 'nokey', message: 'Big-Balls-Schlüssel fehlt', matches: [] }));
  const res = await Promise.all(list.map((lg) => bbFixtures(lg, now)));
  list.forEach((lg, i) => { for (const m of res[i].matches || []) MATCH_LG.set(m.id, lg.id); });
  const open0 = (m) => m.st !== 'ft' && m.st !== 'off' && Date.parse(m.utc) <= now && now - Date.parse(m.utc) < 30 * 3600e3;
  const forceKickoff = res.some((r) => r.matches.some((m) => kickoffJustStarted(m, now)));
  if (!res.some((r) => r.matches.some(open0)) && !forceKickoff) return res;
  // Premier League zuerst über FPL (gratis): was FPL abdeckt, fragt keine andere Quelle mehr ab
  const fpl = await fplApply(list, res, now, open0).catch(() => ({ done: new Set(), ft: false }));
  const plIdx = list.findIndex((l) => l.id === 'pl');
  if (fpl.ft && plIdx >= 0) await cacheSet(`bb2:${list[plIdx].key}`, res[plIdx]);
  const open = (m) => open0(m) && !fpl.done.has(m.id);
  const others = (ms) => ms.filter((m) => !fpl.done.has(m.id));
  if (!res.some((r) => r.matches.some(open)) && !res.some((r) => others(r.matches).some((m) => kickoffJustStarted(m, now)))) return res;
  // Jeden UTC-Tag mit offenen Spielen abfragen (Abendspiele von gestern stehen nicht in der Liste von heute)
  const days = [...new Set(res.flatMap((r) => r.matches.filter(open).map((m) => m.utc.slice(0, 10))))].sort().slice(-2);
  const liveDay = (d) => res.some((r) => liveWindow(others(r.matches).filter((m) => m.utc.slice(0, 10) === d), now));
  // Laufende Stände kommen aus dem Live-Feed; die Tagesliste (Endstände) genügt dann im doppelten Abstand
  const lists = await Promise.all(days.map((d) => bbDay(d, now, liveDay(d) && liveEager ? 2 * BB_LIVE_MS_FN() : 15 * 60 * 1000)));
  const byId = new Map(lists.flatMap((l) => (l?.list || []).map((x) => [x.id, x.m])));
  // Laufende Spiele: Live-Feed hat Vorrang vor der gespeicherten Tagesliste (die für die Champions League hinterherhinkt)
  if (days.some(liveDay)) {
    const live = await bbLive(now);
    for (const x of live?.list || []) {
      const old = byId.get(x.id) || {};
      const merged = { ...old, ...Object.fromEntries(Object.entries(x.m).filter(([, v]) => v != null)) };
      // Ohne Spielstand oder Status im Live-Feed den gespeicherten Stand behalten
      if (x.m.score?.home == null && !x.m.status) continue;
      byId.set(x.id, merged);
    }
  }
  const changed = new Set();
  res.forEach((r, i) => r.matches.forEach((m, j) => {
    const x = byId.get(m.id);
    if (!x || !open(m)) return;
    // Live-Feed ohne Status, aber mit Spielstand nach dem Anpfiff: als laufend werten
    const st0 = x.status || (x.score?.home != null && Date.parse(m.utc) <= now ? 'live' : '');
    const fresh = mapBb(list[i], { ...x, status: st0, kickoff_utc: x.kickoff_utc || m.utc, home: x.home || { name: m.h }, away: x.away || { name: m.a } });
    if (fresh.st === 'ft') changed.add(i);
    r.matches[j] = { ...m, st: fresh.st, hs: fresh.hs, as: fresh.as, min: fresh.min, ht: fresh.ht || m.ht, note: fresh.note };
  }));
  await addScorers(list, res, now).catch(() => {});
  // Big Balls hat für Fussball keinen Live-Feed (nur nachgeladene Datenbank): Ligen mit Sportradar-Wettbewerb (Champions
  // League, Premier League) über die Sportradar-Live-Liste (eine Abfrage für alle Spiele weltweit) nachführen
  if (Deno.env.get('SPORTRADAR_KEY')) {
    // Ligen mit eigener Quelle GOAL (Super League, Challenge League) nicht über Sportradar (der sr-Eintrag dient dort nur den Namen)
    const srIdx = list.map((lg, i) => { const L = FB_LEAGUES.find((l) => l.id === lg.id); return L?.sr && L.src !== 'goal' ? i : -1; }).filter((i) => i >= 0);
    const need = srIdx.some((i) => others(res[i].matches).some((m) => open(m) || kickoffJustStarted(m, now)));
    if (need) {
      const live = srIdx.some((i) => liveWindow(others(res[i].matches), now)) ? await srLive(now, favKickoff(res, now)).catch(() => null) : null;
      const byIdSr = new Map((live?.list || []).map((x) => [x.id, x]));
      for (const i of srIdx) {
        const lg = FB_LEAGUES.find((l) => l.id === list[i].id);
        const sched = await srFixtures({ ...lg, key: lg.sr }, now).catch(() => null);
        if (!sched) continue;
        for (let j = 0; j < res[i].matches.length; j++) {
          const m = res[i].matches[j];
          if (!open(m)) continue;
          const t = Date.parse(m.utc);
          const sr = sched.matches.find((x) => Math.abs(Date.parse(x.utc) - t) < 3 * 3600e3 && (nameKey(x.h) === nameKey(m.h) || nameKey(x.a) === nameKey(m.a)));
          if (!sr) continue;
          let x = byIdSr.get(sr.id);
          // Nicht (mehr) live und seit über 100 Min. angepfiffen: einmal die Timeline (nach Spielende dauerhaft gespeichert)
          if (!x && now - t > 100 * 60 * 1000) { const tl = await srTimeline(sr.id, now).catch(() => null); if (tl) x = { es: tl.es, goals: tl.goals }; }
          if (!x) continue;
          const st = srState(x.es);
          if (st === 'pre') continue;
          const p1 = (x.es.period_scores || []).find((p) => p.number === 1);
          res[i].matches[j] = { ...m, st, hs: x.es.home_score ?? m.hs, as: x.es.away_score ?? m.as, min: st === 'live' ? srMin(x.es) : null,
            ht: p1 ? `${p1.home_score}:${p1.away_score}` : m.ht, goals: x.goals?.length ? x.goals : m.goals };
          if (st === 'ft') changed.add(i);
        }
      }
      for (const i of changed) await cacheSet(`bb2:${list[i].key}`, res[i]);
    }
  }
  return res;
}
// Torschützen für laufende und eben beendete Spiele ohne Tore: Bundesliga von OpenLigaDB (frei, während des Spiels jede Minute),
// alle anderen aus den gespeicherten Tor-Abfragen bei Big Balls (die der Mitteilungs-Zeitplan bei jedem neuen Tor macht).
// Liest nur Gespeichertes bzw. eine freie Quelle: keine zusätzlichen Abfragen beim Big-Balls-Kontingent.
async function addScorers(list, res, now) {
  const recent = (m) => m.st === 'live' || m.st === 'ht' || (m.st === 'ft' && now - Date.parse(m.utc) < 4 * 3600e3);
  const want = (m) => recent(m) && !m.goals?.length;
  for (let i = 0; i < list.length; i++) {
    const todo = res[i].matches.map((m, j) => [m, j]).filter(([m]) => want(m));
    if (!todo.length) continue;
    const lg = FB_LEAGUES.find((l) => l.id === list[i].id);
    let oldb = null;
    if (lg?.oldb) oldb = await oldbLeague({ id: lg.oldb, key: lg.oldb }, fbSeason(new Date(now)), now).catch(() => null);
    for (const [m, j] of todo) {
      let goals = null;
      if (oldb) {
        const t = Date.parse(m.utc);
        const o = oldb.matches.find((x) => Math.abs(Date.parse(x.utc) - t) < 2 * 3600e3 && (sameTeam(m.h, x.h) || sameTeam(m.a, x.a)));
        // OpenLigaDB ist während des Spiels meist schneller als Big Balls: mit mindestens so vielen Toren gilt auch ihr Stand
        if (o?.goals?.length && o.goals.length >= (m.hs || 0) + (m.as || 0)) {
          goals = o.goals;
          if (o.hs != null && o.as != null) res[i].matches[j] = { ...res[i].matches[j], hs: o.hs, as: o.as };
        }
      }
      if (!goals && /^bb-/.test(m.id)) {
        const hit = await cacheGet(`bbev:${m.id.slice(3)}`);
        if (hit?.data?.goals?.length) goals = hit.data.goals;
      }
      if (goals) res[i].matches[j] = { ...res[i].matches[j], goals };
    }
  }
}
// Tore eines Spiels; nach Spielende dauerhaft, sonst 2 Min. gespeichert
async function bbGame(id) {
  const uuid = String(id).replace(/^bb-/, '');
  const ck = `bbev:${uuid}`;
  const hit = await cacheGet(ck);
  if (hit && (hit.data.final || Date.now() - hit.at < BB_LIVE_MS_FN())) return hit.data;
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
  // Heißt das Team im Tor-Ereignis anders als im Spiel (z. B. «Leeds» statt «Leeds United»), landen alle Tore beim Gast:
  // passt nur die vertauschte Verteilung zum Stand, die Seiten tauschen
  const swapped = asIs.map((g) => ({ ...g, s: 3 - g.s }));
  const goals = fits(asIs) ? asIs : fits(flipped) ? flipped : fits(swapped) ? swapped : asIs;
  const data = { goals, final: match.status === 'finished' };
  await cacheSet(ck, data);
  return data;
}
// Tabellen und Torschützen aus Big Balls Data
// Zonen: [von, bis, Art] – cl/el/co = Europacup-Plätze, rel = Relegation, ab = Abstieg (Stand Saison 26/27, ohne Sonderfälle wie Pokalsieger)
const BB_TABLE = {
  ucl: { key: 'ucl', zones: [[1, 8, 'ucl-r16'], [9, 24, 'ucl-playoff'], [25, 36, 'ucl-out']] },
  pl: { key: 'epl', scorers: 'epl', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [18, 20, 'ab']] },
  bl1: { key: 'bundesliga', scorers: 'bundesliga', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [16, 16, 'rel'], [17, 18, 'ab']] },
  laliga: { key: 'laliga', scorers: 'laliga', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [18, 20, 'ab']] },
  seriea: { key: 'seriea', scorers: 'serie-a', zones: [[1, 4, 'cl'], [5, 5, 'el'], [6, 6, 'co'], [18, 20, 'ab']] },
  ligue1: { key: 'ligue1', scorers: 'ligue-1', zones: [[1, 3, 'cl'], [4, 4, 'clq'], [5, 5, 'el'], [6, 6, 'co'], [16, 16, 'rel'], [17, 18, 'ab']] },
  chsl: { goal: 'cmr77dvyx00egrx06pta3wmnc', zones: [] },
  chcl: { goal: 'cmr77dvyx00ekrx064z74pcl5', zones: [] },
  // Championship: Tabelle von Sportradar (keine Torschützenliste)
  efl: { sr: 'sr:competition:18', zones: [[1, 2, 'up'], [3, 6, 'upq'], [22, 24, 'ab']] },
};
// Tabelle eines Sportradar-Wettbewerbs (eine Abfrage), bis 6 Std. gespeichert
async function srTable(cfg, now, force) {
  const ck = `srtab:${cfg.sr}`;
  const hit = await cacheGet(ck);
  if (hit && !force && now - hit.at < 6 * 3600 * 1000) return hit.data;
  if (!Deno.env.get('SPORTRADAR_KEY') || !(await srAllowed())) return hit?.data || { available: false };
  try {
    const season = await srSeason({ key: cfg.sr }, now);
    if (!season) return hit?.data || { available: false };
    const d = await srGet(`seasons/${season}/standings`);
    const st = (d?.standings || []).find((x) => x.type === 'total') || d?.standings?.[0];
    const rows = (st?.groups?.[0]?.standings || []).map((r) => {
      const name = r.competitor?.name || '';
      return { rank: r.rank, team: srName(name), logo: srLogo(name), p: r.played ?? 0, w: r.win ?? 0, d: r.draw ?? 0, l: r.loss ?? 0,
        gf: r.goals_for ?? 0, ga: r.goals_against ?? 0, pts: r.points ?? 0 };
    }).sort((a, b) => a.rank - b.rank);
    const data = { available: rows.length > 0, zones: cfg.zones, rows, source: 'Sportradar', asOf: new Date(now).toISOString() };
    if (rows.length) await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || { available: false }; }
}
async function fbLeague(id, kind, now = Date.now(), force = false) {
  const cfg = BB_TABLE[id];
  if (!cfg) return { available: false };
  if (cfg.goal) return kind === 'scorers' ? { available: false } : goalTable(cfg, now, force);
  if (cfg.sr) return kind === 'scorers' ? { available: false } : srTable(cfg, now, force);
  if (kind === 'scorers') {
    if (id === 'ucl') {
      const season = String(fbSeason(new Date(now)));
      const ck = `oldbsc:${id}:${season}`;
      const hit = await cacheGet(ck);
      if (hit && !force && now - hit.at < 24 * 3600 * 1000) return hit.data;
      try {
        const raw = await getJson(`https://api.openligadb.de/getgoalgetters/${id}/${season}`);
        const rows = (Array.isArray(raw) ? raw : []).sort((a, b) => Number(b.goalCount || 0) - Number(a.goalCount || 0))
          .slice(0, 20).map((r, i) => ({ rank: i + 1, n: String(r.goalGetterName || ''), team: '', g: Number(r.goalCount) || 0, a: null }));
        const data = { available: rows.length > 0, rows, source: 'OpenLigaDB' };
        await cacheSet(ck, data);
        return data;
      } catch { return hit?.data || { available: false }; }
    }
    if (!Deno.env.get('BIGBALLS_KEY') || !cfg.scorers) return { available: false };
    const ck = `bbsc:${cfg.key}`;
    const hit = await cacheGet(ck);
    if (hit && !force && now - hit.at < 24 * 3600 * 1000) return hit.data;
    if (!(await bbAllowed())) return hit?.data || { available: false };
    const d = await bbGet(`leagues/${cfg.scorers}/top-scorers`, { limit: '20' }).catch(() => null);
    // Fehler oder leere Antwort: den alten Stand behalten statt ihn zu überschreiben
    if (!d?.data?.length) return hit?.data || { available: false };
    const data = { available: true, source: 'Big Balls', rows: (d?.data || []).map((r) => ({ rank: r.rank, n: String(r.player_name || ''), team: String(r.team || ''), g: r.goals ?? 0, a: r.assists ?? 0, mp: r.matches ?? null })) };
    await cacheSet(ck, data);
    return data;
  }
  if (!Deno.env.get('BIGBALLS_KEY')) return { available: false };
  const ck = `bbtab:${cfg.key}`;
  const hit = await cacheGet(ck);
  if (hit && !force && now - hit.at < 24 * 3600 * 1000) return hit.data;
  if (!(await bbAllowed())) return hit?.data || { available: false };
  const params = id === 'ucl'
    ? { sport: 'football', league: cfg.key, season: String(fbSeason(new Date(now))) }
    : { league: cfg.key };
  const d = await bbGet('standings', params).catch(() => null);
  const t = d?.data?.standings?.[0];
  const rows = (t?.rows || []).map((r) => {
    const w = r.wins ?? 0, draws = r.draws ?? r.ties ?? 0;
    return { rank: r.rank, team: String(r.team_name || r.team || ''), logo: fbImg(r.logo_url), p: r.games_played ?? r.played ?? 0, w, d: draws, l: r.losses ?? 0,
      gf: r.goals_for ?? r.goals_scored ?? r.points_for ?? 0, ga: r.goals_against ?? r.goals_conceded ?? r.points_against ?? 0,
      pts: r.points ?? r.pts ?? (w * 3 + draws) };
  }).sort((a, b) => a.rank - b.rank);
  // Fehler oder leere Antwort: die gespeicherte Tabelle behalten statt sie für einen Tag mit «nicht verfügbar» zu überschreiben
  if (!rows.length) return hit?.data || { available: false };
  const data = { available: true, season: String(t?.season || ''), zones: cfg.zones, rows, asOf: new Date(now).toISOString() };
  await cacheSet(ck, data);
  return data;
}
const teamKey = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, '').replace(/\b(a?fc|cf|sc)\b/g, '').replace(/[^a-z]/g, '');
const zurichDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date(iso));
// Premier League und Champions League: Aufstellung und Live-Spielstatistik nach Möglichkeit von Sportradar
const nameKey = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\b(fc|afc|cf)\b/g, '').replace(/[^a-z]/g, '').slice(0, 6);
async function srMatchFor(m, now) {
  const lg = FB_LEAGUES.find((l) => l.id === m.l);
  const sr = lg?.sr || SR_LINEUP[m.l];
  if (!sr || !Deno.env.get('SPORTRADAR_KEY')) return null;
  const sched = await srFixtures({ ...lg, key: sr }, now);
  for (const x of sched.matches) if (!MATCH_LG.has(x.id)) MATCH_LG.set(x.id, m.l);
  const t = Date.parse(m.utc);
  return sched.matches.find((x) => x.id === m.id) || sched.matches.find((x) => Math.abs(Date.parse(x.utc) - t) < 3 * 3600e3 && (nameKey(x.h) === nameKey(m.h) || nameKey(x.a) === nameKey(m.a))) || null;
}
// Ligen mit Aufstellung und Teamstatistik: Premier League und Champions League mit Sportradar-Aufstellung (genauer: Formation,
// Positionen links/rechts), sonst und als Ersatz die Aufstellung von Big Balls (nur Tor/Verteidigung/Mittelfeld/Sturm)
const DETAIL_LEAGUES = new Set(['pl', 'ucl', 'efl', 'bl1', 'laliga', 'seriea', 'ligue1', 'chsl', 'chcl']);
// Aufstellungen auch für diese Ligen von Sportradar (mit Nationalität); nur beim Öffnen einer Aufstellung abgefragt, sonst Big Balls
const SR_LINEUP = { efl: 'sr:competition:18', bl1: 'sr:competition:35', laliga: 'sr:competition:8', seriea: 'sr:competition:23', ligue1: 'sr:competition:34' };
// Nationalität: Sportradar liefert ISO-3-Codes (dazu ENG/SCO/WAL/NIR) → ISO-2 bzw. gb-eng usw., die Seite macht daraus Flagge und Namen
const ISO3 = Object.fromEntries('AFG AF ALB AL DZA DZ AND AD AGO AO ATG AG ARG AR ARM AM AUS AU AUT AT AZE AZ BHS BS BHR BH BGD BD BRB BB BLR BY BEL BE BLZ BZ BEN BJ BTN BT BOL BO BIH BA BWA BW BRA BR BRN BN BGR BG BFA BF BDI BI CPV CV KHM KH CMR CM CAN CA CAF CF TCD TD CHL CL CHN CN COL CO COM KM COG CG COD CD CRI CR CIV CI HRV HR CUB CU CUW CW CYP CY CZE CZ DNK DK DJI DJ DMA DM DOM DO ECU EC EGY EG SLV SV GNQ GQ ERI ER EST EE SWZ SZ ETH ET FRO FO FJI FJ FIN FI FRA FR GUF GF GAB GA GMB GM GEO GE DEU DE GER DE GHA GH GIB GI GRC GR GRD GD GLP GP GUM GU GTM GT GIN GN GNB GW GUY GY HTI HT HND HN HKG HK HUN HU ISL IS IND IN IDN ID IRN IR IRQ IQ IRL IE ISR IL ITA IT JAM JM JPN JP JOR JO KAZ KZ KEN KE PRK KP KOR KR XKX XK KOS XK KWT KW KGZ KG LAO LA LVA LV LBN LB LSO LS LBR LR LBY LY LIE LI LTU LT LUX LU MAC MO MDG MG MWI MW MYS MY MDV MV MLI ML MLT MT MTQ MQ MRT MR MUS MU MEX MX MDA MD MCO MC MNG MN MNE ME MSR MS MAR MA MOZ MZ MMR MM NAM NA NPL NP NLD NL NCL NC NZL NZ NIC NI NER NE NGA NG MKD MK NOR NO OMN OM PAK PK PSE PS PAN PA PNG PG PRY PY PER PE PHL PH POL PL PRT PT PRI PR QAT QA REU RE ROU RO RUS RU RWA RW KNA KN LCA LC VCT VC WSM WS SMR SM STP ST SAU SA SEN SN SRB RS SYC SC SLE SL SGP SG SVK SK SVN SI SLB SB SOM SO ZAF ZA SSD SS ESP ES LKA LK SDN SD SUR SR SWE SE CHE CH SUI CH SYR SY TWN TW TJK TJ TZA TZ THA TH TLS TL TGO TG TON TO TTO TT TUN TN TUR TR TKM TM UGA UG UKR UA ARE AE GBR GB USA US URY UY UZB UZ VUT VU VEN VE VNM VN YEM YE ZMB ZM ZWE ZW NED NL POR PT CRO HR DEN DK GRE GR BUL BG ALG DZ RSA ZA KSA SA UAE AE CHI CL URU UY PAR PY CRC CR HON HN GUA GT SLO SI LAT LV'.match(/\S+ \S+/g).map((x) => x.split(' ')));
const UK = { ENG: 'gb-eng', SCO: 'gb-sct', WAL: 'gb-wls', NIR: 'gb-nir' };
const natCode = (p) => { const c = String(p?.country_code || '').toUpperCase(); return UK[c] || ISO3[c] || ''; };
async function bbLineup(m, now) {
  const uuid = m.id.replace(/^bb-/, '');
  const ck = `bblu:${uuid}`;
  const hit = await cacheGet(ck);
  // Ältere gespeicherte Aufstellungen ohne Rückennummern der Ersatzspieler: einmal neu laden
  const noNos = hit?.data?.available && !hit.data.home?.benchNo;
  if (hit && !noNos && (hit.data.final || now - hit.at < (hit.data.available ? 3 * 3600 : 15 * 60) * 1000)) return hit.data;
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
      bench: bench.map((p) => String(p.name || '')), benchIds: bench.map((p) => `bb:${p.player_id}`), benchNo: bench.map((p) => p.jersey_number ?? '') };
  };
  const data = { available: (d?.data?.home || []).some((p) => p.starter), home: team(d?.data?.home), away: team(d?.data?.away), final: m.st === 'ft', src: 'bb' };
  await cacheSet(ck, data);
  return data;
}
async function fbDetail(id, kind, now = Date.now(), overview = null) {
  const ov = overview || await fbOverview(now);
  const m = ov.matches.find((x) => x.id === id);
  if (!m || !DETAIL_LEAGUES.has(m.l)) return { error: 'nicht verfügbar' };
  // Super League, Challenge League: Aufstellung und Live-Statistik von GOAL
  if (id.startsWith('gl-')) return kind === 'stats' ? goalStats(m, now) : goalLineup(m, now);
  if (kind === 'stats') {
    // Nach Spielende Big Balls (dauerhaft gespeichert); während des Spiels und als Ersatz Sportradar (UCL, PL, Championship)
    if (m.st === 'pre') return { available: false };
    const bbStats = async () => {
      if (!id.startsWith('bb-')) return { available: false };
      const uuid = id.replace(/^bb-/, '');
      const ck = `bbst:${uuid}`;
      const hit = await cacheGet(ck);
      if (hit && (hit.data.final || now - hit.at < 30 * 60 * 1000)) return hit.data;
      if (!(await bbAllowed())) return hit?.data || { available: false };
      const d = await bbGet(`matches/${uuid}/statistics`);
      const side = (x) => x && { poss: x.ball_possession, shots: x.total_shots, on: x.shots_on_target, corners: x.corner_kicks, fouls: x.fouls,
        yellow: x.yellow_cards, red: x.red_cards, passes: x.total_passes, acc: x.accurate_passes, saves: x.goalkeeper_saves, offsides: x.offsides };
      const available = d?.meta?.available !== false && !!d?.data?.home;
      const data = { available, home: side(d?.data?.home), away: side(d?.data?.away), final: m.st === 'ft' && available, src: 'Big Balls' };
      await cacheSet(ck, data);
      return data;
    };
    const srStats = async () => {
      if (!['ucl', 'pl', 'efl'].includes(m.l) || !Deno.env.get('SPORTRADAR_KEY')) return null;
      const sr = await srMatchFor(m, now).catch(() => null);
      return sr ? srMatchStats(sr, m, now).catch(() => null) : null;
    };
    const done = m.st === 'ft' ? await bbStats().catch(() => null) : null;
    if (done?.available) return done;
    const sr = await srStats();
    if (sr?.available) return sr;
    return done || (await bbStats().catch(() => ({ available: false })));
  }
  // Aufstellung: erst ab 90 Min. vor Anpfiff sinnvoll; nach Spielende dauerhaft. Sportradar, wo vorhanden, sonst Big Balls
  const sr = await srMatchFor(m, now).catch(() => null);
  if (!sr) return m.id.startsWith('bb-') ? bbLineup(m, now) : { available: false };
  const ck = `srlu:${sr.id}`;
  const hit = await cacheGet(ck);
  // Ältere gespeicherte Aufstellungen ohne Spieler-IDs, Rückennummern oder Nationalität: einmal neu laden
  // Fehlende Fotos (Wikidata) höchstens alle 30 Min. nachholen, nicht bei jedem Aufruf
  // Fotos fehlen: nur die Fotos nachholen (Wikidata, kein Sportradar), höchstens alle 30 Min. und 4-mal
  if (hit?.data?.available && !hit.data.imgv && hit.data.raw?.length && now - (hit.data.pt || hit.at) > 30 * 60 * 1000 && (hit.data.ptn || 0) < 4) {
    const ph = await lineupPhotos(hit.data.raw).catch(() => ({ ok: false, map: {} }));
    const d2 = { ...hit.data, pt: now, ptn: (hit.data.ptn || 0) + 1 };
    for (const t of [d2.home, d2.away]) for (const p of t?.start || []) if (ph.map[p.id]) p.img = ph.map[p.id];
    if (ph.ok) { d2.imgv = 1; delete d2.raw; }
    await cacheSet(ck, d2);
    return d2;
  }
  const noIds = hit?.data?.available && (!hit.data.home?.start?.[0]?.id || !hit.data.home?.benchNo || !hit.data.home?.benchCc) && (hit.data.n || 0) < 2;
  // Fertige Aufstellung (ab Anpfiff ändert sie sich nicht mehr) nie neu holen; sonst höchstens 8 Sportradar-Abfragen pro Spiel
  if (hit?.data?.available && Date.parse(m.utc) < now) return hit.data;
  if (hit && (hit.data.n || 0) >= 8) return hit.data.available ? hit.data : bbLineup(m, now);
  if (hit && !noIds && (hit.data.final || now - hit.at < (hit.data.available ? 3 * 3600 : 15 * 60) * 1000)) return hit.data;
  if (Date.parse(m.utc) - now > 90 * 60 * 1000) return { available: false, message: 'Die Aufstellung erscheint etwa eine Stunde vor Anpfiff.' };
  if (!(await srAllowed())) return hit?.data || bbLineup(m, now);
  const d = await srGet(`sport_events/${srUrn(sr.id)}/lineups`).catch(() => null);
  // Fehler: den alten Stand (oder «nicht verfügbar») 15 Min. merken, statt jede Minute erneut zu fragen
  const n = (hit?.data?.n || 0) + 1;
  if (!d) { await cacheSet(ck, { ...(hit?.data || { available: false, message: 'Die Aufstellung ist gerade nicht verfügbar.' }), n }); return hit?.data?.available ? hit.data : bbLineup(m, now); }
  const flip = (n) => String(n || '').replace(/^(.+), (.+)$/, '$2 $1');
  const POS = { goalkeeper: 'TW', right_back: 'RV', left_back: 'LV', central_defender: 'IV', defensive_midfielder: 'DM', central_midfielder: 'ZM', right_winger: 'RA', left_winger: 'LA',
    attacking_midfielder: 'OM', striker: 'ST', right_midfielder: 'RM', left_midfielder: 'LM', midfielder: 'M', defender: 'V', forward: 'ST' };
  const team = (c) => c && { formation: c.formation?.type || '', coach: flip(c.manager?.name),
    start: (c.players || []).filter((p) => p.starter).sort((a, b) => (a.order || 0) - (b.order || 0)).map((p) => ({ id: String(p.id || '').split(':').pop(), n: flip(p.name), no: p.jersey_number ?? '', pos: POS[p.position] || POS[p.type] || '', cc: natCode(p) })),
    bench: (c.players || []).filter((p) => !p.starter).map((p) => flip(p.name)), benchIds: (c.players || []).filter((p) => !p.starter).map((p) => String(p.id || '').split(':').pop()),
    benchNo: (c.players || []).filter((p) => !p.starter).map((p) => p.jersey_number ?? ''), benchCc: (c.players || []).filter((p) => !p.starter).map(natCode) };
  const comps = d?.lineups?.competitors || [];
  const data = { available: comps.some((c) => (c.players || []).some((p) => p.starter)),
    home: team(comps.find((c) => c.qualifier === 'home')), away: team(comps.find((c) => c.qualifier === 'away')), final: m.st === 'ft', n };
  // Fotos der Startelf (Wikidata/Commons, kein Kontingent); klappt die Abfrage nicht, beim nächsten Laden nochmals versuchen
  if (data.available) {
    const ph = await lineupPhotos(comps.flatMap((c) => (c.players || []).filter((p) => p.starter))).catch(() => ({ ok: false, map: {} }));
    for (const t of [data.home, data.away]) for (const p of t?.start || []) if (ph.map[p.id]) p.img = ph.map[p.id];
    // Fotos fehlen: Spieler für den späteren Foto-Nachtrag merken (statt die Aufstellung neu zu holen)
    if (ph.ok) data.imgv = 1; else { data.pt = now; data.raw = comps.flatMap((c) => (c.players || []).filter((p) => p.starter)).map((p) => ({ id: p.id, name: p.name, date_of_birth: p.date_of_birth })); }
  }
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
// Fotos für die Aufstellung (Sportradar liefert Name + Geburtsdatum): eine Wikidata-Abfrage für alle Spieler (Fussballer mit
// diesem Geburtsdatum, Nachname passt), dann eine Commons-Abfrage für die Vorschaubilder (120 px). Ohne Treffer kein Foto.
async function lineupPhotos(players) {
  const list = players.filter((p) => /^\d{4}-\d\d-\d\d$/.test(String(p.date_of_birth || '')) && p.id);
  if (!list.length) return { ok: true, map: {} };
  const dobs = [...new Set(list.map((p) => p.date_of_birth))].map((d) => `"${d}T00:00:00Z"^^xsd:dateTime`).join(' ');
  let rows;
  try {
    rows = await sparql(`SELECT ?p ?l ?b ?img WHERE { VALUES ?b { ${dobs} } ?p wdt:P569 ?b ; wdt:P106 wd:Q937857 ; wdt:P18 ?img . ?p rdfs:label ?l . FILTER(LANG(?l) = "en") }`);
  } catch { return { ok: false, map: {} }; }
  const files = new Map();
  for (const p of list) {
    const last = plainName(String(p.name || '').split(',')[0]).split(' ').pop();
    const hits = rows.filter((r) => String(r.b.value).slice(0, 10) === p.date_of_birth && plainName(r.l.value).split(' ').includes(last));
    // Mehrdeutig (zwei verschiedene Personen): lieber kein Foto als ein falsches; mehrere Bilder derselben Person: das erste
    const people = [...new Set(hits.map((r) => r.p.value))];
    if (people.length === 1) files.set(String(p.id).split(':').pop(), decodeURIComponent(hits[0].img.value.split('/Special:FilePath/')[1] || ''));
  }
  const map = {};
  const names = [...new Set([...files.values()].filter(Boolean))];
  for (let i = 0; i < names.length; i += 40) {
    const titles = names.slice(i, i + 40).map((f) => `File:${f}`).join('|');
    const ii = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url&iiurlwidth=120&format=json&formatversion=2&titles=${encodeURIComponent(titles)}`,
      { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()).catch(() => null);
    if (!ii) return { ok: false, map };
    const norm = new Map((ii.query?.normalized || []).map((n) => [n.to, n.from]));
    for (const pg of ii.query?.pages || []) {
      const u = String(pg.imageinfo?.[0]?.thumburl || '').replace(/\?.*$/, '');
      if (!/^https:\/\/(upload|thumb)\.wikimedia\.org\//.test(u)) continue;
      const title = norm.get(pg.title) || pg.title;
      for (const [id, f] of files) if (`File:${f}` === title || `File:${f}`.replace(/_/g, ' ') === pg.title) map[id] = u;
    }
  }
  return { ok: true, map };
}
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
// Neue Spielerprofile haben einen eigenen kleinen Tageszähler: die Adresse ist öffentlich, und wer Spieler-Nummern
// durchzählt, soll nicht das Kontingent für die Live-Stände aufbrauchen
const playerAllowed = () => dailyAllowed('plcount', 100);
async function fbPlayerBb(uuid, now) {
  if (!Deno.env.get('BIGBALLS_KEY')) return { available: false };
  const ckP = `bbpl:${uuid}`, ckF = `bbpf:${uuid}`;
  let prof = await cacheGet(ckP);
  if (!prof || prof.data?.wv !== 2 || now - prof.at > 7 * 864e5) { // wv 2: Wikipedia-Suche über Name + Verein
    if (!(await playerAllowed()) || !(await bbAllowed())) { if (!prof) return { available: false, message: 'Tagesgrenze erreicht' }; }
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
        club: club0, transfers, wv: 2, career: wiki.career, img: wiki.img || (/^https:\/\/api\.bigballsdata\.com\//.test(String(P.headshot_url || '')) ? P.headshot_url : ''), };
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
    if (!(await playerAllowed()) || !(await srAllowed())) { if (!prof) return { available: false, message: 'Tagesgrenze erreicht' }; }
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
const SR_STATS_MS = 5 * 60 * 1000;
// Meldet Sportradar «Limit Exceeded» (Kontingent oder zu viele Anfragen), 30 Min. gar nicht mehr fragen – für alle
// Instanzen (el_fb_cache «srblock»). Sonst versucht jeder Minuten-Tick es erneut und verbraucht die Tagesgrenze.
let srBlockUntil = 0;
const SR_BLOCK_MS = 30 * 60 * 1000;
async function srAllowed() {
  if (Date.now() < srBlockUntil) return false;
  const b = Number((await cacheGet('srblock'))?.data) || 0;
  if (Date.now() < b) { srBlockUntil = b; return false; }
  return dailyAllowed('srcount', srDailyMax());
}
// Test-Zugang: höchstens 1 Abfrage pro Sekunde, darum nacheinander mit Abstand
let srLast = 0;
async function srGet(path, params = {}, el = '') {
  countUse('sr', path, params, el);
  const at = Math.max(Date.now(), srLast + 1100);
  srLast = at;
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
  const q = new URLSearchParams({ ...params, api_key: Deno.env.get('SPORTRADAR_KEY') || '' });
  const res = await fetch(`${srBase()}/${path}.json?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  const d = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = String(d?.message || `HTTP ${res.status}`);
    if (res.status === 429 || /limit exceeded/i.test(msg)) { srBlockUntil = Date.now() + SR_BLOCK_MS; await cacheSet('srblock', srBlockUntil).catch(() => {}); }
    throw new Error(msg);
  }
  return d;
}
// ---------- Verbrauch pro Datenelement und Liga (Big Balls, Sportradar) ----------
// Jede Abfrage wird im Speicher gezählt und am Ende jeder Anfrage in el_fb_cache «use:<Tag>» zusammengeführt (ungefähr, keine API-Kosten)
const MATCH_LG = new Map(), SEASON_LG = new Map(), USE = new Map();
const lgOfKey = (k) => FB_LEAGUES.find((l) => l.key === k || l.sr === k)?.id || Object.entries(SR_LINEUP).find(([, v]) => v === k)?.[0]
  || Object.entries(BB_TABLE).find(([, v]) => v.key === k || v.scorers === k || v.sr === k)?.[0] || '';
function useTag(src, path, params, el) {
  const m = (re) => (re.exec(path) || [])[1];
  if (src === 'bb') {
    if (path === 'matches') return ['Spielplan', lgOfKey(params.league)];
    if (path === 'scores') return [params.date ? 'Tagesliste (Endstände)' : 'Live-Feed', 'alle'];
    if (path === 'standings') return ['Tabelle', lgOfKey(params.league)];
    let id = m(/^leagues\/([^/]+)\/top-scorers/); if (id) return ['Torschützenliste', lgOfKey(id)];
    id = m(/^(?:stored\/)?matches\/([^/]+)/);
    if (id) return [/lineups$/.test(path) ? 'Aufstellung' : /statistics$/.test(path) ? 'Statistik' : 'Tore & Torschützen', MATCH_LG.get(`bb-${id}`) || ''];
    if (/^players\//.test(path)) return ['Spielerprofil', 'alle'];
    return ['Sonstiges', 'alle'];
  }
  let id = m(/^competitions\/([^/]+)\/seasons/); if (id) return ['Saison', lgOfKey(id)];
  id = m(/^seasons\/([^/]+)\/(summaries|standings|competitors)/);
  if (id) return [/standings/.test(path) ? 'Tabelle' : /competitors/.test(path) ? 'Spielerprofil' : 'Spielplan', SEASON_LG.get(id) || ''];
  if (path === 'schedules/live/timelines') return ['Live-Feed', 'alle'];
  id = m(/^sport_events\/sr:sport_event:(\d+)/);
  if (id) return [el || (/lineups$/.test(path) ? 'Aufstellung' : 'Tore & Torschützen'), MATCH_LG.get(`sr-${id}`) || ''];
  if (/^players\//.test(path)) return ['Spielerprofil', 'alle'];
  return ['Sonstiges', 'alle'];
}
function countUse(src, path, params = {}, el = '') {
  try {
    const [e, lg] = useTag(src, path, params, el);
    const k = `${src}|${e}|${lg || '?'}`;
    USE.set(k, (USE.get(k) || 0) + 1);
  } catch { /* Zählen darf nie stören */ }
}
async function flushUse() {
  if (!USE.size) return;
  const delta = new Map(USE); USE.clear();
  const ck = `use:${new Date().toISOString().slice(0, 10)}`;
  const cur = (await cacheGet(ck))?.data || {};
  for (const [k, n] of delta) cur[k] = (cur[k] || 0) + n;
  await cacheSet(ck, cur);
}
async function usageReport(now) {
  const days = [...Array(7)].map((_, i) => new Date(now - i * 864e5).toISOString().slice(0, 10));
  const out = [];
  for (const d of days) {
    const u = (await cacheGet(`use:${d}`))?.data || {};
    out.push({ day: d, bb: (await cacheGet(`bbcount:${d}`))?.data ?? null, sr: (await cacheGet(`srcount:${d}`))?.data ?? null,
      rows: Object.entries(u).map(([k, n]) => { const [src, el, lg] = k.split('|'); return { src, el, lg, n }; }).sort((a, b) => b.n - a.n) });
  }
  return { leagues: FB_LEAGUES.map((l) => ({ id: l.id, name: l.name, short: l.short, color: l.color })), max: { bb: bbDailyMax(), sr: srDailyMax() }, days: out };
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
// Wappen der Sportradar-Teams (Sportradar liefert in der Soccer API keine Bilder): Wikipedia-Vorschaubilder, 120 px.
// Englische Klubs stehen in EN_CREST weiter unten; hier nur Schweizer Klubs und englische, deren Kurzname dort nicht passt
const SR_LOGO = {
  'AFC Bournemouth': 'en/thumb/e/e5/AFC_Bournemouth_%282013%29.svg/120px-AFC_Bournemouth_%282013%29.svg.png',
  'Etoile Carouge FC': 'commons/thumb/5/55/%C3%89toile_Carouge_FC_2023_Logo.svg/120px-%C3%89toile_Carouge_FC_2023_Logo.svg.png',
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
  'Grasshopper Club Zurich': 'commons/thumb/f/ff/GC_Z%C3%BCrich_Logo.svg/120px-GC_Z%C3%BCrich_Logo.svg.png',
  'Lausanne-Sport': 'commons/thumb/0/0d/FC_Lausanne-Sport_logo.svg/120px-FC_Lausanne-Sport_logo.svg.png',
  'Neuchatel Xamax': 'en/thumb/6/6f/Neuch%C3%A2tel_Xamax_FCS_logo.svg/120px-Neuch%C3%A2tel_Xamax_FCS_logo.svg.png',
  'SC Kriens': 'en/thumb/d/d6/SC_Kriens_logo.svg/120px-SC_Kriens_logo.svg.png',
  'Servette Geneva': 'en/thumb/f/f4/Servette_FC_crest.svg/120px-Servette_FC_crest.svg.png',
  'Stade Lausanne Ouchy': 'en/thumb/0/0e/FC_Stade_Lausanne_Ouchy_logo.svg/120px-FC_Stade_Lausanne_Ouchy_logo.svg.png',
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
// Wappen der englischen Ligaklubs (Premier League bis League Two, Stand 2026/27) von Wikipedia, 120 px; Schlüssel = Name ohne FC/AFC,
// nur Buchstaben – so passt auch eine leicht andere Schreibweise von Sportradar (z. B. «Wrexham AFC», «Sheffield Wednesday FC»)
const EN_CREST = {
  accringtonstanley: 'en/thumb/b/ba/Accrington_Stanley_F.C._logo.svg/120px-Accrington_Stanley_F.C._logo.svg.png', arsenal: 'en/thumb/5/53/Arsenal_FC.svg/120px-Arsenal_FC.svg.png',
  astonvilla: 'en/thumb/9/9a/Aston_Villa_FC_new_crest.svg/120px-Aston_Villa_FC_new_crest.svg.png', barnet: 'en/thumb/a/a2/Barnet_FC.svg/120px-Barnet_FC.svg.png',
  barnsley: 'en/thumb/c/c9/Barnsley_FC.svg/120px-Barnsley_FC.svg.png', birminghamcity: 'en/thumb/6/68/Birmingham_City_FC_logo.svg/120px-Birmingham_City_FC_logo.svg.png',
  blackburnrovers: 'en/thumb/0/0f/Blackburn_Rovers.svg/120px-Blackburn_Rovers.svg.png', blackpool: 'en/thumb/d/df/Blackpool_FC_logo.svg/120px-Blackpool_FC_logo.svg.png',
  boltonwanderers: 'en/thumb/8/82/Bolton_Wanderers_FC_logo.svg/120px-Bolton_Wanderers_FC_logo.svg.png', bradfordcity: 'en/thumb/0/04/Bradford_City_AFC_crest.svg/120px-Bradford_City_AFC_crest.svg.png',
  brentford: 'en/thumb/2/2a/Brentford_FC_crest.svg/120px-Brentford_FC_crest.svg.png', brightonhovealbion: 'en/thumb/d/d0/Brighton_and_Hove_Albion_FC_crest.svg/120px-Brighton_and_Hove_Albion_FC_crest.svg.png',
  bristolcity: 'en/thumb/f/f5/Bristol_City_crest.svg/120px-Bristol_City_crest.svg.png', bristolrovers: 'en/thumb/4/47/Bristol_Rovers_F.C._logo.svg/120px-Bristol_Rovers_F.C._logo.svg.png',
  bromley: 'en/thumb/3/35/Bromley_FC_crest.svg/120px-Bromley_FC_crest.svg.png', burnley: 'en/thumb/6/6d/Burnley_FC_Logo.svg/120px-Burnley_FC_Logo.svg.png',
  burtonalbion: 'en/thumb/9/93/Burton_Albion_FC_crest.svg/120px-Burton_Albion_FC_crest.svg.png', cambridgeunited: 'en/thumb/5/57/Cambridge_United_FC_crest.svg/120px-Cambridge_United_FC_crest.svg.png',
  cardiffcity: 'en/thumb/3/3c/Cardiff_City_crest.svg/120px-Cardiff_City_crest.svg.png', charltonathletic: 'en/thumb/f/f5/Charlton_Athletic_FC_crest.svg/120px-Charlton_Athletic_FC_crest.svg.png',
  chelsea: 'en/thumb/c/cc/Chelsea_FC.svg/120px-Chelsea_FC.svg.png', cheltenhamtown: 'en/thumb/c/c3/Cheltenham_Town_F.C._logo.svg/120px-Cheltenham_Town_F.C._logo.svg.png',
  chesterfield: 'en/thumb/9/94/Chesterfield_FC_crest.svg/120px-Chesterfield_FC_crest.svg.png', colchesterunited: 'en/thumb/9/9c/Colchester_United_FC_crest.svg/120px-Colchester_United_FC_crest.svg.png',
  coventrycity: 'en/thumb/7/7b/Coventry_City_FC_crest.svg/120px-Coventry_City_FC_crest.svg.png', crawleytown: 'en/thumb/1/11/Crawley_Town_FC_crest.svg/120px-Crawley_Town_FC_crest.svg.png',
  crewealexandra: 'en/thumb/9/9d/Crewe_Alexandra.svg/120px-Crewe_Alexandra.svg.png', crystalpalace: 'en/thumb/a/a2/Crystal_Palace_FC_logo_%282022%29.svg/120px-Crystal_Palace_FC_logo_%282022%29.svg.png',
  derbycounty: 'en/thumb/4/4a/Derby_County_crest.svg/120px-Derby_County_crest.svg.png', doncasterrovers: 'en/thumb/c/c5/Doncaster_Rovers_F.C._logo.svg/120px-Doncaster_Rovers_F.C._logo.svg.png',
  everton: 'en/thumb/7/7c/Everton_FC_logo.svg/120px-Everton_FC_logo.svg.png', exetercity: 'en/thumb/7/71/Exeter_City_FC.svg/120px-Exeter_City_FC.svg.png',
  fleetwoodtown: 'en/thumb/e/ed/Fleetwood_Town_F.C._logo.svg/120px-Fleetwood_Town_F.C._logo.svg.png', fulham: 'en/thumb/e/eb/Fulham_FC_%28shield%29.svg/120px-Fulham_FC_%28shield%29.svg.png',
  gillingham: 'en/thumb/5/5e/FC_Gillingham_Logo.svg/120px-FC_Gillingham_Logo.svg.png', grimsbytown: 'en/thumb/d/db/Grimsby_Town_F.C._logo.svg/120px-Grimsby_Town_F.C._logo.svg.png',
  huddersfieldtown: 'en/thumb/4/43/Huddersfield_Town_AFC_crest.svg/120px-Huddersfield_Town_AFC_crest.svg.png', hullcity: 'en/thumb/5/54/Hull_City_A.F.C._logo.svg/120px-Hull_City_A.F.C._logo.svg.png',
  ipswichtown: 'en/thumb/4/43/Ipswich_Town.svg/120px-Ipswich_Town.svg.png', leedsunited: 'en/thumb/5/54/Leeds_United_F.C._logo.svg/120px-Leeds_United_F.C._logo.svg.png',
  leicestercity: 'en/thumb/2/2d/Leicester_City_crest.svg/120px-Leicester_City_crest.svg.png', leytonorient: 'en/thumb/a/a8/Leyton_Orient_F.C._logo.svg/120px-Leyton_Orient_F.C._logo.svg.png',
  lincolncity: 'en/thumb/3/39/Lincoln_City_FC_2024_crest.svg/120px-Lincoln_City_FC_2024_crest.svg.png', liverpool: 'en/thumb/0/0c/Liverpool_FC.svg/120px-Liverpool_FC.svg.png',
  lutontown: 'en/thumb/9/9d/Luton_Town_logo.svg/120px-Luton_Town_logo.svg.png', manchestercity: 'en/thumb/e/eb/Manchester_City_FC_badge.svg/120px-Manchester_City_FC_badge.svg.png',
  manchesterunited: 'en/thumb/7/7a/Manchester_United_FC_crest.svg/120px-Manchester_United_FC_crest.svg.png', mansfieldtown: 'en/thumb/7/7d/Mansfield_Town_FC.svg/120px-Mansfield_Town_FC.svg.png',
  middlesbrough: 'en/thumb/2/2c/Middlesbrough_FC_crest.svg/120px-Middlesbrough_FC_crest.svg.png', millwall: 'en/thumb/9/98/Millwall_FC_crest.svg/120px-Millwall_FC_crest.svg.png',
  miltonkeynesdons: 'en/thumb/e/e5/Milton_Keynes_Dons_FC_2025_crest.svg/120px-Milton_Keynes_Dons_FC_2025_crest.svg.png', newcastleunited: 'en/thumb/8/87/Newcastle_United_FC_2026_crest.svg/120px-Newcastle_United_FC_2026_crest.svg.png',
  newportcounty: 'en/thumb/4/44/Newport_County_AFC_crest.svg/120px-Newport_County_AFC_crest.svg.png', northamptontown: 'en/thumb/2/2d/Northampton_Town_F.C._logo.svg/120px-Northampton_Town_F.C._logo.svg.png',
  norwichcity: 'en/thumb/1/17/Norwich_City_FC_logo.svg/120px-Norwich_City_FC_logo.svg.png', nottinghamforest: 'en/thumb/e/e5/Nottingham_Forest_F.C._logo.svg/120px-Nottingham_Forest_F.C._logo.svg.png',
  nottscounty: 'en/thumb/2/2e/Notts_County_Logo.svg/120px-Notts_County_Logo.svg.png', oldhamathletic: 'en/thumb/a/a2/Oldham_Athletic_AFC_%28emblem%29.svg/120px-Oldham_Athletic_AFC_%28emblem%29.svg.png',
  oxfordunited: 'en/thumb/3/3e/Oxford_United_FC_logo.svg/120px-Oxford_United_FC_logo.svg.png', peterboroughunited: 'en/thumb/9/9a/Peterborough_United_FC_crest.svg/120px-Peterborough_United_FC_crest.svg.png',
  plymouthargyle: 'en/thumb/a/a8/Plymouth_Argyle_F.C._logo.svg/120px-Plymouth_Argyle_F.C._logo.svg.png', portsmouth: 'en/thumb/3/38/Portsmouth_FC_logo.svg/120px-Portsmouth_FC_logo.svg.png',
  portvale: 'en/thumb/5/5f/Port_Vale_logo.svg/120px-Port_Vale_logo.svg.png', prestonnorthend: 'en/thumb/8/82/Preston_North_End_FC.svg/120px-Preston_North_End_FC.svg.png',
  queensparkrangers: 'en/thumb/3/31/Queens_Park_Rangers_crest.svg/120px-Queens_Park_Rangers_crest.svg.png', reading: 'en/thumb/1/11/Reading_FC.svg/120px-Reading_FC.svg.png',
  rochdale: 'en/thumb/b/bb/Rochdale_AFC_crest.svg/120px-Rochdale_AFC_crest.svg.png', rotherhamunited: 'en/thumb/4/42/Rotherham_United_F.C._svg.svg/120px-Rotherham_United_F.C._svg.svg.png',
  salfordcity: 'en/thumb/7/70/Salford_City_F.C._new_logo.svg/120px-Salford_City_F.C._new_logo.svg.png', sheffieldunited: 'en/thumb/9/9c/Sheffield_United_FC_logo.svg/120px-Sheffield_United_FC_logo.svg.png',
  sheffieldwednesday: 'en/thumb/b/b8/Sheffield_Wednesday_FC_2026_crest.svg/120px-Sheffield_Wednesday_FC_2026_crest.svg.png', shrewsburytown: 'en/thumb/1/1b/Shrewsbury_Town_F.C._logo.svg/120px-Shrewsbury_Town_F.C._logo.svg.png',
  southampton: 'en/thumb/c/c9/FC_Southampton.svg/120px-FC_Southampton.svg.png', stevenage: 'en/thumb/4/49/Stevenage_FC_crest.svg/120px-Stevenage_FC_crest.svg.png',
  stockportcounty: 'en/thumb/4/43/Stockport_County_FC_logo_2020.svg/120px-Stockport_County_FC_logo_2020.svg.png', stokecity: 'en/thumb/b/bf/Stoke_City_FC_crest_2026.svg/120px-Stoke_City_FC_crest_2026.svg.png',
  sunderland: 'en/thumb/7/77/Logo_Sunderland.svg/120px-Logo_Sunderland.svg.png', swanseacity: 'en/thumb/f/f9/Swansea_City_AFC_logo.svg/120px-Swansea_City_AFC_logo.svg.png',
  swindontown: 'en/thumb/a/a3/Swindon_Town_FC.svg/120px-Swindon_Town_FC.svg.png', tottenhamhotspur: 'en/thumb/b/b4/Tottenham_Hotspur.svg/120px-Tottenham_Hotspur.svg.png',
  tranmererovers: 'en/thumb/5/55/Tranmere_Rovers_FC_crest.svg/120px-Tranmere_Rovers_FC_crest.svg.png', walsall: 'en/thumb/e/ef/Walsall_FC.svg/120px-Walsall_FC.svg.png',
  watford: 'en/thumb/e/e2/Watford.svg/120px-Watford.svg.png', westbromwichalbion: 'en/thumb/8/8b/West_Bromwich_Albion.svg/120px-West_Bromwich_Albion.svg.png',
  westhamunited: 'en/thumb/c/c2/West_Ham_United_FC_logo.svg/120px-West_Ham_United_FC_logo.svg.png', wiganathletic: 'en/thumb/4/43/Wigan_Athletic.svg/120px-Wigan_Athletic.svg.png',
  wolverhamptonwanderers: 'en/thumb/c/c9/Wolverhampton_Wanderers_FC_crest.svg/120px-Wolverhampton_Wanderers_FC_crest.svg.png', wrexham: 'en/thumb/0/0d/Wrexham_A.F.C._Logo.svg/120px-Wrexham_A.F.C._Logo.svg.png',
  wycombewanderers: 'en/thumb/f/fb/Wycombe_Wanderers_FC_logo.svg/120px-Wycombe_Wanderers_FC_logo.svg.png', yorkcity: 'en/thumb/7/71/York_City_FC.svg/120px-York_City_FC.svg.png',
};
const EN_ALIAS = { qpr: 'queensparkrangers', westbrom: 'westbromwichalbion', sheffieldwed: 'sheffieldwednesday', mkdons: 'miltonkeynesdons',
  wolves: 'wolverhamptonwanderers', spurs: 'tottenhamhotspur', manutd: 'manchesterunited', manunited: 'manchesterunited', mancity: 'manchestercity',
  brighton: 'brightonhovealbion', brightonandhovealbion: 'brightonhovealbion', prestonne: 'prestonnorthend' };
const crestKey = (n) => String(n || '').toLowerCase().replace(/&/g, '').replace(/\b(a\.?f\.?c\.?|f\.?c\.?)(?=\W|$)/g, '').replace(/[^a-z]/g, '');
const enCrest = (n) => { const k = crestKey(n); return EN_CREST[EN_ALIAS[k] || k] || ''; };
const srLogo = (n) => { const f = SR_LOGO[n] || SR_LOGO_SHORT[n] || enCrest(n); return f ? `https://upload.wikimedia.org/wikipedia/${f}` : ''; };
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
  if (hit?.data) SEASON_LG.set(hit.data, lgOfKey(lg.key));
  if (hit && now - hit.at < 24 * 3600 * 1000) return hit.data;
  if (!(await srAllowed())) return hit?.data || null;
  const d = await srGet(`competitions/${lg.key}/seasons`);
  const today = new Date(now).toISOString().slice(0, 10);
  const list = (d?.seasons || []).filter((x) => x.start_date && x.start_date <= today).sort((a, b) => b.start_date.localeCompare(a.start_date));
  const cur = list.find((x) => !x.end_date || x.end_date >= today) || list[0];
  const id = cur?.id || null;
  if (id) { await cacheSet(ck, id); SEASON_LG.set(id, lgOfKey(lg.key)); }
  return id;
}
// Spielplan der Saison (bis 200 Spiele pro Abfrage), täglich; Fehler nur 30 Min. merken
async function srFixtures(lg, now) {
  const ck = `sr:${lg.key}`;
  const hit = await cacheGet(ck);
  // Genau 100 Spiele = mit dem alten Fehler nur die erste Seite gespeichert: neu laden
  const cut = hit?.data?.matches?.length === 100;
  if (hit && !cut && now - hit.at < (hit.data.status === 'ok' && !hit.data.stale ? 24 * 3600 * 1000 : 30 * 60 * 1000)) return hit.data;
  // Sportradar gesperrt («Limit Exceeded»): den letzten Spielplan zeigen statt einer Fehlermeldung
  if (hit?.data?.matches?.length && Date.now() < srBlockUntil) return { ...hit.data, status: 'ok', message: '', stale: true };
  try {
    const season = await srSeason(lg, now);
    if (!season) throw new Error('Keine laufende Saison gefunden');
    const all = [];
    // Sportradar liefert höchstens 100 Spiele pro Seite (limit=200 wird auf 100 gekürzt): weiterblättern bis zur letzten Seite
    let partial = false;
    for (let start = 0; start < 1000; start += 100) {
      if (!(await srAllowed())) { if (!all.length) return hit?.data || { status: 'error', message: 'Tagesgrenze für Sportradar erreicht', matches: [] }; partial = true; break; }
      const d = await srGet(`seasons/${season}/summaries`, { start: String(start), limit: '100' });
      const sums = d?.summaries || [];
      all.push(...sums.map((x) => mapSr(lg, x)));
      if (sums.length < 100) break;
    }
    // Unvollständig (Tagesgrenze mitten im Blättern): den alten Stand behalten und bald erneut versuchen
    if (partial && hit?.data?.matches?.length > all.length) return { ...hit.data, status: 'error', message: 'Spielplan unvollständig (Tagesgrenze)' };
    // Bekannte Torschützen und Schlussstände aus dem alten Stand übernehmen
    const old = new Map((hit?.data?.matches || []).map((m) => [m.id, m]));
    for (const m of all) { const o = old.get(m.id); if (o?.goals && !m.goals) m.goals = o.goals; }
    const data = { status: all.length ? 'ok' : 'error', message: all.length ? '' : 'Kein Spielplan erhalten', matches: all };
    await cacheSet(ck, data);
    return data;
  } catch (err) {
    // Fehler (z. B. «Limit Exceeded»): mit vorhandenem Spielplan weiterarbeiten, in 30 Min. erneut versuchen
    const old = hit?.data?.matches || [];
    const data = old.length ? { ...hit.data, status: 'ok', message: '', stale: true, matches: old }
      : { status: 'error', message: 'Zurzeit keine Daten', matches: [] };
    await cacheSet(ck, data);
    return data;
  }
}
// Live-Timelines aller laufenden Spiele weltweit (eine Abfrage): Stand, Minute und Tore
async function srLive(now, kickoffRefresh = false) {
  const ck = 'srlive';
  const hit = await cacheGet(ck);
  if (hit && now - hit.at < SR_LIVE_MS && !kickoffRefresh) return hit.data;
  if (kickoffRefresh) {
    const mk = `srlivekick:${Math.floor(now / 60000)}`;
    if ((await cacheGet(mk))?.data) return hit?.data || null;
    await cacheSet(mk, true);
  }
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
  // Ebenso nach dem Abpfiff, solange Sportradar das Spiel noch nicht abgeschlossen hat («ended» statt «closed»)
  // Ab 2½ Std. nach Anpfiff nur noch stündlich, ab 4 Std. gar nicht mehr (Resultat steht; Sportradar schliesst Spiele teils
  // erst Stunden später ab) – vorher fragte die Funktion bis 12 Std. lang alle 7 Min. nach. Höchstens 30 Abfragen pro Spiel
  const ko = Date.parse(hit?.data?.ko || '') || 0;
  if (hit && ((ko && now - ko > 4 * 3600e3) || (hit.data.n || 0) >= 30)) return hit.data;
  const quiet = hit && (['pre', 'off'].includes(srState(hit.data.es)) || hit.data.es?.status === 'ended' || hit.data.err || (ko && now - ko > 150 * 60 * 1000));
  if (hit && (hit.data.final || now - hit.at < (quiet ? 60 * 60 * 1000 : SR_LIVE_MS))) return hit.data;
  if (!Deno.env.get('SPORTRADAR_KEY') || !(await srAllowed())) return hit?.data || null;
  let d;
  try { d = await srGet(`sport_events/${srUrn(id)}/timeline`); }
  catch (err) { await cacheSet(ck, { ...(hit?.data || { goals: [], final: false, es: {} }), err: 1, n: (hit?.data?.n || 0) + 1 }); throw err; } // Fehler: 1 Std. Ruhe
  const es = d?.sport_event_status || {};
  const data = { goals: srGoals(d?.timeline), final: srState(es) === 'ft', es, ko: d?.sport_event?.start_time || hit?.data?.ko || '', n: (hit?.data?.n || 0) + 1 };
  await cacheSet(ck, data);
  return data;
}
// Live-Teamstatistik aus derselben Sportradar-Timeline wie Tore und Spielereignisse.
async function srMatchStats(sr, match, now) {
  const ck = `srstats:${sr.id}`;
  const hit = await cacheGet(ck);
  if (hit && (hit.data.final || now - hit.at < SR_STATS_MS)) return hit.data;
  if (match.st === 'pre') return { available: false, final: false, message: 'Die Live-Statistik erscheint nach Anpfiff.', src: 'Sportradar' };
  if (!Deno.env.get('SPORTRADAR_KEY') || !(await srAllowed())) return hit?.data || { available: false, final: false, src: 'Sportradar' };
  const d = await srGet(`sport_events/${srUrn(sr.id)}/timeline`, {}, 'Statistik');
  const teams = d?.statistics?.totals?.competitors || d?.statistics?.competitors || [];
  const raw = (qualifier) => teams.find((x) => x.qualifier === qualifier)?.statistics || null;
  const side = (x) => x && ({
    poss: num(x.ball_possession), shots: num(x.shots_total), on: num(x.shots_on_target), corners: num(x.corner_kicks),
    fouls: num(x.fouls), yellow: num(x.yellow_cards), red: x.red_cards == null && x.yellow_red_cards == null ? null : (num(x.red_cards) || 0) + (num(x.yellow_red_cards) || 0),
    passes: num(x.passes_total), acc: num(x.passes_successful), saves: num(x.shots_saved), offsides: num(x.offsides),
  });
  const home = side(raw('home')), away = side(raw('away'));
  const available = !!home && !!away && Object.keys(home).some((key) => home[key] != null && away[key] != null);
  const data = { available, home, away, final: match.st === 'ft' && available, src: 'Sportradar' };
  await cacheSet(ck, data);
  return data;
}
async function srLeagues(list, now) {
  if (!Deno.env.get('SPORTRADAR_KEY')) return list.map(() => ({ status: 'nokey', message: 'Sportradar-Schlüssel fehlt', matches: [] }));
  const res = [];
  for (const lg of list) res.push(await srFixtures(lg, now)); // nacheinander (1 Abfrage/Sek.)
  list.forEach((lg, i) => { for (const m of res[i].matches || []) MATCH_LG.set(m.id, lg.id); });
  const open = (m) => m.st !== 'ft' && m.st !== 'off' && Date.parse(m.utc) <= now && now - Date.parse(m.utc) < 12 * 3600e3;
  if (!res.some((r) => r.matches.some(open))) return res;
  const live = res.some((r) => liveWindow(r.matches, now)) ? await srLive(now, favKickoff(res, now)) : null;
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
  const hit = await cacheGet(ck);
  // Angepfiffen, aber noch ohne Schlussresultat (OpenLigaDB trägt das Ende teils spät ein): alle 15 Min. nachfragen,
  // sonst bliebe das Spiel bis zum nächsten Tag ohne Resultat stehen
  const pending = (hit?.data?.matches || []).some((m) => m.st !== 'ft' && Date.parse(m.utc) < now && now - Date.parse(m.utc) < 12 * 3600e3);
  if (hit && now - hit.at < (liveWindow(hit.data.matches, now) ? 60 * 1000 : pending ? 15 * 60 * 1000 : 24 * 3600 * 1000)) return hit.data;
  try {
    const raw = await getJson(`https://api.openligadb.de/getmatchdata/${lg.key}/${season}`);
    const data = { status: 'ok', message: '', matches: (Array.isArray(raw) ? raw : []).map((m) => mapOldb(lg, m, now)) };
    await cacheSet(ck, data);
    return data;
  } catch {
    return hit?.data || { status: 'error', message: 'OpenLigaDB nicht erreichbar', matches: [] };
  }
}
async function fbOverview(now) {
  const season = fbSeason(new Date(now));
  const fail = () => ({ status: 'error', message: 'Fehler', matches: [] });
  const srList = FB_LEAGUES.filter((lg) => lg.src === 'sr'), bbList = FB_LEAGUES.filter((lg) => lg.src === 'bb'), glList = FB_LEAGUES.filter((lg) => lg.src === 'goal');
  const [other, srRes, bbRes] = await Promise.all([
    Promise.all(FB_LEAGUES.map((lg) => (lg.src === 'oldb' ? oldbLeague(lg, season, now) : lg.src === 'goal' ? goalLeague(lg, now) : null)).map((p) => p && p.catch(fail))),
    srList.length ? srLeagues(srList, now).catch(() => srList.map(fail)) : [],
    bbList.length ? bbLeagues(bbList, now).catch(() => bbList.map(fail)) : [],
  ]);
  const res = FB_LEAGUES.map((lg, i) => (lg.src === 'sr' ? srRes[srList.indexOf(lg)] : lg.src === 'bb' ? bbRes[bbList.indexOf(lg)] : other[i]));
  void glList;
  const from = now - 14 * 864e5, to = now + 15 * 864e5;
  // Ein Wappen pro Klub über alle Ligen (z. B. Liverpool in Premier League und Champions League):
  // zuerst Sportradar-Ligen (Wikipedia, scharf), dann Bundesligen, zuletzt Champions League
  // Gespeicherte Sportradar-Spielpläne von früher: Namen kürzen und Wappen nachtragen
  FB_LEAGUES.forEach((lg, i) => { if (lg.src === 'sr') for (const m of res[i].matches || []) { m.hl = m.hl || srLogo(m.h); m.al = m.al || srLogo(m.a); m.h = srName(m.h); m.a = srName(m.a); } });
  const crest = new Map();
  const rank = (lg) => (lg.src === 'sr' || lg.src === 'goal' ? 0 : lg.id === 'ucl' ? 2 : 1);
  [...FB_LEAGUES.keys()].sort((a, b) => rank(FB_LEAGUES[a]) - rank(FB_LEAGUES[b])).forEach((i) => {
    for (const m of res[i].matches || []) {
      if (m.hl && !crest.has(m.h)) crest.set(m.h, m.hl);
      if (m.al && !crest.has(m.a)) crest.set(m.a, m.al);
    }
  });
  for (const r of res) for (const m of r.matches || []) { m.hl = crest.get(m.h) || m.hl; m.al = crest.get(m.a) || m.al; }
  FB_LEAGUES.forEach((lg, i) => { for (const m of res[i].matches || []) MATCH_LG.set(m.id, lg.id); });
  return { updated: new Date(now).toISOString(), season, paused: now - bbPausedAt < 15 * 60 * 1000,
    leagues: FB_LEAGUES.map((lg, i) => ({ id: lg.id, name: lg.name, country: lg.country, short: lg.short, color: lg.color, status: res[i].status, message: res[i].message })),
    matches: res.flatMap((r) => r.matches.filter((m) => { const t = Date.parse(m.utc); return t >= from && t <= to; })) };
}
// Vor dem Anpfiff Aufstellungen vorwärmen; nach Spielende Statistiken und nach dem letzten Tages-Spiel Tabellen vorwärmen.
async function refreshAroundMatches(now, ov, favs = new Set()) {
  const matches = ov.matches || [];
  const favMatch = (m) => favs.has(String(m.h).toLowerCase()) || favs.has(String(m.a).toLowerCase());
  const today = zurichDay(new Date(now).toISOString());
  const yesterday = zurichDay(new Date(now - 864e5).toISOString());
  const refreshed = { lineups: 0, stats: 0, tables: 0, scorers: 0 };

  for (const m of matches) {
    if (!DETAIL_LEAGUES.has(m.l) || m.st === 'ft' || m.st === 'off') continue;
    const kickoff = Date.parse(m.utc);
    if (kickoff - now > 90 * 60 * 1000 || now - kickoff > 130 * 60 * 1000 || !favMatch(m)) continue;
    await fbDetail(m.id, 'lineup', now, ov).catch(() => null);
    refreshed.lineups++;
  }

  for (const m of matches) {
    if (!DETAIL_LEAGUES.has(m.l) || !m.id.startsWith('bb-') || m.st !== 'ft' || now - Date.parse(m.utc) > 8 * 3600e3 || !favMatch(m)) continue;
    const uuid = m.id.replace(/^bb-/, '');
    const cached = await cacheGet(`bbst:${uuid}`);
    if (cached?.data?.final) continue;
    await fbDetail(m.id, 'stats', now, ov).catch(() => null);
    refreshed.stats++;
  }

  for (const day of [yesterday, today]) {
    for (const id of Object.keys(BB_TABLE)) {
      const dayMatches = matches.filter((m) => m.l === id && zurichDay(m.utc) === day);
      if (!dayMatches.length || !dayMatches.some((m) => m.st === 'ft') || dayMatches.some((m) => !['ft', 'off'].includes(m.st))) continue;
      const tableDoneKey = `fbtable_done:${id}:${day}`;
      const scorerDoneKey = `fbscorer_done:${id}:${day}`;
      const tableDone = Boolean((await cacheGet(tableDoneKey))?.data);
      const scorerDone = Boolean((await cacheGet(scorerDoneKey))?.data);
      if (tableDone && scorerDone) continue;
      const attemptKey = `fbboardattempt:${id}:${day}`;
      const attempt = await cacheGet(attemptKey);
      if (attempt && now - attempt.at < 15 * 60 * 1000) continue;
      await cacheSet(attemptKey, true);
      if (!tableDone) {
        // Alte Tabelle merken, neue holen und prüfen, ob die Resultate seit dem alten Stand drin sind (ein Spiel mehr bei beiden Teams).
        // Fehlt etwas (Quelle trägt Resultate erst später ein): die Spiel-IDs als «missing» mitgeben – die Seite rechnet sie selbst ein –
        // und in 15 Min. nochmals holen, höchstens 8-mal; danach bleibt «missing» bis zur nächsten Tabelle
        const ck = BB_TABLE[id].goal ? `gltab:${BB_TABLE[id].goal}` : BB_TABLE[id].sr ? `srtab:${BB_TABLE[id].sr}` : `bbtab:${BB_TABLE[id].key}`;
        const old = (await cacheGet(ck))?.data;
        const table = await fbLeague(id, 'table', now, true).catch(() => ({ available: false }));
        if (table.available) {
          const oldAt = Date.parse(old?.asOf || '') || 0;
          const row = (rows, n) => { const k = teamKey(n); return (rows || []).find((r) => teamKey(r.team) === k) || (rows || []).find((r) => { const t = teamKey(r.team); return k.length >= 5 && (t.startsWith(k.slice(0, 6)) || k.startsWith(t.slice(0, 6))); }); };
          const missing = old?.available ? dayMatches.filter((m) => m.st === 'ft' && Date.parse(m.utc) + 115 * 60 * 1000 > oldAt).filter((m) => {
            const oh = row(old.rows, m.h), oa = row(old.rows, m.a), nh = row(table.rows, m.h), na = row(table.rows, m.a);
            return oh && oa && nh && na && (nh.p <= oh.p || na.p <= oa.p);
          }).map((m) => m.id) : [];
          const tries = Number((await cacheGet(`fbtable_try:${id}:${day}`))?.data || 0) + 1;
          await cacheSet(`fbtable_try:${id}:${day}`, tries);
          await cacheSet(ck, { ...table, missing });
          if (!missing.length || tries >= 8) { await cacheSet(tableDoneKey, true); refreshed.tables++; }
        }
      }
      if (!scorerDone) {
        const scorers = await fbLeague(id, 'scorers', now, true).catch(() => ({ available: false }));
        if (scorers.available) { await cacheSet(scorerDoneKey, true); refreshed.scorers++; }
      }
    }
  }
  return refreshed;
}
async function fbGame(id) {
  if (/^bb-[\w-]+$/.test(String(id))) return bbGame(id);
  if (/^sr-\d+$/.test(String(id))) { const t = await srTimeline(String(id)); return { goals: t?.goals || [], final: !!t?.final }; }
  if (/^gl-[a-z0-9]+$/.test(String(id))) return goalGame(String(id));
  throw new Error('ungültig');
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
// Secrets bereinigen: Leerzeichen, Zeilenumbrüche, Anführungszeichen und «=» am Ende entfernen, base64 → base64url
const vapidClean = (v) => String(v || '').replace(/[\s"'`]/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const vapidPub = () => vapidClean(Deno.env.get('VAPID_PUBLIC'));
async function vapidJwt(aud) {
  const pubS = vapidPub(), d = vapidClean(Deno.env.get('VAPID_PRIVATE'));
  if (!/^[\w-]{86,88}$/.test(pubS)) throw new Error(`VAPID_PUBLIC ungültig (${pubS.length} Zeichen, erwartet 87)`);
  if (!/^[\w-]{43}$/.test(d)) throw new Error(`VAPID_PRIVATE ungültig (${d.length} Zeichen, erwartet 43)`);
  const pub = unb64u(pubS);
  vapidKey ||= await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: Deno.env.get('VAPID_SUBJECT') || 'https://ccodel9876.github.io/euroleague/' })}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64u(sig)}`;
}
// Leere Push-Nachricht an ein Gerät; 404/410 = Anmeldung ungültig (wird gelöscht)
async function pushPing(endpoint, detail = false) {
  const aud = new URL(endpoint).origin;
  const res = await fetch(endpoint, { method: 'POST', headers: { Authorization: `vapid t=${await vapidJwt(aud)}, k=${vapidPub()}`, TTL: '1800', Urgency: 'high', 'Content-Length': '0' },
    signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (detail) return `${res.status}${res.ok ? '' : ` ${(await res.text().catch(() => '')).slice(0, 120)}`}`;
  return res.status;
}
const PUSH_URL = `${SUPABASE_URL}/rest/v1/el_fb_push`, PROFILES_URL = `${SUPABASE_URL}/rest/v1/el_profiles`;
async function pushProfile(name, pin) {
  const key = String(name || '').trim().slice(0, 40).toLowerCase();
  if (!key || !/^\d{4,8}$/.test(String(pin || ''))) return null;
  const r = await fetch(`${PROFILES_URL}?key=eq.${encodeURIComponent(key)}&select=key,pin_hash`, { headers: serviceHeaders() });
  const row = r.ok ? (await r.json())[0] : null;
  if (!row) return null;
  // Sperre gegen Durchprobieren, gleicher Zähler wie in der Funktion euroleague (pinGuard): 5 falsche PINs = 15 Min. gesperrt
  const fk = `pinfail:${key}`, f = (await cacheGet(fk))?.data;
  if (f?.until > Date.now()) return null;
  if (sameString(await sha256Hex(`${pin}:${key}`), row.pin_hash)) return key;
  const n = (f?.n || 0) + 1;
  await cacheSet(fk, n >= 5 ? { n: 0, until: Date.now() + 15 * 60 * 1000 } : { n, until: 0 });
  return null;
}
// Nur die Push-Dienste der Browser (Apple, Google, Mozilla, Microsoft): sonst liesse sich die Funktion als Absender an fremde Adressen missbrauchen
const PUSH_HOST = /^https:\/\/(fcm\.googleapis\.com|[\w-]+\.push\.apple\.com|[\w.-]+\.push\.services\.mozilla\.com|[\w.-]+\.notify\.windows\.com)\//;
async function handlePush(body) {
  const endpoint = String(body?.endpoint || '');
  if (body.kind !== 'push-test' && (!PUSH_HOST.test(endpoint) || endpoint.length > 1000)) return { ok: false, error: 'ungültig' };
  if (body.kind === 'push-test') {
    // Testmeldung an alle Geräte des Profils (Name + PIN nötig)
    const key = await pushProfile(body.name, body.pin);
    if (!key) return { ok: false, error: 'profil' };
    const subs = await fetch(`${PUSH_URL}?profile_key=eq.${encodeURIComponent(key)}&select=endpoint`, { headers: serviceHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    // 10 Sek. warten, damit man das Handy sperren kann (bei offener App zeigt iOS oft kein Banner)
    await new Promise((r) => setTimeout(r, 10000));
    const now = Date.now(), res = [];
    for (const s of subs) {
      const hash = await sha256Hex(s.endpoint);
      const old = (await cacheGet(`pushmsg:${hash}`))?.data || [];
      await cacheSet(`pushmsg:${hash}`, [...old.filter((x) => now - x.at < 30 * 60 * 1000), { id: '', tag: `test-${now}`, at: now, title: '⚽ Testmeldung', body: 'So sieht eine Tor-Mitteilung aus: FC Basel 1:0 FC Lugano · 18\'' }].slice(-10));
      res.push(await pushPing(s.endpoint, true).catch((e) => `Fehler: ${String(e?.message || e).slice(0, 120)}`));
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
// ---------- EuroLeague-Mitteilungen: Viertelstände und Endresultat der Lieblingsteams ----------
// Läuft im selben Minutentakt wie die Tor-Mitteilungen und nutzt dieselben Abos (el_fb_push). Die Stände kommen von der
// Funktion «euroleague» (Übersicht; Spielbericht nur für die Viertelsummen). Ohne Spiel eines Lieblingsteams schläft
// die Abfrage bis kurz vor dem nächsten Anpfiff (Zustand in el_fb_cache, Schlüssel «elpush»).
const EL_FN = `${SUPABASE_URL}/functions/v1/euroleague`;
async function elJson(q = '') {
  const r = await fetch(`${EL_FN}${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`euroleague ${r.status}`);
  return r.json();
}
// Ein Spiel und sein gemerkter Zustand → neuer Zustand und höchstens ein Ereignis ({ kind: 'q', q } Viertel zu Ende,
// { kind: 'ot' } Verlängerung, { kind: 'final' } Schluss – den bestätigt der Aufrufer). st: { q: gemeldete Viertel
// (-1 = noch unbekannt), ot, p: Pause schon geprüft, final, at }. pauseQ: gespielte Viertel laut Spielbericht, falls
// die Übersicht in einer Pause kein Viertel nennt. Erst mitten im Spiel entdeckt: nichts nachmelden.
export function elDetect(g, st, pauseQ = 0) {
  const n = Number((/\d+/.exec(g.period || '') || [])[0]) || 0;
  if (g.status === 'live') {
    if (!st) return { st: { q: n ? n - 1 : -1, ot: n > 4, at: Date.parse(g.utc) }, ev: null };
    st = { ...st };
    const some = (g.hs || 0) + (g.as || 0) > 0;
    if (!n) {
      if (!pauseQ) return { st, ev: null };
      st.p = true;
      if (st.q >= 0 && pauseQ > st.q && pauseQ <= 3 && some) { st.q = pauseQ; return { st, ev: { kind: 'q', q: pauseQ, exact: true } }; }
      if (pauseQ > st.q) st.q = pauseQ;
      return { st, ev: null };
    }
    st.p = false;
    if (st.q < 0) { st.q = n - 1; st.ot = n > 4; return { st, ev: null }; }
    if (n > 4) { if (st.ot) return { st, ev: null }; st.ot = true; st.q = 4; return { st, ev: { kind: 'ot' } }; }
    const exact = g.clock === '00:00', doneQ = exact ? n : n - 1;
    if (doneQ > st.q && doneQ <= 3 && some) { st.q = doneQ; return { st, ev: { kind: 'q', q: doneQ, exact } }; }
    if (doneQ > st.q) st.q = doneQ;
    return { st, ev: null };
  }
  if (g.status === 'final' && st && !st.final) return { st: { ...st }, ev: { kind: 'final' } };
  return { st, ev: null };
}
// Text der Mitteilung für ein Abo (f = seine Lieblingsteams): Sieg und Führung klingen anders als Niederlage und Rückstand
export function elMessage(e, f, nm, now) {
  const { g } = e, both = f.has(g.home) && f.has(g.away), my = f.has(g.home) ? g.home : g.away;
  const mine = my === g.home ? e.hs : e.as, opp = my === g.home ? e.as : e.hs, lead = e.hs > e.as ? g.home : g.away;
  const score = `${nm(g.home)} ${e.hs}:${e.as} ${nm(g.away)}`;
  const when = e.q === 2 ? 'zur Halbzeit' : `nach dem ${e.q}. Viertel`;
  let title;
  if (e.kind === 'ot') title = '⏱️ Verlängerung!';
  else if (e.kind === 'final') title = both ? `🏀 Schluss: Sieg für ${nm(lead)}` : mine > opp ? `🏀 Vamooooos! Sieg für ${nm(my)}` : `😤 Niederlage für ${nm(my)}`;
  else if (mine === opp) title = `🏀 Gleichstand ${when}`;
  else if (both) title = `🏀 ${nm(lead)} führt ${when}`;
  else title = mine > opp ? `🏀 ${nm(my)} führt ${when}` : `⚠️ ${nm(my)} liegt ${when} zurück`;
  return { id: `el-${g.code}`, kind: 'el', tag: `el-${g.code}-${e.kind}${e.q || ''}`, at: now, url: `basketball/euroleague/?game=${g.code}`,
    title, body: e.kind === 'final' ? `Endstand: ${score}` : score };
}
async function elPushTick(now, subs, profs) {
  if (!subs.length) return { skip: 'keine Abos' };
  const fav = new Map(profs.map((p) => [p.key, new Set((Array.isArray(p.favorites) ? p.favorites : []).map(String))]));
  const favs = new Set([...fav.values()].flatMap((x) => [...x]));
  if (!favs.size) return { skip: 'keine Teams' };
  const state = (await cacheGet('elpush'))?.data || { sleep: 0, games: {} };
  // Geänderte Lieblingsteams wecken sofort (sonst merkt der Tick ein neues Team erst beim nächsten Aufwachen, bis 3 Std.)
  const favKey = [...favs].sort().join('|');
  if (now < state.sleep && state.favs === favKey) return { sleep: new Date(state.sleep).toISOString() };
  const ov = await elJson();
  const mine = (ov.games || []).filter((g) => favs.has(g.home) || favs.has(g.away));
  const games = {}, events = [];
  const qsum = (box, i, k) => (box?.quarters?.[i] || []).slice(0, k).reduce((x, v) => x + (v || 0), 0);
  for (const g of mine) {
    const code = String(g.code), old = state.games?.[code];
    if (!old && g.status !== 'live') continue;
    let box = null, pauseQ = 0;
    // Pause ohne Viertel in der Übersicht: einmal pro Pause im Spielbericht nachzählen, wie viele Viertel gespielt sind
    if (g.status === 'live' && old && !old.p && !/\d/.test(g.period || '') && g.clock === '00:00' && g.hs + g.as > 0) {
      box = await elJson(`?game=${g.code}`).catch(() => null);
      const qs = box?.quarters || [];
      while (pauseQ < 4 && ((qs[0]?.[pauseQ] || 0) + (qs[1]?.[pauseQ] || 0)) > 0) pauseQ++;
    }
    let { st, ev } = elDetect(g, old, pauseQ);
    let hs = g.hs, as = g.as;
    if (ev?.kind === 'q' && !ev.exact) {
      // Das nächste Viertel läuft schon: Stand am Viertelende aus den Viertelsummen
      box = await elJson(`?game=${g.code}`).catch(() => null);
      const a = qsum(box, 0, ev.q), b = qsum(box, 1, ev.q);
      if (a + b > 0 && a <= g.hs && b <= g.as) { hs = a; as = b; }
    }
    if (ev?.kind === 'final') {
      // Schluss erst melden, wenn der Spielbericht ein gespieltes 4. Viertel zeigt und nicht mehr läuft (höchstens 15 Min. warten)
      box = await elJson(`?game=${g.code}`).catch(() => null);
      st.tries = (st.tries || 0) + 1;
      if (!(box && !box.live && qsum(box, 0, 4) + qsum(box, 1, 4) > qsum(box, 0, 3) + qsum(box, 1, 3)) && st.tries < 15) ev = null;
      else st.final = true;
    }
    if (ev) events.push({ g, kind: ev.kind, q: ev.q, hs, as });
    if (now - (st.at || 0) < 30 * 3600e3) games[code] = st;
  }
  // Nichts los: bis 5 Min. vor dem nächsten Spiel eines Lieblingsteams schlafen (höchstens 3 Std., falls der Spielplan ändert)
  const t = (g) => Date.parse(g.utc);
  const busy = mine.some((g) => g.status === 'live' || (games[g.code] && !games[g.code].final && now - t(g) < 5 * 3600e3)
    || (g.status === 'pre' && t(g) - now < 6 * 60 * 1000 && now - t(g) < 4 * 3600e3));
  const next = Math.min(...mine.filter((g) => g.status === 'pre' && t(g) > now).map(t));
  await cacheSet('elpush', { sleep: busy ? 0 : Math.min(Number.isFinite(next) ? next - 5 * 60 * 1000 : Infinity, now + 3 * 3600e3), games, favs: favKey });
  if (!events.length) return { events: 0, live: busy };
  const nm = (c) => ov.teams?.[c]?.short || ov.teams?.[c]?.name || c;
  let sent = 0;
  for (const s of subs) {
    const f = fav.get(s.profile_key);
    const msgs = f ? events.filter((e) => f.has(e.g.home) || f.has(e.g.away)).map((e) => elMessage(e, f, nm, now)) : [];
    if (!msgs.length) continue;
    const hash = await sha256Hex(s.endpoint);
    const old = (await cacheGet(`pushmsg:${hash}`))?.data || [];
    await cacheSet(`pushmsg:${hash}`, [...old.filter((x) => now - x.at < 30 * 60 * 1000), ...msgs].slice(-10));
    const st = await pushPing(s.endpoint).catch(() => 0);
    if (st >= 200 && st < 300) sent++;
  }
  return { events: events.length, sent, live: busy };
}
// Jede Minute: Cache-Zeitplan ausführen und Tore seit dem letzten Lauf für Push erkennen
async function pushTick(now, again = false) {
  // Abos und ihre Lieblingsteams zuerst (nur eigene Datenbank, kein API-Kontingent): bestimmen, was vorgewärmt wird und wie oft live
  const subs = Deno.env.get('VAPID_PRIVATE') ? await fetch(`${PUSH_URL}?select=endpoint,profile_key`, { headers: serviceHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []) : [];
  const keys = [...new Set(subs.map((x) => x.profile_key))];
  const profs = keys.length ? await fetch(`${PROFILES_URL}?key=in.(${keys.map((k) => `"${String(k).replace(/"/g, '')}"`).join(',')})&select=key,fb_favorites,favorites`, { headers: serviceHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => []) : [];
  const fav = new Map(profs.map((p) => [p.key, new Set((Array.isArray(p.fb_favorites) ? p.fb_favorites : []).map((n) => String(n).toLowerCase()))]));
  const favs = new Set([...fav.values()].flatMap((x) => [...x]));
  // EuroLeague zuerst und unabhängig vom Fussball: ein Fehler dort hält die Tor-Mitteilungen nicht auf
  const el = again ? null : await elPushTick(now, subs, profs).catch((e) => ({ error: String(e?.message || e).slice(0, 80) }));
  // Läuft ein EuroLeague-Spiel eines Lieblingsteams: nach 30 Sekunden im Hintergrund ein zweites Mal prüfen, so kommen die
  // Viertel-Mitteilungen etwa eine halbe Minute schneller, ohne den Zeitplan (jede Minute) zu ändern. Die Funktion
  // «euroleague» hält Live-Stände 20 Sekunden, der zweite Durchlauf sieht also einen neuen Stand.
  if (!again && el?.live && globalThis.EdgeRuntime?.waitUntil) {
    globalThis.EdgeRuntime.waitUntil(new Promise((r) => setTimeout(r, 30 * 1000)).then(() => elPushTick(Date.now(), subs, profs)).catch(() => {}));
  }
  // Fussball-Teil wie die EuroLeague: schläft bis 100 Minuten vor dem nächsten Spiel eines Lieblingsteams (Aufstellung ab
  // 90 Min. vorher), dann jede Minute bis 2½ Std. nach Anpfiff bzw. Spielende. Spätestens alle 3 Std. kurz aufwachen
  // (verschobene Anstosszeiten). Ändern sich die Lieblingsteams, sofort aufwachen. Wer die Seite offen hat, holt seine
  // Daten selbst; Tabellen fremder Ligen werden dann beim Öffnen frisch geholt statt vorgewärmt.
  const favKey = [...favs].sort().join('|');
  const gate = (await cacheGet('fbtick'))?.data;
  if (!again && gate?.next && now < gate.next && gate.favs === favKey) return { el, wait: new Date(gate.next).toISOString() };
  liveFavs = favs;
  const viewer = await cacheGet('fbview');
  const cached = (await cacheGet('fbov:last'))?.data?.matches || [];
  liveEager = Boolean(viewer && now - viewer.at < 10 * 60 * 1000) || cached.some((m) => (m.st === 'live' || m.st === 'ht') && (favs.has(String(m.h).toLowerCase()) || favs.has(String(m.a).toLowerCase())));
  const ov = await fbOverview(now);
  await cacheSet('fbov:last', { matches: ov.matches.filter((m) => m.st === 'live' || m.st === 'ht').map((m) => ({ h: m.h, a: m.a, st: m.st })) });
  const isFav = (m) => favs.has(String(m.h).toLowerCase()) || favs.has(String(m.a).toLowerCase());
  const busy = ov.matches.some((m) => isFav(m) && (m.st === 'live' || m.st === 'ht'
    || (m.st === 'pre' && Date.parse(m.utc) - now < 100 * 60 * 1000 && now - Date.parse(m.utc) < 3 * 3600e3)
    || (m.st === 'ft' && now - Date.parse(m.utc) < 150 * 60 * 1000)));
  const nextFav = Math.min(...ov.matches.filter((m) => isFav(m) && m.st === 'pre' && Date.parse(m.utc) > now).map((m) => Date.parse(m.utc) - 100 * 60 * 1000));
  const next = busy ? 0 : Math.max(now + 60 * 1000, Math.min(now + 3 * 3600e3, nextFav));
  if (!again && (next || gate?.next || gate?.favs !== favKey)) await cacheSet('fbtick', { next, favs: favKey });
  // Premier-League-Spiel eines Lieblingsteams läuft: nach 30 Sek. im Hintergrund ein zweites Mal prüfen (wie bei der EuroLeague),
  // Tor-Mitteilungen kommen so etwa eine halbe Minute früher. FPL ist gratis; die App selbst bleibt beim Minuten-Abruf
  if (!again && globalThis.EdgeRuntime?.waitUntil && ov.matches.some((m) => m.l === 'pl' && isFav(m) && (m.st === 'live' || m.st === 'ht'))) {
    globalThis.EdgeRuntime.waitUntil(new Promise((r) => setTimeout(r, 30 * 1000)).then(() => pushTick(Date.now(), true)).catch(() => {}));
  }
  const refresh = await refreshAroundMatches(now, ov, favs);
  const prev = (await cacheGet('push:scores'))?.data || {};
  const cur = {}, events = [], scoreChanges = [];
  for (const m of ov.matches) {
    if (m.hs == null || m.as == null || !['live', 'ht', 'ft'].includes(m.st)) continue;
    const p = prev[m.id];
    // Höchster bekannter Stand: fällt eine Quelle kurz aus und zeigt einen tieferen, gäbe es später einen zweiten Push fürs selbe Tor
    cur[m.id] = p ? [Math.max(m.hs, p[0]), Math.max(m.as, p[1])] : [m.hs, m.as];
    // Nur echte Änderungen (erster Stand nach dem Anpfiff = Ausgangslage, ausser es steht schon ein Tor und das Spiel ist frisch)
    if (!p) {
      if (m.hs + m.as > 0 && m.st !== 'ft' && now - Date.parse(m.utc) < 10 * 60 * 1000) {
        events.push({ m, side: m.hs > 0 ? 1 : 2 });
        if (!m.goals?.length && /^(bb-|sr-|gl-)/.test(m.id)) scoreChanges.push(m);
      }
      continue;
    }
    if (m.hs > p[0]) events.push({ m, side: 1 });
    if (m.as > p[1]) events.push({ m, side: 2 });
    if ((m.hs !== p[0] || m.as !== p[1]) && !m.goals?.length && /^(bb-|sr-|gl-)/.test(m.id)) scoreChanges.push(m);
  }
  // Beendete Spiele nach einem Tag aus dem Vergleich nehmen
  for (const [id, v] of Object.entries(prev)) if (!cur[id] && ov.matches.some((m) => m.id === id && now - Date.parse(m.utc) < 864e5)) cur[id] = v;
  await cacheSet('push:scores', cur);
  for (const m of scoreChanges) await fbGame(m.id).catch(() => null);
  // Anpfiff, Halbzeit, Schluss bei Spielen der Lieblingsteams: aus dem Statuswechsel, den der Server ohnehin jede Minute sieht (keine
  // zusätzliche Abfrage). Je Spiel gemerkt, was schon gemeldet ist; verpasste Phasen (z. B. erst nach Schluss gesehen) nicht nachmelden
  const pst = (await cacheGet('push:st'))?.data || {}, nst = {}, phases = [];
  for (const m of ov.matches) {
    const ko = Date.parse(m.utc);
    if (!isFav(m) || now - ko > 864e5 || ko - now > 3 * 3600e3) continue;
    const p = { ...(pst[m.id] || {}) };
    const on = m.st === 'live' || m.st === 'ht';
    if ((on || m.st === 'ft') && !p.k) { p.k = 1; if (on && now - ko < 15 * 60 * 1000) phases.push({ m, ph: 'k' }); }
    // Halbzeit: die Quelle meldet «ht». FPL (Premier League) kennt keine Pause: die Minute steht ab der 45. seit 6 Min. still
    let ht = m.st === 'ht';
    if (m.st === 'live' && m.src === 'fpl') {
      const mn = Number(m.min) || 0;
      if (mn !== p.m) { p.m = mn; p.mt = now; }
      else if (mn >= 45 && mn < 50 && now - (p.mt || now) >= 6 * 60 * 1000 && now - ko < 80 * 60 * 1000) ht = true;
    }
    if (ht && !p.h && p.k) { p.h = 1; phases.push({ m, ph: 'h' }); }
    if (m.st === 'live' && !ht && (Number(m.min) || 0) > 50) p.h = 1; // zweite Halbzeit läuft: verpasste Pause nicht nachmelden
    if (m.st === 'ft' && !p.f) { p.f = 1; if (on || pst[m.id]?.k) phases.push({ m, ph: 'f' }); }
    nst[m.id] = p;
  }
  if (JSON.stringify(nst) !== JSON.stringify(pst)) await cacheSet('push:st', nst);
  // Aufstellung erschienen (vor dem Anpfiff, von refreshAroundMatches eben geladen): einmal pro Spiel melden
  const lineups = [];
  for (const m of ov.matches) {
    if (!DETAIL_LEAGUES.has(m.l) || m.st !== 'pre' || !(favs.has(m.h.toLowerCase()) || favs.has(m.a.toLowerCase()))) continue;
    const k = Date.parse(m.utc) - now;
    if (k > 90 * 60 * 1000 || k < -10 * 60 * 1000) continue;
    if ((await cacheGet(`push:lu:${m.id}`))?.data) continue;
    const d = await fbDetail(m.id, 'lineup', now, ov).catch(() => null);
    if (!d?.available || !d.home?.start?.length) continue;
    await cacheSet(`push:lu:${m.id}`, 1);
    lineups.push({ m, d });
  }
  if (!Deno.env.get('VAPID_PRIVATE')) return { el, events: 0, sent: 0, refresh };
  if (!events.length && !lineups.length && !phases.length) return { el, events: 0, sent: 0, refresh };
  if (!subs.length) return { el, events: events.length, sent: 0 };
  let sent = 0;
  const hhmm = (iso) => new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  for (const s of subs) {
    const f = fav.get(s.profile_key);
    const isMine = (m) => f && (f.has(m.h.toLowerCase()) || f.has(m.a.toLowerCase()));
    const mine = events.filter((e) => isMine(e.m));
    const luMsgs = lineups.filter((x) => isMine(x.m)).map(({ m, d }) => {
      const home = f.has(m.h.toLowerCase()), team = home ? m.h : m.a, t = home ? d.home : d.away;
      return { id: m.id, kind: 'lineup', tag: `${m.id}-lineup`, at: now, url: `fussball/?m=${encodeURIComponent(m.id)}&tab=lineup`,
        title: `📋 Aufstellung ${team}`, body: `${m.h} – ${m.a} · Anpfiff ${hhmm(m.utc)}${t?.formation ? ` · ${t.formation}` : ''}` };
    });
    const phMsgs = phases.filter((x) => isMine(x.m)).map(({ m, ph }) => {
      const favT = [m.h, m.a].find((n) => f.has(n.toLowerCase())), lg = FB_LEAGUES.find((l) => l.id === m.l)?.name || '';
      const hs = m.hs ?? 0, as = m.as ?? 0, sc = `${m.h} ${hs}:${as} ${m.a}`;
      const goals = (m.goals || []).map((g) => `${g.n}${g.m ? ` ${g.m}'` : ''}`).join(', ');
      const diff = favT === m.h ? hs - as : as - hs;
      const msg = ph === 'k' ? { title: `🟢 Anpfiff: ${m.h} – ${m.a}`, body: `${lg} · Los geht's!` }
        : ph === 'h' ? { title: `🟡 Halbzeit: ${sc}`, body: goals || 'Noch keine Tore' }
        : { title: `🔴 Schluss: ${sc}`, body: `${diff > 0 ? `Sieg für ${favT}` : diff < 0 ? `Niederlage für ${favT}` : 'Unentschieden'}${goals ? ` · ${goals}` : ''}` };
      return { id: m.id, kind: 'phase', tag: `${m.id}-${ph}`, at: now, url: `fussball/?m=${encodeURIComponent(m.id)}`, ...msg };
    });
    if (!mine.length && !luMsgs.length && !phMsgs.length) continue;
    const hash = await sha256Hex(s.endpoint);
    const old = (await cacheGet(`pushmsg:${hash}`))?.data || [];
    const msgs = mine.map(({ m, side }) => {
      const team = side === 1 ? m.h : m.a, last = (m.goals || []).filter((g) => g.s === side).at(-1);
      const scorerIsFavorite = f.has(team.toLowerCase());
      const favoriteTeam = [m.h, m.a].find((name) => f.has(name.toLowerCase()));
      return { id: m.id, tag: `${m.id}-${m.hs}-${m.as}`, at: now,
        title: scorerIsFavorite ? `⚽ Vamooooos! - Tor für ${team}` : `⚠️ Gegentor für ${favoriteTeam}`,
        body: `${m.h} ${m.hs}:${m.as} ${m.a}${last?.n ? ` · ${last.n}${last.m ? ` (${last.m}')` : ''}` : m.min ? ` · ${m.min}'` : ''}` };
    });
    await cacheSet(`pushmsg:${hash}`, [...old.filter((x) => now - x.at < 30 * 60 * 1000), ...msgs, ...luMsgs, ...phMsgs].slice(-10));
    const st = await pushPing(s.endpoint).catch(() => 0);
    if (st === 404 || st === 410) await fetch(`${PUSH_URL}?endpoint=eq.${encodeURIComponent(s.endpoint)}`, { method: 'DELETE', headers: serviceHeaders() }).catch(() => {});
    else if (st >= 200 && st < 300) sent++;
  }
  return { el, events: events.length, lineups: lineups.length, phases: phases.length, sent, refresh };
}
// Das Gerät holt nach dem Anstoss seine Meldungen ab (nur die der letzten 30 Min.); abgeholt = gelöscht, damit
// beim nächsten Anstoss nicht ältere Meldungen nochmals erscheinen
async function pushMessages(endpoint, now) {
  const hash = await sha256Hex(String(endpoint || ''));
  const ck = `pushmsg:${hash}`;
  const list = ((await cacheGet(ck))?.data || []).filter((x) => now - x.at < 30 * 60 * 1000);
  if (list.length) await cacheSet(ck, []);
  return list;
}

let lastViewMark = 0;
// ---------- API-Football (api-sports.io), Test vor dem Umbau ----------
// Secret APIFOOTBALL_KEY. ?afprobe=1 prüft Konto und ob Super League (207), Challenge League (208) und Championship (40)
// in der laufenden Saison geliefert werden. 3 Abfragen, Ergebnis 30 Min. gemerkt (die Gratisstufe hat 100 pro Tag).
const AF_BASE = 'https://v3.football.api-sports.io';
const AF_LEAGUES = [['chsl', 207, 'Super League'], ['chcl', 208, 'Challenge League'], ['efl', 40, 'Championship']];
async function afGet(path, q = {}) {
  const key = Deno.env.get('APIFOOTBALL_KEY');
  if (!key) throw new Error('Secret APIFOOTBALL_KEY fehlt');
  const res = await fetch(`${AF_BASE}/${path}?${new URLSearchParams(q)}`, { headers: { 'x-apisports-key': key }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
  const d = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return d;
}
async function afProbe() {
  const hit = await cacheGet('afprobe');
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return { ...hit.data, cached: true };
  const st = await afGet('status');
  const acc = st?.response || {};
  const year = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
  const leagues = [];
  for (const [id, lg, name] of AF_LEAGUES) {
    const d = await afGet('fixtures', { league: String(lg), season: String(year), next: '3' }).catch((e) => ({ errors: { fetch: String(e.message) } }));
    const errs = d?.errors && (Array.isArray(d.errors) ? d.errors : Object.values(d.errors));
    leagues.push({ id, name, season: year, ok: !errs?.length && (d?.response || []).length > 0, errors: errs || [],
      next: (d?.response || []).map((f) => `${f.fixture?.date?.slice(0, 16)} ${f.teams?.home?.name} – ${f.teams?.away?.name}`) });
  }
  const out = { ok: leagues.every((l) => l.ok), plan: acc.subscription?.plan || '', requests: acc.requests || null, leagues };
  await cacheSet('afprobe', out);
  return out;
}

// ---------- GOAL API: Super League und Challenge League ----------
// Saisonspielplan 1× pro Tag (Blättern à 100), heutige Spiele mit Live-Stand alle 2 Min. (Lieblingsteam spielt oder jemand
// schaut zu) bzw. alle 5 Min., Tore aus den Ereignissen. Namen und Wappen wie bisher (aus dem alten Sportradar-Stand),
// damit Lieblingsteams («FC Basel») weiter passen. Eigene Grenze GOAL_DAILY (Standard 900 von 1000).
const goalDailyMax = () => Number(Deno.env.get('GOAL_DAILY')) || 900;
const goalAllowed = () => dailyAllowed('goalcount', goalDailyMax());
const gNorm = (n) => String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\b(fc|sc|fk|ac|cs)\b/g, '').replace(/[^a-z]/g, '');
const G_ALIAS = { grasshoppers: 'gczurich', grasshopper: 'gczurich', gc: 'gczurich', neuchatelxamax: 'xamax', xamaxfcs: 'xamax', nyon: 'stadenyonnais', stadelausanneouchy: 'lausanneouchy', servettegeneve: 'servette', yverdonsport: 'yverdonsport', etoilecarouge: 'etoilecarouge' };
async function goalNames(lg) {
  // Anzeigenamen und Wappen aus dem gespeicherten Sportradar-Spielplan (bleibt erhalten), ergänzt laufend aus GOAL
  const old = (await cacheGet(`sr:${lg.sr}`))?.data?.matches || [];
  const map = new Map();
  for (const m of old) { map.set(gNorm(m.h), { n: m.h, logo: m.hl || '' }); map.set(gNorm(m.a), { n: m.a, logo: m.al || '' }); }
  return map;
}
function goalName(map, raw, badge) {
  let k = gNorm(raw); k = G_ALIAS[k] || k;
  let hit = map.get(k);
  if (!hit) for (const [nk, v] of map) if (nk.length > 3 && (nk.includes(k) || k.includes(nk))) { hit = v; break; }
  return hit ? { n: hit.n, logo: hit.logo || srLogo(hit.n) } : { n: String(raw || '').trim(), logo: '' };
}
const gInt = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function goalState(f) {
  const s = String(f.matchStatus || '').toUpperCase(), p = String(f.matchPeriod || '').toUpperCase();
  if (s === 'LIVE') return /HALF_?TIME|BREAK/.test(p) ? 'ht' : 'live';
  if (/FINISH|FT|AFTER|ENDED/.test(s)) return 'ft';
  if (/POSTP|CANC|ABAND|SUSP|DELAY/.test(s)) return 'off';
  return 'pre';
}
// Tore aus den Ereignissen (Feldnamen defensiv: GOAL nennt sie nicht vollständig in der Doku)
function goalGoals(f, events) {
  const out = [];
  for (const e of events || []) {
    const t = String(e.type || e.eventType || e.name || '').toLowerCase();
    const scorerH = e.homeScorer || e.home_scorer, scorerA = e.awayScorer || e.away_scorer;
    if (!/goal|tor/.test(t) && !scorerH && !scorerA) continue;
    if (/disallow|cancel|miss/.test(t)) continue;
    const side = scorerH ? 1 : scorerA ? 2 : (e.teamId && e.teamId === f.homeTeamId) || /home/i.test(String(e.side || e.team || '')) ? 1 : 2;
    const who = scorerH || scorerA || e.player?.name || e.playerName || e.player || '';
    const own = /own/.test(t) || /\(o\.?\s?g\.?\)|own goal/i.test(String(who)), pen = /pen/.test(t) || /\(pen/i.test(String(who));
    out.push({ m: String(e.time ?? e.minute ?? e.elapsed ?? '').replace(/'$/, ''), s: side, n: `${String(who).replace(/\s*\((o\.?\s?g\.?|pen\.?)\)\s*/i, '').trim()}${pen ? ' (Pen.)' : own ? ' (Eigentor)' : ''}` });
  }
  return out;
}
function mapGoal(lg, f, names) {
  const st = goalState(f), H = goalName(names, f.homeTeam?.name || f.homeTeamName), A = goalName(names, f.awayTeam?.name || f.awayTeamName);
  const hh = gInt(f.homeTeamHalftimeScore), ah = gInt(f.awayTeamHalftimeScore);
  const goals = goalGoals(f, f.events);
  return { id: `gl-${f.id}`, l: lg.id, utc: new Date(f.kickoffUtc).toISOString(), round: String(f.matchRound || ''), h: H.n, a: A.n, hl: H.logo, al: A.logo,
    hs: st === 'pre' ? null : gInt(f.homeTeamScore), as: st === 'pre' ? null : gInt(f.awayTeamScore), st,
    min: st === 'live' ? (f.matchExtra ? `${f.matchElapsed}+${f.matchExtra}` : f.matchElapsed ?? f.matchMinute ?? null) : null,
    ht: hh !== null && ah !== null && st !== 'pre' ? `${hh}:${ah}` : '', note: st === 'off' ? String(f.matchStatus || '') : '', ...(goals.length ? { goals } : {}) };
}
async function goalLeague(lg, now) {
  if (!Deno.env.get('GOAL_KEY')) return { status: 'nokey', message: 'GOAL-Schlüssel fehlt', matches: [] };
  const ck = `gl:${lg.key}`, hit = await cacheGet(ck), names = await goalNames(lg);
  let data = hit?.data;
  // Spielplan: 3 Wochen zurück bis 5 Wochen voraus (mehr zeigt die App nicht), 1-mal pro Tag; bei Fehlern nach 30 Min.
  // Verschiebungen am Spieltag selbst bringt die Live-Abfrage von heute mit
  if (!data || now - hit.at > (data.status === 'ok' && !data.stale ? 24 * 3600 * 1000 : 30 * 60 * 1000)) {
    try {
      const all = [], seen = new Set(), day = (ms) => new Date(ms).toISOString().slice(0, 10);
      for (let off = 0; off < 400; off += 100) {
        if (!(await goalAllowed())) throw new Error('Tagesgrenze GOAL');
        const { d } = await goalGet('/fixtures', { leagueId: lg.key, from: day(now - 21 * 864e5), to: day(now + 35 * 864e5), limit: '100', offset: String(off) });
        const list = goalList(d).filter((f) => (f.leagueId || f.league?.id) === lg.key && !seen.has(f.id));
        list.forEach((f) => seen.add(f.id)); all.push(...list);
        if (list.length < 100) break;
      }
      const old = new Map((data?.matches || []).map((m) => [m.id, m]));
      const matches = all.map((f) => mapGoal(lg, f, names)).map((m) => (old.get(m.id)?.goals && !m.goals ? { ...m, goals: old.get(m.id).goals } : m));
      data = { status: matches.length ? 'ok' : 'error', message: matches.length ? '' : 'Kein Spielplan erhalten', matches };
      await cacheSet(ck, data);
    } catch (err) {
      data = data?.matches?.length ? { ...data, status: 'ok', message: '', stale: true } : { status: 'error', message: 'Zurzeit keine Daten', matches: [] };
      await cacheSet(ck, data);
    }
  }
  // Heute: Live-Stand und Tore, solange ein Spiel läuft oder bald beginnt
  if (liveWindow(data.matches, now)) {
    const lk = `gllive:${lg.key}`, lh = await cacheGet(lk);
    // Spiel eines Lieblingsteams: jede Minute (55 Sek., damit der Minuten-Takt des Zeitplans nicht knapp danebenliegt);
    // sonst 2 Min., solange jemand zuschaut, oder 5 Min.
    const ttl = data.matches.some((m) => isFavGame(m, now)) ? 55 * 1000 : liveEager ? 2 * 60 * 1000 : 5 * 60 * 1000;
    let today = lh?.data;
    if (!lh || now - lh.at > ttl) {
      try {
        if (!(await goalAllowed())) throw new Error('Tagesgrenze GOAL');
        const day = new Date(now).toISOString().slice(0, 10);
        const { d } = await goalGet('/fixtures', { leagueId: lg.key, from: day, to: day, limit: '50' });
        today = goalList(d).filter((f) => f.leagueId === lg.key || f.league?.id === lg.key).map((f) => mapGoal(lg, f, names));
        await cacheSet(lk, today);
      } catch { today = lh?.data || []; }
    }
    const byId = new Map((today || []).map((m) => [m.id, m]));
    let changed = false;
    data = { ...data, matches: data.matches.map((m) => { const t = byId.get(m.id); if (!t) return m; if (t.st === 'ft' && m.st !== 'ft') changed = true; return { ...m, ...t, goals: t.goals || m.goals }; }) };
    if (changed) await cacheSet(ck, data);
  }
  // Torschützen: kommen nicht mit dem Spielplan. Laufende und in den letzten 3 Tagen beendete Spiele einzeln holen
  // (laufend alle 2 Min., beendet einmal und dann dauerhaft gespeichert); höchstens 8 pro Durchgang
  // Laufend nur, wenn der Stand mehr Tore zeigt als bekannt sind (spart Abfragen: etwa eine pro Tor statt alle 2 Min.)
  const need = data.matches.filter((m) => (m.hs || m.as) && (((m.st === 'live' || m.st === 'ht') && (m.hs + m.as) !== (m.goals?.length || 0))
    || (m.st === 'ft' && now - Date.parse(m.utc) < 3 * 864e5 && !m.goalsDone))).slice(0, 8);
  if (need.length) {
    const got = new Map();
    for (const m of need) { const g = await goalGame(m.id).catch(() => null); if (g) got.set(m.id, g); }
    let save = false;
    data = { ...data, matches: data.matches.map((m) => { const g = got.get(m.id); if (!g) return m; if (g.final) save = true; return { ...m, goals: g.goals.length ? g.goals : m.goals, goalsDone: g.final || undefined }; }) };
    if (save) await cacheSet(ck, data);
  }
  return data;
}
// ---------- GOAL: Aufstellung und Statistik (Super League, Challenge League) ----------
// Aufstellung: erscheint etwa 30 Min. vor Anpfiff. Bis dahin höchstens alle 5 Min. fragen (ab 60 Min. vorher), dann dauerhaft
// gespeichert. Höchstens 15 Abfragen pro Spiel. Positionen liefert GOAL nur als Reihenfolge: das Feld ordnet nach Formation
// Trainer: GOAL liefert ihn als Liste oder einzeln, mit unterschiedlichen Feldnamen
const goalCoach = (c) => { const x = Array.isArray(c) ? c[0] : c; return String((typeof x === 'string' ? x : x?.lineupPlayer || x?.name || x?.coachName || x?.playerName) || '').trim(); };
async function goalLineup(m, now) {
  const fid = m.id.replace(/^gl-/, ''), ck = `gllu:${fid}`, hit = await cacheGet(ck);
  if (hit?.data?.available && (hit.data.final || Date.parse(m.utc) < now)) return hit.data;
  if (hit && (now - hit.at < (hit.data.available ? 3 * 3600e3 : 5 * 60 * 1000) || (hit.data.n || 0) >= 15)) return hit.data;
  if (Date.parse(m.utc) - now > 60 * 60 * 1000) return { available: false, message: 'Die Aufstellung erscheint etwa eine halbe Stunde vor Anpfiff.' };
  if (!(await goalAllowed())) return hit?.data || { available: false, message: 'Die Aufstellung ist gerade nicht verfügbar.' };
  const n = (hit?.data?.n || 0) + 1;
  try {
    const { d } = await goalGet(`/fixtures/${fid}/lineups`);
    const x = d?.data || d || {};
    const ord = (p, i) => Number(p.lineupPosition) || 100 + i;
    const side = (t, formation) => {
      const st = (t?.startingLineups || []).map((p, i) => [p, i]).sort((a, b) => ord(...a) - ord(...b)).map(([p]) => p);
      const sub = t?.substitutes || [];
      return { formation: String(formation || '').trim(), coach: goalCoach(t?.coach ?? t?.coaches ?? t?.manager),
        start: st.map((p) => ({ id: '', n: String(p.lineupPlayer || ''), no: p.lineupNumber ?? '', pos: '', cc: '', img: /^https:\/\/media\.goal-api\.com\//.test(String(p.playerImage || '')) ? p.playerImage : '' })),
        bench: sub.map((p) => String(p.lineupPlayer || '')), benchIds: sub.map(() => ''), benchNo: sub.map((p) => p.lineupNumber ?? ''), benchCc: sub.map(() => '') };
    };
    const home = side(x.home, x.homeFormation), away = side(x.away, x.awayFormation);
    const available = home.start.length >= 11 && away.start.length >= 11;
    const data = { available, home, away, src: 'goal', final: available && m.st === 'ft', n,
      ...(available ? {} : { message: 'Die Aufstellung erscheint etwa eine halbe Stunde vor Anpfiff.' }) };
    await cacheSet(ck, data);
    return data;
  } catch {
    const data = { ...(hit?.data || { available: false, message: 'Die Aufstellung ist gerade nicht verfügbar.' }), n };
    await cacheSet(ck, data);
    return data;
  }
}
// Statistik: live höchstens alle 5 Min., nach Schluss einmal und dauerhaft. Leere Werte heissen bei GOAL «nicht erfasst»
export function goalStatMap(list) {
  const v = {}, types = [];
  for (const r of list || []) {
    const t = String(r.type || '').toLowerCase().trim();
    types.push(r.type);
    const num = (x) => { const s = String(x ?? '').replace('%', '').trim(); return s === '' || !Number.isFinite(Number(s)) ? null : Number(s); };
    v[t] = [num(r.home), num(r.away)];
  }
  const get = (...ks) => { for (const k of ks) if (v[k] && (v[k][0] != null || v[k][1] != null)) return v[k]; return [null, null]; };
  const side = (i) => {
    const on = get('on target', 'shots on target', 'shots on goal')[i], off = get('off target', 'shots off target', 'shots off goal')[i];
    let shots = get('shots total', 'total shots', 'shots')[i];
    if (shots == null && on != null && off != null) shots = on + off + (get('blocked shots', 'shots blocked')[i] || 0);
    return { poss: get('ball possession', 'possession', 'possession %')[i], shots, on, corners: get('corners', 'corner kicks')[i],
      fouls: get('fouls')[i], yellow: get('yellow cards', 'yellowcards')[i], red: get('red cards', 'redcards')[i],
      passes: get('passes', 'total passes', 'passes total')[i], acc: get('accurate passes', 'passes accurate', 'successful passes')[i],
      saves: get('saves', 'goalkeeper saves')[i], offsides: get('offsides')[i], att: get('attacks')[i], datt: get('dangerous attacks')[i] };
  };
  return { home: side(0), away: side(1), types };
}
async function goalStats(m, now) {
  if (m.st === 'pre') return { available: false, src: 'GOAL', message: 'Die Live-Statistik erscheint nach Anpfiff.' };
  const fid = m.id.replace(/^gl-/, ''), ck = `glst:${fid}`, hit = await cacheGet(ck);
  if (hit && (hit.data.final || now - hit.at < SR_STATS_MS || (hit.data.n || 0) >= 40)) return hit.data;
  if (!(await goalAllowed())) return hit?.data || { available: false, src: 'GOAL' };
  const n = (hit?.data?.n || 0) + 1;
  try {
    const { d } = await goalGet(`/fixtures/${fid}/statistics`);
    const x = d?.data || d || {};
    const { home, away, types } = goalStatMap(x.match?.fullTime || []);
    const any = (t) => Object.values(t).some((y) => y != null);
    const data = { available: Boolean(x.hasStatistics !== false && (any(home) || any(away))), home, away, types, src: 'GOAL', final: m.st === 'ft', n };
    await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || { available: false, src: 'GOAL' }; }
}
// Einzelnes Spiel (Tore für Mitteilungen und Spieldetail): Ereignisse, live 2 Min., nach Schluss dauerhaft
async function goalGame(id) {
  const fid = id.replace(/^gl-/, ''), ck = `glev:${fid}`, hit = await cacheGet(ck), now = Date.now();
  if (hit && (hit.data.final || now - hit.at < 2 * 60 * 1000)) return hit.data;
  if (!(await goalAllowed())) return hit?.data || { goals: [], final: false };
  try {
    const [{ d: fx }, ev] = await Promise.all([goalGet(`/fixtures/${fid}`), goalGet(`/fixtures/${fid}/events`).catch(() => ({ d: null }))]);
    const f = fx?.data || fx;
    const events = goalList(ev.d).length ? goalList(ev.d) : f?.events || [];
    const data = { goals: goalGoals(f || {}, events), final: goalState(f || {}) === 'ft' };
    await cacheSet(ck, data);
    return data;
  } catch { return hit?.data || { goals: [], final: false }; }
}
// Tabelle (eine Abfrage), bis 6 Std. gespeichert bzw. nach dem letzten Spiel des Tages neu
// GOAL mischt in die Tabelle teils Gruppen der Vorsaison (z. B. die Abstiegsrunde, 31 Spiele) – jedes Team erschien doppelt.
// Gruppe je Zeile aus Saison-/Phasenangaben; fehlen sie oder bleiben Teams doppelt: nach Spielzahl gruppieren (± 3) und die Gruppe
// mit den meisten Teams nehmen (die laufende Saison hat alle Teams), bei Gleichstand die mit weniger Spielen
const goalStandGroup = (r) => [r?.season ?? r?.seasonId ?? r?.seasonName ?? '', r?.stageName ?? r?.stage ?? r?.groupName ?? r?.group ?? ''].join('|');
export function goalCurrentRows(rows) {
  const dup = (list) => new Set(list.map((r) => r.team)).size < list.length;
  if (!dup(rows)) return rows;
  const byG = new Map();
  for (const r of rows) byG.set(r._g, [...(byG.get(r._g) || []), r]);
  let groups = [...byG.values()];
  if (groups.length < 2 || groups.some(dup)) {
    const sorted = [...rows].sort((a, b) => a.p - b.p);
    groups = [];
    for (const r of sorted) { const g = groups.at(-1); if (g && r.p - g[0].p <= 3 && !g.some((x) => x.team === r.team)) g.push(r); else groups.push([r]); }
  }
  return groups.sort((a, b) => b.length - a.length || a[0].p - b[0].p)[0];
}
async function goalTable(cfg, now, force) {
  const ck = `gltab:${cfg.goal}`, hit = await cacheGet(ck);
  // v2: alte Saison herausgefiltert (gespeicherte Tabellen ohne v2 einmal neu holen)
  if (hit && !force && hit.data?.v === 2 && now - hit.at < 6 * 3600 * 1000) return hit.data;
  if (!Deno.env.get('GOAL_KEY') || !(await goalAllowed())) return hit?.data?.v === 2 ? hit.data : { available: false };
  try {
    const { d } = await goalGet(`/standings/${cfg.goal}`);
    const lg = FB_LEAGUES.find((l) => l.key === cfg.goal), names = lg ? await goalNames(lg) : new Map();
    const raw = goalList(d).filter((r) => !r.stageName || /current|regular|league/i.test(r.stageName) || goalList(d).every((x) => x.stageName === r.stageName));
    const pick = (r, ...ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== null && r[k] !== '') return Number(r[k]); return 0; };
    const rows = raw.map((r) => { const T = goalName(names, r.teamName || r.team?.name); return { rank: pick(r, 'overallLeaguePosition', 'position', 'rank'), team: T.n, logo: T.logo,
      p: pick(r, 'overallLeaguePayed', 'overallLeaguePlayed', 'played'), w: pick(r, 'overallLeagueW', 'won', 'win'), d: pick(r, 'overallLeagueD', 'draw', 'drawn'),
      l: pick(r, 'overallLeagueL', 'lost', 'loss'), gf: pick(r, 'overallLeagueGF', 'goalsFor'), ga: pick(r, 'overallLeagueGA', 'goalsAgainst'), pts: pick(r, 'overallLeaguePTS', 'points', 'pts') }; })
      .map((r, i) => ({ ...r, _g: goalStandGroup(raw[i]) })).filter((r) => r.team);
    const cur = goalCurrentRows(rows).sort((a, b) => a.rank - b.rank).map(({ _g, ...r }) => r);
    const data = { v: 2, available: cur.length > 0, zones: cfg.zones, rows: cur, source: 'GOAL API', asOf: new Date(now).toISOString() };
    if (cur.length) await cacheSet(ck, data);
    return data;
  } catch { return hit?.data?.v === 2 ? hit.data : { available: false }; }
}

// ---------- GOAL API (goal-api.com), Test vor dem Umbau der Schweizer Ligen ----------
// Secret GOAL_KEY, Zugang per «Authorization: Bearer». Die Doku nennt zwei Basisadressen; der Test probiert beide und
// sucht die Schweizer Ligen (Kennungen unbekannt), Live-Spiele, Spielplan und Tabelle. Etwa 15 Abfragen, 30 Min. gemerkt.
const GOAL_BASES = ['https://api.goal-api.com/v1', 'https://goal-api.com/api/v1'];
let goalBase = '';
async function goalGet(path, q = {}) {
  const key = Deno.env.get('GOAL_KEY');
  if (!key) throw new Error('Secret GOAL_KEY fehlt');
  const qs = new URLSearchParams(q).toString();
  let last = '';
  for (const base of goalBase ? [goalBase] : GOAL_BASES) {
    try {
      const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
      const limits = Object.fromEntries([...res.headers].filter(([k]) => /limit|remaining|quota/i.test(k)));
      const d = await res.json().catch(() => null);
      if (res.ok && d) { goalBase = base; return { d, limits }; }
      last = `${base}: HTTP ${res.status} ${String(d?.message || d?.error || '').slice(0, 80)}`;
    } catch (e) { last = `${base}: ${String(e?.message || e).slice(0, 80)}`; }
  }
  throw new Error(last);
}
const goalList = (d) => (Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : Array.isArray(d?.response) ? d.response : []);
async function goalProbe() {
  const hit = await cacheGet('goalprobe');
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return { ...hit.data, cached: true };
  const out = { base: '', limits: {}, swiss: [], leagueSample: null, live: null, leagues: [] };
  // Ligen durchsuchen (bis 12 Seiten à 100), Schweizer Einträge sammeln
  for (let off = 0; off < 1200; off += 100) {
    const { d, limits } = await goalGet('/leagues', { limit: '100', offset: String(off) });
    out.base = goalBase; out.limits = limits;
    const list = goalList(d);
    if (!out.leagueSample && list[0]) out.leagueSample = list[0];
    for (const l of list) if (/switz|schweiz|suisse/i.test(JSON.stringify(l))) out.swiss.push(l);
    if (list.length < 100) break;
  }
  const live = await goalGet('/fixtures/live').catch((e) => ({ err: String(e.message) }));
  const ll = goalList(live.d);
  out.live = live.err ? { error: live.err } : { count: ll.length, swiss: ll.filter((f) => /switz/i.test(JSON.stringify(f))).slice(0, 5), sampleKeys: ll[0] ? Object.keys(ll[0]) : [] };
  for (const l of out.swiss.filter((x) => /super league|challenge league/i.test(JSON.stringify(x))).slice(0, 2)) {
    const id = l.id ?? l.leagueId ?? l._id;
    const fx = await goalGet(`/leagues/${id}/fixtures`, { limit: '100' }).catch((e) => ({ err: String(e.message) }));
    const st = await goalGet(`/standings/${id}`).catch((e) => ({ err: String(e.message) }));
    const fl = goalList(fx.d), now = Date.now();
    out.leagues.push({ id, name: l.name || l.leagueName, season: l.season || l.currentSeason || null,
      fixtures: fx.err ? { error: fx.err } : { count: fl.length, next: fl.filter((f) => Date.parse(f.kickoffUtc || f.date || 0) > now).slice(0, 3).map((f) => `${f.kickoffUtc || f.date} ${f.homeTeamName || f.home?.name} – ${f.awayTeamName || f.away?.name}`), sampleKeys: fl[0] ? Object.keys(fl[0]) : [] },
      standings: st.err ? { error: st.err } : { rows: goalList(st.d).length || (st.d?.data?.standings || []).length, sample: JSON.stringify(st.d).slice(0, 300) } });
  }
  out.ok = out.leagues.length === 2 && out.leagues.every((x) => x.fixtures.count > 0);
  await cacheSet('goalprobe', out);
  return out;
}

// ?capprobe=1: prüft, welche Zusatzdaten die Quellen wirklich liefern (Konzept «drei Ligen, ein Takt»): GOAL Aufstellung,
// Statistik und Torschützenliste der Super League; Big Balls Aufstellung (CL, PL), Statistik und Torschützenliste der CL.
// Nimmt das letzte beendete Spiel aus dem Speicher und, falls eines läuft, zusätzlich ein Live-Spiel. Höchstens 9 Abfragen, 30 Min. gespeichert
// ?capprobe=1&id=gl-…|bb-…: nur dieses Spiel (Aufstellung + Statistik, 2 Abfragen), 2 Min. gespeichert – z. B. vor dem Anpfiff oder live
async function capProbeOne(id) {
  if (!/^(gl|bb)-[\w-]{6,40}$/.test(id)) return { ok: false, error: 'ungültige ID' };
  const ck = `capprobe1:${id}`, hit = await cacheGet(ck);
  if (hit && Date.now() - hit.at < 2 * 60 * 1000) return { ...hit.data, cached: true };
  const sum = (d) => ({ size: JSON.stringify(d ?? null).length, sample: JSON.stringify(d ?? null).slice(0, 600) });
  const out = { id, at: new Date().toISOString() };
  const run = async (fn) => { try { return { ok: true, ...sum(await fn()) }; } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; } };
  if (id.startsWith('gl-')) {
    const fid = id.slice(3);
    out.lineups = await run(async () => (await goalGet(`/fixtures/${fid}/lineups`)).d);
    out.statistics = await run(async () => (await goalGet(`/fixtures/${fid}/statistics`)).d);
  } else {
    const u = id.slice(3);
    out.lineups = await run(() => bbGet(`stored/matches/${u}/lineups`));
    out.statistics = await run(() => bbGet(`matches/${u}/statistics`));
  }
  await cacheSet(ck, out);
  return out;
}
async function capProbe() {
  const hit = await cacheGet('capprobe');
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return { ...hit.data, cached: true };
  const now = Date.now();
  const sum = (d) => {
    const x = d?.data ?? d;
    const keys = x && typeof x === 'object' ? Object.keys(Array.isArray(x) ? (x[0] || {}) : x).slice(0, 15) : [];
    return { keys, size: JSON.stringify(d ?? null).length, sample: JSON.stringify(d ?? null).slice(0, 400) };
  };
  const tryGoal = async (path, q) => { try { const { d } = await goalGet(path, q); return { ok: true, ...sum(d) }; } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; } };
  const tryBb = async (path) => { try { return { ok: true, ...sum(await bbGet(path)) }; } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 160) }; } };
  const pick = (ms, st) => (ms || []).filter((m) => (st === 'ft' ? m.st === 'ft' : m.st === 'live' || m.st === 'ht') && Date.parse(m.utc) < now).sort((a, b) => Date.parse(b.utc) - Date.parse(a.utc))[0];
  const out = { at: new Date(now).toISOString(), goal: {}, bb: {} };
  const sl = FB_LEAGUES.find((l) => l.id === 'chsl');
  const gms = (await cacheGet(`gl:${sl.key}`))?.data?.matches || [];
  const gft = pick(gms, 'ft'), glive = pick(gms, 'live');
  if (gft) {
    const fid = gft.id.replace(/^gl-/, '');
    out.goal.match = `${gft.h} – ${gft.a} (${gft.utc})`;
    out.goal.lineups = await tryGoal(`/fixtures/${fid}/lineups`);
    out.goal.statistics = await tryGoal(`/fixtures/${fid}/statistics`);
  } else out.goal.match = 'kein beendetes Spiel im Speicher';
  out.goal.topScorers = await tryGoal(`/leagues/${sl.key}/top-scorers`, { limit: '10' });
  if (glive) { out.goal.liveMatch = `${glive.h} – ${glive.a}`; out.goal.liveStatistics = await tryGoal(`/fixtures/${glive.id.replace(/^gl-/, '')}/statistics`); }
  for (const [id, key] of [['ucl', 'ucl'], ['pl', 'epl']]) {
    const ms = ((await cacheGet(`bb2:${key}`))?.data?.matches || []).filter((m) => m.id.startsWith('bb-'));
    const ft = pick(ms, 'ft'), live = pick(ms, 'live'), r = {};
    if (ft) { const u = ft.id.replace(/^bb-/, ''); r.match = `${ft.h} – ${ft.a} (${ft.utc})`; r.lineups = await tryBb(`stored/matches/${u}/lineups`); if (id === 'ucl') r.statistics = await tryBb(`matches/${u}/statistics`); }
    else r.match = 'kein beendetes Spiel im Speicher';
    if (live) { r.liveMatch = `${live.h} – ${live.a}`; r.liveStatistics = await tryBb(`matches/${live.id.replace(/^bb-/, '')}/statistics`); }
    out.bb[id] = r;
  }
  out.bb.uclTopScorers = await tryBb('leagues/ucl/top-scorers');
  await cacheSet('capprobe', out);
  return out;
}

// Versionsangabe für den Abgleich mit dem Repository: bei jeder Änderung dieser Funktion erhöhen. Abruf: ?version=1
const FN_VERSION = '2026-11-22p';
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
  if (params.has('version')) return new Response(JSON.stringify({ fn: 'fussball', version: FN_VERSION }), { headers });
  if (params.has('usage')) return new Response(JSON.stringify(await usageReport(Date.now())), { headers });
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
  if (params.has('goalprobe')) {
    try { return new Response(JSON.stringify(await goalProbe()), { headers }); }
    catch (err) { return new Response(JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 200) }), { status: 502, headers }); }
  }
  if (params.has('capprobe')) {
    try { return new Response(JSON.stringify(params.get('id') ? await capProbeOne(String(params.get('id'))) : await capProbe()), { headers }); }
    catch (err) { return new Response(JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 200) }), { status: 502, headers }); }
  }
  if (params.has('afprobe')) {
    try { return new Response(JSON.stringify(await afProbe()), { headers }); }
    catch (err) { return new Response(JSON.stringify({ ok: false, error: String(err?.message || err).slice(0, 200) }), { status: 502, headers }); }
  }
  if (params.has('livedebug')) {
    // Diagnose Live-Stände: Zähler, Sportradar-Spielplan der Champions League, Live-Liste, Zuordnung der heutigen CL-Spiele
    try {
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
      const out = { version: 'live-sr-1', srCount: (await cacheGet(`srcount:${day}`))?.data ?? null, srMax: srDailyMax(), bbCount: (await cacheGet(`bbcount:${day}`))?.data ?? null, srKey: Boolean(Deno.env.get('SPORTRADAR_KEY')) };
      const lg = FB_LEAGUES.find((l) => l.id === 'ucl');
      const fx = await srFixtures({ ...lg, key: lg.sr }, now).catch((e) => ({ status: 'error', message: String(e?.message || e), matches: [] }));
      out.uclSr = { status: fx.status, message: fx.message, count: fx.matches.length, today: fx.matches.filter((m) => m.utc.slice(0, 10) === day).map((m) => `${m.utc.slice(11, 16)} ${m.h} – ${m.a} ${m.st} ${m.hs ?? ''}:${m.as ?? ''} ${m.id}`) };
      const live = await srLive(now).catch((e) => ({ error: String(e?.message || e) }));
      out.srLive = { count: live?.list?.length ?? null, error: live?.error, ids: (live?.list || []).slice(0, 40).map((x) => `${x.id} ${x.es?.status} ${x.es?.home_score ?? ''}:${x.es?.away_score ?? ''}`) };
      const bb = (await cacheGet('bb2:ucl'))?.data?.matches || [];
      out.match = bb.filter((m) => m.utc.slice(0, 10) === day).map((m) => {
        const t = Date.parse(m.utc);
        const sr = fx.matches.find((x) => Math.abs(Date.parse(x.utc) - t) < 3 * 3600e3 && (nameKey(x.h) === nameKey(m.h) || nameKey(x.a) === nameKey(m.a)));
        return `${m.h} – ${m.a} [${nameKey(m.h)}/${nameKey(m.a)}] → ${sr ? `${sr.h} – ${sr.a} ${sr.id}` : 'keine Zuordnung'}`;
      });
      return new Response(JSON.stringify(out), { headers });
    } catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err), stack: String(err?.stack || '').slice(0, 400) }), { status: 502, headers }); }
  }
  // Liste der Fussball-Ligaschlüssel von Big Balls (eine Abfrage, 24 Std. gespeichert), um Schlüssel wie den der Championship zu prüfen
  if (params.has('bbleagues')) {
    try {
      const hit = await cacheGet('bbleagues');
      if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return new Response(JSON.stringify(hit.data), { headers });
      if (!(await bbAllowed())) return new Response(JSON.stringify({ error: 'Tagesgrenze' }), { status: 429, headers });
      const d = await bbGet('leagues', { sport: 'football' });
      const arr = Array.isArray(d?.data) ? d.data : d?.data?.leagues || d?.leagues || [];
      const data = { count: arr.length, leagues: arr.map((l) => ({ key: l.key ?? l.slug ?? l.id ?? l.code, name: l.name, country: l.country?.name ?? l.country ?? '' })) };
      await cacheSet('bbleagues', data);
      return new Response(JSON.stringify(data), { headers });
    } catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('bbusage')) {
    try { return new Response(JSON.stringify(await bbUsageRun(Date.now())), { headers }); }
    catch (err) { return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 502, headers }); }
  }
  if (params.has('fbplayer')) {
    try { return new Response(JSON.stringify(await fbPlayer(String(params.get('fbplayer')))), { headers }); }
    catch { return new Response(JSON.stringify({ available: false, error: 'nicht erreichbar' }), { status: 502, headers }); }
  }
  if (params.has('fbgame')) {
    try {
      return new Response(JSON.stringify(await fbGame(params.get('fbgame'))), { headers });
    } catch {
      return new Response(JSON.stringify({ goals: [], error: 'nicht erreichbar' }), { status: 502, headers });
    }
  }
  try {
    // Jemand schaut zu: Live-Stände im kurzen Abstand (höchstens ein Eintrag pro Minute und Instanz)
    if (Date.now() - lastViewMark > 60 * 1000) { lastViewMark = Date.now(); await cacheSet('fbview', true); }
    liveEager = true;
    return new Response(JSON.stringify(await fbOverview(Date.now())), { headers: { ...headers, 'Cache-Control': 'public, max-age=30' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Die Fussball-Daten sind gerade nicht erreichbar.' }), { status: 502, headers });
  }
}

// Nur auf dem Server starten
// Nach jeder Anfrage den gezählten Verbrauch speichern (im Hintergrund, wo die Laufzeit das erlaubt)
async function serve(req) {
  try { return await handle(req); }
  finally {
    const p = flushUse().catch(() => {});
    if (globalThis.EdgeRuntime?.waitUntil) globalThis.EdgeRuntime.waitUntil(p); else await p;
  }
}
if (typeof Deno !== 'undefined') Deno.serve(serve);
