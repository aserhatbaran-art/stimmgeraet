/**
 * Hintergrund-Thread für Tonhöhenerkennung und Tracker. Dadurch blockiert die
 * Berechnung weder die Anzeige noch das Antippen der Tasten.
 *
 * Nachrichten:
 *   { sampleRate, range } → Erkennung einrichten (setzt auch den Tracker zurück)
 *   { range }             → Tonumfang des Instruments ändern ([tiefste, höchste] Hz oder null)
 *   { buffer, time }      → Samples auswerten; time = Aufnahmezeitpunkt in ms.
 *                           Der Puffer wird mit dem Ergebnis zurückgegeben.
 */
import { PitchDetector } from './pitch.js';
import { Tracker } from './tracker.js';

let detector = null;
let tracker = null;

self.onmessage = ({ data }) => {
  if (data.sampleRate) {
    detector = new PitchDetector(data.sampleRate);
    tracker = new Tracker({ range: data.range ?? null });
    return;
  }
  if ('range' in data) {
    tracker?.setRange(data.range);
    return;
  }
  const started = performance.now();
  const raw = detector.detect(new Float32Array(data.buffer));
  const result = tracker.update(raw, data.time);
  result.ms = performance.now() - started;
  self.postMessage({ result, buffer: data.buffer }, [data.buffer]);
};
