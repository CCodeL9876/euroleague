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
//       shots: [{ t: Team, p: Spieler, x, y, m: getroffen, v: 2|3 }],   (fg2/fg3/ft: [Treffer, Versuche];
//       x/y in cm vom Korb aus, y Richtung Mittellinie)
//       flow: { end, ev: [[Sekunde, Heim, Gast]], runs: [{ s: 1 Heim | -1 Gast, t0, t1, f: [Heim, Gast], to: [Heim, Gast],
//       ra, rb, who: [Werfer] }], dec: Index des entscheidenden Laufs oder -1 } }
//
//   GET ?teamstats=1 → Teamwerte und Liga-Quoten für Team-Analyse, Teamprofil und Wurfzonen:
//   → { updated, pending, teams: { CODE: { gp, ortg, drtg, net, pace, efg, p3, tov, oreb, ftr, bench, start, share } },
//       zones: { rim|short|m2l|m2c|m2r|c3l|c3r|w3l|w3r|t3: [Treffer, Versuche] } }
//     (bench/start: Punkte pro Spiel; pending: Spiele, die noch nicht ausgewertet sind. Einmal ausgewertete Spiele
//     bleiben in der Tabelle el_fb_cache, jeder Abruf arbeitet nur die neuen ab.)
//
//   GET ?players=1 → Saisonwerte aller Spieler (pro Spiel) für Bestenlisten, Kader und Vorschau:
//   → { updated, players: [{ id, name, team, img, gp, gs, min, pts, reb, oreb, ast, stl, blk, tov, pir, fg2p, fg3p, ftp, fg3m }] }
//
//   GET ?player=003112&team=IST → Spielerseite: Steckbrief, Saison Spiel für Spiel, Karriere (alle Wettbewerbe)
//   → { id, first, last, no, pos, team, img, country, height, weight, birth, lastTeam, since,
//       avg: { gp, gs, min, pts, reb, oreb, ast, stl, tov, blk, fd, pir, pm, fg2, fg3, ft, fga, fta, fg2p, fg3p, ftp },
//       games: [{ r, utc, home, away, hs, as, team, start, min, pts, reb, ast, stl, tov, pir, pm }],
//       career: [{ comp, season, year, team, teamName, logo, gp, min, pts, reb, ast, pir }],
//       history: [{ from, to, team, loan, league, country }],   (alle Vereine laut Wikipedia; to: null = aktuell)
//       shots: [{ x, y, m, v, r }] }                             (alle Würfe der Saison, r = Spieltag)
//     (career: Summen pro Saison; min in Minuten; team darf fehlen – dann aus den Spielen)
//
//   GET ?facts=1 → „Statistiken & Fakten“: ewige Bestenlisten (seit 2000/01), NBA-Erfahrung der aktuellen Spieler
//   (aus Wikipedia), Kader-Fakten (älteste, jüngste, grösste … Spieler, Nationen, Durchschnittsalter pro Team)
//   → { updated, total, alltime: { gp|pts|reb|ast|pir|fg3m|blk|stl: [{ id, name, team, value, active }] },
//       nba: { count, known, players: [{ id, name, team, nba: [Teams] }] },
//       roster: { players: [{ id, name, team, birth, height, country, countryName, img }] } }
//
//   POST { key, code } → Zugriffsschutz der Seite (gate.js): prüft gegen die Secrets GATE_KEY/GATE_CODE dieser
//   Funktion (Supabase-Dashboard → Edge Functions → euroleague → Secrets), damit die Werte nicht im Repo/Quelltext
//   stehen. → { ok: true|false }. Ohne gesetzte Secrets immer { ok: false }.
//
//   POST { kind: 'profile-create', name, pin, favorites? } → legt ein Profil an (Name frei wählbar, einmalig;
//   PIN 4–8 Ziffern). → { ok, name, favorites } oder { ok:false, error:'vergeben' }.
//   POST { kind: 'profile-login', name, pin } → meldet an einem Profil an (auch auf einem anderen Gerät).
//   → { ok, name, favorites } oder { ok:false, error:'unbekannt'|'pin' }.
//   POST { kind: 'profile-save', name, pin, favorites } → speichert die Lieblingsteams des Profils.
//   → { ok, favorites } oder { ok:false, error:'unbekannt'|'pin' }.
//   Profile liegen in der Tabelle „el_profiles“ (PIN nur als Hash); Zugriff ausschliesslich über diese Funktion
//   mit dem Secret SUPABASE_SERVICE_ROLE_KEY (Tabelle selbst bleibt per RLS für alle anderen gesperrt).
//   Einrichtung: README.md.
//
//   GET ?videos=1 → Videos des offiziellen YouTube-Kanals «EUROLEAGUE BASKETBALL», den Spielen zugeordnet:
//   → { updated, games: { "86": [{ id, t: Titel, k: 'main'|'last5'|'player'|'pre'|'other', d: Sekunden, at }] } }
//     Braucht das Secret YOUTUBE_KEY (YouTube Data API v3); ohne Schlüssel { games: {} }. Liest die Uploads-Liste
//     des Kanals (1 Einheit pro 50 Videos, nur bis zum zuletzt gesehenen Upload) und hält die Zuordnung in der Tabelle el_fb_cache (wie die Funktion fussball),
//     damit auch ältere Spieltage ihre Videos behalten.
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
const PLAYER_MS = 10 * 60 * 1000;
const ROSTER_MS = 6 * 3600 * 1000;
const HISTORY_MS = 24 * 3600 * 1000;
const FACTS_MS = 12 * 3600 * 1000;
const POINTS_MS = 30 * 60 * 1000;
const TEAMSTATS_MS = 10 * 60 * 1000;
const WIKI_UA = 'euroleague-pwa/1.0 (https://github.com/CCodeL9876/euroleague)';
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
      id: String(p.Player_ID || '').trim().replace(/^P/, ''), no: String(p.Dorsal || '').trim(), name: playerName(p.Player), start: Boolean(p.IsStarter), on: Boolean(p.IsPlaying),
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
    return { t: String(r.TEAM || '').trim(), p: playerName(r.PLAYER), id: String(r.ID_PLAYER || '').trim().replace(/^P/, ''), x: Number(r.COORD_X) || 0, y: Number(r.COORD_Y) || 0, m, v };
  });
}

