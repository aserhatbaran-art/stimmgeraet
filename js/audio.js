/**
 * Mikrofonzugriff und Analyse-Schleife.
 * Liefert rund 50-mal pro Sekunde ein Messergebnis. Die Berechnung selbst
 * läuft in einem Hintergrund-Thread (pitch-worker.js).
 */
import { PitchDetector } from './pitch.js';

const INTERVAL_MS = 20;
const HISTORY = 3;
const SAME_NOTE = 1 / 24; // zwei Messungen gelten als gleicher Ton, wenn sie weniger als 50 Cent auseinanderliegen

export class Tuner {
  /** @param {(result: {freq: number|null, clarity: number, rms: number, ms: number}) => void} onResult */
  constructor(onResult) {
    this.onResult = onResult;
    this.ctx = null;
    this.stream = null;
    this.timer = null;
    this.worker = null;
    this.buffer = null;
    this.history = [];
    this.misses = 0;
    /** Zeitpunkt auf der Audio-Uhr, zu dem der Testton einsetzt – nur im Testmodus. */
    this.testOnset = 0;
  }

  /** Testmodus: Millisekunden seit Einsetzen des Testtons, gemessen auf der Audio-Uhr. */
  testElapsedMs() {
    return this.ctx ? (this.ctx.currentTime - this.testOnset) * 1000 : 0;
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
   * @param {number} [options.testFreq]  statt des Mikrofons einen künstlichen Ton einspeisen (Testmodus)
   * @param {number} [options.testDelay] der Testton setzt erst nach so vielen Millisekunden ein
   */
  async start({ testFreq, testDelay = 0 } = {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw named('NotSupportedError');
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.ctx.resume().catch(() => {});

      let source;
      if (testFreq) {
        source = this._testSource(testFreq, testDelay);
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

      const size = analyser.fftSize;
      const sampleRate = this.ctx.sampleRate;
      this.buffer = new Float32Array(size);
      this.history = [];
      this.misses = 0;

      // Ersatz, falls der Hintergrund-Thread nicht verfügbar ist: im Hauptthread rechnen
      let local = null;
      const useLocal = () => {
        this.worker?.terminate();
        this.worker = null;
        local = new PitchDetector(sampleRate);
        this.buffer = new Float32Array(size);
      };
      try {
        this.worker = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' });
        this.worker.onerror = useLocal;
        this.worker.onmessage = ({ data }) => {
          this.buffer = new Float32Array(data.buffer); // Puffer zurückerhalten
          this._handle(data.result);
        };
        this.worker.postMessage({ sampleRate });
      } catch {
        useLocal();
      }

      this.timer = setInterval(() => {
        // Solange der Hintergrund-Thread noch rechnet, ist der Puffer unterwegs → Takt auslassen
        if (this.ctx.state !== 'running' || !this.buffer) return;
        analyser.getFloatTimeDomainData(this.buffer);
        if (this.worker) {
          const { buffer } = this.buffer;
          this.buffer = null;
          this.worker.postMessage({ buffer }, [buffer]);
        } else {
          const started = performance.now();
          const result = local.detect(this.buffer);
          result.ms = performance.now() - started;
          this._handle(result);
        }
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
    this.worker?.terminate();
    this.worker = null;
    this.buffer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  /**
   * Gibt eine Messung erst weiter, wenn zwei aufeinanderfolgende zusammenpassen,
   * und nimmt dann den Median der letzten drei. Das unterdrückt einzelne Ausreißer
   * (z. B. Oktavsprünge im Anschlag) und kostet nur einen Takt von 20 ms.
   */
  _handle(result) {
    if (!this.running) return;
    const { clarity, rms, ms } = result;
    if (result.freq === null) {
      if (++this.misses >= 3) this.history.length = 0;
      this.onResult({ freq: null, clarity, rms, ms });
      return;
    }
    this.misses = 0;
    const h = this.history;
    h.push(result.freq);
    if (h.length > HISTORY) h.shift();

    let freq = null;
    if (h.length >= 3) {
      freq = [...h].sort((a, b) => a - b)[1];
    } else if (h.length === 2 && Math.abs(Math.log2(h[1] / h[0])) < SAME_NOTE) {
      freq = h[1];
    }
    this.onResult({ freq, clarity, rms, ms });
  }

  _testSource(freq, delayMs) {
    const mix = this.ctx.createGain();
    mix.gain.value = 0;
    this.testOnset = this.ctx.currentTime + delayMs / 1000;
    mix.gain.setValueAtTime(0.2, this.testOnset);
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
