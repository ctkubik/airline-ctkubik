from __future__ import annotations

import importlib
from typing import TYPE_CHECKING

import pytest

from lib import config

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize(
    ("docker", "platform", "override", "expected"),
    [
        ("1", "linux", None, "xvfb"),
        (None, "darwin", None, "headed"),
        (None, "linux", None, "headless"),
        (None, "darwin", "HEADLESS", "headless"),
        (None, "darwin", "bogus", "headed"),
    ],
)
def test_browser_mode(
    monkeypatch: pytest.MonkeyPatch,
    docker: str | None,
    platform: str,
    override: str | None,
    expected: str,
) -> None:
    if docker:
        monkeypatch.setenv("AUTO_SOUTHWEST_CHECK_IN_DOCKER", docker)
    else:
        monkeypatch.delenv("AUTO_SOUTHWEST_CHECK_IN_DOCKER", raising=False)
    if override:
        monkeypatch.setenv("BROWSER_MODE", override)
    else:
        monkeypatch.delenv("BROWSER_MODE", raising=False)
    monkeypatch.setattr("sys.platform", platform)
    try:
        assert importlib.reload(config).BROWSER_MODE == expected
    finally:
        monkeypatch.undo()
        importlib.reload(config)


def test_data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    try:
        assert importlib.reload(config).CAPTURES_DIR == str(tmp_path / "captures")
    finally:
        monkeypatch.undo()
        importlib.reload(config)
