# Stimmgerät – Gitarre & Ukulele

Präzises Stimmgerät als installierbare Web-App (PWA) für Android. Kostenlos, ohne Werbung, ohne Datenübertragung – der Ton wird nur auf dem Gerät ausgewertet.

## Funktionen

- **Gitarre:** Standard, Drop D, Halbton tiefer, DADGAD, Open G, Open D
- **Ukulele:** Standard (G C E A), Low-G, Bariton, D-Stimmung
- **Chromatisch:** zeigt den nächstgelegenen Halbton für beliebige Instrumente
- Automatische Saitenerkennung oder feste Saitenwahl durch Antippen
- Waagerechte Skala: Marker links = zu tief, rechts = zu hoch, grünes Feld in der Mitte = gestimmt
- Leuchtender Pfeil und Klartext („Etwas höher stimmen“) zeigen die Drehrichtung
- Erkennt auch leise gezupfte Nylonsaiten; meldet „kräftiger zupfen“, wenn der Ton zu leise ist
- Reaktion rund 0,03 Sekunden nach dem Anschlag, ruhiger Marker ohne Zittern
- Kammerton A4 einstellbar (430–450 Hz), Referenzton je Saite
- Deutsche (H) oder internationale (B) Notennamen
- Funktioniert nach der Installation offline

## Bedienung

1. **Mikrofon einschalten** antippen und den Zugriff erlauben.
2. Instrument und Stimmung wählen.
3. Eine Saite anzupfen. Der Marker erscheint auf der Skala:
   links / blau = zu tief, rechts / rot = zu hoch, im grünen Feld = gestimmt.
   Der leuchtende Pfeil neben dem Notennamen zeigt, in welche Richtung der Marker wandern muss.
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

Danach <http://localhost:8137> öffnen. Mit `?test=110` wird statt des Mikrofons ein künstlicher Ton mit 110 Hz eingespeist (mit `&delay=1000` setzt er erst nach einer Sekunde ein, `&level=-50` legt den Pegel in dBFS fest; die gemessene Reaktionszeit steht im Attribut `data-test` des `<html>`-Elements); mit `?sw=1` wird der Service Worker auch lokal aktiviert.

Nach Änderungen an den Dateien die Versionsnummer `CACHE` in `sw.js` erhöhen, damit installierte Apps die neue Version laden. Ab Version 1.1 lädt sich die App beim nächsten Öffnen einmal selbst neu; die Versionsnummer steht in den Einstellungen.

### Aufbau

| Datei | Inhalt |
|---|---|
| `js/pitch.js` | Tonhöhenerkennung (McLeod Pitch Method: Grobsuche bei 12 kHz, Feinsuche bei voller Abtastrate) |
| `js/tracker.js` | entscheidet, was angezeigt wird: Rauschpegel-Schätzung, Start-/Halte-Hysterese, Oktavkorrektur, Kalman-Filter |
| `js/pitch-worker.js` | führt Erkennung und Tracker im Hintergrund-Thread aus |
| `js/audio.js` | Mikrofon, Analyse-Schleife (50 Messungen pro Sekunde, Fenster 170 ms) |
| `js/tunings.js` | Stimmungen, Notennamen, Umrechnungen |
| `js/tone.js` | Referenzton |
| `js/app.js` | Oberfläche und Einstellungen |
| `sw.js`, `manifest.webmanifest` | Offline-Betrieb und Installation |
| `tools/make-icons.mjs` | erzeugt die Icons (`npm run icons`) |
| `test/pitch.test.mjs` | Genauigkeitstests der Erkennung |
| `test/tracker.test.mjs` | Praxistests: nachgebildete Saiten über ein Handy-Mikrofon, verarbeitet wie in der App |
| `tools/simulate.mjs` | Prüfstand mit Messtabelle; mit Pfad zu einer alten `pitch.js` auch als Vorher-Nachher-Vergleich |

### Genauigkeit und Zuverlässigkeit

Die Tests prüfen alle Saiten aller Stimmungen bei 44,1 und 48 kHz: Bei sauberen Tönen liegt der Messfehler unter 0,1 Cent, mit Rauschen und abklingendem Ton unter 0,5 Cent.

Der Prüfstand (`node tools/simulate.mjs`) bildet gezupfte Nylonsaiten nach, wie ein Handy-Mikrofon sie aufnimmt: schwache Bässe, Raumrauschen, mitschwingende Leersaiten, Schwebungen und den Tonhöhenabfall nach dem Anschlag. Ergebnis für alle sechs Gitarrensaiten bei normalem, leisem und sehr leisem Anschlag:

| | Version 1.1 | Version 1.2 |
|---|---|---|
| erkannte Töne | 6 von 18 | 18 von 18 |
| angezeigte Dauer des Klangs | 14 % | 51 % |
| Reaktion bei normalem Anschlag | 50–70 ms | 10–30 ms |
| Markerbewegung je Takt bei stehendem Ton | 0,43 Cent | 0,05 Cent |
| Geistertöne in 2 Minuten Raumrauschen, auch mit Brummen | – | 0 |

Die Mikrofon-Verzögerung des Handys kommt jeweils hinzu. In der Praxis begrenzen Mikrofon, Raumgeräusche und die Saite selbst die Genauigkeit auf etwa ± 1 Cent; bei Tönen, die kaum lauter als das Raumrauschen sind, auf etwa ± 5 Cent (die App bittet dann um kräftigeres Zupfen).
