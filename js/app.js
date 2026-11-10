import { Tuner } from './audio.js';
import { TonePlayer } from './tone.js';
import { TUNINGS, midiToFreq, freqToMidi, centsBetween, noteName, noteOctave, nearestString } from './tunings.js';

const STORAGE_KEY = 'stimmgeraet.settings.v1';
const IN_TUNE_CENTS = 3; // innerhalb ± 3 Cent gilt die Saite als gestimmt
const IN_TUNE_HOLD_MS = 400; // so lange muss sie im grünen Bereich bleiben
const DEG_PER_CENT = 1.2; // Nadelausschlag: ± 50 Cent = ± 60°
const A4_MIN = 430;
const A4_MAX = 450;

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
  noteName: $('note-name'),
  noteOctave: $('note-octave'),
  cents: $('cents'),
  hint: $('hint'),
  freq: $('freq'),
  strings: $('strings'),
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

let shownTarget = null;
let shownCents = 0;
let lastSignal = 0;
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
  const sign = Math.abs(c) < 0.05 ? '±' : c > 0 ? '+' : '−';
  return `${sign}${text} Cent`;
};

// ---------- Anzeige aufbauen ----------

function polar(cents, radius) {
  const a = (cents * DEG_PER_CENT * Math.PI) / 180;
  return [160 + radius * Math.sin(a), 165 - radius * Math.cos(a)];
}

function buildGauge() {
  const ns = 'http://www.w3.org/2000/svg';
  for (let c = -50; c <= 50; c += 5) {
    const major = c % 10 === 0;
    const [x1, y1] = polar(c, 140);
    const [x2, y2] = polar(c, c === 0 ? 118 : major ? 126 : 132);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1.toFixed(1));
    line.setAttribute('y1', y1.toFixed(1));
    line.setAttribute('x2', x2.toFixed(1));
    line.setAttribute('y2', y2.toFixed(1));
    line.setAttribute('class', c === 0 ? 'tick zero' : major ? 'tick major' : 'tick');
    el.ticks.append(line);
  }
  for (const [c, label] of [
    [-50, '−50'],
    [0, '0'],
    [50, '+50'],
  ]) {
    const [x, y] = polar(c, 154);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', x.toFixed(1));
    text.setAttribute('y', (y + 4).toFixed(1));
    text.setAttribute('class', 'tick-label');
    text.textContent = label;
    el.ticks.append(text);
  }
  const [zx1, zy1] = polar(-IN_TUNE_CENTS, 140);
  const [zx2, zy2] = polar(IN_TUNE_CENTS, 140);
  el.zone.setAttribute('d', `M${zx1.toFixed(1)} ${zy1.toFixed(1)} A140 140 0 0 1 ${zx2.toFixed(1)} ${zy2.toFixed(1)}`);
}

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
  if (midi === null) {
    el.noteName.textContent = '–';
    el.noteOctave.textContent = '';
  } else {
    el.noteName.textContent = noteName(midi, nameOpts());
    el.noteOctave.textContent = noteOctave(midi);
  }
}

function setNeedle(cents) {
  const clamped = Math.max(-50, Math.min(50, cents));
  el.needle.style.transform = `rotate(${(clamped * DEG_PER_CENT).toFixed(2)}deg)`;
}

