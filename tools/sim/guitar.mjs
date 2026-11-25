/**
 * Realistische Nachbildung eines gezupften Saitentons, wie ihn ein Handy-Mikrofon aufnimmt.
 * Dient als Prüfstand für Erkennung und Anzeige (Tests und tools/simulate.mjs).
 *
 * Nachgebildet werden:
 *  - Obertöne je nach Zupfposition, höhere Obertöne klingen schneller ab (Nylon: stark)
 *  - Tonhöhen-Abfall nach dem Anschlag (Saite klingt zuerst etwas zu hoch)
 *  - leichte Inharmonizität, Anschlaggeräusch
 *  - Handy-Mikrofon: Hochpass, der tiefe Grundtöne stark dämpft
 *  - Schwebung durch zwei Schwingungsebenen der Saite
 *  - mitschwingende Leersaiten (leise)
 *  - Grundrauschen des Mikrofons und tieffrequentes Raumrauschen
 */

/** Reproduzierbarer Zufallsgenerator. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Butterworth-Hochpass 2. Ordnung (Biquad), auf das Signal angewendet. */
export function highpass(x, sampleRate, fc) {
  const w = (2 * Math.PI * fc) / sampleRate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
}

/**
 * @param {object} o
 * @param {number} o.freq          Grundfrequenz nach dem Einschwingen (Hz)
 * @param {number} [o.sampleRate=48000]
 * @param {number} [o.seconds=4]   Gesamtdauer
 * @param {number} [o.pluckAt=0.5] Zeitpunkt des Anschlags (s); davor nur Rauschen
 * @param {number} [o.level=-50]   Pegel der ersten 100 ms des Tons (dBFS, RMS)
 * @param {number} [o.noise=-75]   Grundrauschen (dBFS, RMS)
 * @param {'nylon'|'steel'} [o.string='nylon']
 * @param {number} [o.micCutoff=150] Hochpass des Mikrofons (Hz)
 * @param {number} [o.micOrder=4]  Ordnung des Hochpasses (2 oder 4)
 * @param {number} [o.glide=8]     Tonhöhe direkt nach dem Anschlag, in Cent über dem Endwert
 * @param {{from: number, to: number, cents: number}} [o.bend] Wirbel drehen: Tonhöhe ändert sich
 *                                 zwischen from und to (s nach Anschlag) gleichmäßig um cents
 * @param {number[]} [o.sympathetic=[]] Frequenzen mitschwingender Leersaiten (je −30 dB)
 * @param {number} [o.room=-68]   tieffrequentes Raumrauschen (dBFS, RMS)
 * @param {number} [o.seed=1]
 * @returns {Float32Array}
 */
