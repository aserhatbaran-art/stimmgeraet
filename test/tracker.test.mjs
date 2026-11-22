/**
 * Praxistests: nachgebildete Saitentöne über ein Handy-Mikrofon, verarbeitet wie in der App
 * (Erkennung + Tracker im 20-ms-Takt). Grenzwerte mit Abstand zu den gemessenen Werten,
 * damit echte Verschlechterungen auffallen, kleine Schwankungen aber nicht.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluck, truePitch } from '../tools/sim/guitar.mjs';
import { run, newPipeline, SR, WINDOW, STEP_MS } from '../tools/sim/bench.mjs';

const PHONE = { noise: -75, room: -68, micCutoff: 150, micOrder: 4 }; // Handy mit schwachen Bässen
const GOOD_MIC = { noise: -80, room: -72, micCutoff: 80, micOrder: 2 };
const GUITAR = [82.41, 110, 146.83, 196, 246.94, 329.63];
const UKULELE = [392, 261.63, 329.63, 440];
const others = (list, f) => list.filter((x) => x !== f);
const pipeline = () => newPipeline();

function check(label, r, { latency, coverage, bias = 1.5, move = 0.5 }) {
  assert.ok(r.latency !== null, `${label}: nicht erkannt`);
  assert.ok(r.latency <= latency, `${label}: Reaktion ${r.latency} ms > ${latency} ms`);
  assert.equal(r.wrong, 0, `${label}: ${r.wrong} % falsche Töne`);
  assert.equal(r.ghost, 0, `${label}: Anzeige vor dem Anschlag`);
  if (coverage) assert.ok(r.coverage >= coverage, `${label}: nur ${r.coverage} % der Klingdauer angezeigt`);
  if (r.bias !== null) assert.ok(Math.abs(r.bias) <= bias, `${label}: Abweichung ${r.bias.toFixed(2)} Cent`);
  if (r.move !== null) assert.ok(r.move <= move, `${label}: Zeiger zittert (${r.move.toFixed(2)} Cent je Takt)`);
}

test('Konzertgitarre, normale Lautstärke: sofort, richtig, ruhig', () => {
  for (const freq of GUITAR) {
    const r = run(pipeline, { ...PHONE, freq, level: -45, string: 'nylon', sympathetic: others(GUITAR, freq), seed: 1 });
    check(`${freq} Hz`, r, { latency: 80, coverage: 55 });
  }
});

test('Konzertgitarre, leise gezupft (−58 dB)', () => {
  for (const freq of GUITAR) {
    const r = run(pipeline, { ...PHONE, freq, level: -58, string: 'nylon', sympathetic: others(GUITAR, freq), seed: 2 });
    // Tiefe Saiten liegen hier nur 4–8 dB über dem Raumrauschen; ±2,5 Cent liegt noch im grünen Bereich (±3)
    check(`${freq} Hz`, r, { latency: 250, coverage: 20, bias: 2.5 });
  }
});

test('Konzertgitarre, sehr leise (−64 dB, kaum über dem Rauschen): wird erkannt', () => {
  // Nur ~3 dB über dem Raumrauschen schwankt jede Messung um rund 6 Cent (physikalische Grenze).
  // Die App zeigt den Ton trotzdem an und bittet um kräftigeres Zupfen; gefordert ist hier nur die richtige Richtung.
  for (const freq of GUITAR) {
    const r = run(pipeline, { ...PHONE, freq, level: -64, string: 'nylon', sympathetic: others(GUITAR, freq), seed: 3 });
    check(`${freq} Hz`, r, { latency: 400, bias: 7 });
  }
});

test('Zu leiser Ton wird als „schwach“ gemeldet, kräftiger Ton nicht', async () => {
  const { PitchDetector } = await import('../js/pitch.js');
  const { Tracker } = await import('../js/tracker.js');
  const share = (level) => {
    const signal = pluck({ ...PHONE, freq: 110, level, string: 'nylon', sampleRate: SR, seconds: 1.5, pluckAt: 0.5, seed: 10 });
    const detector = new PitchDetector(SR);
    const tracker = new Tracker();
    let shown = 0;
    let weak = 0;
    for (let end = WINDOW; end <= signal.length; end += (SR * STEP_MS) / 1000) {
      const out = tracker.update(detector.detect(signal.subarray(end - WINDOW, end)), (end / SR) * 1000);
      if (end / SR < 0.6 || out.freq === null || out.stale) continue;
      shown++;
      if (out.weak) weak++;
    }
    return weak / shown;
  };
  assert.ok(share(-64) > 0.6, 'sehr leiser Ton nicht als schwach gemeldet');
  assert.ok(share(-45) < 0.05, 'kräftiger Ton fälschlich als schwach gemeldet');
});

test('Verstimmte Saiten werden mit der richtigen Abweichung angezeigt', () => {
  for (const [freq, cents] of [[82.41, -40], [110, 25], [196, -15], [329.63, 45]]) {
    const detuned = freq * 2 ** (cents / 1200);
    const r = run(pipeline, { ...PHONE, freq: detuned, level: -50, string: 'nylon', seed: 4 });
    check(`${freq} Hz ${cents} Cent`, r, { latency: 120 });
  }
});

test('Ukulele (Nylon)', () => {
  for (const freq of UKULELE) {
    for (const level of [-48, -60]) {
      const r = run(pipeline, { ...PHONE, freq, level, string: 'nylon', sympathetic: others(UKULELE, freq), seed: 5 });
      check(`${freq} Hz ${level} dB`, r, { latency: level > -50 ? 80 : 250 });
    }
  }
});

test('Westerngitarre (Stahl) mit besserem Mikrofon', () => {
  for (const freq of GUITAR) {
    const r = run(pipeline, { ...GOOD_MIC, freq, level: -50, string: 'steel', sympathetic: others(GUITAR, freq), seed: 6 });
    // Stahlsaiten sind leicht inharmonisch (Obertöne etwas zu hoch) – Messung liegt dadurch bis ~2 Cent höher
    check(`${freq} Hz`, r, { latency: 80, coverage: 65, bias: 2.5 });
  }
});

test('Wirbel drehen: Anzeige folgt ohne großen Nachlauf', () => {
  for (const freq of [82.41, 196, 329.63]) {
    const r = run(pipeline, { ...PHONE, freq, level: -45, string: 'nylon', bend: { from: 0.8, to: 1.4, cents: 30 }, seed: 7 });
    assert.ok(r.lag !== null && r.lag < 6, `${freq} Hz: Nachlauf ${r.lag?.toFixed(1)} Cent`);
  }
});

test('Saitenwechsel, während die vorige Saite noch klingt', () => {
  const a = { ...PHONE, freq: 110, level: -45, string: 'nylon', seed: 8 };
  const d = { ...PHONE, freq: 146.83, level: -48, string: 'nylon', seed: 9, room: -120, noise: -120 };
  const first = pluck({ ...a, sampleRate: SR, seconds: 4, pluckAt: 0.5 });
  const second = pluck({ ...d, sampleRate: SR, seconds: 4, pluckAt: 1.5 });
  const signal = first.map((v, i) => v + second[i]);
  const truth = (_, t) => (t < 1 ? truePitch(a, t) : truePitch(d, t - 1));
  const r = run(pipeline, { signal, truth });
  const switched = r.rows.find((row) => row.t >= 1 && row.shown && Math.abs(1200 * Math.log2(row.shown / row.truth)) < 10);
  assert.ok(switched, 'neue Saite nicht übernommen');
  assert.ok(switched.t - 1 <= 0.15, `Wechsel erst nach ${Math.round((switched.t - 1) * 1000)} ms`);
});

test('Kein Geisterton im Raumrauschen', () => {
  for (const [room, noise] of [[-68, -75], [-55, -72], [-78, -85]]) {
    const signal = pluck({ freq: 100, level: -200, room, noise, seconds: 12, pluckAt: 11.9, sampleRate: SR, seed: -room });
    const step = Math.round((SR * STEP_MS) / 1000);
    const p = pipeline();
    let shown = 0;
    for (let end = WINDOW; end <= signal.length - SR * 0.2; end += step) {
      if (p(signal.subarray(end - WINDOW, end), (end / SR) * 1000) !== null) shown++;
    }
    assert.equal(shown, 0, `Raum ${room} dB: ${shown} Geistertöne`);
  }
});

test('Start mit leerem Puffer: kein Geisterton, danach wird ein Ton sofort erkannt', () => {
  // Direkt nach dem Start liefert das Mikrofon kurz nur Nullen, dann lautes Raumrauschen
  const noise = pluck({ freq: 100, level: -200, room: -55, noise: -70, seconds: 6, pluckAt: 5.9, sampleRate: SR, seed: 21 });
  const tone = pluck({ ...PHONE, room: -55, noise: -70, freq: 110, level: -40, string: 'nylon', seconds: 6, pluckAt: 4.5, sampleRate: SR, seed: 22 });
  const signal = noise.map((v, i) => (i < SR * 0.4 ? 0 : i < SR * 4.5 ? v : tone[i]));
  const p = pipeline();
  const step = Math.round((SR * STEP_MS) / 1000);
  let ghosts = 0;
  let first = null;
  for (let end = WINDOW; end <= signal.length; end += step) {
    const t = end / SR;
    const shown = p(signal.subarray(end - WINDOW, end), t * 1000);
    if (t < 4.5 && shown !== null) ghosts++;
    if (t >= 4.5 && shown !== null && first === null) first = t - 4.5;
  }
  assert.equal(ghosts, 0, `${ghosts} Geistertöne in der Einlernphase`);
  assert.ok(first !== null && first <= 0.1, `Ton erst nach ${first} s erkannt`);
});

test('Gleichbleibender Brummton wird nach einigen Sekunden ausgeblendet, eine Saite danach trotzdem erkannt', () => {
  const sr = SR;
  const seconds = 14;
  const n = sr * seconds;
  const room = pluck({ freq: 100, level: -200, room: -70, noise: -78, seconds, pluckAt: seconds - 0.1, sampleRate: sr, seed: 31 });
  const string = pluck({ ...PHONE, freq: 196, level: -45, string: 'nylon', seconds, pluckAt: 11, sampleRate: sr, seed: 32 });
  // Brummen 120 Hz mit Obertönen, gleichbleibend −50 dBFS
  const signal = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const hum = Math.sin(2 * Math.PI * 120 * t) + 0.5 * Math.sin(2 * Math.PI * 240 * t) + 0.3 * Math.sin(2 * Math.PI * 360 * t);
    signal[i] = 0.0032 * 0.85 * hum + room[i] + string[i] * (t >= 11 ? 1 : 0);
  }
  const p = pipeline();
  const step = Math.round((sr * STEP_MS) / 1000);
  let humShownLate = 0;
  let stringShown = false;
  for (let end = WINDOW; end <= n; end += step) {
    const t = end / sr;
    const shown = p(signal.subarray(end - WINDOW, end), t * 1000);
    if (t > 9 && t < 11 && shown !== null) humShownLate++;
    if (t > 11.1 && t < 12 && shown !== null && Math.abs(1200 * Math.log2(shown / 196)) < 20) stringShown = true;
  }
  assert.equal(humShownLate, 0, `Brummen nach 9 s noch ${humShownLate} Takte angezeigt`);
  assert.ok(stringShown, 'Saite neben dem Brummen nicht erkannt');
});
