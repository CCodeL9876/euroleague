// Euroleague-Seite: holt alle Spiele der Saison (mit Live-Ständen) über die Supabase-Funktion „euroleague“ und die
// Meldungen aus news.json (täglich von einer Claude-Aufgabe geschrieben) und zeichnet daraus das Dashboard.
// Während ein Spiel läuft, fragt die Seite jede Minute nach, sonst alle 10 Minuten und beim Zurückkehren zur Seite.

import { SUPABASE_URL, SUPABASE_ANON_KEY, KI_NEWS_URL, RUBRIKEN } from './config.js';

const FAV_COLOR = { PAN: '#4CC38A', OLY: '#EE5F68', PAM: '#E8935F', ULK: '#5B7CFA' };
const FAV_PALETTE = ['#4CC38A', '#EE5F68', '#E8935F', '#5B7CFA', '#C86DD7', '#2EC4C6', '#D4A72C', '#8E8CFF'];
function favColor(c) {
  if (FAV_COLOR[c]) return FAV_COLOR[c];
  let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FAV_PALETTE[h % FAV_PALETTE.length];
}
const SHORT = { PAM: 'VAL', ULK: 'FEN', IST: 'EFS', MAD: 'RMB', TEL: 'MTA', RED: 'CZV', BAS: 'BKN', BES: 'BJK', MUN: 'FCB' };
const SHORTNAME = { PAN: 'Panathinaikos', OLY: 'Olympiacos', PAR: 'Partizan', ASV: 'ASVEL', ULK: 'Fenerbahce', BAR: 'Barcelona', ZAL: 'Zalgiris',
  MUN: 'Bayern', PAM: 'Valencia', DUB: 'Dubai', MAD: 'Real Madrid', BES: 'Besiktas', HTA: 'Hapoel TA', RED: 'Zvezda', IST: 'Efes', TEL: 'Maccabi',
  VIR: 'Virtus', MIL: 'Milano', BAS: 'Baskonia', PRS: 'Paris' };
const KEYS = { HTA: ['hapoel'], IST: ['efes'], PAN: ['panathinaikos'], OLY: ['olympiacos'], PAM: ['valencia'], ULK: ['fenerbah'],
  MAD: ['real madrid', 'real '], BAR: ['barcelona', 'barça'], RED: ['zvezda'], PAR: ['partizan'], ZAL: ['zalgiris'], VIR: ['virtus', 'bologna'],
  MIL: ['milano', 'milan', 'olimpia'], BAS: ['baskonia'], ASV: ['asvel'], MUN: ['bayern'], DUB: ['dubai'], BES: ['besiktas'], TEL: ['maccabi'], PRS: ['paris'] };
// Lieblingsteams: lokal zwischengespeichert, mit Profil (Name+PIN) geräteübergreifend synchronisiert (siehe „Profil“ unten)
let FAV = (() => {
  try {
    const v = JSON.parse(localStorage.getItem('el-fav-teams') || 'null');
    if (Array.isArray(v) && v.length) return v.filter((c) => SHORTNAME[c]);
  } catch { /* privates Fenster */ }
  return ['PAN', 'OLY', 'PAM', 'ULK'];
})();
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const LIVE_POLL_MS = 60 * 1000;
const IDLE_POLL_MS = 10 * 60 * 1000;
const NEWS_POLL_MS = 30 * 60 * 1000;

// Zum Testen auf dem eigenen Rechner: ?data=datei.json statt der Supabase-Funktion
const params = new URLSearchParams(location.search);
const testData = /^[\w-]+\.json$/.test(params.get('data') || '') ? params.get('data') : '';
const DATA_URL = testData || `${SUPABASE_URL}/functions/v1/euroleague`;

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privates Fenster */ } },
};

// ---------- Hilfen ----------
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ICON = {
  ball: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M6 6c3 3 3 9 0 12M18 6c-3 3-3 9 0 12"/>',
  chat: '<path d="M4 5h16v12H8l-4 4z"/>',
  star: '<path d="m12 3 2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z"/>',
  bars: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
};
const icon = (name, cls = 'icon') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;

