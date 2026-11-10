/**
 * Mikrofonzugriff und Analyse-Schleife.
 * Liefert rund 25-mal pro Sekunde ein geglättetes Messergebnis.
 */
import { PitchDetector } from './pitch.js';

const INTERVAL_MS = 40;
const HISTORY = 5;

export class Tuner {
  /** @param {(result: {freq: number|null, clarity: number, rms: number}) => void} onResult */
  constructor(onResult) {
    this.onResult = onResult;
    this.ctx = null;
    this.stream = null;
    this.timer = null;
    this.history = [];
    this.misses = 0;
  }

  get running() {
    return this.timer !== null;
  }

  /** true, wenn der Audio-Kontext tatsächlich läuft (nicht vom Browser angehalten). */
  get live() {
    return this.running && this.ctx?.state === 'running';
  }

  /**
   * @param {object} [options]
   * @param {number} [options.testFreq] statt des Mikrofons einen künstlichen Ton einspeisen (Testmodus)
   */
  async start({ testFreq } = {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw named('NotSupportedError');
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.ctx.resume().catch(() => {});

      let source;
      if (testFreq) {
        source = this._testSource(testFreq);
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw named(window.isSecureContext ? 'NotSupportedError' : 'InsecureContextError');
        }
        // Die Sprachfilter des Handys würden die Tonhöhe verfälschen → alle abschalten.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
          video: false,
        });
        source = this.ctx.createMediaStreamSource(this.stream);
      }

      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = this.ctx.sampleRate > 50000 ? 8192 : 4096;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);

      const buffer = new Float32Array(analyser.fftSize);
      const detector = new PitchDetector(this.ctx.sampleRate);
      this.history = [];
      this.misses = 0;

      this.timer = setInterval(() => {
        if (this.ctx.state !== 'running') return;
        analyser.getFloatTimeDomainData(buffer);
        this._handle(detector.detect(buffer));
      }, INTERVAL_MS);
    } catch (err) {
      this._release();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this._release();
  }

  /** Nach einer Nutzer-Geste aufrufen, falls der Browser den Audio-Kontext angehalten hat. */
  resume() {
    this.ctx?.resume().catch(() => {});
  }

  _release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  /** Median über die letzten Messungen: unterdrückt einzelne Ausreißer und Oktavsprünge. */
  _handle(result) {
    if (result.freq === null) {
      if (++this.misses >= 3) this.history.length = 0;
      this.onResult({ freq: null, clarity: result.clarity, rms: result.rms });
      return;
    }
    this.misses = 0;
    this.history.push(result.freq);
    if (this.history.length > HISTORY) this.history.shift();
    if (this.history.length < 2) {
      this.onResult({ freq: null, clarity: result.clarity, rms: result.rms });
      return;
    }
    const sorted = [...this.history].sort((a, b) => a - b);
    this.onResult({ freq: sorted[sorted.length >> 1], clarity: result.clarity, rms: result.rms });
  }

  _testSource(freq) {
    const mix = this.ctx.createGain();
    mix.gain.value = 0.2;
    [1, 0.5, 0.3].forEach((amp, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.frequency.value = freq * (i + 1);
      gain.gain.value = amp;
      osc.connect(gain).connect(mix);
      osc.start();
    });
    return mix;
  }
}

function named(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}
