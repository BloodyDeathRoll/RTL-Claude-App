; Claude RTL Fix - Inno Setup installer
;
; Build:   compile this .iss with Inno Setup 6 (https://jrsoftware.org/isinfo.php)
;          Output:   Output\ClaudeRTLFix-Setup.exe
;
; Behavior at install:
;   1. Prompts for UAC (admin needed because we modify WindowsApps + create a SYSTEM task)
;   2. Copies claude-rtl-patch.exe + watcher-task.xml to "C:\Program Files\ClaudeRTLFix"
;   3. Runs claude-rtl-patch.exe once -> initial patch of the current Claude install
;   4. Imports watcher-task.xml via schtasks -> creates "\ClaudeRTLFix\Watcher" task running as SYSTEM
;
; Behavior at uninstall (reverse order):
;   1. Removes the scheduled task
;   2. Runs claude-rtl-patch.exe --unpatch to restore Claude's original asar
;   3. Removes program files
;
; The patcher itself is idempotent and the watcher will re-apply on Claude updates.

#define MyAppName       "Claude RTL Fix"
#define MyAppShortName  "ClaudeRTLFix"
#define MyAppVersion    "0.1.8"
#define MyAppPublisher  "Claude RTL Fix"
#define MyAppURL        "https://github.com/BloodyDeathRoll/RTL-Claude-App"

[Setup]
AppId={{B7E8AC4F-9F66-4F2A-9F12-7C9B17A0EF11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppShortName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=Output
OutputBaseFilename=ClaudeRTLFix-Setup
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\claude-rtl-patch.exe
CloseApplications=no
SetupLogging=yes

[Files]
Source: "..\..\patcher\dist\claude-rtl-patch.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "watcher-task.xml";                       DestDir: "{app}"; Flags: ignoreversion
Source: "README.txt";                             DestDir: "{app}"; Flags: ignoreversion isreadme

[Icons]
; Just a single uninstall entry — no Start Menu shortcut since there's no UI.
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Run]
; Add a Windows Defender exclusion for WindowsApps so the fuse-flip in
; Claude.exe isn't quarantined mid-write. Runs as admin (installer already
; elevated). Non-fatal: PowerShell exits non-zero if Defender isn't active.
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
    Parameters: "-NoProfile -NonInteractive -Command ""Add-MpPreference -ExclusionPath 'C:\Program Files\WindowsApps','C:\Program Files\ClaudeRTLFix'"""; \
    StatusMsg: "Configuring security exclusions..."; \
    Flags: runhidden waituntilterminated

; Initial patch of whatever Claude version is currently installed.
; --quiet suppresses interactive prompts (AV warning is already shown above
; as a dialog by NextButtonClick) and logs to C:\ProgramData\ClaudeRTLFix\log.txt.
Filename: "{app}\claude-rtl-patch.exe"; \
    Parameters: "--quiet"; \
    StatusMsg: "Patching current Claude install..."; \
    Flags: runhidden waituntilterminated

; Register the SYSTEM-context watcher task. /F overwrites any prior version.
Filename: "{sys}\schtasks.exe"; \
    Parameters: "/Create /TN ""\ClaudeRTLFix\Watcher"" /XML ""{app}\watcher-task.xml"" /F"; \
    StatusMsg: "Installing background watcher..."; \
    Flags: runhidden waituntilterminated

[UninstallRun]
; Remove the watcher first so it can't re-patch while we're tearing down.
Filename: "{sys}\schtasks.exe"; \
    Parameters: "/Delete /TN ""\ClaudeRTLFix\Watcher"" /F"; \
    Flags: runhidden waituntilterminated; \
    RunOnceId: "DelWatcherTask"

; Restore Claude's asar.
Filename: "{app}\claude-rtl-patch.exe"; \
    Parameters: "--unpatch"; \
    Flags: runhidden waituntilterminated; \
    RunOnceId: "UnpatchClaude"

[UninstallDelete]
Type: filesandordirs; Name: "{commonappdata}\{#MyAppShortName}"

[Code]
// Before copying files, stop the watcher task and kill any running patcher
// process so the installer can overwrite claude-rtl-patch.exe (which the
// watcher may be holding open from a previous install).
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then begin
    Exec(ExpandConstant('{sys}\schtasks.exe'),
         '/End /TN "\ClaudeRTLFix\Watcher"',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\taskkill.exe'),
         '/F /IM claude-rtl-patch.exe',
         '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ResultCode: Integer;
  Output: AnsiString;
begin
  Result := True;
  if CurPageID = wpReady then begin
    // Sanity check: is Claude actually installed? Warn but don't block — the
    // user may be pre-staging the patch before installing Claude.
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
                '-NoProfile -Command "if (Get-AppxPackage -Name Claude) { exit 0 } else { exit 1 }"',
                '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      // PowerShell missing? Unlikely on modern Windows. Skip the check.
      Exit;
    end;
    if ResultCode <> 0 then begin
      if MsgBox(
        'Claude does not appear to be installed on this machine.' #13#10 #13#10 +
        'The patcher will still install and the background watcher will apply ' +
        'the fix automatically once you install Claude.' #13#10 #13#10 +
        'Continue anyway?',
        mbConfirmation, MB_YESNO) = IDNO then
        Result := False;
    end;

    // Warn if a third-party AV is present. The installer adds a Defender
    // exclusion automatically, but it cannot do the same for Avast, Norton,
    // Bitdefender, etc. Ask the user to add the exclusion manually before
    // the patcher runs, so Claude.exe isn't quarantined mid-write.
    if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
            '-NoProfile -NonInteractive -Command ' +
            '"$n = (Get-CimInstance -Namespace root/SecurityCenter2 ' +
            '-ClassName AntiVirusProduct | ' +
            'Where-Object { $_.displayName -notmatch ''Defender'' } | ' +
            'Measure-Object).Count; if ($n -gt 0) { exit 1 } else { exit 0 }"',
            '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      if ResultCode = 1 then
        MsgBox(
          'Third-party antivirus detected.' #13#10 #13#10 +
          'The installer will add a Windows Defender exclusion automatically, ' +
          'but your third-party antivirus also needs an exclusion for:' #13#10 #13#10 +
          '    C:\Program Files\WindowsApps' #13#10 #13#10 +
          'Without it, your antivirus may quarantine Claude.exe during patching, ' +
          'which will prevent Claude from launching.' #13#10 #13#10 +
          'Please add the exclusion in your antivirus settings now, ' +
          'then click OK to continue with the installation.',
          mbInformation, MB_OK);
    end;
  end;
end;