// Spielverlauf aus dem Play-by-Play: Stand nach jedem Korb und alle Läufe. Ein Lauf ist ein Abschnitt von höchstens
// 4:30 Minuten, der mit einem Korb des Teams beginnt und endet und den es mit mindestens 8 Punkten gewinnt.
const RUN_SECONDS = 270, RUN_MIN = 8;
export function buildFlow(pbp, live) {
  if (!pbp) return null;
  const ev = [];
  let a = 0, b = 0, last = 0;
  const walk = (rows, base, len) => {
    for (const r of rows) {
      const c = /^(\d+):(\d+)$/.exec(String(r.MARKERTIME || '').trim());
      if (c) last = Math.max(last, base + len - (Number(c[1]) * 60 + Number(c[2])));
      if (r.POINTS_A == null && r.POINTS_B == null) continue;
      const pa = r.POINTS_A ?? a, pb = r.POINTS_B ?? b;
      if (pa === a && pb === b) continue;
      ev.push({ t: last, a: pa, b: pb, da: pa - a, db: pb - b, p: playerName(r.PLAYER).replace(/^.\. /, '').replace(/ (Iv|Iii|Ii|Jr\.?)$/, '') });
      a = pa; b = pb;
    }
  };
  [['FirstQuarter', 0], ['SecondQuarter', 600], ['ThirdQuarter', 1200], ['ForthQuarter', 1800]].forEach(([k, base]) => walk(pbp[k] || [], base, 600));
  // Alle Verlängerungen stehen in derselben Liste, jede beginnt mit „BP“
  const parts = [];
  for (const r of pbp.ExtraTime || []) {
    if (String(r.PLAYTYPE).trim() === 'BP' || !parts.length) parts.push([]);
    parts.at(-1).push(r);
  }
  parts.forEach((rows, i) => walk(rows, 2400 + 300 * i, 300));
  const end = 2400 + 300 * parts.length;
  const net = (e, s) => (e.da - e.db) * s;
  const free = ev.map(() => true), runs = [];
  for (;;) {
    let best = null;
    for (const s of [1, -1]) {
      for (let i = 0; i < ev.length; i++) {
        if (!free[i] || net(ev[i], s) <= 0) continue;
        let sum = 0;
        for (let j = i; j < ev.length && free[j] && ev[j].t - ev[i].t <= RUN_SECONDS; j++) {
          sum += net(ev[j], s);
          if (net(ev[j], s) > 0 && (!best || sum > best.sum)) best = { sum, i, j, s };
        }
      }
    }
    if (!best || best.sum < RUN_MIN) break;
    const part = ev.slice(best.i, best.j + 1);
    for (let k = best.i; k <= best.j; k++) free[k] = false;
    const who = new Map();
    for (const e of part) if (net(e, best.s) > 0 && e.p) who.set(e.p, (who.get(e.p) || 0) + e.da + e.db);
    const first = part[0], lastEv = part.at(-1);
    runs.push({ s: best.s, t0: first.t, t1: lastEv.t, f: [first.a - first.da, first.b - first.db], to: [lastEv.a, lastEv.b],
      ra: part.reduce((x, e) => x + e.da, 0), rb: part.reduce((x, e) => x + e.db, 0),
      who: [...who].sort((x, y) => y[1] - x[1]).slice(0, 3).map((x) => x[0]) });
  }
  runs.sort((x, y) => x.t0 - y.t0);
  return { end, ev: ev.map((e) => [e.t, e.a, e.b]), runs, dec: live ? -1 : decisiveRun(ev, runs) };
}

// Der Lauf des Siegers, in dem er die Führung für immer übernommen hat. Wenn das in keinen Lauf fällt und das Spiel klar
// ausging: sein grösster Lauf. Enge Spiele ohne solchen Lauf haben keine entscheidende Phase.
function decisiveRun(ev, runs) {
  const end = ev.at(-1);
  if (!end || end.a === end.b) return -1;
  const w = end.a > end.b ? 1 : -1;
  let take = 0;
  ev.forEach((e, i) => { if ((e.a - e.b) * w <= 0) take = i + 1; });
  const at = ev[Math.min(take, ev.length - 1)].t;
  const mine = runs.filter((r) => r.s === w);
  const hit = mine.find((r) => r.t0 <= at && at <= r.t1);
  if (hit) return runs.indexOf(hit);
  if (Math.abs(end.a - end.b) < 10 || !mine.length) return -1;
  const size = (r) => Math.abs(r.ra - r.rb);
  return runs.indexOf(mine.reduce((x, y) => (size(y) > size(x) ? y : x)));
}

// Team-Kennzahlen pro 100 Ballbesitze. Die Schnittstelle liefert keine Ballbesitze für Teams, darum die übliche Schätzung.
export function buildTeamStats(trad, adv, oppTrad, oppAdv) {
  const byCode = (raw) => new Map((raw?.teams || []).map((t) => [String(t.team?.code || ''), t]));
  const a = byCode(adv), o = byCode(oppTrad), oa = byCode(oppAdv);
  const poss = (t) => (Number(t.twoPointersAttempted) || 0) + (Number(t.threePointersAttempted) || 0) + 0.44 * (Number(t.freeThrowsAttempted) || 0)
    - (Number(t.offensiveRebounds) || 0) + (Number(t.turnovers) || 0);
  const teams = {};
  for (const t of trad?.teams || []) {
    const code = String(t.team?.code || ''), op = o.get(code), ad = a.get(code);
    if (!code || !op || !ad || !oa.get(code)) continue;
    const p = poss(t), q = poss(op);
    if (!p || !q) continue;
    const ortg = r1(t.pointsScored / p * 100), drtg = r1(op.pointsScored / q * 100);
    teams[code] = { gp: Number(t.gamesPlayed) || 0, ortg, drtg, net: r1(ortg - drtg), pace: r1((p + q) / 2), efg: pctNum(ad.effectiveFieldGoalPercentage),
      p3: pctNum(t.threePointersPercentage), tov: pctNum(ad.turnoversRatio), oreb: pctNum(ad.offensiveReboundsPercentage), ftr: pctNum(ad.freeThrowsRate) };
  }
  return teams;
}

