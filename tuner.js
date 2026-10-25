/**
 * Guitar tuner: listens to the microphone, estimates the pitch with
 * autocorrelation and shows how far the nearest guitar string is from in tune.
 *
 * Runs fully in the browser (Web Audio API) - no server, backend or API keys.
 */

// ---------------------------------------------------------------------------
// Configuration - every tunable value is defined here, once.
// ---------------------------------------------------------------------------

/** Number of strings on the guitar; every tuning below lists exactly this many notes. */
const STRING_COUNT = 6;

/** Frequency of the reference note A4, from which every other pitch is computed. */
const A4_FREQUENCY_HZ = 440;

/** MIDI number of A4. MIDI numbers count semitones, which makes pitch maths simple. */
const A4_MIDI_NUMBER = 69;

/** Semitones above C within an octave, for each natural note letter. */
const SEMITONES_ABOVE_C = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Semitone shift of an accidental in a note name: "b" is a flat, "#" a sharp. */
const ACCIDENTAL_SEMITONES = { b: -1, "": 0, "#": 1 };

/**
 * The selectable tunings. Each string is given as a note name (letter, optional
 * "b" or "#", octave number) and its frequency is computed from that name, so no
 * frequency is typed twice. Notes run from the lowest string to the highest and
 * must stay within MIN/MAX_DETECTABLE_FREQUENCY_HZ. To add a tuning, add an entry.
 *
 * @type {{id: string, name: string, notes: string[]}[]}
 */
