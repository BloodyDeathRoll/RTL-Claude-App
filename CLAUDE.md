# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A Windows (and partially macOS) patcher that fixes right-to-left text rendering (Hebrew, Arabic, etc.) in the Claude desktop app. It injects a small JS payload into the Electron app's `app.asar` and survives Claude's auto-updates via a Windows Scheduled Task.

The working tree lives at `claude-rtl-fix-desktop/claude-rtl-desktop/`.

## Build commands

All build steps require **Node 22+**. Run from `patcher/` unless noted.

```cmd
# Install dependencies (first time only)
cd patcher && npm install

# Step 1 – bundle patcher JS (any platform)
node build.js
# → patcher/dist/patcher.bundled.js  (~250 KB, all deps inlined)

# Step 2 – produce Windows .exe (Windows only, uses node.exe on PATH)
patcher\build-windows.cmd
# → patcher/dist/claude-rtl-patch.exe  (~100 MB Node SEA binary)

# Step 3 – compile the user-facing installer (Windows + Inno Setup 6)
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\installer.iss
# → installer/windows/Output/ClaudeRTLFix-Setup.exe  (~35 MB)

# One-command full release build (Windows only, wraps all three steps)
build-all.cmd
```

## Dev iteration (no .exe rebuild needed)

Source mode reads payload files from disk on every run, so edits to `src/payload/*.js` take effect immediately:

```cmd
# From patcher/
node src\patch.js                          # patch current Claude install
node src\patch.js --unpatch                # restore original asar
node src\patch.js --quiet                  # same as watcher (logs to file)
node src\patch.js --claude-path "C:\..."   # override install path
```

Tail the watcher log: `Get-Content C:\ProgramData\ClaudeRTLFix\log.txt -Wait`

## Architecture

The patcher has three layers:

1. **`src/patch.js`** - CLI entry and orchestration. Locates Claude via `Get-AppxPackage` (MSIX) or legacy Squirrel paths, extracts `app.asar` to a temp dir, calls the patch/unpatch functions, repacks, and cleans up. Idempotent: checks for `__rtlFixOriginalMain` marker in `app.asar`'s `package.json` before doing anything.

2. **`src/integrity.js`** - flips the `EnableEmbeddedAsarIntegrityValidation` Electron fuse off in `claude.exe`/`Claude` using `@electron/fuses`, then re-signs ad-hoc on macOS via `codesign --force --deep --sign -`.

