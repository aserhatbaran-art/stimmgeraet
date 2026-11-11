/**
 * Tonhöhenerkennung nach der McLeod Pitch Method (MPM), in zwei Stufen:
 *
 *  1. Grobsuche auf dem heruntergetakteten Signal (ca. 12 kHz): normalisierte
 *     Differenzfunktion (NSDF) für alle Verschiebungen, erstes ausreichend
 *     hohes Maximum → ungefähre Periodenlänge. Das ist der teure Teil, durch
 *     das Heruntertakten aber rund 16-mal billiger als bei voller Abtastrate.
 *  2. Feinsuche bei voller Abtastrate, nur in der Nähe des Grobergebnisses:
 *     Oktavprüfung, parabolische Interpolation und Verfeinerung über
 *     Vielfache der Periode (längere Messbasis → höhere Genauigkeit).
 *
 * Für höhere Töne wird nur der jüngste Teil des Signals ausgewertet. Das
 * verkürzt die Reaktionszeit, ohne bei tiefen Saiten Genauigkeit zu verlieren.
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
   * @param {number} [options.minWindow=2048] kleinstes Auswertefenster in Samples
   * @param {number} [options.periods=8]      so viele Perioden soll das Auswertefenster mindestens enthalten
   */
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.minFreq = options.minFreq ?? 60;
    this.maxFreq = options.maxFreq ?? 1400;
    this.threshold = options.threshold ?? 0.93;
    this.minClarity = options.minClarity ?? 0.9;
    this.minRms = options.minRms ?? 0.002;
    this.minWindow = options.minWindow ?? 2048;
    this.periods = options.periods ?? 8;
    this.decimation = Math.max(1, Math.round(sampleRate / 12000));
    this._x = null; // Auswertefenster bei voller Abtastrate
    this._len = 0;
    this._y = null; // heruntergetaktetes Signal
    this._nsdf = null;
  }

  /**
   * @param {Float32Array|number[]} input Zeitsignal, jüngste Samples am Ende (z. B. 4096 Samples)
   * @returns {{freq: number|null, clarity: number, rms: number}}
   */
  detect(input) {
    const n = input.length;

    // Nur den Teil auswerten, in dem schon Ton liegt (kurz nach dem Anschlag ist der Anfang noch still)
    const start = this._onset(input);
    const len = n - start;

    // Pegel der jüngsten ~40 ms
    const recent = Math.max(Math.min(n, 256), Math.min(len, 2048));
    let mean = 0;
    for (let i = n - recent; i < n; i++) mean += input[i];
    mean /= recent;
    let energy = 0;
    for (let i = n - recent; i < n; i++) energy += (input[i] - mean) * (input[i] - mean);
    const rms = Math.sqrt(energy / recent) || 0;
    if (!(rms >= this.minRms) || len < 256) return { freq: null, clarity: 0, rms };

    // Grobsuche zuerst im jüngsten, kurzen Abschnitt: reicht für höhere Töne und reagiert
    // am schnellsten. Tiefe Töne brauchen mehr Perioden → dann den ganzen Abschnitt nehmen.
    const short = Math.min(len, this.minWindow);
    let coarse = this._coarse(input, n - short, short);
    if (len > short && (!coarse || coarse * this.periods > short)) {
      coarse = this._coarse(input, start, len) || coarse;
    }
    if (!coarse) return { freq: null, clarity: 0, rms };

    this._load(input, Math.min(len, Math.max(this.minWindow, Math.ceil(coarse * this.periods))));
    const minLag = Math.max(2, Math.floor(this.sampleRate / this.maxFreq));

    let peak = this._peakNear(Math.round(coarse), this.decimation + 1);
    if (!peak) return { freq: null, clarity: 0, rms };

    // Oktavprüfung: Hat die Grobsuche ein Vielfaches der Periode erwischt?
    for (let changed = true; changed; ) {
      changed = false;
      for (const div of [2, 3]) {
        const lag = Math.round(peak.lag / div);
        if (lag < minLag) continue;
        const shorter = this._peakNear(lag, 2);
        if (shorter && shorter.val >= this.threshold * peak.val) {
          peak = shorter;
          changed = true;
          break;
        }
      }
    }

    const clarity = Math.min(1, peak.val);
    if (clarity < this.minClarity) return { freq: null, clarity, rms };

    const freq = this.sampleRate / this._refine(peak.lag, clarity);
    if (freq < this.minFreq || freq > this.maxFreq) return { freq: null, clarity, rms };
    return { freq, clarity, rms };
  }

  /**
   * Index, ab dem das Signal Ton enthält. 0, wenn der ganze Puffer klingt.
   * Verglichen wird die Energie in Blöcken von 32 Samples mit dem lautesten Block.
   */
  _onset(input) {
    const B = 32;
    const blocks = Math.floor(input.length / B);
    let mean = 0;
    for (let i = 0; i < input.length; i++) mean += input[i];
    mean /= input.length;

    if (!this._blocks || this._blocks.length !== blocks) this._blocks = new Float64Array(blocks);
    const e = this._blocks;
    let max = 0;
    for (let b = 0, k = 0; b < blocks; b++) {
      let s = 0;
      for (let i = 0; i < B; i++, k++) s += (input[k] - mean) * (input[k] - mean);
      e[b] = s;
      if (s > max) max = s;
    }
    const limit = 0.02 * max;
    for (let b = 0; b < blocks; b++) {
      if (e[b] >= limit) return b * B;
    }
    return 0;
  }

  /**
   * Grobsuche im Abschnitt input[start … start+len). Liefert die ungefähre Periode
   * in Samples der vollen Abtastrate oder 0, wenn kein Ton gefunden wurde.
   */
  _coarse(input, start, len) {
    const D = this.decimation;
    const n = Math.floor(len / D);
    if (!this._y || this._y.length < n) this._y = new Float64Array(Math.floor(input.length / D));
    const y = this._y;

    // Heruntertakten durch Mittelwertbildung (wirkt zugleich als Tiefpass)
    let mean = 0;
    for (let i = 0, k = start; i < n; i++) {
      let s = 0;
      for (let d = 0; d < D; d++) s += input[k++];
      y[i] = s / D;
      mean += y[i];
    }
    mean /= n;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      y[i] -= mean;
      energy += y[i] * y[i];
    }
    if (energy === 0) return 0;

    const rate = this.sampleRate / D;
    const maxLag = Math.min(Math.floor(rate / this.minFreq) + 2, (n >> 1) - 1);
    const minLag = Math.max(2, Math.floor(rate / this.maxFreq));
    if (maxLag <= minLag) return 0;
    if (!this._nsdf || this._nsdf.length < maxLag + 2) this._nsdf = new Float64Array(maxLag + 2);
    const nsdf = this._nsdf;

    // NSDF: n'(τ) = 2·r'(τ) / m'(τ)
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let tau = 1; tau <= maxLag + 1; tau++) {
      m -= y[tau - 1] * y[tau - 1] + y[n - tau] * y[n - tau];
      let r = 0;
      const end = n - tau;
      for (let j = 0; j < end; j++) r += y[j] * y[j + tau];
      nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    }

    // Maxima der positiven Abschnitte sammeln (das erste Tal nach τ = 0 wird übersprungen)
    let tau = 1;
    while (tau <= maxLag && nsdf[tau] > 0) tau++;

    const peaks = [];
    let highest = 0;
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
        // Interpolierte Höhe vergleichen: bei kurzen Perioden liegt das Maximum zwischen zwei Samples
        const { pos, val } = parabola(nsdf[peakLag - 1], nsdf[peakLag], nsdf[peakLag + 1]);
        peaks.push({ lag: peakLag + pos, val });
        if (val > highest) highest = val;
      }
    }
    if (highest < 0.8) return 0;

    const limit = this.threshold * highest;
    for (const peak of peaks) {
      if (peak.val >= limit) return peak.lag * D;
    }
    return 0;
  }

  /** Kopiert die jüngsten `len` Samples ohne Gleichanteil in das Auswertefenster. */
  _load(input, len) {
    if (!this._x || this._x.length < input.length) this._x = new Float64Array(input.length);
    const x = this._x;
    const start = input.length - len;
    let mean = 0;
    for (let i = 0; i < len; i++) mean += input[start + i];
    mean /= len;
    for (let i = 0; i < len; i++) x[i] = input[start + i] - mean;
    this._len = len;
  }

  /** NSDF-Wert des Auswertefensters für eine einzelne Verschiebung. */
  _nsdfAt(lag) {
    const x = this._x;
    const end = this._len - lag;
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
   * Sucht das NSDF-Maximum im Bereich center ± radius und interpoliert es.
   * @returns {{lag: number, val: number}|null} null, wenn dort kein Maximum liegt
   */
  _peakNear(center, radius) {
    const maxLag = (this._len >> 1) - 2;
    const lo = Math.max(2, center - radius);
    const hi = Math.min(maxLag, center + radius);
    if (lo > hi) return null;

    let c = lo;
    let yc = -Infinity;
    for (let lag = lo; lag <= hi; lag++) {
      const v = this._nsdfAt(lag);
      if (v > yc) {
        yc = v;
        c = lag;
      }
    }
    // Liegt das Maximum am Rand, ein paar Schritte weiterklettern
    let yl = this._nsdfAt(c - 1);
    let yr = this._nsdfAt(c + 1);
    for (let steps = 0; steps < 4 && (yl > yc || yr > yc); steps++) {
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
    }
    if (yl > yc || yr > yc || c < 2 || c > maxLag) return null;

    const { pos, val } = parabola(yl, yc, yr);
    return { lag: c + pos, val };
  }

  /**
   * Misst die Periode über 2, 4, 8 … Perioden hinweg. Der Interpolationsfehler
   * verteilt sich dabei auf mehrere Perioden und wird entsprechend kleiner.
   */
  _refine(period, clarity) {
    const maxLag = (this._len >> 1) - 2;
    for (let k = 2; Math.round(period * k) + 3 <= maxLag; k *= 2) {
      const peak = this._peakNear(Math.round(period * k), 1);
      // Abbruch, wenn es dort kein Maximum gibt oder das Signal über diese Dauer nicht mehr periodisch genug ist
      if (!peak || peak.val < clarity * 0.9) break;
      period = peak.lag / k;
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
