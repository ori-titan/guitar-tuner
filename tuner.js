/**
 * Guitar tuner: listens to the microphone, estimates the pitch with
 * autocorrelation and shows how far the nearest guitar string is from in tune.
 *
 * Runs fully in the browser (Web Audio API) - no server, backend or API keys.
 */

// ---------------------------------------------------------------------------
// Configuration - every tunable value is defined here, once.
// ---------------------------------------------------------------------------

/**
 * Open strings of a guitar in standard tuning, lowest to highest.
 * @type {{name: string, frequencyHz: number}[]}
 */
const STANDARD_TUNING = [
  { name: "E2", frequencyHz: 82.41 },
  { name: "A2", frequencyHz: 110.0 },
  { name: "D3", frequencyHz: 146.83 },
  { name: "G3", frequencyHz: 196.0 },
  { name: "B3", frequencyHz: 246.94 },
  { name: "E4", frequencyHz: 329.63 },
];

/** Lowest frequency searched for; a bit under the low E (82 Hz) for slack. */
const MIN_DETECTABLE_FREQUENCY_HZ = 70;

/** Highest frequency searched for; a bit above the high E (330 Hz) for slack. */
const MAX_DETECTABLE_FREQUENCY_HZ = 400;

/**
 * Size of the long analysis window in samples, used only for the lowest notes.
 * Must hold many periods of the lowest note: 8192 samples is ~170 ms at 48 kHz,
 * about 14 periods of 82 Hz. A 4096 window was too short: it made a perfectly
 * tuned low E read ~6 cents flat. Larger windows are more accurate but cost
 * more CPU and react more slowly, so higher notes use SHORT_WINDOW_SIZE instead.
 */
const FFT_SIZE = 8192;

/**
 * Size of the short analysis window in samples (the newest part of the long
 * one). ~85 ms at 48 kHz: 4x cheaper than the long window and it forgets an old
 * note sooner, which is accurate enough for every string except the low E.
 */
const SHORT_WINDOW_SIZE = 4096;

/**
 * Pitches below this (between the low E at 82 Hz and the A at 110 Hz), or no
 * pitch at all from the short window, trigger a second look with the long window.
 */
const LONG_WINDOW_BELOW_HZ = 95;

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

/** XML namespace required for creating SVG elements from JavaScript. */
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Pegs on each side of the headstock (a 3+3 layout, as on most acoustic guitars). */
const PEGS_PER_SIDE = STANDARD_TUNING.length / 2;

/**
 * Layout of the headstock drawing, in SVG units. Everything drawn, including the
 * visible area (viewBox), is derived from these numbers and from STANDARD_TUNING,
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
  knobRadius: 13,
  viewBoxPadding: 10, // empty space kept above the headstock inside the visible area
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
 * Estimates the pitch in two stages to balance speed and low-note accuracy:
 * first on the short window (fast, cheap), and only if that finds nothing or a
 * very low pitch, again on the full long window (slower, but accurate for the low E).
 *
 * @param {Float32Array} samples the long window of time-domain samples, newest last
 * @param {number} sampleRate sampling rate of {@code samples} in Hz
 * @returns {number} the frequency in Hz, or -1 if no clear pitch was found
 */
function detectPitchTwoStageHz(samples, sampleRate) {
  const newestSamples = samples.subarray(samples.length - SHORT_WINDOW_SIZE);
  const quickFrequencyHz = detectPitchHz(newestSamples, sampleRate);
  if (quickFrequencyHz >= LONG_WINDOW_BELOW_HZ) return quickFrequencyHz;
  return detectPitchHz(samples, sampleRate);
}

/**
 * Finds the guitar string whose target frequency is closest in pitch.
 * Distance is measured in cents (logarithmic), which matches how we hear.
 *
 * @param {number} frequencyHz a detected frequency, greater than 0
 * @returns {{string: {name: string, frequencyHz: number}, index: number, cents: number}}
 *     the closest string, its index in {@code STANDARD_TUNING}, and how many
 *     cents {@code frequencyHz} is above (+) or below (-) that string
 */