const TUNINGS = [
  { id: "standard", name: "Standard", notes: ["E2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "drop-d", name: "Drop D", notes: ["D2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "half-step-down", name: "Half step down", notes: ["Eb2", "Ab2", "Db3", "Gb3", "Bb3", "Eb4"] },
  { id: "dadgad", name: "DADGAD", notes: ["D2", "A2", "D3", "G3", "A3", "D4"] },
  { id: "open-g", name: "Open G", notes: ["D2", "G2", "D3", "G3", "B3", "D4"] },
];

/** Tuning used on the first visit, or when the remembered choice is no longer valid. */
const DEFAULT_TUNING_ID = "standard";

/** Browser-storage key under which the chosen tuning's id is remembered. */
const TUNING_STORAGE_KEY = "guitar-tuner.tuning";

/** Lowest frequency searched for; a bit under the lowest tuned note (D2, 73 Hz) for slack. */
const MIN_DETECTABLE_FREQUENCY_HZ = 70;

/** Highest frequency searched for; a bit above the high E (330 Hz) for slack. */
const MAX_DETECTABLE_FREQUENCY_HZ = 400;

/**
 * Size of the analysis window in samples. Must hold several periods of the
 * lowest note: 4096 samples is ~85 ms at 48 kHz, about 7 periods of 82 Hz.
 * Chosen as the default over larger windows (more accurate for the low E, which
 * reads up to ~6 cents flat here) because it reacts faster and uses less CPU.
 */
const STANDARD_WINDOW_SIZE = 4096;

/**
 * Analysis window used when the user turns on high accuracy mode: ~170 ms at
 * 48 kHz, about 14 periods of 82 Hz. Worst error is ~2.4 cents instead of ~6,
 * at roughly 4x the CPU cost and a slightly slower reaction.
 */
const HIGH_ACCURACY_WINDOW_SIZE = 8192;

/** Browser-storage key under which the high accuracy setting is remembered. */
const ACCURACY_STORAGE_KEY = "guitar-tuner.high-accuracy";

/** Signal level (RMS) below which we assume silence and skip detection. */
const MIN_SIGNAL_RMS = 0.01;

/**
 * Fraction of the best correlation a shorter lag must reach to be preferred.
 * Picking the shortest strong peak avoids "octave errors", where a multiple
 * of the true period correlates slightly better than the true period.
 */
const PEAK_PREFERENCE_RATIO = 0.9;

/** A string counts as in tune when within this many cents of its target. */
const IN_TUNE_THRESHOLD_CENTS = 5;

/** Cents shown at the far edge of the meter on each side of the centre. */
const METER_RANGE_CENTS = 50;

/**
 * How long the last reading (note, needle, peg arrow) stays on screen after the
 * sound stops, so the user has time to read it before it resets.
 */
const HOLD_DURATION_MS = 500;

/**
 * When a string is locked, a pitch further than this from it (in cents; 300 is
 * a minor third) is treated as "not that string" instead of showing a huge,
 * meaningless number of cents.
 */
const LOCKED_MAX_CENTS_OFF = 300;

/** XML namespace required for creating SVG elements from JavaScript. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Pegs on each side of the headstock (a 3+3 layout, as on most acoustic guitars). */
const PEGS_PER_SIDE = STRING_COUNT / 2;

/**
 * Layout of the headstock drawing, in SVG units. Everything drawn, including the
 * visible area (viewBox), is derived from these numbers and from STRING_COUNT,
 * so changing one value here moves the whole drawing.
 */
const HEADSTOCK_GEOMETRY = {
  nutY: 250, // vertical position of the nut, where the strings leave the headstock
  stringEndY: 270, // strings are drawn down to here, hinting at the neck below the nut
  nutLeftX: 95, // horizontal position of the lowest string at the nut
  stringSpacing: 10, // horizontal gap between neighbouring strings at the nut
  pegPostLeftX: 88, // where strings wind onto the left-side pegs
  pegPostRightX: 152, // where strings wind onto the right-side pegs
  pegKnobLeftX: 45, // centre of the left-side tuning knobs
  pegKnobRightX: 195, // centre of the right-side tuning knobs
  lowestPegY: 200, // vertical position of the peg nearest the nut on each side
  pegSpacingY: 50, // vertical gap between pegs on the same side
  topMargin: 40, // headstock extends this far above the highest peg
  knobRadius: 16,
  arrowGap: 9, // distance between a knob and the turn arrow drawn around it
  tabWidth: 5, // the small tab on the knob rim that visibly turns
  tabLength: 7,
  viewBoxPadding: 10, // empty space kept above the headstock inside the visible area
  pegHitRadius: 28, // invisible tap area around each knob, larger than the knob for fingers
  lockRingGap: 4, // distance between a knob and the ring that marks a locked string
};

// ---------------------------------------------------------------------------
// Pure helpers (no DOM, no audio) - easy to reason about and test.
// ---------------------------------------------------------------------------

/**
 * Estimates the fundamental frequency of a signal using autocorrelation.
 *
 * @param {Float32Array} samples time-domain samples in the range [-1, 1]
 * @param {number} sampleRate sampling rate of {@code samples} in Hz
 * @returns {number} the frequency in Hz, or -1 if the signal is too quiet or
 *     no clear pitch was found
 */
function detectPitchHz(samples, sampleRate) {
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  if (Math.sqrt(sumOfSquares / samples.length) < MIN_SIGNAL_RMS) return -1;

  const minLag = Math.floor(sampleRate / MAX_DETECTABLE_FREQUENCY_HZ);
  const maxLag = Math.ceil(sampleRate / MIN_DETECTABLE_FREQUENCY_HZ);
  // Compare equal-length stretches for every lag so scores are comparable.
  const comparedLength = samples.length - maxLag;

  const correlationByLag = new Float32Array(maxLag + 2);
  let bestCorrelation = 0;
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let correlation = 0;
    for (let i = 0; i < comparedLength; i++) {
      correlation += samples[i] * samples[i + lag];
    }
    correlationByLag[lag] = correlation;
    if (lag <= maxLag && correlation > bestCorrelation) bestCorrelation = correlation;
  }
  if (bestCorrelation <= 0) return -1;

  // Take the first local maximum that is nearly as strong as the best one.
  for (let lag = minLag + 1; lag <= maxLag; lag++) {
    const isLocalMax =
      correlationByLag[lag] >= correlationByLag[lag - 1] &&
      correlationByLag[lag] > correlationByLag[lag + 1];
    if (isLocalMax && correlationByLag[lag] >= PEAK_PREFERENCE_RATIO * bestCorrelation) {
      return sampleRate / refinePeakLag(correlationByLag, lag);
    }
  }
  return -1;
}

/**
 * Refines an integer peak position to sub-sample precision by fitting a
 * parabola through the peak and its two neighbours. Without this, the
 * resolution at higher notes would be too coarse to tune accurately.
 *
 * @param {Float32Array} correlationByLag correlation values indexed by lag
 * @param {number} peakLag index of a local maximum in {@code correlationByLag}
 * @returns {number} the fractional lag of the true peak
 */
