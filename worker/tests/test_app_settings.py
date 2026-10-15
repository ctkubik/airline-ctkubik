# ruff: noqa: ANN001, E501, SLF001, TC002 - test fixtures and private test hooks
from __future__ import annotations

import os

import pytest

from lib import app_settings, credentials

KEY = bytes(range(32))


def test_saved_settings_reach_the_environment_and_fall_back(
    db_conn, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CREDENTIALS_KEY", KEY.hex())
    monkeypatch.setitem(app_settings._ORIGINAL, "LLM_BASE_URL", "http://from-env:1234/v1")
    monkeypatch.setitem(app_settings._ORIGINAL, "SERPAPI_API_KEY", None)
    db_conn.execute(
        "INSERT INTO app_settings (key, value) VALUES ('LLM_BASE_URL', 'http://studio.local:1234/v1'), "
        "('SERPAPI_API_KEY', ?), ('AERODATABOX_API_KEY', 'typed-before-a-key-existed'), ('NOT_OURS', 'x')",
        (credentials.encrypt("serp-secret", KEY),),
    )
    db_conn.commit()

    applied = app_settings.apply_to_environ(db_conn)
    assert os.environ["LLM_BASE_URL"] == "http://studio.local:1234/v1"
    assert os.environ["SERPAPI_API_KEY"] == "serp-secret"
    assert "NOT_OURS" not in applied
    stored = db_conn.execute(
        "SELECT value FROM app_settings WHERE key = 'AERODATABOX_API_KEY'"
    ).fetchone()[0]
    assert stored.startswith("enc:v1:")  # plain key encrypted in place

    db_conn.execute("DELETE FROM app_settings WHERE key IN ('LLM_BASE_URL', 'SERPAPI_API_KEY')")
    db_conn.commit()
    app_settings.apply_to_environ(db_conn)
    assert os.environ["LLM_BASE_URL"] == "http://from-env:1234/v1"
    assert "SERPAPI_API_KEY" not in os.environ
    for name in app_settings.MANAGED:
        monkeypatch.delenv(name, raising=False)
