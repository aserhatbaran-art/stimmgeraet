/**
 * Hintergrund-Thread für die Tonhöhenerkennung. Dadurch blockiert die
 * Berechnung weder die Anzeige noch das Antippen der Tasten.
 *
 * Nachrichten:
 *   { sampleRate }  → Erkennung einrichten
 *   { buffer }      → Samples auswerten; der Puffer wird mit dem Ergebnis zurückgegeben
 */
import { PitchDetector } from './pitch.js';

let detector = null;

self.onmessage = ({ data }) => {
  if (data.sampleRate) {
    detector = new PitchDetector(data.sampleRate);
    return;
  }
  const started = performance.now();
  const result = detector.detect(new Float32Array(data.buffer));
  result.ms = performance.now() - started;
  self.postMessage({ result, buffer: data.buffer }, [data.buffer]);
};
