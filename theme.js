/**
 * Theme (dark mode) and browser-storage helpers.
 *
 * Loaded in the page's <head>, before anything is drawn, so a remembered dark
 * mode choice is applied immediately; if this ran at the end of the page like
 * tuner.js, dark mode users would see the wooden background flash up first on
 * every visit. tuner.js (loaded afterwards) uses these functions too.
 */

/** Browser-storage key under which the dark mode choice is remembered. */
const DARK_MODE_STORAGE_KEY = "guitar-tuner.dark-mode";

/**
 * Reads a remembered value from the browser's storage. Storage can be blocked
 * (e.g. private browsing), in which case nothing is remembered.
 *
 * @param {string} key the storage key
 * @returns {string|null} the stored value, or null if there is none or storage is blocked
 */
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

/**
 * Remembers a value in the browser's storage; silently does nothing if storage
 * is blocked, since the tuner works fine without it.
 *
 * @param {string} key the storage key
 * @param {string} value the value to remember
 */
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Ignored on purpose: not remembering a choice is harmless.
  }
}

/**
 * Tells whether dark mode is currently on.
 *
 * @returns {boolean} true if the page is in dark mode
 */
function isDarkMode() {
  return document.documentElement.getAttribute("data-theme") === "dark";
}

/**
 * Turns dark mode on or off. The look itself lives in style.css, under the
 * {@code :root[data-theme="dark"]} selector; this only sets the attribute it keys on.
 *
 * @param {boolean} enabled true for the near-black dark theme, false for the wood
 */
function setDarkMode(enabled) {
  if (enabled) document.documentElement.setAttribute("data-theme", "dark");
  else document.documentElement.removeAttribute("data-theme");
}

setDarkMode(readStorage(DARK_MODE_STORAGE_KEY) === "true");
