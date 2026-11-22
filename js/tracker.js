/**
 * Tracker: entscheidet, welche Messungen angezeigt werden, und glättet sie.
 *
 * Die Erkennung (pitch.js) liefert alle 20 ms eine Rohmessung. Rohmessungen sind
 * bei leisen Tönen lückenhaft und streuen. Der Tracker macht daraus einen ruhigen,
 * schnell reagierenden Anzeigewert:
 *
 *  - Rauschpegel wird laufend geschätzt; ein Ton zählt, wenn er sich davon abhebt.
 *    So werden auch sehr leise Saiten erkannt, ohne dass Raumgeräusche Töne erzeugen.
 *  - Hysterese: Ein neuer Ton braucht strengere Bedingungen (klar, deutlich über dem
 *    Rauschen, zwei übereinstimmende Messungen) als ein bereits verfolgter, ausklingender Ton.
 *  - Oktavsprünge innerhalb eines verfolgten Tons werden korrigiert, einzelne Ausreißer verworfen.
 *  - Glättung mit einem Kalman-Filter (Tonhöhe + Änderungsgeschwindigkeit): Jede Messung
 *    wird nach ihrer Zuverlässigkeit gewichtet – unsichere Messungen bewegen die Anzeige kaum.
 *    Weil der Filter die Änderungsgeschwindigkeit mitschätzt, folgt er dem Drehen am Wirbel
 *    ohne Nachlauf und bleibt trotzdem ruhig, wenn die Tonhöhe steht.
 *
 * Die Datei verwendet keine Browser-APIs und ist deshalb auch in Node testbar.
 */

const toCents = (freq) => 1200 * Math.log2(freq / 440);
const toFreq = (cents) => 440 * 2 ** (cents / 1200);
const OCTAVE_JUMPS = [-1200, 1200, -1902, 1902]; // Oktave und Duodezime (Grundton verfehlt / dritter Oberton)


export class Tracker {
  /**
   * @param {object} [o]
   * @param {number} [o.startClarity=0.8] Mindest-Klarheit, um einen neuen Ton zu beginnen
   * @param {number} [o.keepClarity=0.55] Mindest-Klarheit, um einen verfolgten Ton weiter anzuzeigen
   * @param {number} [o.startSnr=8]       Mindestabstand zum Rauschen (dB) für einen neuen Ton
   * @param {number} [o.keepSnr=3]        Mindestabstand zum Rauschen (dB) für einen verfolgten Ton
   * @param {number} [o.moveClarity=0.7]  Messungen unter dieser Klarheit …
   * @param {number} [o.moveSnr=6]        … oder unter diesem Rauschabstand (dB) gelten als schwach: Knapp über dem
   *                                      Raumrauschen schwanken sie langsam um mehrere Cent. Sie bewegen den Zeiger
   *                                      nur sehr langsam (vierfache Varianz, keine Geschwindigkeit), damit er beim
   *                                      Ausklingen ruhig bleibt und trotzdem dem Tonhöhenverlauf folgt.
   * @param {number} [o.weakFrames=5]    so viele übereinstimmende Messungen in Folge starten auch einen sehr leisen Ton
   * @param {number} [o.window=45]        so weit (Cent) darf eine Messung vom verfolgten Ton abweichen
   * @param {number} [o.staleMs=200]      ohne gültige Messung gilt die Anzeige danach als veraltet
   * @param {number} [o.holdMs=1500]      … und wird danach gelöscht
   * @param {number} [o.q=1000]          Prozessrauschen des Kalman-Filters (Cent²/s³): größer = folgt schneller, zittert mehr
   * @param {number} [o.damping=0.4]      Abklingzeit (s) der geschätzten Änderungsgeschwindigkeit
   * @param {number} [o.overlap=4]        Aufeinanderfolgende Messfenster überlappen stark und sind daher nicht
   *                                      unabhängig; ihre Varianz wird um diesen Faktor erhöht
   * @param {number} [o.reliable=0.75]    ab dieser Klarheit darf eine Messung die Änderungsgeschwindigkeit beeinflussen
   * @param {number} [o.sigmaBase=1.8]    erwartete Messstreuung (Cent) klarer Messungen …
   * @param {number} [o.sigmaSlope=54]    … und ihr Anstieg unterhalb einer Klarheit von 0,75.
   *                                      Beide ermittelt mit tools/simulate.mjs (Nylonsaiten, Handy-Mikrofon).
   */
  constructor(o = {}) {
    this.startClarity = o.startClarity ?? 0.8;
    this.keepClarity = o.keepClarity ?? 0.55;
    this.startSnr = o.startSnr ?? 8;
    this.keepSnr = o.keepSnr ?? 3;
    this.moveClarity = o.moveClarity ?? 0.7;
    this.moveSnr = o.moveSnr ?? 6;
    this.weakFrames = o.weakFrames ?? 5;
    this.window = o.window ?? 45;
    this.staleMs = o.staleMs ?? 200;
    this.holdMs = o.holdMs ?? 1500;
    this.q = o.q ?? 1000;
    this.damping = o.damping ?? 0.4;
    this.overlap = o.overlap ?? 4;
    this.reliable = o.reliable ?? 0.75;
    this.sigmaBase = o.sigmaBase ?? 1.8;
    this.sigmaSlope = o.sigmaSlope ?? 54;
    this.reset();
  }

