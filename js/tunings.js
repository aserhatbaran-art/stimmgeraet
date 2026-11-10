/**
 * Stimmungen, Notennamen und Umrechnungen.
 * Saiten sind als MIDI-Nummern angegeben (A4 = 69), von der tiefsten zur höchsten
 * Saite in der Reihenfolge, wie sie auf dem Instrument liegen.
 */

export const TUNINGS = {
  guitar: [
    { id: 'standard', name: 'Standard (E A D G H E)', strings: [40, 45, 50, 55, 59, 64] },
    { id: 'dropd', name: 'Drop D', strings: [38, 45, 50, 55, 59, 64] },
    { id: 'eb', name: 'Halbton tiefer (E♭)', strings: [39, 44, 49, 54, 58, 63], flats: true },
    { id: 'dadgad', name: 'DADGAD', strings: [38, 45, 50, 55, 57, 62] },
    { id: 'openg', name: 'Open G', strings: [38, 43, 50, 55, 59, 62] },
    { id: 'opend', name: 'Open D', strings: [38, 45, 50, 54, 57, 62] },
  ],
  ukulele: [
    { id: 'standard', name: 'Standard (G C E A)', strings: [67, 60, 64, 69] },
    { id: 'lowg', name: 'Low-G', strings: [55, 60, 64, 69] },
    { id: 'baritone', name: 'Bariton (D G H E)', strings: [50, 55, 59, 64] },
    { id: 'd', name: 'D-Stimmung (A D F♯ H)', strings: [69, 62, 66, 71] },
  ],
};

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Frequenz einer MIDI-Note bei gegebenem Kammerton. */
export function midiToFreq(midi, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12);
}

/** Gebrochene MIDI-Nummer zu einer Frequenz. */
export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

/** Abweichung in Cent zwischen gemessener Frequenz und Zielfrequenz. */
export function centsBetween(freq, target) {
  return 1200 * Math.log2(freq / target);
}

/**
 * Notenname ohne Oktave.
 * @param {number} midi
 * @param {{german?: boolean, flats?: boolean}} [options] german: H statt B
 */
export function noteName(midi, { german = true, flats = false } = {}) {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const name = (flats ? FLAT : SHARP)[pc];
  return german && pc === 11 ? 'H' : name;
}

/** Oktavnummer in wissenschaftlicher Schreibweise (A4 = 440 Hz). */
export function noteOctave(midi) {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** Index der Saite, die der Frequenz am nächsten liegt. */
export function nearestString(freq, strings, a4 = 440) {
  const midi = freqToMidi(freq, a4);
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < strings.length; i++) {
    const dist = Math.abs(midi - strings[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}
