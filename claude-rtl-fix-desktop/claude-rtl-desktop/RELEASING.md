# Releasing

End-to-end process for cutting a new release (e.g. `0.1.8` → `0.1.9`). Most of
the prep is platform-agnostic; the installer artifacts must be built on Windows
(and, optionally, macOS). Replace `X.Y.Z` with the new version throughout.

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

## 3. Build the installers

### Windows (required) — needs Node 22 + Inno Setup 6

```cmd
git pull
cd claude-rtl-fix-desktop\claude-rtl-desktop
build-all.cmd
```

Produces `installer\windows\Output\ClaudeRTLFix-Setup.exe`.

### macOS (optional, experimental)

The macOS code path (`src/integrity.js`) is untested on real hardware. Only ship
`ClaudeRTLFix-macOS.zip` if you've actually verified it; otherwise omit it and
drop the macOS line from the release notes.

## 4. Test before publishing

Install the freshly built `.exe` on a clean Windows VM / spare machine and verify
RTL works on real streamed Hebrew responses (Latin-prefixed paragraphs, numbered
+ bulleted lists, a table, fenced code) in both EN and HE modes. Confirm
`document.documentElement.getAttribute('data-claude-rtl-build')` in DevTools
reports `X.Y.Z`.

For a quick no-repo test of just the payload (no installer rebuild), copy
`patcher/dist/patcher.bundled.js` to the test machine and run, in admin
PowerShell: `node patcher.bundled.js --unpatch` then `node patcher.bundled.js`.

## 5. Publish the GitHub Release

A draft can be created up front (notes only, not public). To attach the built
artifacts and go live:

```sh
gh release upload vX.Y.Z "installer/windows/Output/ClaudeRTLFix-Setup.exe" \
  --repo BloodyDeathRoll/RTL-Claude-App
# (optional) gh release upload vX.Y.Z "ClaudeRTLFix-macOS.zip" --repo BloodyDeathRoll/RTL-Claude-App
gh release edit vX.Y.Z --draft=false --latest --repo BloodyDeathRoll/RTL-Claude-App
```

To create the release from scratch instead (tag must already be pushed):

```sh
gh release create vX.Y.Z --repo BloodyDeathRoll/RTL-Claude-App \
  --title "vX.Y.Z — <summary>" --notes "<notes>" \
  "installer/windows/Output/ClaudeRTLFix-Setup.exe"
```

Once published as `--latest`, the
[releases page](https://github.com/BloodyDeathRoll/RTL-Claude-App/releases)
serves the new installer to everyone.
