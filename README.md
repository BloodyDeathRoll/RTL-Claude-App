# claude-rtl-fix-desktop

A Windows installer that patches Anthropic's Claude desktop app so Hebrew, Arabic, and other right-to-left text renders correctly. Survives Claude's auto-updates.

> Companion to [claude-rtl-fix](https://github.com/BloodyDeathRoll/RTL-Claude-App), the browser extension. The desktop app uses a Chromium renderer just like the web app, but as an Electron MSIX package we can't fix it with a browser extension. This project patches the app itself.

---

## For end users

Download `ClaudeRTLFix-Setup.exe` from the [Releases](https://github.com/BloodyDeathRoll/RTL-Claude-App/releases) page. Double-click it. Accept the UAC prompt. Done.

The patch is applied immediately, and a background task re-applies it within 30 minutes any time Anthropic ships a Claude update.

To remove: Settings → Apps → Claude RTL Fix → Uninstall. This restores Claude's original `app.asar` and removes the background task.

### Antivirus notice

**You may need to add antivirus exclusions before or during installation.**

This tool modifies files inside `C:\Program Files\WindowsApps\` - a protected system directory where Claude's MSIX package lives. It also modifies `Claude.exe` to disable an Electron integrity check. These are legitimate operations, but they look identical to what malware patchers do. Some antivirus products will quarantine the patcher or the modified files.

**Windows Defender** is handled automatically: the installer adds exclusions for `C:\Program Files\WindowsApps` and `C:\Program Files\ClaudeRTLFix` before running the patcher, so Defender should not interfere.

**Third-party antivirus (Avast, Norton, Bitdefender, Kaspersky, etc.):** The installer will warn you if it detects a third-party AV product. Before clicking OK on that dialog, add these two folders as exclusions in your antivirus settings:

```
C:\Program Files\WindowsApps
C:\Program Files\ClaudeRTLFix
```

If you miss this step and your AV quarantines something:
1. Restore the quarantined files from your AV's quarantine vault.
2. Add the exclusions above.
3. Run `claude-rtl-patch.exe --unpatch` then `claude-rtl-patch.exe` again to re-apply cleanly.

> **Why isn't the exe signed?** Code-signing certificates cost $200–600/year. This is a free open-source tool. We plan to apply for a free certificate through [SignPath Foundation](https://signpath.org/free-code-signing) once the tool has been stable for a while. In the meantime, Windows SmartScreen will show a "Windows protected your PC" warning on first run - click "More info" → "Run anyway".

### Looking for the browser extension?

If you use Claude in a browser rather than the desktop app, the browser extension version of this fix is available at [github.com/BloodyDeathRoll/RTL-Claude](https://github.com/BloodyDeathRoll/RTL-Claude). It works without any installation or system modifications - just install the extension and RTL text is fixed in Claude's web interface.

---

## What it actually does

Claude Desktop is an Electron app. Anthropic doesn't currently set `dir="auto"` on message content, so the browser's built-in Unicode bidi algorithm never gets a chance to decide per-paragraph direction. Hebrew comes out left-aligned with punctuation in the wrong place. The fix is one HTML attribute per text block. The trick is *injecting it inside an MSIX-packaged Electron app*, surviving signed-package integrity checks, and re-applying it after auto-updates.

The architecture has three pieces:

```
                ┌────────────────────────────────────────────────────────┐
                │     C:\Program Files\WindowsApps\Claude_<version>_*    │
                │             (Anthropic's signed MSIX package)          │
                │   ┌────────────────────────────────────────────────┐   │
                │   │  app\resources\app.asar  ← we modify this      │   │
                │   │  app\claude.exe          ← we modify this too  │   │
                │   └────────────────────────────────────────────────┘   │
                └─────────────────────┬──────────────────────────────────┘
                                      │
                ┌─────────────────────┴───────────────────┐
                │                                         │
   ┌────────────▼──────────────┐         ┌────────────────▼─────────────┐
   │   claude-rtl-patch.exe    │         │  Scheduled Task              │
   │   (self-contained Node    │ ◀─runs─ │  "\ClaudeRTLFix\Watcher"     │
   │    SEA binary, no deps)   │         │  RunAs: SYSTEM               │
   │                           │         │  Triggers:                   │
   │   1. find Claude (MSIX)   │         │   - at boot                  │
   │   2. take file ownership  │         │   - at any user logon        │
   │   3. unpack app.asar      │         │   - every 30 min             │
   │   4. inject hook+payload  │         │  Action: claude-rtl-patch    │
   │   5. repack app.asar      │         │          .exe --quiet        │
   │   6. flip integrity fuse  │         └──────────────────────────────┘
   │      on claude.exe        │
   │   7. restore ownership    │
   │                           │
   │   Idempotent.             │
   └───────────────────────────┘
```

### The injection technique

We don't try to splice our code into Claude's bundled JS - that would break every time Anthropic bumps their bundler hash. Instead, inside `app.asar`:

1. We write three small files: `rtl-fix-payload.js`, `rtl-fix-hook.js`, `rtl-fix-entry.js`.
2. We rewrite the asar's `package.json` so its `main` field points at our `rtl-fix-entry.js` instead of Claude's original main.
3. `rtl-fix-entry.js` does two things: `require("./rtl-fix-hook.js")` first, then `require("./<original_main>")`. So Claude's main code runs as it always did, just preceded by our hook.

The hook runs in the **main process**. It uses two complementary mechanisms:

**1. CSS injection via `webContents.insertCSS()`** - sets `unicode-bidi: plaintext` on every text block (equivalent to `dir="auto"`) and forces `direction: ltr` on code blocks. CSS rules apply automatically to elements added later by React, so no observer is needed for text direction.

**2. `dir="auto"` on list containers via `webContents.executeJavaScriptInIsolatedWorld()`** - `unicode-bidi: plaintext` in CSS cannot move list markers (numbers/bullets) to the correct side for RTL lists because CSS cannot scan block children to detect direction. Setting `dir="auto"` as an HTML attribute on `ol`/`ul` elements does. A `MutationObserver` running in isolated world 999 catches list elements as React adds them.

The isolated world is important: `executeJavaScript` (world 0) runs in Claude's renderer context and can interfere with React's update cycle. World 999 shares the DOM but is invisible to Claude's JS.

### The integrity bypass

Electron 12+ supports an `EnableEmbeddedAsarIntegrityValidation` fuse that hashes the asar header at launch and refuses to start if the hash doesn't match a value baked into the binary. If this is on (it is for production Claude builds), modifying `app.asar` would make Claude refuse to launch.

The patcher uses [@electron/fuses](https://github.com/electron/fuses) to flip this fuse off in `claude.exe`. No hash recomputation, no maintenance burden when Anthropic re-bundles.

The `OnlyLoadAppFromAsar` fuse is left on - we still want Claude to load from asar, just without the integrity check.

### The MSIX wrinkle

Anthropic ships Claude on Windows as a signed MSIX package, not the legacy Squirrel installer most Electron apps use. MSIX has three properties that affect us:

| Property | Implication |
|---|---|
| Installed under `C:\Program Files\WindowsApps`, owned by `TrustedInstaller`, ACL-locked | We have to `takeown` and `icacls` before writing, and restore ownership after. The patcher does this automatically when it detects an MSIX install. |
| Updates install to a **new** versioned directory, not in place | Our patch is wiped after every update - but the old directory gets cleaned up by Windows, so the watcher just patches the new one. No "undo" logic needed. |
| Package signature gets invalidated by our changes | Doesn't prevent launch (Windows checks signature at install, not launch). Will block manual "Repair" from Windows Settings, which would restore the original asar - that's actually a useful escape hatch. |

The patcher locates the current install via `Get-AppxPackage Claude` instead of hard-coding paths, so it always finds the latest version regardless of which directory Windows put it in.

### The auto-reapply loop

The Scheduled Task triggers on three events:
- **At system boot** - catches the case where Claude was updated while the machine was off.
- **At any user logon** - catches the case where an update landed since the last logon.
- **Every 30 minutes** while the machine is running - catches the case where Claude updates during an active session.

Each run, the patcher does a fast-path check (parses `app.asar`'s `package.json` and looks for our `__rtlFixOriginalMain` marker). If the current install is already patched it exits in ~50ms. Only if it sees a fresh, unpatched MSIX directory does it do the full unpack/inject/repack cycle.

The task runs as `SYSTEM` because writing into `WindowsApps` requires ownership rights that a normal user account doesn't have.

---

## For developers / contributors

### Prerequisites (one-time setup)

To build a release on Windows:

| Tool | Why | Install |
|---|---|---|
| Node 22+ | Bundles the patcher with esbuild, then SEAs it into a `.exe` using Node's built-in Single Executable Application support. | https://nodejs.org/ |
| Inno Setup 6 | Wraps everything into the user-facing `ClaudeRTLFix-Setup.exe`. | https://jrsoftware.org/isinfo.php |

You don't need anything else - no Visual Studio, no Python, no MSBuild, no signing certificates.

### Building a release

```cmd
build-all.cmd
```

That's it. The script:

1. Checks that Node and Inno Setup are present.
2. Runs `npm install` in `patcher/` if `node_modules` doesn't exist.
3. Runs `node patcher/build.js` to bundle the JS into a single 250 KB file.
4. Runs `patcher/build-windows.cmd` to embed that JS into `node.exe` via Node SEA, producing `patcher/dist/claude-rtl-patch.exe` (~100 MB).
5. Runs Inno Setup's `ISCC.exe` on `installer/windows/installer.iss`, producing `installer/windows/Output/ClaudeRTLFix-Setup.exe` (~35 MB).

That single `ClaudeRTLFix-Setup.exe` is what you publish.

### Iterating on the patcher logic

You don't need to rebuild the .exe for every test. From inside `patcher/`:

```cmd
node src\patch.js              REM patch the current Claude install
node src\patch.js --unpatch    REM remove the patch
node src\patch.js --quiet      REM what the watcher runs (logs to file)
```

Source mode reads the payload files from disk, so edits to `src/payload/*.js` take effect immediately on the next run - no rebuild needed.

To override which Claude install to operate on:

```cmd
node src\patch.js --claude-path "C:\Program Files\WindowsApps\Claude_..."
```

### Iterating on the renderer payload only

The fastest dev loop:

1. Edit `patcher/src/payload/rtl-fix-payload.js`.
2. Run `node src/patch.js` (this re-patches with the new payload).
3. Restart Claude.

No bundling step needed for source-mode runs.

### Iterating on the installer

After the build pipeline has produced a `claude-rtl-patch.exe`, you can recompile *just* the installer without re-bundling:

```cmd
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\installer.iss
```

### Project layout

```
claude-rtl-fix-desktop/
├── README.md                         ← this file
├── LICENSE                           ← MIT
├── build-all.cmd                     ← one-command developer build
├── .gitignore
│
├── patcher/                          ← the core patcher
│   ├── package.json
│   ├── build.js                      ← bundles src/ → dist/patcher.bundled.js
│   ├── build-windows.cmd             ← seals bundle into claude-rtl-patch.exe
│   ├── src/
│   │   ├── patch.js                  ← main entry, CLI, orchestration
│   │   ├── integrity.js              ← @electron/fuses + macOS ad-hoc resign
│   │   ├── windows-acl.js            ← takeown / icacls helpers
│   │   ├── embedded-payloads-source.js  ← dev-mode payload loader
│   │   └── payload/
│   │       ├── rtl-fix-entry.js      ← asar entry shim (redirected from package.json main)
│   │       ├── rtl-fix-hook.js       ← main-process hook (insertCSS + isolated-world JS)
│   │       └── rtl-fix-payload.js    ← unused at runtime; kept for future renderer injection
│   └── dist/                         ← build artifacts (gitignored)
│       ├── patcher.bundled.js
│       └── claude-rtl-patch.exe
│
└── installer/
    └── windows/
        ├── installer.iss             ← Inno Setup script
        ├── watcher-task.xml          ← Scheduled-task definition
        ├── README.txt                ← ships inside the installed program dir
        └── Output/                   ← build artifacts (gitignored)
            └── ClaudeRTLFix-Setup.exe
```

### How each piece is wired

`build.js` runs esbuild over `src/patch.js`, bundling everything (including `@electron/asar` and `@electron/fuses`) into one file. The build inlines the payload files as string constants in a generated `dist/embedded-payloads.js`, which the bundle imports via an esbuild alias. There's a small plugin in the build that rewrites `import.meta.url` to `__filename` so the bundled (ESM-internally) `@electron/asar` works in CJS form.

`build-windows.cmd` writes a SEA config, runs `node --experimental-sea-config` to generate the blob, copies the host's `node.exe`, and uses `npx postject` to inject the blob into the copy.

`installer.iss` declares: paste `claude-rtl-patch.exe` and `watcher-task.xml` into `Program Files\ClaudeRTLFix`, then run two commands - `claude-rtl-patch.exe` once for the initial patch, and `schtasks /Create /XML watcher-task.xml` to register the watcher. The uninstaller runs them in reverse.

`watcher-task.xml` is a standard Task Scheduler XML with `<UserId>S-1-5-18</UserId>` (LocalSystem) and three triggers (boot, logon, time-based 30-minute repetition).

### Testing on a real Claude install (without going through the installer)

1. Open an elevated PowerShell prompt.
2. From the project root, build just the patcher: `cd patcher; npm install; node build.js; build-windows.cmd`.
3. Run `patcher\dist\claude-rtl-patch.exe`.
4. Launch Claude, paste some Hebrew, verify rendering.
5. If something's wrong: `patcher\dist\claude-rtl-patch.exe --unpatch` to restore Claude's original asar.

The patcher writes a log to `C:\ProgramData\ClaudeRTLFix\log.txt` when run with `--quiet`. Without `--quiet` it logs to stdout instead.

### Releasing

1. Bump version in `patcher/package.json` and `installer/windows/installer.iss` (`MyAppVersion`).
2. Run `build-all.cmd`.
3. Test the produced installer on a clean Windows VM if possible.
4. Upload `installer/windows/Output/ClaudeRTLFix-Setup.exe` to a GitHub release.
5. Update the README's release link.

---

## macOS support

The macOS code path is fully implemented and verified in CI on every push. There is no GUI installer yet - installation is a one-time terminal command. A `.pkg` installer is on the roadmap.

### For end users

**Requirements:** Node.js 22+ ([nodejs.org](https://nodejs.org/)) and a Mac with Claude.app in `/Applications`.

```bash
# Clone the repo (once), then:
cd claude-rtl-fix-desktop/claude-rtl-desktop
sudo bash installer/macos/install.sh
```

That's it. The script patches Claude immediately and installs a background watcher that re-patches automatically whenever Anthropic ships an update.

To remove:

```bash
sudo bash installer/macos/uninstall.sh
```

**Gatekeeper notice:** When you first launch Claude after patching, macOS may show a "damaged or incomplete" warning. This is because the installer modifies Claude's binary (to disable the Electron integrity check) and then re-signs it with an ad-hoc signature. Ad-hoc signatures are valid but unsigned - Gatekeeper trusts them for apps it has already approved. If you see the warning:
1. Open **System Settings → Privacy & Security**.
2. Scroll down to the "Security" section and click **Open Anyway**.

This is a one-time step per Claude version.

---

### How macOS differs from Windows

| | Windows | macOS |
|---|---|---|
| Claude's install location | `C:\Program Files\WindowsApps\Claude_<ver>_*` (MSIX, owned by TrustedInstaller) | `/Applications/Claude.app` (standard .app bundle) |
| File ownership | Must `takeown` + `icacls` before writing, then restore | Standard POSIX - `sudo` is enough |
| Auto-reapply mechanism | Scheduled Task, polls every 30 minutes | LaunchDaemon with `WatchPaths` - fires the moment Claude's `Resources/` folder changes |
| Integrity bypass | `@electron/fuses` fuse flip only | Same fuse flip **+** `codesign --force --deep --sign -` to re-sign the .app bundle |
| User-facing installer | `ClaudeRTLFix-Setup.exe` (double-click, no terminal) | `install.sh` (terminal, requires Node) - `.pkg` installer planned |

The injection payload (`insertCSS` + `executeJavaScriptInIsolatedWorld`) is **identical** on both platforms - only the delivery mechanism differs.

### Why `WatchPaths` is cleaner than the Windows scheduler

The Windows watcher runs every 30 minutes regardless of whether Claude updated. On macOS, `WatchPaths` is a kernel-level file-change notification: launchd fires the patcher within seconds of Anthropic's updater touching Claude's `Resources/` directory, then goes quiet again. Zero polling, zero unnecessary work.

### What the CI job does (for contributors)

The `test-macos` job in `.github/workflows/release.yml` runs on every push and pull request:

1. **`brew install --cask claude`** - installs a real, production Claude.app (same DMG users download from Anthropic).
2. **`sudo node src/patch.js`** - runs the full patch pipeline: extract asar → inject hook + entry shim → repack → flip fuse → `codesign --sign -`.
3. **Verify** - reads `app.asar`'s `package.json` directly via `@electron/asar` and asserts `__rtlFixOriginalMain` is present and `main` points to `rtl-fix-entry.js`.
4. **`sudo node src/patch.js --unpatch`** - removes the patch.
5. **Verify again** - asserts the marker is gone and `main` is restored.

This catches regressions in the fuse-flip logic, the codesign step, the asar repack, and the entry-shim wiring - all on real Claude binaries - before anything reaches users.

---

## Known limitations & open risks

- **Windows MSIX "Repair"** will revert the patch. Re-running `claude-rtl-patch.exe` (or just waiting for the watcher) puts it back.
- **Third-party antivirus** may flag or quarantine the patcher or the modified Claude files. See the [Antivirus notice](#antivirus-notice) section above for step-by-step instructions. Windows Defender is handled automatically by the installer.
- **Anthropic could change Claude's main entry filename**, which would break our `package.json` rewrite logic. Mitigation: the patcher records the original main filename in a `__rtlFixOriginalMain` key, so even after changes our unpatch still works correctly.
- **An Electron major version bump** could change the SEA / fuse format. The integrity module would need an update - easy fix, just a dependency bump.
- **The patcher binary is large (~100 MB)** because Node SEA includes the full Node runtime. The installer compresses well (~35 MB) but it's not tiny. A future optimization is to ship the bundled JS plus a smaller embedded runtime (Bun, QuickJS, etc.) but the convenience of SEA outweighs the size cost for now.

---

## License

MIT.
