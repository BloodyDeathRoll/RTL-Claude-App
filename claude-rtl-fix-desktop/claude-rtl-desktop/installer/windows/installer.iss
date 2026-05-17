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
#define MyAppVersion    "0.1.0"
#define MyAppPublisher  "Claude RTL Fix"
#define MyAppURL        "https://github.com/your-fork/claude-rtl-fix-desktop"

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
; Initial patch of whatever Claude version is currently installed.
Filename: "{app}\claude-rtl-patch.exe"; \
    Parameters: ""; \
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
  end;
end;
