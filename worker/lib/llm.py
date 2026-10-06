"""Optional local LLM client (LM Studio or any OpenAI-compatible server).

The LLM is an assistant, never a dependency: every helper returns None when
the model is disabled, unreachable, slow, or answers with something unusable,
and callers fall back to their normal behavior. Nothing on the time-critical
check-in path calls into this module.

Settings (environment):
    LLM_ENABLED   "true" to turn it on (default off)
    LLM_BASE_URL  OpenAI-compatible base URL (default LM Studio:
                  http://localhost:1234/v1; from Docker use
                  http://host.docker.internal:1234/v1)
    LLM_MODEL     model id to request; blank = whatever model is loaded
    LLM_TIMEOUT   seconds per request (default 60)
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import requests

from .log import get_logger

logger = get_logger(__name__)

JSON_T = dict[str, Any]

DEFAULT_BASE_URL = "http://localhost:1234/v1"


class LLMClient:
    def __init__(self) -> None:
        self.enabled = os.environ.get("LLM_ENABLED", "").strip().lower() in (
            "1",
            "true",
            "yes",
            "on",
        )
        self.base_url = os.environ.get("LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/")
        self.model = os.environ.get("LLM_MODEL", "").strip()
        try:
            self.timeout = float(os.environ.get("LLM_TIMEOUT", "60"))
        except ValueError:
            self.timeout = 60.0

    def _resolve_model(self) -> str:
        """Use LLM_MODEL, else the first model the server reports as loaded."""
        if self.model:
            return self.model
        resp = requests.get(f"{self.base_url}/models", timeout=10)
        resp.raise_for_status()
        ids = [m["id"] for m in resp.json().get("data") or []]
        # Embedding models can't chat; skip them when picking automatically.
        chat_ids = [i for i in ids if "embed" not in i.lower()]
        if not chat_ids:
            raise RuntimeError("LLM server has no chat model loaded")
        self.model = chat_ids[0]
        return self.model

    def chat(self, system: str, user: str, max_tokens: int = 512) -> str | None:
        """Single-turn chat completion. Returns the reply text or None."""
        if not self.enabled:
            return None
        try:
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                json={
                    "model": self._resolve_model(),
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "temperature": 0,
                    "max_tokens": max_tokens,
                    "stream": False,
                },
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"] or ""
        except Exception as err:  # noqa: BLE001 - the LLM must never break the caller
            logger.warning("LLM request failed: %s", err)
            return None

    def chat_json(self, system: str, user: str, max_tokens: int = 512) -> JSON_T | None:
        """Chat and parse a JSON object out of the reply. Returns None if unusable."""
        reply = self.chat(
            system + "\nRespond with a single JSON object and nothing else.", user, max_tokens
        )
        return extract_json(reply) if reply is not None else None


def extract_json(text: str) -> JSON_T | None:
    """Pull the first JSON object out of a model reply (handles code fences,
    leading prose, and reasoning-model <think> blocks)."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escaped = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == "\\":
                    escaped = True
                elif ch == '"':
                    in_string = False
            elif ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        value = json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
                    return value if isinstance(value, dict) else None
        start = text.find("{", start + 1)
    return None
