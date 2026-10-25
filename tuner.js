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
 * Size of the analysis window in samples. Must hold several periods of the
 * lowest note: 4096 samples is ~85 ms at 48 kHz, about 7 periods of 82 Hz.
 */
const FFT_SIZE = 4096;

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

/** One list item per string, built from STANDARD_TUNING so names live in one place. */
const stringItemElements = STANDARD_TUNING.map((string) => {
  const item = document.createElement("li");
  item.textContent = string.name;
  stringListElement.appendChild(item);
  return item;
});

/** Audio objects while listening; null when stopped. */
let audioContext = null;
let microphoneStream = null;
let animationFrameId = null;

/**
 * Updates the display for a detected pitch, or resets it when none was found.
 *
 * @param {number} frequencyHz detected frequency, or -1 if none
 */
function renderReading(frequencyHz) {
  stringItemElements.forEach((item) => item.classList.remove("active"));

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
  const analyseFrame = () => {
    analyser.getFloatTimeDomainData(samples);
    renderReading(detectPitchHz(samples, audioContext.sampleRate));
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