// Datum in der Schweiz (JJJJ-MM-TT, HH:MM)
const zParts = (d, opts) => {
  const o = {};
  try { new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hourCycle: 'h23', ...opts }).formatToParts(d).forEach((x) => { o[x.type] = x.value; }); } catch { /* alter Browser */ }
  return o;
};
const zDate = (d) => { const o = zParts(d, { year: 'numeric', month: '2-digit', day: '2-digit' }); return `${o.year}-${o.month}-${o.day}`; };
const zTime = (d) => { const o = zParts(d, { hour: '2-digit', minute: '2-digit' }); return `${o.hour}:${o.minute}`; };
function rel(dateKey) {
  const today = zDate(new Date()), tomorrow = zDate(new Date(Date.now() + 864e5));
  if (dateKey === today) return 'heute';
  if (dateKey === tomorrow) return 'morgen';
  const [y, m, d] = dateKey.split('-');
  return `${WD[new Date(Date.UTC(+y, +m - 1, +d, 12)).getUTCDay()]} ${d}.${m}.`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Zustand ----------
let data = null;       // Antwort der Funktion
let news = null;       // news.json
let dataError = '';
let sel = FAV.includes(store.get('el-team')) ? store.get('el-team') : FAV[0];
let tab = ['spiel', 'news', 'teams'].includes(store.get('el-tab')) ? store.get('el-tab') : 'spiel';
const open = { table: false, next: false, leaders: false };
let players = null;     // Saisonwerte aller Spieler (?players=1), erst bei Bedarf geladen
const leaderState = { cat: 'pts', fav: false };
const feedState = { q: '', src: '', expanded: new Set() };

// ---------- Profil ----------
// Ganz bewusst kein echtes Login: Name + 4- bis 8-stellige PIN. Die Supabase-Funktion „euroleague“ prüft die PIN
// serverseitig (gehasht, siehe supabase/functions/euroleague/index.ts) und liefert/speichert die Lieblingsteams.
// Auf diesem Gerät merkt sich die Seite Name+PIN (wie der Zugangscode), damit man sich nicht bei jedem Besuch neu
// anmelden muss; auf einem zweiten Gerät meldet man sich mit demselben Name+PIN an, um dieselben Teams zu sehen.
let profile = null; // { name } sobald angemeldet
let profileBusy = false;
let profileError = '';
let favEdit = false;
let onboarding = false; // true direkt nach dem Anlegen: Team-Wahl ist Pflicht, bevor es weitergeht
let introStage = false; // true nach der Team-Wahl: kurzer Überblick, bevor es ins Dashboard geht
// Merkt die Eingabe im Formular, damit ein Zwischen-render() (z.B. „Prüfe …“ oder nach einem Fehler) sie nicht löscht
let profileDraft = { name: store.get('el-profile-name', ''), pin: '' };

function saveLocalFav(list) { try { localStorage.setItem('el-fav-teams', JSON.stringify(list)); } catch { /* privates Fenster */ } }

async function profileCall(body) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/euroleague`, {
      method: 'POST', headers: { apikey: SUPABASE_ANON_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    const json = await res.json().catch(() => null);
    return json || { ok: false, error: 'antwort' };
  } catch {
    return { ok: false, error: 'netzwerk' };
  }
}

// Dieselben Pfade wie das Logo im Kopfbereich (index.html .brand-logo / gate.js) – für den Pflicht-Bildschirm,
// der ohne Profil erscheint.
const PROFILE_LOGO_PATHS = `<path d="M271.64,232.27h0.26c0,0,96.95,47.56,164.99,62.77c3.92,0.69,4.18,1.54,4.18,2.64l-2.88,2.23
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

function renderProfileGate() {
  let host = document.getElementById('profileGate');
  if (!host) { host = document.createElement('div'); host.id = 'profileGate'; document.body.appendChild(host); }
  host.className = 'gate';
  host.innerHTML = `
    <svg class="gate-mark" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${PROFILE_LOGO_PATHS}</svg>
    <div class="gate-card${profileError ? ' has-error' : ''}">
      <svg class="gate-crest" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${PROFILE_LOGO_PATHS}</svg>
      <h1>Profil nötig</h1>
      <p>Um die Seite zu nutzen, brauchst du ein eigenes Profil (Name + PIN) – damit dir deine Lieblingsteams zugeordnet werden können.</p>
      ${profileFormHtml()}
    </div>`;
}

function renderOnboarding() {
  let host = document.getElementById('profileGate');
  if (!host) { host = document.createElement('div'); host.id = 'profileGate'; document.body.appendChild(host); }
  host.className = 'gate';
  host.innerHTML = `
    <svg class="gate-mark" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${PROFILE_LOGO_PATHS}</svg>
    <div class="gate-card gate-card-wide">
      <svg class="gate-crest" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${PROFILE_LOGO_PATHS}</svg>
      <h1>Lieblingsteams wählen</h1>
      <p>Willkommen, ${esc(profile.name)}! Wähle mindestens ein Team – deine Spiele werden dann hervorgehoben.</p>
      ${favEditHtml()}
      <button type="button" class="onboarding-go" data-act="onboarding-done"${FAV.length ? '' : ' disabled'}>Weiter</button>
    </div>`;
}

function renderIntro() {
  let host = document.getElementById('profileGate');
  if (!host) { host = document.createElement('div'); host.id = 'profileGate'; document.body.appendChild(host); }
  host.className = 'gate';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installHint = ios
    ? 'Tipp: In Safari oben auf Teilen und dann «Zum Home-Bildschirm» – danach öffnet sich die Seite wie eine App.'
    : 'Tipp: Im Browser-Menü «App installieren» bzw. «Zum Startbildschirm hinzufügen» wählen – danach öffnet sich die Seite wie eine App.';
  host.innerHTML = `
    <svg class="gate-mark" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${PROFILE_LOGO_PATHS}</svg>
    <div class="gate-card gate-card-wide">
      <svg class="gate-crest" viewBox="135 8 572 579" aria-hidden="true" focusable="false">${PROFILE_LOGO_PATHS}</svg>
      <h1>Das kannst du hier</h1>
      <ul class="intro-list">
        <li>${icon('ball')}Live-Spielstände, Viertel für Viertel mit und ohne Wurfkarte</li>
        <li>${icon('bars')}Tabelle, Bestenlisten und Spielerstatistik der ganzen Saison</li>
        <li>${icon('star')}Deine Lieblingsteams überall hervorgehoben</li>
        <li>${icon('trend')}Teamseiten mit Kader, Form und Saisonverlauf</li>
        <li>${icon('chat')}Tägliche News aus den wichtigsten Basketball-Portalen</li>
      </ul>
      <p class="profile-hint">${esc(installHint)}</p>
      <button type="button" class="onboarding-go" data-act="intro-done">Let's Go</button>
    </div>`;
}

function enterApp() {
  document.body.classList.remove('needs-profile');
  document.getElementById('profileGate')?.remove();
  boot();
}

// 'in'=Dashboard öffnen, 'onboarding'=Teamwahl nachholen (z.B. Tab vor Abschluss der Anmeldung geschlossen), 'out'=Pflicht-Fenster
async function ensureProfile() {
  const name = store.get('el-profile-name', ''), pin = store.get('el-profile-pin', '');
  if (name && pin) {
    const res = await profileCall({ kind: 'profile-login', name, pin });
    if (res.ok) {
      profile = { name: res.name || name };
      if (Array.isArray(res.favorites) && res.favorites.length) { FAV = res.favorites; saveLocalFav(FAV); return 'in'; }
      FAV = []; saveLocalFav(FAV);
      return 'onboarding';
    }
    if (res.error === 'pin' || res.error === 'unbekannt') { store.set('el-profile-name', ''); store.set('el-profile-pin', ''); }
  }
  return 'out';
}

// Ohne Profil kein Zugriff: solange body.needs-profile, zeigt ein Re-render das passende Pflicht-Fenster statt des Dashboards
function refreshProfileUI() {
  if (!document.body.classList.contains('needs-profile')) return render();
  if (introStage) renderIntro(); else if (onboarding) renderOnboarding(); else renderProfileGate();
}

async function profileLogin(name, pin) {
  profileBusy = true; profileError = ''; refreshProfileUI();
  const res = await profileCall({ kind: 'profile-login', name, pin });
  profileBusy = false;
  if (res.ok) {
    profile = { name: res.name || name };
    store.set('el-profile-name', name); store.set('el-profile-pin', pin);
    favEdit = false;
    profileDraft = { name: '', pin: '' };
    if (Array.isArray(res.favorites) && res.favorites.length) {
      FAV = res.favorites; saveLocalFav(FAV);
      enterApp();
    } else {
      FAV = []; saveLocalFav(FAV);
      onboarding = true;
      refreshProfileUI();
    }
    return;
  }
  profileError = res.error === 'pin' ? 'Falsche PIN.' : res.error === 'unbekannt' ? 'Unbekannter Name – «Neu anlegen» verwenden.' : 'Das hat gerade nicht geklappt.';
  refreshProfileUI();
}

async function profileCreate(name, pin) {
  profileBusy = true; profileError = ''; refreshProfileUI();
  const res = await profileCall({ kind: 'profile-create', name, pin, favorites: [] });
  profileBusy = false;
  if (res.ok) {
    profile = { name: res.name || name };
    store.set('el-profile-name', name); store.set('el-profile-pin', pin);
    favEdit = false;
    profileDraft = { name: '', pin: '' };
    FAV = []; saveLocalFav(FAV); // neues Profil: Teamwahl ist Pflicht, keine Vorauswahl übernehmen
    onboarding = true;
    refreshProfileUI();
    return;
  }
  profileError = res.error === 'vergeben' ? 'Dieser Name ist schon vergeben – stattdessen anmelden?' : 'Das hat gerade nicht geklappt.';
  refreshProfileUI();
}

// Abmelden sperrt die Seite sofort wieder – ohne Profil ist kein Weiterschauen möglich
// Die Homebildschirm-App hat (v.a. auf iOS) einen eigenen Speicher und keine Adresszeile: dort fügt man diesen Link
// im Fenster „Zugang nötig“ ein (gate.js). Der Schlüssel stammt aus der eigenen, bereits erfolgten Anmeldung.
async function copyAccessLink() {
  const key = store.get('el-gate-key', '');
  if (!key) { toast('Link nicht gespeichert – einmal oben rechts abmelden und mit dem Zugangslink neu anmelden.'); return; }
  const url = `${location.origin}${location.pathname}?key=${encodeURIComponent(key)}`;
  try { await navigator.clipboard.writeText(url); toast('Link kopiert – in der Home-App bei «Zugang nötig» einfügen.'); }
  catch { window.prompt('Link kopieren:', url); }
}

function profileLogout() {
  profile = null; profileError = ''; favEdit = false; onboarding = false; introStage = false;
  store.set('el-profile-name', ''); store.set('el-profile-pin', '');
  document.body.classList.add('needs-profile');
  renderProfileGate();
}

async function toggleFav(code) {
  const i = FAV.indexOf(code);
  if (i >= 0) { if (FAV.length <= 1) return; FAV.splice(i, 1); } else FAV.push(code);
  if (FAV.length && !FAV.includes(sel)) sel = FAV[0];
  saveLocalFav(FAV);
  refreshProfileUI();
  if (profile) {
    const pin = store.get('el-profile-pin', '');
    if (pin) await profileCall({ kind: 'profile-save', name: profile.name, pin, favorites: FAV });
  }
}

// render() läuft nur, solange ein Profil besteht (siehe enterApp/ensureProfile) – kein Gast-Zustand mehr nötig
function profileHtml() {
  return `<div class="profile-bar">
    <span class="profile-who">${icon('star', 'icon')}${esc(profile.name)}</span>
    <div class="profile-acts">
      ${favEdit
        ? '<button type="button" class="profile-link" data-act="fav-edit">Fertig</button>'
        : `<button type="button" class="profile-icon" data-act="fav-edit" aria-label="Lieblingsteams bearbeiten" title="Lieblingsteams bearbeiten">${icon('star')}</button>`}
      <button type="button" class="profile-icon" data-act="copy-link" aria-label="Link für Home-App kopieren" title="Link für Home-App kopieren">${icon('share')}</button>
      <button type="button" class="profile-icon" data-act="profile-logout" aria-label="Profil abmelden" title="Profil abmelden">${icon('logout')}</button>
    </div>
  </div>${favEdit ? favEditHtml() : ''}`;
}

function profileFormHtml() {
  return `<form class="profile-form" id="profileForm">
    <input id="profName" type="text" maxlength="40" autocomplete="off" placeholder="Dein Name" aria-label="Name" value="${esc(profileDraft.name)}">
    <input id="profPin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" placeholder="PIN (4–8 Ziffern)" aria-label="PIN" value="${esc(profileDraft.pin)}">
    <div class="profile-form-acts">
      <button type="button" data-act="profile-login-go"${profileBusy ? ' disabled' : ''}>${profileBusy ? '…' : 'Anmelden'}</button>
      <button type="button" data-act="profile-create-go"${profileBusy ? ' disabled' : ''}>${profileBusy ? '…' : 'Neu anlegen'}</button>
    </div>
    ${profileError ? `<p class="profile-err">${esc(profileError)}</p>` : '<p class="profile-hint">Name + PIN merken: Auf jedem Gerät damit anmelden, um dieselben Lieblingsteams zu sehen.</p>'}
  </form>`;
}

// Wappen, falls Spieldaten schon geladen sind (unabhängig vom Profilstatus, siehe loadData() ganz unten);
// ohne Daten (z.B. offline bei der allerersten Anmeldung) einfach ohne Bild, Name reicht dann als Beschriftung
function teamLogo(c) {
  const crest = data?.teams?.[c]?.crest || '';
  return /^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//.test(crest) ? `<img class="fav-pick-logo" src="${esc(crest)}" alt="" loading="lazy">` : '';
}
function favEditHtml() {
  const teams = Object.keys(SHORTNAME).sort((a, b) => SHORTNAME[a].localeCompare(SHORTNAME[b], 'de'));
  return `<div class="fav-edit" role="group" aria-label="Lieblingsteams wählen">
    ${teams.map((c) => `<button type="button" class="fav-pick" style="--c:${favColor(c)}" data-act="fav-toggle" data-c="${c}" aria-pressed="${FAV.includes(c)}">${teamLogo(c)}${esc(SHORTNAME[c])}</button>`).join('')}
  </div>${profileError ? `<p class="profile-err">${esc(profileError)}</p>` : ''}`;
}

// ---------- Ableitungen aus den Spielen ----------
function model() {
  const teams = data?.teams || {};
  const games = (data?.games || []).map((g) => ({ ...g, at: new Date(g.utc), date: zDate(new Date(g.utc)), time: zTime(new Date(g.utc)) }));
  const st = {}, hist = {};
  Object.keys(teams).forEach((c) => { st[c] = { c, s: 0, n: 0, d: 0, hs: 0, hn: 0, as: 0, an: 0 }; hist[c] = []; });
  games.filter((g) => g.status === 'final' && g.hs !== g.as).sort((a, b) => a.at - b.at).forEach((g) => {
    const h = st[g.home], a = st[g.away]; if (!h || !a) return;
    h.d += g.hs - g.as; a.d += g.as - g.hs;
    if (g.hs > g.as) { h.s++; a.n++; h.hs++; a.an++; } else { a.s++; h.n++; a.as++; h.hn++; }
    hist[g.home].push({ r: g.round, d: g.hs - g.as, w: g.hs > g.as }); hist[g.away].push({ r: g.round, d: g.as - g.hs, w: g.as > g.hs });
  });
  const table = Object.values(st).filter((t) => t.s + t.n > 0 || teams[t.c])
    .sort((x, y) => (y.s - x.s) || (x.n - y.n) || (y.d - x.d) || x.c.localeCompare(y.c));
  table.forEach((t, i) => {
    t.rank = i + 1;
    // Serie: gleiche Ergebnisse am Stück, vom letzten Spiel rückwärts („S3“ = 3 Siege, „N2“ = 2 Niederlagen)
    const h = hist[t.c] || [];
    let k = 0; while (k < h.length && h[h.length - 1 - k].w === h[h.length - 1]?.w) k++;
    t.streak = h.length ? `${h[h.length - 1].w ? 'S' : 'N'}${k}` : '';
  });
  const rounds = {};
  games.forEach((g) => { (rounds[g.round] = rounds[g.round] || []).push(g); });
  const roundNrs = Object.keys(rounds).map(Number).sort((a, b) => a - b);
  // Letzter Spieltag mit Resultaten (läuft schon der nächste, aber ohne Resultat, bleibt der vorherige stehen)
  const lastPlayed = [...roundNrs].reverse().find((r) => rounds[r].some((g) => g.status === 'final'));
  const upcoming = games.filter((g) => g.status === 'pre' && g.at > Date.now() - 4 * 3600e3);
  return { teams, games, st, hist, table, rounds, lastPlayed, upcoming };
}

const name = (m, c) => m.teams[c]?.short || m.teams[c]?.name || c;
const fullName = (m, c) => m.teams[c]?.name || c;
const short = (c) => SHORT[c] || c;
const shortName = (m, c) => SHORTNAME[c] || name(m, c);
const rec = (m, c) => (m.st[c] ? `${m.st[c].s}–${m.st[c].n}` : '');
function logo(m, c, cls = '') {
  const crest = m.teams[c]?.crest || '';
  return `<span class="logo${cls ? ` ${cls}` : ''}">${/^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//.test(crest) ? `<img src="${esc(crest)}" alt="" loading="lazy">` : esc(short(c))}</span>`;
}

// „3. Viertel · 4:12“, „Halbzeit“
function liveLabel(g) {
  const n = Number((/\d+/.exec(g.period || '') || [])[0]);
  const part = n >= 1 && n <= 4 ? `${n}. Viertel` : n > 4 ? 'Verlängerung' : '';
  const clock = /^\d{1,2}:\d\d$/.test(g.clock || '') && g.clock !== '00:00' ? g.clock.replace(/^0(?=\d:)/, '') : '';
  if (part && g.clock === '00:00') return n === 2 ? 'Halbzeit' : `Ende ${n}. Viertel`;
  // In Pausen und vor dem Sprungball liefert die EuroLeague kein Viertel
  if (!part && g.clock === '00:00') return 'Pause';
  if (!part && !g.hs && !g.as) return 'Gleich Sprungball';
  return [part, clock].filter(Boolean).join(' · ');
}

// Antippen öffnet den Spielbericht (openBox)
function boxTarget(node, m, g) {
  node.dataset.act = 'box'; node.dataset.code = g.code;
  node.setAttribute('role', 'button'); node.tabIndex = 0;
  node.setAttribute('aria-label', `Spielbericht ${name(m, g.home)} gegen ${name(m, g.away)}`);
}
const boxAttrs = (m, g) => `data-act="box" data-code="${g.code}" role="button" tabindex="0" aria-label="Spielbericht ${esc(name(m, g.home))} gegen ${esc(name(m, g.away))}"`;

// Eine Spielzeile: Heim | Resultat, Live-Stand oder Anspielzeit | Gast
function gameRow(m, g, hl) {
  const done = g.status === 'final';
  const side = (c, win, away) => {
    const cls = `side${away ? ' away' : ''}${done ? (win ? ' win' : ' lose') : ''}${FAV.includes(c) ? ' fav' : ''}`;
    return `<div class="${cls}">${logo(m, c)}<span class="nm"><span class="full">${esc(name(m, c))}</span><span class="short">${esc(shortName(m, c))}</span><small>${esc(rec(m, c))}</small></span></div>`;
  };
  const mid = g.status === 'final' ? `<span class="result num${hl ? ' hl' : ''}">${g.hs} : ${g.as}</span>`
    : g.status === 'live' ? `<span class="result live num"><small><i class="live-dot" aria-hidden="true"></i>${esc(liveLabel(g) || 'Live')}</small>${g.hs} : ${g.as}</span>`
    : `<span class="result open num"><small>${esc(rel(g.date))}</small>${esc(g.time)}</span>`;
  const row = el('div', `game${g.status === 'live' ? ' is-live' : ''}`, side(g.home, g.hs > g.as, false) + mid + side(g.away, g.as > g.hs, true));
  boxTarget(row, m, g);
  return row;
}

// ---------- Linke Spalte: deine Teams ----------
function niceStep(range) { for (const s of [5, 10, 20, 25, 50, 100, 200]) if (range / s <= 4) return s; return 500; }
function chartHtml(m, c) {
  const cum = []; let s = 0;
  (m.hist[c] || []).forEach((x) => { s += x.d; cum.push({ v: s, w: x.w }); });
  const total = m.st[c]?.d || 0;
  const head = `<div class="chart-head"><span class="chart-title">Korbdifferenz ${esc(short(c))}</span><span class="chart-value num">${total > 0 ? '+' : ''}${total}</span></div>`;
  if (!cum.length) return `${head}<p class="label">Noch keine Spiele.</p>`;
  const vals = cum.map((p) => p.v).concat([0]);
  const step = niceStep((Math.max(...vals) - Math.min(...vals)) || 10);
  const lo = Math.floor(Math.min(...vals) / step) * step;
  let hi = Math.ceil(Math.max(...vals) / step) * step; if (hi === lo) hi = lo + step;
  const X0 = 42, X1 = 248, Y0 = 18, Y1 = 140;
  const y = (v) => Y1 - (v - lo) / (hi - lo) * (Y1 - Y0);
  const x = (i) => (cum.length === 1 ? (X0 + X1) / 2 : X0 + 8 + i * (X1 - X0 - 8) / (cum.length - 1));
  let grid = '', labels = '';
  for (let v = lo; v <= hi; v += step) {
    grid += `<line x1="${X0}" y1="${y(v).toFixed(1)}" x2="${X1}" y2="${y(v).toFixed(1)}"/>`;
    labels += `<text x="${X0 - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v > 0 ? '+' : ''}${v}</text>`;
  }
  const pts = cum.map((p, i) => `${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`);
  const base = y(Math.max(lo, Math.min(0, hi))).toFixed(1);
  const dots = cum.map((p, i) => (i === cum.length - 1 ? `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4.5" class="c-end"/>`
    : p.w ? '' : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" class="c-loss"/>`)).join('');
  return `${head}<svg viewBox="0 0 260 150" role="img" aria-label="Kumulierte Korbdifferenz nach Spieltag: ${cum.map((p) => (p.v > 0 ? '+' : '') + p.v).join(', ')}. Rote Punkte sind Niederlagen.">
    <defs><linearGradient id="area-${c}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="c-area" stop-opacity="0.55"/><stop offset="1" class="c-area" stop-opacity="0"/></linearGradient></defs>
    <g class="c-grid">${grid}</g>${labels}
    <path d="M${pts.join(' L')} L${x(cum.length - 1).toFixed(1)} ${base} L${x(0).toFixed(1)} ${base} Z" fill="url(#area-${c})"/>
    <path d="M${pts.join(' L')}" class="c-line"/>${dots}</svg>`;
}

function nextHtml(m, c) {
  const g = m.games.find((x) => x.status !== 'final' && (x.home === c || x.away === c) && x.at > Date.now() - 4 * 3600e3);
  if (!g) return `<div class="who">${logo(m, c)}<div><span class="label">Nächstes Spiel</span><strong>Noch nicht im Spielplan</strong></div></div>`;
  const home = g.home === c, opp = home ? g.away : g.home;
  const when = g.status === 'live' ? `<span class="live-text"><i class="live-dot" aria-hidden="true"></i>${g.hs}:${g.as}</span><small>${esc(liveLabel(g) || 'Live')}</small>`
    : `${esc(rel(g.date))} ${esc(g.time)}<small>Spieltag ${g.round} · ${home ? 'Heimspiel' : 'Auswärts'}</small>`;
  return `<div class="who"><span class="pair" aria-hidden="true">${logo(m, c)}${logo(m, opp)}</span>
      <div><span class="label">${g.status === 'live' ? 'Läuft gerade' : 'Nächstes Spiel'} · ${esc(short(c))}</span><strong>${home ? 'gegen ' : 'bei '}${esc(name(m, opp))}</strong></div></div>
    <div class="next-foot"><button type="button" class="btn-ghost" data-act="open-next">Spielplan</button><div class="when num">${when}</div></div>`;
}

function renderLeft(m) {
  const left = $('#left');
  const chips = FAV.map((c) => `<button type="button" class="chip" style="--c:${favColor(c)}" data-team="${c}" aria-pressed="${c === sel}" aria-label="${esc(fullName(m, c))}, ${esc(rec(m, c))}"><b>${esc(short(c))}</b><span>${esc(rec(m, c))}</span></button>`).join('');
  const star = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 3 6.5 7 .8-5.2 4.8 1.4 7L12 17.6 5.8 21l1.4-7L2 9.3l7-.8z"/></svg>';
  const cards = [...FAV].sort((a, b) => (m.st[a]?.rank || 99) - (m.st[b]?.rank || 99)).filter((c) => m.st[c]).map((c) => {
    const t = m.st[c], form = (m.hist[c] || []).slice(-5);
    return `<article class="team-card" data-act="team" data-c="${c}" role="button" tabindex="0" aria-label="Teamseite ${esc(name(m, c))}"><span class="rank">${t.rank === 1 ? star : ''}Platz ${t.rank}</span><span class="tname">${esc(name(m, c))}</span>
      <span class="rec num">${esc(rec(m, c))}</span>
      <span class="form" role="img" aria-label="Form: ${form.map((f) => (f.w ? 'Sieg' : 'Niederlage')).join(', ')}">${form.map((f) => `<i${f.w ? '' : ' class="l"'}></i>`).join('')}</span></article>`;
  }).join('');
  left.innerHTML = `<section class="panel chart" aria-label="${esc(fullName(m, sel))}, Korbdifferenz über die Saison">${chartHtml(m, sel)}</section>
    <div class="chips" role="group" aria-label="Team wählen">${chips}</div>
    <section class="panel next" aria-label="Nächstes Spiel">${nextHtml(m, sel)}</section>
    <div class="sec-head"><h2>Deine Teams</h2><span class="label">Form · letzte 5</span></div>
    <div class="teams">${cards}</div>`;
}

// ---------- Bestenlisten ----------
const CATS = [['pts', 'Punkte'], ['reb', 'Rebounds'], ['ast', 'Assists'], ['pir', 'PIR'], ['stl', 'Steals'], ['blk', 'Blocks'], ['fg3m', 'Dreier']];
// Nur Spieler mit mindestens der Hälfte der Spiele des fleissigsten Spielers (sonst führt jemand mit einem einzigen Spiel)
function qualified() {
  const list = players?.players || [];
  const maxGp = Math.max(1, ...list.map((p) => p.gp));
  return list.filter((p) => p.gp >= Math.max(1, Math.floor(maxGp / 2)));
}
function leaderTeaser(m) {
  if (!players) return 'Top-Scorer, Rebounds, Assists und mehr.';
  const top = [...qualified()].sort((a, b) => b.pts - a.pts)[0];
  return top ? `${top.name} (${short(top.team)}) führt mit ${String(top.pts).replace('.', ',')} Punkten pro Spiel.` : 'Top-Scorer, Rebounds, Assists und mehr.';
}
const num1 = (v) => (Number.isInteger(v) ? `${v}` : String(v).replace('.', ','));
function playerImg(p, cls = 'pimg') {
  return /^https:\/\/media-cdn\.(incrowdsports\.com|cortextech\.io)\//.test(p.img || '') ? `<img class="${cls}" src="${esc(p.img)}" alt="" loading="lazy">` : `<span class="${cls} none" aria-hidden="true"></span>`;
}
function leadersHtml(m) {
  if (!players) return `<p class="label">${esc(playersError || 'Lade Spielerstatistik …')}</p>`;
  const [cat, label] = CATS.find((c) => c[0] === leaderState.cat) || CATS[0];
  const list = qualified().filter((p) => !leaderState.fav || FAV.includes(p.team)).sort((a, b) => b[cat] - a[cat] || b.gp - a.gp).slice(0, 10);
  return `<div class="cats" role="group" aria-label="Kategorie">${CATS.map(([k, l]) => `<button type="button" data-act="leader-cat" data-cat="${k}" aria-pressed="${k === cat}">${l}</button>`).join('')}</div>
    <label class="fav-only"><input type="checkbox" data-act="leader-fav" ${leaderState.fav ? 'checked' : ''}> Nur deine Teams</label>
    <ol class="leaders">${list.map((p, i) => `<li><span class="rk num">${i + 1}</span>${playerImg(p)}<span class="who"><b>${esc(p.name)}</b><small><button type="button" class="team-link" data-act="team" data-c="${esc(p.team)}">${esc(name(m, p.team))}</button> · ${p.gp} Spiele</small></span><span class="val num">${num1(p[cat])}<small>${cat === 'fg3m' ? 'pro Spiel' : 'pro Spiel'}</small></span></li>`).join('') || '<li class="label">Keine Spieler.</li>'}</ol>
    <p class="standings-note">${label} pro Spiel, nur Spieler mit mindestens der Hälfte der Spiele. <a href="https://www.euroleaguebasketball.net/en/euroleague/stats/" target="_blank" rel="noopener">Alle Statistiken der EuroLeague ↗</a></p>`;
}

// ---------- Mitte: Spieltag ----------
function cardFor(g) {
  const kh = KEYS[g.home] || [], ka = KEYS[g.away] || [];
  return (news?.items || []).findIndex((it) => {
    const t = (it.title || '').toLowerCase();
    return kh.some((k) => t.includes(k)) && ka.some((k) => t.includes(k));
  });
}

// 7-Segment-Ziffern wie auf der Hallentafel (SVG); nicht leuchtende Segmente schimmern leicht durch
const SEG_T = 8;
const segH = (x, y, l) => `${x},${y} ${x + SEG_T / 2},${y - SEG_T / 2} ${x + l - SEG_T / 2},${y - SEG_T / 2} ${x + l},${y} ${x + l - SEG_T / 2},${y + SEG_T / 2} ${x + SEG_T / 2},${y + SEG_T / 2}`;
const segV = (x, y, l) => `${x},${y} ${x + SEG_T / 2},${y + SEG_T / 2} ${x + SEG_T / 2},${y + l - SEG_T / 2} ${x},${y + l} ${x - SEG_T / 2},${y + l - SEG_T / 2} ${x - SEG_T / 2},${y + SEG_T / 2}`;
const SEGS = { a: segH(9, 6, 34), b: segV(46, 8, 36), c: segV(46, 48, 36), d: segH(9, 86, 34), e: segV(6, 48, 36), f: segV(6, 8, 36), g: segH(9, 46, 34) };
const SEG_DIGITS = { 0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
function seg7(text, cls) {
  let x = 0, body = '';
  for (const ch of text) {
    if (ch === ':') { body += `<g transform="translate(${x} 0)"><circle cx="8" cy="30" r="4.5" class="on"/><circle cx="8" cy="62" r="4.5" class="on"/></g>`; x += 16; continue; }
    const on = SEG_DIGITS[ch] || '';
    body += `<g transform="translate(${x} 0) skewX(-5)">${Object.entries(SEGS).map(([k, p]) => `<polygon points="${p}" class="${on.includes(k) ? 'on' : 'off'}"/>`).join('')}</g>`;
    x += 60;
  }
  return `<svg class="seg ${cls}" viewBox="-4 0 ${x} 92" aria-hidden="true" focusable="false">${body}</svg>`;
}
const lastScores = new Map();

const HERO_ART ='<svg viewBox="0 0 300 240"><path d="M70 170a95 95 0 1 1 170 -40" fill="none" stroke="#5B7CFA" stroke-width="10" stroke-linecap="round" opacity="0.9"/><path d="M60 150a95 95 0 0 0 40 50" fill="none" stroke="#5B7CFA" stroke-width="10" stroke-linecap="round" opacity="0.5"/><ellipse cx="150" cy="212" rx="70" ry="10" fill="#1B1C38" opacity="0.6"/><circle cx="150" cy="118" r="72" fill="#E8935F"/><circle cx="150" cy="118" r="72" fill="none" stroke="#C86F3B" stroke-width="3"/><path d="M78 118h144M150 46v144M100 66c22 26 22 78 0 104M200 66c-22 26-22 78 0 104" fill="none" stroke="#4A2210" stroke-width="5" stroke-linecap="round"/><ellipse cx="124" cy="86" rx="22" ry="12" fill="#FFFFFF" opacity="0.18" transform="rotate(-30 124 86)"/></svg>';

function renderCenter(m) {
  const center = $('#center');
  const now = Date.now();
  const today = zDate(new Date());
  const nx = m.upcoming[0];
  const day = m.games.some((g) => g.date === today) ? today : (nx ? nx.date : '');
  const dayGames = m.games.filter((g) => g.date === day);
  const parts = [];

  // Heute
  const label = day ? (day === today ? 'Heute' : cap(rel(day))) : 'Keine Spiele angesetzt';
  // Laufende Spiele stehen gross in den Live-Boxen darunter, oben nur die übrigen
  const chips = dayGames.filter((g) => g.status !== 'live').map((g) => {
    const mid = g.status === 'final' ? `${g.hs}:${g.as}` : g.status === 'live' ? `${g.hs}:${g.as}` : g.time;
    const sub = g.status === 'live' ? `<small><i class="live-dot" aria-hidden="true"></i>${esc(liveLabel(g) || 'Live')}</small>` : '';
    const fav = FAV.includes(g.home) || FAV.includes(g.away);
    return `<div class="day-game${g.status === 'final' ? ' done' : ''}${g.status === 'live' ? ' live' : ''}${fav ? ' fav' : ''}" ${boxAttrs(m, g)} title="${esc(fullName(m, g.home))} – ${esc(fullName(m, g.away))}">
      <span class="t">${logo(m, g.home, 'xs')}<b>${esc(short(g.home))}</b></span><span class="mid num">${sub}${esc(mid)}</span><span class="t away"><b>${esc(short(g.away))}</b>${logo(m, g.away, 'xs')}</span></div>`;
  }).join('');
  const liveNow = dayGames.some((g) => g.status === 'live');
  parts.push(`<section class="today" aria-label="Spiele ${day === today ? 'von heute' : 'am nächsten Spieltag'}">
    <div class="today-head"><h2>${esc(label)}${dayGames.length ? ` <span>· Spieltag ${dayGames[0].round} · ${dayGames.length} ${dayGames.length === 1 ? 'Spiel' : 'Spiele'}</span>` : ''}</h2>
      ${data ? `<span class="stand${liveNow ? ' is-live' : ''}">${liveNow ? 'Live · ' : ''}Stand ${esc(zTime(new Date(data.updated)))}</span>` : ''}</div>
    ${chips ? `<div class="day-games" data-keep-scroll="today">${chips}</div>` : ''}</section>`);

  if (dataError) parts.push(`<p class="notice">${esc(dataError)}</p>`);

  // Laufen gerade Spiele, ersetzen sie das „Spiel des Tages“: gleiche Box, eine pro Spiel, seitlich wischbar
  const finals = m.lastPlayed ? m.rounds[m.lastPlayed].filter((g) => g.status === 'final') : [];
  const lives = m.games.filter((g) => g.status === 'live');
  if (lives.length) {
    // Als Hallentafel: ganze Tafel antippbar (öffnet den Spielbericht); bei neuem Korb blinken die Punkte kurz
    const cards = lives.map((g) => {
      const key = `${g.hs}:${g.as}`, before = lastScores.get(g.code);
      lastScores.set(g.code, key);
      const n = Number((/\d+/.exec(g.period || '') || [])[0]);
      const clock = /^\d{1,2}:\d\d$/.test(g.clock || '') ? g.clock.padStart(5, ' ') : '  :  ';
      const label = liveLabel(g) || 'Live';
      const state = n >= 1 && g.clock !== '00:00' ? 'Live' : label;
      return `<section class="live-hero${before && before !== key ? ' flash' : ''}" ${boxAttrs(m, g)}>
      <div class="hall-panel">
        <div class="hall-side">${logo(m, g.home, 'sm')}<span class="hall-label">${esc(shortName(m, g.home))}</span><div class="hall-score">${seg7(String(g.hs).padStart(3, ' '), 'red')}</div></div>
        <div class="hall-mid"><div class="hall-clock">${seg7(clock, 'amber')}</div>
          <div class="hall-per">${n > 4 ? 'VERL.' : `VIERTEL ${seg7(n >= 1 ? String(n) : ' ', 'amber')}`}</div></div>
        <div class="hall-side">${logo(m, g.away, 'sm')}<span class="hall-label">${esc(shortName(m, g.away))}</span><div class="hall-score">${seg7(String(g.as).padStart(3, ' '), 'red')}</div></div>
      </div>
      <div class="hall-foot"><span class="hall-live"><i class="live-dot" aria-hidden="true"></i>${esc(state)}</span><span>Spieltag ${g.round} · Bericht ›</span></div></section>`;
    }).join('');
    parts.push(`<div class="hero-scroll${lives.length > 1 ? ' multi' : ''}" data-keep-scroll="live" aria-label="Live-Spiele">${cards}</div>`);
  }

  // Spiel des Tages: höchster Sieg im letzten Spieltag mit Resultaten
  const big = lives.length ? null : [...finals].sort((a, b) => Math.abs(b.hs - b.as) - Math.abs(a.hs - a.as) || b.at - a.at)[0];
  if (big) {
    const ci = cardFor(big);
    parts.push(`<section class="hero" aria-label="Spiel des Tages">
      <div class="hero-art" aria-hidden="true">${HERO_ART}</div>
      <div class="hero-info"><h2>Spiel des Tages</h2><div class="score" ${boxAttrs(m, big)}>
        <div class="team"><span class="pts num">${big.hs}</span><span class="tn">${logo(m, big.home, 'xs')}${esc(name(m, big.home))}</span></div>
        <span class="arrow" aria-hidden="true">»</span>
        <div class="team"><span class="pts num">${big.as}</span><span class="tn">${logo(m, big.away, 'xs')}${esc(name(m, big.away))}</span></div></div>
        <div class="hero-actions"><span class="pill-dark num">+${Math.abs(big.hs - big.as)} <span class="dim">für ${esc(short(big.hs > big.as ? big.home : big.away))} · Spieltag ${big.round}</span></span>
        ${ci >= 0 ? `<button type="button" class="btn-accent" data-act="show-news" data-i="${ci}">Zur Meldung <span aria-hidden="true">↓</span></button>` : ''}</div></div></section>`);
  }

  // Kacheln
  const [leader, second] = m.table;
  const same = second ? m.table.filter((t) => t !== leader && t.s === second.s && t.n === second.n).length : 0;
  const tabTxt = leader && leader.s + leader.n ? `${esc(name(m, leader.c))} führt mit ${leader.s}–${leader.n}${second ? `, dahinter ${same > 1 ? `${same} Teams` : esc(name(m, second.c))} mit ${second.s}–${second.n}` : ''}.` : 'Rangliste der EuroLeague.';
  let nextTxt = 'Keine weiteren Spiele im Spielplan.';
  if (nx) {
    const started = m.rounds[nx.round].some((g) => g.status !== 'pre');
    nextTxt = started ? `Spieltag ${nx.round} läuft, nächstes Spiel ${esc(rel(nx.date))} um ${esc(nx.time)}.`
      : `Spieltag ${nx.round} startet ${esc(rel(nx.date))} um ${esc(nx.time)} mit ${esc(name(m, nx.home))} gegen ${esc(name(m, nx.away))}.`;
  }
  const avg = finals.length ? Math.round(finals.reduce((s, g) => s + g.hs + g.as, 0) / finals.length) : 0;
  parts.push(`<div class="tiles">
    <button type="button" class="tile t-blue" data-act="toggle-table" aria-expanded="${open.table}" aria-controls="tableBox"><svg viewBox="0 0 120 120" aria-hidden="true"><path d="M34 18h52v22c0 18-12 30-26 30S34 58 34 40z" fill="#8FA6FF"/><path d="M34 26H18c0 16 8 24 18 26M86 26h16c0 16-8 24-18 26" fill="none" stroke="#8FA6FF" stroke-width="8" stroke-linecap="round"/><rect x="52" y="68" width="16" height="18" fill="#7D96FF"/><rect x="36" y="86" width="48" height="14" rx="5" fill="#A9BBFF"/></svg><strong>Tabelle</strong><p>${tabTxt}</p></button>
    <button type="button" class="tile t-violet" data-act="toggle-next" aria-expanded="${open.next}" aria-controls="nextBox"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="58" r="44" fill="#9C78FF"/><path d="M16 58h88M60 14v88M30 26c14 16 14 48 0 64M90 26c-14 16-14 48 0 64" fill="none" stroke="#5A2BD6" stroke-width="6" stroke-linecap="round"/></svg><strong>Nächste Spiele</strong><p>${nextTxt}</p></button>
    <button type="button" class="tile t-coral" data-act="toggle-leaders" aria-expanded="${open.leaders}" aria-controls="leadersBox"><svg viewBox="0 0 120 120" aria-hidden="true"><rect x="18" y="62" width="20" height="38" rx="6" fill="#FF9AA0"/><rect x="50" y="40" width="20" height="60" rx="6" fill="#FFB4B8"/><rect x="82" y="18" width="20" height="82" rx="6" fill="#FF9AA0"/></svg><strong>Bestenlisten</strong><p>${esc(leaderTeaser(m))}</p></button>
  </div>`);
  center.innerHTML = parts.join('');

  // Tabelle (aus allen Resultaten berechnet)
  const tableBox = el('section', 'standings-wrap'); tableBox.id = 'tableBox'; tableBox.hidden = !open.table;
  tableBox.innerHTML = `<table class="standings-table"><thead><tr><th>#</th><th class="team-h">Team</th><th><abbr title="Spiele">Sp</abbr></th><th><abbr title="Siege">S</abbr></th><th><abbr title="Niederlagen">N</abbr></th><th class="pts"><abbr title="Korbdifferenz">+/-</abbr></th><th class="ha"><abbr title="Bilanz zu Hause">Heim</abbr></th><th class="ha"><abbr title="Bilanz auswärts">Ausw.</abbr></th><th><abbr title="Serie: S = Siege, N = Niederlagen am Stück">Serie</abbr></th></tr></thead>
    <tbody>${m.table.map((t) => `<tr class="${t.rank <= 6 ? 'zone-po' : t.rank <= 10 ? 'zone-pi' : ''}${t.rank === 6 || t.rank === 10 ? ' zone-end' : ''}${FAV.includes(t.c) ? ' fav' : ''}"><td class="pos">${t.rank}</td><td class="team"><button type="button" class="team-link" data-act="team" data-c="${t.c}">${logo(m, t.c, 'xxs')}${esc(name(m, t.c))}</button></td><td>${t.s + t.n}</td><td>${t.s}</td><td>${t.n}</td><td class="pts">${t.d > 0 ? '+' : ''}${t.d}</td><td class="ha">${t.hs}–${t.hn}</td><td class="ha">${t.as}–${t.an}</td><td class="streak ${t.streak.startsWith('S') ? 'win' : 'loss'}">${esc(t.streak)}</td></tr>`).join('')}</tbody></table>
    <p class="zones"><span class="z-po">Platz 1–6: Playoffs</span><span class="z-pi">Platz 7–10: Play-in</span></p>
    <p class="standings-note">Aus allen Resultaten berechnet; bei gleicher Bilanz entscheidet hier die Korbdifferenz (die EuroLeague zählt zuerst die direkten Duelle). Team antippen öffnet die Teamseite.</p>`;
  center.appendChild(tableBox);

  // Nächste Spiele
  const nextBox = el('section', 'next-box'); nextBox.id = 'nextBox'; nextBox.hidden = !open.next; nextBox.setAttribute('aria-label', 'Nächste Spiele');
  const upRounds = [...new Set(m.games.filter((g) => g.status !== 'final' && g.at > now - 4 * 3600e3).map((g) => g.round))].slice(0, 2);
  if (!upRounds.length) nextBox.appendChild(el('p', 'label', 'Keine weiteren Spiele im Spielplan.'));
  upRounds.forEach((r) => {
    nextBox.appendChild(el('h3', '', `Spieltag ${r} · Nächste Spiele`));
    const l = el('div', 'games');
    m.rounds[r].filter((g) => g.status !== 'final').forEach((g) => l.appendChild(gameRow(m, g, false)));
    nextBox.appendChild(l);
  });
  center.appendChild(nextBox);

  // Bestenlisten (Saisonwerte pro Spiel)
  const leadersBox = el('section', 'leaders-box'); leadersBox.id = 'leadersBox'; leadersBox.hidden = !open.leaders; leadersBox.setAttribute('aria-label', 'Bestenlisten');
  leadersBox.innerHTML = leadersHtml(m);
  center.appendChild(leadersBox);

  // Resultate des letzten Spieltags
  if (m.lastPlayed) {
    const gs = m.rounds[m.lastPlayed];
    const pl = gs.filter((g) => g.status === 'final');
    center.appendChild(el('div', 'stats-head', `<h2>Spieltag ${m.lastPlayed} · Resultate</h2>
      <div class="facts num"><span title="Gespielte Spiele">${icon('ball')}${pl.length}<span class="sr-only"> Spiele</span></span>
      ${avg ? `<span title="Punkte pro Spiel">${icon('bars')}Ø ${avg}<span class="sr-only"> Punkte pro Spiel</span></span>` : ''}
      ${big ? `<span title="Höchster Sieg">${icon('trend')}+${Math.abs(big.hs - big.as)}<span class="sr-only"> höchster Sieg</span></span>` : ''}</div>`));
    const list = el('div', 'games');
    gs.forEach((g) => list.appendChild(gameRow(m, g, g === big)));
    center.appendChild(list);
  }

  // Ganz unten: Links zu den anderen Sport-Seiten
  center.appendChild(el('section', 'rubriken', `<h2>Weitere Rubriken</h2><nav class="rubrik-nav" aria-label="Weitere Rubriken">${RUBRIKEN.map((r) =>
    `<a class="rubrik-btn${r.active ? ' active' : ''}${r.disabled ? ' disabled' : ''}" href="${esc(r.url)}"${r.disabled ? ' aria-disabled="true" tabindex="-1"' : ''}>${esc(r.name)}</a>`).join('')}</nav>`));
}

// ---------- Rechts: News ----------
function dkey(s) { const p = String(s || '').split('.'); return p.length === 3 ? p[2] + p[1] + p[0] : ''; }
const SRC_COLOR = ['#5B7CFA', '#EE5F68', '#4CC38A', '#E8935F', '#6E3CF0'];

function renderFeed() {
  const items = news?.items || [];
  const newest = items.map((i) => i.firstShown).sort((a, b) => dkey(b).localeCompare(dkey(a)))[0] || '';
  const todayCH = zDate(new Date()).split('-').reverse().join('.');
  const nNew = items.filter((i) => i.firstShown === newest).length;
  const srcs = [...new Set(items.map((i) => i.source).filter(Boolean))];
  $('#feedHead').innerHTML = `<span><span class="live" aria-hidden="true"></span>${newest === todayCH ? 'Neu heute' : `Neu am ${esc(newest)}`} · ${nNew}</span><span class="num">${icon('chat')}${items.length} Meldungen</span>`;
  $('#src').innerHTML = ['', ...srcs].map((s) => `<button type="button" data-src="${esc(s)}" aria-pressed="${feedState.src === s}">${esc(s || 'Alle')}</button>`).join('');
  const q = feedState.q.trim().toLowerCase();
  let shown = 0, divided = false;
  const html = items.map((it, i) => {
    const ok = (!feedState.src || it.source === feedState.src) && (!q || `${it.tag} ${it.title} ${it.text}`.toLowerCase().includes(q));
    if (!ok) return '';
    shown++;
    const divider = !divided && !q && !feedState.src && it.firstShown !== newest ? (divided = true, '<h3 class="feed-divider">Frühere Meldungen</h3>') : '';
    const color = SRC_COLOR[srcs.indexOf(it.source) % SRC_COLOR.length] || SRC_COLOR[0];
    const openTxt = feedState.expanded.has(i);
    return `${divider}<article class="card${openTxt ? ' is-open' : ''}" id="news-${i}">
      <span class="src-avatar" style="--ac:${color}" aria-hidden="true">${esc((it.source || '?').charAt(0))}</span>
      <div class="card-top"><span class="tag">${esc(it.tag)}</span></div>
      <h2>${esc(it.title)}</h2><p>${esc(it.text)}</p>
      <button type="button" class="more" data-act="more" data-i="${i}" aria-expanded="${openTxt}">${openTxt ? 'Weniger' : 'Weiterlesen'}</button>
      <div class="card-foot"><span>${esc(it.time)}</span><div class="foot-actions">
        <button type="button" class="share-btn" data-act="share" data-i="${i}" aria-label="Meldung teilen: ${esc(it.title)}">${icon('share', '')}Teilen</button>
        <a href="${esc(/^https:\/\//.test(it.url) ? it.url : '#')}" target="_blank" rel="noopener">${esc(it.source)} ↗</a></div></div></article>`;
  }).join('');
  $('#feed').innerHTML = html + (shown ? '' : '<p class="feed-empty">Keine Meldung passt zur Suche.</p>');
  const badge = $('#newsBadge');
  if (badge) { badge.textContent = nNew; badge.hidden = !nNew; badge.setAttribute('aria-label', `${nNew} neue Meldungen`); }
}

// ---------- Zeichnen ----------
function render() {
  const m = model();
  const keep = [...document.querySelectorAll('[data-keep-scroll]')].map((n) => [n.dataset.keepScroll, n.scrollLeft]);
  $('#profileBar').innerHTML = profileHtml();
  renderLeft(m);
  renderCenter(m);
  for (const [k, x] of keep) { const n = document.querySelector(`[data-keep-scroll="${k}"]`); if (n) n.scrollLeft = x; }
}

function setTab(t, scroll = true) {
  tab = t;
  $('#app').dataset.tab = t;
  document.querySelectorAll('.mtabs button').forEach((b) => { if (b.dataset.tab === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  store.set('el-tab', t);
  if (scroll) window.scrollTo(0, 0);
}

function showNews(i) {
  feedState.q = ''; feedState.src = ''; $('#newsSearch').value = '';
  renderFeed();
  setTab('news', false);
  const card = document.getElementById(`news-${i}`);
  if (!card) return;
  card.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('is-flash'); void card.offsetWidth; card.classList.add('is-flash');
}

async function share(i) {
  const it = news?.items?.[i]; if (!it) return;
  const text = `${it.title}\nQuelle (${it.source}): ${it.url}\n\nGefunden auf Sport-News Euroleague: ${location.href.split('?')[0]}`;
  try {
    if (navigator.share) { await navigator.share({ title: it.title, text, url: it.url }); return; }
  } catch { return; /* abgebrochen */ }
  try { await navigator.clipboard.writeText(text); toast('Text und Link kopiert'); } catch { toast('Kopieren nicht möglich'); }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------- Spielbericht ----------
const boxState = { code: 0, data: null, error: '', team: 0, timer: null, shooter: '' };
const pct = (a) => (a[1] ? `${Math.round(a[0] / a[1] * 100)}%` : '–');
const ratio = (a) => `${a[0]}/${a[1]}`;

async function loadBox(code) {
  try {
    const url = testData ? `box-${code}.json` : `${DATA_URL}?game=${code}`;
    const res = await fetch(url, { headers: testData ? {} : { apikey: SUPABASE_ANON_KEY }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const d = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(d?.teams)) throw new Error(d?.error || `Fehler ${res.status}`);
    if (boxState.code !== code) return;
    boxState.data = d; boxState.error = '';
  } catch {
    if (boxState.code === code) boxState.error = 'Der Spielbericht ist gerade nicht erreichbar.';
  }
}

function openBox(code) {
  const dlg = $('#box');
  boxState.code = code; boxState.data = null; boxState.error = ''; boxState.team = 0; boxState.shooter = '';
  clearInterval(boxState.timer);
  renderBox();
  if (!dlg.open) dlg.showModal();
  const g = (data?.games || []).find((x) => x.code === code);
  if (!g) return;
  if (g.status === 'pre') { if (!players) loadPlayers().then(() => { if (boxState.code === code) renderBox(); }); return; }
  loadBox(code).then(renderBox);
  if (g.status === 'live') boxState.timer = setInterval(async () => {
    await loadBox(code); await loadData(); renderBox(); render();
  }, 30000);
}

// Inhalt in einen inneren Rahmen: ein Klick auf den Rand des Fensters (dialog selbst) schliesst es
const setBox = (dlg, html) => { dlg.innerHTML = `<div class="box-in">${html}</div>`; };

function renderBox() {
  const dlg = $('#box');
  const m = model();
  const g = m.games.find((x) => x.code === boxState.code);
  if (!g) { dlg.textContent = ''; return; }
  const b = boxState.data;
  const status = g.status === 'live' ? `<span class="live-text"><i class="live-dot" aria-hidden="true"></i>Live${liveLabel(g) ? ` · ${esc(liveLabel(g))}` : ''}</span>`
    : g.status === 'final' ? 'Endstand' : `${esc(cap(rel(g.date)))} ${esc(g.time)}`;
  const head = `<div class="box-top"><h2 id="boxTitle">Spielbericht · Spieltag ${g.round}</h2><button type="button" class="box-close" data-act="box-close" aria-label="Schliessen">×</button></div>
    <div class="box-score">
      <button type="button" class="box-team" data-act="team" data-c="${g.home}">${logo(m, g.home)}<b>${esc(name(m, g.home))}</b><small>${esc(rec(m, g.home))}</small></button>
      <div class="box-mid"><span class="num">${g.status === 'pre' ? '–:–' : `${g.hs} : ${g.as}`}</span><small>${status}</small></div>
      <button type="button" class="box-team" data-act="team" data-c="${g.away}">${logo(m, g.away)}<b>${esc(name(m, g.away))}</b><small>${esc(rec(m, g.away))}</small></button>
    </div>`;
  if (g.status === 'pre') {
    setBox(dlg, `${head}${previewHtml(m, g)}`);
    const duel = $('#duels', dlg);
    if (duel) m.games.filter((x) => x.status === 'final' && ((x.home === g.home && x.away === g.away) || (x.home === g.away && x.away === g.home))).forEach((x) => duel.appendChild(gameRow(m, x, false)));
    return;
  }
  if (!b) { setBox(dlg, `${head}<p class="box-note">${esc(boxState.error || 'Lade Statistik …')}</p>`); return; }
  const [th, ta] = b.teams;
  if (!th || !ta) { setBox(dlg, `${head}<p class="box-note">Für dieses Spiel gibt es noch keine Statistik.</p>`); return; }

  // Viertel
  const qn = Math.max(b.quarters[0]?.length || 0, b.quarters[1]?.length || 0);
  const qLabel = (i) => (i < 4 ? `${i + 1}.` : `V${i > 4 ? i - 3 : ''}`);
  const qRow = (code, q) => `<tr><th scope="row">${esc(short(code))}</th>${Array.from({ length: qn }, (_, i) => `<td>${q?.[i] ?? '–'}</td>`).join('')}</tr>`;
  const quarters = qn ? `<table class="box-q num"><thead><tr><th></th>${Array.from({ length: qn }, (_, i) => `<th scope="col">${qLabel(i)}</th>`).join('')}</tr></thead>
    <tbody>${qRow(g.home, b.quarters[0])}${qRow(g.away, b.quarters[1])}</tbody></table>` : '';

  // Teamvergleich: Balken anteilig, bessere Seite hervorgehoben (bei Ballverlusten und Fouls ist weniger besser)
  const T = (t) => t.totals;
  const rows = [
    ['2-Punkte-Würfe', (t) => T(t).fg2[1] ? T(t).fg2[0] / T(t).fg2[1] : 0, (t) => `${pct(T(t).fg2)} <small>${ratio(T(t).fg2)}</small>`],
    ['3-Punkte-Würfe', (t) => T(t).fg3[1] ? T(t).fg3[0] / T(t).fg3[1] : 0, (t) => `${pct(T(t).fg3)} <small>${ratio(T(t).fg3)}</small>`],
    ['Freiwürfe', (t) => T(t).ft[1] ? T(t).ft[0] / T(t).ft[1] : 0, (t) => `${pct(T(t).ft)} <small>${ratio(T(t).ft)}</small>`],
    ['Rebounds', (t) => T(t).reb], ['Offensiv-Rebounds', (t) => T(t).oreb], ['Assists', (t) => T(t).ast],
    ['Steals', (t) => T(t).stl], ['Blocks', (t) => T(t).blk], ['Ballverluste', (t) => T(t).tov, null, true], ['Fouls', (t) => T(t).pf, null, true],
    ['Effizienz (PIR)', (t) => T(t).pir],
  ];
  const compare = rows.map(([label, val, show, lessBetter]) => {
    const a = val(th), c = val(ta), sum = Math.abs(a) + Math.abs(c) || 1;
    const better = a === c ? 0 : (a > c) !== Boolean(lessBetter) ? 1 : 2;
    return `<div class="cmp"><span class="cmp-v${better === 1 ? ' is-best' : ''}">${show ? show(th) : a}</span><span class="cmp-l">${label}</span><span class="cmp-v away${better === 2 ? ' is-best' : ''}">${show ? show(ta) : c}</span>
      <span class="cmp-bar" aria-hidden="true"><i style="width:${(Math.abs(a) / sum * 100).toFixed(1)}%"></i><i class="away" style="width:${(Math.abs(c) / sum * 100).toFixed(1)}%"></i></span></div>`;
  }).join('');

  // Spieler eines Teams
  const team = b.teams[boxState.team] || th;
  const top = Math.max(...team.players.map((p) => p.pts), 0);
  const players = team.players.map((p) => `<tr class="${p.on && b.live ? 'on' : ''}">
      <td class="no">${esc(p.no)}</td><th scope="row" class="pl">${p.on && b.live ? '<i class="live-dot" aria-label="auf dem Feld"></i>' : ''}${esc(p.name)}${p.start ? '<small>S5</small>' : ''}</th>
      <td>${esc(p.min || '–')}</td><td class="${p.pts === top && top ? 'is-top' : ''}"><b>${p.pts}</b></td><td>${p.reb}</td><td>${p.ast}</td>
      <td>${ratio(p.fg2)}</td><td>${ratio(p.fg3)}</td><td>${ratio(p.ft)}</td><td>${p.stl}</td><td>${p.tov}</td><td>${p.blk}</td><td>${p.pf}</td><td><b>${p.pir}</b></td><td>${p.pm > 0 ? '+' : ''}${p.pm}</td></tr>`).join('');
  setBox(dlg, `${head}${quarters}
    <h3>Teamvergleich</h3><div class="cmp-head"><span>${esc(short(g.home))}</span><span>${esc(short(g.away))}</span></div><div class="cmp-list">${compare}</div>
    <h3>Spieler</h3>
    <div class="seg" role="group" aria-label="Team wählen">${b.teams.map((t, i) => `<button type="button" data-act="box-team" data-i="${i}" aria-pressed="${i === boxState.team}">${esc(name(m, i === 0 ? g.home : g.away))}</button>`).join('')}</div>
    ${team.coach ? `<p class="box-coach">Trainer: ${esc(team.coach)}</p>` : ''}
    ${shotsHtml(b, team)}
    <div class="pl-wrap"><table class="pl-table num"><thead><tr><th scope="col">#</th><th scope="col" class="pl">Spieler</th><th scope="col">Min</th><th scope="col">Pkt</th><th scope="col"><abbr title="Rebounds">Reb</abbr></th><th scope="col"><abbr title="Assists">Ass</abbr></th><th scope="col"><abbr title="2-Punkte-Würfe">2P</abbr></th><th scope="col"><abbr title="3-Punkte-Würfe">3P</abbr></th><th scope="col"><abbr title="Freiwürfe">FW</abbr></th><th scope="col"><abbr title="Steals">St</abbr></th><th scope="col"><abbr title="Ballverluste">BV</abbr></th><th scope="col"><abbr title="Blocks">Bl</abbr></th><th scope="col"><abbr title="Fouls">F</abbr></th><th scope="col"><abbr title="Effizienz">PIR</abbr></th><th scope="col">+/-</th></tr></thead>
    <tbody>${players}</tbody></table></div>
    <p class="box-note small">Quelle: EuroLeague. S5 = Startformation${b.live ? ', roter Punkt = gerade auf dem Feld. Aktualisiert sich alle 30 Sekunden' : ''}.</p>`);
}

// Vorschau: Tabelle, Form, Heim/Auswärts, Duelle dieser Saison und Top-Spieler beider Teams
function formDots(m, c) {
  const f = (m.hist[c] || []).slice(-5);
  return `<span class="form" role="img" aria-label="Form: ${f.map((x) => (x.w ? 'Sieg' : 'Niederlage')).join(', ') || 'noch keine Spiele'}">${f.map((x) => `<i${x.w ? '' : ' class="l"'}></i>`).join('')}</span>`;
}
function previewHtml(m, g) {
  const a = m.st[g.home] || {}, b = m.st[g.away] || {};
  const row = (label, va, vb, better) => `<div class="cmp"><span class="cmp-v${better === 1 ? ' is-best' : ''}">${va}</span><span class="cmp-l">${label}</span><span class="cmp-v away${better === 2 ? ' is-best' : ''}">${vb}</span></div>`;
  const cmpNum = (x, y, less) => (x === y ? 0 : (x > y) !== Boolean(less) ? 1 : 2);
  const duels = m.games.filter((x) => x.status === 'final' && ((x.home === g.home && x.away === g.away) || (x.home === g.away && x.away === g.home)));
  const tops = (c) => (players?.players || []).filter((p) => p.team === c && p.gp > 0).sort((x, y) => y.pir - x.pir).slice(0, 3);
  const topList = (c) => `<div class="tops"><h4>${esc(name(m, c))}</h4>${players ? (tops(c).map((p) => `<div class="top">${playerImg(p)}<span><b>${esc(p.name)}</b><small>${num1(p.pts)} Pkt · ${num1(p.reb)} Reb · ${num1(p.ast)} Ass · PIR ${num1(p.pir)}</small></span></div>`).join('') || '<p class="label">Noch keine Werte.</p>') : `<p class="label">${esc(playersError || 'Lade …')}</p>`}</div>`;
  return `<h3>Vorschau</h3><div class="cmp-head"><span>${esc(short(g.home))}</span><span>${esc(short(g.away))}</span></div><div class="cmp-list">
      ${row('Tabellenplatz', a.rank ? `${a.rank}.` : '–', b.rank ? `${b.rank}.` : '–', cmpNum(a.rank || 99, b.rank || 99, true))}
      ${row('Bilanz', esc(rec(m, g.home)), esc(rec(m, g.away)), cmpNum((a.s || 0) - (a.n || 0), (b.s || 0) - (b.n || 0)))}
      ${row('Korbdifferenz', `${(a.d || 0) > 0 ? '+' : ''}${a.d || 0}`, `${(b.d || 0) > 0 ? '+' : ''}${b.d || 0}`, cmpNum(a.d || 0, b.d || 0))}
      ${row(`${esc(short(g.home))} zu Hause · ${esc(short(g.away))} auswärts`, `${a.hs || 0}–${a.hn || 0}`, `${b.as || 0}–${b.an || 0}`, 0)}
      ${row('Serie', esc(a.streak || '–'), esc(b.streak || '–'), 0)}
      ${row('Form', formDots(m, g.home), formDots(m, g.away), 0)}
    </div>
    <h3>Duelle diese Saison</h3><div class="games" id="duels"></div>${duels.length ? '' : '<p class="label">Noch kein Duell in dieser Saison.</p>'}
    <h3>Top-Spieler (nach PIR)</h3><div class="tops-wrap">${topList(g.home)}${topList(g.away)}</div>
    <p class="box-note small">Die Spielstatistik erscheint, sobald das Spiel läuft.</p>`;
}

// Wurfkarte: halbes Spielfeld (FIBA-Masse in cm, Korb bei 0/0, y Richtung Mittellinie), Treffer gefüllt, Fehlwürfe als Ring
function shotsHtml(b, team) {
  const all = (b.shots || []).filter((x) => x.t === team.code);
  if (!all.length) return '';
  const shooters = [...new Set(all.map((x) => x.p))].sort((x, y) => x.localeCompare(y, 'de'));
  if (boxState.shooter && !shooters.includes(boxState.shooter)) boxState.shooter = '';
  const list = all.filter((x) => !boxState.shooter || x.p === boxState.shooter);
  const cnt = (v) => { const l = list.filter((x) => x.v === v); return [l.filter((x) => x.m).length, l.length]; };
  const c2 = cnt(2), c3 = cnt(3);
  const dots = list.map((x) => (x.m ? `<circle class="shot made" cx="${x.x}" cy="${x.y}" r="26"/>` : `<circle class="shot miss" cx="${x.x}" cy="${x.y}" r="22"/>`)).join('');
  return `<div class="shots"><div class="shots-head"><h4>Wurfkarte</h4>
      <label class="sr-only" for="shotPlayer">Spieler</label>
      <select id="shotPlayer"><option value="">Alle Spieler</option>${shooters.map((p) => `<option value="${esc(p)}"${p === boxState.shooter ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
    <svg class="court" viewBox="-760 -170 1520 1090" role="img" aria-label="Wurfkarte: ${c2[0] + c3[0]} von ${c2[1] + c3[1]} Würfen getroffen">
      <rect class="ct-floor" x="-750" y="-157.5" width="1500" height="1070"/>
      <rect class="ct-line" x="-245" y="-157.5" width="490" height="580"/>
      <circle class="ct-line" cx="0" cy="422.5" r="180"/>
      <path class="ct-line" d="M-660 -157.5 V141.5 A675 675 0 0 0 660 141.5 V-157.5"/>
      <path class="ct-line" d="M-125 0 A125 125 0 0 0 125 0"/>
      <line class="ct-line" x1="-90" y1="-37.5" x2="90" y2="-37.5"/>
      <circle class="ct-line" cx="0" cy="0" r="22.5"/>
      ${dots}</svg>
    <p class="shots-sum num"><span><i class="lg made"></i>Treffer</span><span><i class="lg miss"></i>Fehlwurf</span><span>2P ${c2[0]}/${c2[1]} (${pct(c2)})</span><span>3P ${c3[0]}/${c3[1]} (${pct(c3)})</span></p></div>`;
}

// ---------- Teamseite ----------
let teamCode = '';
function openTeam(code) {
  const dlg = $('#teamDlg');
  teamCode = code;
  renderTeamPage();
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  if (!players) loadPlayers().then(() => { if (teamCode === code) renderTeamPage(); });
}
function renderTeamPage() {
  const dlg = $('#teamDlg');
  const m = model();
  const c = teamCode, t = m.st[c];
  if (!c || !m.teams[c]) { dlg.textContent = ''; return; }
  const roster = (players?.players || []).filter((p) => p.team === c).sort((x, y) => y.pts - x.pts || y.gp - x.gp);
  const games = m.games.filter((g) => g.home === c || g.away === c);
  const next = games.filter((g) => g.status !== 'final').slice(0, 3);
  const results = games.filter((g) => g.status === 'final').reverse();
  dlg.innerHTML = `<div class="box-in">
    <div class="box-top"><h2 id="teamTitle">Teamseite</h2><button type="button" class="box-close" data-act="team-close" aria-label="Schliessen">×</button></div>
    <div class="team-hero">${logo(m, c, 'lg')}<div><b>${esc(fullName(m, c))}</b>
      <small>${t ? `Platz ${t.rank} · ${t.s}–${t.n} · ${t.d > 0 ? '+' : ''}${t.d}` : ''}</small>
      <small>${t ? `Heim ${t.hs}–${t.hn} · Auswärts ${t.as}–${t.an}${t.streak ? ` · Serie ${esc(t.streak)}` : ''}` : ''}</small>${formDots(m, c)}</div></div>
    <section class="panel chart">${chartHtml(m, c)}</section>
    ${next.length ? '<h3>Nächste Spiele</h3><div class="games" id="teamNext"></div>' : ''}
    <h3>Resultate</h3>${results.length ? '<div class="games" id="teamResults"></div>' : '<p class="label">Noch keine Spiele.</p>'}
    <h3>Kader · Saisonwerte pro Spiel</h3>
    ${players ? (roster.length ? `<div class="pl-wrap"><table class="pl-table num"><thead><tr><th scope="col" class="pl">Spieler</th><th scope="col"><abbr title="Spiele">Sp</abbr></th><th scope="col">Min</th><th scope="col">Pkt</th><th scope="col"><abbr title="Rebounds">Reb</abbr></th><th scope="col"><abbr title="Assists">Ass</abbr></th><th scope="col"><abbr title="Steals">St</abbr></th><th scope="col"><abbr title="Blocks">Bl</abbr></th><th scope="col"><abbr title="3-Punkte-Quote">3P%</abbr></th><th scope="col"><abbr title="Effizienz">PIR</abbr></th></tr></thead>
      <tbody>${roster.map((p) => `<tr><th scope="row" class="pl">${playerImg(p, 'pimg sm')}${esc(p.name)}</th><td>${p.gp}</td><td>${num1(p.min)}</td><td><b>${num1(p.pts)}</b></td><td>${num1(p.reb)}</td><td>${num1(p.ast)}</td><td>${num1(p.stl)}</td><td>${num1(p.blk)}</td><td>${num1(p.fg3p)}</td><td><b>${num1(p.pir)}</b></td></tr>`).join('')}</tbody></table></div>`
      : '<p class="label">Noch keine Spielerwerte.</p>') : `<p class="label">${esc(playersError || 'Lade Kader …')}</p>`}
    <p class="box-note small">Spiel antippen öffnet den Spielbericht.</p></div>`;
  const nx = $('#teamNext', dlg); if (nx) next.forEach((g) => nx.appendChild(gameRow(m, g, false)));
  const rs = $('#teamResults', dlg); if (rs) results.forEach((g) => rs.appendChild(gameRow(m, g, false)));
}

// ---------- Daten holen ----------
let playersError = '', playersLoading = null;
function loadPlayers() {
  if (players) return Promise.resolve();
  if (playersLoading) return playersLoading;
  const url = testData ? 'players-data.json' : `${DATA_URL}?players=1`;
  playersLoading = fetch(url, { headers: testData ? {} : { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(20000) })
    .then(async (res) => { const d = await res.json(); if (!res.ok || !Array.isArray(d?.players)) throw new Error(); players = d; playersError = ''; })
    .catch(() => { playersError = 'Die Spielerstatistik ist gerade nicht erreichbar.'; })
    .finally(() => { playersLoading = null; });
  return playersLoading;
}

async function loadData() {
  try {
    const headers = testData ? {} : { apikey: SUPABASE_ANON_KEY };
    const res = await fetch(DATA_URL, { headers, cache: 'no-store', signal: AbortSignal.timeout(20000) });
    const d = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(d?.games)) throw new Error(d?.error || `Fehler ${res.status}`);
    data = d;
    dataError = res.headers.get('x-offline') ? `Offline – angezeigt wird der Stand von ${zTime(new Date(d.updated))} Uhr.` : '';
  } catch {
    dataError = data ? 'Live-Daten gerade nicht erreichbar – angezeigt wird der letzte Stand.' : 'Resultate und Spielplan sind gerade nicht erreichbar. Bitte später nochmals öffnen.';
  }
}

async function loadNews() {
  try {
    const res = await fetch('news.json', { cache: 'no-cache' });
    const n = await res.json();
    if (Array.isArray(n?.items)) { const changed = JSON.stringify(n) !== JSON.stringify(news); news = n; return changed; }
  } catch { /* behalten, was da ist */ }
  return false;
}

function liveSoon() {
  const now = Date.now();
  return (data?.games || []).some((g) => g.status === 'live' || (g.status === 'pre' && new Date(g.utc) - now < 20 * 60000 && now - new Date(g.utc) < 4 * 3600e3));
}

let dataTimer, newsAt = 0;
async function refresh({ withNews = false } = {}) {
  clearTimeout(dataTimer);
  const [, newsChanged] = await Promise.all([loadData(), withNews || Date.now() - newsAt > NEWS_POLL_MS ? loadNews() : Promise.resolve(false)]);
  if (withNews || newsChanged) { newsAt = Date.now(); renderFeed(); }
  render();
  if ($('#teamDlg').open) renderTeamPage();
  if (document.visibilityState === 'visible') dataTimer = setTimeout(refresh, liveSoon() ? LIVE_POLL_MS : IDLE_POLL_MS);
}

// ---------- Bedienung ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act], [data-team], [data-src], .mtabs button');
  if (!t) return;
  if (t.matches('.mtabs button')) return setTab(t.dataset.tab);
  if (t.dataset.team) { sel = t.dataset.team; store.set('el-team', sel); return render(); }
  if (t.hasAttribute('data-src')) { feedState.src = t.dataset.src; return renderFeed(); }
  const act = t.dataset.act;
  if (act === 'toggle-table' || act === 'toggle-next') {
    const k = act === 'toggle-table' ? 'table' : 'next';
    open[k] = !open[k]; render();
  } else if (act === 'open-next') {
    open.next = true; setTab('spiel', false); render();
    $('#nextBox')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  } else if (act === 'show-news') showNews(Number(t.dataset.i));
  else if (act === 'more') {
    const i = Number(t.dataset.i);
    if (feedState.expanded.has(i)) feedState.expanded.delete(i); else feedState.expanded.add(i);
    renderFeed();
  } else if (act === 'share') share(Number(t.dataset.i));
  else if (act === 'box') openBox(Number(t.dataset.code));
  else if (act === 'box-close') $('#box').close();
  else if (act === 'box-team') { boxState.team = Number(t.dataset.i); boxState.shooter = ''; renderBox(); }
  else if (act === 'team') openTeam(t.dataset.c);
  else if (act === 'team-close') $('#teamDlg').close();
  else if (act === 'toggle-leaders') {
    open.leaders = !open.leaders; render();
    if (open.leaders && !players) loadPlayers().then(render);
  } else if (act === 'leader-cat') { leaderState.cat = t.dataset.cat; render(); }
  else if (act === 'leader-fav') { leaderState.fav = t.checked; render(); }
  else if (act === 'theme') toggleTheme();
  else if (act === 'logout') logout();
  else if (act === 'fav-edit') { favEdit = !favEdit; profileError = ''; render(); }
  else if (act === 'profile-logout') profileLogout();
  else if (act === 'copy-link') copyAccessLink();
  else if (act === 'fav-toggle') toggleFav(t.dataset.c);
  else if (act === 'onboarding-done') { if (!FAV.length) return; onboarding = false; introStage = true; refreshProfileUI(); }
  else if (act === 'intro-done') { introStage = false; enterApp(); }
  else if (act === 'profile-login-go' || act === 'profile-create-go') {
    const name = profileDraft.name.trim();
    const pin = profileDraft.pin.trim();
    if (!name || !/^\d{4,8}$/.test(pin)) { profileError = 'Name und eine PIN aus 4–8 Ziffern eingeben.'; refreshProfileUI(); return; }
    if (act === 'profile-login-go') profileLogin(name, pin); else profileCreate(name, pin);
  }
});

// ---------- Abmelden ----------
// Hebt die gemerkte Freischaltung (gate.js) wieder auf und lädt die Seite mit demselben Zugangs-Link neu,
// damit sofort wieder die Codeabfrage erscheint.
function logout() {
  let key = '';
  try {
    key = localStorage.getItem('el-gate-key') || '';
    localStorage.removeItem('el-gate-ok');
    localStorage.removeItem('el-gate-key');
    if (!key) sessionStorage.setItem('el-gate-relogin', '1');
  } catch { /* privates Fenster */ }
  const url = new URL(location.href);
  url.search = key ? `?key=${encodeURIComponent(key)}` : '';
  location.href = url.toString();
}
// Spielzeilen auch mit der Tastatur öffnen
document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('[data-act="box"], article[data-act="team"]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (t.dataset.act === 'box') openBox(Number(t.dataset.code)); else openTeam(t.dataset.c); }
});
$('#newsSearch').addEventListener('input', (e) => { feedState.q = e.target.value; renderFeed(); });
$('#box').addEventListener('close', () => { clearInterval(boxState.timer); boxState.code = 0; });
$('#teamDlg').addEventListener('close', () => { teamCode = ''; });
$('#teamDlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
document.addEventListener('change', (e) => { if (e.target.id === 'shotPlayer') { boxState.shooter = e.target.value; renderBox(); $('#shotPlayer')?.focus(); } });
document.addEventListener('submit', (e) => { if (e.target.id === 'profileForm') e.preventDefault(); });
document.addEventListener('input', (e) => {
  if (e.target.id === 'profName') profileDraft.name = e.target.value;
  else if (e.target.id === 'profPin') profileDraft.pin = e.target.value;
});

// ---------- Hell / Dunkel ----------
// Ohne eigene Wahl folgt die Seite dem iPhone; theme-boot.js setzt eine gespeicherte Wahl schon vor dem ersten Zeichnen
const currentTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
function themeUi() {
  const dark = currentTheme() === 'dark';
  const btn = $('#themeBtn');
  btn.innerHTML = icon(dark ? 'sun' : 'moon');
  btn.setAttribute('aria-label', dark ? 'Hellen Modus einschalten' : 'Dunklen Modus einschalten');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((mt) => { mt.content = bg; });
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('el-theme', next);
  themeUi();
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', themeUi);
themeUi();
// Klick neben das Fenster schliesst es
$('#box').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !document.body.classList.contains('needs-profile')) refresh();
  else clearTimeout(dataTimer);
});

// Ganz oben nach unten ziehen lädt die Seite neu (wie in iPhone-Apps) – vor allem für die Web-App vom
// Home-Bildschirm, die keinen Neu-laden-Knopf hat. Bringt neueste Spielstände, News und Version der Seite.
function setupPullToRefresh() {
  const THRESHOLD = 70, MAX = 110;
  const ind = el('div', 'ptr', icon('refresh'));
  ind.setAttribute('aria-hidden', 'true');
  document.body.append(ind);
  let startY = null, startX = 0, dy = 0, busy = false;
  const show = (d) => {
    const pos = Math.min(d, MAX);
    ind.style.transform = `translate(-50%, ${pos - 50}px) rotate(${pos * 3}deg)`;
    ind.style.opacity = String(Math.min(pos / THRESHOLD, 1));
    ind.classList.toggle('is-ready', d >= THRESHOLD);
  };
  const reset = () => { ind.style.transform = ''; ind.style.opacity = ''; ind.classList.remove('is-ready'); };
  window.addEventListener('touchstart', (e) => {
    if (busy || e.touches.length !== 1 || window.scrollY > 0 || $('#box').open || $('#teamDlg').open) return;
    startY = e.touches[0].clientY; startX = e.touches[0].clientX; dy = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const y = e.touches[0].clientY - startY, x = e.touches[0].clientX - startX;
    // Seitwärts wischen (Spiele von heute) oder nach oben scrollen: kein Aktualisieren
    if (y <= 0 || Math.abs(x) > y || window.scrollY > 0) { startY = null; reset(); return; }
    dy = y * 0.6; // etwas Widerstand, wie bei iOS
    show(dy);
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (startY == null) return;
    startY = null;
    if (dy < THRESHOLD) return reset();
    busy = true;
    ind.classList.add('is-loading');
    ind.style.transform = 'translate(-50%, 20px)';
    ind.style.opacity = '1';
    location.reload();
  });
  window.addEventListener('touchcancel', () => { startY = null; reset(); });
}

// Marke: „Sport“ führt zur KI-News-Seite
$('#siteLink').href = KI_NEWS_URL;

function boot() {
  setTab(tab, false);
  setupPullToRefresh();
  refresh({ withNews: true }).then(() => loadPlayers()).then(render);
}

// Teamdaten (für die Logos in der Favoriten-Auswahl) schon vor der Anmeldung laden, unabhängig vom Profilstatus.
// Nur die Teamwahl neu zeichnen, falls sie gerade offen ist – das Anmelde-/Anlege-Formular soll dabei nicht stören.
loadData().then(() => { if (onboarding) renderOnboarding(); });

// Ohne Profil geht es nicht weiter: zuerst ein vorhandenes Profil auf diesem Gerät prüfen, sonst das Pflicht-Fenster zeigen
(async () => {
  const state = await ensureProfile();
  if (state === 'in') { enterApp(); return; }
  document.body.classList.add('needs-profile');
  if (state === 'onboarding') { onboarding = true; renderOnboarding(); } else renderProfileGate();
})();

// ---------- Hinweis „App auf Homebildschirm speichern“ ----------
// Nur im Browser (nicht in der Web-App vom Home-Bildschirm) und nur auf Handy/Tablet. „Später“ oder × blendet ihn für
// zwei Wochen aus. Android-Browser bieten das Installieren selbst an (beforeinstallprompt) – dann direkt ein Knopf.
const INSTALL_KEY = 'el-install-later';
const INSTALL_PAUSE_MS = 14 * 864e5;
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => $('#install')?.remove());
function standalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
function setupInstallHint() {
  const force = params.get('install') === '1'; // zum Ausprobieren: ?install=1 zeigt den Hinweis immer
  if (standalone() && !force) return;
  if (!force && !matchMedia('(pointer: coarse)').matches) return; // nur Handy/Tablet
  if (!force && Date.now() - Number(store.get(INSTALL_KEY, 0)) < INSTALL_PAUSE_MS) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const shareIcon = '<svg class="ins-ico" viewBox="0 0 24 24" aria-label="Teilen"><path d="M12 15V3M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  setTimeout(() => {
    if ((standalone() && !force) || $('#box').open || $('#teamDlg').open) return;
    const howto = ios
      ? `Tippe in Safari auf ${shareIcon} <b>Teilen</b> (bei neueren iPhones im Menü <b>«…»</b>) und dann auf <b>«Zum Home-Bildschirm»</b>. Danach öffnet sich die Seite wie eine App – ohne Adresszeile.`
      : installEvent ? 'Mit einem Tipp auf «Installieren» liegt die Seite wie eine App auf deinem Startbildschirm.'
      : 'Öffne im Browser das Menü <b>⋮</b> und wähle <b>«App installieren»</b> bzw. <b>«Zum Startbildschirm hinzufügen»</b>.';
    const box = el('section', 'install', `<img src="icon-180.png" alt="" width="44" height="44">
      <div class="ins-text"><h2>App auf Homebildschirm speichern</h2><p>${howto}</p>
        <div class="ins-acts">${!ios && installEvent ? '<button type="button" class="ins-go" data-ins="go">Installieren</button>' : ''}<button type="button" class="ins-later" data-ins="later">Später</button></div></div>
      <button type="button" class="ins-close" data-ins="later" aria-label="Hinweis schliessen">×</button>`);
    box.id = 'install'; box.setAttribute('role', 'region'); box.setAttribute('aria-label', 'Hinweis: App auf Homebildschirm speichern');
    box.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-ins]'); if (!b) return;
      if (b.dataset.ins === 'go' && installEvent) { installEvent.prompt(); await installEvent.userChoice.catch(() => null); installEvent = null; }
      else store.set(INSTALL_KEY, String(Date.now()));
      box.classList.add('is-gone');
      setTimeout(() => box.remove(), 250);
    });
    document.body.append(box);
  }, 2500);
}
setupInstallHint();

// Offline-Modus: sw.js hält den letzten Stand bereit (nur über https bzw. localhost)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