3. **`src/windows-acl.js`** - takes ownership (`takeown`) and grants write ACLs (`icacls`) on files inside `C:\Program Files\WindowsApps\` (which is owned by TrustedInstaller), then restores them after writing.

### Injection technique

Instead of splicing into Claude's bundled JS (fragile against bundler hash changes), the patcher:
- Writes `rtl-fix-read.js`, `rtl-fix-payload.js`, `rtl-fix-hook.js`, and `rtl-fix-entry.js` into the asar root.
- Rewrites `package.json` `"main"` → `rtl-fix-entry.js`, saving the original in `__rtlFixOriginalMain`.
- `rtl-fix-entry.js` does `require('./rtl-fix-hook')` then `require('./<original_main>')`.
- `rtl-fix-hook.js` (main process) listens for `web-contents-created` and, on every load/navigation, injects two renderer scripts into isolated world 999 (`executeJavaScriptInIsolatedWorld` — shares the page DOM, stays out of Claude's own JS world): `rtl-fix-read.js` then `rtl-fix-payload.js`. No `insertCSS`/preload; each script injects its own scoped `<style>` and self-guards against the repeated did-navigate re-injections.
- `rtl-fix-read.js` (renderer) is the **read-direction engine** for responses. It decides direction by **content**, not `dir="auto"`/first-strong-character (a Hebrew block opening with a Latin token resolves LTR off its first letter). `resolveDir(text)`: in HE mode → `rtl` unconditionally; in EN mode → dominant strong-RTL-vs-LTR count (ties → rtl, `null` when no strong char yet). Code is mode-exempt via `codeDir()` (inline code → always LTR + `unicode-bidi:isolate`; block `<pre>` → follows its own content). It sets explicit `dir` on text blocks / list items / table cells / containers (scoped to message roots so HE mode never flips the app chrome) and forces `direction`+`text-align` together with `!important` via a `[data-rtl-fix]`-scoped stylesheet. Two passes (immediate per-element `dir="auto"`, then a debounced content re-judge), a `MutationObserver` (childList+subtree+characterData) that re-queues the nearest container/block on each mutation, a **~150 ms debounce with a hard ~600 ms ceiling** (so continuous streaming mutations can't starve the scan), and chunked passes (~150 elements/idle). A temporary build stamp is written to `<html data-claude-rtl-build>` for DevTools version confirmation.
- `rtl-fix-payload.js` (renderer) is the **input-direction toggle**: a two-segment `EN | HE` switch injected into the composer. `HE` sets `direction:rtl`/`text-align:right` on the ProseMirror editor via a `<style>` rule keyed off `data-claude-input-dir="he"` on `<html>` (two explicit states, no auto-detection). It persists the choice in `localStorage` and syncs across windows via the `storage` event, and re-injects via a `MutationObserver` as the composer is swapped between the landing page and threads. Ported from the browser extension (v1.6.0).
- The EN/HE toggle is the **single source of truth** for both layers: the `localStorage` key `claude-rtl-fix-input-dir` is shared, and flipping the switch dispatches a same-window `claude-rtl-mode-change` event that makes the read engine re-judge all on-screen content live. `window.__claudeRtlSetEnabled(bool)` is the master on/off that fully reverts both layers.

### Payload embedding

`build.js` runs esbuild over `src/patch.js`, inlines the payload files as string constants in `dist/embedded-payloads.js`, and uses an esbuild alias so the bundle imports them. In source mode, `src/embedded-payloads-source.js` reads the payload files from disk instead.

### Auto-reapply

A Windows Scheduled Task (`installer/windows/watcher-task.xml`, runs as SYSTEM) triggers the patcher at boot, at any user logon, and every 30 minutes. Each run does a fast-path check (~50 ms) and only does the full unpack/repack if the current MSIX directory isn't already patched.

## Release checklist

Full copy-paste process: see `RELEASING.md` in the working tree root. Summary:

1. Bump version in three places: `patcher/package.json`, `installer/windows/installer.iss` (`MyAppVersion`), and `patcher/src/payload/rtl-fix-read.js` (`BUILD_STAMP`).
2. `node build.js`, commit, push, then tag `vX.Y.Z` and push the tag.
3. **Done — CI takes it from there.** `.github/workflows/release.yml` fires on any `v*` tag: it runs the macOS patch/unpatch correctness gate, installs Inno Setup on a `windows-latest` runner and runs `build-all.cmd`, then publishes the GitHub Release with `ClaudeRTLFix-Setup.exe` + `ClaudeRTLFix-macOS.zip` attached (~2 min). **No local Windows machine, Node, or Inno Setup is needed to cut a release** — never send anyone to build locally. Watch with `gh run watch <id> --exit-status`.
4. Verify the published build on a clean Windows VM (confirm `data-claude-rtl-build` reports the new version in DevTools).

## Known constraints

- The `patcher/dist/` and `installer/windows/Output/` directories are gitignored build artifacts.
- The `.exe` is ~100 MB because Node SEA embeds the full Node runtime - this is intentional.
- macOS code path is implemented in `integrity.js` but **untested** on real hardware.
- MSIX "Repair" from Windows Settings reverts the patch (the watcher re-applies it within 30 min).
- **Desktop message DOM differs from the claude.ai web build** (verified 2026-06-21, Claude 1.14271): there is **no** `prose` / `font-claude-message` / `data-message-author-role`. Assistant content is `div.standard-markdown` (markdown body) inside `div.font-claude-response`, paragraphs are `p.font-claude-response-body`; user content is under `[data-testid="user-message"]`. Lists render as `display:flex;flex-direction:column` with physical `pl-8`, so native `outside` markers overflow in RTL — `rtl-fix-read.js` forces `list-style-position:inside` and mirrors the padding. These selectors live in `rtl-fix-read.js` (`MSG_ROOT_SEL`); re-verify against the live DOM if a Claude update breaks RTL.
- The read engine keys its forcing CSS off its own `data-rtl-dir` attribute, **not** `dir` — Claude's renderer controls `dir` and reverts ours on re-render. Flip `DEBUG` in `rtl-fix-read.js` and check `<html data-claude-rtl-build>` in DevTools when diagnosing.
