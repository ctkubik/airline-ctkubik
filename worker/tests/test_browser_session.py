# ruff: noqa: SLF001 - exercising the listener directly
from __future__ import annotations

from lib.browser_session import API_BASE_URL, MOBILE_HEADERS_URL, BrowserSession

WAF = {
    "X-API-Key": "k",
    "X-Channel-ID": "MWEB",
    "User-Agent": "UA",
    "EE30zvQLWf-a": "token",
    "Accept": "*/*",
}


def event(url: str, headers: dict) -> dict:
    return {"params": {"request": {"url": url, "headers": headers}}}


def test_headers_from_the_usual_request() -> None:
    session = BrowserSession()
    session._headers_listener(event(MOBILE_HEADERS_URL, WAF))
    assert session._headers_set
    assert "Accept" not in session.headers
    assert session.headers["EE30zvQLWf-a"] == "token"


def test_headers_from_another_mobile_api_call() -> None:
    session = BrowserSession()
    # A call without the bot-check headers isn't enough
    session._headers_listener(event(API_BASE_URL + "mobile-misc/v1/content", {"X-API-Key": "k"}))
    assert not session._headers_set
    session._headers_listener(event("https://www.southwest.com/api/x", WAF))
    assert not session._headers_set
    session._headers_listener(event(API_BASE_URL + "mobile-air-booking/v1/other", WAF))
    assert session._headers_set
    assert session.headers["X-API-Key"] == "k"
