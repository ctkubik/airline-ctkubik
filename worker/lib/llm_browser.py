"""LLM-assisted fallbacks for driving Southwest's website.

The seat-upgrade flow finds page elements with hard-coded CSS selectors, which
break whenever Southwest redesigns a page. When a selector comes up empty,
these helpers list the visible elements on the page, ask the local LLM which
one matches the goal, and return a selector for it.

Safety: the model only ever picks an index from the list we built; it never
writes selectors or scripts. Indices are validated before use, and every
helper returns None (meaning "fall back to the existing failure handling")
when the LLM is off, unreachable, or unsure.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from .llm import LLMClient
from .log import get_logger

logger = get_logger(__name__)

# Tags visible elements with a per-call attribute so earlier selectors stay
# valid when a later call tags the same page again.
_CANDIDATES_JS = """
var kind = arguments[0], limit = arguments[1], attr = arguments[2];
var selectors = {
    input: 'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select',
    clickable: 'a, button, [role=button], [role=link], [role=tab], ' +
        'input[type=submit], input[type=button]',
    seat: 'button, [role=button], [role=gridcell], [role=checkbox], [role=option], [tabindex], td'
};
var out = [];
var els = document.querySelectorAll(selectors[kind] || selectors.clickable);
for (var i = 0; i < els.length && out.length < limit; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || getComputedStyle(el).visibility === 'hidden') continue;
    var idx = out.length;
    el.setAttribute(attr, String(idx));
    var label = '';
    if (el.id) {
        var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (l) label = l.textContent;
    }
    var clean = function (s, n) { return (s || '').replace(/\\s+/g, ' ').trim().slice(0, n); };
    out.push({
        i: idx,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        text: clean(el.innerText || el.value, 80),
        aria: clean(el.getAttribute('aria-label'), 80),
        label: clean(label, 60),
        name: el.getAttribute('name') || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        cls: kind === 'seat' ? clean(String(el.className || ''), 60) : '',
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
    });
}
return JSON.stringify(out);
"""


def _new_attr() -> str:
    return f"data-llm-{uuid.uuid4().hex[:8]}"


def _list_candidates(driver: Any, kind: str, limit: int) -> tuple[str, list[dict]]:
    attr = _new_attr()
    raw = driver.execute_script(_CANDIDATES_JS, kind, limit, attr)
    try:
        candidates = json.loads(raw or "[]")
    except (json.JSONDecodeError, TypeError):
        candidates = []
    return attr, candidates


def _format_candidates(candidates: list[dict]) -> str:
    lines = []
    for c in candidates:
        parts = [f"[{c['i']}] <{c['tag']}{' type=' + c['type'] if c.get('type') else ''}>"]
        for key in ("text", "aria", "label", "placeholder", "name", "id", "cls"):
            if c.get(key):
                parts.append(f'{key}="{c[key]}"')
        if c.get("disabled"):
            parts.append("disabled")
        lines.append(" ".join(parts))
    return "\n".join(lines)


def _valid_index(value: Any, candidates: list[dict]) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        idx = int(value)
    except (TypeError, ValueError):
        return None
    return idx if 0 <= idx < len(candidates) else None


def _selector(attr: str, idx: int) -> str:
    return f'[{attr}="{idx}"]'


def find_element(
    driver: Any, goal: str, kind: str = "clickable", client: LLMClient | None = None
) -> str | None:
    """Ask the LLM which visible element matches `goal`. Returns a CSS selector or None."""
    client = client or LLMClient()
    if not client.enabled:
        return None
    attr, candidates = _list_candidates(driver, kind, limit=150)
    if not candidates:
        return None
    answer = client.chat_json(
        "You help automate a web page. You are given a numbered list of visible page "
        "elements and a goal. Pick the single element that best accomplishes the goal. "
        'Answer {"index": <number>} or {"index": null} if no element fits.',
        f"Goal: {goal}\n\nElements:\n{_format_candidates(candidates)}",
        max_tokens=100,
    )
    idx = _valid_index((answer or {}).get("index"), candidates)
    if idx is None:
        logger.info("LLM found no element for goal: %s", goal)
        return None
    logger.info("LLM picked element %d for goal '%s': %s", idx, goal, candidates[idx])
    return _selector(attr, idx)


def find_form_fields(
    driver: Any, fields: dict[str, str], client: LLMClient | None = None
) -> dict[str, str] | None:
    """Map each named field (key -> description) to an input on the page.

    Returns {key: css_selector} for the fields the LLM could place, or None.
    """
    client = client or LLMClient()
    if not client.enabled:
        return None
    attr, candidates = _list_candidates(driver, "input", limit=80)
    if not candidates:
        return None
    wanted = "\n".join(f'- "{key}": {desc}' for key, desc in fields.items())
    answer = client.chat_json(
        "You help fill in a web form. You are given a numbered list of visible form inputs "
        "and the fields to fill. For each field, give the index of the matching input, or "
        'null if none matches. Answer {"<field>": <index or null>, ...}.',
        f"Fields to fill:\n{wanted}\n\nInputs:\n{_format_candidates(candidates)}",
        max_tokens=200,
    )
    if not answer:
        return None
    result: dict[str, str] = {}
    used: set[int] = set()
    for key in fields:
        idx = _valid_index(answer.get(key), candidates)
        if idx is not None and idx not in used:
            used.add(idx)
            result[key] = _selector(attr, idx)
    logger.info("LLM mapped form fields: %s", sorted(result))
    return result or None


def extract_seats(driver: Any, client: LLMClient | None = None) -> list[dict] | None:
    """Ask the LLM to find available seats on a seat map it can't otherwise parse.

    Returns seat dicts compatible with the selector-based extractor
    ({seat, className, disabled, text, tag, selector}) or None.
    """
    client = client or LLMClient()
    if not client.enabled:
        return None
    attr, candidates = _list_candidates(driver, "seat", limit=400)
    if not candidates:
        return None
    answer = client.chat_json(
        "You read an airplane seat map from a web page. You are given a numbered list of "
        "visible page elements. Identify the elements that are individual seats a "
        "passenger can select right now (not occupied, blocked, or disabled). Seat ids "
        'look like a row number plus a letter, e.g. "12A". Answer '
        '{"seats": [{"index": <number>, "seat": "<row><letter>"}, ...]} '
        "(an empty list if there is no seat map).",
        _format_candidates(candidates),
        max_tokens=4000,
    )
    if not answer or not isinstance(answer.get("seats"), list):
        return None
    seats = []
    for item in answer["seats"]:
        if not isinstance(item, dict):
            continue
        idx = _valid_index(item.get("index"), candidates)
        seat_id = str(item.get("seat") or "").strip().upper()
        if idx is None or not seat_id:
            continue
        c = candidates[idx]
        seats.append(
            {
                "seat": seat_id,
                "className": c.get("cls", ""),
                "disabled": bool(c.get("disabled")),
                "text": (c.get("text") or c.get("aria") or "")[:50],
                "tag": c.get("tag", "").upper(),
                "selector": _selector(attr, idx),
                "source": "llm",
            }
        )
    logger.info("LLM extracted %d available seats", len(seats))
    return seats


def verify_outcome(driver: Any, question: str, client: LLMClient | None = None) -> dict | None:
    """Ask the LLM a yes/no question about what the page currently says.

    Returns {"answer": True|False|None, "summary": str} or None if the LLM is off.
    """
    client = client or LLMClient()
    if not client.enabled:
        return None
    text = driver.execute_script("return document.body ? document.body.innerText : ''") or ""
    answer = client.chat_json(
        "You check the result of an action on a web page by reading its visible text. "
        "Answer only from what the page says. "
        'Answer {"answer": true | false | null, "summary": "<one short sentence>"} '
        "where null means the page does not make it clear.",
        f"Question: {question}\n\nPage text:\n{text[:6000]}",
        max_tokens=200,
    )
    if not answer:
        return None
    verdict = answer.get("answer")
    return {
        "answer": verdict if isinstance(verdict, bool) else None,
        "summary": str(answer.get("summary") or "")[:300],
    }
