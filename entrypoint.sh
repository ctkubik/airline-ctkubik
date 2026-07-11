#!/bin/sh
# Container entrypoint: guarantees working auth credentials, then starts
# supervisord (Next.js frontend + Python worker).
#
# The app fails closed if AUTH_SECRET/AUTH_PASSWORD are unset, so a container
# started with no configuration would be unusable. Instead of shipping known
# default credentials (an auth bypass), generate random ones on first boot and
# persist them in the data volume so they survive restarts.
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

random_hex() {
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

if [ -z "$AUTH_SECRET" ]; then
    SECRET_FILE="$DATA_DIR/.auth-secret"
    if [ ! -s "$SECRET_FILE" ]; then
        random_hex > "$SECRET_FILE"
        chmod 600 "$SECRET_FILE"
    fi
    AUTH_SECRET="$(cat "$SECRET_FILE")"
    export AUTH_SECRET
fi

GENERATED_PASSWORD=""
if [ -z "$AUTH_PASSWORD" ]; then
    PASSWORD_FILE="$DATA_DIR/.auth-password"
    if [ ! -s "$PASSWORD_FILE" ]; then
        random_hex | cut -c1-16 > "$PASSWORD_FILE"
        chmod 600 "$PASSWORD_FILE"
    fi
    AUTH_PASSWORD="$(cat "$PASSWORD_FILE")"
    export AUTH_PASSWORD
    GENERATED_PASSWORD=1
fi

AUTH_USERNAME="${AUTH_USERNAME:-admin}"
export AUTH_USERNAME

echo "=============================================================="
echo " Auto Southwest Check-In"
echo ""
echo " Web UI:   http://localhost:3000"
echo " Username: $AUTH_USERNAME"
if [ -n "$GENERATED_PASSWORD" ]; then
    echo " Password: $AUTH_PASSWORD"
    echo ""
    echo " (auto-generated and saved in the data volume;"
    echo "  set AUTH_PASSWORD in .env to choose your own)"
else
    echo " Password: (set via AUTH_PASSWORD)"
fi
echo "=============================================================="

exec supervisord -c /app/supervisord.conf
