# Stimmgerät – Gitarre & Ukulele

Präzises Stimmgerät als installierbare Web-App (PWA) für Android. Kostenlos, ohne Werbung, ohne Datenübertragung – der Ton wird nur auf dem Gerät ausgewertet.

## Funktionen

- **Gitarre:** Standard, Drop D, Halbton tiefer, DADGAD, Open G, Open D
- **Ukulele:** Standard (G C E A), Low-G, Bariton, D-Stimmung
- **Chromatisch:** zeigt den nächstgelegenen Halbton für beliebige Instrumente
- Automatische Saitenerkennung oder feste Saitenwahl durch Antippen
- Zeiger mit Ruheposition: ohne Ton liegt er links, mit Ton zeigt er die Abweichung
- Gespreizte Skala: bis ± 10 Cent bewegt 1 Cent den Zeiger deutlich; grünes Feld innerhalb ± 3 Cent
- Anzeige in Cent und Hz, Reaktion rund 0,05–0,1 Sekunden nach dem Anschlag
- Kammerton A4 einstellbar (430–450 Hz), Referenzton je Saite
- Deutsche (H) oder internationale (B) Notennamen
- Funktioniert nach der Installation offline

## Bedienung

1. **Mikrofon einschalten** antippen und den Zugriff erlauben.
2. Instrument und Stimmung wählen.
3. Eine Saite anzupfen. Der Zeiger schwingt aus der Ruheposition links zur Messposition:
   links der Mitte / blau = zu tief, rechts / rot = zu hoch, im grünen Feld = gestimmt.
4. Optional eine Saite antippen, um sie fest zu wählen (hilfreich bei neuen, stark verstimmten Saiten).
5. **Referenzton** einschalten und eine Saite antippen, um den Zielton zu hören.

Tipp: Handy nah ans Schallloch legen, in ruhiger Umgebung stimmen, Saite einzeln und nicht zu hart anschlagen.

## Veröffentlichen mit GitHub Pages (kostenlos)

Das Mikrofon funktioniert im Browser nur über HTTPS – deshalb muss die App einmal gehostet werden.

1. Auf <https://github.com> anmelden (oder kostenloses Konto anlegen).
2. Neues Repository anlegen: Name z. B. `stimmgeraet`, Sichtbarkeit **Public**, ohne README.
3. Im Projektordner ausführen (`DEIN-NAME` ersetzen). Beim ersten Push öffnet sich ein Browserfenster zur Anmeldung.

   ```bash
   git remote add origin https://github.com/DEIN-NAME/stimmgeraet.git
   ```

   ```bash
   git push -u origin main
   ```

4. Im Repository: **Settings → Pages → Build and deployment → Source: „Deploy from a branch“**, Branch **main**, Ordner **/ (root)**, **Save**.
5. Nach etwa einer Minute ist die App erreichbar unter `https://DEIN-NAME.github.io/stimmgeraet/`.

## Auf dem Android-Handy installieren

1. Die Adresse in **Chrome** öffnen.
2. Menü **⋮ → „App installieren“** (oder „Zum Startbildschirm hinzufügen“).
3. Die App über das neue Icon starten und das Mikrofon erlauben.

## Entwicklung

Kein Build-Schritt, keine Abhängigkeiten.

```bash
npm test
```

```bash
npm start
```

Danach <http://localhost:8137> öffnen. Mit `?test=110` wird statt des Mikrofons ein künstlicher Ton mit 110 Hz eingespeist (mit `&delay=1000` setzt er erst nach einer Sekunde ein, die gemessene Reaktionszeit steht dann im Attribut `data-test` des `<html>`-Elements); mit `?sw=1` wird der Service Worker auch lokal aktiviert.

Nach Änderungen an den Dateien die Versionsnummer `CACHE` in `sw.js` erhöhen, damit installierte Apps die neue Version laden. Ab Version 1.1 lädt sich die App beim nächsten Öffnen einmal selbst neu; die Versionsnummer steht in den Einstellungen.

### Aufbau

| Datei | Inhalt |
|---|---|
| `js/pitch.js` | Tonhöhenerkennung (McLeod Pitch Method: Grobsuche bei 12 kHz, Feinsuche bei voller Abtastrate) |
| `js/pitch-worker.js` | führt die Erkennung im Hintergrund-Thread aus |
| `js/audio.js` | Mikrofon, Analyse-Schleife (50 Messungen pro Sekunde), Ausreißer-Filter |
| `js/tunings.js` | Stimmungen, Notennamen, Umrechnungen |
| `js/tone.js` | Referenzton |
| `js/app.js` | Oberfläche und Einstellungen |
| `sw.js`, `manifest.webmanifest` | Offline-Betrieb und Installation |
| `tools/make-icons.mjs` | erzeugt die Icons (`npm run icons`) |
| `test/pitch.test.mjs` | Genauigkeitstests |

### Genauigkeit

Die Tests prüfen alle Saiten aller Stimmungen bei 44,1 und 48 kHz: Bei sauberen Tönen liegt der Messfehler unter 0,01 Cent, mit Rauschen und abklingendem Ton unter 0,5 Cent. Eine Messung dauert rund 0,2 ms; ein Ton wird erkannt, sobald etwa vier Perioden vorliegen (tiefe E-Saite: rund 60 ms). In der Praxis begrenzen Mikrofon und Saitenschwingung die Genauigkeit auf etwa ± 1 Cent.