/** Ruhezustand: kein Ton zu hören. */
function showIdle() {
  shownTarget = null;
  okSince = 0;
  confirmed = false;
  el.meter.dataset.state = 'idle';
  el.meter.classList.remove('hold');
  setNeedle(0);
  el.cents.innerHTML = '&nbsp;';

  if (playing !== null) {
    const midi = playing === 'a4' ? 69 : currentTuning().strings[playing];
    setNote(midi);
    el.hint.textContent = 'Referenzton läuft';
    el.freq.textContent = fmtHz(midiToFreq(midi, settings.a4));
  } else if (!isChromatic() && refMode) {
    setNote(null);
    el.hint.textContent = 'Saite antippen, um den Ton zu hören';
    el.freq.innerHTML = '&nbsp;';
  } else if (!isChromatic() && locked !== null) {
    const midi = currentTuning().strings[locked];
    setNote(midi);
    el.hint.textContent = 'Saite anzupfen';
    el.freq.textContent = `Ziel ${fmtHz(midiToFreq(midi, settings.a4))}`;
  } else {
    setNote(null);
    el.hint.textContent = tuner.running ? (isChromatic() ? 'Ton spielen' : 'Saite anzupfen') : 'Mikrofon ist aus';
    el.freq.innerHTML = '&nbsp;';
  }
  updateStringStates(playing === null && !refMode ? locked : null);
}

// ---------- Messergebnisse ----------

function onResult({ freq, rms }) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -100;
  el.level.style.transform = `scaleX(${Math.max(0, Math.min(1, (db + 60) / 50)).toFixed(3)})`;

  if (playing !== null || (refMode && !isChromatic())) return;

  const now = performance.now();
  if (freq === null) {
    if (shownTarget === null) return;
    if (now - lastSignal > 1500) showIdle();
    else if (now - lastSignal > 300) el.meter.classList.add('hold');
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

  // Nadel leicht glätten; bei Saitenwechsel sofort springen
  if (shownTarget !== targetMidi) {
    shownTarget = targetMidi;
    shownCents = cents;
    okSince = 0;
    confirmed = false;
  } else {
    shownCents += (cents - shownCents) * 0.45;
  }

  const inTune = Math.abs(shownCents) <= IN_TUNE_CENTS;
  el.meter.dataset.state = inTune ? 'ok' : shownCents < 0 ? 'low' : 'high';
  setNeedle(shownCents);
  setNote(targetMidi);
  el.cents.textContent = fmtCents(shownCents);
  el.hint.textContent = inTune ? 'Gestimmt ✓' : shownCents < 0 ? 'Zu tief – höher stimmen ↑' : 'Zu hoch – tiefer stimmen ↓';

  // Weit daneben: zusätzlich anzeigen, welcher Ton tatsächlich klingt
  const heard = Math.round(freqToMidi(freq, settings.a4));
  const heardText =
    Math.abs(cents) > 50 ? ` (${noteName(heard, nameOpts())}${noteOctave(heard)})` : '';
  el.freq.textContent = `${fmtHz(freq)}${heardText} · Ziel ${fmtHz(targetFreq)}`;

  if (inTune) {
    if (!okSince) okSince = now;
    if (!confirmed && now - okSince >= IN_TUNE_HOLD_MS) {
      confirmed = true;
      if (stringIndex !== null) tuned.add(stringIndex);
      if (settings.vibrate) navigator.vibrate?.(40);
    }
  } else {
    okSince = 0;
    if (Math.abs(shownCents) > IN_TUNE_CENTS * 2) confirmed = false;
  }
  updateStringStates(stringIndex);
}

// ---------- Mikrofon ----------

const tuner = new Tuner(onResult);
const tone = new TonePlayer();
const testFreq = Number(new URLSearchParams(location.search).get('test')) || 0;
let wakeLock = null;

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
    await tuner.start({ testFreq });
    el.start.hidden = true;
    requestWakeLock();
    showIdle();
  } catch (err) {
    el.start.hidden = false;
    el.error.textContent = ERRORS[err.name] ?? `Das Mikrofon konnte nicht gestartet werden (${err.name}).`;
    el.error.hidden = false;
    showIdle();
  }
}

function stopTuner() {
  tuner.stop();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  el.level.style.transform = 'scaleX(0)';
  el.start.hidden = false;
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
  tone.play(midi2freq(midi));
  showIdle();
}

const midi2freq = (midi) => midiToFreq(midi, settings.a4);

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
renderAll();
autoStart();

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
if ('serviceWorker' in navigator && (!isLocal || new URLSearchParams(location.search).has('sw'))) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
