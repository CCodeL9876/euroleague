// Zugriffsschutz: zwei einfache Hürden, kein echtes Login, keine Benutzerkonten.
// 1) Ein geheimer Link-Parameter (?key=...), den nur bekommt, wem der Link weitergegeben wurde.
// 2) Ein gemeinsamer Code, den alle berechtigten Personen kennen (Abfrage per natives window.prompt()).
// Beide Werte werden NICHT im Quelltext verglichen, sondern an die Supabase-Funktion „euroleague“ geschickt
// (POST { key, code }), die sie gegen ihre eigenen Secrets GATE_KEY/GATE_CODE prüft (Supabase-Dashboard →
// Edge Functions → Secrets). So steht hier nichts Geheimes im Repo/Quelltext – nur eine Hürde gegen
// zufällige Besucher:innen, kein Schutz gegen jemanden, der die Netzwerk-Anfragen mitliest.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const STORAGE_KEY = 'el-gate-ok';
const CHECK_URL = `${SUPABASE_URL}/functions/v1/euroleague`;
const MAX_TRIES = 5;

function unlocked() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

function remember() {
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
}

function boot() {
  document.body.classList.add('unlocked');
  import('./app.js');
}

function cleanUrl() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has('key')) {
      u.searchParams.delete('key');
      history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    }
  } catch {}
}

async function verify(key, code) {
  try {
    const res = await fetch(CHECK_URL, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ key, code }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => null);
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

async function askCode(key) {
  let message = 'Zugangscode für Sport-News Euroleague:';
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const input = window.prompt(message);
    if (input === null) return false; // abgebrochen
    const code = input.trim();
    if (!code) { message = 'Zugangscode für Sport-News Euroleague:'; continue; }
    if (await verify(key, code)) return true;
    message = 'Falscher Code. Nochmal versuchen:';
  }
  return false;
}

(async () => {
  if (unlocked()) {
    cleanUrl();
    boot();
    return;
  }
  const key = new URLSearchParams(location.search).get('key');
  if (!key) return; // kein Hinweis, kein Popup – Seite bleibt leer
  if (await askCode(key)) {
    remember();
    cleanUrl();
    boot();
  }
})();
