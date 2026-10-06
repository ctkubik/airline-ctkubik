#!/bin/bash
# Control the app's background services on macOS.
#   macos/ctl.sh status    - are both services running, is the dashboard up
#   macos/ctl.sh start     - start both services
#   macos/ctl.sh stop      - stop both services (they stay stopped until start or reboot)
#   macos/ctl.sh restart   - restart both (e.g. after editing .env)
#   macos/ctl.sh logs      - follow the log files (Ctrl+C to quit)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABELS=("com.airline-checkin.web" "com.airline-checkin.worker" "com.airline-checkin.watchdog")
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

if [ -f "$REPO/.env" ]; then
    DATA_DIR="$(set -a; . "$REPO/.env" >/dev/null 2>&1; echo "${DATA_DIR:-}")"
    PORT="$(set -a; . "$REPO/.env" >/dev/null 2>&1; echo "${PORT:-}")"
fi
DATA_DIR="${DATA_DIR:-$REPO/data}"
PORT="${PORT:-3000}"

is_loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

start() {
    for label in "${LABELS[@]}"; do
        plist="$AGENTS_DIR/$label.plist"
        if [ ! -f "$plist" ]; then
            echo "Missing $plist. Run macos/install.sh first." >&2
            exit 1
        fi
        if is_loaded "$label"; then
            launchctl kickstart "$DOMAIN/$label"
        else
            launchctl bootstrap "$DOMAIN" "$plist"
        fi
    done
    echo "Started."
}

stop() {
    for label in "${LABELS[@]}"; do
        if is_loaded "$label"; then
            launchctl bootout "$DOMAIN/$label" || true
        fi
        # bootout is asynchronous; wait so an immediate start doesn't fail
        for _ in $(seq 1 30); do
            is_loaded "$label" || break
            sleep 0.5
        done
    done
    echo "Stopped."
}

restart() {
    for label in "${LABELS[@]}"; do
        if is_loaded "$label"; then
            launchctl kickstart -k "$DOMAIN/$label"
        else
            launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$label.plist"
        fi
    done
    echo "Restarted."
}

status() {
    for label in "${LABELS[@]}"; do
        if is_loaded "$label"; then
            pid="$(launchctl print "$DOMAIN/$label" | awk '/^\tpid =/ {print $3}')"
            echo "$label: running${pid:+ (pid $pid)}"
        else
            echo "$label: not running"
        fi
    done
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
        echo "Dashboard: http://localhost:$PORT (healthy)"
    else
        echo "Dashboard: not responding on port $PORT"
    fi
}

case "${1:-status}" in
    start) start ;;
    stop) stop ;;
    restart) restart ;;
    status) status ;;
    logs) tail -n 50 -F "$DATA_DIR/logs/web.log" "$DATA_DIR/logs/worker.log" "$DATA_DIR/logs/watchdog.log" ;;
    *)
        echo "usage: $0 status|start|stop|restart|logs" >&2
        exit 64
        ;;
esac