// Wurfzone wie auf der Spielerseite (app.js, shotZone): Würfe von weit hinter der Mittellinie und ohne Ort zählen nicht
export function shotZone(x, y, v) {
  if (y > 900 || (x === 0 && y === 0)) return '';
  const side = x < 0 ? 'l' : 'r', angle = Math.atan2(Math.abs(x), y) * 180 / Math.PI;
  if (v === 3) return y < 141.5 ? `c3${side}` : angle < 22 ? 't3' : `w3${side}`;
  const d = Math.hypot(x, y);
  return d <= 150 ? 'rim' : d <= 300 ? 'short' : angle < 30 ? 'm2c' : `m2${side}`;
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

// ---------- Spielerseite ----------
const nice = (w) => String(w || '').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const rosters = new Map(), clubNames = new Map(), playerPages = new Map();

// Kader eines Teams (Rückennummer, Position, letzter Verein, Fotos) – ändert sich selten
async function rosterOf(season, team) {
  const hit = rosters.get(team);
  if (hit && Date.now() - hit.at < ROSTER_MS) return hit.data;
  const data = await getJson(`https://api-live.euroleague.net/v2/competitions/E/seasons/${season}/clubs/${team}/people`);
  rosters.set(team, { at: Date.now(), data });
  return data;
}
// Name eines (auch früheren) Vereins, z. B. „ZAG“ → „KK Zagreb“
// Die Karriere nennt Vereine teils mit TV-Kürzel („EFS“ statt „IST“): dann über die Vereine der Saison suchen
let seasonClubs = { at: 0, season: '', data: [] };
async function clubName(code, season) {
  if (!code) return '';
  if (clubNames.has(code)) return clubNames.get(code);
  let name = await getJson(`https://api-live.euroleague.net/v2/clubs/${code}`).then((c) => String(c?.name || '')).catch(() => '');
  if (!name) {
    if (seasonClubs.season !== season || Date.now() - seasonClubs.at > ROSTER_MS) {
      const list = await getJson(`https://api-live.euroleague.net/v2/competitions/E/seasons/${season}/clubs`).catch(() => null);
      seasonClubs = { at: Date.now(), season, data: Array.isArray(list?.data) ? list.data : [] };
    }
    name = String(seasonClubs.data.find((c) => c.tvCode === code || c.code === code)?.name || '');
  }
  if (name) clubNames.set(code, name);
  return name;
}

export function buildPlayerPage(id, season, bio, entry, seasonStats, careerRaw) {
  const a = seasonStats?.averagePerGame || {};
  const pr = (v) => pctNum(v);
  const avg = { gp: Number(a.gamesPlayed) || 0, gs: Number(a.totalGamesStarted) || 0, min: r1((Number(a.timePlayed) || 0) / 60),
    pts: r1(a.points), reb: r1(a.totalRebounds), oreb: r1(a.offensiveRebounds), ast: r1(a.assistances), stl: r1(a.steals), tov: r1(a.turnovers),
    blk: r1(a.blocksFavour), fd: r1(a.foulsReceived), pir: r1(a.valuation), pm: r1(a.plusMinus),
    fg2: [r1(a.fieldGoalsMade2), r1(a.fieldGoalsAttempted2)], fg3: [r1(a.fieldGoalsMade3), r1(a.fieldGoalsAttempted3)], ft: [r1(a.freeThrowsMade), r1(a.freeThrowsAttempted)],
    fga: r1(a.fieldGoalsAttemptedTotal), fta: r1(a.freeThrowsAttempted),
    fg2p: pr(a.twoPointShootingPercentage), fg3p: pr(a.threePointShootingPercentage), ftp: pr(a.freeThrowShootingPercentage) };
  const games = (seasonStats?.games || []).map((x) => {
    const g = x.game || {}, st = x.stats || {};
    return { r: Number(g.round) || 0, utc: String(g.utcDate || ''), home: String(g.local?.club?.code || ''), away: String(g.road?.club?.code || ''),
      hs: Number(g.local?.score) || 0, as: Number(g.road?.score) || 0, team: String(x.playerClubCode || ''), start: Boolean(st.startFive),
      min: Math.round((Number(st.timePlayed) || 0) / 60), pts: Number(st.points) || 0, reb: Number(st.totalRebounds) || 0, ast: Number(st.assistances) || 0,
      stl: Number(st.steals) || 0, tov: Number(st.turnovers) || 0, pir: Number(st.valuation) || 0, pm: Number(st.plusMinus) || 0 };
  }).filter((g) => g.r).sort((x, y) => x.utc.localeCompare(y.utc));
  const career = [];
  for (const comp of Array.isArray(careerRaw) ? careerRaw : []) {
    for (const s of comp.seasons || []) {
      const st = s.stats || {};
      career.push({ comp: String(comp.competitionAlias || comp.competitionCode || ''), season: String(s.seasonAlias || ''),
        year: Number((/\d{4}/.exec(String(s.seasonAlias || '')) || [])[0]) || 0, team: s.teamCode ? String(s.teamCode) : '', teamName: '',
        logo: String(s.teamLogo || ''), gp: Number(st.gamesPlayed) || 0, min: Math.round((Number(st.timePlayed) || 0) / 60),
        pts: Number(st.points) || 0, reb: Number(st.totalRebounds) || 0, ast: Number(st.assistances) || 0, pir: Number(st.valuation) || 0 });
    }
  }
  // Ohne Teamcode (z. B. Nachwuchsturnier): über das gleiche Logo einem bekannten Verein zuordnen
  for (const c of career) if (!c.team && c.logo) c.team = career.find((x) => x.team && x.logo === c.logo)?.team || '';
  career.sort((x, y) => x.year - y.year || x.comp.localeCompare(y.comp));
  const person = bio || entry?.person || {};
  const [last, first] = String(person.name || '').split(',').map((x) => x.trim());
  const img = entry?.images?.headshot || entry?.images?.action || '';
  return { id, first: nice(first), last: nice(last), no: String(entry?.dorsal || '').trim(), pos: String(entry?.positionName || ''),
    team: String(entry?.club?.code || games.at(-1)?.team || ''), img: /^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//.test(img) ? img : '',
    country: String(person.country?.name || ''), countryCode: String(person.country?.code || ''), height: Number(person.height) || 0,
    weight: Number(person.weight) || 0, birth: String(person.birthDate || '').slice(0, 10), lastTeam: nice(entry?.lastTeam || ''),
    since: String(entry?.startDate || '').slice(0, 10), avg, games, career };
}

// ---------- Würfe der Saison (für die Wurfkarte der Spielerseite) ----------
const pointsCache = new Map();
async function pointsOf(season, code) {
  const hit = pointsCache.get(code);
  if (hit && Date.now() - hit.at < POINTS_MS) return hit.data;
  const data = buildShots(await getJson(`https://live.euroleague.net/api/Points?gamecode=${code}&seasoncode=${season}`));
  pointsCache.set(code, { at: Date.now(), data });
  if (pointsCache.size > 400) pointsCache.delete(pointsCache.keys().next().value);
  return data;
}
async function seasonShots(season, id, seasonStats) {
  const games = (seasonStats?.games || []).map((x) => ({ code: Number(x.game?.gameCode) || 0, r: Number(x.game?.round) || 0 })).filter((g) => g.code);
  const lists = await Promise.all(games.map((g) => pointsOf(season, g.code).then((l) => l.filter((s) => s.id === id).map(({ x, y, m, v }) => ({ x, y, m, v, r: g.r }))).catch(() => [])));
  return lists.flat();
}

// ---------- Vereinsgeschichte aus Wikipedia (Infobox „years/team“), Liga und Land aus Wikidata ----------
const histories = new Map();
const plain = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
async function sparql(q) {
  const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(q)}`, { headers: { accept: 'application/sparql-results+json', 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`sparql ${res.status}`);
  return (await res.json())?.results?.bindings || [];
}
const titleOf = (url) => decodeURIComponent(String(url || '').split('/wiki/')[1] || '').replace(/_/g, ' ');
// Englischer Wikipedia-Artikel: über die EuroLeague-ID (Wikidata P3536), sonst Basketballer mit gleichem Geburtsdatum und Namen
async function wikiArticle(id, first, last, birth) {
  const byId = await sparql(`SELECT ?a WHERE { ?p wdt:P3536 "${id}" . ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }`);
  if (byId[0]) return titleOf(byId[0].a.value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return '';
  const rows = await sparql(`SELECT ?l ?a WHERE { ?p wdt:P106 wd:Q3665646 ; wdt:P569 ?b . FILTER(?b = "${birth}T00:00:00Z"^^xsd:dateTime) ?p rdfs:label ?l . FILTER(LANG(?l) = "en") ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }`);
  const want = plain(`${first} ${last}`), lastN = plain(last);
  const hit = rows.find((r) => plain(r.l.value) === want) || rows.find((r) => plain(r.l.value).split(' ').includes(lastN.split(' ').pop()));
  return hit ? titleOf(hit.a.value) : '';
}
// Wikitext aufräumen: [[Ziel|Text]] → Text, {{nbay|2016|start}} → 2016, Fussnoten weg
function wikiClean(v) {
  return String(v || '').replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '').replace(/<[^>]+>/g, '')
    .replace(/\{\{\s*nbay\s*\|\s*(\d{4})[^}]*\}\}/gi, '$1').replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '').replace(/&nbsp;/g, ' ').trim();
}
export function parseCareer(wikitext) {
  const box = String(wikitext || '');
  const fields = {};
  const re = /\|\s*(years|team)(\d+)\s*=\s*((?:\[\[[^\]]*\]\]|\{\{[^}]*\}\}|<ref[\s\S]*?<\/ref>|[^|\n])*)/g;
  let m;
  while ((m = re.exec(box))) (fields[m[2]] ||= {})[m[1]] = m[3];
  return Object.keys(fields).map(Number).sort((a, b) => a - b).map((k) => {
    const raw = fields[k], teamRaw = String(raw.team || '').trim();
    const link = /\[\[([^\]|]+)/.exec(teamRaw);
    const yrs = wikiClean(raw.years);
    const y = /(\d{4})(?:\s*[–—-]\s*(\d{4}|present))?/i.exec(yrs);
    if (!y) return null;
    return { from: Number(y[1]), to: y[2] ? (/present/i.test(y[2]) ? null : Number(y[2])) : Number(y[1]),
      team: wikiClean(teamRaw).replace(/^→\s*/, ''), article: link ? link[1].trim() : '', loan: teamRaw.startsWith('→') };
  }).filter((h) => h && h.team);
}
async function historyOf(id, first, last, birth) {
  const hit = histories.get(id);
  if (hit && Date.now() - hit.at < HISTORY_MS) return hit.data;
  let data = [];
  try {
    const title = await wikiArticle(id, first, last, birth);
    if (title) {
      const wp = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`,
        { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json());
      data = parseCareer(wp?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content);
      // Liga (ohne Europacups) und Land der Vereine; Weiterleitungen der Artikelnamen zuerst auflösen
      const arts = [...new Set(data.map((h) => h.article).filter(Boolean))].slice(0, 50);
      const canon = {};
      if (arts.length) {
        const rq = await fetch(`https://en.wikipedia.org/w/api.php?action=query&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(arts.join('|'))}`,
          { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.json()).catch(() => null);
        for (const a of arts) canon[a] = a.replace(/_/g, ' ');
        for (const n of rq?.query?.normalized || []) for (const a of arts) if (canon[a] === n.from) canon[a] = n.to;
        for (const r of rq?.query?.redirects || []) for (const a of arts) if (canon[a] === r.from) canon[a] = r.to;
        const iri = (t) => `<https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_')).replace(/%2C/g, ',').replace(/%3A/g, ':')}>`;
        const rows = await sparql(`SELECT ?a ?lgLabel ?cLabel WHERE { VALUES ?a { ${[...new Set(Object.values(canon))].map(iri).join(' ')} } ?a schema:about ?t .
          OPTIONAL { ?t wdt:P118 ?lg } OPTIONAL { ?t wdt:P17 ?c } SERVICE wikibase:label { bd:serviceParam wikibase:language "de,en". } }`).catch(() => []);
        const info = {};
        for (const r of rows) {
          const t = titleOf(r.a.value), e = (info[t] ||= { leagues: [], country: '' });
          const lg = r.lgLabel?.value || '';
          if (lg && !/^Q\d+$/.test(lg) && !e.leagues.includes(lg)) e.leagues.push(lg);
          if (!e.country && r.cLabel?.value && !/^Q\d+$/.test(r.cLabel.value)) e.country = r.cLabel.value;
        }
        for (const h of data) {
          const e = info[canon[h.article]] || {};
          h.league = (e.leagues || []).find((l) => !/euroleague|eurocup|champions league|europe cup|fiba|basketball league europe/i.test(l)) || '';
          h.country = e.country || '';
        }
      }
      // Artikelname behalten (Link auf Wikipedia in den Stationen), Weiterleitungen aufgelöst
      for (const h of data) h.article = h.article ? (canon[h.article] || h.article) : '';
    }
  } catch { /* Wikipedia nicht erreichbar: nur EuroLeague-Stationen */ }
  histories.set(id, { at: Date.now(), data });
  return data;
}

