"""At-rest encryption for stored Southwest account passwords.

Counterpart of frontend/lib/secrets.ts — the format must stay in sync:

    enc:v1:base64(iv[12] || tag[16] || ciphertext)   (AES-256-GCM)

Key = SHA-256(AUTH_SECRET). The frontend encrypts when an account is saved;
the worker decrypts when it needs to log in to Southwest. Legacy plaintext
values (no prefix) pass through unchanged and are re-encrypted at startup.
"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

PREFIX = "enc:v1:"


class SecretDecryptError(Exception):
    pass


def _get_key() -> bytes | None:
    secret = os.environ.get("AUTH_SECRET")
    if not secret:
        return None
    return hashlib.sha256(secret.encode()).digest()


def is_encrypted(value: str) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def encrypt_secret(plaintext: str) -> str:
    key = _get_key()
    if not key:
        return plaintext
    iv = os.urandom(12)
    # AESGCM.encrypt returns ciphertext||tag; the shared format is iv||tag||ciphertext
    ct_and_tag = AESGCM(key).encrypt(iv, plaintext.encode(), None)
    ciphertext, tag = ct_and_tag[:-16], ct_and_tag[-16:]
    return PREFIX + base64.b64encode(iv + tag + ciphertext).decode()


def decrypt_secret(value: str) -> str:
    if not is_encrypted(value):
        return value
    key = _get_key()
    if not key:
        raise SecretDecryptError("AUTH_SECRET is not set; cannot decrypt stored credential")
    raw = base64.b64decode(value[len(PREFIX):])
    iv, tag, ciphertext = raw[:12], raw[12:28], raw[28:]
    try:
        return AESGCM(key).decrypt(iv, ciphertext + tag, None).decode()
    except Exception as err:
        raise SecretDecryptError(
            "Could not decrypt stored Southwest password — AUTH_SECRET has likely "
            "changed since the account was saved. Re-enter the account password "
            "in the web UI."
        ) from err
