# Sport-News Euroleague

Euroleague-Tagesüberblick als eigene Website: News, Resultate, Tabelle, nächste Spiele und Live-Spielstände.
Läuft auf GitHub Pages, ohne Build-Schritt (reines HTML/CSS/JavaScript).

## Woher die Daten kommen

| Teil | Quelle | Aktualisierung |
|---|---|---|
| Resultate, Spielplan, Tabelle, Live-Stände | Supabase-Funktion `euroleague` (holt sie von den öffentlichen Schnittstellen der EuroLeague) | bei jedem Öffnen; während eines Spiels jede Minute |
| Spielbericht (Antippen eines Spiels: Viertel, Teamvergleich, Spielerstatistik) | Supabase-Funktion `euroleague` mit `?game=…` (Boxscore der EuroLeague) | beim Öffnen; während eines Spiels alle 30 Sekunden |
| Wurfkarte (im Spielbericht) | Supabase-Funktion `euroleague` mit `?game=…` (Würfe mit Koordinaten) | wie der Spielbericht |
| Bestenlisten, Kader, Top-Spieler der Vorschau | Supabase-Funktion `euroleague` mit `?players=1` (Saisonwerte pro Spiel aller Spieler) | höchstens alle 30 Minuten neu |
| News (16 Meldungen) | `news.json` in diesem Repository | täglich um 07:15 durch eine Claude-Aufgabe |
| Lieblingsteams | ohne Profil: nur lokal auf dem Gerät (`localStorage`); mit Profil (Name+PIN): Tabelle `el_profiles`, über die Funktion `euroleague` | bei jeder Änderung |

Die Tabelle, die Form der Teams und die Kurve werden auf der Seite aus allen Resultaten der Saison berechnet.
Ebenso Heim-/Auswärtsbilanz, Serie und die Vorschau vor einem Spiel (Form, Tabellenplatz, Duelle dieser Saison).

**Offline:** `sw.js` hält Seite und letzten Datenstand bereit; ohne Netz steht „Offline – angezeigt wird der Stand von …“.
**Hell/Dunkel:** folgt dem iPhone; der Knopf oben rechts legt es fest (nur auf diesem Gerät, `theme-boot.js`).

## Einrichtung

### 1. GitHub Pages

Repository-Einstellungen → **Pages** → Source **Deploy from a branch**, Branch `main`, Ordner `/ (root)` → Save.
Die Seite ist danach unter `https://ccodel9876.github.io/euroleague/` erreichbar.

### 2. Supabase-Funktion `euroleague`

Im selben Supabase-Projekt wie die Haushalt-App:

1. Supabase-Dashboard → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Als Namen genau `euroleague` eintragen, den Inhalt von
   [supabase/functions/euroleague/index.ts](supabase/functions/euroleague/index.ts) hineinkopieren → **Deploy function**.
3. Bei der Funktion die **JWT-Prüfung ausschalten** (Verify JWT aus).

Die Funktion braucht keine Anmeldung: Sie liefert nur öffentliche EuroLeague-Daten und antwortet nur der eigenen
Seite (`ALLOWED_ORIGINS` oben in der Datei). Sie speichert nichts und hält Spielplan (2 Minuten) und Spielstände
(20 Sekunden) kurz im Arbeitsspeicher, damit viele Aufrufe die EuroLeague nicht mehrfach abfragen.

### 3. Zugriffsschutz (`gate.js`)

Die Seite ist für einen eingeladenen Kreis gedacht, kein öffentliches Angebot: Ohne einen geheimen Link-Parameter
bleibt sie leer; mit dem Parameter erscheint ein Eingabefeld für einen gemeinsamen Code. Beide Werte liegen als
**Secrets derselben Supabase-Funktion** (nicht im Repository, nicht im Quelltext):

1. Supabase-Dashboard → Edge Functions → `euroleague` → **Secrets** → zwei Werte setzen:
   - `GATE_KEY` – der geheime Teil der Link-URL
   - `GATE_CODE` – der Code, den alle berechtigten Personen eingeben
