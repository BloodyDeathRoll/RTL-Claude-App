# Releasing

End-to-end process for cutting a new release (e.g. `0.1.9` → `0.1.10`). Every
step runs on any platform: GitHub Actions builds and publishes the installers on
its own runners when you push the tag. Replace `X.Y.Z` with the new version
throughout.

All paths are relative to the working tree root:
`claude-rtl-fix-desktop/claude-rtl-desktop/`.

## 1. Bump the version (any platform)

Three places must agree:

| File | Field |
| --- | --- |
| `patcher/package.json` | `"version": "X.Y.Z"` |
| `installer/windows/installer.iss` | `#define MyAppVersion "X.Y.Z"` |
| `patcher/src/payload/rtl-fix-read.js` | `var BUILD_STAMP = 'X.Y.Z';` |

`BUILD_STAMP` is what `<html data-claude-rtl-build="...">` reports in DevTools —
it's how you confirm the live app is running the new payload, so keep it in sync.

## 2. Rebuild the bundle and commit (any platform)

```sh
cd patcher && node build.js     # refreshes dist/ (gitignored) + embedded payloads
cd ..
git add -A
git commit -m "chore(release): bump version to X.Y.Z"
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push origin vX.Y.Z
```

`dist/` and `installer/windows/Output/` are gitignored build artifacts — they are
NOT committed; they're rebuilt per release and uploaded to the GitHub Release.

## 3. That's it — CI builds and publishes

Pushing the `vX.Y.Z` tag in step 2 is the whole release. `.github/workflows/release.yml`
runs on any `v*` tag and does everything:

| Job | Runner | What it does |
| --- | --- | --- |
| `test-macos` | `macos-latest` | installs Claude via Homebrew, patches, verifies the `__rtlFixOriginalMain` marker, unpatches, verifies removal — the correctness gate |
| `build-windows` | `windows-latest` | `choco install innosetup`, then `build-all.cmd` → `ClaudeRTLFix-Setup.exe` |
| `publish-release` | `ubuntu-latest` | creates the GitHub Release with both artifacts attached |

**You do NOT need Node, Inno Setup, or a Windows machine to cut a release.** The
runner installs its own toolchain. Do not build locally and upload by hand — the
tag push already produced and published the artifacts.

Watch it:

```sh
gh run list --limit 3
gh run watch <run-id> --exit-status
gh release view vX.Y.Z --json assets --jq '.assets[] | "\(.name)  \(.size) bytes"'
```

Expect ~2 minutes end to end. A published `vX.Y.Z` carries `ClaudeRTLFix-Setup.exe`
(~23 MB) and `ClaudeRTLFix-macOS.zip` (~30 KB), and the
[releases page](https://github.com/BloodyDeathRoll/RTL-Claude-App/releases)
serves the new installer to everyone immediately.

If CI is unavailable and you must build by hand, `build-all.cmd` on Windows needs
Node 22 + Inno Setup 6 at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe` (override
via the `ISCC` env var), then `gh release upload vX.Y.Z "installer/windows/Output/ClaudeRTLFix-Setup.exe"`.
This is the fallback, not the process.

## 4. Verify the shipped build

Install the published `.exe` on a clean Windows VM / spare machine and verify RTL
works on real streamed Hebrew responses (Latin-prefixed paragraphs, numbered +
bulleted lists, a table, fenced code) in both EN and HE modes. Confirm
`document.documentElement.getAttribute('data-claude-rtl-build')` in DevTools
reports `X.Y.Z`.

For a quick no-repo test of just the payload (no installer at all), copy
`patcher/dist/patcher.bundled.js` to the test machine and run, in admin
PowerShell: `node patcher.bundled.js --unpatch` then `node patcher.bundled.js`.

To test **watcher** behavior specifically, note the watcher runs as SYSTEM and
admin-as-you is not equivalent. Temporarily repoint the existing task:

```powershell
schtasks /Change /TN "\ClaudeRTLFix\Watcher" /TR "'C:\Program Files\nodejs\node.exe' C:\ProgramData\ClaudeRTLFix\patcher.bundled.js --quiet"
schtasks /Run /TN "\ClaudeRTLFix\Watcher"
Start-Sleep 60
Get-Content C:\ProgramData\ClaudeRTLFix\log.txt -Tail 5
schtasks /Change /TN "\ClaudeRTLFix\Watcher" /TR "'C:\Program Files\ClaudeRTLFix\claude-rtl-patch.exe' --quiet"
```
