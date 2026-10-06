from __future__ import annotations

import os
import sqlite3
from typing import TYPE_CHECKING

import pytest

from lib import credentials

if TYPE_CHECKING:
    from pathlib import Path

KEY = bytes(range(32))


def test_round_trip_and_plaintext_passthrough() -> None:
    sealed = credentials.encrypt("p@ss wörd!", KEY)
    assert sealed.startswith("enc:v1:")
    assert credentials.decrypt(sealed, KEY) == "p@ss wörd!"
    assert credentials.decrypt("legacy-plain", KEY) == "legacy-plain"


def test_wrong_key_is_a_clear_error() -> None:
    sealed = credentials.encrypt("secret", KEY)
    with pytest.raises(credentials.CredentialKeyError, match="re-enter"):
        credentials.decrypt(sealed, bytes(32))


def test_encrypts_stored_passwords_and_creates_key(
    db_conn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:  # noqa: ANN001, E501
    monkeypatch.delenv("CREDENTIALS_KEY", raising=False)
    monkeypatch.setattr(credentials, "KEY_FILE", str(tmp_path / ".credentials-key"))
    db_conn.execute("INSERT INTO accounts (id, username, password) VALUES ('a', 'u', 'hunter2')")
    db_conn.commit()
    assert credentials.encrypt_stored_passwords(db_conn) == 1
    stored = db_conn.execute("SELECT password FROM accounts").fetchone()[0]
    assert stored.startswith("enc:v1:")
    assert oct(os.stat(credentials.KEY_FILE).st_mode & 0o777) == "0o600"
    assert credentials.decrypt(stored) == "hunter2"
    assert credentials.encrypt_stored_passwords(db_conn) == 0


def test_no_new_key_when_encrypted_values_exist(
    db_conn, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:  # noqa: ANN001, E501
    """A missing key (e.g. Keychain locked) must not start a second, different key."""
    monkeypatch.delenv("CREDENTIALS_KEY", raising=False)
    monkeypatch.setattr(credentials, "KEY_FILE", str(tmp_path / ".credentials-key"))
    sealed = credentials.encrypt("old", KEY)
    db_conn.execute(
        "INSERT INTO accounts (id, username, password) VALUES ('a', 'u', ?), ('b', 'v', 'new')",
        (sealed,),
    )
    db_conn.commit()
    assert credentials.encrypt_stored_passwords(db_conn) == 0
    assert not os.path.exists(credentials.KEY_FILE)


def test_env_key_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CREDENTIALS_KEY", KEY.hex())
    assert credentials.load_key() == KEY


def test_daily_backup_is_consistent_and_rotated(db_conn, tmp_path: Path) -> None:  # noqa: ANN001
    import db

    db_conn.execute("INSERT INTO accounts (id, username, password) VALUES ('a', 'u', 'x')")
    db_conn.commit()
    backups = tmp_path / "backups"
    backups.mkdir()
    for day in range(1, 20):
        (backups / f"checkin-2026-01-{day:02d}.db").write_text("old")
    path = db.backup_database(db_conn, str(backups))
    assert path is not None
    assert sqlite3.connect(path).execute("SELECT username FROM accounts").fetchone() == ("u",)
    assert db.backup_database(db_conn, str(backups)) is None  # once a day
    assert len(list(backups.glob("checkin-*.db"))) == db.BACKUP_KEEP_DAYS
