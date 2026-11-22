import { Tuner } from './audio.js';
import { TonePlayer } from './tone.js';
import { TUNINGS, midiToFreq, freqToMidi, centsBetween, noteName, noteOctave, nearestString } from './tunings.js';

const STORAGE_KEY = 'stimmgeraet.settings.v1';
const SCALE_RANGE = 50; // Skala reicht einen Viertelton nach unten und oben
const IN_TUNE_ENTER = 3; // grün ab dieser Abweichung (Cent) …
const IN_TUNE_LEAVE = 5; // … und erst ab dieser wieder nicht mehr grün (kein Flackern an der Grenze)
const SLIGHTLY = 12; // bis hier „etwas“ höher/tiefer
const IN_TUNE_HOLD_MS = 300; // so lange muss die Saite grün bleiben, bis sie als gestimmt gilt
const MARKER_TAU_MS = 30; // Trägheit der Markerbewegung (nur Optik, die Messwerte sind schon geglättet)
const A4_MIN = 430;
const A4_MAX = 450;

const $ = (id) => document.getElementById(id);
const el = {
  tabs: $('instrument-tabs'),
  tuningRow: $('tuning-row'),
  tuningSelect: $('tuning-select'),
  meter: $('meter'),
  marker: $('marker'),
  ticks: $('scale-ticks'),
  level: $('level-bar'),
  readout: $('readout'),
  noteName: $('note-name'),
  noteOctave: $('note-octave'),
  hint: $('hint'),
  sub: $('sub'),
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
  s.german = s.german !== false;
  s.vibrate = s.vibrate !== false;
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

let shownTarget = null; // MIDI-Nummer des angezeigten Zieltons, null = kein Ton
let inTune = false;
let okSince = 0;
let confirmed = false;

const isChromatic = () => settings.instrument === 'chromatic';

function currentTuning() {
  const list = TUNINGS[settings.instrument];
  return list.find((t) => t.id === settings.tuning[settings.instrument]) ?? list[0];
}

const nameOpts = () => ({ german: settings.german, flats: !isChromatic() && !!currentTuning().flats });
const fullName = (midi) => `${noteName(midi, nameOpts())}${noteOctave(midi)}`;

// ---------- Formatierung ----------

const fmtHz = (freq) => `${freq.toFixed(1).replace('.', ',')} Hz`;

/** Text nur schreiben, wenn er sich geändert hat (spart Arbeit bei 50 Messungen pro Sekunde). */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// ---------- Skala und Marker ----------

function buildScale() {
  for (let c = -SCALE_RANGE; c <= SCALE_RANGE; c += 5) {
    const tick = document.createElement('span');
    tick.className = c === 0 ? 'tick zero' : c % 25 === 0 ? 'tick major' : c % 10 === 0 ? 'tick medium' : 'tick';
    tick.style.left = `${50 + (c / SCALE_RANGE) * 50}%`;
    el.ticks.append(tick);
  }
}

// Der Marker gleitet mit kurzer Trägheit zur neuen Position (−1 … +1 = linker … rechter Rand).
let markerPos = 0;
let markerTarget = 0;
let markerFrame = 0;
let markerTime = 0;

function setMarker(cents, jump = false) {
  markerTarget = Math.max(-1, Math.min(1, cents / SCALE_RANGE));
  if (jump) {
    // Neuer Ton: direkt an die gemessene Stelle, ohne über die Skala zu wandern
    markerPos = markerTarget;
    drawMarker();
    return;
  }
  if (!markerFrame && markerPos !== markerTarget) {
    markerTime = performance.now();
    markerFrame = requestAnimationFrame(stepMarker);
  }
}

function stepMarker(now) {
  const dt = Math.min(64, Math.max(0, now - markerTime));
  markerTime = now;
  markerPos += (markerTarget - markerPos) * (1 - Math.exp(-dt / MARKER_TAU_MS));
  if (Math.abs(markerTarget - markerPos) < 0.0005) markerPos = markerTarget;
  drawMarker();
  markerFrame = markerPos === markerTarget ? 0 : requestAnimationFrame(stepMarker);
}

function drawMarker() {
  // Der Marker ist so breit wie die Skala; 50 % seiner Breite = halbe Skala
  el.marker.style.transform = `translateX(${(markerPos * 50).toFixed(2)}%)`;
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

/** Ruhezustand: kein Ton zu hören. Der Marker verschwindet. */
function showIdle() {
  shownTarget = null;
  inTune = false;
  okSince = 0;
  confirmed = false;
  el.meter.dataset.state = 'idle';
  el.meter.classList.remove('stale', 'weak');

  // Solange das Mikrofon aus ist, steht an Stelle der Hinweise die Einschalt-Taste
  const showStart = !tuner.running && playing === null;
  el.startbox.hidden = !showStart;
  el.readout.hidden = showStart;

  if (playing !== null) {
    const midi = playing === 'a4' ? 69 : currentTuning().strings[playing];
    setNote(midi);
    setText(el.hint, 'Referenzton läuft');
    setText(el.sub, fmtHz(midiToFreq(midi, settings.a4)));
  } else if (!isChromatic() && refMode) {
    setNote(null);
    setText(el.hint, 'Saite antippen, um ihren Ton zu hören');
    setText(el.sub, ' ');
  } else if (!isChromatic() && locked !== null) {
    const midi = currentTuning().strings[locked];
    setNote(midi);
    setText(el.hint, `Saite ${currentTuning().strings.length - locked} anzupfen`);
    setText(el.sub, `Ziel ${fmtHz(midiToFreq(midi, settings.a4))}`);
  } else {
    setNote(null);
    setText(el.hint, isChromatic() ? 'Ton spielen' : 'Saite anzupfen');
    setText(el.sub, ' ');
  }
  updateStringStates(playing === null && !refMode ? locked : null);
}

// ---------- Messergebnisse ----------

function onResult({ freq, stale, weak, levelDb, floorDb, ms }) {
  // Pegelbalken: Abstand zum Rauschen (0 … 30 dB)
  const snr = levelDb - floorDb;
  el.level.style.transform = `scaleX(${Math.max(0, Math.min(1, snr / 30)).toFixed(3)})`;
  if (testFreq) recordTestStats(freq, ms);

  if (playing !== null || (refMode && !isChromatic())) return;
  if (freq === null) {
    if (shownTarget !== null) showIdle();
    return;
  }

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
  shownTarget = targetMidi;
  setMarker(cents, changed);
  setNote(targetMidi);

  // Grün mit Hysterese, damit die Farbe an der Grenze nicht flackert
  inTune = Math.abs(cents) <= (inTune && !changed ? IN_TUNE_LEAVE : IN_TUNE_ENTER);
  el.meter.dataset.state = inTune ? 'ok' : cents < 0 ? 'low' : 'high';
  el.meter.classList.toggle('stale', stale);
  el.meter.classList.toggle('weak', weak && !stale);

  setText(el.hint, hintFor(cents));
  if (stale) setText(el.sub, 'Ton ist verklungen – neu anzupfen');
  else if (weak) setText(el.sub, 'Sehr leise – kräftiger zupfen oder Handy näher halten');
  else if (Math.abs(cents) > SCALE_RANGE) setText(el.sub, `Klingt wie ${fullName(Math.round(freqToMidi(freq, settings.a4)))} · Ziel ${fullName(targetMidi)}`);
  else setText(el.sub, `${fmtHz(freq)} · Ziel ${fmtHz(targetFreq)}`);

  if (inTune && !stale && !weak) {
    if (changed || !okSince) okSince = performance.now();
    if (!confirmed && performance.now() - okSince >= IN_TUNE_HOLD_MS) {
      confirmed = true;
      if (stringIndex !== null) tuned.add(stringIndex);
      if (settings.vibrate && navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(40);
    }
  } else if (!inTune) {
    okSince = 0;
    confirmed = false;
  } else {
    okSince = 0; // grün, aber veraltet oder zu leise: Haltezeit neu beginnen
  }
  updateStringStates(stringIndex);
}

function hintFor(cents) {
  if (inTune) return 'Gestimmt ✓';
  const abs = Math.abs(cents);
  if (cents < 0) return abs > SCALE_RANGE ? 'Viel zu tief – höher stimmen' : abs <= SLIGHTLY ? 'Etwas höher stimmen' : 'Höher stimmen';
  return abs > SCALE_RANGE ? 'Viel zu hoch – tiefer stimmen' : abs <= SLIGHTLY ? 'Etwas tiefer stimmen' : 'Tiefer stimmen';
}

// ---------- Mikrofon ----------

const tuner = new Tuner(onResult);
const tone = new TonePlayer();
const params = new URLSearchParams(location.search);
const testFreq = Number(params.get('test')) || 0; // Testmodus: künstlicher Ton statt Mikrofon
const testDelay = Number(params.get('delay')) || 0;
const levelParam = Number(params.get('level'));
const testLevel = Number.isFinite(levelParam) && params.has('level') ? Math.min(0, Math.max(-100, levelParam)) : -20;
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
    await tuner.start({ testFreq, testDelay, testLevel });
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

buildScale();
drawMarker();
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
