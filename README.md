# Guitar Tuner

A guitar tuner (standard tuning, Drop D and more) that listens to your microphone and shows how far the nearest string is from being in tune.

**It runs entirely in the browser.** There is no server, no backend, no database and no API keys, just HTML, CSS and JavaScript. This is why it can be hosted on GitHub Pages, which only serves static files and cannot run a backend. Your microphone audio never leaves your device.

## How to use

1. Open the page:
   - **Hosted:** open the GitHub Pages URL of the project.
   - **Locally:** the microphone only works on `https://` pages or on `localhost`, so opening `index.html` by double-click may be blocked. Instead, run `python3 -m http.server` in this folder and open `http://localhost:8000`.
2. Pick your **tuning** in the dropdown next to the Start button (Standard, Drop D, Half step down, DADGAD or Open G). The string names and peg labels change to match, and your choice is remembered for next time.
3. Press **Start** and allow microphone access when the browser asks.
4. Pluck **one open string at a time** and let it ring.
5. Read the display:
   - **Big note name**: the string closest to the pitch you played (E2, A2, D3, G3, B3 or E4).
   - **Frequency**: the detected pitch in Hz.
   - **Needle**: left of the centre mark means flat, right means sharp.
   - **Status line**: tells you whether to tighten or loosen the string and by how many cents.
   - **Headstock drawing**: the string you played is highlighted and vibrates while it sounds (orange when off, green when in tune). Its tuning peg shows a curved arrow and a turning knob in the direction to turn it, and a text hint says e.g. "Tighten: turn the E2 peg counterclockwise". This assumes a standard 3+3 headstock: left-side pegs tighten counterclockwise, right-side pegs clockwise.
   - **String list**: the closest string is highlighted. **Tap a string name** (or its peg on the headstock) to *lock* the tuner to it: the display then measures against that string only, and a line under the list says "Locked to A2 · tap it again for auto mode". Tap it again to go back to automatic. Locking helps when a string is so far off that the tuner mistakes it for its neighbour. If you play something more than 300 cents from the locked string, it says "Not near A2". Changing the tuning clears the lock.
   - The last reading stays on screen for half a second after the sound stops, so you have time to read it.
6. Adjust the tuning peg until the needle sits in the centre, turns green and the status says **In tune!** (within ±5 cents).
7. Press **Stop** when finished. This releases the microphone so the browser's recording indicator turns off.

### Settings and keyboard shortcuts

- **Settings (gear button, top right):** *Dark mode* swaps the wood for a plain near-black background (less glare at night or on a dark stage); it is remembered. *High accuracy mode* analyses a longer slice of sound (about 170 ms instead of 85 ms). It is more precise, especially for the low strings, but uses about 4x more processing power and battery, reacts a little slower and may stutter on older phones, so a warning is shown in the dialog. The setting is remembered, and takes effect immediately, even while listening.
- **Keyboard:** press **E**, **A**, **D**, **G** or **B** to lock the string with that note. Press the same key again for the next string with the same note (in standard tuning, **E** locks the low E, then the high E, then goes back to automatic mode). Other tunings follow the same rule (in Drop D, **D** cycles D2 then D3). It works with any keyboard language: Latin layouts use the printed letter, and other scripts such as Hebrew use the key's position, so the key that is E on a US keyboard counts as E. Shortcuts are ignored while the settings dialog is open, when a modifier key (Ctrl, Cmd, Alt) is held, and while a dropdown has focus.
- **Feedback:** the settings dialog has a link to this project's GitHub Issues page, for bug reports and suggestions (a free GitHub account is needed to post).

### Available tunings

| Tuning | Strings (lowest to highest) |
| ------ | --------------------------- |
| Standard | E2 A2 D3 G3 B3 E4 |
| Drop D | D2 A2 D3 G3 B3 E4 |
| Half step down | Eb2 Ab2 Db3 Gb3 Bb3 Eb4 |
| DADGAD | D2 A2 D3 G3 A3 D4 |
| Open G | D2 G2 D3 G3 B3 D4 |

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
| `style.css` | Wooden guitar-body theme, layout and the string/peg animations. Colours are CSS variables defined once at the top. The wood grain is an inline SVG noise filter inside the CSS (no image files). |
| `theme.js` | Dark mode and the browser-storage helpers. It is loaded in the page's `<head>` so a remembered dark mode is applied before anything is drawn (no flash of the wood). |
| `tuner.js` | All the logic: microphone capture, pitch detection, drawing the headstock and updating the display. |

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

### 4. Tunings and finding the nearest string
Tunings live in the `TUNINGS` table as plain note names (e.g. `"Eb2"`). `noteToFrequencyHz` computes each frequency from the name (equal temperament, A4 = 440 Hz), so no frequency is typed twice. `applyTuning` switches the tuner to a tuning: it updates the string list, the peg labels and the dropdown, and the choice is saved in `localStorage` (with a safe fallback if the browser blocks it).

