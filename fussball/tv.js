// TV: Rechteinhaber in der Schweiz und in Deutschland, Saison 2026/27 (keine Quelle liefert den Sender pro Spiel).
// Bundesliga und 2. Bundesliga nach Anstosszeit (Sky Einzelspiele, DAZN Konferenz und Sonntag). Länderspiele nur mit
// Schweiz (SRF) bzw. Deutschland (Heimspiel ARD/ZDF, auswärts RTL). Bei Rechtewechseln hier anpassen.
const NAT_LEAGUES = new Set(['unl', 'wcq', 'emq', 'wc', 'em', 'fr']);
export function tvOf(m) {
  const z = Object.fromEntries(new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(m.utc)).map((p) => [p.type, p.value]));
  const wd = z.weekday || '', hm = `${z.hour}:${z.minute}`;
  if (NAT_LEAGUES.has(m.l)) {
    const sui = /^(switzerland|schweiz)$/i, ger = /^(germany|deutschland)$/i;
    return { ch: sui.test(m.h) || sui.test(m.a) ? 'SRF' : '', de: ger.test(m.h) ? 'ARD/ZDF' : ger.test(m.a) ? 'RTL' : '' };
  }
  switch (m.l) {
    case 'ucl': return { ch: 'blue Sport', de: /^Di/.test(wd) ? 'DAZN · Prime' : 'DAZN' };
    case 'chsl': case 'chcl': return { ch: 'blue Sport', de: '' };
    case 'pl': return { ch: 'Sky · blue Sport', de: 'Sky' };
    case 'laliga': case 'seriea': case 'ligue1': return { ch: 'DAZN', de: 'DAZN' };
    case 'bl1': {
      const de = /^So/.test(wd) ? 'DAZN' : (/^Sa/.test(wd) && hm === '15:30') || /^(Di|Mi)/.test(wd) ? 'Sky · DAZN Konferenz' : 'Sky';
      return { ch: de, de };
    }
    case 'bl2': return { ch: 'Sky', de: /^Sa/.test(wd) && hm === '20:30' ? 'Sky · RTL' : 'Sky' };
    default: return { ch: '', de: '' };
  }
}
