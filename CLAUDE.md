# Stimmgerät (PWA)
Zweck: Stimmgerät für Gitarre/Ukulele als installierbare Web-App für Android; Schwerpunkt leise Nylonsaiten über Handy-Mikrofon.
Live: https://aserhatbaran-art.github.io/stimmgeraet/ (GitHub Pages, Branch `main`, Root). Aktuell Version 1.3.

## Befehle
- Testen: `node --test` (29 Tests, ~25 s)
- Prüfstand mit Messtabelle (Saiten + Störgeräusche): `node tools/simulate.mjs` · Vergleich mit alter Erkennung: `node tools/simulate.mjs <pfad/alte/pitch.js>` · Tracker-Optionen testen: `TRACKER='{"q":800}' node tools/simulate.mjs`
- Lokal starten: Browser-Vorschau „stimmgeraet“ (.claude/launch.json) bzw. `python -m http.server 8137` → http://localhost:8137
- Testmodus ohne Mikrofon: `?test=110&delay=1000&level=-30` (Reaktionszeit in `<html data-test>`); `?sw=1` aktiviert Service Worker lokal
- Icons neu erzeugen: `node tools/make-icons.mjs`
- Veröffentlichen: `git push origin main` → nach ~1 min live

## Struktur
- `js/pitch.js`: Tonhöhenerkennung (McLeod/NSDF, Grobsuche 12 kHz, Feinsuche bis 30 Perioden, Rückfall auf kurzes Fenster)
- `js/tracker.js`: Anzeige-Logik: Rauschpegel-Schätzung, Start-/Halte-Hysterese, Störgeräusch-Filter (Tonumfang, 4 stabile Messungen, Pegelabfall, nach Störungen 10 Messungen), Untertöne bei Mischungen (8 Messungen Probezeit), Vorrang der zuletzt angeschlagenen Saite (`prevX`), Zurückspringen nach Störung, Kalman-Filter, Brummton-Erkennung (6 s)
- `js/pitch-worker.js`: Erkennung + Tracker im Worker; `js/audio.js`: Mikrofon, 20-ms-Takt, Fenster 170 ms (8192 @ 48 kHz), Fallback ohne Worker
- `js/app.js`: Oberfläche (waagerechte Skala ±50 Cent, Pfeile, Hinweistexte, Saiten, Einstellungen in localStorage); setzt den Tonumfang (`instrumentRange`, tiefste Saite −7 / höchste +5 Halbtöne) über `tuner.setRange`
- `js/tunings.js`: Stimmungen (MIDI-Nummern), Notennamen (H/B); `js/tone.js`: Referenzton
- `sw.js`: Offline-Cache (Dateiliste + Version `stimmgeraet-vN`); `manifest.webmanifest`
- `test/pitch.test.mjs` (Erkennung), `test/tracker.test.mjs` (Praxistests), `test/interference.test.mjs` (Störgeräusche); `tools/sim/guitar.mjs` (Saiten), `tools/sim/noise.mjs` (Störgeräusche), `tools/sim/bench.mjs` + `interference.mjs` (Prüfstand-Kern)

## Konventionen
- Reines HTML/CSS/JS, ES-Module, kein Build, keine Abhängigkeiten; alle Pfade relativ (läuft unter /stimmgeraet/)
- `pitch.js` und `tracker.js` ohne Browser-APIs (in Node testbar)
- Oberfläche und Kommentare auf Deutsch; Commits auf Deutsch mit Co-Authored-By-Zeile
- Git-E-Mail im Projekt: `aserhatbaran-art@users.noreply.github.com` (nicht die private Adresse)

## Achtung
- Bei jeder Dateiänderung: `CACHE` in `sw.js` hochzählen, neue Dateien in `FILES` aufnehmen, Version in `index.html` (`.version`) und `package.json` anheben
- Nutzerwunsch: keine Cent-Angaben in der Oberfläche (zu verwirrend); Anzeige = waagerechte Skala
- Tracker-Parameter sind am Prüfstand abgestimmt: nach Änderungen `node tools/simulate.mjs` und `node --test` vergleichen (Erkennung 18/18, Geistertöne 0, Störgeräusche Gitarre ≤ 5 %)
- Zielkonflikt Reaktion ↔ Störfestigkeit: 4 Bestätigungs-Messungen (70–90 ms) gewählt; 3 Messungen wären 20 ms schneller, aber ~10× mehr Fehlanzeigen bei Sprechen
- Grenzen: Wechsel auf tiefere Saite, deren Oberton die nachklingende Saite ist (E4→A2/E2, H3→E2), nur bis ~10 dB leiser; sehr leise Töne (~3 dB über Rauschen) ±5 Cent; Stahlsaiten +≤2 Cent (Inharmonizität); Nachlauf beim Wirbeldrehen ~4 Cent; Stimme mit ähnlicher Tonhöhe nur 10–15 dB leiser als die Saite verschiebt die Anzeige um bis zu ~25 Cent (Mischsignal, mit einem Mikrofon nicht trennbar); chromatisch werden Pfeiftöne angezeigt (echte Töne)
- Kotlin-Umbau geprüft und verworfen (11/2026): Störanfälligkeit liegt in der Auswertung, nicht in der Plattform; Nachteile: APK-Installation, keine automatischen Updates
- Weißfilter gegen Raumrauschen getestet und verworfen (verschlechtert die Messung)
- Echtes Mikrofon nur am Handy testbar; Testbrowser-Screenshots zeigen Farben teils blass (Aufnahme-Artefakt)
- Nicht getestet: Querformat (bewusst nicht unterstützt)