function findClosestString(frequencyHz) {
  let closest = null;
  STANDARD_TUNING.forEach((string, index) => {
    const cents = 1200 * Math.log2(frequencyHz / string.frequencyHz);
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

/** One list item per string, built from STANDARD_TUNING so names live in one place. */
const stringItemElements = STANDARD_TUNING.map((string) => {
  const item = document.createElement("li");
  item.textContent = string.name;
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
 * Draws the headstock into the given SVG: the body, the nut, and for each entry
 * of STANDARD_TUNING a string and a tuning peg. The low strings are on the left
 * (bottom to top) and the high strings on the right (top to bottom), so no
 * strings cross - the same as a real 3+3 headstock.
 *
 * @param {SVGElement} svg the (empty) SVG element to draw into
 * @returns {{stringLine: SVGElement, peg: SVGElement}[]} the animatable parts,
 *     in the same order as STANDARD_TUNING
 */
function buildHeadstock(svg) {
  const g = HEADSTOCK_GEOMETRY;
  const stringCount = STANDARD_TUNING.length;
  const nutRightX = g.nutLeftX + (stringCount - 1) * g.stringSpacing;
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

  return STANDARD_TUNING.map((tuning, index) => {
    const isLeftSide = index < PEGS_PER_SIDE;
    const rowFromBottom = isLeftSide ? index : stringCount - 1 - index;
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
    // Arrow arc drawn clockwise; style.css mirrors it for counterclockwise turns.
    const arrow = createSvgElement("g", {}, "peg-arrow");
    arrow.appendChild(createSvgElement("path", { d: "M 0 -22 A 22 22 0 1 1 -22 0" }, "peg-arrow-line"));
    arrow.appendChild(createSvgElement("polygon", { points: "-22,-7 -28,1 -16,1" }, "peg-arrow-head"));
    peg.appendChild(arrow);
    peg.appendChild(createSvgElement("circle", { r: g.knobRadius }, "peg-knob"));
    // The small tab on the knob rim is what visibly turns.
    peg.appendChild(
      createSvgElement("rect", { x: -2, y: -g.knobRadius, width: 4, height: 6, rx: 1 }, "peg-tab"),
    );
    const label = createSvgElement("text", { x: 0, y: 3.5 }, "peg-label");
    label.textContent = tuning.name;
    peg.appendChild(label);
    svg.appendChild(peg);

    return { stringLine, peg };
  });
}

/** Animatable headstock parts, one entry per string, in STANDARD_TUNING order. */
const headstockParts = buildHeadstock(headstockElement);

/** CSS classes that renderReading may put on headstock parts; all are cleared on every update. */
const HEADSTOCK_STATE_CLASSES = ["active", "vibrating", "in-tune", "turn-clockwise", "turn-counterclockwise"];

/**
 * Tells which way a string's peg must be turned to move the pitch in the wanted
 * direction. On a 3+3 headstock the pegs on the two sides are mirror images:
 * left-side pegs tighten counterclockwise, right-side pegs clockwise.
 *
 * @param {number} stringIndex index of the string in STANDARD_TUNING
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
    statusElement.textContent = "Play a string...";
    return;
  }

  const { string, index, cents } = findClosestString(frequencyHz);
  const isInTune = Math.abs(cents) <= IN_TUNE_THRESHOLD_CENTS;
  // Clamp so the needle never leaves the meter for wildly off pitches.
  const clampedCents = Math.max(-METER_RANGE_CENTS, Math.min(METER_RANGE_CENTS, cents));

  noteNameElement.textContent = string.name;
  frequencyElement.textContent = `${frequencyHz.toFixed(1)} Hz`;
  needleElement.style.left = `${50 + (clampedCents / METER_RANGE_CENTS) * 50}%`;
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
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  audioContext.createMediaStreamSource(microphoneStream).connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  // Last successful detection, kept so the reading can linger after the sound stops.
  let lastDetection = null;
  const analyseFrame = () => {
    analyser.getFloatTimeDomainData(samples);
    const frequencyHz = detectPitchTwoStageHz(samples, audioContext.sampleRate);
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
  renderReading(-1);
  statusElement.textContent = "Press Start and play a string.";
  toggleButton.textContent = "Start";
}

toggleButton.addEventListener("click", () => {
  if (audioContext === null) startTuner();
  else stopTuner();
});
