import { Tuner } from './audio.js';
import { TonePlayer } from './tone.js';
import { TUNINGS, midiToFreq, freqToMidi, centsBetween, noteName, noteOctave, nearestString } from './tunings.js';

const STORAGE_KEY = 'stimmgeraet.settings.v1';
const IN_TUNE_CENTS = 3; // innerhalb ± 3 Cent gilt die Saite als gestimmt
const IN_TUNE_HOLD_MS = 300; // so lange muss sie im grünen Bereich bleiben
const HOLD_MS = 1000; // so lange bleibt die letzte Messung nach dem Ausklingen stehen
const TEXT_INTERVAL_MS = 100; // Zahlen höchstens 10-mal pro Sekunde erneuern, damit sie lesbar bleiben
const A4_MIN = 430;
const A4_MAX = 450;

// Skala: Der Bereich bis ± 10 Cent ist gespreizt und belegt die halbe Skala (3° je Cent),
// der Rest bis ± 50 Cent die andere Hälfte. Ohne Ton liegt der Zeiger links außerhalb.
const KNEE_CENTS = 10;
const KNEE_DEG = 30;
const MAX_DEG = 60;
const PARK_DEG = -73;
const NEEDLE_TAU_MS = 35; // Trägheit des Zeigers

const $ = (id) => document.getElementById(id);
const el = {
  tabs: $('instrument-tabs'),
  tuningRow: $('tuning-row'),
  tuningSelect: $('tuning-select'),
  meter: $('meter'),
  needle: $('needle'),
  ticks: $('gauge-ticks'),
  zone: $('gauge-zone'),
  level: $('level-bar'),
  readout: $('readout'),
  noteName: $('note-name'),
  noteOctave: $('note-octave'),
  cents: $('cents'),
  hint: $('hint'),
  freq: $('freq'),
  strings: $('strings'),
  startbox: $('startbox'),
  start: $('btn-start'),
  error: $('error'),
  auto: $('btn-auto'),
  ref: $('btn-ref'),
  refLabel: $('btn-ref-label'),
  settings: $('settings'),
  settingsBtn: $('btn-settings'),
  a4Value: $('a4-value'),
  a4Minus: $('a4-minus'),
  a4Plus: $('a4-plus'),
  optGerman: $('opt-german'),
  optVibrate: $('opt-vibrate'),
};

// ---------- Einstellungen ----------

const DEFAULTS = {
  instrument: 'guitar',
  tuning: { guitar: 'standard', ukulele: 'standard' },
  a4: 440,
  german: true,
  vibrate: true,
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    // Speicher nicht verfügbar oder beschädigt → Standardwerte
  }
  const s = { ...DEFAULTS, ...saved, tuning: { ...DEFAULTS.tuning, ...saved.tuning } };
  if (!['guitar', 'ukulele', 'chromatic'].includes(s.instrument)) s.instrument = DEFAULTS.instrument;
  s.a4 = Math.min(A4_MAX, Math.max(A4_MIN, Math.round(Number(s.a4)) || 440));
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // z. B. privater Modus – die App funktioniert auch ohne Speichern
  }
}

const settings = loadSettings();

// ---------- Laufzeit-Zustand ----------

let locked = null; // Index der fest gewählten Saite, null = automatische Erkennung
let refMode = false; // Saiten-Tasten spielen den Referenzton
let playing = null; // Index der Saite, deren Referenzton läuft ('a4' im chromatischen Modus)
const tuned = new Set(); // in dieser Sitzung bereits gestimmte Saiten

let shownTarget = null; // MIDI-Nummer des angezeigten Zieltons, null = Ruhezustand
let smoothCents = 0; // leicht geglättete Abweichung für Zahl und Farbe
let lastSignal = 0;
let lastText = 0;
let okSince = 0;
let confirmed = false;

const isChromatic = () => settings.instrument === 'chromatic';

function currentTuning() {
  const list = TUNINGS[settings.instrument];
  return list.find((t) => t.id === settings.tuning[settings.instrument]) ?? list[0];
}

const nameOpts = () => ({ german: settings.german, flats: !isChromatic() && !!currentTuning().flats });

// ---------- Formatierung ----------

