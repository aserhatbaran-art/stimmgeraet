/**
 * Prüfstand-Kern: spielt ein Szenario durch eine Verarbeitung, genau im Takt der App
 * (alle 20 ms ein Fenster von 8192 Samples bei 48 kHz), und bewertet die Anzeige.
 */
import { pluck, truePitch } from './guitar.mjs';
import { PitchDetector } from '../../js/pitch.js';
import { Tracker } from '../../js/tracker.js';

export const SR = 48000;
export const WINDOW = Number(globalThis.process?.env?.WINDOW) || 8192;
export const STEP_MS = 20;
const PLUCK = 0.5;
const SECONDS = 3.5;

/** Neue Verarbeitung: Erkennung + Tracker. Liefert je Takt die angezeigte Frequenz oder null. */
export function newPipeline(options = {}) {
  const detector = new PitchDetector(SR);
  const tracker = new Tracker(options);
  return (buffer, now) => {
    const out = tracker.update(detector.detect(buffer), now);
    return out.freq !== null && !out.stale ? out.freq : null;
  };
}

/** Alte Verarbeitung (Version 1.1), nachgebaut aus audio.js und app.js. */
export function oldPipeline(OldDetector) {
  const detector = new OldDetector(SR);
  const hist = [];
  let misses = 0;
  let needle = null;
  return (buffer) => {
    const r = detector.detect(buffer);
    let freq = null;
    if (r.freq === null) {
      if (++misses >= 3) hist.length = 0;
    } else {
      misses = 0;
      hist.push(r.freq);
      if (hist.length > 3) hist.shift();
      if (hist.length >= 3) freq = [...hist].sort((a, b) => a - b)[1];
      else if (hist.length === 2 && Math.abs(Math.log2(hist[1] / hist[0])) < 1 / 24) freq = hist[1];
    }
    if (freq === null) return null;
    // Zeiger: Trägheit 35 ms bei 20-ms-Takt
    const cents = 1200 * Math.log2(freq);
    needle = needle === null ? cents : needle + (cents - needle) * (1 - Math.exp(-STEP_MS / 35));
    return 2 ** (needle / 1200);
  };
}

/**
 * @param {() => (buffer: Float32Array, nowMs: number) => number|null} makePipeline
 * @param {object} scenario Parameter für pluck(); optional `signal` (fertiges Signal, Anschlag bei 0,5 s)
 */
export function run(makePipeline, scenario) {
  const signal = scenario.signal ?? pluck({ ...scenario, sampleRate: SR, seconds: PLUCK + SECONDS, pluckAt: PLUCK });
  const step = Math.round((SR * STEP_MS) / 1000);
  const pipeline = makePipeline();
  const rows = [];
  for (let end = WINDOW; end <= signal.length; end += step) {
    const t = end / SR - PLUCK; // Zeit seit Anschlag
    const shown = pipeline(signal.subarray(end - WINDOW, end), (end / SR) * 1000);
    if (t < -0.1) continue;
    rows.push({ t, shown, truth: t >= 0 ? (scenario.truth ?? truePitch)(scenario, t) : null });
  }

  const during = rows.filter((r) => r.t >= 0);
  const live = during.filter((r) => r.shown !== null);
  const err = (r) => 1200 * Math.log2(r.shown / r.truth);
  const first = live[0];
  const wrong = live.filter((r) => Math.abs(err(r)) > 50).length;
  const ghost = rows.filter((r) => r.t < 0 && r.shown !== null).length;

  // Ruhe der Anzeige: Streuung und mittlere Bewegung je Takt in 0,8 … 3 s
  const steady = live.filter((r) => r.t >= 0.8 && Math.abs(err(r)) <= 50 && !scenario.bend);
  const errs = steady.map(err);
  const mean = errs.reduce((s, v) => s + v, 0) / (errs.length || 1);
  const sd = Math.sqrt(errs.reduce((s, v) => s + (v - mean) ** 2, 0) / (errs.length || 1));
  let moves = 0;
  for (let i = 1; i < errs.length; i++) moves += Math.abs(errs[i] - errs[i - 1]);

  // Wirbel drehen: mittlerer Abstand der Anzeige zur wahren Tonhöhe während und kurz nach der Änderung
  let lag = null;
  if (scenario.bend) {
    const during = live.filter((r) => r.t >= scenario.bend.from && r.t <= scenario.bend.to + 0.3);
    lag = during.reduce((s, r) => s + Math.abs(err(r)), 0) / (during.length || 1);
  }

  // Einschwingen: ab wann bleibt die Anzeige innerhalb ± 3 Cent um die wahre Tonhöhe?
  let settle = null;
  for (let i = live.length - 1; i >= 0; i--) {
    if (Math.abs(err(live[i])) > 3) break;
    settle = live[i].t;
  }

  return {
    rows,
    latency: first ? Math.round(first.t * 1000) : null,
    coverage: Math.round((100 * live.length) / during.length),
    wrong: Math.round((100 * wrong) / (live.length || 1)),
    ghost,
    sd: errs.length ? sd : null,
    move: errs.length > 1 ? moves / (errs.length - 1) : null,
    bias: errs.length ? mean : null,
    settle: settle === null ? null : Math.round(settle * 1000),
    lag,
  };
}
