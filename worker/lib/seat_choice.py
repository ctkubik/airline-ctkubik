"""Decide whether an open seat beats the seat a passenger already has.

The rules here decide; the local LLM only helps read Southwest's pages (find
the seat map, read prices, confirm the change saved). That keeps the choice
predictable: the same seat map and preferences always give the same answer.

Seats are ranked in tiers from the Settings page preferences:
    4  preferred letter in a preferred row   (e.g. a window in rows 1-6)
    3  preferred letter, any row
    2  fallback letter in a preferred row
    1  fallback letter, any row
    0  anything else (usually a middle seat)
   -1  a row you asked to avoid
A seat is only taken when it's in a higher tier than the current seat, or
the same tier and at least `min_row_gain` rows further forward (0 turns that
off). With no known current seat, only a top-tier seat is taken.

Never chosen: seats that show a price or say extra legroom/upgrade/premium.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SEAT_RE = re.compile(r"^\s*(\d{1,2})\s*([A-K])\s*$", re.IGNORECASE)
_PAID_RE = re.compile(
    r"\$\s?\d|\d+\s?(?:usd|dollars)|extra\s*legroom|premium|upgrade|purchase|paid|fee|for\s+sale",
    re.IGNORECASE,
)


@dataclass
class SeatPrefs:
    preferred_letters: list[str]
    preferred_rows: list[int]
    fallback_letters: list[str]
    avoid_rows: list[int]
    min_row_gain: int = 0

    @classmethod
    def from_row(cls, row: dict | None) -> SeatPrefs:
        row = row or {}

        def letters(value: str | None, default: str) -> list[str]:
            return [x.strip().upper() for x in (value or default).split(",") if x.strip()]

        def rows(value: str | None, default: str) -> list[int]:
            out: list[int] = []
            for part in (value if value is not None else default).split(","):
                part = part.strip()
                if "-" in part:
                    lo, _, hi = part.partition("-")
                    if lo.strip().isdigit() and hi.strip().isdigit():
                        out.extend(range(int(lo), int(hi) + 1))
                elif part.isdigit():
                    out.append(int(part))
            return out

        try:
            gain = int(row.get("min_row_gain") or 0)
        except (TypeError, ValueError):
            gain = 0
        return cls(
            preferred_letters=letters(row.get("preferred_letters"), "A,F"),
            preferred_rows=rows(row.get("preferred_rows"), "1,2,3,4,5,6"),
            fallback_letters=letters(row.get("fallback_letters"), "A,C,D,F"),
            avoid_rows=rows(row.get("avoid_rows"), ""),
            min_row_gain=max(0, gain),
        )


def parse_seat(seat: str | None) -> tuple[int, str] | None:
    m = _SEAT_RE.match(str(seat or ""))
    return (int(m.group(1)), m.group(2).upper()) if m else None


def tier(seat: str | None, prefs: SeatPrefs) -> int | None:
    parsed = parse_seat(seat)
    if not parsed:
        return None
    row, letter = parsed
    if row in prefs.avoid_rows:
        return -1
    good_row = row in prefs.preferred_rows
    if letter in prefs.preferred_letters:
        return 4 if good_row else 3
    if letter in prefs.fallback_letters:
        return 2 if good_row else 1
    return 0


def is_free(candidate: dict) -> bool:
    """False when anything about the seat says it costs money."""
    if candidate.get("paid") or (candidate.get("price") or 0) > 0:
        return False
    text = " ".join(str(candidate.get(k) or "") for k in ("text", "aria", "className", "label"))
    return not _PAID_RE.search(text)


def is_better(new: str, current: str | None, prefs: SeatPrefs) -> bool:
    t_new = tier(new, prefs)
    if t_new is None:
        return False
    t_cur = tier(current, prefs)
    if t_cur is None:
        return t_new == 4
    if t_new != t_cur:
        return t_new > t_cur
    if prefs.min_row_gain <= 0:
        return False
    return parse_seat(current)[0] - parse_seat(new)[0] >= prefs.min_row_gain


def rank_key(seat: str, prefs: SeatPrefs) -> tuple:
    row, letter = parse_seat(seat)
    letter_order = prefs.preferred_letters + [
        x for x in prefs.fallback_letters if x not in prefs.preferred_letters
    ]
    return (
        -(tier(seat, prefs) or 0),
        row,
        letter_order.index(letter) if letter in letter_order else 99,
    )


def choose(available: list[dict], current: str | None, prefs: SeatPrefs) -> tuple[dict | None, str]:
    """Best free seat that beats the current one, and why (for the log)."""
    usable = []
    skipped_paid = 0
    for c in available:
        seat = str(c.get("seat") or "").upper()
        if not parse_seat(seat) or c.get("disabled"):
            continue
        cls = str(c.get("className") or "").lower()
        if any(word in cls for word in ("unavailable", "occupied", "blocked", "taken")):
            continue
        if not is_free(c):
            skipped_paid += 1
            continue
        if current and seat == current.upper():
            continue
        usable.append({**c, "seat": seat})
    better = [c for c in usable if is_better(c["seat"], current, prefs)]
    note = f"{len(usable)} free seats open"
    if skipped_paid:
        note += f", {skipped_paid} paid seats skipped"
    if not better:
        return None, note + (
            f"; none better than {current}" if current else "; no top-choice seat open"
        )
    best = min(better, key=lambda c: rank_key(c["seat"], prefs))
    return best, note + f"; {best['seat']} beats {current or 'no seat'}"


# ---------------------------------------------------------------------------
# Reading Southwest's pages
# ---------------------------------------------------------------------------

_CURRENT_RE = re.compile(
    r"\bseat\s*(?:#|number|assignment)?\s*:?\s*(\d{1,2}[A-F])\b", re.IGNORECASE
)
_PAYMENT_RE = re.compile(
    r"(?:total|amount)\s*(?:due|to pay|charged|today)[^\n$]{0,40}\$\s?(?:[1-9]\d*|0\.\d*[1-9])|"
    r"\bpay\s+\$\s?[1-9]|card\s*number|payment\s*(?:method|information|details)|"
    r"\bpurchase\s+(?:this\s+)?seat",
    re.IGNORECASE,
)


def current_seat_from_text(text: str) -> str | None:
    """'Seat 14C' on a manage-reservation page."""
    m = _CURRENT_RE.search(text or "")
    return m.group(1).upper() if m else None


def page_asks_for_payment(text: str) -> bool:
    return bool(_PAYMENT_RE.search(text or ""))


def seat_costs_money(driver, llm_client=None) -> bool:  # noqa: ANN001
    """After clicking a seat: does finishing the change mean paying? Either a
    payment pattern on the page or the LLM saying so counts as yes."""
    from .llm_browser import verify_outcome  # noqa: PLC0415 - keeps this module dependency-free

    try:
        text = driver.execute_script("return document.body ? document.body.innerText : ''") or ""
    except Exception:  # noqa: BLE001 - can't read the page: don't risk a charge
        return True
    if page_asks_for_payment(text):
        return True
    verdict = verify_outcome(
        driver,
        "Would confirming this seat selection charge the passenger money (a price, fee, "
        "total due or payment form is shown for it)?",
        llm_client,
    )
    return bool(verdict and verdict.get("answer") is True)
