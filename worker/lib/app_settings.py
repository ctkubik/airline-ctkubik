"""Settings saved on the dashboard's API Connections page.

The dashboard stores them in the app_settings table (API keys encrypted like
account passwords). Every worker loop copies them into os.environ, where the
rest of the worker already looks (LLM_*, AERODATABOX_*, SERPAPI_* ...), so a
saved change applies within a minute with no restart. A setting removed on
the page goes back to its .env value.
"""

from __future__ import annotations

import os

from .credentials import CredentialKeyError, decrypt, encrypt, is_encrypted, load_key
from .log import get_logger

logger = get_logger(__name__)

SECRETS = {"AERODATABOX_API_KEY", "SERPAPI_API_KEY", "LLM_API_KEY"}
MANAGED = SECRETS | {
    "FLIGHT_STATUS_DELAY_MINUTES",
    "FLIGHT_STATUS_MONTHLY_LIMIT",
    "SERPAPI_MONTHLY_LIMIT",
    "TRIP_PRICE_CHECK_HOURS",
    "TRIP_PRICE_DROP_ALERT",
    "LLM_ENABLED",
    "LLM_BASE_URL",
    "LLM_MODEL",
    "LLM_TIMEOUT",
    "SOUTHWEST_PHONE_APP",
}

# .env values as the process started, to restore when a saved value is removed
_ORIGINAL = {name: os.environ.get(name) for name in MANAGED}


def apply_to_environ(conn) -> dict[str, str]:  # noqa: ANN001
    """Copy saved settings into os.environ. Returns the names now set from the app."""
    try:
        rows = conn.execute("SELECT key, value FROM app_settings").fetchall()
    except Exception:  # noqa: BLE001 - table missing on a very old database
        return {}
    applied: dict[str, str] = {}
    key = None
    for name, value in rows:
        if name not in MANAGED:
            continue
        if name in SECRETS:
            if not is_encrypted(value):
                # Saved before an encryption key existed: encrypt it now
                key = key or load_key()
                if key:
                    conn.execute(
                        "UPDATE app_settings SET value = ? WHERE key = ?",
                        (encrypt(value, key), name),
                    )
                    conn.commit()
            else:
                try:
                    value = decrypt(value)
                except CredentialKeyError as err:
                    logger.error("Can't read saved %s: %s", name, err)
                    continue
        os.environ[name] = value
        applied[name] = value
    for name in MANAGED - applied.keys():
        original = _ORIGINAL.get(name)
        if original is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = original
    return applied
