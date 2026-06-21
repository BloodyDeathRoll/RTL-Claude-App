// Claude RTL Fix - main-process hook.
// Loaded before Claude's own entry by rtl-fix-entry.js.
// On every page load / navigation it injects two renderer scripts into isolated
// world 999 (executeJavaScriptInIsolatedWorld — shares the page DOM, stays out
// of Claude's own JS world; no preload):
//   - rtl-fix-read.js    : content-driven READ-direction engine for responses
//                          (sets explicit dir + injects its own scoped CSS).
//   - rtl-fix-payload.js  : the EN/HE composer toggle (input direction).
// Both self-guard against the repeated did-navigate re-injections.
'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_DIR  = path.join(os.tmpdir(), 'claude-rtl-fix');
const LOG_FILE = path.join(LOG_DIR, 'debug.log');

function dbg(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' [hook] ' + msg + '\n');
  } catch (_) {}
}

dbg('hook loaded');

// Renderer scripts injected into isolated world 999. Read once at startup from
// the asar root next to us. Read failure is non-fatal and logged — a missing
// read engine still leaves the composer toggle working, and vice versa.
//
// rtl-fix-read.js supersedes the old approach of a static insertCSS
// (unicode-bidi:plaintext) + a dir="auto" list fix: that was first-strong-char
// detection, which mis-judges Hebrew blocks opening with a Latin token. The
// engine decides direction by content and injects its own scoped stylesheet.
function readPayload(name) {
  try {
    return fs.readFileSync(path.join(__dirname, name), 'utf8');
  } catch (e) {
    dbg(name + ' read FAIL: ' + e.message);
    return '';
  }
}

const READ_JS = readPayload('rtl-fix-read.js');     // read-direction engine
const INPUT_DIR_JS = readPayload('rtl-fix-payload.js'); // composer EN/HE toggle

function runIsolated(wc, label, code) {
  if (!code) return;
  try {
    wc.executeJavaScriptInIsolatedWorld(999, [{ code }]).then(
      ()  => dbg(label + ' OK id=' + wc.id),
      (e) => dbg(label + ' FAIL id=' + wc.id + ': ' + e.message)
    );
  } catch (e) {
    dbg(label + ' THROW id=' + wc.id + ': ' + e.message);
  }
}

function inject(wc) {
  if (!wc || wc.isDestroyed()) return;
  // Read engine first so its mode-change listeners are ready before the
  // composer toggle (which can dispatch a mode-change on init) runs.
  runIsolated(wc, 'readJS', READ_JS);
  runIsolated(wc, 'inputDirJS', INPUT_DIR_JS);
}

app.on('web-contents-created', (_event, wc) => {
  dbg('web-contents-created id=' + wc.id);
  wc.on('did-finish-load', () => {
    dbg('did-finish-load id=' + wc.id);
    inject(wc);
  });
  wc.on('did-navigate', () => inject(wc));
});
