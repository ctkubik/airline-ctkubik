#!/bin/bash
# Starts one half of the app in the foreground. launchd runs this (see
# install.sh); you normally don't call it yourself.
#   macos/run.sh web     - the Next.js dashboard on port 3000
#   macos/run.sh worker  - the Python check-in worker
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

# launchd starts with a bare environment; make Homebrew tools findable.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

export DATA_DIR="${DATA_DIR:-$REPO/data}"
export DB_PATH="${DB_PATH:-$DATA_DIR/checkin.db}"
mkdir -p "$DATA_DIR/logs"

# Keep logs from filling the disk: on each start, if this service's log is
# over 20 MB, keep its last 5 MB as <name>.log.1 and empty the live file.
# (Copy + truncate, because launchd holds the live file open.)
rotate_log() {
    local log="$DATA_DIR/logs/$1.log"
    if [ -f "$log" ] && [ "$(stat -f %z "$log" 2>/dev/null || echo 0)" -gt 20971520 ]; then
        tail -c 5242880 "$log" > "$log.1"
        : > "$log"
    fi
}
rotate_log "${1:-}"

find_node() {
    # The installer's private copy first; Homebrew paths for older installs.
    for candidate in "$REPO/runtime/node/bin/node" /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node; do
        [ -x "$candidate" ] && { echo "$candidate"; return; }
    done
    command -v node
}

case "${1:-}" in
    web)
        export NODE_ENV=production
        export NEXT_TELEMETRY_DISABLED=1
        export PORT="${PORT:-3000}"
        # 0.0.0.0 = reachable from other devices on your network / Tailscale.
        # Set BIND_ADDRESS=127.0.0.1 in .env to allow this Mac only.
        export HOSTNAME="${BIND_ADDRESS:-0.0.0.0}"
        cd "$REPO/frontend/.next/standalone"
        exec "$(find_node)" server.js
        ;;
    worker)
        cd "$REPO/worker"
        # caffeinate keeps the Mac awake while the worker runs, so a
        # check-in scheduled for 3am isn't missed because the Mac slept.
        exec /usr/bin/caffeinate -i -s "$REPO/.venv/bin/python" -u worker.py
        ;;
    *)
        echo "usage: $0 web|worker" >&2
        exit 64
        ;;
esac