const fmt = (value, digits) => value.toFixed(digits).replace('.', ',').replace('-', '−');
const fmtHz = (freq) => `${fmt(freq, freq < 1000 ? 2 : 1)} Hz`;
const fmtCents = (c) => {
  const abs = Math.abs(c);
  const text = abs >= 20 ? String(Math.round(abs)) : fmt(abs, 1);
  const sign = abs < 0.05 ? '±' : c > 0 ? '+' : '−';
  return `${sign}${text} Cent`;
};

/** Text nur schreiben, wenn er sich geändert hat (spart Arbeit bei 50 Messungen pro Sekunde). */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// ---------- Skala und Zeiger ----------

/** Zeigerwinkel zu einer Abweichung in Cent (0° = senkrecht nach oben). */
function centsToDeg(cents) {
  const abs = Math.min(50, Math.abs(cents));
  const deg =
    abs <= KNEE_CENTS
      ? (abs / KNEE_CENTS) * KNEE_DEG
      : KNEE_DEG + ((abs - KNEE_CENTS) / (50 - KNEE_CENTS)) * (MAX_DEG - KNEE_DEG);
  return Math.sign(cents) * deg;
}

function polar(deg, radius) {
  const a = (deg * Math.PI) / 180;
  return [160 + radius * Math.sin(a), 165 - radius * Math.cos(a)];
}

function buildGauge() {
  const ns = 'http://www.w3.org/2000/svg';
  const marks = [];
  for (let c = -KNEE_CENTS; c <= KNEE_CENTS; c++) marks.push(c);
  for (let c = 20; c <= 50; c += 10) marks.push(c, -c);

  for (const c of marks) {
    const abs = Math.abs(c);
    const kind = c === 0 ? 'zero' : abs === 10 || abs === 50 ? 'major' : abs === 5 || abs > 10 ? 'medium' : 'minor';
    const inner = { zero: 116, major: 124, medium: 129, minor: 134 }[kind];
    const [x1, y1] = polar(centsToDeg(c), 140);
    const [x2, y2] = polar(centsToDeg(c), inner);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1.toFixed(1));
    line.setAttribute('y1', y1.toFixed(1));
    line.setAttribute('x2', x2.toFixed(1));
    line.setAttribute('y2', y2.toFixed(1));
    line.setAttribute('class', `tick ${kind}`);
    el.ticks.append(line);
  }
  for (const c of [-50, -10, 0, 10, 50]) {
    const [x, y] = polar(centsToDeg(c), 154);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', x.toFixed(1));
    text.setAttribute('y', (y + 4).toFixed(1));
    text.setAttribute('class', 'tick-label');
    text.textContent = c === 0 ? '0' : c > 0 ? `+${c}` : `−${-c}`;
    el.ticks.append(text);
  }
  const [zx1, zy1] = polar(centsToDeg(-IN_TUNE_CENTS), 140);
  const [zx2, zy2] = polar(centsToDeg(IN_TUNE_CENTS), 140);
  el.zone.setAttribute('d', `M${zx1.toFixed(1)} ${zy1.toFixed(1)} A140 140 0 0 1 ${zx2.toFixed(1)} ${zy2.toFixed(1)}`);
}

// Der Zeiger folgt seinem Ziel mit etwas Trägheit, wie eine echte Nadel.
let needleDeg = PARK_DEG;
let needleTarget = PARK_DEG;
let needleFrame = 0;
let needleTime = 0;

function setNeedle(deg) {
  needleTarget = deg;
  if (!needleFrame && needleDeg !== needleTarget) {
    needleTime = performance.now();
    needleFrame = requestAnimationFrame(stepNeedle);
  }
}

function stepNeedle(now) {
  const dt = Math.min(64, Math.max(0, now - needleTime));
  needleTime = now;
  needleDeg += (needleTarget - needleDeg) * (1 - Math.exp(-dt / NEEDLE_TAU_MS));
  if (Math.abs(needleTarget - needleDeg) < 0.05) needleDeg = needleTarget;
  el.needle.style.transform = `rotate(${needleDeg.toFixed(2)}deg)`;
  needleFrame = needleDeg === needleTarget ? 0 : requestAnimationFrame(stepNeedle);
}

// ---------- Anzeige aufbauen ----------

function renderTabs() {
  for (const tab of el.tabs.children) {
    tab.setAttribute('aria-selected', String(tab.dataset.instrument === settings.instrument));
  }
}

