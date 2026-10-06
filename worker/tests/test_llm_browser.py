from __future__ import annotations

import json
from typing import Any

from lib import llm_browser


class FakeDriver:
    def __init__(self, candidates: list[dict], body_text: str = "") -> None:
        self.candidates = candidates
        self.body_text = body_text
        self.calls: list[tuple] = []

    def execute_script(self, _script: str, *args: Any) -> str:
        self.calls.append(args)
        if args:
            return json.dumps(self.candidates)
        return self.body_text


class FakeClient:
    def __init__(self, answer: Any, enabled: bool = True) -> None:
        self.answer = answer
        self.enabled = enabled
        self.prompts: list[str] = []

    def chat_json(self, _system: str, user: str, max_tokens: int = 512) -> Any:  # noqa: ARG002
        self.prompts.append(user)
        return self.answer


def cand(i: int, tag: str = "button", **fields: Any) -> dict:
    base = {
        "i": i, "tag": tag, "type": "", "text": "", "aria": "", "label": "", "name": "",
        "id": "", "placeholder": "", "cls": "", "disabled": False,
    }  # fmt: skip
    base.update(fields)
    return base


def test_find_element_returns_scoped_selector() -> None:
    driver = FakeDriver([cand(0, text="Home"), cand(1, tag="a", text="Change seats")])
    client = FakeClient({"index": 1})
    selector = llm_browser.find_element(driver, "open seat selection", client=client)
    attr = driver.calls[0][2]
    assert attr.startswith("data-llm-")
    assert selector == f'[{attr}="1"]'
    assert '[1] <a> text="Change seats"' in client.prompts[0]


def test_find_element_rejects_out_of_range_and_null() -> None:
    driver = FakeDriver([cand(0, text="Home")])
    for answer in ({"index": 7}, {"index": None}, {"index": True}, None):
        assert llm_browser.find_element(driver, "x", client=FakeClient(answer)) is None


def test_disabled_client_never_touches_page() -> None:
    driver = FakeDriver([cand(0)])
    client = FakeClient({"index": 0}, enabled=False)
    assert llm_browser.find_element(driver, "x", client=client) is None
    assert driver.calls == []


def test_find_form_fields_skips_duplicates_and_bad_indices() -> None:
    driver = FakeDriver(
        [cand(0, tag="input", label="Confirmation #"), cand(1, tag="input", label="First name")]
    )
    client = FakeClient({"confirmation_number": 0, "first_name": 0, "last_name": "nope"})
    fields = {"confirmation_number": "c", "first_name": "f", "last_name": "l"}
    result = llm_browser.find_form_fields(driver, fields, client=client)
    attr = driver.calls[0][2]
    assert result == {"confirmation_number": f'[{attr}="0"]'}


def test_extract_seats_normalizes_output() -> None:
    driver = FakeDriver(
        [cand(0, text="12A", cls="seat open"), cand(1, aria="Seat 12B taken", disabled=True)]
    )
    answer = {
        "seats": [{"index": 0, "seat": "12a"}, {"index": 9, "seat": "1A"}, "junk", {"index": 1}]
    }
    seats = llm_browser.extract_seats(driver, client=FakeClient(answer))
    attr = driver.calls[0][2]
    assert seats == [
        {
            "seat": "12A",
            "className": "seat open",
            "disabled": False,
            "text": "12A",
            "tag": "BUTTON",
            "selector": f'[{attr}="0"]',
            "source": "llm",
        }
    ]


def test_extract_seats_bad_shape() -> None:
    driver = FakeDriver([cand(0)])
    assert llm_browser.extract_seats(driver, client=FakeClient({"seats": "none"})) is None


def test_verify_outcome() -> None:
    driver = FakeDriver([], body_text="Your seat 3A is confirmed.")
    client = FakeClient({"answer": True, "summary": "Seat 3A confirmed."})
    assert llm_browser.verify_outcome(driver, "Did it work?", client=client) == {
        "answer": True,
        "summary": "Seat 3A confirmed.",
    }
    assert "Your seat 3A is confirmed." in client.prompts[0]


def test_verify_outcome_non_bool_answer_is_unclear() -> None:
    driver = FakeDriver([], body_text="...")
    result = llm_browser.verify_outcome(driver, "?", client=FakeClient({"answer": "yes"}))
    assert result == {"answer": None, "summary": ""}
