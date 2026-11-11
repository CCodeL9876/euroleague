// Tests für die reinen Funktionen der Supabase-Funktionen (ohne Netz, ohne Datenbank).
// Auf dem Mac ohne Installation:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m supabase/functions/tests.mjs
// oder mit Deno: deno run supabase/functions/tests.mjs
import { fplSame, elDetect, elMessage, mapOldb, parseFootballCareer } from './fussball/index.ts';
import { buildPayload, gameExcitement } from './euroleague/index.ts';

const out = globalThis.print || console.log;
let failed = 0, passed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed++; else { failed++; out(`FEHLER ${name}\n  erhalten: ${JSON.stringify(got)}\n  erwartet: ${JSON.stringify(want)}`); }
};

// --- Fussball: FPL-Namen. Die Zuordnung in fplApply verlangt Heim UND Gast, weil einzelne Namen zu ähnlich sind ---
eq('fplSame Man City', fplSame('Man City', 'Manchester City'), true);
eq('fplSame Spurs', fplSame('Spurs', 'Tottenham Hotspur'), true);
eq('fplSame Newcastle', fplSame('Newcastle', 'Newcastle United'), true);
eq('fplSame Arsenal/Chelsea', fplSame('Arsenal', 'Chelsea'), false);
// Bekannte Schwäche des Präfix-Vergleichs (darum Heim UND Gast): die beiden Manchester-Klubs gelten einzeln als gleich
const pair = (fh, fa, h, a) => fplSame(fh, h) && fplSame(fa, a);
eq('Paar United–Arsenal ≠ City–Chelsea', pair('Man Utd', 'Arsenal', 'Manchester City', 'Chelsea'), false);
eq('Paar City–Chelsea', pair('Man City', 'Chelsea', 'Manchester City', 'Chelsea'), true);

// --- Fussball: OpenLigaDB ---
const oldb = (extra) => ({ matchID: 1, matchDateTimeUTC: '2026-11-07T12:00:00Z', team1: { teamName: 'A' }, team2: { teamName: 'B' }, goals: [], matchResults: [], ...extra });
const lg = { id: 'bl2' }, ko = Date.parse('2026-11-07T12:00:00Z');
eq('oldb vor Anpfiff', mapOldb(lg, oldb({}), ko - 60000).st, 'pre');
eq('oldb läuft', mapOldb(lg, oldb({ goals: [{ matchMinute: 10, scoreTeam1: 1, scoreTeam2: 0, goalGetterName: 'X' }] }), ko + 30 * 60000).hs, 1);
const fin = mapOldb(lg, oldb({ matchIsFinished: true, matchResults: [{ resultTypeID: 2, pointsTeam1: 2, pointsTeam2: 1 }] }), ko + 3 * 3600e3);
eq('oldb Endstand', [fin.st, fin.hs, fin.as], ['ft', 2, 1]);

// --- Fussball: Karriere aus Wikipedia ---
const car = parseFootballCareer('| years1 = 2015–2018 | clubs1 = [[FC Basel]] | caps1 = 50 | goals1 = 7\n| nationalyears1 = 2016– | nationalteam1 = [[Switzerland national football team|Switzerland]]');
eq('Karriere Klub', car.find((c) => c.kind === 'club'), { kind: 'club', team: 'FC Basel', loan: false, from: 2015, to: 2018, gp: 50, g: 7 });
eq('Karriere Nationalteam offen', car.find((c) => c.kind === 'nat')?.to, null);

// --- EuroLeague-Mitteilungen: Viertel, Verlängerung, Schluss ---
const G = (status, period, clock, hs, as) => ({ code: 7, utc: '2026-11-11T19:45:00Z', home: 'OLY', away: 'MAD', status, period, clock, hs, as });
const run = (seq) => { let st; const evs = []; for (const [g, pq] of seq) { const r = elDetect(g, st, pq || 0); st = r.st; if (r.ev) { if (r.ev.kind === 'final') st.final = true; evs.push(r.ev.kind + (r.ev.q || '')); } } return evs; };
eq('ganzes Spiel mit Verlängerung', run([[G('live', '', '', 0, 0)], [G('live', '1', '08:10', 4, 2)], [G('live', '1', '00:00', 22, 18)], [G('live', '1', '00:00', 22, 18)],
  [G('live', '2', '09:30', 24, 18)], [G('live', '', '00:00', 40, 44), 2], [G('live', '3', '05:00', 50, 55)], [G('live', '4', '09:50', 60, 60)],
  [G('live', '5', '04:00', 82, 80)], [G('final', '', '00:00', 91, 88)], [G('final', '', '00:00', 91, 88)]]), ['q1', 'q2', 'q3', 'ot', 'final']);
eq('mitten im Spiel entdeckt: nichts nachmelden', run([[G('live', '3', '05:00', 50, 55)], [G('live', '4', '09:00', 60, 62)], [G('final', '', '', 70, 75)]]), ['q3', 'final']);
eq('nie live gesehen: kein Schluss', run([[G('final', '', '', 70, 75)]]), []);
const nm = (c) => c, ev = { g: G('final', '', '', 91, 88), kind: 'final', hs: 91, as: 88 };
eq('Sieg-Text', elMessage(ev, new Set(['OLY']), nm, 0).title, '🏀 Vamooooos! Sieg für OLY');
eq('Niederlage-Text', elMessage(ev, new Set(['MAD']), nm, 0).title, '😤 Niederlage für MAD');

// --- EuroLeague: Phase im Spielplan, Spannungs-Bewertung ---
const game = (code, round, phase) => ({ gameCode: code, round, phaseType: { code: phase }, utcDate: '2026-04-01T18:00:00', played: true,
  local: { club: { code: 'AAA', name: 'A' }, score: 80 }, road: { club: { code: 'BBB', name: 'B' }, score: 70 } });
const pay = await buildPayload({ data: [game(1, 38, 'RS'), game(2, 39, 'PI')] }, new Date('2026-07-01'), async () => null);
eq('Phase wird mitgegeben', pay.games.map((g) => g.ph), ['RS', 'PI']);
const row = (t, a, b) => ({ MARKERTIME: t, POINTS_A: a, POINTS_B: b, PLAYER: 'X, Y' });
const close = gameExcitement({ FirstQuarter: [row('09:00', 2, 0), row('08:00', 2, 3), row('07:00', 5, 3)], SecondQuarter: [], ThirdQuarter: [], ForthQuarter: [row('00:30', 5, 6), row('00:05', 7, 6)] });
const blow = gameExcitement({ FirstQuarter: [row('09:00', 10, 0)], SecondQuarter: [row('05:00', 30, 5)], ThirdQuarter: [], ForthQuarter: [row('01:00', 60, 20)] });
eq('knappes Spiel schlägt Kantersieg', close.score > blow.score, true);
eq('später Führungswechsel als Grund', close.why, 'Krimi bis zur Schlusssirene');
eq('Verlängerung als Grund', gameExcitement({ FirstQuarter: [row('09:00', 2, 0)], ForthQuarter: [row('00:10', 2, 2)], ExtraTime: [{ PLAYTYPE: 'BP' }, row('01:00', 4, 2)] }).why, 'Verlängerung');

out(`${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed) throw new Error('Tests fehlgeschlagen');
