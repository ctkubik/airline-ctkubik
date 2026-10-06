#!/bin/bash
# Installs (or updates) the app to run natively on this Mac.
#
# Most people never run this directly: double-click "Install on Mac.command"
# (or use the one-line bootstrap in MACOS.md), which puts the app in
# ~/airline-ctkubik and then runs this script.
#
# What it does, with no Homebrew, git or admin rights needed:
#   1. Downloads private copies of Python 3.13 and Node 22 into ./runtime
#      (checksums verified) and Google Chrome if it isn't installed
#   2. Installs the worker's packages and builds the web dashboard
#   3. Creates .env with a random login password (first run only), and turns
#      on the local AI features if LM Studio is installed
#   4. Registers two background services (launchd) that start at login and
#      restart automatically if they crash
#   5. Adds "Airline Check-In" to ~/Applications, which opens the dashboard
#   6. Offers (via macOS dialogs) to keep the Mac awake and to set up
#      automatic login, then opens the dashboard
#
# Safe to run again at any time; it keeps your data and settings.
# Set AIRLINE_NONINTERACTIVE=1 to skip all dialogs (used by CI).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

NONINTERACTIVE="${AIRLINE_NONINTERACTIVE:-}"
APP_NAME="Airline Check-In"
RUNTIME="$REPO/runtime"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*"; }

# dialog MESSAGE [BUTTON...]: native macOS dialog; prints the button clicked.
# The last button is the default. Prints nothing when non-interactive.
dialog() {
    [ -n "$NONINTERACTIVE" ] && return 0
    osascript - "$APP_NAME" "$@" <<'APPLESCRIPT' 2>/dev/null || true
on run argv
    set theTitle to item 1 of argv
    set theMessage to item 2 of argv
    if (count of argv) > 2 then
        set theButtons to items 3 thru -1 of argv
    else
        set theButtons to {"OK"}
    end if
    set theResult to display dialog theMessage with title theTitle buttons theButtons default button (count of theButtons) with icon note
    return button returned of theResult
end run
APPLESCRIPT
}

die() {
    printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
    dialog "Installation stopped: $*

The Terminal window has the details." "OK" >/dev/null
    exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Linux, use Docker (see README)."

# macOS privacy protection blocks background services from reading these
# folders, which makes the services fail with "Operation not permitted".
case "$REPO" in
    "$HOME/Documents"*|"$HOME/Desktop"*|"$HOME/Downloads"*|"$HOME/Library/Mobile Documents"*)
        die "the app is in a protected folder ($REPO). Double-click \"Install on Mac.command\" instead, which installs to your home folder."
        ;;
esac

case "$(uname -m)" in
    arm64) NODE_ARCH=arm64; PY_TRIPLE=aarch64-apple-darwin ;;
    x86_64) NODE_ARCH=x64; PY_TRIPLE=x86_64-apple-darwin ;;
    *) die "unsupported Mac processor: $(uname -m)" ;;
esac

download() {  # download URL FILE
    curl -fL --retry 3 --retry-delay 2 --progress-bar -o "$2" "$1" || die "couldn't download $1. Check the internet connection and try again."
}

# ── 1. Runtimes ──────────────────────────────────────────────────────────
mkdir -p "$RUNTIME"

step "Python 3.13"
PYTHON="$RUNTIME/python/bin/python3.13"
if [ -x "$PYTHON" ]; then
    echo "Already installed ($("$PYTHON" --version))"
