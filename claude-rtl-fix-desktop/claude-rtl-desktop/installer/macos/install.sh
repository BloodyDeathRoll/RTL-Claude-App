#!/usr/bin/env bash
# Claude RTL Fix - macOS installer
#
# What this does:
#   1. Copies the patcher to /usr/local/lib/claude-rtl-fix/
#   2. Installs a LaunchDaemon (root-level background task) that re-patches
#      Claude automatically whenever Anthropic ships an update.
#      The daemon uses macOS WatchPaths — it fires the moment Claude's Resources
#      folder changes, not on a timer. No polling needed.
#   3. Patches the currently installed Claude.app right now.
#
# Requirements: Node 22+  (https://nodejs.org/)
# Run with:     sudo bash install.sh
#               (sudo is needed to write to /usr/local/lib and /Applications/Claude.app)

set -euo pipefail

INSTALL_DIR="/usr/local/lib/claude-rtl-fix"
DAEMON_LABEL="com.claudertlfix.watcher"
DAEMON_PLIST="/Library/LaunchDaemons/$DAEMON_LABEL.plist"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Two supported layouts:
#   1. Release ZIP (flat):  install.sh, package.json, src/ all in SCRIPT_DIR
#   2. Source tree:         installer/macos/install.sh with patcher/ two levels up
if [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/src" ]; then
  PATCHER_DIR="$SCRIPT_DIR"
elif [ -d "$SCRIPT_DIR/../../patcher" ]; then
  PATCHER_DIR="$(cd "$SCRIPT_DIR/../../patcher" && pwd)"
else
  echo "error: cannot locate patcher files." >&2
  echo "  expected either package.json + src/ next to install.sh," >&2
  echo "  or a patcher/ directory two levels above it." >&2
  exit 1
fi

# ---- require root ----
if [ "$(id -u)" -ne 0 ]; then
  echo "error: run this with sudo:" >&2
  echo "  sudo bash $0" >&2
  exit 1
fi

# ---- require Node 22+ ----
if ! command -v node &>/dev/null; then
  echo "error: Node.js not found. Install from https://nodejs.org/" >&2
  exit 1
fi
NODE="$(command -v node)"
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "error: Node 22 or newer required (found Node $NODE_MAJOR)." >&2
  exit 1
fi
echo "[check] node $NODE_MAJOR at $NODE — OK"

# ---- install patcher files ----
echo "[1/4] Installing patcher to $INSTALL_DIR..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -R "$PATCHER_DIR/src" "$INSTALL_DIR/"
cp "$PATCHER_DIR/package.json" "$INSTALL_DIR/"
[ -f "$PATCHER_DIR/package-lock.json" ] && cp "$PATCHER_DIR/package-lock.json" "$INSTALL_DIR/" || true

# ---- install npm deps ----
echo "[2/4] Installing npm dependencies..."
npm install --prefix "$INSTALL_DIR" --no-fund --no-audit --omit=dev 2>&1 | grep -v "^npm warn"

# ---- install LaunchDaemon ----
# The daemon runs as root (required to write inside /Applications/Claude.app).
# WatchPaths fires when Anthropic's updater replaces the Resources folder —
# no 30-minute polling loop needed, unlike the Windows Scheduled Task.
echo "[3/4] Installing LaunchDaemon (auto-reapply on Claude update)..."
cat > "$DAEMON_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>
  <string>$DAEMON_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$INSTALL_DIR/src/patch.js</string>
    <string>--quiet</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>/Applications/Claude.app/Contents/Resources</string>
    <string>/Applications/Claude.app</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict></plist>
PLIST

# bootout is safe to fail if the daemon isn't loaded yet
launchctl bootout system "$DAEMON_PLIST" 2>/dev/null || true
launchctl bootstrap system "$DAEMON_PLIST"
echo "       LaunchDaemon loaded."

# ---- patch Claude now ----
echo "[4/4] Patching Claude..."
"$NODE" "$INSTALL_DIR/src/patch.js"

echo ""
echo "Done. Claude is patched and the auto-reapply watcher is active."
echo "Hebrew and Arabic text will render correctly from the next Claude launch."
echo ""
echo "To uninstall:  sudo bash $(dirname "$0")/uninstall.sh"
