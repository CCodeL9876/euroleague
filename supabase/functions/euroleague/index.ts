// Supabase Edge Function „euroleague“: alle Spiele der laufenden EuroLeague-Saison mit Resultaten und Live-Ständen –
// Datenquelle der Euroleague-Seite (index.html, app.js). Der Browser darf die EuroLeague nicht selbst abfragen,
// darum diese Funktion.
//
//   GET (ohne Anmeldung; antwortet nur Seiten von ALLOWED_ORIGINS)
//   → { updated, season,
//       teams: { CODE: { name, short, crest } },
//       games: [{ code, round, utc, home, away, hs, as, status, period, clock }] }
//     status: 'pre' (noch nicht begonnen), 'live' (läuft), 'final' (beendet); period: Viertel, clock: Restzeit
//
// Quelle sind die öffentlichen Schnittstellen der EuroLeague: der Spielplan der Saison (api-live.euroleague.net) und
// pro laufendem Spiel der aktuelle Stand (live.euroleague.net). Nur öffentliche Daten, keine Anmeldung nötig.
// Speichert und protokolliert nichts; der Spielplan bleibt 2 Minuten, ein Spielstand 20 Sekunden im Arbeitsspeicher,
// damit viele Aufrufe die EuroLeague nicht mehrfach abfragen. Einrichtung: README.md (JWT-Prüfung aus).
//
// Bewusst eine einzige Datei in reinem JavaScript (gültiges TypeScript) zum Einfügen im Supabase-Dashboard;
// buildPayload() hat keine Abhängigkeiten und lässt sich im Browser testen.

const ALLOWED_ORIGINS = ['https://ccodel9876.github.io'];
const TIMEOUT_MS = 10000;
const SCHEDULE_MS = 2 * 60 * 1000;
const LIVE_MS = 20 * 1000;
// Stand abfragen ab 5 Minuten vor dem angesetzten Beginn bis 4 Stunden danach (solange nicht „played“)
const EARLY_MS = 5 * 60 * 1000;
const LATE_MS = 4 * 3600 * 1000;

// Saison „E2026“ läuft von Herbst 2026 bis Frühling 2027
export function seasonCode(now) {
  const y = now.getUTCFullYear();
  return `E${now.getUTCMonth() + 1 >= 7 ? y : y - 1}`;
}

const roundOf = (g) => Number(g.round?.round ?? (/\d+/.exec(String(g.roundName || g.roundAlias || '')) || [])[0]) || 0;

// Spielplan der EuroLeague (v2, „data“) → kompakte Daten für die Seite; liveOf(code) liefert für Spiele, die gerade
// laufen könnten, { live, hs, as, period, clock } oder null (nicht erreichbar)
export async function buildPayload(schedule, now, liveOf) {
  const t = now.getTime();
  const teams = {};
  const addTeam = (side) => {
    const c = side?.club || {};
    const code = String(c.code || '');
    if (code && !teams[code]) teams[code] = { name: String(c.name || code), short: String(c.abbreviatedName || c.editorialName || c.name || code), crest: String(c.images?.crest || '') };
    return code;
  };
  const list = (schedule?.data || [])
    .map((g) => {
      const utc = String(g.utcDate || '');
      return { code: Number(g.gameCode), round: roundOf(g), at: Date.parse(utc.endsWith('Z') ? utc : `${utc}Z`), played: Boolean(g.played),
        home: addTeam(g.local), away: addTeam(g.road), hs: Number(g.local?.score) || 0, as: Number(g.road?.score) || 0 };
    })
    .filter((g) => g.code > 0 && Number.isFinite(g.at) && g.home && g.away)
    .sort((a, b) => a.at - b.at || a.code - b.code);
  const games = await Promise.all(list.map(async (g) => {
    const out = { code: g.code, round: g.round, utc: new Date(g.at).toISOString(), home: g.home, away: g.away, hs: 0, as: 0, status: 'pre', period: '', clock: '' };
    if (g.played) return { ...out, hs: g.hs, as: g.as, status: 'final' };
    if (g.at > t + EARLY_MS || g.at < t - LATE_MS) return out;
    const s = await liveOf(g.code);
    if (!s) return out;
    if (s.live) return { ...out, hs: s.hs, as: s.as, status: 'live', period: s.period, clock: s.clock };
    // Nicht mehr live, aber Punkte und Beginn vorbei: beendet (der Spielplan trägt „played“ erst später nach)
    if (s.hs + s.as > 0 && g.at < t) return { ...out, hs: s.hs, as: s.as, status: 'final' };
    return out;
  }));
  return { updated: now.toISOString(), season: '', teams, games };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let schedule = { at: 0, season: '', data: null };
const lives = new Map();

async function loadSchedule(season) {
  if (schedule.season === season && schedule.data && Date.now() - schedule.at < SCHEDULE_MS) return schedule.data;
  const data = await getJson(`https://api-live.euroleague.net/v2/competitions/E/seasons/${season}/games`);
  schedule = { at: Date.now(), season, data };
  return data;
}

// Stand eines Spiels; TeamA ist die Heimmannschaft
async function liveOf(season, code) {
  const hit = lives.get(code);
  if (hit && Date.now() - hit.at < LIVE_MS) return hit.data;
  try {
    const h = await getJson(`https://live.euroleague.net/api/Header?gamecode=${code}&seasoncode=${season}`);
    const data = { live: h?.Live === true, hs: Number(h?.ScoreA) || 0, as: Number(h?.ScoreB) || 0,
      period: String(h?.Quarter ?? '').trim(), clock: String(h?.RemainingPartialTime ?? '').trim() };
    lives.set(code, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

// Nur die eigene Seite (und zum Testen localhost) darf die Antwort lesen
function corsFor(req) {
  const origin = req.headers.get('origin') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'apikey, authorization, content-type', 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } : { Vary: 'Origin' };
}

async function handle(req) {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'nur GET' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  const now = new Date();
  const season = seasonCode(now);
  let data;
  try {
    data = await loadSchedule(season);
  } catch {
    return new Response(JSON.stringify({ error: 'Die EuroLeague antwortet nicht.' }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  const payload = await buildPayload(data, now, (code) => liveOf(season, code));
  payload.season = season;
  // Kurz zwischenspeichern lassen: mehrere Geräte holen in derselben halben Minute dieselbe Antwort
  return new Response(JSON.stringify(payload), { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=20' } });
}

// Nur auf dem Server starten – im Browser (Test) wird nur buildPayload gebraucht
if (typeof Deno !== 'undefined') Deno.serve(handle);