else
    # Relocatable builds from the python-build-standalone project (the same
    # builds uv and other tools install), checked against their SHA256SUMS.
    # Plain download links first: they aren't subject to the GitHub API's
    # 60-requests-an-hour limit for anonymous users.
    pbs="https://github.com/astral-sh/python-build-standalone/releases"
    py_tag="$(curl -fsSI "$pbs/latest" | awk 'tolower($1) == "location:" {print $2}' \
        | tr -d '\r' | sed -n 's#.*/releases/tag/##p' || true)"
    py_file=""
    expected=""
    if [ -n "$py_tag" ] && curl -fsSL -o "$TMP/SHA256SUMS" "$pbs/download/$py_tag/SHA256SUMS"; then
        py_file="$(awk '{print $2}' "$TMP/SHA256SUMS" \
            | grep -E "^cpython-3\.13\.[0-9]+\+[0-9]+-$PY_TRIPLE-install_only\.tar\.gz$" | head -1 || true)"
        expected="$(awk -v f="$py_file" '$2 == f {print $1}' "$TMP/SHA256SUMS")"
        py_url="$pbs/download/$py_tag/${py_file//+/%2B}"
    fi
    if [ -z "$py_file" ]; then
        # Fallback: the GitHub API's release listing (uses GITHUB_TOKEN if set)
        auth=()
        [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
        # ${auth[@]+...}: macOS's bash 3.2 treats an empty array as unset under set -u
        release_json="$(curl -fsSL ${auth[@]+"${auth[@]}"} https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest)" \
            || die "couldn't reach GitHub to download Python. Wait a few minutes and try again."
        py_url="$(printf '%s' "$release_json" \
            | grep -oE "https://[^\"]*/cpython-3\.13\.[0-9]+(%2B|\+)[0-9]+-$PY_TRIPLE-install_only\.tar\.gz" | head -1 || true)"
        [ -n "$py_url" ] || die "couldn't find a Python 3.13 download for this Mac"
        py_file="$(basename "$py_url" | sed 's/%2B/+/g')"
        sums_url="$(printf '%s' "$release_json" | grep -oE 'https://[^"]*/SHA256SUMS' | head -1 || true)"
        if [ -n "$sums_url" ]; then
            download "$sums_url" "$TMP/SHA256SUMS"
            expected="$(awk -v f="$py_file" '$2 == f {print $1}' "$TMP/SHA256SUMS")"
        else
            download "$py_url.sha256" "$TMP/py.sha256"
            expected="$(awk '{print $1}' "$TMP/py.sha256")"
        fi
    fi
    download "$py_url" "$TMP/$py_file"
    [ -n "$expected" ] || die "no checksum published for $py_file"
    echo "$expected  $TMP/$py_file" | shasum -a 256 -c - >/dev/null || die "Python download failed its checksum"
    rm -rf "$RUNTIME/python"
    tar -xzf "$TMP/$py_file" -C "$RUNTIME"
    [ -x "$PYTHON" ] || die "Python unpacked but $PYTHON is missing"
    echo "Installed $("$PYTHON" --version)"
fi

step "Node 22"
NODE="$RUNTIME/node/bin/node"
if [ -x "$NODE" ] && [[ "$("$NODE" --version)" == v22.* ]]; then
    echo "Already installed ($("$NODE" --version))"
else
    node_base="https://nodejs.org/dist/latest-v22.x"
    download "$node_base/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
    node_line="$(grep -E "node-v22\.[0-9.]+-darwin-$NODE_ARCH\.tar\.gz$" "$TMP/SHASUMS256.txt" | head -1 || true)"
    [ -n "$node_line" ] || die "couldn't find a Node 22 download for this Mac"
    node_file="${node_line##* }"
    download "$node_base/$node_file" "$TMP/$node_file"
    echo "${node_line%% *}  $TMP/$node_file" | shasum -a 256 -c - >/dev/null || die "Node download failed its checksum"
    rm -rf "$RUNTIME/node"
    mkdir -p "$RUNTIME/node"
    tar -xzf "$TMP/$node_file" -C "$RUNTIME/node" --strip-components 1
    echo "Installed Node $("$NODE" --version)"
fi
export PATH="$RUNTIME/node/bin:$PATH"

step "Google Chrome"
CHROME_APP=""
for candidate in "/Applications/Google Chrome.app" "$HOME/Applications/Google Chrome.app"; do
    [ -d "$candidate" ] && CHROME_APP="$candidate" && break
done
if [ -n "$CHROME_APP" ]; then
    echo "Already installed ($CHROME_APP)"
else
    download "https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg" "$TMP/chrome.dmg"
    mount_point="$TMP/chrome-mount"
    mkdir -p "$mount_point"
    hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount_point" "$TMP/chrome.dmg" || die "couldn't open the Chrome installer"
    # Only install a Chrome that is validly signed by Google (team EQHXZ8M8AV)
    if ! codesign --verify --strict "$mount_point/Google Chrome.app" 2>/dev/null \
        || ! codesign -dv "$mount_point/Google Chrome.app" 2>&1 | grep -q "TeamIdentifier=EQHXZ8M8AV"; then
        hdiutil detach -quiet "$mount_point" || true
        die "the Chrome download failed its signature check"
    fi
    if [ -w /Applications ]; then
        CHROME_APP="/Applications/Google Chrome.app"
    else
        mkdir -p "$HOME/Applications"
        CHROME_APP="$HOME/Applications/Google Chrome.app"
    fi
    ditto "$mount_point/Google Chrome.app" "$CHROME_APP"
    hdiutil detach -quiet "$mount_point" || true
    echo "Installed to $CHROME_APP"
