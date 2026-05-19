Claude RTL Fix
==============

A small patch for the Claude desktop app that fixes right-to-left text
rendering (Hebrew, Arabic, etc.) in chat messages.

SOURCE & LATEST RELEASE
------------------------
https://github.com/BloodyDeathRoll/RTL-Claude-App


ANTIVIRUS — READ THIS FIRST
----------------------------
This tool modifies files inside C:\Program Files\WindowsApps\ (where
Claude's MSIX package lives) and modifies Claude.exe to disable an
Electron integrity check. These are legitimate operations, but they
look identical to what malware patchers do. Some antivirus products
will quarantine the patcher or the modified files.

Windows Defender is handled automatically — the installer adds exclusions
for the two relevant folders before the patcher runs.

Third-party antivirus (Avast, Norton, Bitdefender, Kaspersky, etc.):
Before running the installer, add these two folders as exclusions in your
antivirus settings:

    C:\Program Files\WindowsApps
    C:\Program Files\ClaudeRTLFix

If your AV quarantines something after install:
  1. Restore the quarantined files from your AV's quarantine vault.
  2. Confirm the exclusions above are saved.
  3. Run claude-rtl-patch.exe --unpatch, then claude-rtl-patch.exe again.


WHAT IT DOES
------------
The patcher modifies Claude's app.asar to inject a small hook that runs
before Claude's own code. The hook:
  - Injects CSS that sets unicode-bidi:plaintext on text blocks (equivalent
    to dir="auto") so the browser picks LTR or RTL per paragraph.
  - Forces direction:ltr on code blocks so code is never mirrored.
  - Sets dir="auto" on list elements so bullet/number markers appear on
    the correct side for RTL content.


WHAT'S RUNNING ON YOUR MACHINE
-------------------------------
1. C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe
     The patcher binary. Idempotent — running it twice does nothing the
     second time.

2. Scheduled Task "ClaudeRTLFix\Watcher" running as SYSTEM
     Triggers: at boot, at every user logon, and every 30 minutes.
     Action:   runs the patcher with --quiet.
     Purpose:  re-applies the patch after Claude auto-updates. Anthropic
               ships updates as new MSIX versions in fresh, unpatched
               directories — this task patches the new install automatically.

3. C:\ProgramData\ClaudeRTLFix\log.txt
     Patcher activity log. Truncated when it reaches ~1 MB.

4. C:\ProgramData\ClaudeRTLFix\backups\app.asar.<version>.rtlbak
     Backup of Claude's original asar. Safe to delete if you need space.


UNINSTALL
---------
Use "Add or remove programs" in Windows Settings, or run the uninstaller in
this directory. Uninstall will:
  1. Remove the scheduled task.
  2. Run the patcher with --unpatch to restore Claude's original asar.
  3. Delete program files.

To manually disable the patch without uninstalling:
    "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe" --unpatch
Then disable the scheduled task in Task Scheduler so it doesn't re-apply.


TROUBLESHOOTING
---------------
Claude won't launch after install:
  1. Open PowerShell as Administrator.
  2. Run: "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe" --unpatch
  3. Try launching Claude again.
  4. If it works, report the issue at the GitHub link above.

Patch doesn't re-apply after a Claude update:
  Check C:\ProgramData\ClaudeRTLFix\log.txt for error messages.
  Manually run claude-rtl-patch.exe as Administrator.

Installer fails with "Access is denied" on claude-rtl-patch.exe:
  This means the watcher task is running and holding the file open.
  Open Task Scheduler, find ClaudeRTLFix\Watcher, right-click > End,
  then retry the installation.
