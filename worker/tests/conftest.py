import os
import sys

# Import worker modules the same way worker.py does (`from lib.x import ...`).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


import pytest


@pytest.fixture
def db_conn(tmp_path, monkeypatch):  # noqa: ANN001, ANN201
    """A fresh worker database in a temp folder (full schema + migrations)."""
    import db

    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "checkin.db"))
    monkeypatch.setattr(db, "_schema_initialized", False)
    conn = db.get_connection()
    yield conn
    conn.close()