// ---------- Statistiken & Fakten ----------
const NBA_TEAMS = new Set(['Atlanta Hawks', 'Boston Celtics', 'Brooklyn Nets', 'New Jersey Nets', 'Charlotte Hornets', 'Charlotte Bobcats', 'Chicago Bulls',
  'Cleveland Cavaliers', 'Dallas Mavericks', 'Denver Nuggets', 'Detroit Pistons', 'Golden State Warriors', 'Houston Rockets', 'Indiana Pacers',
  'Los Angeles Clippers', 'LA Clippers', 'Los Angeles Lakers', 'Memphis Grizzlies', 'Vancouver Grizzlies', 'Miami Heat', 'Milwaukee Bucks',
  'Minnesota Timberwolves', 'New Orleans Pelicans', 'New Orleans Hornets', 'New Orleans/Oklahoma City Hornets', 'New York Knicks', 'Oklahoma City Thunder',
  'Seattle SuperSonics', 'Orlando Magic', 'Philadelphia 76ers', 'Phoenix Suns', 'Portland Trail Blazers', 'Sacramento Kings', 'San Antonio Spurs',
  'Toronto Raptors', 'Utah Jazz', 'Washington Wizards', 'Washington Bullets']);
let facts = { at: 0, season: '', data: null };
async function wikiBatch(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const part = titles.slice(i, i + 50);
    const d = await fetch(`https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(part.join('|'))}`,
      { headers: { 'user-agent': WIKI_UA }, signal: AbortSignal.timeout(TIMEOUT_MS * 2) }).then((r) => r.json()).catch(() => null);
    const map = {};
    for (const t of part) map[t] = t;
    for (const n of d?.query?.normalized || []) for (const t of part) if (map[t] === n.from) map[t] = n.to;
    for (const r of d?.query?.redirects || []) for (const t of part) if (map[t] === r.from) map[t] = r.to;
    const text = {};
    for (const pg of d?.query?.pages || []) text[pg.title] = pg.revisions?.[0]?.slots?.main?.content || '';
    for (const t of part) if (text[map[t]]) out[t] = text[map[t]];
  }
  return out;
}
async function factsOf(season) {
  if (facts.season === season && facts.data && Date.now() - facts.at < FACTS_MS) return facts.data;
  const clubs = await getJson(`https://api-live.euroleague.net/v2/competitions/E/seasons/${season}/clubs`);
  const codes = (Array.isArray(clubs?.data) ? clubs.data : []).map((c) => String(c.code || '')).filter(Boolean);
  const rosters = await Promise.all(codes.map((c) => rosterOf(season, c).then((r) => ({ c, r })).catch(() => ({ c, r: [] }))));
  const roster = [];
  for (const { c, r } of rosters) for (const e of Array.isArray(r) ? r : []) {
    if (e?.typeName !== 'Player' || e.active === false || !e.person?.code) continue;
    const pr = e.person, [last, first] = String(pr.name || '').split(',').map((x) => x.trim());
    const img = e.images?.headshot || '';
    roster.push({ id: pr.code, name: playerName(pr.name), first: nice(first), last: nice(last), team: c, birth: String(pr.birthDate || '').slice(0, 10),
      height: Number(pr.height) || 0, country: String(pr.country?.code || ''), countryName: String(pr.country?.name || ''),
      img: /^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//.test(img) ? img : '' });
  }
  const active = new Set(roster.map((p) => p.id));
  // Ewige Bestenlisten (alle Spieler seit 2000/01, Summen)
  const all = await fetch('https://api-live.euroleague.net/v3/competitions/E/statistics/players/traditional?seasonMode=All&statisticMode=Accumulated&limit=5000',
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS * 3) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const rows = (all?.players || []).map((s) => ({ id: String(s.player?.code || ''), name: playerName(s.player?.name), team: String(s.player?.team?.code || '').split(';').pop().trim(),
    gp: Number(s.gamesPlayed) || 0, pts: Number(s.pointsScored) || 0, reb: Number(s.totalRebounds) || 0, ast: Number(s.assists) || 0, pir: Number(s.pir) || 0,
    fg3m: Number(s.threePointersMade) || 0, blk: Number(s.blocks) || 0, stl: Number(s.steals) || 0 }));
  const alltime = {};
  for (const k of ['gp', 'pts', 'reb', 'ast', 'pir', 'fg3m', 'blk', 'stl']) {
    alltime[k] = [...rows].sort((a, b) => b[k] - a[k]).slice(0, 10).map((r) => ({ id: r.id, name: r.name, team: r.team, value: r[k], active: active.has(r.id) }));
  }
  // NBA-Erfahrung: Wikipedia-Artikel über die EuroLeague-ID, sonst über Geburtsdatum + Name; Infobox nach NBA-Teams durchsuchen
  const article = {};
  try {
    const ids = roster.map((p) => `"${p.id}"`).join(' ');
    for (const r of await sparql(`SELECT ?id ?a WHERE { VALUES ?id { ${ids} } ?p wdt:P3536 ?id . ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }`)) article[r.id.value] = titleOf(r.a.value);
    const rest = roster.filter((p) => !article[p.id] && /^\d{4}-\d{2}-\d{2}$/.test(p.birth));
    if (rest.length) {
      const dates = [...new Set(rest.map((p) => `"${p.birth}T00:00:00Z"^^xsd:dateTime`))].join(' ');
      const cand = await sparql(`SELECT ?b ?l ?a WHERE { VALUES ?b { ${dates} } ?p wdt:P106 wd:Q3665646 ; wdt:P569 ?b ; rdfs:label ?l . FILTER(LANG(?l) = "en") ?a schema:about ?p ; schema:isPartOf <https://en.wikipedia.org/> }`);
      for (const p of rest) {
        const want = plain(`${p.first} ${p.last}`);
        const hit = cand.find((c) => c.b.value.startsWith(p.birth) && plain(c.l.value) === want);
        if (hit) article[p.id] = titleOf(hit.a.value);
      }
    }
  } catch { /* Wikidata nicht erreichbar */ }
  const texts = await wikiBatch([...new Set(Object.values(article))]).catch(() => ({}));
  const nbaPlayers = [];
  let known = 0;
  for (const p of roster) {
    const w = texts[article[p.id]];
    if (!w) continue;
    known++;
    const teams = [...new Set(parseCareer(w).filter((h) => !h.loan && NBA_TEAMS.has(h.team)).map((h) => h.team))];
    if (teams.length) nbaPlayers.push({ id: p.id, name: p.name, team: p.team, nba: teams });
  }
  const data = { updated: new Date().toISOString(), total: roster.length, alltime,
    nba: { count: nbaPlayers.length, known, players: nbaPlayers },
    roster: { players: roster.map(({ first, last, ...r }) => r) } };
  facts = { at: Date.now(), season, data };
  return data;
}

async function playerOf(season, id, team) {
  const key = `${id}:${team}`;
  const hit = playerPages.get(key);
  if (hit && Date.now() - hit.at < PLAYER_MS) return hit.data;
  const base = 'https://api-live.euroleague.net/v2';
  const [bio, seasonStats, careerRaw] = await Promise.all([
    getJson(`${base}/people/${id}`).catch(() => null),
    getJson(`${base}/competitions/E/seasons/${season}/people/${id}/stats`).catch(() => null),
    getJson(`${base}/people/${id}/stats`).catch(() => []),
  ]);
  if (!bio && !seasonStats) throw new Error('unbekannt');
  const club = team || String(seasonStats?.games?.at?.(-1)?.playerClubCode || '');
  const roster = club ? await rosterOf(season, club).catch(() => []) : [];
  const entry = (Array.isArray(roster) ? roster : []).find((p) => p?.person?.code === id) || null;
  const data = buildPlayerPage(id, season, bio, entry, seasonStats, careerRaw);
  const [history, shots] = await Promise.all([
    historyOf(id, data.first, data.last, data.birth).catch(() => []),
    seasonShots(season, id, seasonStats).catch(() => []),
    Promise.all(data.career.map(async (c) => { c.teamName = await clubName(c.team, season); })),
  ]);
  data.history = history; data.shots = shots;
  playerPages.set(key, { at: Date.now(), data });
  if (playerPages.size > 300) playerPages.delete(playerPages.keys().next().value);
  return data;
}

const boxes = new Map();
async function boxOf(season, code) {
  const hit = boxes.get(code);
  if (hit && Date.now() - hit.at < (hit.data.live ? BOX_LIVE_MS : BOX_FINAL_MS)) return hit.data;
  const [raw, points, plays] = await Promise.all([
    getJson(`https://live.euroleague.net/api/Boxscore?gamecode=${code}&seasoncode=${season}`),
    getJson(`https://live.euroleague.net/api/Points?gamecode=${code}&seasoncode=${season}`).catch(() => null),
    getJson(`https://live.euroleague.net/api/PlaybyPlay?gamecode=${code}&seasoncode=${season}`).catch(() => null),
  ]);
  const box = buildBox(code, raw);
  const data = { ...box, shots: buildShots(points), flow: buildFlow(plays, box.live) };
  // Noch ohne Spieler (Spiel nicht begonnen): nur kurz merken
  boxes.set(code, { at: data.teams.some((t) => t.players.length) ? Date.now() : Date.now() - BOX_FINAL_MS + BOX_LIVE_MS, data });
  return data;
}

// Bankpunkte und Liga-Quoten: beendete Spiele ändern sich nicht mehr, darum wird jedes nur einmal gelesen und
// das Ergebnis in el_fb_cache gesammelt. Pro Abruf höchstens rund 12 Sekunden Arbeit, den Rest holt der nächste Abruf.
const EXTRAS_BUDGET_MS = 12000, EXTRAS_BATCH = 8;
async function extrasOf(season) {
  const key = `el-extras:${season}`;
  const store = (await videoCacheGet(key)) || { done: {}, bench: {}, zones: {} };
  const schedule = await loadSchedule(season);
  const todo = (schedule?.data || []).filter((g) => g.played && !store.done[g.gameCode]);
  const stop = Date.now() + EXTRAS_BUDGET_MS;
  const before = Object.keys(store.done).length;
  for (let i = 0; i < todo.length && Date.now() < stop; i += EXTRAS_BATCH) {
    const read = await Promise.all(todo.slice(i, i + EXTRAS_BATCH).map(async (g) => {
      try {
        const q = `gamecode=${g.gameCode}&seasoncode=${season}`;
        const [cmp, points] = await Promise.all([getJson(`https://live.euroleague.net/api/Comparison?${q}`), getJson(`https://live.euroleague.net/api/Points?${q}`)]);
        return cmp.PointsBenchA == null || cmp.PointsBenchB == null ? null : { g, cmp, shots: buildShots(points) };
      } catch { return null; }
    }));
    for (const r of read) {
      if (!r) continue;
      store.done[r.g.gameCode] = 1;
      for (const [club, side] of [[r.g.local?.club?.code, 'A'], [r.g.road?.club?.code, 'B']]) {
        const b = (store.bench[club] ||= [0, 0, 0]);
        b[0] += Number(r.cmp[`PointsBench${side}`]) || 0; b[1] += Number(r.cmp[`PointsStarters${side}`]) || 0; b[2]++;
      }
      for (const s of r.shots) {
        const z = shotZone(s.x, s.y, s.v);
        if (!z) continue;
        const c = (store.zones[z] ||= [0, 0]);
        c[1]++; if (s.m) c[0]++;
      }
    }
  }
  if (Object.keys(store.done).length !== before) await videoCacheSet(key, store);
  return { ...store, pending: (schedule?.data || []).filter((g) => g.played && !store.done[g.gameCode]).length };
}

let teamStats = { at: 0, season: '', data: null };
async function teamStatsOf(season) {
  if (teamStats.season === season && teamStats.data && Date.now() - teamStats.at < TEAMSTATS_MS) return teamStats.data;
  const url = (k) => `https://api-live.euroleague.net/v3/competitions/E/statistics/teams/${k}?seasonMode=Single&seasonCode=${season}&statisticMode=PerGame&limit=40`;
  const [trad, adv, oppTrad, oppAdv, extras] = await Promise.all([getJson(url('traditional')), getJson(url('advanced')), getJson(url('opponentsTraditional')), getJson(url('opponentsAdvanced')), extrasOf(season)]);
  const teams = buildTeamStats(trad, adv, oppTrad, oppAdv);
  for (const [code, t] of Object.entries(teams)) {
    const [bench, start, n] = extras.bench[code] || [0, 0, 0];
    if (n) Object.assign(t, { bench: r1(bench / n), start: r1(start / n), share: r1(bench / ((bench + start) || 1) * 100) });
  }
  const data = { updated: new Date().toISOString(), pending: extras.pending, teams, zones: extras.zones };
  // Solange Spiele fehlen, nicht merken: der nächste Abruf arbeitet weiter
  teamStats = { at: extras.pending ? 0 : Date.now(), season, data };
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

// ---------- Videos (YouTube-Kanal der EuroLeague) ----------
const YT_UPLOADS = 'UUGr3nR_XH9r6E5b09ZJAT9w'; // Uploads-Liste des Kanals UCGr3nR_XH9r6E5b09ZJAT9w
const VIDEOS_MS = 30 * 60 * 1000;
const KIND_ORDER = { main: 0, last5: 1, player: 2, pre: 3, other: 4 };
// Wörter in Vereinsnamen, die mehrere Teams teilen oder in Titeln sonst vorkommen
const NAME_STOP = new Set(['basketball', 'basket', 'club', 'istanbul', 'belgrade', 'aviv', 'real']);
// Titel/Namen vergleichbar machen, mit Ziffern (für „R9“, „last 5“) und Leerzeichen an beiden Enden
const words = (s) => ` ${String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

export function videoKind(title) {
  const t = words(title);
  if (/ (last|ultimi|ultimos) 5 /.test(t)) return 'last5';
  if (/ player highlights | highlights giocatore | jugador /.test(t)) return 'player';
  if (/ pregame | atmosphere | warm up /.test(t)) return 'pre';
  if (/ highlights /.test(t) && / r\d+ | round /.test(t)) return 'main';
  return 'other';
}

// ISO-8601-Dauer („PT8M27S“) → Sekunden
export function isoSeconds(s) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(s || ''));
  return m ? ((Number(m[1]) || 0) * 86400) + ((Number(m[2]) || 0) * 3600) + ((Number(m[3]) || 0) * 60) + (Number(m[4]) || 0) : 0;
}

// Videos ({ id, title, at: ms, d }) → { Spielcode: [Video] }. Ein Video gehört zu einem Spiel, wenn im Titel beide
// Teams vorkommen und es zwischen 6 Stunden vor und 6 Tagen nach dem Beginn erschien (bei zwei Duellen derselben
// Teams entscheidet das nähere). Kurzvideos (bis 60 s) bleiben weg.
export function matchVideos(videos, payload) {
  const tokens = {};
  for (const [code, t] of Object.entries(payload?.teams || {})) {
    tokens[code] = [...new Set(words(`${t.name} ${t.short}`).trim().split(' ').filter((w) => w.length >= 4 && !NAME_STOP.has(w)))];
  }
  const has = (title, code) => (tokens[code] || []).some((w) => title.includes(` ${w}`));
  const games = (payload?.games || []).map((g) => ({ ...g, at: Date.parse(g.utc) }));
  const out = {};
  for (const v of videos) {
    if (!v.id || v.d <= 60) continue;
    const title = words(v.title);
    let best = null;
    for (const g of games) {
      if (v.at < g.at - 6 * 3600e3 || v.at > g.at + 6 * 864e5) continue;
      if (!has(title, g.home) || !has(title, g.away)) continue;
      if (!best || Math.abs(v.at - g.at) < Math.abs(v.at - best.at)) best = g;
    }
    if (!best) continue;
    (out[best.code] ||= []).push({ id: v.id, t: v.title, k: videoKind(v.title), d: v.d, at: new Date(v.at).toISOString() });
  }
  return out;
}

// Neue Zuordnung in die gespeicherte einfügen (ein Video nur einmal), pro Spiel nach Art und Zeit sortiert
export function mergeVideos(old, add) {
  const games = { ...(old || {}) };
  for (const [code, list] of Object.entries(add || {})) {
    const byId = new Map((games[code] || []).map((v) => [v.id, v]));
    for (const v of list) byId.set(v.id, v);
    games[code] = [...byId.values()].sort((a, b) => (KIND_ORDER[a.k] ?? 9) - (KIND_ORDER[b.k] ?? 9) || a.at.localeCompare(b.at)).slice(0, 8);
  }
  return games;
}

async function ytGet(path, key) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  return res.json();
}

const videoMem = new Map();
async function videoCacheGet(key) {
  if (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?key=eq.${encodeURIComponent(key)}&select=data`, { headers: serviceHeaders(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.ok) return (await r.json())[0]?.data || null;
    } catch { /* Tabelle fehlt: Arbeitsspeicher */ }
  }
  return videoMem.get(key) || null;
}
async function videoCacheSet(key, data) {
  videoMem.set(key, data);
  if (!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return;
  await fetch(`${SUPABASE_URL}/rest/v1/el_fb_cache?on_conflict=key`, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, data, at: new Date().toISOString() }), signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => {});
}