fi

# ── 2. Worker and dashboard ──────────────────────────────────────────────
step "Setting up the Python worker"
# Rebuild the virtual environment if it was made with a different Python
# (for example by an older, Homebrew-based version of this installer).
if [ -f .venv/pyvenv.cfg ] && ! grep -q "$RUNTIME/python" .venv/pyvenv.cfg; then
    echo "Recreating .venv with the bundled Python"
    rm -rf .venv
fi
[ -x .venv/bin/python ] || "$PYTHON" -m venv .venv
.venv/bin/python -m pip install --quiet --disable-pip-version-check --upgrade pip
.venv/bin/python -m pip install --quiet --disable-pip-version-check -r worker/requirements.txt

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
) || die "the dashboard build failed"

# ── 3. Settings (.env) ───────────────────────────────────────────────────
step "Checking settings (.env)"
GENERATED_PASSWORD=""
random_hex() { LC_ALL=C openssl rand -hex "$1"; }
set_env() {  # set_env KEY VALUE: replace the line (even if commented out), else append
    if grep -qE "^#?$1=" .env; then
        KEY="$1" VALUE="$2" perl -pi -e 's/^#?\Q$ENV{KEY}\E=.*/$ENV{KEY}=$ENV{VALUE}/' .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
}
current() { (set -a; . ./.env >/dev/null 2>&1; eval "echo \"\${$1:-}\""); }

if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env"
fi
chmod 600 .env
if [ -z "$(current AUTH_SECRET)" ] || [ "$(current AUTH_SECRET)" = "replace-with-a-long-random-string" ]; then
    set_env AUTH_SECRET "$(random_hex 32)"
fi
if [ -z "$(current AUTH_PASSWORD)" ] || [ "$(current AUTH_PASSWORD)" = "changeme" ]; then
    GENERATED_PASSWORD="$(random_hex 8)"
    set_env AUTH_PASSWORD "$GENERATED_PASSWORD"
fi
[ -n "$(current AUTH_USERNAME)" ] || set_env AUTH_USERNAME admin
if [ "$CHROME_APP" = "$HOME/Applications/Google Chrome.app" ]; then
    set_env CHROME_PATH "$CHROME_APP/Contents/MacOS/Google Chrome"
fi

# Local AI: turn it on automatically when LM Studio is installed. The app
# shows "Not reachable" in Settings and carries on if LM Studio isn't running.
if [ -d "/Applications/LM Studio.app" ] || [ -d "$HOME/Applications/LM Studio.app" ] || [ -d "$HOME/.lmstudio" ]; then
    if [ -z "$(current LLM_ENABLED)" ]; then
        set_env LLM_ENABLED true
        echo "LM Studio found: local AI features turned on"
    fi
    if [ -x "$HOME/.lmstudio/bin/lms" ]; then
        "$HOME/.lmstudio/bin/lms" server start >/dev/null 2>&1 && echo "Started LM Studio's server" || true
    fi
fi

DATA_DIR="$(current DATA_DIR)"
DATA_DIR="${DATA_DIR:-$REPO/data}"
PORT="$(current PORT)"
PORT="${PORT:-3000}"
mkdir -p "$DATA_DIR/logs"

# ── 4. Background services (launchd) ─────────────────────────────────────
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
    restart_agent "$label" "$plist" || die "couldn't start the $1 service"
    echo "  $label"
}

# launchctl bootout returns before the old service has fully stopped, and
# bootstrapping again too soon fails with "5: Input/output error" (the
# update path). Wait for it to go away, then retry the bootstrap briefly.
restart_agent() {  # restart_agent LABEL PLIST
    launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 || true
    for _ in $(seq 1 30); do
        launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || break
        sleep 0.5
    done
    for _ in 1 2 3 4 5; do
        launchctl bootstrap "$DOMAIN" "$2" 2>/dev/null && return 0
        sleep 2
    done
    launchctl bootstrap "$DOMAIN" "$2"
}
write_agent web
write_agent worker

