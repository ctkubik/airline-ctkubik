"""Encryption for stored Southwest passwords.

The worker needs each account's real password to log in, so it can't be
hashed; it's encrypted with AES-256-GCM instead. Stored values look like
"enc:v1:<base64 of 12-byte nonce + ciphertext + 16-byte tag>"; the dashboard
(frontend/lib/credentials.ts) writes the same format.

The key (64 hex characters) comes from:
  1. CREDENTIALS_KEY in the environment. On macOS the installer keeps it in
     your login Keychain and macos/run.sh passes it in, so the data folder
     alone doesn't unlock the passwords.
  2. Otherwise DATA_DIR/.credentials-key (created on first use; Docker).

Plain-text values (from older versions) still work and are encrypted in
place by encrypt_stored_passwords().
"""

from __future__ import annotations

import base64
import os
import secrets

from .config import DATA_DIR
from .log import get_logger

logger = get_logger(__name__)

PREFIX = "enc:v1:"
KEY_FILE = os.path.join(DATA_DIR, ".credentials-key")

try:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
except ImportError:  # e.g. 32-bit ARM Docker images without a cryptography wheel
    AESGCM = None


class CredentialKeyError(Exception):
    """A stored password can't be decrypted (key missing or changed)."""


def available() -> bool:
    return AESGCM is not None


def _parse_key(text: str) -> bytes | None:
    try:
        key = bytes.fromhex(text.strip())
    except ValueError:
        return None
    return key if len(key) == 32 else None


def load_key() -> bytes | None:
    env = os.environ.get("CREDENTIALS_KEY", "").strip()
    if env:
        key = _parse_key(env)
        if key is None:
            logger.error("CREDENTIALS_KEY is set but isn't 64 hex characters; ignoring it")
        return key
    try:
        with open(KEY_FILE) as fh:
            return _parse_key(fh.read())
    except FileNotFoundError:
        return None


def create_key_file() -> bytes:
    os.makedirs(os.path.dirname(KEY_FILE), exist_ok=True)
    key_hex = secrets.token_hex(32)
    fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(key_hex)
    return bytes.fromhex(key_hex)


def is_encrypted(value: str | None) -> bool:
    return bool(value) and value.startswith(PREFIX)


def encrypt(plaintext: str, key: bytes) -> str:
    nonce = secrets.token_bytes(12)
    sealed = AESGCM(key).encrypt(nonce, plaintext.encode(), None)
    return PREFIX + base64.b64encode(nonce + sealed).decode()


def decrypt(value: str, key: bytes | None = None) -> str:
    """Plain-text values pass through unchanged."""
    if not is_encrypted(value):
        return value
    if not available():
        raise CredentialKeyError(
            "this install can't decrypt passwords (cryptography isn't installed)"
        )
    key = key or load_key()
    if key is None:
        raise CredentialKeyError(
            "the password encryption key is missing (on a Mac, run the installer again)"
        )
    raw = base64.b64decode(value[len(PREFIX) :])
    try:
        return AESGCM(key).decrypt(raw[:12], raw[12:], None).decode()
    except Exception as err:  # noqa: BLE001 - InvalidTag and friends
        raise CredentialKeyError(
            "the stored password can't be decrypted with the current key (was the key changed?); "
            "re-enter the account's password on the Accounts page"
        ) from err


def encrypt_stored_passwords(conn) -> int:  # noqa: ANN001
    """Encrypt any plain-text account passwords in place. Returns how many."""
    if not available():
        return 0
    rows = conn.execute(
        "SELECT id, password FROM accounts WHERE password NOT LIKE 'enc:%'"
    ).fetchall()
    if not rows:
        return 0
    key = load_key()
    if key is None:
        # Only start a new key file when nothing is encrypted yet; otherwise
        # a missing key means the real one is somewhere else (the Keychain).
        if conn.execute("SELECT 1 FROM accounts WHERE password LIKE 'enc:%' LIMIT 1").fetchone():
            logger.error("Can't encrypt new passwords: the encryption key is missing")
            return 0
        key = create_key_file()
    for account_id, password in rows:
        conn.execute(
            "UPDATE accounts SET password = ? WHERE id = ?", (encrypt(password, key), account_id)
        )
    conn.commit()
    logger.info("Encrypted %d stored Southwest password(s)", len(rows))
    return len(rows)