2. Der Zugangslink lautet dann `https://ccodel9876.github.io/euroleague/?key=<GATE_KEY>` – den Link **und** den
   Code getrennt weitergeben (z. B. Link per Nachricht, Code mündlich).
3. Nach richtigem Code merkt sich das Gerät den Zugang (`localStorage`), der `?key=…`-Teil wird aus der
   Adressleiste entfernt.

Das ist bewusst **keine echte Benutzerverwaltung** – nur eine Hürde gegen zufällige Besucher:innen.

### 4. Profile (Name + PIN) für geräteübergreifende Lieblingsteams

Jede Person kann sich ein eigenes, leichtes Profil anlegen (Name + 4- bis 8-stellige PIN, keine E-Mail) und damit
ihre Lieblingsteams auf mehreren Geräten gleich sehen. Die PIN wird nur gehasht gespeichert, die Prüfung läuft in
der Funktion `euroleague` – die Tabelle selbst ist für alle anderen gesperrt. Einmalig einrichten:

1. **Tabelle anlegen** – Supabase-Dashboard → **SQL Editor** → Neue Abfrage → diesen SQL-Code ausführen:
   ```sql
   create table if not exists el_profiles (
     key text primary key,          -- Name klein geschrieben, zum Nachschlagen
     name text not null,            -- Name wie eingegeben, zur Anzeige
     pin_hash text not null,
     favorites text[] not null default '{}',
     updated_at timestamptz not null default now()
   );
   alter table el_profiles enable row level security;
   ```
   Die Tabelle bleibt ohne eigene RLS-Regeln für `anon`/`authenticated` komplett gesperrt; nur die Funktion kommt
   mit dem Service-Role-Key daran vorbei.
2. **Service-Role-Key als Secret setzen** – Supabase-Dashboard → **Project Settings** → **API** → **service_role**
   Key kopieren (⚠️ nicht mit dem `anon`-Key verwechseln – dieser Key umgeht alle Zugriffsregeln). Dann unter
   **Edge Functions** → **Secrets** einen neuen Eintrag `SUPABASE_SERVICE_ROLE_KEY` mit diesem Wert anlegen.
3. Die Funktion `euroleague` wie gewohnt mit dem aktuellen Code neu deployen (sie enthält jetzt auch die
   Profil-Routen).

Ohne diese Einrichtung funktioniert die Seite weiterhin normal – Lieblingsteams bleiben dann einfach rein lokal
auf dem jeweiligen Gerät, wie zuvor.

### 5. News-Aufgabe

Eine geplante Claude-Aufgabe sucht täglich neue Meldungen (Sportando, Eurohoops, BasketNews, RealGM), fasst sie auf
Deutsch zusammen und schreibt sie in `news.json`:

```json
{ "issue": 31, "updated": "30. Oktober 2026 · 07:17 Uhr (CH)",
  "items": [{ "tag": "Resultat · Zalgiris", "title": "…", "text": "…", "time": "28.10.2026 · 22:49",
              "source": "Sportando", "url": "https://…", "firstShown": "29.10.2026" }] }
```

`firstShown` (TT.MM.JJJJ) bestimmt, welche Meldungen unter „Neu heute“ und welche unter „Frühere Meldungen“ stehen.

## Lokal testen

Im Ordner einen einfachen Webserver starten (z. B. `python3 -m http.server`) und `http://localhost:8000/` öffnen –
die Funktion antwortet auch `localhost`. Ohne eingerichtete Funktion: `?data=datei.json` lädt eine Datei mit
Testdaten im selben Format statt der Funktion.

## Kosten

Keine: GitHub Pages ist für öffentliche Repositories gratis; die Aufrufe der Supabase-Funktion liegen weit im
kostenlosen Rahmen (während eines Spiels ein Aufruf pro Minute und offenem Gerät).
