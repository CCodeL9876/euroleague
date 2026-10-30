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
//       min, pts, fg2, fg3, ft, oreb, dreb, reb, ast, stl, tov, blk, pf, pir, pm }] }],
//       shots: [{ t: Team, p: Spieler, x, y, m: getroffen, v: 2|3 }] }   (fg2/fg3/ft: [Treffer, Versuche];
//       x/y in cm vom Korb aus, y Richtung Mittellinie)
//
//   GET ?players=1 → Saisonwerte aller Spieler (pro Spiel) für Bestenlisten, Kader und Vorschau:
//   → { updated, players: [{ id, name, team, img, gp, gs, min, pts, reb, oreb, ast, stl, blk, tov, pir, fg2p, fg3p, ftp, fg3m }] }
//
//   POST { key, code } → Zugriffsschutz der Seite (gate.js): prüft gegen die Secrets GATE_KEY/GATE_CODE dieser
//   Funktion (Supabase-Dashboard → Edge Functions → euroleague → Secrets), damit die Werte nicht im Repo/Quelltext
//   stehen. → { ok: true|false }. Ohne gesetzte Secrets immer { ok: false }.
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
const PLAYERS_MS = 30 * 60 * 1000;
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

// Würfe aus dem Feld (ohne Freiwürfe) für die Wurfkarte
export function buildShots(points) {
  const kinds = { '2FGM': [2, true], '2FGA': [2, false], '3FGM': [3, true], '3FGA': [3, false] };
  return (points?.Rows || []).filter((r) => kinds[String(r.ID_ACTION || '').trim()]).map((r) => {
    const [v, m] = kinds[String(r.ID_ACTION).trim()];
    return { t: String(r.TEAM || '').trim(), p: playerName(r.PLAYER), x: Number(r.COORD_X) || 0, y: Number(r.COORD_Y) || 0, m, v };
  });
}

// Saisonwerte (pro Spiel) der EuroLeague → kompakte Liste. Bei Wechseln („BAS;TEL“) zählt das letzte Team.
const pctNum = (v) => { const n = parseFloat(String(v ?? '').replace('%', '')); return Number.isFinite(n) ? n : 0; };
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
export function buildPlayers(stats) {
  return (stats?.players || []).map((s) => {
    const pl = s.player || {};
    const team = String(pl.team?.code || '').split(';').pop().trim();
    return { id: String(pl.code || ''), name: playerName(pl.name), team, img: String(pl.imageUrl || ''),
      gp: Number(s.gamesPlayed) || 0, gs: Number(s.gamesStarted) || 0, min: r1(s.minutesPlayed), pts: r1(s.pointsScored),
      reb: r1(s.totalRebounds), oreb: r1(s.offensiveRebounds), ast: r1(s.assists), stl: r1(s.steals), blk: r1(s.blocks),
      tov: r1(s.turnovers), pir: r1(s.pir), fg2p: pctNum(s.twoPointersPercentage), fg3p: pctNum(s.threePointersPercentage),
      ftp: pctNum(s.freeThrowsPercentage), fg3m: r1(s.threePointersMade) };
  }).filter((p) => p.id && p.team);
}

let players = { at: 0, season: '', data: null };
async function playersOf(season) {
  if (players.season === season && players.data && Date.now() - players.at < PLAYERS_MS) return players.data;
  const raw = await getJson(`https://api-live.euroleague.net/v3/competitions/E/statistics/players/traditional?seasonMode=Single&seasonCode=${season}&statisticMode=PerGame&limit=500`);
  const data = { updated: new Date().toISOString(), players: buildPlayers(raw) };
  players = { at: Date.now(), season, data };
  return data;
}

const boxes = new Map();
async function boxOf(season, code) {
  const hit = boxes.get(code);
  if (hit && Date.now() - hit.at < (hit.data.live ? BOX_LIVE_MS : BOX_FINAL_MS)) return hit.data;
  const [raw, points] = await Promise.all([
    getJson(`https://live.euroleague.net/api/Boxscore?gamecode=${code}&seasoncode=${season}`),
    getJson(`https://live.euroleague.net/api/Points?gamecode=${code}&seasoncode=${season}`).catch(() => null),
  ]);
  const data = { ...buildBox(code, raw), shots: buildShots(points) };
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
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'apikey, authorization, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', Vary: 'Origin' } : { Vary: 'Origin' };
}

// Gleich lang vergleichen (kein Rückschluss aus der Antwortzeit auf richtige/falsche Zeichen)
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleGate(req, cors) {
  const headers = { ...cors, 'Content-Type': 'application/json' };
  const gateKey = Deno.env.get('GATE_KEY') || '';
  const gateCode = Deno.env.get('GATE_CODE') || '';
  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false }), { status: 400, headers }); }
  const key = String(body?.key ?? '');
  const code = String(body?.code ?? '');
  const ok = Boolean(gateKey) && Boolean(gateCode) && sameString(key, gateKey) && sameString(code, gateCode);
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 401, headers });
}

async function handle(req) {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method === 'POST') return handleGate(req, cors);
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'nur GET oder POST' }), { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } });
  const now = new Date();
  const season = seasonCode(now);
  const params = new URL(req.url).searchParams;
  if (params.has('players')) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    try {
      return new Response(JSON.stringify(await playersOf(season)), { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    } catch {
      return new Response(JSON.stringify({ error: 'Die Spielerstatistik ist gerade nicht erreichbar.' }), { status: 502, headers });
    }
  }
  const game = params.get('game');
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
