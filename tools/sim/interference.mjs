/**
 * Störgeräusch-Prüfstand: wie oft zeigt die App bei Umgebungsgeräuschen einen Ton an?
 */
import { speech, knocks, whistle, clatter, mix } from './noise.mjs';
import { SR, WINDOW, STEP_MS } from './bench.mjs';

export const INTERFERENCE = [
  ['Sprechen Mann', (level, seed) => speech({ f0: 115, level, seed })],
  ['Sprechen Frau', (level, seed) => speech({ f0: 210, level, seed })],
  ['Sprechen Kind', (level, seed) => speech({ f0: 290, level, seed })],
  ['Klopfen', (level, seed) => knocks({ level, seed })],
  ['Pfeifen/Piepen', (level, seed) => whistle({ level, seed })],
  ['Klappern', (level, seed) => clatter({ level, seed })],
];

/** Anteil der Takte mit (nicht blasser) Anzeige und Zahl der angezeigten Töne. */
export function interference(makePipeline, signal) {
  const p = makePipeline();
  const step = Math.round((SR * STEP_MS) / 1000);
  let frames = 0;
  let shown = 0;
  let events = 0;
  let prev = null;
  for (let end = WINDOW; end <= signal.length; end += step) {
    const f = p(signal.subarray(end - WINDOW, end), (end / SR) * 1000);
    frames++;
    if (f !== null) shown++;
    if (f !== null && prev === null) events++;
    prev = f;
  }
  return { share: (100 * shown) / frames, events };
}

export function interferenceSignal(make, level, seed = 1) {
  return mix(make(level, seed), { seed: seed + 100 });
}
