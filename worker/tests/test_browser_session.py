# ruff: noqa: SLF001 - exercising the listener directly
from __future__ import annotations

from lib import browser_session as bs
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


class FakeDriver:
    """Each URL either shows Southwest's missing-page error or hands over headers."""

    def __init__(self, session: BrowserSession, missing: set[str]) -> None:
        self.session = session
        self.missing = missing
        self.opened: list[str] = []
        self.url = ""

    def get(self, url: str) -> None:
        self.opened.append(url)
        self.url = url
        if url not in self.missing:
            self.session._headers_listener(event(MOBILE_HEADERS_URL, WAF))

    def execute_script(self, _script: str) -> str:
        if self.url in self.missing:
            return "Sorry! We're having trouble accessing this content. Error 404040404"
        return "Welcome"


def test_retired_mobile_page_is_skipped() -> None:
    session = BrowserSession()
    driver = FakeDriver(session, missing={bs.MOBILE_LOGIN_URL})
    session._driver = driver
    session._load_mobile_site(timeout=10)
    assert driver.opened == [bs.MOBILE_LOGIN_URL, bs.BASE_URL + "/"]
    assert session._headers_set
    # The page that worked is tried first next time
    driver.opened.clear()
    session._load_mobile_site(timeout=10)
    assert driver.opened == [bs.BASE_URL + "/"]
