/**
 * Nachbildung typischer Störgeräusche beim Stimmen, wie ein Handy-Mikrofon sie aufnimmt.
 * Prüfstand dafür, dass die App nur gezupfte Saiten anzeigt und nicht auf Umgebungsgeräusche reagiert.
 *
 *  - speech:  Sprechen (Silben mit gleitender Tonhöhe, Vokal-Formanten, Pausen, Konsonanten)
 *  - knocks:  Klopfen, Absetzen von Gegenständen (kurze, gedämpfte Resonanzen)
 *  - whistle: Pfeifen, Piepen, Vogelstimmen (hohe Töne)
 *  - clatter: Klappern, Geschirr, Schritte (kurze Geräuschimpulse)
 * Jede Funktion liefert ein Signal mit dem angegebenen Pegel (dBFS, RMS der aktiven Abschnitte)
 * ohne Raumrauschen; mit `mix` wird es zum Raumrauschen addiert.
 */
import { rng, highpass, pluck } from './guitar.mjs';

const VOWELS = [
  [730, 1090, 2440], // a
  [530, 1840, 2480], // e
  [270, 2290, 3010], // i
  [570, 840, 2410], // o
  [300, 870, 2240], // u
  [660, 1720, 2410], // ä
];

/** Spektrale Hüllkurve eines Vokals (drei Formanten) bei Frequenz f. */
function formantGain(f, [f1, f2, f3]) {
  const peak = (fc, bw) => 1 / (1 + ((f - fc) / bw) ** 2);
  return peak(f1, 90) + 0.6 * peak(f2, 120) + 0.3 * peak(f3, 160) + 0.02;
}

/**
 * Sprechen: Silben von 100–300 ms, Tonhöhe gleitet je Silbe um bis zu ± 4 Halbtöne,
 * Wörter und Satzpausen dazwischen.
 * @param {object} o
 * @param {number} [o.seconds=20]
 * @param {number} [o.level=-45] Pegel der stimmhaften Abschnitte (dBFS)
 * @param {number} [o.f0=120]    mittlere Sprechtonhöhe (Hz): Männer ~110, Frauen ~210, Kinder ~300
 * @param {number} [o.seed=1]
 * @param {number} [o.sampleRate=48000]
 */
export function speech(o = {}) {
  const sr = o.sampleRate ?? 48000;
  const n = Math.round((o.seconds ?? 20) * sr);
  const rand = rng(o.seed ?? 1);
  const base = o.f0 ?? 120;
  const out = new Float64Array(n);

  let i = Math.round(0.2 * sr);
  let phase = 0;
  while (i < n) {
    // Ein Wort aus 1–4 Silben
    const syllables = 1 + Math.floor(rand() * 4);
    for (let s = 0; s < syllables && i < n; s++) {
      const dur = Math.round((0.1 + rand() * 0.2) * sr);
      const startF = base * 2 ** ((rand() * 2 - 1) * 4 / 12);
      const glide = (rand() * 2 - 1) * 4; // Halbtöne über die Silbe
      const vowel = VOWELS[Math.floor(rand() * VOWELS.length)];
      const loud = 10 ** ((rand() * 2 - 1) * 4 / 20);
      // Konsonant davor: kurzes Rauschen
      const cons = Math.round((0.02 + rand() * 0.05) * sr);
      for (let k = 0; k < cons && i + k < n; k++) out[i + k] += 0.15 * loud * (rand() * 2 - 1);
      i += cons;
      // stimmhafter Teil: Obertöne mit Formant-Hüllkurve
      let gains = null;
      let gainF0 = 0;
      for (let k = 0; k < dur && i + k < n; k++) {
        const t = k / dur;
        const f0 = startF * 2 ** ((glide * t) / 12) * (1 + 0.004 * Math.sin(2 * Math.PI * 5.3 * (k / sr)));
        if (!gains || Math.abs(f0 / gainF0 - 1) > 0.01) {
          gains = [];
          for (let h = 1; h * f0 < 4000; h++) gains.push((formantGain(h * f0, vowel) / h) * 2);
          gainF0 = f0;
        }
        phase += (2 * Math.PI * f0) / sr;
        let v = 0;
        for (let h = 0; h < gains.length; h++) v += gains[h] * Math.sin((h + 1) * phase);
        const env = Math.min(1, k / (0.025 * sr), (dur - k) / (0.04 * sr));
        out[i + k] += loud * env * v;
      }
      i += dur + Math.round(rand() * 0.06 * sr);
    }
    // Pause zwischen Wörtern, gelegentlich längere Satzpause
    i += Math.round((rand() < 0.2 ? 0.4 + rand() * 0.8 : 0.05 + rand() * 0.2) * sr);
  }
  return finish(out, sr, o.level ?? -45);
}

