/**
 * Störgeräusche: Die App soll nur gezupfte Saiten anzeigen – nicht Sprechen, Klopfen,
 * Pfeifen oder Klappern in der Umgebung. Nachbildungen siehe tools/sim/noise.mjs.
 * Gemessen wird der Anteil der Zeit, in der eine (nicht blasse) Anzeige erscheint.
 * Vorher (Version 1.2): Sprechen 51–73 %, Pfeifen 46–50 %, Klopfen 21–38 %, Klappern 14–42 %.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluck } from '../tools/sim/guitar.mjs';
import { speech } from '../tools/sim/noise.mjs';
import { INTERFERENCE, interference, interferenceSignal } from '../tools/sim/interference.mjs';
import { run, newPipeline, SR } from '../tools/sim/bench.mjs';
import { Tracker } from '../js/tracker.js';

const GUITAR_RANGE = [55, 440]; // wie in der App: tiefste Saite − 7 Halbtöne … höchste + 5
const PHONE = { noise: -75, room: -68, micCutoff: 150, micOrder: 4 };
const signals = new Map();
const signal = (name, make, level) => {
  const key = `${name}${level}`;
  if (!signals.has(key)) signals.set(key, interferenceSignal(make, level));
  return signals.get(key);
};

test('Gitarre: Umgebungsgeräusche ohne Saite lösen (fast) keine Anzeige aus', () => {
  for (const [name, make] of INTERFERENCE) {
    for (const level of [-55, -35]) {
      const r = interference(() => newPipeline({ range: GUITAR_RANGE }), signal(name, make, level));
      if (name.startsWith('Pfeifen') || name.startsWith('Klappern')) {
        assert.equal(r.events, 0, `${name} ${level} dB: ${r.events} Anzeigen`);
      } else {
        assert.ok(r.share <= 8, `${name} ${level} dB: ${r.share.toFixed(1)} % der Zeit angezeigt`);
      }
    }
  }
});

test('Chromatisch (ohne Tonumfang): Sprechen und Klopfen bleiben selten', () => {
  for (const [name, make] of INTERFERENCE.filter(([n]) => n.startsWith('Sprechen') || n === 'Klopfen')) {
    const r = interference(() => newPipeline(), signal(name, make, -45));
    assert.ok(r.share <= 8, `${name}: ${r.share.toFixed(1)} % der Zeit angezeigt`);
  }
});

test('Gespräch im Hintergrund: Saiten werden trotzdem richtig angezeigt', () => {
  for (const f0 of [115, 210]) {
    const voice = speech({ f0, level: -65, seconds: 4, seed: 9 });
    for (const freq of [82.41, 110, 146.83, 196, 246.94, 329.63]) {
      const s = { ...PHONE, freq, level: -45, string: 'nylon', seed: 5, sampleRate: SR, seconds: 4, pluckAt: 0.5 };
      const mixed = pluck(s).map((v, i) => v + voice[i]);
      const r = run(() => newPipeline({ range: GUITAR_RANGE }), { ...s, signal: mixed });
      const label = `${freq} Hz, Stimme ${f0} Hz`;
      // Bei laufendem Gespräch gilt die längere Probezeit (10 Messungen) → bis 0,3 s
      assert.ok(r.latency !== null && r.latency <= 300, `${label}: Reaktion ${r.latency} ms`);
      assert.equal(r.wrong, 0, `${label}: ${r.wrong} % falsche Töne`);
      assert.ok(Math.abs(r.bias) <= 5, `${label}: Abweichung ${r.bias.toFixed(1)} Cent`);
    }
  }
});

test('Tonumfang: ungültige Angaben werden ignoriert', () => {
  const t = new Tracker();
  t.setRange([300, 100]);
  assert.equal(t.range, null);
  t.setRange(['x', 5]);
  assert.equal(t.range, null);
  t.setRange([60, 500]);
  assert.deepEqual(t.range, [60, 500]);
  t.setRange(null);
  assert.equal(t.range, null);
});
