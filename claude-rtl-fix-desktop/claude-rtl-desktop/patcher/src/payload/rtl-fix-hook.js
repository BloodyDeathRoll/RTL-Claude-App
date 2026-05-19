// Claude RTL Fix - main-process hook.
// Loaded before Claude's own entry by rtl-fix-entry.js.
// Injects RTL CSS via webContents.insertCSS() on every page load.
// No preload injection, no JS execution in renderer — CSS only.
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

// unicode-bidi:plaintext is the CSS equivalent of dir="auto": the browser
// picks LTR or RTL per-element based on the first strong character.
// For code blocks we force LTR with bidi-override.
// ol/ul intentionally excluded: dir="auto" is set via JS below, and
// unicode-bidi:plaintext would conflict with the HTML dir attribute.
const RTL_CSS =
  'p,li,blockquote,h1,h2,h3,h4,h5,h6,td,th,' +
  '[class*="prose"]>*,[data-message-author-role]' +
  '{unicode-bidi:plaintext!important}' +
  'pre,code,kbd,samp,var' +
  '{direction:ltr!important;unicode-bidi:bidi-override!important}';

// Sets dir="auto" on list containers (existing and future) so markers
// follow content direction. Runs in isolated world 999 — shares the DOM
// but doesn't touch Claude's JS world.
const LIST_FIX_JS = [
  '(function(){',
  '  function fix(el){',
  '    if(!el.hasAttribute("dir")) el.setAttribute("dir","auto");',
  '  }',
  '  document.querySelectorAll("ol,ul").forEach(fix);',
  '  new MutationObserver(function(ms){',
  '    ms.forEach(function(m){',
  '      m.addedNodes.forEach(function(n){',
  '        if(n.nodeType!==1) return;',
  '        if(n.matches("ol,ul")) fix(n);',
  '        n.querySelectorAll&&n.querySelectorAll("ol,ul").forEach(fix);',
  '      });',
  '    });',
  '  }).observe(document.documentElement,{childList:true,subtree:true});',
  '})();',
].join('');

function inject(wc) {
  if (!wc || wc.isDestroyed()) return;
  Promise.resolve(wc.insertCSS(RTL_CSS)).then(
    ()  => dbg('insertCSS OK id=' + wc.id),
    (e) => dbg('insertCSS FAIL id=' + wc.id + ': ' + e.message)
  );
  try {
    wc.executeJavaScriptInIsolatedWorld(999, [{ code: LIST_FIX_JS }])
      .then(
        ()  => dbg('isolatedJS OK id=' + wc.id),
        (e) => dbg('isolatedJS FAIL id=' + wc.id + ': ' + e.message)
      );
  } catch (e) {
    dbg('isolatedJS THROW id=' + wc.id + ': ' + e.message);
  }
}

app.on('web-contents-created', (_event, wc) => {
  dbg('web-contents-created id=' + wc.id);
  wc.on('did-finish-load', () => {
    dbg('did-finish-load id=' + wc.id);
    inject(wc);
  });
  wc.on('did-navigate', () => inject(wc));
});
