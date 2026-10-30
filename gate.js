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

function remember(key) {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
    localStorage.setItem('el-gate-key', key);
  } catch {}
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

// Dieselben Pfade wie das Logo im Kopfbereich (index.html .brand-logo) – einmal gross/blass als
// Hintergrund-„Schatten“, einmal klein als Wappen über der Code-Eingabe.
const LOGO_PATHS = `<path d="M271.64,232.27h0.26c0,0,96.95,47.56,164.99,62.77c3.92,0.69,4.18,1.54,4.18,2.64l-2.88,2.23
  c-64.32,13.4-166.35,62.01-166.61,62.13c-0.07,0.02-79.1,34.87-79.19,78.46c-0.07,25.38,18.49,47.42,25.31,55.26l3.76,4.14
  c51.27,50.74,121.74,82.12,199.53,82.28c123.64,0.26,229.05-78.34,268.6-188.43c-0.93-4.63-9.72-5.51-18.7-4.54
  C524.9,405.04,481.93,526.92,481.29,528.21c-122.78,37.46-113.97-32.11-113.97-32.11c-0.14-49.75,95.17-113.42,172.05-145.34
  c10.05-4.16,75.08-28.88,159.24-38.57c5.4-0.43,7.27-5.06,7.53-9.55c0.36-6.56,0.31-10.93-0.67-16.68
  c-1.26-5.61-6.11-6.96-9.84-7.32c-10.34-1.28-20.13-2.64-29.4-4.06c-29.35-5.06-75.96-15.59-126.73-36.22
  c-55.59-22.55-170.34-81.19-171.34-139.59c0,0-8.53-69.62,114.11-31.63c0.62,1.26,43.09,123.35,188.98,139.8
  c8.98,1.02,17.78,0.17,18.73-4.49C650.92,92.19,545.87,13.11,422.23,12.85c-77.82-0.17-148.41,30.92-199.91,81.43l-3.76,4.14
  c-6.87,7.8-25.48,29.78-25.6,55.14C192.85,184.03,228.31,210.86,271.64,232.27"/>
  <path d="M159.67,404.32c1.21,0,3.64-0.36,3.64-2.88c0.07-29.02,32.32-54.59,72.87-75.3c21.46-10.32,44.18-20.42,65.27-26.53
  l3.02-2.23l-3.71-2.64c-18.16-6.44-44.09-16.92-66.07-27.5c-39.71-20.72-70.97-46.13-70.92-74.77c0.02-2.52-2.43-2.9-3.61-2.9
  l-3.37,3.35c-12.72,32.18-19.73,67.26-19.82,103.98c-0.07,36.7,6.8,71.8,19.37,104.05L159.67,404.32z"/>`;

function showPrompt(key) {
  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <svg class="gate-mark" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${LOGO_PATHS}</svg>
    <form class="gate-card" id="gateForm">
      <svg class="gate-crest" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${LOGO_PATHS}</svg>
      <h1>Zugangscode</h1>
      <p>Diese Seite ist nur für einen eingeladenen Kreis zugänglich.</p>
      <input id="gateCode" type="password" inputmode="text" autocomplete="off" placeholder="Code eingeben" aria-label="Zugangscode">
      <button type="submit" id="gateGo" class="onboarding-go">Weiter</button>
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
      remember(key);
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
    form.classList.remove('has-error');
    void form.offsetWidth; // Reflow erzwingen, damit die Animation bei wiederholtem Fehler erneut abspielt
    form.classList.add('has-error');
  });
}

function showRelinkNotice() {
  const gate = document.createElement('div');
  gate.className = 'gate';
  gate.innerHTML = `
    <svg class="gate-mark" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${LOGO_PATHS}</svg>
    <div class="gate-card">
      <svg class="gate-crest" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${LOGO_PATHS}</svg>
      <h1>Abgemeldet</h1>
      <p>Zum erneuten Anmelden bitte den ursprünglichen Zugangslink nochmal öffnen.</p>
    </div>`;
  document.body.appendChild(gate);
}

if (unlocked()) {
  cleanUrl();
  boot();
} else {
  const key = new URLSearchParams(location.search).get('key');
  if (key) showPrompt(key);
  else if (sessionStorage.getItem('el-gate-relogin') === '1') { sessionStorage.removeItem('el-gate-relogin'); showRelinkNotice(); }
  // Sonst (fremder Besuch ohne Link): Seite bleibt leer – keine Fehlermeldung, kein Hinweis.
}
