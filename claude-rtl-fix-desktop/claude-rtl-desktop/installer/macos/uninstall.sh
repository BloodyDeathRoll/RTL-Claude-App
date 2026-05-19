#!/usr/bin/env bash
# Claude RTL Fix - macOS uninstaller

set -euo pipefail

INSTALL_DIR="/usr/local/lib/claude-rtl-fix"
DAEMON_LABEL="com.claudertlfix.watcher"
DAEMON_PLIST="/Library/LaunchDaemons/$DAEMON_LABEL.plist"

if [ "$(id -u)" -ne 0 ]; then
  echo "error: run this with sudo:" >&2
  echo "  sudo bash $0" >&2
  exit 1
fi

echo "[1/3] Stopping watcher..."
launchctl bootout system "$DAEMON_PLIST" 2>/dev/null || true
rm -f "$DAEMON_PLIST"

echo "[2/3] Restoring Claude's original app.asar..."
if [ -f "$INSTALL_DIR/src/patch.js" ]; then
  node "$INSTALL_DIR/src/patch.js" --unpatch || true
else
  echo "       Patcher not found — skipping restore."
fi

echo "[3/3] Removing patcher files..."
rm -rf "$INSTALL_DIR"

echo ""
echo "Done. Claude has been restored and the watcher removed."
