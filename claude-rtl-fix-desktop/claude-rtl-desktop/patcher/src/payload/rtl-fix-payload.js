// Claude RTL Fix - desktop payload
// Runs in renderer context via webContents.executeJavaScript.
// Idempotent: safe to invoke many times. Installs a single observer per page.

(function () {
  if (window.__claudeRtlFixInstalled) return;
  window.__claudeRtlFixInstalled = true;

  const TEXT_BLOCK_SELECTORS = [
    'p', 'li', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'td', 'th',
    '[class*="prose"] > *',
    '[data-message-author-role]'
  ].join(',');

  const CODE_SELECTORS = ['pre', 'code', 'kbd', 'samp', 'var'].join(',');
  const MARK = 'data-rtl-fix-applied';

  function apply(root) {
    if (!root || root.nodeType !== 1) return;

    root.querySelectorAll(TEXT_BLOCK_SELECTORS).forEach((el) => {
      if (el.closest(CODE_SELECTORS)) return;
      if (el.hasAttribute(MARK)) return;
      el.setAttribute('dir', 'auto');
      el.setAttribute(MARK, 'auto');
    });

    root.querySelectorAll(CODE_SELECTORS).forEach((el) => {
      if (el.getAttribute('dir') === 'ltr' && el.hasAttribute(MARK)) return;
      el.setAttribute('dir', 'ltr');
      el.setAttribute(MARK, 'ltr');
    });

    if (root.matches && root.matches(TEXT_BLOCK_SELECTORS) && !root.closest(CODE_SELECTORS) && !root.hasAttribute(MARK)) {
      root.setAttribute('dir', 'auto');
      root.setAttribute(MARK, 'auto');
    }
  }

  apply(document.body || document.documentElement);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const el = m.target.parentElement;
        if (el) apply(el);
      } else {
        m.addedNodes.forEach((n) => apply(n));
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    characterData: true,
    subtree: true,
  });
})();
