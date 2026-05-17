Claude RTL Fix
==============

A small patch for the Claude desktop app that fixes right-to-left text
rendering (Hebrew, Arabic, etc.) in chat messages.

WHAT IT DOES
------------
The patcher modifies Claude's app.asar file to inject a small script that runs
in every Claude window. That script sets dir="auto" on each text block, so the
browser's built-in Unicode bidi algorithm picks the correct text direction per
paragraph. Code blocks are forced to LTR.

WHAT'S RUNNING ON YOUR MACHINE
------------------------------
1. C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe
     The patcher binary. Idempotent — running it twice does nothing the
     second time.

2. Scheduled Task "ClaudeRTLFix\Watcher" running as SYSTEM
     Triggers: at boot, at every user logon, and every 30 minutes.
     Action:   runs the patcher with --quiet.
     Purpose:  re-applies the patch after Claude auto-updates. Anthropic ships
               updates as new MSIX versions which land in fresh, unpatched
               directories under C:\Program Files\WindowsApps — this task
               notices and patches the new install.

3. C:\ProgramData\ClaudeRTLFix\log.txt
     Patcher activity log. Truncated when it reaches ~1 MB.

4. C:\ProgramData\ClaudeRTLFix\backups\app.asar.<version>.rtlbak
     Backup of Claude's original asar from each version we patched. Safe to
     delete if you need the disk space.

UNINSTALL
---------
Use "Add or remove programs" in Windows Settings, or run the uninstaller in
this directory. Uninstall will:
  1. Remove the scheduled task.
  2. Run the patcher with --unpatch to restore Claude's original asar.
  3. Delete program files.

If you need to manually disable the patch without uninstalling, you can run:
    "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe" --unpatch

Then disable the scheduled task in Task Scheduler so it doesn't re-apply.

TROUBLESHOOTING
---------------
If Claude won't launch after install:
  1. Open PowerShell as Administrator.
  2. Run:   "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe" --unpatch
  3. Try launching Claude again.
  4. If it works, the patch is incompatible with this Claude version. Check
     for an update to Claude RTL Fix.

If the patch doesn't re-apply after a Claude update:
  Check C:\ProgramData\ClaudeRTLFix\log.txt for error messages.
  Manually run:  "C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe"  as admin.

SOURCE
------
https://github.com/your-fork/claude-rtl-fix-desktop
