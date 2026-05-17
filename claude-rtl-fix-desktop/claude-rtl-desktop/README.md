# claude-rtl-fix-desktop

A Windows installer that patches Anthropic's Claude desktop app so Hebrew, Arabic, and other right-to-left text renders correctly. Survives Claude's auto-updates.

> Companion to [claude-rtl-fix](https://github.com/your-repo/claude-rtl-fix), the browser extension. The desktop app uses a Chromium renderer just like the web app, but as an Electron MSIX package we can't fix it with a browser extension. This project patches the app itself.

---

## For end users

Download `ClaudeRTLFix-Setup.exe` from the [Releases](https://github.com/your-fork/claude-rtl-fix-desktop/releases) page. Double-click it. Accept the UAC prompt. Done.

The patch is applied immediately, and a background task re-applies it within 30 minutes any time Anthropic ships a Claude update.

To remove: Settings → Apps → Claude RTL Fix → Uninstall. This restores Claude's original `app.asar` and removes the background task.

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

We don't try to splice our code into Claude's bundled JS — that would break every time Anthropic bumps their bundler hash. Instead, inside `app.asar`:

1. We write three small files: `rtl-fix-payload.js`, `rtl-fix-hook.js`, `rtl-fix-entry.js`.
2. We rewrite the asar's `package.json` so its `main` field points at our `rtl-fix-entry.js` instead of Claude's original main.
3. `rtl-fix-entry.js` does two things: `require("./rtl-fix-hook.js")` first, then `require("./<original_main>")`. So Claude's main code runs as it always did, just preceded by our hook.

The hook runs in the **main process**. It registers a listener:

```js
app.on('web-contents-created', (_event, webContents) => {
  const inject = () => webContents.executeJavaScript(RTL_FIX_PAYLOAD).catch(() => {});
  webContents.on('did-finish-load', inject);
  webContents.on('did-navigate', inject);
  webContents.on('did-navigate-in-page', inject);
});
```

Every renderer that Claude creates gets the payload injected on every load and navigation. The payload is the same logic as the browser extension's `content.js`: set `dir="auto"` on text blocks, force `dir="ltr"` on code, install a `MutationObserver` for streaming tokens.

### The integrity bypass

Electron 12+ supports an `EnableEmbeddedAsarIntegrityValidation` fuse that hashes the asar header at launch and refuses to start if the hash doesn't match a value baked into the binary. If this is on (it is for production Claude builds), modifying `app.asar` would make Claude refuse to launch.

The patcher uses [@electron/fuses](https://github.com/electron/fuses) to flip this fuse off in `claude.exe`. No hash recomputation, no maintenance burden when Anthropic re-bundles.

The `OnlyLoadAppFromAsar` fuse is left on — we still want Claude to load from asar, just without the integrity check.

### The MSIX wrinkle

Anthropic ships Claude on Windows as a signed MSIX package, not the legacy Squirrel installer most Electron apps use. MSIX has three properties that affect us:

| Property | Implication |
|---|---|
| Installed under `C:\Program Files\WindowsApps`, owned by `TrustedInstaller`, ACL-locked | We have to `takeown` and `icacls` before writing, and restore ownership after. The patcher does this automatically when it detects an MSIX install. |
| Updates install to a **new** versioned directory, not in place | Our patch is wiped after every update — but the old directory gets cleaned up by Windows, so the watcher just patches the new one. No "undo" logic needed. |
| Package signature gets invalidated by our changes | Doesn't prevent launch (Windows checks signature at install, not launch). Will block manual "Repair" from Windows Settings, which would restore the original asar — that's actually a useful escape hatch. |

The patcher locates the current install via `Get-AppxPackage Claude` instead of hard-coding paths, so it always finds the latest version regardless of which directory Windows put it in.

### The auto-reapply loop

The Scheduled Task triggers on three events:
- **At system boot** — catches the case where Claude was updated while the machine was off.
- **At any user logon** — catches the case where an update landed since the last logon.
- **Every 30 minutes** while the machine is running — catches the case where Claude updates during an active session.

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

You don't need anything else — no Visual Studio, no Python, no MSBuild, no signing certificates.

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

Source mode reads the payload files from disk, so edits to `src/payload/*.js` take effect immediately on the next run — no rebuild needed.

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
│   │       ├── rtl-fix-hook.js       ← main-process Electron hook
│   │       └── rtl-fix-payload.js    ← renderer-side RTL logic
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

`installer.iss` declares: paste `claude-rtl-patch.exe` and `watcher-task.xml` into `Program Files\ClaudeRTLFix`, then run two commands — `claude-rtl-patch.exe` once for the initial patch, and `schtasks /Create /XML watcher-task.xml` to register the watcher. The uninstaller runs them in reverse.

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

The patcher's macOS code path is written but **untested** as of this revision. The integrity module uses the same `@electron/fuses` library plus an ad-hoc `codesign --sign -` step. We'd need someone with a Mac running Claude.app to validate end-to-end, then add:

- A LaunchAgent plist with `WatchPaths` on `/Applications/Claude.app/Contents/Resources/` (much cleaner than the Windows scheduled-task approach — macOS fires the watcher *on file change*, not on a timer).
- A `.pkg` installer built with `pkgbuild` + `productbuild`.

These are mechanical to add once the patcher itself is verified to work on macOS.

---

## Known limitations & open risks

- **Windows MSIX "Repair"** will revert the patch. Re-running `claude-rtl-patch.exe` (or just waiting for the watcher) puts it back.
- **Microsoft Defender / corporate AV** may flag the modification of files in `WindowsApps`. Defender shouldn't (this is a common pattern for system utilities), but specific AV products can.
- **Anthropic could change Claude's main entry filename**, which would break our `package.json` rewrite logic. Mitigation: the patcher records the original main filename in a `__rtlFixOriginalMain` key, so even after changes our unpatch still works correctly.
- **An Electron major version bump** could change the SEA / fuse format. The integrity module would need an update — easy fix, just a dependency bump.
- **The patcher binary is large (~100 MB)** because Node SEA includes the full Node runtime. The installer compresses well (~35 MB) but it's not tiny. A future optimization is to ship the bundled JS plus a smaller embedded runtime (Bun, QuickJS, etc.) but the convenience of SEA outweighs the size cost for now.

---

## License

MIT.
