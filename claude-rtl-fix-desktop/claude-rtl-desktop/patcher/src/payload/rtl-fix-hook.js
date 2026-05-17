// Claude RTL Fix - main-process hook.
// Loaded BEFORE Claude's own entry by rtl-fix-entry.js.
// Patches BrowserWindow + listens for new webContents and injects the payload
// on every load / navigation. Uses executeJavaScript so we don't fight the
// preload-script slot (Claude may already be using it).

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let payloadSource = '';
try {
  payloadSource = fs.readFileSync(
    path.join(__dirname, 'rtl-fix-payload.js'),
    'utf8'
  );
} catch (e) {
  console.error('[claude-rtl-fix] failed to load payload:', e);
  return;
}

function inject(wc) {
  if (!wc || wc.isDestroyed()) return;
  wc.executeJavaScript(payloadSource, true).catch(() => {});
}

app.on('web-contents-created', (_event, wc) => {
  wc.on('did-finish-load', () => inject(wc));
  wc.on('did-navigate', () => inject(wc));
  wc.on('did-navigate-in-page', () => inject(wc));
  wc.on('did-frame-finish-load', () => inject(wc));
});