  /** Erwartete Messstreuung (Cent) einer Rohmessung abhängig von ihrer Klarheit. */
  sigma(clarity) {
    return this.sigmaBase + Math.max(0, 0.75 - clarity) * this.sigmaSlope;
  }

  reset() {
    this.floorDb = null; // geschätzter Rauschpegel
    this.noiseFrames = 0; // Anzahl bisher zum Einlernen genutzter Rausch-Messungen
    this.rejects = 0; // als Ausreißer verworfene Messungen in Folge
    this.trackStart = 0; // Beginn des verfolgten Tons
    this.trackStartDb = 0; // Pegel zu Beginn des verfolgten Tons
    this.slowDb = null; // träger Pegel zur Anschlagerkennung
    this.x = null; // geschätzte Tonhöhe (Cent relativ zu A4)
    this.v = 0; // geschätzte Änderungsgeschwindigkeit (Cent/s)
    this.P = [0, 0, 0]; // Kovarianz [Pxx, Pxv, Pvv]
    this.lastAccept = -Infinity;
    this.lastMove = -Infinity; // letzte Messung, die den Zeiger bewegen durfte
    this.lastUpdate = 0;
    this.candidate = null; // möglicher neuer Ton, wartet auf Bestätigung
    this.weak = []; // letzte unsichere Messungen eines möglichen sehr leisen Tons
  }

  /**
   * @param {{freq: number|null, clarity: number, rms: number}} r Rohmessung
   * @param {number} now Zeit in Millisekunden
   * @returns {{freq: number|null, stale: boolean, weak: boolean, levelDb: number, floorDb: number}}
   *          freq: anzuzeigende Frequenz oder null; stale: Ton ist gerade nicht messbar (Anzeige blass);
   *          weak: Ton ist hörbar, aber zu leise für eine sichere Messung (Hinweis: kräftiger zupfen)
   */
  update(r, now) {
    const db = 20 * Math.log10(Math.max(r.rms || 0, 1e-10));
    const pos = r.freq ? toCents(r.freq) : null;

    // Digitale Stille (z. B. leerer Puffer direkt nach dem Start) sagt nichts über das Raumrauschen
    if (db < -110) {
      return this._output(now, db);
    }

    // Anschlag: Pegel springt deutlich über den bisherigen Verlauf
    const onset = this.slowDb !== null && db > this.slowDb + 9;
    this.slowDb = this.slowDb === null ? db : this.slowDb + (db - this.slowDb) * 0.3;

    // Rauschpegel: aus Messungen ohne Ton, schnell nach unten, langsam nach oben.
    // In den ersten Messungen nach dem Start schnell in beide Richtungen (Einlernen).
    if (this.floorDb === null) this.floorDb = Math.min(db, -65);
    const pitched = pos !== null && r.clarity >= this.keepClarity;
    const learning = this.noiseFrames < 15;
    if (db < this.floorDb) {
      this.floorDb += (db - this.floorDb) * (learning ? 0.5 : 0.25);
    } else if (!pitched) {
      this.floorDb += (db - this.floorDb) * (learning ? 0.3 : 0.03);
    }
    if (!pitched) this.noiseFrames++;

    // Gleichbleibender Dauerton (Netzbrummen, Lüfter): Saiten klingen ab, ein Ton, der nach 6 s
    // noch genauso laut ist wie zu Beginn, ist ein Störgeräusch → als Rauschpegel übernehmen.
    if (this.x !== null && now - this.trackStart > 6000 && db > this.trackStartDb - 6) {
      this.floorDb = Math.max(this.floorDb, db);
    }
    const snr = db - this.floorDb;

    const tracking = this.x !== null && now - this.lastAccept <= this.holdMs;
    const strong = pos !== null && r.clarity >= this.startClarity && snr >= this.startSnr;
    let accepted = null;

    if (pos !== null && tracking && !onset && r.clarity >= this.keepClarity && snr >= this.keepSnr) {
      // Verfolgter Ton: Oktavfehler unsicherer Messungen auf die Lage des Tons zurückführen.
      // Klare Messungen werden nicht korrigiert – sonst bliebe ein falsch erkannter Beginn
      // in der falschen Oktave hängen. Sie laufen unten als möglicher neuer Ton weiter.
      let p = pos;
      let corrected = false;
      for (const jump of OCTAVE_JUMPS) {
        if (Math.abs(p - this.x - jump) < this.window && !strong) {
          p -= jump;
          corrected = true;
          break;
        }
      }
      // Weniger verlässlich und daher geringer gewichtet: korrigierte Oktavfehler und Messungen
      // knapp über dem Rauschen (Raumrauschen im Bereich des Tons verschiebt die Messung)
      const sigma = this.sigma(r.clarity) * (corrected ? 2 : 1) * Math.min(4, Math.max(1, 15 / Math.max(snr, 1)));
      const reliable = r.clarity >= this.reliable && !corrected && snr >= 10;
      const moves = r.clarity >= this.moveClarity && snr >= this.moveSnr;
      const R = sigma * sigma * this.overlap * (moves ? 1 : 4);
      if (Math.abs(p - this.x) <= this.window && this._update(p, R, now, reliable && moves)) {
        accepted = p;
        if (moves) this.lastMove = now;
      }
    }

    if (accepted === null && strong) {
      // Neuer Ton (oder Wechsel): erst übernehmen, wenn zwei Messungen übereinstimmen.
      // Eine sehr klare Messung kurz nach einem Anschlag genügt allein.
      const c = this.candidate;
      const confirmed = c && now - c.t <= 70 && Math.abs(pos - c.pos) < 35;
      const decisive = onset || (r.clarity >= 0.95 && snr >= 15);
      if (confirmed || (decisive && !tracking)) {
        this._init(pos, this.sigma(r.clarity) ** 2, now);
        this._newTrack(now, db);
        this.candidate = null;
        accepted = pos;
        this.lastMove = now;
      } else {
        this.candidate = { pos, t: now };
      }
    }

    // Sehr leiser Ton: mehrere unsichere, aber übereinstimmende Messungen in Folge
    if (accepted === null && !tracking) {
      if (pos !== null && r.clarity >= this.keepClarity + 0.05 && snr >= this.keepSnr - 1) {
        this.weak.push(pos);
        if (this.weak.length > this.weakFrames) this.weak.shift();
        if (this.weak.length === this.weakFrames) {
          const sorted = [...this.weak].sort((a, b) => a - b);
          const median = sorted[sorted.length >> 1];
          if (sorted[sorted.length - 1] - sorted[0] <= 20) {
            this._init(median, this.sigma(r.clarity) ** 2, now);
            this._newTrack(now, db);
            accepted = median; // bleibt „schwach“: lastMove wird nicht gesetzt
          }
        }
      } else {
        this.weak.length = 0;
      }
    }
    if (accepted !== null) this.weak.length = 0;

    if (accepted !== null) this.lastAccept = now;

    return this._output(now, db);
  }