export function pluck(o) {
  const sr = o.sampleRate ?? 48000;
  const seconds = o.seconds ?? 4;
  const pluckAt = o.pluckAt ?? 0.5;
  const level = o.level ?? -50;
  const noise = o.noise ?? -75;
  const nylon = (o.string ?? 'nylon') === 'nylon';
  const glide = o.glide ?? 8;
  const rand = rng(o.seed ?? 1);

  const n = Math.round(seconds * sr);
  const start = Math.round(pluckAt * sr);
  const tone = new Float64Array(n);

  // Obertöne: Zupfen bei ~1/6 der Saitenlänge; Nylon dämpft hohe Obertöne stärker
  const p = 0.17;
  const tau1 = nylon ? 1.8 : 3.5; // Abklingzeit des Grundtons (s)
  const B = nylon ? 2e-5 : 1e-4; // Inharmonizität
  const harmonics = [];
  const addString = (freq, gain, rise, glideCents) => {
    for (let h = 1; h <= 24; h++) {
      const f = h * freq * Math.sqrt(1 + B * h * h);
      if (f > sr * 0.45) break;
      const amp = (gain * Math.abs(Math.sin(Math.PI * h * p))) / h ** (nylon ? 1.4 : 1.0);
      const tau = tau1 / (1 + (nylon ? 0.9 : 0.35) * (h - 1));
      // zweite Schwingungsebene: 0,6 Cent höher, schwächer, langsamer abklingend → Schwebung
      harmonics.push({ f, amp, tau, rise, glideCents, phase: rand() * 2 * Math.PI });
      harmonics.push({ f: f * 2 ** (0.6 / 1200), amp: amp * 0.35, tau: tau * 1.3, rise, glideCents, phase: rand() * 2 * Math.PI });
    }
  };
  addString(o.freq, 1, 0.004, glide);
  const main = harmonics.length;
  for (const f of o.sympathetic ?? []) addString(f, 10 ** (-30 / 20), 0.08, 0);

  // Tonhöhenverlauf (Anschlag-Abfall + Wirbel) einmal je Sample als Faktor berechnen
  const pitchFactor = new Float64Array(n);
  for (let i = start; i < n; i++) {
    const t = (i - start) / sr;
    pitchFactor[i] = 2 ** ((glide * Math.exp(-t / 0.25) + bendAt(o, t)) / 1200);
  }

  for (let k = 0; k < harmonics.length; k++) {
    const { f, amp, tau, rise, glideCents, phase } = harmonics[k];
    const follows = k < main && glideCents !== 0; // nur die gezupfte Saite ändert ihre Tonhöhe
    const step = (2 * Math.PI * f) / sr;
    const decayStep = Math.exp(-1 / (tau * sr)); // Abklingen als Faktor je Sample
    const riseSamples = rise * sr;
    let ph = phase;
    let env = amp;
    for (let i = start, j = 0; i < n; i++, j++) {
      ph += follows ? step * pitchFactor[i] : step;
      tone[i] += env * (j < riseSamples ? j / riseSamples : 1) * Math.sin(ph);
      env *= decayStep;
    }
  }
  // Anschlaggeräusch: kurzer Rauschimpuls
  for (let i = start; i < Math.min(n, start + Math.round(0.006 * sr)); i++) {
    tone[i] += 0.3 * (rand() * 2 - 1) * (1 - (i - start) / (0.006 * sr));
  }

  // Handy-Mikrofon
  const stages = (o.micOrder ?? 4) / 2;
  for (let s = 0; s < stages; s++) highpass(tone, sr, o.micCutoff ?? 150);

  // Auf Zielpegel bringen (RMS der ersten 100 ms nach dem Anschlag)
  let e = 0;
  const win = Math.round(0.1 * sr);
  for (let i = start; i < start + win; i++) e += tone[i] * tone[i];
  const gain = 10 ** (level / 20) / Math.sqrt(e / win);

  // Raumrauschen: tiefpassgefiltert (Brummen, Lüftung, Verkehr), dann durch das Mikrofon
  const room = new Float64Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.02 * ((rand() * 2 - 1) - lp);
    room[i] = lp;
  }
  for (let s = 0; s < stages; s++) highpass(room, sr, o.micCutoff ?? 150);
  let er = 0;
  for (let i = 0; i < n; i++) er += room[i] * room[i];
  const roomGain = 10 ** ((o.room ?? -68) / 20) / Math.sqrt(er / n || 1);

  const out = new Float32Array(n);
  const noiseAmp = 10 ** (noise / 20) * Math.sqrt(3); // Gleichverteilung: RMS = Amplitude / √3
  for (let i = 0; i < n; i++) out[i] = tone[i] * gain + room[i] * roomGain + noiseAmp * (rand() * 2 - 1);
  return out;
}

/** Tonhöhenänderung durch Drehen am Wirbel (Cent) zum Zeitpunkt t nach dem Anschlag. */
function bendAt(o, t) {
  if (!o.bend) return 0;
  const { from, to, cents } = o.bend;
  return cents * Math.min(1, Math.max(0, (t - from) / (to - from)));
}

/** Tatsächliche Tonhöhe (Hz) zum Zeitpunkt t nach dem Anschlag – für die Auswertung. */
export function truePitch(o, t) {
  const glide = o.glide ?? 8;
  return o.freq * 2 ** ((glide * Math.exp(-t / 0.25) + bendAt(o, t)) / 1200);
}