let videoLoading = null;
async function videosOf(season, now) {
  const key = Deno.env.get('YOUTUBE_KEY') || '';
  if (!key) return { updated: now.toISOString(), games: {} };
  const ck = `el-videos:${season}`;
  const stored = await videoCacheGet(ck);
  if (stored && Date.now() - Date.parse(stored.updated) < VIDEOS_MS) return stored;
  // Gleichzeitige Aufrufe teilen sich einen Abruf
  videoLoading ||= (async () => {
    try {
      // Neuste Uploads zuerst; weiterblättern, bis ein schon bekanntes Video kommt (seen = jüngster Upload beim letzten
      // Abruf), höchstens 4 Seiten = 200 Uploads (rund zwei Wochen). So fehlt auch nach Tagen ohne Aufruf nichts.
      const seen = Date.parse(stored?.seen || '') || 0;
      const uploadAt = (it) => Date.parse(it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || '') || 0;
      const items = [];
      let token = '';
      for (let i = 0; i < 4; i++) {
        const d = await ytGet(`playlistItems?part=contentDetails,snippet&maxResults=50&playlistId=${YT_UPLOADS}${token ? `&pageToken=${token}` : ''}`, key);
        const page = d.items || [];
        items.push(...page.filter((it) => uploadAt(it) > seen));
        token = d.nextPageToken || '';
        if (!token || page.some((it) => uploadAt(it) <= seen)) break;
      }
      const ids = items.map((it) => it.contentDetails?.videoId).filter(Boolean);
      const dur = new Map();
      for (let i = 0; i < ids.length; i += 50) {
        const d = await ytGet(`videos?part=contentDetails&id=${ids.slice(i, i + 50).join(',')}`, key);
        for (const v of d.items || []) dur.set(v.id, isoSeconds(v.contentDetails?.duration));
      }
      const videos = items.map((it) => ({ id: it.contentDetails?.videoId, title: String(it.snippet?.title || ''),
        at: Date.parse(it.contentDetails?.videoPublishedAt || it.snippet?.publishedAt || ''), d: dur.get(it.contentDetails?.videoId) || 0 }))
        .filter((v) => v.id && Number.isFinite(v.at));
      const payload = await buildPayload(await loadSchedule(season), now, async () => null);
      const newest = Math.max(seen, ...videos.map((v) => v.at));
      const data = { updated: new Date().toISOString(), seen: newest ? new Date(newest).toISOString() : '', games: mergeVideos(stored?.games, matchVideos(videos, payload)) };
      await videoCacheSet(ck, data);
      return data;
    } catch (err) {
      if (stored) return stored;
      throw err;
    } finally {
      videoLoading = null;
    }
  })();
  return videoLoading;
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

function handleGate(body, cors) {
  const headers = { ...cors, 'Content-Type': 'application/json' };
  const gateKey = Deno.env.get('GATE_KEY') || '';
  const gateCode = Deno.env.get('GATE_CODE') || '';
  const key = String(body?.key ?? '');
  const code = String(body?.code ?? '');
  const ok = Boolean(gateKey) && Boolean(gateCode) && sameString(key, gateKey) && sameString(code, gateCode);
  return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 401, headers });
}

