#!/bin/bash
# One-command install (and update) for running the app natively on macOS.
#
#   ./macos/install.sh
#
# Safe to run again: after `git pull`, re-run it to rebuild and restart.
# What it does:
#   1. Installs Python 3.13, Node 22 and Google Chrome with Homebrew (if missing)
#   2. Creates a Python virtual environment and installs the worker's packages
#   3. Builds the web dashboard
#   4. Creates .env with a random login password (first run only)
#   5. Registers two background services (launchd) that start at login and
#      restart automatically if they crash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux, use Docker (see README)."

# macOS privacy protection blocks background services from reading these
# folders, which makes the services fail with "Operation not permitted".
case "$REPO" in
    "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*|"$HOME/Library/Mobile Documents"*)
        die "The app is in a protected folder ($REPO).
Background services can't read Documents, Desktop, Downloads or iCloud Drive.
Move it first, for example:
    mv \"$REPO\" ~/airline-ctkubik && cd ~/airline-ctkubik && ./macos/install.sh"
        ;;
esac

# ── 1. Homebrew packages ─────────────────────────────────────────────────
step "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1; then
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        [ -x "$b" ] && eval "$("$b" shellenv)"
    done
fi
command -v brew >/dev/null 2>&1 || die "Homebrew isn't installed. Install it from https://brew.sh, then run this again."

step "Installing Python 3.13 and Node 22 (skipped if already installed)"
brew list python@3.13 >/dev/null 2>&1 || brew install python@3.13
brew list node@22 >/dev/null 2>&1 || brew install node@22

PYTHON="$(brew --prefix python@3.13)/bin/python3.13"
NODE_DIR="$(brew --prefix node@22)/bin"
export PATH="$NODE_DIR:$PATH"
[ -x "$PYTHON" ] || die "Python 3.13 not found at $PYTHON"

if [ ! -d "/Applications/Google Chrome.app" ] && [ ! -d "$HOME/Applications/Google Chrome.app" ]; then
    step "Installing Google Chrome"
    brew install --cask google-chrome
fi

# ── 2. Python worker ─────────────────────────────────────────────────────
step "Setting up the Python worker"
if [ -x .venv/bin/python ] && ! .venv/bin/python -c 'import sys; sys.exit(sys.version_info[:2] != (3, 13))'; then
    echo "Recreating .venv with Python 3.13"
    rm -rf .venv
fi
[ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip
.venv/bin/python -m pip install --quiet -r worker/requirements.txt

# ── 3. Web dashboard ─────────────────────────────────────────────────────
step "Building the web dashboard (takes a minute or two)"
(
    cd frontend
    export NEXT_TELEMETRY_DISABLED=1
    npm ci --no-audit --no-fund --loglevel=error
    npm run build
    rm -rf .next/standalone/.next/static
    cp -R .next/static .next/standalone/.next/static
    if [ -d public ]; then rm -rf .next/standalone/public && cp -R public .next/standalone/public; fi
    node -e "require('./.next/standalone/node_modules/better-sqlite3')"
)

# ── 4. Settings (.env) ───────────────────────────────────────────────────
step "Checking settings (.env)"
GENERATED_PASSWORD=""
random_hex() { LC_ALL=C openssl rand -hex "$1"; }
set_env() {  # set_env KEY VALUE: replace the line if present, else append
    if grep -qE "^#?$1=" .env; then
        KEY="$1" VALUE="$2" perl -pi -e 's/^#?\Q$ENV{KEY}\E=.*/$ENV{KEY}=$ENV{VALUE}/' .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}
if [ ! -f .env ]; then
    cp .env.example .env
    chmod 600 .env
    echo "Created .env from .env.example"
fi
current() { (set -a; . ./.env >/dev/null 2>&1; eval "echo \"\${$1:-}\""); }
if [ -z "$(current AUTH_SECRET)" ] || [ "$(current AUTH_SECRET)" = "replace-with-a-long-random-string" ]; then
    set_env AUTH_SECRET "$(random_hex 32)"
fi
if [ -z "$(current AUTH_PASSWORD)" ] || [ "$(current AUTH_PASSWORD)" = "changeme" ]; then
    GENERATED_PASSWORD="$(random_hex 8)"
    set_env AUTH_PASSWORD "$GENERATED_PASSWORD"
fi
[ -n "$(current AUTH_USERNAME)" ] || set_env AUTH_USERNAME admin

DATA_DIR="$(current DATA_DIR)"
DATA_DIR="${DATA_DIR:-$REPO/data}"
PORT="$(current PORT)"
PORT="${PORT:-3000}"
mkdir -p "$DATA_DIR/logs"

# ── 5. Background services (launchd) ─────────────────────────────────────
step "Installing background services"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
mkdir -p "$AGENTS_DIR"

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

write_agent() {  # write_agent NAME
    local label="com.airline-checkin.$1"
    local plist="$AGENTS_DIR/$label.plist"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$(xml_escape "$REPO/macos/run.sh")</string>
        <string>$1</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(xml_escape "$REPO")</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!-- Interactive = macOS won't throttle or App Nap the service -->
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$(xml_escape "$DATA_DIR/logs/$1.log")</string>
    <key>StandardErrorPath</key>
    <string>$(xml_escape "$DATA_DIR/logs/$1.log")</string>
</dict>
</plist>
PLIST
    plutil -lint "$plist" >/dev/null
    launchctl bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$plist"
    echo "  $label"
}
write_agent web
write_agent worker

step "Waiting for the dashboard to come up"
for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" && break
    sleep 1
done
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
    echo "Dashboard is up."
else
    warn "The dashboard didn't answer yet. Check the log: tail -50 \"$DATA_DIR/logs/web.log\""
fi

# ── Power settings ───────────────────────────────────────────────────────
step "Keeping the Mac awake"
echo "A sleeping Mac misses check-ins. The worker already holds the Mac awake"
echo "while it runs. These settings also restart the Mac after a power cut:"
echo "    sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1"
if [ -t 0 ]; then
    read -r -p "Apply them now? (asks for your Mac password) [y/N] " answer
    if [[ "$answer" =~ ^[Yy] ]]; then
        sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1 && echo "Power settings applied."
    fi
fi

# ── Done ─────────────────────────────────────────────────────────────────
echo
bold "All set."
echo "  Dashboard:  http://localhost:$PORT  (from other devices: http://$(scutil --get LocalHostName 2>/dev/null || hostname).local:$PORT)"
echo "  Username:   $(current AUTH_USERNAME)"
if [ -n "$GENERATED_PASSWORD" ]; then
    echo "  Password:   $GENERATED_PASSWORD   (saved in .env)"
else
    echo "  Password:   the AUTH_PASSWORD in .env"
fi
echo
echo "  Status / logs:  ./macos/ctl.sh status   |   ./macos/ctl.sh logs"
echo "  Update later:   git pull && ./macos/install.sh"
echo
echo "Two things only you can do (see MACOS.md):"
echo "  1. Turn on automatic login: System Settings > Users & Groups > Automatically log in as."
echo "     The services run in your login session, so the Mac must log in by itself after a restart."
echo "  2. Optional local AI: in LM Studio, load a model and start the server, then set"
echo "     LLM_ENABLED=true in .env and run ./macos/ctl.sh restart"
