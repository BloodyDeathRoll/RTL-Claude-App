# Installation Guide

## Windows

### Requirements

- Windows 10 or 11
- Claude desktop app already installed (from [claude.ai/download](https://claude.ai/download))

### Steps

1. Go to the [Releases](https://github.com/BloodyDeathRoll/RTL-Claude-App/releases) page and download **`ClaudeRTLFix-Setup.exe`**.

2. **SmartScreen warning** - Windows will show "Windows protected your PC" because the exe is not yet signed.
   Click **More info**, then **Run anyway**.

3. **UAC prompt** - Click **Yes** to allow the installer to run as administrator.

4. **If you have a third-party antivirus** (Avast, Norton, Bitdefender, Kaspersky, etc.):
   The installer will warn you if it detects one. Before clicking OK on that dialog, add these two folders as exclusions in your antivirus settings:
   ```
   C:\Program Files\WindowsApps
   C:\Program Files\ClaudeRTLFix
   ```
   Windows Defender is handled automatically - no manual step needed.

5. The installer patches Claude immediately. **Relaunch Claude** and Hebrew/Arabic text will render correctly.

A background task (Windows Scheduled Task, runs as SYSTEM) re-applies the patch within 30 minutes any time Anthropic ships a Claude update. You do not need to re-run the installer after updates.

### Uninstall

Settings → Apps → search "Claude RTL Fix" → Uninstall.

This restores Claude's original files and removes the background task.

---

## macOS

### Requirements

- macOS 12 (Monterey) or newer
- Claude desktop app installed in `/Applications` (from [claude.ai/download](https://claude.ai/download))
- **Node.js 22 or newer** - download from [nodejs.org](https://nodejs.org/) if you don't have it

  Check your version: open Terminal and run `node --version`. If it prints `v22.x.x` or higher you're ready.

### Steps

1. Go to the [Releases](https://github.com/BloodyDeathRoll/RTL-Claude-App/releases) page and download **`ClaudeRTLFix-macOS.zip`**.

2. Double-click the zip to extract it. You'll get a folder named `claude-rtl-fix-macos`.

3. Open **Terminal** (Applications → Utilities → Terminal).

4. `cd` into the extracted folder. For example, if it's in Downloads:
   ```bash
   cd ~/Downloads/claude-rtl-fix-macos
   ```

5. Run the installer:
   ```bash
   sudo bash install.sh
   ```
   Enter your Mac password when prompted. The script will install Node dependencies, register a background task, and patch Claude immediately.

6. **Relaunch Claude** and Hebrew/Arabic text will render correctly.

A LaunchDaemon (root-level background task) watches Claude's Resources folder and re-applies the patch automatically whenever Anthropic ships an update. No manual re-run needed.

### Uninstall

In Terminal, from the extracted folder:
```bash
sudo bash uninstall.sh
```

This stops the background task and restores Claude's original files.

---

## Troubleshooting

**Windows: antivirus quarantined something**
1. Open your AV's quarantine vault and restore the quarantined files.
2. Add `C:\Program Files\WindowsApps` and `C:\Program Files\ClaudeRTLFix` as exclusions.
3. From an administrator command prompt, run:
   ```
   "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe" --unpatch
   "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe"
   ```

**Windows: patch isn't applied after a Claude update**
The Scheduled Task runs every 30 minutes and at every logon. Wait up to 30 minutes, or trigger it manually from Task Scheduler: find `\ClaudeRTLFix\Watcher` and click **Run**.

**macOS: `node: command not found`**
Install Node.js 22 from [nodejs.org](https://nodejs.org/) and re-run the installer.

**macOS: Gatekeeper blocks Claude after patching**
Run this in Terminal:
```bash
sudo xattr -rd com.apple.quarantine /Applications/Claude.app
```

**macOS: patch isn't applied after a Claude update**
The LaunchDaemon fires automatically when Claude's Resources folder changes. If it doesn't trigger within a minute, you can patch manually:
```bash
sudo node /usr/local/lib/claude-rtl-fix/src/patch.js
```
