from __future__ import annotations

from typing import Any

import pytest
import requests
from lib.llm import LLMClient, extract_json

from lib import llm


class FakeResponse:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self.payload = payload
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code}")

    def json(self) -> dict:
        return self.payload


def chat_reply(content: str) -> FakeResponse:
    return FakeResponse({"choices": [{"message": {"content": content}}]})


@pytest.fixture
def enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_BASE_URL", "http://llm.test/v1/")
    monkeypatch.delenv("LLM_MODEL", raising=False)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ('{"index": 3}', {"index": 3}),
        ('Sure!\n```json\n{"index": 3}\n```', {"index": 3}),
        ('<think>maybe {"index": 1}?</think>{"index": 2}', {"index": 2}),
        ('{"a": "brace } in string", "b": {"c": 1}}', {"a": "brace } in string", "b": {"c": 1}}),
        ('{broken {"ok": true}', {"ok": True}),
        ("[1, 2]", None),
        ("no json here", None),
    ],
)
def test_extract_json(text: str, expected: dict | None) -> None:
    assert extract_json(text) == expected


def test_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_ENABLED", raising=False)
    calls = []
    monkeypatch.setattr(llm.requests, "post", lambda *args, **_: calls.append(args))
    assert LLMClient().chat("s", "u") is None
    assert calls == []


@pytest.mark.usefixtures("enabled")
def test_chat_picks_first_chat_model(monkeypatch: pytest.MonkeyPatch) -> None:
    seen = {}

    def fake_get(url: str, **_: Any) -> FakeResponse:
        seen["models_url"] = url
        return FakeResponse({"data": [{"id": "text-embedding-nomic"}, {"id": "qwen3-8b"}]})

    def fake_post(url: str, json: dict, **_: Any) -> FakeResponse:
        seen["chat_url"] = url
        seen["model"] = json["model"]
        return chat_reply("hello")

    monkeypatch.setattr(llm.requests, "get", fake_get)
    monkeypatch.setattr(llm.requests, "post", fake_post)
    assert LLMClient().chat("s", "u") == "hello"
    assert seen == {
        "models_url": "http://llm.test/v1/models",
        "chat_url": "http://llm.test/v1/chat/completions",
        "model": "qwen3-8b",
    }


@pytest.mark.usefixtures("enabled")
def test_chat_uses_configured_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL", "my-model")

    def no_listing(*_: Any, **__: Any) -> None:
        pytest.fail("should not list models")

    monkeypatch.setattr(llm.requests, "get", no_listing)
    monkeypatch.setattr(llm.requests, "post", lambda _, json, **__: chat_reply(json["model"]))
    assert LLMClient().chat("s", "u") == "my-model"


@pytest.mark.usefixtures("enabled")
def test_chat_returns_none_when_server_down(monkeypatch: pytest.MonkeyPatch) -> None:
    def refused(*_: Any, **__: Any) -> None:
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(llm.requests, "get", refused)
    assert LLMClient().chat("s", "u") is None


@pytest.mark.usefixtures("enabled")
def test_chat_returns_none_without_chat_model(monkeypatch: pytest.MonkeyPatch) -> None:
    only_embeddings = FakeResponse({"data": [{"id": "nomic-embed"}]})
    monkeypatch.setattr(llm.requests, "get", lambda *_, **__: only_embeddings)
    assert LLMClient().chat("s", "u") is None


@pytest.mark.usefixtures("enabled")
def test_chat_json(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_MODEL", "m")
    monkeypatch.setattr(llm.requests, "post", lambda *_, **__: chat_reply('ok {"index": 4}'))
    assert LLMClient().chat_json("s", "u") == {"index": 4}


def test_bad_timeout_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_TIMEOUT", "soon")
    assert LLMClient().timeout == 60.0
