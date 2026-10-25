# Guitar Tuner

A guitar tuner for standard tuning that listens to your microphone and shows how far the nearest string is from being in tune.

**It runs entirely in the browser.** There is no server, no backend, no database and no API keys, just HTML, CSS and JavaScript. This is why it can be hosted on GitHub Pages, which only serves static files and cannot run a backend. Your microphone audio never leaves your device.

## How to use

1. Open the page:
   - **Hosted:** open the GitHub Pages URL of the project.
   - **Locally:** the microphone only works on `https://` pages or on `localhost`, so opening `index.html` by double-click may be blocked. Instead, run `python3 -m http.server` in this folder and open `http://localhost:8000`.
2. Press **Start** and allow microphone access when the browser asks.
3. Pluck **one open string at a time** and let it ring.
4. Read the display:
   - **Big note name**: the string closest to the pitch you played (E2, A2, D3, G3, B3 or E4).
   - **Frequency**: the detected pitch in Hz.
   - **Needle**: left of the centre mark means flat, right means sharp.
   - **Status line**: tells you whether to tighten or loosen the string and by how many cents.
   - **String list**: the closest string is highlighted.
5. Adjust the tuning peg until the needle sits in the centre, turns green and the status says **In tune!** (within ±5 cents).
6. Press **Stop** when finished. This releases the microphone so the browser's recording indicator turns off.

### Standard tuning targets

| String | Note | Frequency (Hz) |
| ------ | ---- | -------------- |
| 6 (lowest) | E2 | 82.41 |
| 5 | A2 | 110.00 |
| 4 | D3 | 146.83 |
| 3 | G3 | 196.00 |
| 2 | B3 | 246.94 |
| 1 (highest) | E4 | 329.63 |

## Files

| File | Purpose |
| ---- | ------- |
| `index.html` | Page structure: note readout, tuning meter, string list and the Start/Stop button. |
| `style.css` | Dark theme and layout. Colours are CSS variables defined once at the top. |
| `tuner.js` | All the logic: microphone capture, pitch detection and updating the display. |

## How the code works

### 1. Capturing audio
`startTuner()` asks for the microphone with `navigator.mediaDevices.getUserMedia`. Echo cancellation, noise suppression and automatic gain are turned **off**, because they are designed for speech and distort sustained musical notes. The stream goes into a Web Audio `AnalyserNode`, and on every animation frame (`requestAnimationFrame`) the latest 4096 samples are read from it.

### 2. Detecting the pitch (`detectPitchHz`)
The pitch is found with **autocorrelation**: the signal is compared with a delayed copy of itself, and the delay (lag) at which they line up best is the length of one period of the note. Frequency is then `sampleRate / lag`.

- If the signal is too quiet (RMS below `MIN_SIGNAL_RMS`) it returns `-1`, meaning "no note".
- Only lags corresponding to 70 to 400 Hz are searched, which covers all six strings with some slack.
- It chooses the **first strong peak** (at least 90% of the best one) rather than the absolute best. A multiple of the true period can correlate slightly better, which would make the tuner report a note an octave too low ("octave error").

### 3. Sub-sample precision (`refinePeakLag`)
Lags are whole numbers of samples, which is too coarse for higher notes. A parabola is fitted through the peak and its two neighbours, and its top gives a fractional lag and so a more accurate frequency.

### 4. Finding the nearest string (`findClosestString`)
The detected frequency is compared with each string in `STANDARD_TUNING` using **cents**, a logarithmic unit (100 cents = one semitone): `cents = 1200 * log2(detected / target)`. This matches how we hear pitch. The string with the smallest absolute cents distance wins, and the sign tells flat (negative) or sharp (positive).

### 5. Updating the display (`renderReading`)
Sets the note name, frequency, status text and highlighted string, and moves the needle. The needle position is clamped to ±50 cents so it never leaves the meter. With no pitch detected, the display resets.

## Configuration

Every tunable value is defined once, at the top of `tuner.js`:

| Constant | Meaning |
| -------- | ------- |
| `STANDARD_TUNING` | Names and target frequencies of the strings. The string list on the page is built from it. |
| `MIN_DETECTABLE_FREQUENCY_HZ` / `MAX_DETECTABLE_FREQUENCY_HZ` | Frequency range searched. |
| `FFT_SIZE` | Number of samples analysed per frame. |
| `MIN_SIGNAL_RMS` | Level below which input is treated as silence. |
| `PEAK_PREFERENCE_RATIO` | How strong a shorter peak must be to be preferred (octave-error protection). |
| `IN_TUNE_THRESHOLD_CENTS` | Accuracy needed to count as "in tune". |
| `METER_RANGE_CENTS` | Cents at the far edge of the meter. |

Colours can be changed in the `:root` block of `style.css`.

## Limitations and troubleshooting

- Only **standard tuning** is supported. Other tunings would need a different `STANDARD_TUNING` table and detection range.
- Play one string at a time in a fairly quiet room. Background noise or ringing neighbouring strings can confuse the detection.
- **"Microphone unavailable. Allow access and use HTTPS or localhost."**: allow microphone permission for the site, and make sure the page is served over HTTPS or from `localhost`.
- The needle stays at the centre showing `--`: no clear pitch was found. Play the string louder or closer to the microphone.