function renderTuningSelect() {
  el.tuningRow.hidden = isChromatic();
  if (isChromatic()) return;
  el.tuningSelect.replaceChildren(
    ...TUNINGS[settings.instrument].map((t) => {
      const option = document.createElement('option');
      option.value = t.id;
      option.textContent = settings.german ? t.name : t.name.replaceAll('H', 'B');
      return option;
    }),
  );
  el.tuningSelect.value = currentTuning().id;
}

function renderStrings() {
  el.strings.hidden = isChromatic();
  el.auto.hidden = isChromatic();
  el.refLabel.textContent = isChromatic() ? 'Kammerton A4' : 'Referenzton';
  if (isChromatic()) return;
  const { strings } = currentTuning();
  el.strings.style.setProperty('--count', strings.length);
  el.strings.replaceChildren(
    ...strings.map((midi, i) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'string';
      button.dataset.index = i;
      const name = noteName(midi, nameOpts());
      button.setAttribute('aria-label', `Saite ${strings.length - i}: ${name}${noteOctave(midi)}`);
      button.innerHTML = `<span class="string-name">${name}<sub>${noteOctave(midi)}</sub></span><span class="string-num">${strings.length - i}</span>`;
      return button;
    }),
  );
  updateStringStates(null);
}

function updateStringStates(active) {
  for (const button of el.strings.children) {
    const i = Number(button.dataset.index);
    button.classList.toggle('active', i === active);
    button.classList.toggle('locked', i === locked && !refMode);
    button.classList.toggle('tuned', tuned.has(i));
    button.classList.toggle('playing', i === playing);
  }
  el.auto.setAttribute('aria-pressed', String(locked === null));
  el.ref.setAttribute('aria-pressed', String(isChromatic() ? playing === 'a4' : refMode));
}

function setNote(midi) {
  setText(el.noteName, midi === null ? '–' : noteName(midi, nameOpts()));
  setText(el.noteOctave, midi === null ? '' : String(noteOctave(midi)));
}

/** Ruhezustand: kein Ton zu hören. Der Zeiger fährt in die Ruheposition links. */
function showIdle() {
  shownTarget = null;
  okSince = 0;
  confirmed = false;
  el.meter.dataset.state = 'idle';
  el.meter.classList.remove('hold');
  setNeedle(PARK_DEG);
  el.cents.innerHTML = '&nbsp;';

  // Solange das Mikrofon aus ist, steht an Stelle der Messwerte die Einschalt-Taste
  const showStart = !tuner.running && playing === null;
  el.startbox.hidden = !showStart;
  el.readout.hidden = showStart;

  if (playing !== null) {
    const midi = playing === 'a4' ? 69 : currentTuning().strings[playing];
    setNote(midi);
    setText(el.hint, 'Referenzton läuft');
    setText(el.freq, fmtHz(midiToFreq(midi, settings.a4)));
  } else if (!isChromatic() && refMode) {
    setNote(null);
    setText(el.hint, 'Saite antippen, um den Ton zu hören');
    el.freq.innerHTML = '&nbsp;';
  } else if (!isChromatic() && locked !== null) {
    const midi = currentTuning().strings[locked];
    setNote(midi);
    setText(el.hint, 'Saite anzupfen');
    setText(el.freq, `Ziel ${fmtHz(midiToFreq(midi, settings.a4))}`);
  } else {
    setNote(null);
    setText(el.hint, isChromatic() ? 'Ton spielen' : 'Saite anzupfen');
    el.freq.innerHTML = '&nbsp;';
  }
  updateStringStates(playing === null && !refMode ? locked : null);
}

// ---------- Messergebnisse ----------

