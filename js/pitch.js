/**
 * Tonhöhenerkennung nach der McLeod Pitch Method (MPM).
 *
 * Ablauf:
 *  1. Gleichanteil entfernen, Pegel (RMS) bestimmen.
 *  2. Normalisierte Differenzfunktion (NSDF) für alle Verschiebungen berechnen.
 *  3. Erstes ausreichend hohes Maximum wählen (vermeidet Oktavfehler durch Obertöne).
 *  4. Parabolische Interpolation → Periodenlänge mit Sub-Sample-Genauigkeit.
 *  5. Verfeinerung über Vielfache der Periode (längere Messbasis → höhere Genauigkeit).
 *
 * Die Datei verwendet keine Browser-APIs und ist deshalb auch in Node testbar.
 */

export class PitchDetector {
  /**
   * @param {number} sampleRate Abtastrate in Hz
   * @param {object} [options]
   * @param {number} [options.minFreq=60]     tiefste erkennbare Frequenz
   * @param {number} [options.maxFreq=1400]   höchste erkennbare Frequenz
   * @param {number} [options.threshold=0.93] Anteil des höchsten Maximums, ab dem ein früheres Maximum gewählt wird
   * @param {number} [options.minClarity=0.9] Mindest-Klarheit (0…1), darunter gilt das Signal als Geräusch
   * @param {number} [options.minRms=0.002]   Mindestpegel, darunter gilt das Signal als Stille
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.minFreq = options.minFreq ?? 60;
    this.maxFreq = options.maxFreq ?? 1400;
    this.threshold = options.threshold ?? 0.93;
    this.minClarity = options.minClarity ?? 0.9;
    this.minRms = options.minRms ?? 0.002;
    this._x = null;
    this._nsdf = null;
  }

  /**
   * @param {Float32Array|number[]} input Zeitsignal (z. B. 4096 Samples)
   * @returns {{freq: number|null, clarity: number, rms: number}}
   */
  detect(input) {
    const n = input.length;
    if (!this._x || this._x.length !== n) this._x = new Float64Array(n);
    const x = this._x;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += input[i];
    mean /= n;

    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = input[i] - mean;
      x[i] = v;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / n);
    if (!(rms >= this.minRms)) return { freq: null, clarity: 0, rms: rms || 0 };

    const maxLag = Math.min(Math.floor(this.sampleRate / this.minFreq) + 2, (n >> 1) - 1);
    const minLag = Math.max(2, Math.floor(this.sampleRate / this.maxFreq));
    if (!this._nsdf || this._nsdf.length !== maxLag + 2) this._nsdf = new Float64Array(maxLag + 2);
    const nsdf = this._nsdf;

    // NSDF: n'(τ) = 2·r'(τ) / m'(τ)
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      m -= x[tau - 1] * x[tau - 1] + x[n - tau] * x[n - tau];
      let r = 0;
      const end = n - tau;
      for (let j = 0; j < end; j++) r += x[j] * x[j + tau];
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }

    // Maxima der positiven Abschnitte sammeln (das erste Tal nach τ = 0 wird übersprungen)
    let tau = 1;
    while (tau <= maxLag && nsdf[tau] > 0) tau++;

    let bestLag = -1;
    let highest = 0;
    const lags = [];
    while (tau <= maxLag) {
      while (tau <= maxLag && nsdf[tau] <= 0) tau++;
      let peakLag = -1;
      let peakVal = 0;
      while (tau <= maxLag && nsdf[tau] > 0) {
        if (nsdf[tau] > peakVal) {
          peakVal = nsdf[tau];
          peakLag = tau;
        }
        tau++;
      }
      const isLocalMax =
        peakLag >= minLag && nsdf[peakLag] >= nsdf[peakLag - 1] && nsdf[peakLag] >= nsdf[peakLag + 1];
      if (isLocalMax) {
        lags.push(peakLag);
        if (peakVal > highest) highest = peakVal;
      }
    }
    if (lags.length === 0) return { freq: null, clarity: 0, rms };

    const limit = this.threshold * highest;
    for (const lag of lags) {
      if (nsdf[lag] >= limit) {
        bestLag = lag;
        break;
      }
    }

    let { pos, val } = parabola(nsdf[bestLag - 1], nsdf[bestLag], nsdf[bestLag + 1]);
    let period = bestLag + pos;
    const clarity = Math.min(1, val);
    if (clarity < this.minClarity) return { freq: null, clarity, rms };

    period = this._refine(period, clarity);

    const freq = this.sampleRate / period;
    if (freq < this.minFreq || freq > this.maxFreq) return { freq: null, clarity, rms };
    return { freq, clarity, rms };
  }

  /** NSDF-Wert für eine einzelne Verschiebung. */
  _nsdfAt(lag) {
    const x = this._x;
    const end = x.length - lag;
    let r = 0;
    let m = 0;
    for (let j = 0; j < end; j++) {
      const a = x[j];
      const b = x[j + lag];
      r += a * b;
      m += a * a + b * b;
    }
    return m > 0 ? (2 * r) / m : 0;
  }

  /**
   * Misst die Periode über 2, 4, 8 … Perioden hinweg. Der Interpolationsfehler
   * verteilt sich dabei auf mehrere Perioden und wird entsprechend kleiner.
   */
  _refine(period, clarity) {
    const maxLag = (this._x.length >> 1) - 2;
    let k = 1;
    for (;;) {
      const k2 = k * 2;
      let c = Math.round(period * k2);
      if (c + 3 > maxLag) break;

      let yl = this._nsdfAt(c - 1);
      let yc = this._nsdfAt(c);
      let yr = this._nsdfAt(c + 1);
      let steps = 0;
      while (steps < 3 && (yl > yc || yr > yc)) {
        if (yl > yr) {
          c -= 1;
          yr = yc;
          yc = yl;
          yl = this._nsdfAt(c - 1);
        } else {
          c += 1;
          yl = yc;
          yc = yr;
          yr = this._nsdfAt(c + 1);
        }
        steps++;
      }
      if (yl > yc || yr > yc) break; // kein eindeutiges Maximum in der Nähe

      const { pos, val } = parabola(yl, yc, yr);
      if (val < clarity * 0.9) break; // Signal über diese Dauer nicht mehr periodisch genug
      period = (c + pos) / k2;
      k = k2;
    }
    return period;
  }
}

/** Scheitel einer Parabel durch drei benachbarte Punkte (Abstand 1). */
function parabola(y0, y1, y2) {
  const denom = y0 - 2 * y1 + y2;
  if (denom === 0) return { pos: 0, val: y1 };
  const pos = (0.5 * (y0 - y2)) / denom;
  return { pos, val: y1 - 0.25 * (y0 - y2) * pos };
}
