/**
 * Mikrofonzugriff und Analyse-Schleife.
 * Alle 20 ms werden die jüngsten ~170 ms Ton ausgewertet. Erkennung (pitch.js) und
 * Tracker (tracker.js) laufen in einem Hintergrund-Thread (pitch-worker.js).
 */
import { PitchDetector } from './pitch.js';
import { Tracker } from './tracker.js';

const INTERVAL_MS = 20;
const WINDOW_SECONDS = 0.17; // Länge des Messfensters

export class Tuner {
  /**
   * @param {(result: {freq: number|null, stale: boolean, weak: boolean, levelDb: number, floorDb: number, ms: number}) => void} onResult
   */
  constructor(onResult) {
    this.onResult = onResult;
    this.ctx = null;
    this.stream = null;
    this.timer = null;
    this.worker = null;
    this.buffer = null;
    this.local = null; // Erkennung im Hauptthread, falls kein Hintergrund-Thread verfügbar ist
    this.range = null; // Tonumfang des Instruments in Hz, null = alle Töne
    /** Zeitpunkt auf der Audio-Uhr, zu dem der Testton einsetzt – nur im Testmodus. */
    this.testOnset = 0;
  }

  get running() {
    return this.timer !== null;
  }

  /** true, wenn der Audio-Kontext tatsächlich läuft (nicht vom Browser angehalten). */
  get live() {
    return this.running && this.ctx?.state === 'running';
  }

  /** Testmodus: Millisekunden seit Einsetzen des Testtons, gemessen auf der Audio-Uhr. */
  testElapsedMs() {
    return this.ctx ? (this.ctx.currentTime - this.testOnset) * 1000 : 0;
  }

  /**
   * Tonumfang des Instruments setzen: Töne außerhalb (z. B. Pfeifen, Piepen) werden nicht angezeigt.
   * @param {[number, number]|null} range [tiefste, höchste] Frequenz in Hz; null = alle Töne
   */
  setRange(range) {
    this.range = range;
    this.worker?.postMessage({ range });
    this.local?.tracker.setRange(range);
  }

  /**
   * @param {object} [options]
   * @param {number} [options.testFreq]  statt des Mikrofons einen künstlichen Ton einspeisen (Testmodus)
   * @param {number} [options.testDelay] der Testton setzt erst nach so vielen Millisekunden ein
   * @param {number} [options.testLevel] Pegel des Testtons in dBFS (Standard −20)
   */
  async start({ testFreq, testDelay = 0, testLevel = -20 } = {}) {
    if (this.running || this.starting) return;
    this.starting = true;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw named('NotSupportedError');
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.ctx.resume().catch(() => {});

      let source;
      if (testFreq) {
        source = this._testSource(testFreq, testDelay, testLevel);
      } else {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw named(window.isSecureContext ? 'NotSupportedError' : 'InsecureContextError');
        }
        // Die Sprachfilter des Handys würden Saitentöne verfälschen oder als „Rauschen“ unterdrücken
        // → alle abschalten. Die App gleicht leise Signale selbst aus (Rauschpegel-Schätzung im Tracker).
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
          video: false,
        });
        source = this.ctx.createMediaStreamSource(this.stream);
      }

      const analyser = this.ctx.createAnalyser();
      const sampleRate = this.ctx.sampleRate;
      // Nächste Zweierpotenz ≥ 170 ms (48 kHz → 8192); Analyser erlaubt 32 … 32768
      analyser.fftSize = Math.min(32768, 2 ** Math.ceil(Math.log2(sampleRate * WINDOW_SECONDS)));
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);

      const size = analyser.fftSize;
      this.buffer = new Float32Array(size);

      // Ersatz, falls der Hintergrund-Thread nicht verfügbar ist: im Hauptthread rechnen
      const useLocal = () => {
        this.worker?.terminate();
        this.worker = null;
        this.local = { detector: new PitchDetector(sampleRate), tracker: new Tracker({ range: this.range }) };
        this.buffer = new Float32Array(size);
      };
      try {
        this.worker = new Worker(new URL('./pitch-worker.js', import.meta.url), { type: 'module' });
        this.worker.onerror = useLocal;
        this.worker.onmessage = ({ data }) => {
          this.buffer = new Float32Array(data.buffer); // Puffer zurückerhalten
          if (this.running) this.onResult(data.result);
        };
        this.worker.postMessage({ sampleRate, range: this.range });
      } catch {
        useLocal();
      }

      this.timer = setInterval(() => {
        // Solange der Hintergrund-Thread noch rechnet, ist der Puffer unterwegs → Takt auslassen
        if (this.ctx.state !== 'running' || !this.buffer) return;
        analyser.getFloatTimeDomainData(this.buffer);
        const time = performance.now();
        if (this.worker) {
          const { buffer } = this.buffer;
          this.buffer = null;
          this.worker.postMessage({ buffer, time }, [buffer]);
        } else {
          const started = performance.now();
          const result = this.local.tracker.update(this.local.detector.detect(this.buffer), time);
          result.ms = performance.now() - started;
          this.onResult(result);
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
    this.local = null;
    this.buffer = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  /** Testton: Grundton mit zwei Obertönen, setzt nach delayMs ein. */
  _testSource(freq, delayMs, levelDb) {
    const mix = this.ctx.createGain();
    this.testOnset = this.ctx.currentTime + delayMs / 1000;
    mix.gain.value = 0;
    // Summe der Teiltöne hat etwa den RMS-Wert 0,8; daraus der Verstärkungsfaktor für den Zielpegel
    mix.gain.setValueAtTime(10 ** (levelDb / 20) / 0.8, this.testOnset);
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
