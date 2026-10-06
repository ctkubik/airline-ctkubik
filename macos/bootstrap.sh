#!/bin/bash
# Puts the app in ~/airline-ctkubik (downloading or updating it) and runs the
# installer. Two ways in:
#
#   Double-click "Install on Mac.command" in a downloaded copy of the app
#   (installs from that copy), or paste this line into Terminal (downloads
#   the latest version from GitHub; no git needed):
#
#     curl -fsSL https://raw.githubusercontent.com/ctkubik/airline-ctkubik/master/macos/bootstrap.sh | bash
#
# Re-running either one updates the app and keeps your data and settings.
# Options (environment): AIRLINE_HOME (install folder), AIRLINE_BRANCH.
set -euo pipefail

REPO_SLUG="ctkubik/airline-ctkubik"
BRANCH="${AIRLINE_BRANCH:-master}"
DEST="${AIRLINE_HOME:-$HOME/airline-ctkubik}"
SOURCE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --source) SOURCE="$2"; shift 2 ;;
        *) echo "unknown option: $1" >&2; exit 64 ;;
    esac
done

[ "$(uname -s)" = "Darwin" ] || { echo "This installer is for macOS." >&2; exit 1; }

# Never overwrite a folder that isn't this app.
if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ] \
    && [ ! -f "$DEST/macos/install.sh" ] && [ ! -f "$DEST/worker/worker.py" ]; then
    echo "$DEST already exists and isn't this app. Move it aside, or set AIRLINE_HOME to another folder." >&2
    exit 1
fi

# Your data, settings and downloaded runtimes are never touched by an update.
EXCLUDES=(
    --exclude "/data/" --exclude "/.env" --exclude "/.venv/" --exclude "/runtime/"
    --exclude "/frontend/node_modules/" --exclude "/frontend/.next/" --exclude "/.git/"
)

if [ -n "$SOURCE" ]; then
    SOURCE="$(cd "$SOURCE" && pwd)"
    if [ "$SOURCE" != "$DEST" ]; then
        echo "Copying the app to $DEST"
        mkdir -p "$DEST"
        rsync -a --delete "${EXCLUDES[@]}" "$SOURCE/" "$DEST/"
    fi
elif [ -d "$DEST/.git" ]; then
    echo "Updating $DEST with git"
    git -C "$DEST" pull --ff-only
else
    echo "Downloading the latest version ($BRANCH)"
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    curl -fL --retry 3 --progress-bar "https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$BRANCH" \
        | tar -xz -C "$tmp"
    # Check before copying, so a version without the Mac installer can't
    # replace a working install.
    src_dir="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
    if [ ! -f "$src_dir/macos/install.sh" ]; then
        echo "The $BRANCH version of the app doesn't include the Mac installer yet." >&2
        echo "Use the version that does: AIRLINE_BRANCH=<branch name> (see MACOS.md)." >&2
        exit 1
    fi
    mkdir -p "$DEST"
    rsync -a --delete "${EXCLUDES[@]}" "$src_dir/" "$DEST/"
fi

exec /bin/bash "$DEST/macos/install.sh"