// ---------- Profile (Name + PIN, geräteübergreifende Lieblingsteams) ----------
const SUPABASE_URL = 'https://vbipkljatgandplwould.supabase.co';
const PROFILES_URL = `${SUPABASE_URL}/rest/v1/el_profiles`;
const TEAM_CODE_RE = /^[A-Z]{2,4}$/;

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function serviceHeaders() {
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

function cleanFavorites(favorites) {
  if (!Array.isArray(favorites)) return [];
  return [...new Set(favorites.map((f) => String(f || '').trim().toUpperCase()).filter((f) => TEAM_CODE_RE.test(f)))].slice(0, 14);
}

// Fussball-Lieblingsteams: genaue Teamnamen (Spalte fb_favorites, jsonb; null = noch nie gespeichert)
function cleanFbFavorites(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((n) => String(n || '').trim().slice(0, 60)).filter(Boolean))].slice(0, 40);
}

async function findProfile(key) {
  // select=* statt fester Spalten: funktioniert auch, solange die Spalte fb_favorites noch nicht angelegt ist
  const res = await fetch(`${PROFILES_URL}?key=eq.${encodeURIComponent(key)}&select=*`, { headers: serviceHeaders() });
  if (!res.ok) throw new Error(`profiles ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function handleProfile(body, cors) {
  const headers = { ...cors, 'Content-Type': 'application/json' };
  if (!Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) return new Response(JSON.stringify({ ok: false, error: 'nicht eingerichtet' }), { status: 500, headers });
  const name = String(body?.name ?? '').trim().slice(0, 40);
  const pin = String(body?.pin ?? '').trim();
  const key = name.toLowerCase();
  if (!key || !/^\d{4,8}$/.test(pin)) return new Response(JSON.stringify({ ok: false, error: 'ungültig' }), { status: 400, headers });
  try {
    if (body.kind === 'profile-create') {
      const existing = await findProfile(key);
      if (existing) return new Response(JSON.stringify({ ok: false, error: 'vergeben' }), { status: 409, headers });
      const pin_hash = await sha256Hex(`${pin}:${key}`);
      const favorites = cleanFavorites(body.favorites);
      const res = await fetch(PROFILES_URL, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify([{ key, name, pin_hash, favorites }]) });
      if (!res.ok) throw new Error(`create ${res.status}`);
      return new Response(JSON.stringify({ ok: true, name, favorites }), { headers });
    }
    if (body.kind === 'profile-login') {
      const row = await findProfile(key);
      if (!row) return new Response(JSON.stringify({ ok: false, error: 'unbekannt' }), { status: 404, headers });
      const pin_hash = await sha256Hex(`${pin}:${key}`);
      if (!sameString(pin_hash, row.pin_hash)) return new Response(JSON.stringify({ ok: false, error: 'pin' }), { status: 401, headers });
      return new Response(JSON.stringify({ ok: true, name: row.name, favorites: row.favorites || [], fbFavorites: Array.isArray(row.fb_favorites) ? row.fb_favorites : null }), { headers });
    }
    if (body.kind === 'profile-fbsave') {
      const row = await findProfile(key);
      if (!row) return new Response(JSON.stringify({ ok: false, error: 'unbekannt' }), { status: 404, headers });
      const pin_hash = await sha256Hex(`${pin}:${key}`);
      if (!sameString(pin_hash, row.pin_hash)) return new Response(JSON.stringify({ ok: false, error: 'pin' }), { status: 401, headers });
      const fb_favorites = cleanFbFavorites(body.fbFavorites);
      const res = await fetch(`${PROFILES_URL}?key=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: { ...serviceHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify({ fb_favorites, updated_at: new Date().toISOString() }) });
      if (!res.ok) throw new Error(`fbsave ${res.status}`);
      return new Response(JSON.stringify({ ok: true, fbFavorites: fb_favorites }), { headers });
    }
    if (body.kind === 'profile-save') {
      const row = await findProfile(key);
      if (!row) return new Response(JSON.stringify({ ok: false, error: 'unbekannt' }), { status: 404, headers });
      const pin_hash = await sha256Hex(`${pin}:${key}`);
      if (!sameString(pin_hash, row.pin_hash)) return new Response(JSON.stringify({ ok: false, error: 'pin' }), { status: 401, headers });
      const favorites = cleanFavorites(body.favorites);
      const res = await fetch(`${PROFILES_URL}?key=eq.${encodeURIComponent(key)}`, { method: 'PATCH', headers: { ...serviceHeaders(), Prefer: 'return=minimal' }, body: JSON.stringify({ favorites, updated_at: new Date().toISOString() }) });
      if (!res.ok) throw new Error(`save ${res.status}`);
      return new Response(JSON.stringify({ ok: true, favorites }), { headers });
    }
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'serverfehler' }), { status: 502, headers });
  }
  return new Response(JSON.stringify({ ok: false, error: 'unbekannte Aktion' }), { status: 400, headers });
}

