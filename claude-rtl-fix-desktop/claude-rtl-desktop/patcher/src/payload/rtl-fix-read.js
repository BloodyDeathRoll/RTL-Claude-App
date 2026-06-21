// rtl-fix-read.js — renderer-side READ-direction engine for Claude responses.
//
// Ported from the Claude RTL Fix browser extension. It decides text direction
// by CONTENT (resolveDir / codeDir), never by dir="auto" / first-strong-char —
// a Hebrew block that opens with a Latin token ("[Certain] ...", "**Excel** ...",
// a Hebrew sentence that starts with "Claude for Work") resolves LTR off its
// first letter even though it is Hebrew, so direction must come from a
// dominant-direction count, not the UA's first-strong heuristic.
//
// rtl-fix-hook.js runs this in isolated world 999 (executeJavaScriptInIsolated-
// World) on every load/navigation — it shares the page DOM and per-origin
// localStorage but stays out of Claude's own JS world. Guarded so the repeated
// did-navigate injections don't double-initialize within one document.
//
// The EN/HE toggle (rtl-fix-payload.js, persisted in localStorage) is the single
// source of truth for BOTH the composer and rendered responses:
//   - HE  -> force RTL on every message block unconditionally. Embedded English
//            runs still lay out LTR within the RTL line via the Unicode bidi algo.
//   - EN  -> per-block dominant-direction detection (majority strong RTL vs LTR).
// Flipping the toggle re-judges all on-screen content live.
(function () {
  'use strict';

  // Top-frame only, and don't re-initialize when the hook re-injects us on a
  // later did-navigate within the same document.
  if (window !== window.top) return;
  if (window.__claudeRtlReadInit) return;
  window.__claudeRtlReadInit = true;

  // Build stamp written to <html data-claude-rtl-build="..."> so the live code
  // version can be confirmed in DevTools. Track the app version; bump on change.
  var BUILD_STAMP = '0.1.9';

  // Shared with the composer toggle (rtl-fix-payload.js): 'en' | 'he'.
  var MODE_KEY = 'claude-rtl-fix-input-dir';
  var STYLE_ID = 'claude-rtl-fix-read-styles';
  // Marks every element this engine manages. Scopes our !important CSS so we
  // never clobber Claude's own UI chrome, and lets the master toggle revert
  // cleanly (remove dir only from elements we touched).
  var MARK_ATTR = 'data-rtl-fix';
  // The direction VALUE we resolved, on our OWN attribute. We drive all CSS off
  // this, NOT the standard `dir` attribute: Claude's markdown renderer controls
  // `dir` on its elements and reverts ours on its next React render (which left
  // blocks frozen at "auto", rendering by first-strong-character). React never
  // touches a data-* attribute it doesn't own, so this always survives.
  var RDIR_ATTR = 'data-rtl-dir';
  // Marks a list whose padding we mirrored left→right for RTL (see fixListPadding).
  var PAD_ATTR = 'data-rtl-pad';
  var STAMP_ATTR = 'data-claude-rtl-build';

  // Roots that hold rendered assistant/user message markdown. We only judge
  // direction INSIDE these — critical for HE mode, where "force RTL" would
  // otherwise flip the entire app UI (sidebar, menus, buttons) to RTL.
  // VERIFIED against the desktop DOM (2026-06-21): the desktop build does NOT
  // use the web build's `prose` / `font-claude-message` / `data-message-author-
  // role` markers. Assistant content is `.standard-markdown` (the markdown
  // container) wrapped in `.font-claude-response`; user content is under
  // `[data-testid="user-message"]`. `[class*="font-claude-response"]` matches
  // both the wrapper and the `font-claude-response-body` paragraphs.
  var MSG_ROOT_SEL =
    '[data-testid="user-message"],' +
    '.standard-markdown,' +
    '[class*="font-claude-response"]';

  // Text blocks whose direction we judge by content.
  var BLOCK_SEL =
    'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,summary';
  // Code-ish elements — exempt from the language mode (see codeDir).
  var CODE_SEL = 'pre,code,kbd,samp,var';
  // Containers whose own direction (and thus list-marker side / cell flow)
  // depends on overall content; re-queued on every relevant mutation.
  var CONTAINER_SEL = 'ol,ul,table,blockquote,dl';
  // Everything we ever re-judge, for bulk descendant queueing.
  var ALL_SEL = BLOCK_SEL + ',' + CONTAINER_SEL + ',' + CODE_SEL;

  // The composer is a ProseMirror contenteditable with its own input-direction
  // handling (rtl-fix-payload.js). Never let the read engine touch it.
  function isEditable(el) {
    return !!(el && el.closest &&
      el.closest('[contenteditable="true"],.ProseMirror'));
  }

  var enabled = true;

  // Diagnostics → app DevTools console. Off in release; flip to true to trace
  // detection/flush while debugging.
  var DEBUG = false;
  function diag(msg) {
    if (DEBUG) { try { console.log('[rtl-fix-read] ' + msg); } catch (_) {} }
  }

  // --- direction detection --------------------------------------------------
  //
  // Detect by regex over textContent ONLY — never getComputedStyle, which forces
  // a synchronous layout and trips Electron's slow-script warnings under the
  // continuous DOM churn of a streaming response.
  //
  // Strong RTL: Hebrew (U+0590-05FF), Arabic (U+0600-06FF, U+0750-077F,
  // U+08A0-08FF) and Hebrew/Arabic presentation forms (U+FB1D-FDFF, U+FE70-FEFF).
  // Strong LTR: Latin / Latin-ext / IPA (A-Z a-z, U+00C0-02AF), Greek
  // (U+0370-03FF) and Cyrillic (U+0400-04FF).
  var RTL_RE = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/g;
  var LTR_RE = /[A-Za-zÀ-ʯͰ-ϿЀ-ӿ]/g;

  function strongCounts(text) {
    if (!text) return { rtl: 0, ltr: 0 };
    // Cap the scan: a few thousand chars is plenty to establish dominance and
    // bounds the cost on very long code blocks / tables.
    if (text.length > 4000) text = text.slice(0, 4000);
    return {
      rtl: (text.match(RTL_RE) || []).length,
      ltr: (text.match(LTR_RE) || []).length,
    };
  }

  // Dominant strong direction; null when there is no strong character yet
  // (e.g. an empty block the app inserted before its text streams in).
  function dominantDir(text) {
    var c = strongCounts(text);
    if (!c.rtl && !c.ltr) return null;
    return c.rtl >= c.ltr ? 'rtl' : 'ltr'; // ties -> rtl
  }

  function getMode() {
    try {
      return localStorage.getItem(MODE_KEY) === 'he' ? 'he' : 'en';
    } catch (_) {
      return 'en';
    }
  }
  var mode = getMode();

  // The toggle is the source of truth: HE forces RTL on every message block
  // (embedded English still lays out LTR within the line via the bidi algo);
  // EN falls back to dominant-direction detection.
  function resolveDir(text) {
    if (mode === 'he') return 'rtl';
    return dominantDir(text);
  }

  // Code is exempt from the language mode.
  //  - inside <pre> (block code): follow content — a Hebrew-prose fence -> rtl,
  //    real ASCII source -> ltr.
  //  - inline code in prose: always ltr.
  function codeDir(el) {
    if (el.closest('pre')) {
      var c = strongCounts(el.closest('pre').textContent || '');
      return c.rtl > c.ltr ? 'rtl' : 'ltr';
    }
    return 'ltr';
  }

  // --- applying direction ---------------------------------------------------

  function mark(el) { el.setAttribute(MARK_ATTR, ''); }

  // Source of truth is RDIR_ATTR (React-proof). We still mirror to `dir`
  // best-effort for accessibility and for elements React doesn't control, but
  // rendering depends only on RDIR_ATTR.
  function setRdir(el, dir) {
    mark(el);
    var want = dir || 'auto'; // null (no strong char yet) -> auto
    if (el.getAttribute(RDIR_ATTR) !== want) el.setAttribute(RDIR_ATTR, want);
    try { if (el.getAttribute('dir') !== want) el.setAttribute('dir', want); } catch (_) {}
  }

  // Pass 1 — immediate, per element. Give freshly-inserted nodes a reasonable
  // direction before the debounced re-scan runs: dir="auto" on text blocks,
  // content-based dir on code.
  function pass1(el) {
    if (isEditable(el)) return;
    if (el.matches) {
      if (el.matches(CODE_SEL)) setRdir(el, codeDir(el));
      else if (el.matches(BLOCK_SEL) && !el.hasAttribute(RDIR_ATTR)) setRdir(el, null);
    }
    if (!el.querySelectorAll) return;
    var blocks = el.querySelectorAll(BLOCK_SEL);
    for (var i = 0; i < blocks.length; i++) {
      if (isEditable(blocks[i])) continue;
      if (!blocks[i].hasAttribute(RDIR_ATTR)) setRdir(blocks[i], null);
    }
    var codes = el.querySelectorAll(CODE_SEL);
    for (var j = 0; j < codes.length; j++) {
      if (isEditable(codes[j])) continue;
      setRdir(codes[j], codeDir(codes[j]));
    }
  }

  // RTL list-marker fix. The app gives <ol>/<ul> a physical `padding-left` (its
  // LTR design) with `list-style-position: outside`, so in RTL the marker is
  // placed on the right with no right padding to hold it and overflows into the
  // gutter. Mirror the actual left padding onto the right (and zero the left) so
  // the markers sit inside. getComputedStyle is fine here: it runs only on list
  // CONTAINERS (a handful), only on the rtl transition (guarded by PAD_ATTR) —
  // not in the per-block hot path the perf rule is about.
  function fixListPadding(el, dir) {
    var isList = el.tagName === 'OL' || el.tagName === 'UL';
    if (!isList) return;
    if (dir === 'rtl') {
      if (el.hasAttribute(PAD_ATTR)) return; // already mirrored
      var pad = getComputedStyle(el).paddingLeft; // resolved px, app's value
      el.style.paddingRight = pad;
      el.style.paddingLeft = '0px';
      el.setAttribute(PAD_ATTR, '');
    } else if (el.hasAttribute(PAD_ATTR)) {
      el.style.paddingRight = '';
      el.style.paddingLeft = '';
      el.removeAttribute(PAD_ATTR);
    }
  }

  // Pass 2 — debounced re-judge by content. Sets the explicit direction that
  // overrides pass 1's "auto".
  function judge(el) {
    if (!el.isConnected || isEditable(el) || !el.matches) return;
    if (el.matches(CODE_SEL)) { setRdir(el, codeDir(el)); return; }
    // Blocks and containers both judged by content. Native list markers follow
    // the element's computed `direction` (which our CSS forces from RDIR_ATTR),
    // so per-<li> direction is what moves the bullet/number to the correct side;
    // the <ol>/<ul> handles the list block's text-align.
    if (el.matches(BLOCK_SEL) || el.matches(CONTAINER_SEL)) {
      var dir = resolveDir(el.textContent || '');
      setRdir(el, dir);
      fixListPadding(el, dir);
    }
  }

  // --- queue + debounce-with-ceiling + chunked flush ------------------------
  //
  // Claude mutates the DOM continuously while streaming, so a plain
  // reset-on-every-mutation debounce can be starved forever. Use a ~150ms
  // debounce WITH a hard ~600ms ceiling: once we've waited the ceiling we flush
  // even while mutations keep arriving. (This was the single bug that made every
  // other fix appear to do nothing on the web version.)
  var DEBOUNCE = 150;
  var CEILING = 600;
  var CHUNK = 150;
  var queue = new Set();
  var debTimer = null;
  var ceilTimer = null;

  var idle = window.requestIdleCallback
    ? function (fn) { window.requestIdleCallback(fn, { timeout: 200 }); }
    : function (fn) { setTimeout(fn, 16); };

  function enqueue(el) { if (el && el.nodeType === 1) queue.add(el); }

  function scheduleFlush() {
    if (debTimer) clearTimeout(debTimer);
    debTimer = setTimeout(flush, DEBOUNCE);
    if (!ceilTimer) ceilTimer = setTimeout(flush, CEILING); // hard ceiling
  }

  function flush() {
    if (debTimer) { clearTimeout(debTimer); debTimer = null; }
    if (ceilTimer) { clearTimeout(ceilTimer); ceilTimer = null; }
    if (!enabled) { queue.clear(); return; }
    // queue is a Set — Array.prototype.slice.call() does NOT work on it (a Set
    // has .size, not .length, and no indexed access) and silently yields []. Use
    // Array.from. (This was the bug that made judge() never run: every flush got
    // an empty list and cleared the real queue, leaving blocks stuck at pass-1
    // "auto".)
    var items = Array.from(queue);
    queue.clear();
    if (items.length) diag('flush ' + items.length + ' item(s) (mode=' + mode + ')');
    processChunks(items, 0);
  }

  // Chunk all bulk DOM passes (~150 elements per idle callback) so a big rescan
  // (initial load, mode flip, long thread) never blocks the main thread.
  function processChunks(items, i) {
    var end = Math.min(i + CHUNK, items.length);
    // Per-element try/catch: a single bad node must never abort the whole chunk
    // (and leave the rest stuck at pass-1 "auto").
    for (; i < end; i++) {
      try { judge(items[i]); }
      catch (e) { diag('judge threw: ' + (e && e.message)); }
    }
    if (i < items.length) idle(function () { processChunks(items, i); });
  }

  // --- mutation handling ----------------------------------------------------

  function inRoot(el) {
    return !!(el && el.closest && el.closest(MSG_ROOT_SEL) && !isEditable(el));
  }

  // Re-queue the nearest ancestor block / container / code so a block judged
  // once while empty gets re-checked after its text streams in.
  function enqueueAncestors(el) {
    if (!el.closest) return;
    var b = el.closest(BLOCK_SEL); if (b) enqueue(b);
    var c = el.closest(CONTAINER_SEL); if (c) enqueue(c);
    var k = el.closest(CODE_SEL); if (k) enqueue(k);
  }

  function enqueueDescendants(el) {
    if (!el.querySelectorAll) return;
    var ds = el.querySelectorAll(ALL_SEL);
    for (var i = 0; i < ds.length; i++) enqueue(ds[i]);
  }

  // An added element is handled two ways, because Claude often inserts a whole
  // message wrapper in ONE childList mutation:
  //   - if it sits inside a message root → process it directly;
  //   - else if it CONTAINS roots → closest() can't see those descendants, so
  //     query down into it and process each contained root. (Missing this was
  //     why nothing got an explicit dir: the streamed message subtree was added
  //     as a wrapper that didn't itself match a root selector.)
  function handleAdded(n) {
    if (isEditable(n)) return;
    if (n.closest && n.closest(MSG_ROOT_SEL)) {
      pass1(n);              // immediate
      enqueue(n);
      enqueueAncestors(n);   // judge container/block this node landed inside
      enqueueDescendants(n); // and everything it brought with it
      return;
    }
    if (!n.querySelectorAll) return;
    var roots = n.querySelectorAll(MSG_ROOT_SEL);
    for (var i = 0; i < roots.length; i++) {
      if (isEditable(roots[i])) continue;
      pass1(roots[i]);
      enqueueDescendants(roots[i]);
    }
    if (roots.length) diag('wrapper added with ' + roots.length + ' root(s)');
  }

  function onMutations(muts) {
    if (!enabled) return;
    // Wrap the whole pass and ALWAYS scheduleFlush in finally: if anything here
    // threw before reaching scheduleFlush, the debounced re-judge would never be
    // scheduled and on-screen content would stay frozen at pass-1 "auto".
    try {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') {
          // Text streamed into a block: re-judge its block + container.
          var p = m.target && m.target.parentElement;
          if (inRoot(p)) enqueueAncestors(p);
          continue;
        }
        // childList
        for (var j = 0; j < m.addedNodes.length; j++) {
          var n = m.addedNodes[j];
          if (n.nodeType === 1) handleAdded(n);
          else if (n.nodeType === 3 && inRoot(n.parentElement)) {
            enqueueAncestors(n.parentElement); // streamed text node
          }
        }
        // The mutated container itself may be a streaming block gaining children.
        if (m.target && m.target.nodeType === 1 && inRoot(m.target)) {
          enqueueAncestors(m.target);
        }
      }
    } catch (e) {
      diag('onMutations threw: ' + (e && e.message));
    } finally {
      scheduleFlush();
    }
  }

  var observer = new MutationObserver(onMutations);

  // --- full / mode-flip rescan ----------------------------------------------

  // Initial load + every mode flip: re-judge all on-screen content. We only
  // enqueue here (no synchronous pass1) so the actual per-element work stays on
  // the chunked judge() path and never blocks the main thread on a long thread.
  function scanAll() {
    var roots = document.querySelectorAll(MSG_ROOT_SEL);
    for (var i = 0; i < roots.length; i++) {
      if (isEditable(roots[i])) continue;
      enqueueDescendants(roots[i]);
    }
    scheduleFlush();
  }

  function onModeChange(newMode) {
    mode = newMode === 'he' ? 'he' : 'en';
    diag('mode -> ' + mode);
    if (enabled) scanAll(); // re-judge every on-screen block + container live
  }

  // Same-window flip (composer toggle dispatches this) + cross-window flip
  // (storage event from another renderer window).
  window.addEventListener('claude-rtl-mode-change', function (e) {
    onModeChange(e && e.detail ? e.detail.mode : getMode());
  });
  window.addEventListener('storage', function (e) {
    if (e.key === MODE_KEY) onModeChange(e.newValue === 'he' ? 'he' : 'en');
  });

  // --- CSS ------------------------------------------------------------------
  //
  // direction AND text-align must be forced together with !important: Claude's
  // Tailwind hard-codes a physical text-align (and sometimes direction), so the
  // dir attribute alone (a low-specificity UA rule) loses. Scoped to [MARK_ATTR]
  // so we only ever affect elements this engine chose to manage.
  // Build a `tag:not([mark]),tag2:not([mark]),…` selector from a comma list so
  // the floor only applies to blocks the engine hasn't explicitly judged yet.
  function notMarked(sel) {
    return sel.split(',').map(function (t) {
      return t.trim() + ':not([' + MARK_ATTR + '])';
    }).join(',');
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var D = '[' + RDIR_ATTR + '='; // e.g. D + '"rtl"]'
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      // --- baseline floor ---------------------------------------------------
      // Content-based direction for every block the engine hasn't explicitly
      // judged yet (and anything its scoping never reaches). This is the proven
      // global behavior from before the engine existed: it can only ever IMPROVE
      // to a wrong-on-Latin-prefix guess, never regress to no RTL at all. Once
      // the engine sets [data-rtl-fix], these :not() rules stop matching and the
      // RDIR_ATTR rules below take over.
      notMarked(BLOCK_SEL) + '{unicode-bidi:plaintext;}',
      notMarked(CODE_SEL) + '{direction:ltr;unicode-bidi:bidi-override;}',

      // --- explicit, content-judged direction (overrides the floor) ---------
      // Keyed off OUR attribute (data-rtl-dir), which React can't revert.
      // direction AND text-align forced together with !important: Claude's
      // Tailwind hard-codes a physical text-align, so direction alone loses.
      D + '"rtl"]{direction:rtl!important;text-align:right!important;}',
      'ul' + D + '"rtl"],ol' + D + '"rtl"],li' + D + '"rtl"]' +
        '{direction:rtl!important;text-align:right!important;}',
      // Claude renders lists as `display:flex;flex-direction:column`, where
      // native `outside` markers overflow past the (RTL) right edge no matter
      // the padding. Moving the marker inside the content box keeps it in flow.
      // Paired with the padding mirror (fixListPadding) for the right indent.
      'ul' + D + '"rtl"],ol' + D + '"rtl"]{list-style-position:inside!important;}',
      // LTR blocks: force direction only (leave text-align to the app, so we
      // don't fight intentional centering on a mostly-Latin block).
      D + '"ltr"]{direction:ltr!important;}',
      // Not yet resolved (still "auto"): keep it content-based.
      D + '"auto"]{unicode-bidi:plaintext!important;}',
      // Inline code in prose: isolate from the surrounding bidi run, always LTR.
      ':not(pre)>code' + D + '"ltr"]{unicode-bidi:isolate!important;direction:ltr!important;}',
      // Block code: follow its own judged direction.
      'pre' + D + '"rtl"],pre' + D + '"rtl"] code' +
        '{direction:rtl!important;text-align:right!important;}',
      'pre' + D + '"ltr"],pre' + D + '"ltr"] code' +
        '{direction:ltr!important;text-align:left!important;}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyles() {
    var s = document.getElementById(STYLE_ID);
    if (s) s.remove();
  }

  // --- master on/off --------------------------------------------------------
  //
  // Fully revert: stop observing, drop the stylesheet, and strip dir from every
  // element we marked (and the marker itself).
  function removeAllDir() {
    var marked = document.querySelectorAll('[' + MARK_ATTR + ']');
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute('dir');
      marked[i].removeAttribute(RDIR_ATTR);
      marked[i].removeAttribute(MARK_ATTR);
      if (marked[i].hasAttribute(PAD_ATTR)) {
        marked[i].style.paddingRight = '';
        marked[i].style.paddingLeft = '';
        marked[i].removeAttribute(PAD_ATTR);
      }
    }
  }

  function setEnabled(value) {
    enabled = !!value;
    if (enabled) {
      injectStyles();
      observer.observe(document.body || document.documentElement,
        { childList: true, subtree: true, characterData: true });
      scanAll();
    } else {
      observer.disconnect();
      queue.clear();
      removeStyles();
      removeAllDir();
    }
  }

  // Single master switch — reverts the read engine AND the composer control.
  window.__claudeRtlSetEnabled = function (value) {
    setEnabled(value);
    if (typeof window.__claudeRtlSetInputDirEnabled === 'function') {
      window.__claudeRtlSetInputDirEnabled(value);
    }
  };

  // --- boot -----------------------------------------------------------------

  function start() {
    document.documentElement.setAttribute(STAMP_ATTR, BUILD_STAMP);
    diag('init ' + BUILD_STAMP + ' (mode=' + mode + ')');
    setEnabled(true);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
