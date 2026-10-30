// Zugriffsschutz: zwei einfache Hürden, kein echtes Login, keine Benutzerkonten.
// 1) Ein geheimer Link-Parameter (?key=...), den nur bekommt, wem der Link weitergegeben wurde.
// 2) Ein gemeinsamer Code, den alle berechtigten Personen kennen (Abfrage über eine eingeblendete Karte).
// Beide Werte werden NICHT im Quelltext verglichen, sondern an die Supabase-Funktion „euroleague“ geschickt
// (POST { key, code }), die sie gegen ihre eigenen Secrets GATE_KEY/GATE_CODE prüft (Supabase-Dashboard →
// Edge Functions → Secrets). So steht hier nichts Geheimes im Repo/Quelltext – nur eine Hürde gegen
// zufällige Besucher:innen, kein Schutz gegen jemanden, der die Netzwerk-Anfragen mitliest.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const STORAGE_KEY = 'el-gate-ok';
const CHECK_URL = `${SUPABASE_URL}/functions/v1/euroleague`;

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

function showPrompt(key) {
  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <form class="gate-card" id="gateForm">
      <h1>Zugangscode</h1>
      <p>Diese Seite ist nur für einen eingeladenen Kreis zugänglich.</p>
      <input id="gateCode" type="password" inputmode="text" autocomplete="off" placeholder="Code eingeben" aria-label="Zugangscode">
      <button type="submit" id="gateGo">Weiter</button>
      <p class="gate-err" id="gateErr" hidden>Falscher Code. Nochmal versuchen.</p>
    </form>`;
  document.body.appendChild(gate);

  const form = gate.querySelector('#gateForm');
  const input = gate.querySelector('#gateCode');
  const btn = gate.querySelector('#gateGo');
  const err = gate.querySelector('#gateErr');
  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;
    btn.disabled = true;
    btn.textContent = 'Prüfe …';
    const ok = await verify(key, code);
    if (ok) {
      remember();
      cleanUrl();
      gate.remove();
      boot();
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Weiter';
    err.hidden = false;
    input.value = '';
    input.focus();
  });
}

if (unlocked()) {
  cleanUrl();
  boot();
} else {
  const key = new URLSearchParams(location.search).get('key');
  if (key) showPrompt(key);
  // Ohne ?key=... in der URL bleibt die Seite leer – keine Fehlermeldung, kein Hinweis.
}
