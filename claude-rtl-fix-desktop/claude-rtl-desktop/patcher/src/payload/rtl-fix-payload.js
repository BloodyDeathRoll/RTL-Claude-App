// rtl-fix-payload.js — renderer-side input-direction toggle.
//
// Ported from the Claude RTL Fix browser extension (v1.6.0), specifically the
// INPUT_DIR_* constants and the injectInputDirStyles / createInputDirButton /
// updateInputDirButton / injectInputDirButton / applyInputDir functions in
// shared/content.js. Two deltas for the desktop build:
//   1. localStorage instead of chrome.storage (no extension APIs in the app).
//   2. The <style> is injected by this script (which the patch injects) rather
//      than by a content script.
//
// rtl-fix-hook.js runs this in isolated world 999 (executeJavaScriptInIsolated-
// World) on every load/navigation — it shares the page DOM and per-origin
// localStorage but stays out of Claude's own JS world. It is guarded so the
// repeated did-navigate injections don't double-initialize within one document.
//
// Behavior: a two-segment EN | HE switch in the composer toggles the message
// editor's writing direction. HE sets direction:rtl + text-align:right on the
// ProseMirror editor; EN is the default LTR. Two explicit states only — no
// dir="auto" auto-detection, which would flip mid-sentence as you type.
(function () {
  'use strict';

  // Top-frame only, and don't re-initialize when the hook re-injects us on a
  // later did-navigate within the same document.
  if (window !== window.top) return;
  if (window.__claudeRtlInputDirInit) return;
  window.__claudeRtlInputDirInit = true;

  // localStorage value: 'en' | 'he'. Persisted across launches and synced
  // between renderer windows via the 'storage' event below.
  var INPUT_DIR_STORAGE_KEY = 'claude-rtl-fix-input-dir';
  // Attribute set on <html>; the injected CSS keys off the "he" value.
  var INPUT_DIR_ATTR = 'data-claude-input-dir';
  var INPUT_DIR_STYLE_ID = 'claude-rtl-fix-input-dir-styles';
  var INPUT_DIR_BTN_ID = 'claude-rtl-fix-input-dir-btn';
  var INPUT_DIR_SEG_ATTR = 'data-claude-input-dir-seg';

  // Single source of truth for the composer editor. Used both by the CSS rule
  // and as the presence anchor for injection. The new-chat landing composer and
  // the in-thread composer are the same ProseMirror component, so one entry
  // covers both. NOTE (open item): verify this still matches in the desktop
  // renderer (landing + thread) via DevTools; adjust here if the markup differs.
  var COMPOSER_SELECTOR = 'div.ProseMirror[contenteditable="true"]';

  // The bottom-left composer "+" button we anchor the switch after. NOTE (open
  // item): confirm the desktop "+" still matches one of these; if the switch
  // lands in the wrong spot, update only this list.
  var ADD_BUTTON_SELECTOR =
    'button[aria-label*="add" i],' +
    'button[aria-label*="attach" i],' +
    'button[aria-label*="upload" i],' +
    'button[data-testid*="input-menu" i]';

  // Master on/off. The desktop patch has no runtime toggle — "off" is the
  // unpatched app, where this file isn't loaded at all. We still expose the
  // enable/disable plumbing (and a window hook) so a future master switch can
  // remove the UI/CSS/attribute without reloading. See setInputDirEnabled.
  var enabled = true;

  function getInputDir() {
    try {
      return localStorage.getItem(INPUT_DIR_STORAGE_KEY) === 'he' ? 'he' : 'en';
    } catch (_) {
      return 'en';
    }
  }

  // --- direction mechanism -------------------------------------------------
  //
  // Drive direction off a <html data-claude-input-dir="he"> attribute + a CSS
  // rule, NOT inline styles: the composer is a framework-managed (ProseMirror)
  // contenteditable that strips inline styles on re-render.

  function injectInputDirStyles() {
    if (document.getElementById(INPUT_DIR_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = INPUT_DIR_STYLE_ID;
    // Apply to the editor AND its descendants (`… *`): child blocks (<p> etc.)
    // can carry their own Tailwind text-align. Both `direction: rtl` AND
    // `text-align: right` are required — Tailwind hard-codes a physical
    // text-align:left, so direction alone reorders glyphs but leaves the text
    // pinned to the left.
    style.textContent =
      'html[' + INPUT_DIR_ATTR + '="he"] :is(' + COMPOSER_SELECTOR + '),' +
      'html[' + INPUT_DIR_ATTR + '="he"] :is(' + COMPOSER_SELECTOR + ') *{' +
      'direction:rtl!important;text-align:right!important;}';
    (document.head || document.documentElement).appendChild(style);
  }

  function removeInputDirStyles() {
    var style = document.getElementById(INPUT_DIR_STYLE_ID);
    if (style) style.remove();
  }

  function applyInputDir(dir) {
    var html = document.documentElement;
    if (!html) return;
    if (!enabled) {
      html.removeAttribute(INPUT_DIR_ATTR);
      return;
    }
    html.setAttribute(INPUT_DIR_ATTR, dir === 'he' ? 'he' : 'en');
  }

  function setInputDir(dir) {
    var v = dir === 'he' ? 'he' : 'en';
    try { localStorage.setItem(INPUT_DIR_STORAGE_KEY, v); } catch (_) {}
    applyInputDir(v);
    var btn = document.getElementById(INPUT_DIR_BTN_ID);
    if (btn) updateInputDirButton(btn, v);
  }

  // --- the EN | HE switch --------------------------------------------------

  function createInputDirButton() {
    var container = document.createElement('div');
    container.id = INPUT_DIR_BTN_ID;
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Input text direction');
    // Rounded pill with a subtle currentColor border. color:inherit +
    // currentColor make it adopt the app theme automatically.
    container.style.cssText = [
      'display:inline-flex',
      'align-items:stretch',
      'box-sizing:border-box',
      'border:1px solid color-mix(in srgb, currentColor 25%, transparent)',
      'border-radius:9999px',
      'overflow:hidden',
      'font-size:11px',
      'font-weight:600',
      'line-height:1',
      'color:inherit',
      'margin-left:10px',
      'cursor:pointer',
      'user-select:none',
      'vertical-align:middle',
    ].join(';');

    [['en', 'EN'], ['he', 'HE']].forEach(function (pair) {
      var seg = document.createElement('span');
      seg.setAttribute(INPUT_DIR_SEG_ATTR, pair[0]);
      seg.setAttribute('role', 'button');
      seg.textContent = pair[1];
      seg.style.cssText = [
        'display:inline-flex',
        'align-items:center',
        'padding:3px 8px',
        'background:transparent',
        'transition:opacity .15s ease, background .15s ease',
      ].join(';');
      // Don't steal focus from the composer when clicking the switch.
      seg.addEventListener('mousedown', function (e) { e.preventDefault(); });
      // Clicking a segment switches directly to that direction (no cycling).
      seg.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setInputDir(pair[0]);
      });
      container.appendChild(seg);
    });

    return container;
  }

  // The active segment is contrasted (full opacity + a filled highlight); the
  // inactive one is faded but stays clickable.
  function updateInputDirButton(container, dir) {
    var segs = container.querySelectorAll('[' + INPUT_DIR_SEG_ATTR + ']');
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var active = seg.getAttribute(INPUT_DIR_SEG_ATTR) === dir;
      seg.style.opacity = active ? '1' : '0.45';
      seg.style.background = active
        ? 'color-mix(in srgb, currentColor 18%, transparent)'
        : 'transparent';
    }
  }

  // Vertical alignment: the "+" lives in a control sub-group whose alignment we
  // don't control, so flex/vertical-align centering can't be trusted. Measure
  // the "+" button's vertical center and nudge the switch with translateY to
  // match exactly. transform doesn't affect layout flow, so this can't shift
  // anything else. Recompute on every (re)injection.
  function alignInputDirButton(btn) {
    var ref = document.querySelector(ADD_BUTTON_SELECTOR);
    if (!ref) return; // nothing to align to (used a fallback anchor)
    btn.style.transform = 'none'; // reset before measuring
    var r = ref.getBoundingClientRect();
    var b = btn.getBoundingClientRect();
    if (!r.height || !b.height) return;
    var delta = (r.top + r.height / 2) - (b.top + b.height / 2);
    btn.style.transform = 'translateY(' + delta + 'px)';
  }

  function injectInputDirButton() {
    if (!enabled) return;
    // Only inject where there's a composer (covers landing + thread).
    var composer = document.querySelector(COMPOSER_SELECTOR);
    if (!composer) return;

    var btn = document.getElementById(INPUT_DIR_BTN_ID);
    if (btn && btn.isConnected) {
      // Already placed; keep its vertical alignment fresh (layout may shift).
      alignInputDirButton(btn);
      return;
    }

    btn = createInputDirButton();
    updateInputDirButton(btn, getInputDir());

    // Placement: immediately after the "+" button; fall back to the send-button
    // row, then the editor's parent.
    var addBtn = document.querySelector(ADD_BUTTON_SELECTOR);
    if (addBtn && addBtn.parentNode) {
      addBtn.parentNode.insertBefore(btn, addBtn.nextSibling);
    } else {
      var sendBtn = document.querySelector('button[aria-label*="send" i]');
      if (sendBtn && sendBtn.parentNode) {
        sendBtn.parentNode.insertBefore(btn, sendBtn);
      } else if (composer.parentNode) {
        composer.parentNode.insertBefore(btn, composer.nextSibling);
      } else {
        return;
      }
    }

    alignInputDirButton(btn);
  }

  function removeInputDirButton() {
    var btn = document.getElementById(INPUT_DIR_BTN_ID);
    if (btn) btn.remove();
  }

  // The composer (and its control row) is torn down and swapped when navigating
  // between the landing page and a thread, so re-inject on DOM mutations.
  // rAF-coalesced so streaming bursts don't thrash.
  var injectScheduled = false;
  function scheduleInject() {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(function () {
      injectScheduled = false;
      injectInputDirButton();
    });
  }

  var observer = new MutationObserver(scheduleInject);

  // Future master on/off: flip everything without a reload. Exposed on window
  // so the main-process hook could drive it if a runtime toggle is ever added.
  function setInputDirEnabled(value) {
    enabled = !!value;
    if (enabled) {
      injectInputDirStyles();
      applyInputDir(getInputDir());
      injectInputDirButton();
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      observer.disconnect();
      removeInputDirButton();
      removeInputDirStyles();
      applyInputDir('en'); // clears the attribute while disabled
    }
  }
  window.__claudeRtlSetInputDirEnabled = setInputDirEnabled;

  // Keep multiple renderer windows in sync — the localStorage analogue of the
  // browser build's chrome.storage.onChanged reactivity.
  window.addEventListener('storage', function (e) {
    if (e.key !== INPUT_DIR_STORAGE_KEY) return;
    var dir = e.newValue === 'he' ? 'he' : 'en';
    applyInputDir(dir);
    var btn = document.getElementById(INPUT_DIR_BTN_ID);
    if (btn) updateInputDirButton(btn, dir);
  });

  // The "+" can move as the toolbar reflows; realign on resize.
  window.addEventListener('resize', function () {
    var btn = document.getElementById(INPUT_DIR_BTN_ID);
    if (btn && btn.isConnected) alignInputDirButton(btn);
  });

  // Restore the saved direction and wire everything up.
  injectInputDirStyles();
  applyInputDir(getInputDir());
  injectInputDirButton();
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