`findClosestString` then compares the detected frequency with each string of the current tuning using **cents**, a logarithmic unit (100 cents = one semitone): `cents = 1200 * log2(detected / target)`. This matches how we hear pitch. The string with the smallest absolute cents distance wins, and the sign tells flat (negative) or sharp (positive).

### The string lock (`toggleStringLock`)
`lockedStringIndex` is `null` for automatic mode. `findTargetString` returns either the closest string (`findClosestString`) or the locked one, and both use the same `centsFromString` formula. Taps on the list items and the pegs (which have an invisible, larger hit area for fingers) call `toggleStringLock`; the list items also work from the keyboard (Enter or Space).

### Keyboard and accuracy setting
`noteLetterFromKeyEvent` turns a key press into a note letter (the printed letter if it is A-G, otherwise the physical key position from `event.code`), and `nextLockIndexForLetter` decides which string to lock, cycling through strings that share the letter. `setHighAccuracy` switches between `STANDARD_WINDOW_SIZE` and `HIGH_ACCURACY_WINDOW_SIZE`; the analyser and its sample buffer are kept in module state, so the window can be resized while listening.

### 5. Updating the display (`renderReading`)
Sets the note name, frequency, status text and highlighted string, and moves the needle. The needle position is clamped to ±50 cents so it never leaves the meter. With no pitch detected, the display resets.

### 6. The headstock animation (`buildHeadstock`)
The guitar headstock is an SVG that `tuner.js` draws at load time from `STRING_COUNT` and `HEADSTOCK_GEOMETRY`, so positions are defined once. The peg labels are filled in by `applyTuning` for the selected tuning. Low strings go to the left pegs and high strings to the right pegs, so the strings do not cross. `renderReading` only adds or removes CSS classes (`active`, `vibrating`, `in-tune`, `turn-clockwise`, `turn-counterclockwise`); `style.css` does the actual animation. `isTurnClockwise` decides the turn direction from the side of the headstock and from whether the pitch is too low or too high.

### 7. Keeping the reading on screen
When the pitch disappears, the main loop keeps re-rendering the last detected reading (without the vibration) until `HOLD_DURATION_MS` has passed, and only then resets the display.

## Configuration

Every tunable value is defined once, at the top of `tuner.js`:

| Constant | Meaning |
| -------- | ------- |
| `TUNINGS` | The selectable tunings, as note names from the lowest to the highest string. To add a tuning, add an entry (all notes must be between the detectable limits below). |
| `DEFAULT_TUNING_ID` | The tuning used on the first visit. |
| `MIN_DETECTABLE_FREQUENCY_HZ` / `MAX_DETECTABLE_FREQUENCY_HZ` | Frequency range searched. |
| `STANDARD_WINDOW_SIZE` | Number of samples analysed per frame by default (4096). A larger window makes the low strings more accurate but reacts slower and uses more CPU. |
| `HIGH_ACCURACY_WINDOW_SIZE` | The longer window (8192) used when high accuracy mode is on. |
| `MIN_SIGNAL_RMS` | Level below which input is treated as silence. |
| `PEAK_PREFERENCE_RATIO` | How strong a shorter peak must be to be preferred (octave-error protection). |
| `IN_TUNE_THRESHOLD_CENTS` | Accuracy needed to count as "in tune". |
| `METER_RANGE_CENTS` | Cents at the far edge of the meter. |
| `LOCKED_MAX_CENTS_OFF` | With a string locked, pitches further away than this (300 cents) show "Not near ...". |
| `HOLD_DURATION_MS` | How long the last reading stays after the sound stops. |
| `HEADSTOCK_GEOMETRY` | Positions and sizes of the headstock drawing. |

Colours can be changed in the `:root` block of `style.css`.

## Limitations and troubleshooting

- Only the tunings in the `TUNINGS` table are available, and their notes must lie within the detection range (70 to 400 Hz). Very low tunings such as Drop C need `MIN_DETECTABLE_FREQUENCY_HZ` lowered first.
- The 4096-sample listening window favours speed over low-note precision: a perfectly tuned low E can read up to about 6 cents flat. Trust the other strings' readings more, or turn on **High accuracy mode** in the settings (gear button), which brings the worst error down to about 2 cents at the cost of more CPU and a slightly slower reaction.
- Play one string at a time in a fairly quiet room. Background noise or ringing neighbouring strings can confuse the detection.
- **"Microphone unavailable. Allow access and use HTTPS or localhost."**: allow microphone permission for the site, and make sure the page is served over HTTPS or from `localhost`.
- The needle stays at the centre showing `--`: no clear pitch was found. Play the string louder or closer to the microphone.
