#!/bin/bash
# Stop and remove the app's background services on macOS.
# Your data (./data and .env) is left in place; delete those yourself if you
# want a clean slate.
set -euo pipefail

AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

for label in com.airline-checkin.web com.airline-checkin.worker com.airline-checkin.watchdog; do
    launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    rm -f "$AGENTS_DIR/$label.plist"
    echo "Removed $label"
done
echo "Background services removed. Data and settings were kept."
