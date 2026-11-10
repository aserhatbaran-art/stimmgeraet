import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchDetector } from '../js/pitch.js';
import { TUNINGS, midiToFreq } from '../js/tunings.js';

const N = 4096;

/** Reproduzierbarer Zufallsgenerator. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Künstlicher Saitenton: Grundton + Obertöne, optional Rauschen und Abklingen. */
function synth(freq, sampleRate, { harmonics = [1, 0.6, 0.4, 0.3, 0.2, 0.1], noise = 0, decay = 0, seed = 1 } = {}) {
  const rand = rng(seed);
  const phases = harmonics.map(() => rand() * 2 * Math.PI);
  const out = new Float32Array(N);
  const norm = 0.25 / harmonics.reduce((s, h) => s + h, 0);
  for (let i = 0; i < N; i++) {
    const t = i / sampleRate;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      v += harmonics[h] * Math.sin(2 * Math.PI * freq * (h + 1) * t + phases[h]);
    }
    v *= norm * Math.exp(-decay * t);
    if (noise) v += noise * (rand() * 2 - 1);
    out[i] = v;
  }
  return out;
}

const cents = (f, ref) => 1200 * Math.log2(f / ref);

// Alle Saiten aller Stimmungen, jeweils nur einmal
const midiNotes = [...new Set(Object.values(TUNINGS).flatMap((list) => list.flatMap((t) => t.strings)))].sort(
  (a, b) => a - b,
);

for (const sampleRate of [44100, 48000]) {
  test(`saubere Töne, ${sampleRate} Hz: Fehler < 0,1 Cent`, () => {
    const detector = new PitchDetector(sampleRate);
    let worst = 0;
    for (const midi of midiNotes) {
      for (const offset of [-37, -9, 0, 4, 23, 48]) {
        const f = midiToFreq(midi, 440) * 2 ** (offset / 1200);
        const result = detector.detect(synth(f, sampleRate, { seed: midi * 100 + offset }));
        assert.ok(result.freq, `kein Ton erkannt bei ${f.toFixed(2)} Hz`);
        const err = Math.abs(cents(result.freq, f));
        worst = Math.max(worst, err);
        assert.ok(err < 0.1, `${f.toFixed(2)} Hz erkannt als ${result.freq.toFixed(3)} Hz (${err.toFixed(3)} Cent)`);
      }
    }
    console.log(`  größter Fehler: ${worst.toFixed(4)} Cent`);
  });

  test(`Rauschen + Abklingen, ${sampleRate} Hz: Fehler < 0,5 Cent`, () => {
    const detector = new PitchDetector(sampleRate);
    let worst = 0;
    for (const midi of midiNotes) {
      for (const offset of [-20, 0, 15]) {
        const f = midiToFreq(midi, 440) * 2 ** (offset / 1200);
        const result = detector.detect(synth(f, sampleRate, { noise: 0.006, decay: 4, seed: midi * 7 + offset }));
        assert.ok(result.freq, `kein Ton erkannt bei ${f.toFixed(2)} Hz`);
        const err = Math.abs(cents(result.freq, f));
        worst = Math.max(worst, err);
        assert.ok(err < 0.5, `${f.toFixed(2)} Hz erkannt als ${result.freq.toFixed(3)} Hz (${err.toFixed(3)} Cent)`);
      }
    }
    console.log(`  größter Fehler: ${worst.toFixed(4)} Cent`);
  });
}

test('schwacher Grundton (Handy-Mikrofon bei tiefen Saiten): kein Oktavfehler', () => {
  const detector = new PitchDetector(48000);
  for (const midi of [38, 40, 43, 45, 50]) {
    const f = midiToFreq(midi, 440);
    const result = detector.detect(synth(f, 48000, { harmonics: [0.08, 1, 0.8, 0.5, 0.35, 0.2], noise: 0.003, seed: midi }));
    assert.ok(result.freq, `kein Ton erkannt bei ${f.toFixed(2)} Hz`);
    assert.ok(Math.abs(cents(result.freq, f)) < 0.5, `${f.toFixed(2)} Hz erkannt als ${result.freq.toFixed(2)} Hz`);
  }
});

test('reiner Sinus wird erkannt', () => {
  const detector = new PitchDetector(48000);
  for (const f of [82.41, 110, 196, 329.63, 440, 880]) {
    const result = detector.detect(synth(f, 48000, { harmonics: [1] }));
    assert.ok(result.freq && Math.abs(cents(result.freq, f)) < 0.1, `${f} Hz erkannt als ${result.freq}`);
  }
});

test('Stille liefert keinen Ton', () => {
  const detector = new PitchDetector(48000);
  assert.equal(detector.detect(new Float32Array(N)).freq, null);
});

test('Rauschen liefert keinen Ton', () => {
  const detector = new PitchDetector(48000);
  for (let seed = 1; seed <= 20; seed++) {
    const rand = rng(seed);
    const noise = Float32Array.from({ length: N }, () => 0.2 * (rand() * 2 - 1));
    assert.equal(detector.detect(noise).freq, null, `Rauschen (Seed ${seed}) fälschlich als Ton erkannt`);
  }
});

test('anderer Kammerton: 432 Hz wird als 432 Hz gemessen', () => {
  const detector = new PitchDetector(48000);
  const result = detector.detect(synth(432, 48000));
  assert.ok(Math.abs(cents(result.freq, 432)) < 0.1);
});
