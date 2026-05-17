# claude-rtl-fix-desktop

Fixes right-to-left text rendering (Hebrew, Arabic, etc.) in the Claude
desktop app, with automatic re-application after Claude auto-updates.

The patcher core is platform-agnostic. Windows MSIX (Anthropic's current
distribution format) and the legacy Squirrel-based Windows installer are both
supported. macOS support is implemented but currently untested on real
hardware.

## How it works

```
                        ┌─────────────────────────────────────────────┐
                        │     C:\Program Files\WindowsApps\Claude_*   │
                        │              (Anthropic's MSIX)             │
                        │   ┌─────────────────────────────────────┐   │
                        │   │  app\resources\app.asar             │   │
                        │   │  app\claude.exe (Electron binary)   │   │
                        │   └─────────────────────────────────────┘   │
                        └────────────────────┬────────────────────────┘
                                             │ modified by ↓
                ┌────────────────────────────┴────────────────────────┐
                │                                                     │
   ┌────────────▼──────────────┐               ┌──────────────────────▼─────────┐
   │  claude-rtl-patch.exe     │               │  Scheduled Task                │
   │  (single-file Node SEA)   │ ◀────runs──── │  "\ClaudeRTLFix\Watcher"       │
   │                           │               │  Runs as: SYSTEM               │
   │  • find MSIX install      │               │  Triggers:                     │
   │  • take ownership         │               │   - at boot                    │
   │  • extract app.asar       │               │   - at any user logon          │
   │  • inject hook + payload  │               │   - every 30 min               │
   │  • repack app.asar        │               └────────────────────────────────┘
   │  • flip integrity fuse    │
   │  • restore ownership      │       Patch injection (inside app.asar):
   │                           │
   │  Idempotent: re-running   │       package.json "main" → rtl-fix-entry.js
   │  is a no-op when already  │             which requires:
   │  patched.                 │              • rtl-fix-hook.js  (main-process)
   └───────────────────────────┘                  hooks app.on('web-contents-created')
                                                  and injects rtl-fix-payload.js
                                                  via webContents.executeJavaScript
                                              • the original main (preserved)
```

## Building

### 1. Bundle the patcher (any platform with Node 22)

```
cd patcher
npm install
node build.js
```

Produces `patcher/dist/patcher.bundled.js` (~250 KB, all deps inlined).

### 2. Make the Windows .exe (Windows machine with Node 22)

Copy `patcher/dist/patcher.bundled.js` to a Windows machine, then run:

```
patcher\build-windows.cmd
```

This downloads no extra Node — it uses the `node.exe` already on your PATH.
It produces `patcher/dist/claude-rtl-patch.exe` via the official Node SEA
mechanism (single-executable-application).

### 3. Compile the installer (Windows machine with Inno Setup 6)

Install Inno Setup from https://jrsoftware.org/isinfo.php (free, open source).

Then either open `installer/windows/installer.iss` in the Inno Setup IDE and
press F9, or from the command line:

```
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\windows\installer.iss
```

Produces `installer/windows/Output/ClaudeRTLFix-Setup.exe` — the one-click
installer you ship to end users.

## Testing on a real Claude install

Without going through the installer:

```
# 1. Run the .exe manually as Administrator
runas /user:Administrator "claude-rtl-patch.exe"

# 2. Launch Claude, paste some Hebrew in a conversation, check the rendering

# 3. To revert:
claude-rtl-patch.exe --unpatch
```

The patcher writes a log to `C:\ProgramData\ClaudeRTLFix\log.txt` when
`--quiet` is used (the watcher always uses this). Tail it to debug:

```
Get-Content C:\ProgramData\ClaudeRTLFix\log.txt -Wait
```

## How the auto-reapply works

Anthropic distributes Claude as a signed MSIX package. When they ship a new
version, Windows installs it into a *new* directory under `WindowsApps` (e.g.
`Claude_1.6608.2.0_x64__pzs8sxrjxfjjc` → `Claude_1.6609.0.0_x64__pzs8sxrjxfjjc`)
and unregisters the old one.

The watcher task runs the patcher every 30 min. The patcher checks the
current install location via `Get-AppxPackage` — which always points to the
*latest* registered version — and applies the patch there if it isn't already
present.

This means:
- Patches applied to old version directories never need to be "undone" —
  Windows itself cleans up the old directory.
- The new version is patched within at most 30 minutes of being installed.
- Manual runs (or a logon event) can trigger re-patching sooner.

## File layout

```
claude-rtl-fix-desktop/
├── patcher/                      ← the patcher itself
│   ├── src/
│   │   ├── patch.js              ← main entry; CLI + orchestration
│   │   ├── integrity.js          ← fuse-flip + macOS re-sign
│   │   ├── windows-acl.js        ← takeown/icacls helpers
│   │   ├── embedded-payloads-source.js   ← dev-mode payload loader
│   │   └── payload/
│   │       ├── rtl-fix-hook.js   ← runs in Electron main process
│   │       └── rtl-fix-payload.js ← runs in renderer (the actual RTL logic)
│   ├── build.js                  ← bundles src/ + embeds payloads into dist/
│   ├── build-windows.cmd         ← Windows-only: SEA the bundle into .exe
│   └── package.json
├── installer/
│   └── windows/
│       ├── installer.iss         ← Inno Setup script for the installer
│       ├── watcher-task.xml      ← Scheduled-task definition
│       └── README.txt            ← Ships with the installed app
└── README.md                     ← this file
```
