/**
 * Referenzton. Enthält Obertöne, damit auch tiefe Saiten über den kleinen
 * Handy-Lautsprecher hörbar sind (dieser gibt den Grundton von E2 kaum wieder).
 */
const HARMONICS = [0, 1, 0.5, 0.33, 0.2, 0.12, 0.08];

export class TonePlayer {
  constructor() {
    this.ctx = null;
    this.wave = null;
    this.voice = null;
    this.timer = null;
    /** Wird aufgerufen, sobald der Ton endet (auch nach Zeitablauf). */
    this.onstop = null;
  }

  get playing() {
    return this.voice !== null;
  }

  play(freq, seconds = 8) {
    this._silence();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!this.ctx) {
      this.ctx = new Ctx();
      this.wave = this.ctx.createPeriodicWave(new Float32Array(HARMONICS.length), new Float32Array(HARMONICS));
    }
    this.ctx.resume().catch(() => {});

    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.setPeriodicWave(this.wave);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.03);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start();

    this.voice = { osc, gain };
    this.timer = setTimeout(() => this.stop(), seconds * 1000);
  }

  stop() {
    if (!this.voice) return;
    this._silence();
    this.onstop?.();
  }

  _silence() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.voice) return;
    const { osc, gain } = this.voice;
    const now = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + 0.06);
    osc.stop(now + 0.08);
    this.voice = null;
  }
}