async function handle(req) {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }); }
    if (body && typeof body.kind === 'string' && body.kind.startsWith('profile-')) return handleProfile(body, cors);
    return handleGate(body, cors);
  }
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
  if (params.has('teamstats')) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    try {
      const d = await teamStatsOf(season);
      return new Response(JSON.stringify(d), { headers: { ...headers, 'Cache-Control': `public, max-age=${d.pending ? 5 : 600}` } });
    } catch {
      return new Response(JSON.stringify({ error: 'Die Teamwerte sind gerade nicht erreichbar.' }), { status: 502, headers });
    }
  }
  if (params.has('videos')) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    try {
      return new Response(JSON.stringify(await videosOf(season, now)), { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    } catch {
      return new Response(JSON.stringify({ error: 'Die Videos sind gerade nicht erreichbar.' }), { status: 502, headers });
    }
  }
  if (params.has('facts')) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    try {
      return new Response(JSON.stringify(await factsOf(season)), { headers: { ...headers, 'Cache-Control': 'public, max-age=3600' } });
    } catch {
      return new Response(JSON.stringify({ error: 'Die Statistiken sind gerade nicht erreichbar.' }), { status: 502, headers });
    }
  }
  const player = params.get('player');
  if (player != null) {
    const headers = { ...cors, 'Content-Type': 'application/json' };
    const team = String(params.get('team') || '').toUpperCase();
    if (!/^\d{3,8}$/.test(player) || (team && !TEAM_CODE_RE.test(team))) return new Response(JSON.stringify({ error: 'ungültiger Spieler' }), { status: 400, headers });
    try {
      return new Response(JSON.stringify(await playerOf(season, player, team)), { headers: { ...headers, 'Cache-Control': 'public, max-age=600' } });
    } catch {
      return new Response(JSON.stringify({ error: 'Die Spielerdaten sind gerade nicht erreichbar.' }), { status: 502, headers });
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