function refinePeakLag(correlationByLag, peakLag) {
  const before = correlationByLag[peakLag - 1];
  const at = correlationByLag[peakLag];
  const after = correlationByLag[peakLag + 1];
  const curvature = before - 2 * at + after;
  if (curvature === 0) return peakLag;
  return peakLag + (0.5 * (before - after)) / curvature;
}

/**
 * Converts a note name to its frequency in equal temperament (A4 = 440 Hz).
 *
 * @param {string} noteName letter A-G, optional "b" (flat) or "#" (sharp), then
 *     the octave digit, e.g. "E2", "Bb3"
 * @returns {number} the frequency in Hz
 * @throws {Error} if {@code noteName} is not in that format
 */
function noteToFrequencyHz(noteName) {
  const match = /^([A-G])([b#]?)(\d)$/.exec(noteName);
  if (match === null) throw new Error(`Invalid note name: ${noteName}`);
  const [, letter, accidental, octave] = match;
  const midiNumber =
    12 * (Number(octave) + 1) + SEMITONES_ABOVE_C[letter] + ACCIDENTAL_SEMITONES[accidental];
  return A4_FREQUENCY_HZ * 2 ** ((midiNumber - A4_MIDI_NUMBER) / 12);
}

/**
 * Turns a tuning's note names into strings with target frequencies.
 *
 * @param {{notes: string[]}} tuning an entry of TUNINGS
 * @returns {{name: string, frequencyHz: number}[]} the strings, lowest to highest
 * @throws {Error} if the tuning does not have exactly STRING_COUNT notes
 */
function buildTuningStrings(tuning) {
  if (tuning.notes.length !== STRING_COUNT) {
    throw new Error(`A tuning needs ${STRING_COUNT} notes, got ${tuning.notes.length}`);
  }
  return tuning.notes.map((name) => ({ name, frequencyHz: noteToFrequencyHz(name) }));
}

/**
 * Measures how far a pitch is from a string's target, in cents (logarithmic,
 * 100 cents = one semitone), which matches how we hear.
 *
 * @param {number} frequencyHz a detected frequency, greater than 0
 * @param {{frequencyHz: number}} string the string to compare with
 * @returns {number} cents above (+) or below (-) the string's target
 */
function centsFromString(frequencyHz, string) {
  return 1200 * Math.log2(frequencyHz / string.frequencyHz);
}

/**
 * Finds the guitar string whose target frequency is closest in pitch.
 * Distance is measured in cents (logarithmic), which matches how we hear.
 *
 * @param {number} frequencyHz a detected frequency, greater than 0
 * @param {{name: string, frequencyHz: number}[]} strings the strings of the current tuning
 * @returns {{string: {name: string, frequencyHz: number}, index: number, cents: number}}
 *     the closest string, its index in {@code strings}, and how many
 *     cents {@code frequencyHz} is above (+) or below (-) that string
 */
function findClosestString(frequencyHz, strings) {
  let closest = null;
  strings.forEach((string, index) => {
    const cents = centsFromString(frequencyHz, string);
    if (closest === null || Math.abs(cents) < Math.abs(closest.cents)) {
      closest = { string, index, cents };
    }
  });
  return closest;
}

// ---------------------------------------------------------------------------
// UI and audio wiring.
// ---------------------------------------------------------------------------

const noteNameElement = document.getElementById("note-name");
const frequencyElement = document.getElementById("frequency");
const needleElement = document.getElementById("needle");
const statusElement = document.getElementById("status");
const stringListElement = document.getElementById("string-list");
const toggleButton = document.getElementById("toggle-button");
const headstockElement = document.getElementById("headstock");
const turnHintElement = document.getElementById("turn-hint");
const tuningSelectElement = document.getElementById("tuning-select");
const lockHintElement = document.getElementById("lock-hint");
const settingsButtonElement = document.getElementById("settings-button");
const settingsDialogElement = document.getElementById("settings-dialog");
const settingsCloseButtonElement = document.getElementById("settings-close");
const highAccuracyToggleElement = document.getElementById("high-accuracy-toggle");
const darkModeToggleElement = document.getElementById("dark-mode-toggle");

/** One list item per string; applyTuning fills in the note names. */
const stringItemElements = Array.from({ length: STRING_COUNT }, () => {
  const item = document.createElement("li");
  stringListElement.appendChild(item);
  return item;
});

/**
 * Creates an element in the SVG namespace (plain createElement would not render).
 *
 * @param {string} tagName SVG tag, e.g. "line" or "g"
 * @param {Object<string, string|number>} attributes attributes to set
 * @param {string} className value of the class attribute, used for styling in style.css
 * @returns {SVGElement} the new, not yet attached, element
 */
function createSvgElement(tagName, attributes, className) {
  const element = document.createElementNS(SVG_NAMESPACE, tagName);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.setAttribute("class", className);
  return element;
}

/**
 * Draws the headstock into the given SVG: the body, the nut, and for each of the
 * STRING_COUNT strings a string and a tuning peg. The low strings are on the left
 * (bottom to top) and the high strings on the right (top to bottom), so no
 * strings cross - the same as a real 3+3 headstock. The peg labels are left
 * empty; applyTuning fills them in for the selected tuning.
 *
 * @param {SVGElement} svg the (empty) SVG element to draw into
 * @returns {{stringLine: SVGElement, peg: SVGElement, label: SVGElement}[]} the
 *     animatable parts and the peg label, lowest string first
 */
function buildHeadstock(svg) {
  const g = HEADSTOCK_GEOMETRY;
  const nutRightX = g.nutLeftX + (STRING_COUNT - 1) * g.stringSpacing;
  const topY = g.lowestPegY - (PEGS_PER_SIDE - 1) * g.pegSpacingY - g.topMargin;

  // Crop the visible area to the headstock so there is no empty space above it.
  // The width spans both knob columns, which are placed symmetrically around the centre.
  const viewBoxTop = topY - g.viewBoxPadding;
  svg.setAttribute(
    "viewBox",
    `0 ${viewBoxTop} ${g.pegKnobLeftX + g.pegKnobRightX} ${g.stringEndY - viewBoxTop}`,
  );

  // Body is a trapezoid, wider at the top where the pegs are.
  const bodyPoints = [
    [g.nutLeftX - 8, g.nutY],
    [g.pegPostLeftX - 16, topY],
    [g.pegPostRightX + 16, topY],
    [nutRightX + 8, g.nutY],
  ];
  svg.appendChild(
    createSvgElement("polygon", { points: bodyPoints.map((p) => p.join(",")).join(" ") }, "headstock-body"),
  );
  svg.appendChild(
    createSvgElement(
      "rect",
      { x: g.nutLeftX - 8, y: g.nutY, width: nutRightX - g.nutLeftX + 16, height: 6 },
      "headstock-nut",
    ),
  );

  return Array.from({ length: STRING_COUNT }, (_, index) => {
    const isLeftSide = index < PEGS_PER_SIDE;
    const rowFromBottom = isLeftSide ? index : STRING_COUNT - 1 - index;
    const pegY = g.lowestPegY - rowFromBottom * g.pegSpacingY;
    const postX = isLeftSide ? g.pegPostLeftX : g.pegPostRightX;
    const knobX = isLeftSide ? g.pegKnobLeftX : g.pegKnobRightX;
    const nutX = g.nutLeftX + index * g.stringSpacing;

    const stringLine = createSvgElement(
      "line",
      { x1: nutX, y1: g.stringEndY, x2: postX, y2: pegY },
      "guitar-string",
    );
    svg.appendChild(stringLine);
    svg.appendChild(
      createSvgElement("line", { x1: postX, y1: pegY, x2: knobX, y2: pegY }, "peg-shaft"),
    );

    // The peg group is centred on the knob so rotations and the arrow use (0, 0) as the pivot.
    const peg = createSvgElement("g", { transform: `translate(${knobX} ${pegY})` }, "peg");
    // Invisible circle larger than the knob, so the peg is easy to tap on a phone.
    peg.appendChild(createSvgElement("circle", { r: g.pegHitRadius }, "peg-hit-area"));
    // Ring shown only while this string is locked (see style.css).
    peg.appendChild(
      createSvgElement("circle", { r: g.knobRadius + g.lockRingGap }, "peg-lock-ring"),
    );
    // Arrow: a 270-degree arc around the knob, drawn clockwise from the top to the
    // left, with a head pointing up at its end. style.css mirrors it for counterclockwise turns.
    const arrowRadius = g.knobRadius + g.arrowGap;
    const arrow = createSvgElement("g", {}, "peg-arrow");
    arrow.appendChild(
      createSvgElement(
        "path",
        { d: `M 0 ${-arrowRadius} A ${arrowRadius} ${arrowRadius} 0 1 1 ${-arrowRadius} 0` },
        "peg-arrow-line",
      ),
    );
    arrow.appendChild(
      createSvgElement(
        "polygon",
        {
          points:
            `${-arrowRadius},-8 ` +
            `${-arrowRadius - 7},1 ` +
            `${-arrowRadius + 7},1`,
        },
        "peg-arrow-head",
      ),
    );
    peg.appendChild(arrow);
    peg.appendChild(createSvgElement("circle", { r: g.knobRadius }, "peg-knob"));
    // The small tab on the knob rim is what visibly turns.
    peg.appendChild(
      createSvgElement(
        "rect",
        { x: -g.tabWidth / 2, y: -g.knobRadius, width: g.tabWidth, height: g.tabLength, rx: 1 },
        "peg-tab",
      ),
    );
    // dy of 0.35em centres the text vertically whatever font size style.css gives it.
    const label = createSvgElement("text", { x: 0, y: 0, dy: "0.35em" }, "peg-label");
    peg.appendChild(label);
    svg.appendChild(peg);

    return { stringLine, peg, label };
  });
}

/** Animatable headstock parts, one entry per string, lowest string first. */
const headstockParts = buildHeadstock(headstockElement);

/** CSS classes that renderReading may put on headstock parts; all are cleared on every update. */
const HEADSTOCK_STATE_CLASSES = ["active", "vibrating", "in-tune", "turn-clockwise", "turn-counterclockwise"];

/**
 * Tells which way a string's peg must be turned to move the pitch in the wanted
 * direction. On a 3+3 headstock the pegs on the two sides are mirror images:
 * left-side pegs tighten counterclockwise, right-side pegs clockwise.
 *
 * @param {number} stringIndex index of the string, 0 being the lowest
 * @param {boolean} needsTightening true if the pitch must go up, false if down
 * @returns {boolean} true if the peg must be turned clockwise, false for counterclockwise
 */
function isTurnClockwise(stringIndex, needsTightening) {
  const isLeftSide = stringIndex < PEGS_PER_SIDE;
  return isLeftSide !== needsTightening;
}

/** Audio objects while listening; null when stopped. */
let audioContext = null;
let microphoneStream = null;
let animationFrameId = null;

/** Strings (name and target frequency) of the selected tuning, lowest first; set by applyTuning. */
let currentStrings = [];

/** Index of the string the user locked the tuner to, or null for automatic string detection. */
let lockedStringIndex = null;

/** The microphone analyser and its sample buffer while listening; null when stopped. */
let analyserNode = null;
let sampleBuffer = null;

/** Whether high accuracy mode (the longer analysis window) is on; set by setHighAccuracy. */
let isHighAccuracy = false;

/**
 * Tells how many samples the pitch detector should analyse per frame.
 *
 * @returns {number} HIGH_ACCURACY_WINDOW_SIZE in high accuracy mode, otherwise STANDARD_WINDOW_SIZE
 */
function getAnalysisWindowSize() {
  return isHighAccuracy ? HIGH_ACCURACY_WINDOW_SIZE : STANDARD_WINDOW_SIZE;
}

/**
 * Decides which string a pitch is measured against: the locked string if there
 * is one, otherwise the closest string of the current tuning.
 *
 * @param {number} frequencyHz a detected frequency, greater than 0
 * @returns {{string: {name: string, frequencyHz: number}, index: number, cents: number}}
 *     the target string, its index, and the cents {@code frequencyHz} is above (+) or below (-) it
 */
function findTargetString(frequencyHz) {
  if (lockedStringIndex === null) return findClosestString(frequencyHz, currentStrings);
  const string = currentStrings[lockedStringIndex];
  return { string, index: lockedStringIndex, cents: centsFromString(frequencyHz, string) };
}

/**
 * Updates the display for a detected pitch, or resets it when none was found.
 *
 * @param {number} frequencyHz detected frequency, or -1 if none
 * @param {boolean} [isLive=true] whether the sound is still being played; false
 *     while a past reading is only being held on screen, so the string stops vibrating
 */
function renderReading(frequencyHz, isLive = true) {
  stringItemElements.forEach((item) => item.classList.remove("active"));
  headstockParts.forEach(({ stringLine, peg }) => {
    stringLine.classList.remove(...HEADSTOCK_STATE_CLASSES);
    peg.classList.remove(...HEADSTOCK_STATE_CLASSES);
  });
  turnHintElement.textContent = "";

  if (frequencyHz <= 0) {
    noteNameElement.textContent = "--";
    frequencyElement.textContent = "0.0 Hz";
    needleElement.style.left = "50%";
    needleElement.classList.remove("in-tune");
    statusElement.textContent =
      lockedStringIndex === null
        ? "Play a string..."
        : `Play the ${currentStrings[lockedStringIndex].name} string...`;
    return;
  }

  const { string, index, cents } = findTargetString(frequencyHz);
  const isInTune = Math.abs(cents) <= IN_TUNE_THRESHOLD_CENTS;
  // Clamp so the needle never leaves the meter for wildly off pitches.
  const clampedCents = Math.max(-METER_RANGE_CENTS, Math.min(METER_RANGE_CENTS, cents));

  noteNameElement.textContent = string.name;
  frequencyElement.textContent = `${frequencyHz.toFixed(1)} Hz`;
  needleElement.style.left = `${50 + (clampedCents / METER_RANGE_CENTS) * 50}%`;
  if (lockedStringIndex !== null && Math.abs(cents) > LOCKED_MAX_CENTS_OFF) {
    needleElement.classList.remove("in-tune");
    statusElement.textContent = `Not near ${string.name} - pluck the ${string.name} string`;
    return;
  }
  needleElement.classList.toggle("in-tune", isInTune);
  stringItemElements[index].classList.add("active");

  const { stringLine, peg } = headstockParts[index];
  stringLine.classList.add("active");
  stringLine.classList.toggle("vibrating", isLive);
  stringLine.classList.toggle("in-tune", isInTune);
  peg.classList.add("active");
  peg.classList.toggle("in-tune", isInTune);
  if (!isInTune) {
    const needsTightening = cents < 0;
    const clockwise = isTurnClockwise(index, needsTightening);
    peg.classList.add(clockwise ? "turn-clockwise" : "turn-counterclockwise");
    turnHintElement.textContent =
      `${needsTightening ? "Tighten" : "Loosen"}: turn the ${string.name} peg ` +
      `${clockwise ? "clockwise ↻" : "counterclockwise ↺"}`;
  }
  statusElement.textContent = isInTune
    ? "In tune!"
    : cents < 0
      ? `${Math.abs(cents).toFixed(0)} cents flat - tighten the string`
      : `${cents.toFixed(0)} cents sharp - loosen the string`;
}

/**
 * Requests microphone access and starts the analysis loop.
 * Echo cancellation and similar processing are disabled because they are
 * meant for speech and distort sustained musical notes.
 */
async function startTuner() {
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (error) {
    statusElement.textContent =
      "Microphone unavailable. Allow access and use HTTPS or localhost.";
    return;
  }

  audioContext = new AudioContext();
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = getAnalysisWindowSize();
  audioContext.createMediaStreamSource(microphoneStream).connect(analyserNode);

  sampleBuffer = new Float32Array(analyserNode.fftSize);
  // Last successful detection, kept so the reading can linger after the sound stops.
  let lastDetection = null;
  const analyseFrame = () => {
    // The buffer is re-read every frame because high accuracy mode can replace it while listening.
    analyserNode.getFloatTimeDomainData(sampleBuffer);
    const frequencyHz = detectPitchHz(sampleBuffer, audioContext.sampleRate);
    const nowMs = performance.now();
    if (frequencyHz > 0) {
      lastDetection = { frequencyHz, timeMs: nowMs };
      renderReading(frequencyHz);
    } else if (lastDetection !== null && nowMs - lastDetection.timeMs < HOLD_DURATION_MS) {
      renderReading(lastDetection.frequencyHz, false);
    } else {
      renderReading(-1);
    }
    animationFrameId = requestAnimationFrame(analyseFrame);
  };
  analyseFrame();

  toggleButton.textContent = "Stop";
}

/** Stops listening and releases the microphone so the browser's mic indicator turns off. */
function stopTuner() {
  cancelAnimationFrame(animationFrameId);
  microphoneStream.getTracks().forEach((track) => track.stop());
  audioContext.close();
  audioContext = null;
  microphoneStream = null;
  analyserNode = null;
  sampleBuffer = null;
  renderReading(-1);
  statusElement.textContent = "Press Start and play a string.";
  toggleButton.textContent = "Start";
}

toggleButton.addEventListener("click", () => {
  if (audioContext === null) startTuner();
  else stopTuner();
});

/**
 * Looks up a tuning by id.
 *
 * @param {string|null} id a tuning id, possibly missing or outdated (e.g. from storage)
 * @returns {{id: string, name: string, notes: string[]}} the matching tuning, or the
 *     default tuning if there is no match
 */
function findTuningById(id) {
  return (
    TUNINGS.find((tuning) => tuning.id === id) ??
    TUNINGS.find((tuning) => tuning.id === DEFAULT_TUNING_ID)
  );
}

/**
 * Reads the remembered tuning id. Storage can be blocked (e.g. private browsing),
 * in which case the default tuning is simply used.
 *
 * @returns {string|null} the saved id, or null if nothing could be read
 */
function loadSavedTuningId() {
  return readStorage(TUNING_STORAGE_KEY);
}

/**
 * Remembers the chosen tuning for the next visit; silently does nothing if
 * storage is blocked, since the tuner works fine without it.
 *
 * @param {string} id the id of the tuning to remember
 */
function saveTuningId(id) {
  writeStorage(TUNING_STORAGE_KEY, id);
}

/**
 * Switches the tuner to the given tuning: updates the string list, the peg
 * labels and the selector, and clears the current reading, which belonged to
 * the previous tuning.
 *
 * @param {{id: string, name: string, notes: string[]}} tuning an entry of TUNINGS
 */
function applyTuning(tuning) {
  currentStrings = buildTuningStrings(tuning);
  currentStrings.forEach((string, index) => {
    stringItemElements[index].textContent = string.name;
    headstockParts[index].label.textContent = string.name;
  });
  tuningSelectElement.value = tuning.id;
  // The lock refers to a position in the old tuning, so it no longer means anything.
  lockedStringIndex = null;
  updateLockMarkers();
  if (audioContext !== null) renderReading(-1);
}

/**
 * Shows which string (if any) is locked: marks it in the string list and on
 * its peg, keeps the list items' accessibility state in sync, and shows a line
 * explaining how to return to automatic mode (empty when nothing is locked).
 */
function updateLockMarkers() {
  lockHintElement.textContent =
    lockedStringIndex === null
      ? ""
      : `Locked to ${currentStrings[lockedStringIndex].name} · tap it again for auto mode`;
  stringItemElements.forEach((item, index) => {
    const isLocked = index === lockedStringIndex;
    item.classList.toggle("locked", isLocked);
    item.setAttribute("aria-pressed", String(isLocked));
    headstockParts[index].peg.classList.toggle("locked", isLocked);
  });
}

/**
 * Locks the tuner to a string, or unlocks it if that string is already locked.
 * While locked, pitches are measured against that string only, instead of the
 * closest one - useful when a string is so far off that it would be mistaken
 * for its neighbour.
 *
 * @param {number} stringIndex index of the tapped string, 0 being the lowest
 */
function toggleStringLock(stringIndex) {
  setLockedString(lockedStringIndex === stringIndex ? null : stringIndex);
}

/**
 * Sets which string the tuner is locked to and refreshes the display.
 *
 * @param {number|null} stringIndex index of the string to lock to, or null for automatic mode
 */
function setLockedString(stringIndex) {
  lockedStringIndex = stringIndex;
  updateLockMarkers();
  if (audioContext !== null) renderReading(-1);
}

/**
 * Decides what a letter key does: the next string whose note letter matches.
 * The first press locks the lowest matching string, each further press moves to
 * the next matching one (e.g. low E, then high E in standard tuning), and the
 * press after the last matching string unlocks.
 *
 * @param {{name: string}[]} strings the strings of the current tuning, lowest first
 * @param {string} noteLetter a letter A-G
 * @param {number|null} currentLockedIndex the currently locked string, or null
 * @returns {number|null|undefined} the string to lock to, null to unlock, or
 *     undefined if no string of this tuning has that note letter (key is ignored)
 */
function nextLockIndexForLetter(strings, noteLetter, currentLockedIndex) {
  const matchingIndexes = strings
    .map((string, index) => index)
    .filter((index) => strings[index].name[0] === noteLetter);
  if (matchingIndexes.length === 0) return undefined;
  const position = matchingIndexes.indexOf(currentLockedIndex);
  if (position === -1) return matchingIndexes[0];
  return position + 1 < matchingIndexes.length ? matchingIndexes[position + 1] : null;
}

/**
 * Works out which note letter (A-G) a key press stands for, whatever the
 * keyboard language. On Latin layouts the printed letter is used, so layouts
 * like AZERTY or Dvorak work as labelled. On other scripts (Hebrew, Russian,
 * Arabic ...) the printed letter is not A-G, so the key's physical position is
 * used instead: the key that is E on a US keyboard counts as E.
 *
 * @param {KeyboardEvent} event the key press
 * @returns {string|null} the letter A-G, or null if the key is not a note letter
 */
function noteLetterFromKeyEvent(event) {
  const printed = typeof event.key === "string" && event.key.length === 1 ? event.key.toUpperCase() : "";
  if (/^[A-G]$/.test(printed)) return printed;
  const physical = /^Key([A-G])$/.exec(event.code ?? "");
  return physical === null ? null : physical[1];
}

/**
 * Keyboard shortcuts: pressing a note letter locks the matching string (see
 * nextLockIndexForLetter). Ignored while typing in a form control, while the
 * settings dialog is open, when a modifier key is held (so browser shortcuts
 * keep working), and for auto-repeat when a key is held down.
 *
 * @param {KeyboardEvent} event the key press
 */
function handleKeyDown(event) {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const targetTag = event.target && event.target.tagName;
  if (targetTag === "SELECT" || targetTag === "INPUT" || targetTag === "TEXTAREA") return;
  if (settingsDialogElement.open) return;

  const noteLetter = noteLetterFromKeyEvent(event);
  if (noteLetter === null) return;
  const nextIndex = nextLockIndexForLetter(currentStrings, noteLetter, lockedStringIndex);
  if (nextIndex === undefined) return;
  setLockedString(nextIndex);
}

document.addEventListener("keydown", handleKeyDown);

/**
 * Turns high accuracy mode on or off. If the tuner is listening, the analysis
 * window is resized on the spot, so there is no need to stop and restart.
 *
 * @param {boolean} enabled true for the longer, more accurate window
 */
function setHighAccuracy(enabled) {
  isHighAccuracy = enabled;
  highAccuracyToggleElement.checked = enabled;
  if (analyserNode !== null) {
    analyserNode.fftSize = getAnalysisWindowSize();
    sampleBuffer = new Float32Array(analyserNode.fftSize);
  }
}

// Each string can be tapped in the list or on the headstock. List items are also
// operable from the keyboard, so they behave like buttons for assistive technology.
stringItemElements.forEach((item, index) => {
  item.setAttribute("role", "button");
  item.setAttribute("tabindex", "0");
  item.addEventListener("click", () => toggleStringLock(index));
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleStringLock(index);
    }
  });
  headstockParts[index].peg.addEventListener("click", () => toggleStringLock(index));
});