  _newTrack(now, db) {
    this.trackStart = now;
    this.trackStartDb = db;
  }

  _output(now, db) {
    if (this.x !== null && now - this.lastAccept > this.holdMs) this.x = null; // Ton ist verklungen
    return {
      freq: this.x === null ? null : toFreq(this.x),
      stale: this.x !== null && now - this.lastAccept > this.staleMs,
      weak: this.x !== null && now - this.lastAccept <= this.staleMs && now - this.lastMove > 150,
      levelDb: db,
      floorDb: this.floorDb ?? -100,
    };
  }

  _init(p, R, now) {
    this.rejects = 0;
    this.x = p;
    this.v = 0;
    this.P = [R, 0, 100 * 100];
    this.lastUpdate = now;
  }

  /**
   * Kalman-Schritt: Vorhersage bis `now`, dann Messung p mit Varianz R einrechnen.
   * Unsichere Messungen (reliable = false) korrigieren nur die Tonhöhe, nicht die
   * Änderungsgeschwindigkeit – sonst würde eine Folge verschobener Werte den Zeiger wegziehen.
   * @returns {boolean} false, wenn die Messung als Ausreißer verworfen wurde
   */
  _update(p, R, now, reliable = true) {
    const dt = (now - this.lastUpdate) / 1000;
    if (dt > 0.3) {
      // Nach einer Lücke neu ansetzen statt von einem alten Wert aus hinterherzuziehen
      this._init(p, R, now);
      return true;
    }
    // Vorhersage: konstante Geschwindigkeit, die langsam abklingt
    const decay = Math.exp(-dt / this.damping);
    const [a, b, c] = this.P;
    const x = this.x + this.v * dt;
    const v = this.v * decay;
    const q = this.q;
    // P = F·P·Fᵀ + Q  mit F = [[1, dt], [0, decay]]
    const a1 = a + 2 * dt * b + dt * dt * c + (q * dt ** 3) / 3;
    const b1 = decay * (b + dt * c) + (q * dt * dt) / 2;
    const c1 = decay * decay * c + q * dt;

    // Ausreißer: weit außerhalb der erwarteten Streuung. Nach mehreren Verwürfen in Folge
    // wird die Grenze weiter, damit der Filter einer echten Änderung (Wirbel) nicht verloren geht.
    const S = a1 + R;
    const y = p - x;
    if (y * y > 16 * S * (1 + this.rejects) + 9) {
      this.rejects++;
      return false;
    }
    this.rejects = 0;

    const k0 = a1 / S;
    const k1 = reliable ? b1 / S : 0;
    this.x = x + k0 * y;
    this.v = v + k1 * y;
    this.P = reliable ? [(1 - k0) * a1, (1 - k0) * b1, c1 - k1 * b1] : [(1 - k0) * a1, (1 - k0) * b1, c1];
    this.lastUpdate = now;
    return true;
  }
}
