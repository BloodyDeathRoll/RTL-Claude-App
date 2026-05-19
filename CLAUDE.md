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
- Writes `rtl-fix-payload.js`, `rtl-fix-hook.js`, and `rtl-fix-entry.js` into the asar root.
- Rewrites `package.json` `"main"` → `rtl-fix-entry.js`, saving the original in `__rtlFixOriginalMain`.
- `rtl-fix-entry.js` does `require('./rtl-fix-hook')` then `require('./<original_main>')`.
- `rtl-fix-hook.js` (main process) listens for `web-contents-created` and injects `rtl-fix-payload.js` via `executeJavaScript` on every load/navigation.
- `rtl-fix-payload.js` (renderer) sets `dir="auto"` on text blocks and `dir="ltr"` on code elements, then installs a `MutationObserver` for streaming tokens.

### Payload embedding

`build.js` runs esbuild over `src/patch.js`, inlines the payload files as string constants in `dist/embedded-payloads.js`, and uses an esbuild alias so the bundle imports them. In source mode, `src/embedded-payloads-source.js` reads the payload files from disk instead.

### Auto-reapply

A Windows Scheduled Task (`installer/windows/watcher-task.xml`, runs as SYSTEM) triggers the patcher at boot, at any user logon, and every 30 minutes. Each run does a fast-path check (~50 ms) and only does the full unpack/repack if the current MSIX directory isn't already patched.

## Release checklist

1. Bump version in `patcher/package.json` and `installer/windows/installer.iss` (`MyAppVersion`).
2. Run `build-all.cmd` on Windows.
3. Test on a clean Windows VM.
4. Upload `installer/windows/Output/ClaudeRTLFix-Setup.exe` to GitHub Releases.

## Known constraints

- The `patcher/dist/` and `installer/windows/Output/` directories are gitignored build artifacts.
- The `.exe` is ~100 MB because Node SEA embeds the full Node runtime - this is intentional.
- macOS code path is implemented in `integrity.js` but **untested** on real hardware.
- MSIX "Repair" from Windows Settings reverts the patch (the watcher re-applies it within 30 min).