TUNINGS.forEach((tuning) => {
  const option = document.createElement("option");
  option.value = tuning.id;
  option.textContent = tuning.name;
  tuningSelectElement.appendChild(option);
});
tuningSelectElement.addEventListener("change", () => {
  const tuning = findTuningById(tuningSelectElement.value);
  applyTuning(tuning);
  saveTuningId(tuning.id);
});
applyTuning(findTuningById(loadSavedTuningId()));

// Settings dialog: opened with the gear button, closed with its button, Escape
// (built into <dialog>) or a click on the dark area around it.
settingsButtonElement.addEventListener("click", () => {
  if (typeof settingsDialogElement.showModal === "function") settingsDialogElement.showModal();
});
settingsCloseButtonElement.addEventListener("click", () => settingsDialogElement.close());
settingsDialogElement.addEventListener("click", (event) => {
  if (event.target === settingsDialogElement) settingsDialogElement.close();
});
highAccuracyToggleElement.addEventListener("change", () => {
  setHighAccuracy(highAccuracyToggleElement.checked);
  writeStorage(ACCURACY_STORAGE_KEY, String(isHighAccuracy));
});
setHighAccuracy(readStorage(ACCURACY_STORAGE_KEY) === "true");

// Dark mode itself is applied by theme.js before the page is drawn; here the checkbox
// is set to match it and wired up to change and remember the choice.
darkModeToggleElement.checked = isDarkMode();
darkModeToggleElement.addEventListener("change", () => {
  setDarkMode(darkModeToggleElement.checked);
  writeStorage(DARK_MODE_STORAGE_KEY, String(darkModeToggleElement.checked));
});