step "Waiting for the dashboard to come up"
healthy=""
for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health"; then healthy=1; break; fi
    sleep 1
done
[ -n "$healthy" ] && echo "Dashboard is up." \
    || warn "The dashboard didn't answer yet. Check the log: tail -50 \"$DATA_DIR/logs/web.log\""

# ── 5. Launcher app ──────────────────────────────────────────────────────
step "Adding \"$APP_NAME\" to your Applications folder"
LAUNCHER="$HOME/Applications/$APP_NAME.app"
mkdir -p "$HOME/Applications"
rm -rf "$LAUNCHER"
osacompile -o "$LAUNCHER" -e "open location \"http://localhost:$PORT\"" >/dev/null
echo "  $LAUNCHER"

# ── 6. Keep the Mac awake and able to restart unattended ─────────────────
step "Power and login settings"
power_ok() {
    pmset -g | awk '$1 == "sleep" && $2 == "0" {s=1} $1 == "autorestart" && $2 == "1" {a=1} END {exit !(s && a)}'
}
if power_ok; then
    echo "Sleep is off and restart-after-power-cut is on."
elif [ -z "$NONINTERACTIVE" ]; then
    if osascript -e 'do shell script "pmset -a sleep 0 disksleep 0 autorestart 1 womp 1" with prompt "Airline Check-In wants to stop this Mac from sleeping and have it restart after a power cut, so it never misses a check-in." with administrator privileges' >/dev/null 2>&1; then
        echo "Power settings applied."
    else
        warn "Power settings skipped. The worker still keeps the Mac awake while it runs."
    fi
fi

AUTOLOGIN_USER="$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || true)"
if [ "$AUTOLOGIN_USER" = "$(id -un)" ]; then
    echo "Automatic login is on."
else
    warn "Automatic login is off: after a restart, nothing runs until someone logs in."
    if fdesetup isactive >/dev/null 2>&1; then
        autologin_note="Automatic login isn't available while FileVault is on. To use it, turn FileVault off in Privacy & Security first."
    else
        autologin_note="In the window that opens, choose \"Automatically log in as\" and pick your user."
    fi
    if [ "$(dialog "One last setting: automatic login.

The app runs while you're logged in. If the Mac restarts (power cut, macOS update) it needs to log you in by itself, or check-ins wait until someone does.

$autologin_note" "Later" "Open Settings")" = "Open Settings" ]; then
        open "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension" 2>/dev/null \
            || open "/System/Library/PreferencePanes/Accounts.prefPane"
    fi
fi

# ── Done ─────────────────────────────────────────────────────────────────
USERNAME="$(current AUTH_USERNAME)"
LAN_NAME="$(scutil --get LocalHostName 2>/dev/null || hostname)"
echo
bold "All set."
echo "  Dashboard:  http://localhost:$PORT  (other devices: http://$LAN_NAME.local:$PORT)"
echo "  Username:   $USERNAME"
if [ -n "$GENERATED_PASSWORD" ]; then
    echo "  Password:   $GENERATED_PASSWORD   (saved in .env)"
    login_text="Username: $USERNAME
Password: $GENERATED_PASSWORD

The password is also saved in the .env file in $REPO."
else
    echo "  Password:   the AUTH_PASSWORD in .env"
    login_text="Log in with your existing username ($USERNAME) and password."
fi
echo
echo "  Open it any time from Applications > $APP_NAME."
echo "  To update later, run the installer again."

if [ -n "$healthy" ]; then
    if [ -n "$GENERATED_PASSWORD" ]; then
        choice="$(dialog "$APP_NAME is installed and running.

$login_text" "Copy Password" "Open Dashboard")"
    else
        choice="$(dialog "$APP_NAME is installed and running.

$login_text" "Open Dashboard")"
    fi
    if [ "$choice" = "Copy Password" ]; then
        printf '%s' "$GENERATED_PASSWORD" | pbcopy
    fi
    if [ -n "$choice" ]; then
        open "http://localhost:$PORT"
    fi
else
    dialog "$APP_NAME is installed, but the dashboard hasn't started yet.

Give it a minute, then open $APP_NAME from your Applications folder. If it still doesn't load, the details are in $DATA_DIR/logs/web.log." "OK" >/dev/null
fi