/** Klopfen, Absetzen von Gegenständen: gedämpfte Resonanzen 80–500 Hz, Abklingzeit 20–120 ms. */
export function knocks(o = {}) {
  const sr = o.sampleRate ?? 48000;
  const n = Math.round((o.seconds ?? 20) * sr);
  const rand = rng(o.seed ?? 2);
  const out = new Float64Array(n);
  for (let t = 0.3 + rand(); t < (o.seconds ?? 20) - 0.5; t += 0.4 + rand() * 1.6) {
    const at = Math.round(t * sr);
    const modes = 1 + Math.floor(rand() * 3);
    const loud = 10 ** ((rand() * 2 - 1) * 6 / 20);
    for (let m = 0; m < modes; m++) {
      const f = 80 + rand() * 420;
      const tau = 0.02 + rand() * 0.1;
      const amp = loud / (m + 1);
      const len = Math.min(n - at, Math.round(tau * 6 * sr));
      for (let k = 0; k < len; k++) out[at + k] += amp * Math.exp(-k / (tau * sr)) * Math.sin((2 * Math.PI * f * k) / sr);
    }
    for (let k = 0; k < Math.round(0.003 * sr) && at + k < n; k++) out[at + k] += loud * (rand() * 2 - 1);
  }
  return finish(out, sr, o.level ?? -40);
}

/** Pfeifen, Piepen, Vogelstimmen: Töne 600–3000 Hz, teils gleitend, 0,1–1 s lang. */
export function whistle(o = {}) {
  const sr = o.sampleRate ?? 48000;
  const n = Math.round((o.seconds ?? 20) * sr);
  const rand = rng(o.seed ?? 3);
  const out = new Float64Array(n);
  for (let t = 0.3; t < (o.seconds ?? 20) - 1; t += 0.3 + rand() * 1.5) {
    const at = Math.round(t * sr);
    const len = Math.round((0.1 + rand() * 0.9) * sr);
    const f = 600 + rand() * 2400;
    const glide = rand() < 0.5 ? 0 : (rand() * 2 - 1) * 7;
    let ph = 0;
    for (let k = 0; k < len && at + k < n; k++) {
      ph += (2 * Math.PI * f * 2 ** ((glide * k) / len / 12)) / sr;
      const env = Math.min(1, k / (0.01 * sr), (len - k) / (0.02 * sr));
      out[at + k] += env * (Math.sin(ph) + 0.1 * Math.sin(2 * ph));
    }
    t += len / sr;
  }
  return finish(out, sr, o.level ?? -45);
}

/** Klappern, Geschirr, Schritte: kurze Geräuschimpulse mit hohen Resonanzen. */
export function clatter(o = {}) {
  const sr = o.sampleRate ?? 48000;
  const n = Math.round((o.seconds ?? 20) * sr);
  const rand = rng(o.seed ?? 4);
  const out = new Float64Array(n);
  for (let t = 0.2; t < (o.seconds ?? 20) - 0.3; t += 0.05 + rand() * 0.5) {
    const at = Math.round(t * sr);
    const len = Math.round((0.005 + rand() * 0.04) * sr);
    const f = 1500 + rand() * 4000;
    const loud = 10 ** ((rand() * 2 - 1) * 8 / 20);
    for (let k = 0; k < len && at + k < n; k++) {
      const env = Math.exp(-k / (0.3 * len));
      out[at + k] += loud * env * (0.6 * (rand() * 2 - 1) + Math.sin((2 * Math.PI * f * k) / sr));
    }
  }
  return finish(out, sr, o.level ?? -40);
}

/** Handy-Mikrofon (Hochpass 150 Hz, 4. Ordnung) und Pegel der aktiven Abschnitte einstellen. */
function finish(x, sr, level) {
  highpass(x, sr, 150);
  highpass(x, sr, 150);
  let e = 0;
  let count = 0;
  const block = Math.round(0.02 * sr);
  for (let b = 0; b + block <= x.length; b += block) {
    let s = 0;
    for (let k = b; k < b + block; k++) s += x[k] * x[k];
    if (s > 0) {
      e += s;
      count += block;
    }
  }
  // Nur hörbare Abschnitte zählen (oberhalb 1 % der mittleren Energie)
  const mean = e / (count || 1);
  e = 0;
  count = 0;
  for (let b = 0; b + block <= x.length; b += block) {
    let s = 0;
    for (let k = b; k < b + block; k++) s += x[k] * x[k];
    if (s / block > 0.01 * mean) {
      e += s;
      count += block;
    }
  }
  const gain = 10 ** (level / 20) / Math.sqrt(e / (count || 1) || 1);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * gain;
  return out;
}

/** Störgeräusch zum Raumrauschen addieren. */
export function mix(signal, { room = -68, noise = -75, seed = 5, sampleRate = 48000 } = {}) {
  const seconds = signal.length / sampleRate;
  const bg = pluck({ freq: 100, level: -200, room, noise, seconds, pluckAt: seconds - 0.1, sampleRate, seed });
  return signal.map((v, i) => v + bg[i]);
}
