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

### 3. News-Aufgabe

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