function onResult({ freq, rms, ms }) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  el.level.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 50)).toFixed(3)})`;
  if (testFreq) recordTestStats(freq, ms);

  if (playing !== null || (refMode && !isChromatic())) return;

  const now = performance.now();
  if (freq === null) {
    if (shownTarget === null) return;
    const silent = now - lastSignal;
    if (silent > HOLD_MS) showIdle();
    else if (silent > 200) el.meter.classList.add('hold');
    return;
  }
  lastSignal = now;
  el.meter.classList.remove('hold');

  let targetMidi;
  let stringIndex = null;
  if (isChromatic()) {
    targetMidi = Math.round(freqToMidi(freq, settings.a4));
  } else {
    const { strings } = currentTuning();
    stringIndex = locked ?? nearestString(freq, strings, settings.a4);
    targetMidi = strings[stringIndex];
  }
  const targetFreq = midiToFreq(targetMidi, settings.a4);
  const cents = centsBetween(freq, targetFreq);

  const changed = shownTarget !== targetMidi;
  if (changed) {
    shownTarget = targetMidi;
    smoothCents = cents;
    okSince = 0;
    confirmed = false;
  } else {
    smoothCents += (cents - smoothCents) * 0.5;
  }

  // Der Zeiger bekommt den ungeglätteten Wert; seine Trägheit glättet genug.
  setNeedle(centsToDeg(cents));

  const inTune = Math.abs(smoothCents) <= IN_TUNE_CENTS;
  el.meter.dataset.state = inTune ? 'ok' : smoothCents < 0 ? 'low' : 'high';
  setNote(targetMidi);
  setText(el.hint, inTune ? 'Gestimmt ✓' : smoothCents < 0 ? 'Zu tief – höher stimmen ↑' : 'Zu hoch – tiefer stimmen ↓');

  if (changed || now - lastText >= TEXT_INTERVAL_MS) {
    lastText = now;
    setText(el.cents, fmtCents(smoothCents));
    // Weit daneben: zusätzlich anzeigen, welcher Ton tatsächlich klingt
    const heard = Math.round(freqToMidi(freq, settings.a4));
    const heardText = Math.abs(cents) > 50 ? ` (${noteName(heard, nameOpts())}${noteOctave(heard)})` : '';
    setText(el.freq, `${fmtHz(freq)}${heardText} · Ziel ${fmtHz(targetFreq)}`);
  }

  if (inTune) {
    if (!okSince) okSince = now;
    if (!confirmed && now - okSince >= IN_TUNE_HOLD_MS) {
      confirmed = true;
      if (stringIndex !== null) tuned.add(stringIndex);
      if (settings.vibrate && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(40);
    }
  } else {
    okSince = 0;
    if (Math.abs(smoothCents) > IN_TUNE_CENTS * 2) confirmed = false;
  }
  updateStringStates(stringIndex);
}

// ---------- Mikrofon ----------

const tuner = new Tuner(onResult);
const tone = new TonePlayer();
const params = new URLSearchParams(location.search);
const testFreq = Number(params.get('test')) || 0; // Testmodus: künstlicher Ton statt Mikrofon
const testDelay = Number(params.get('delay')) || 0;
let wakeLock = null;

/** Testmodus: Reaktionszeit und Rechenzeit festhalten (auslesbar über das data-Attribut). */
const testStats = { firstResultMs: null, maxDetectMs: 0, results: 0 };
function recordTestStats(freq, ms) {
  testStats.results++;
  testStats.maxDetectMs = Math.max(testStats.maxDetectMs, ms || 0);
  if (freq !== null && testStats.firstResultMs === null) {
    testStats.firstResultMs = Math.round(tuner.testElapsedMs());
  }
  document.documentElement.dataset.test = JSON.stringify(testStats);
}

const ERRORS = {
  NotAllowedError:
    'Der Mikrofonzugriff wurde abgelehnt. Tippe auf das Schloss-Symbol neben der Adresse, erlaube das Mikrofon und versuche es erneut.',
  SecurityError: 'Der Mikrofonzugriff wurde vom Browser blockiert.',
  NotFoundError: 'Es wurde kein Mikrofon gefunden.',
  NotReadableError: 'Das Mikrofon wird gerade von einer anderen App verwendet.',
  InsecureContextError: 'Das Mikrofon funktioniert nur über eine sichere Verbindung (https).',
  NotSupportedError: 'Dieser Browser unterstützt die Tonaufnahme nicht. Bitte Chrome verwenden.',
};

async function startTuner() {
  el.error.hidden = true;
  try {
    await tuner.start({ testFreq, testDelay });
    requestWakeLock();
  } catch (err) {
    el.error.textContent = ERRORS[err.name] ?? `Das Mikrofon konnte nicht gestartet werden (${err.name}).`;
    el.error.hidden = false;
  }
  showIdle();
}

function stopTuner() {
  tuner.stop();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  el.level.style.transform = 'scaleX(0)';
  showIdle();
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // nicht unterstützt oder Energiesparmodus – kein Problem
  }
}

/** Startet ohne Antippen, wenn das Mikrofon früher schon erlaubt wurde. */
async function autoStart() {
  let granted = Boolean(testFreq);
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    granted ||= status.state === 'granted';
  } catch {
    // Abfrage nicht unterstützt → Start per Taste
  }
  if (!granted) return;
  await startTuner();
  // Manche Browser halten den Ton an, bis der Bildschirm berührt wurde.
  setTimeout(() => {
    if (tuner.running && !tuner.live) stopTuner();
  }, 800);
}

// ---------- Referenzton ----------

function playTone(which) {
  if (playing === which) {
    tone.stop();
    return;
  }
  const midi = which === 'a4' ? 69 : currentTuning().strings[which];
  playing = which;
  tone.play(midiToFreq(midi, settings.a4));
  showIdle();
}

tone.onstop = () => {
  playing = null;
  showIdle();
};

function resetSelection() {
  if (tone.playing) tone.stop();
  playing = null;
  locked = null;
  refMode = false;
  tuned.clear();
}

// ---------- Bedienung ----------

el.start.addEventListener('click', startTuner);
document.addEventListener('pointerdown', () => tuner.resume(), { passive: true });

el.tabs.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-instrument]');
  if (!tab || tab.dataset.instrument === settings.instrument) return;
  resetSelection();
  settings.instrument = tab.dataset.instrument;
  saveSettings();
  renderAll();
});

el.tuningSelect.addEventListener('change', () => {
  resetSelection();
  settings.tuning[settings.instrument] = el.tuningSelect.value;
  saveSettings();
  renderAll();
});

el.strings.addEventListener('click', (event) => {
  const button = event.target.closest('.string');
  if (!button) return;
  const i = Number(button.dataset.index);
  if (refMode) {
    playTone(i);
  } else {
    locked = locked === i ? null : i;
    showIdle();
  }
});

el.auto.addEventListener('click', () => {
  locked = null;
  if (refMode) {
    refMode = false;
    if (tone.playing) tone.stop();
  }
  showIdle();
});

el.ref.addEventListener('click', () => {
  if (isChromatic()) {
    playTone('a4');
    return;
  }
  refMode = !refMode;
  if (!refMode && tone.playing) tone.stop();
  else showIdle();
});

el.settingsBtn.addEventListener('click', () => {
  renderSettings();
  el.settings.showModal();
});
el.settings.addEventListener('click', (event) => {
  if (event.target === el.settings) el.settings.close(); // Tippen neben das Fenster schließt es
});

function changeA4(delta) {
  settings.a4 = Math.min(A4_MAX, Math.max(A4_MIN, settings.a4 + delta));
  saveSettings();
  if (tone.playing) tone.stop();
  renderSettings();
  showIdle();
}
el.a4Minus.addEventListener('click', () => changeA4(-1));
el.a4Plus.addEventListener('click', () => changeA4(1));

el.optGerman.addEventListener('change', () => {
  settings.german = el.optGerman.checked;
  saveSettings();
  renderAll();
});
el.optVibrate.addEventListener('change', () => {
  settings.vibrate = el.optVibrate.checked;
  saveSettings();
});

function renderSettings() {
  el.a4Value.textContent = `${settings.a4} Hz`;
  el.a4Minus.disabled = settings.a4 <= A4_MIN;
  el.a4Plus.disabled = settings.a4 >= A4_MAX;
  el.optGerman.checked = settings.german;
  el.optVibrate.checked = settings.vibrate;
}

function renderAll() {
  renderTabs();
  renderTuningSelect();
  renderStrings();
  showIdle();
}

// Im Hintergrund das Mikrofon freigeben, beim Zurückkehren wieder einschalten
let resumeOnReturn = false;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    resumeOnReturn = tuner.running;
    if (tone.playing) tone.stop();
    if (tuner.running) stopTuner();
  } else if (resumeOnReturn) {
    resumeOnReturn = false;
    autoStart();
  }
});

// ---------- Start ----------

buildGauge();
el.needle.style.transform = `rotate(${PARK_DEG}deg)`;
renderAll();
autoStart();

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && (!isLocal || params.has('sw'))) {
  // Sobald eine neue Version bereitsteht, einmal neu laden – so kommt ein Update beim nächsten Öffnen an.
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  }
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
