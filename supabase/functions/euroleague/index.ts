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
//   GET ?game=83  → Spielbericht eines Spiels (auch während es läuft):
//   → { code, live, quarters: [[…Heim], […Gast]], teams: [{ code, name, coach, totals, players: [{ no, name, start, on,
//       min, pts, fg2, fg3, ft, oreb, dreb, reb, ast, stl, tov, blk, pf, pir, pm }] }] }   (fg2/fg3/ft: [Treffer, Versuche])
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
const BOX_LIVE_MS = 20 * 1000;
const BOX_FINAL_MS = 60 * 60 * 1000;
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

// „LUWAWU-CABARROT, TIMOTHE“ → „T. Luwawu-Cabarrot“
function playerName(raw) {
  const [last, first] = String(raw || '').split(',').map((x) => x.trim());
  const nice = (w) => w.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return first ? `${first.charAt(0).toUpperCase()}. ${nice(last)}` : nice(last || '');
}

const statLine = (p) => ({
  min: String(p?.Minutes || '').trim(), pts: Number(p?.Points) || 0,
  fg2: [Number(p?.FieldGoalsMade2) || 0, Number(p?.FieldGoalsAttempted2) || 0],
  fg3: [Number(p?.FieldGoalsMade3) || 0, Number(p?.FieldGoalsAttempted3) || 0],
  ft: [Number(p?.FreeThrowsMade) || 0, Number(p?.FreeThrowsAttempted) || 0],
  oreb: Number(p?.OffensiveRebounds) || 0, dreb: Number(p?.DefensiveRebounds) || 0, reb: Number(p?.TotalRebounds) || 0,
  ast: Number(p?.Assistances) || 0, stl: Number(p?.Steals) || 0, tov: Number(p?.Turnovers) || 0,
  blk: Number(p?.BlocksFavour) || 0, pf: Number(p?.FoulsCommited) || 0, pir: Number(p?.Valuation) || 0,
});

// Boxscore der EuroLeague → kompakter Spielbericht. Reihenfolge der Teams: Heim, Gast.
export function buildBox(code, box) {
  const quarter = (q) => {
    const keys = Object.keys(q || {}).filter((k) => /^Quarter\d+$|^Extra/i.test(k));
    return keys.map((k) => (q[k] == null ? null : Number(q[k]) || 0));
  };
  const teams = (box?.Stats || []).slice(0, 2).map((t) => {
    const players = (t.PlayersStats || []).map((p) => ({
      no: String(p.Dorsal || '').trim(), name: playerName(p.Player), start: Boolean(p.IsStarter), on: Boolean(p.IsPlaying),
      ...statLine(p), pm: Number(p.Plusminus) || 0,
    }));
    const code = String((t.PlayersStats || [])[0]?.Team || t.tmr?.Team || '').trim();
    return { code, name: String(t.Team || ''), coach: playerName(t.Coach), players, totals: statLine(t.totr) };
  });
  return { code, live: box?.Live === true, quarters: (box?.ByQuarter || []).slice(0, 2).map(quarter), teams };
}

const boxes = new Map();
async function boxOf(season, code) {
  const hit = boxes.get(code);
  if (hit && Date.now() - hit.at < (hit.data.live ? BOX_LIVE_MS : BOX_FINAL_MS)) return hit.data;
  const raw = await getJson(`https://live.euroleague.net/api/Boxscore?gamecode=${code}&seasoncode=${season}`);
  const data = buildBox(code, raw);
  // Noch ohne Spieler (Spiel nicht begonnen): nur kurz merken
  boxes.set(code, { at: data.teams.some((t) => t.players.length) ? Date.now() : Date.now() - BOX_FINAL_MS + BOX_LIVE_MS, data });
  return data;
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
  const game = new URL(req.url).searchParams.get('game');
  if (game != null) {
    const code = Number(game);
    const headers = { ...cors, 'Content-Type': 'application/json' };
    if (!Number.isInteger(code) || code < 1 || code > 999) return new Response(JSON.stringify({ error: 'ungültiges Spiel' }), { status: 400, headers });
    try {
      const box = await boxOf(season, code);
      return new Response(JSON.stringify(box), { headers: { ...headers, 'Cache-Control': `public, max-age=${box.live ? 20 : 300}` } });
    } catch {
      return new Response(JSON.stringify({ error: 'Der Spielbericht ist gerade nicht erreichbar.' }), { status: 502, headers });
    }
  }
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
