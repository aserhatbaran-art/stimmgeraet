/**
 * Prüfstand: spielt nachgebildete Gitarrentöne durch Erkennung und Anzeige-Filter,
 * genau im Takt der App (alle 20 ms ein Fenster von 8192 Samples bei 48 kHz).
 *
 * Aufruf:  node tools/simulate.mjs [pfad/zu/alter/pitch.js]
 * Umgebungsvariable TRACKER='{"q":800}' setzt Tracker-Optionen zum Ausprobieren.
 * Mit Pfad wird zusätzlich die alte Verarbeitung (Version 1.1) zum Vergleich gemessen.
 */
import { pluck } from './sim/guitar.mjs';
import { SR, WINDOW, STEP_MS, run, newPipeline as makeNew, oldPipeline } from './sim/bench.mjs';
import { pathToFileURL } from 'node:url';

const newPipeline = () => makeNew(process.env.TRACKER ? JSON.parse(process.env.TRACKER) : {});

const STRINGS = [
  ['E2', 82.41],
  ['A2', 110],
  ['D3', 146.83],
  ['G3', 196],
  ['H3', 246.94],
  ['E4', 329.63],
];

export const SCENARIOS = [];
for (const [name, freq] of STRINGS) {
  // Die übrigen Leersaiten schwingen leise mit
  const sympathetic = STRINGS.map(([, f]) => f).filter((f) => f !== freq);
  for (const level of [-45, -58, -64]) {
    SCENARIOS.push({ name, freq, level, noise: -75, room: -68, micCutoff: 150, micOrder: 4, string: 'nylon', sympathetic, seed: Math.round(freq) + level });
  }
}
// Wirbel drehen: 30 Cent in 0,6 s nach oben, bei normalem Pegel
export const BENDS = [82.41, 196, 329.63].map((freq) => ({
  name: `Wirbel ${freq.toFixed(0)} Hz`,
  freq,
  level: -45,
  noise: -75,
  room: -68,
  micCutoff: 150,
  micOrder: 4,
  string: 'nylon',
  bend: { from: 0.8, to: 1.4, cents: 30 },
  seed: 7,
}));

function fmt(v, digits = 0, unit = '') {
  return v === null || v === undefined ? '   –' : `${v.toFixed(digits)}${unit}`;
}

function report(label, makePipeline) {
  console.log(`\n=== ${label} ===`);
  console.log('Saite Pegel   Reaktion  Abdeckung  falsch  Geister  Streuung  Bewegung/Takt  eingeschwungen');
  const all = [];
  for (const s of SCENARIOS) {
    const r = run(makePipeline, s);
    all.push(r);
    console.log(
      `${s.name.padEnd(5)} ${String(s.level).padStart(4)} dB ${fmt(r.latency, 0, ' ms').padStart(9)} ${fmt(r.coverage, 0, ' %').padStart(10)} ${fmt(r.wrong, 0, ' %').padStart(7)} ${String(r.ghost).padStart(8)} ${fmt(r.sd, 2, ' ct').padStart(9)} ${fmt(r.move, 2, ' ct').padStart(14)} ${fmt(r.settle, 0, ' ms').padStart(15)}`,
    );
  }
  for (const s of BENDS) {
    const r = run(makePipeline, s);
    console.log(`${s.name.padEnd(16)} Nachlauf beim Drehen Ø ${fmt(r.lag, 1, ' ct')}`);
  }
  const det = all.filter((r) => r.latency !== null);
  const sds = all.filter((r) => r.sd !== null).map((r) => r.sd);
  const lags = BENDS.map((s) => run(makePipeline, s).lag);
  console.log(`Streuung Ø ${(sds.reduce((a, b) => a + b, 0) / sds.length).toFixed(2)} ct, max ${Math.max(...sds).toFixed(2)} ct; Nachlauf Ø ${(lags.reduce((a, b) => a + b, 0) / lags.length).toFixed(1)} ct`);
  console.log(
    `Summe: erkannt ${det.length}/${all.length}, Reaktion Ø ${Math.round(det.reduce((s, r) => s + r.latency, 0) / (det.length || 1))} ms, Abdeckung Ø ${Math.round(all.reduce((s, r) => s + r.coverage, 0) / all.length)} %, Bewegung/Takt Ø ${(det.filter((r) => r.move !== null).reduce((s, r) => s + r.move, 0) / (det.filter((r) => r.move !== null).length || 1)).toFixed(2)} ct`,
  );
  return all;
}

/** Geistertöne: 30 s reines Raum- und Mikrofonrauschen in verschiedenen Stärken. */
function ghosts(makePipeline) {
  let frames = 0;
  let shown = 0;
  for (const [room, noise] of [[-68, -75], [-60, -72], [-75, -82], [-50, -70]]) {
    const signal = pluck({ freq: 100, level: -200, room, noise, seconds: 30, pluckAt: 29.9, sampleRate: SR, seed: room });
    const pipeline = makePipeline();
    const step = Math.round((SR * STEP_MS) / 1000);
    for (let end = WINDOW; end <= signal.length - SR * 0.2; end += step) {
      frames++;
      if (pipeline(signal.subarray(end - WINDOW, end), (end / SR) * 1000) !== null) shown++;
    }
  }
  console.log(`Geistertöne im reinen Rauschen: ${shown} von ${frames} Takten`);
}

const oldPath = process.argv[2];
if (oldPath) {
  const { PitchDetector: OldDetector } = await import(pathToFileURL(oldPath).href);
  report('Version 1.1 (alt)', () => oldPipeline(OldDetector));
}
report('Neu', newPipeline);
ghosts(newPipeline);
