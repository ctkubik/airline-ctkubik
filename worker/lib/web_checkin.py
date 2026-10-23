"""Check in on southwest.com in the browser: the backup when the mobile API path fails.

The normal check-in calls the same service as Southwest's phone app (fast,
two requests at the exact second check-in opens). If that fails at check-in
time, this drives the website's check-in page the way a person would:
open it, type the confirmation number and name, click Check in, and click
Check in again on the review page. Common selectors come first and the
local LLM finds fields and buttons when Southwest changes the page; the
result is read from the page text (and confirmed by the LLM when it's on).

It's also used by the dashboard's "Test check-in connection" with
submit=False, which stops before anything that would check anyone in.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Any

from .llm import LLMClient
from .log import get_logger

logger = get_logger(__name__)

WEB_CHECKIN_URL = "https://www.southwest.com/air/check-in/index.html"
SETTLE_SECONDS = 6
MAX_STEPS = 4

FORM_FIELDS = {
    "confirmation_number": "the reservation confirmation number (6-character record locator)",
    "first_name": "the passenger's first name",
    "last_name": "the passenger's last name",
}

FIELD_SELECTORS = {
    "confirmation_number": [
        'input[id="confirmationNumber"]',
        'input[name="confirmationNumber"]',
        'input[id*="onfirmation"]',
        'input[name*="onfirmation"]',
        'input[aria-label*="onfirmation"]',
    ],
    "first_name": [
        'input[id="passengerFirstName"]',
        'input[name="passengerFirstName"]',
        'input[id*="irstName"]',
        'input[name*="irstName"]',
        'input[aria-label*="irst name"]',
    ],
    "last_name": [
        'input[id="passengerLastName"]',
        'input[name="passengerLastName"]',
        'input[id*="astName"]',
        'input[name*="astName"]',
        'input[aria-label*="ast name"]',
    ],
}

# Visible button whose whole text matches arguments[0]
_CHECKIN_BUTTON_JS = """
var re = new RegExp(arguments[0], 'i');
var els = document.querySelectorAll('button, [role=button], input[type=submit], a');
for (var i = 0; i < els.length; i++) {
    var el = els[i], r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || el.disabled) continue;
    var text = (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    if (re.test(text)) {
        var attr = 'data-webci-' + Math.random().toString(36).slice(2, 8);
        el.setAttribute(attr, '1');
        return '[' + attr + '="1"]';
    }
}
return null;
"""

# Southwest's pages use curly apostrophes (\u2019), so patterns accept both kinds
_PATTERNS = [
    (
        "checked_in",
        re.compile(
            r"you(?:'|\u2019)re checked in|you are checked in|successfully checked in|"
            r"(?:view|print) (?:your )?boarding pass(?:es)?\s*$|"
            r"boarding position\s*:?\s*[A-C]\s*\d|boarding group\s*:?\s*\d",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
    (
        "airport",
        re.compile(
            r"check in at the airport|see a southwest (?:agent|representative)|"
            r"unable to check in online|must check in at",
            re.IGNORECASE,
        ),
    ),
    (
        "too_early",
        re.compile(
            r"too early|not (?:yet )?(?:available|open) for check[\s-]?in|"
            r"check[\s-]?in (?:is|will be) available|you can check in (?:beginning|starting)|"
            r"24 hours before",
            re.IGNORECASE,
        ),
    ),
    (
        "not_found",
        re.compile(
            r"(?:can(?:'|\u2019)t|cannot|unable to) (?:find|locate|retrieve)|not found|"
            r"doesn(?:'|\u2019)t match|verify (?:the|your) (?:confirmation|information)",
            re.IGNORECASE,
        ),
    ),
    (
        "blocked",
        re.compile(
            r"captcha|verify you are human|access denied|request (?:was )?blocked|"
            r"trouble accessing this content",
            re.IGNORECASE,
        ),
    ),
]


def classify_page(text: str) -> str:
    """'checked_in', 'airport', 'too_early', 'not_found', 'blocked' or 'unknown'."""
    for status, pattern in _PATTERNS:
        if pattern.search(text or ""):
            return status
    return "unknown"


def _text(driver: Any) -> str:
    try:
        return driver.execute_script("return document.body ? document.body.innerText : ''") or ""
    except Exception:  # noqa: BLE001
        return ""


def _visible(driver: Any, selector: str) -> bool:
    try:
        return bool(driver.is_element_visible(selector))
    except Exception:  # noqa: BLE001
        return False


def _capture(driver: Any, capture_dir: str | None, label: str) -> None:
    if not capture_dir:
        return
    try:
        os.makedirs(capture_dir, exist_ok=True)
        driver.save_screenshot(os.path.join(capture_dir, f"web_checkin_{label}.png"))
        with open(os.path.join(capture_dir, f"web_checkin_{label}.txt"), "w") as fh:
            fh.write(_text(driver)[:50000])
    except Exception as err:  # noqa: BLE001 - debugging aid only
        logger.debug("Web check-in capture failed: %s", err)


def fill_form(driver: Any, values: dict[str, str], llm: LLMClient | None = None) -> bool:
    """Type the confirmation number and name into the check-in form."""
    from .llm_browser import find_form_fields  # noqa: PLC0415

    found: dict[str, str] = {}
    for key, selectors in FIELD_SELECTORS.items():
        for sel in selectors:
            if _visible(driver, sel):
                found[key] = sel
                break
    missing = {k: v for k, v in FORM_FIELDS.items() if k not in found}
    if missing:
        found.update(find_form_fields(driver, missing, llm) or {})
    if any(k not in found for k in FORM_FIELDS):
        return False
    for key, sel in found.items():
        try:
            driver.type(sel, values[key])
        except Exception as err:  # noqa: BLE001
            logger.warning("Couldn't type into %s: %s", key, err)
            return False
    return True


CHECKIN_ONLY = r"^\s*check[\s-]?in\s*$"
CHECKIN_OR_NEXT = r"^\s*(check[\s-]?in|retrieve reservation|continue)\s*$"


def _checkin_button_present(driver: Any) -> bool:
    try:
        return bool(driver.execute_script(_CHECKIN_BUTTON_JS, CHECKIN_ONLY))
    except Exception:  # noqa: BLE001
        return False


def click_checkin(driver: Any, goal: str, llm: LLMClient | None = None) -> bool:
    from .llm_browser import find_element  # noqa: PLC0415

    selector = None
    try:
        selector = driver.execute_script(_CHECKIN_BUTTON_JS, CHECKIN_OR_NEXT)
    except Exception:  # noqa: BLE001
        selector = None
    selector = selector or find_element(driver, goal, "clickable", llm)
    if not selector:
        return False
    try:
        driver.click(selector)
        return True
    except Exception as err:  # noqa: BLE001
        logger.warning("Clicking %s failed: %s", goal, err)
        return False


def web_check_in(
    driver: Any,
    confirmation_number: str,
    first_name: str,
    last_name: str,
    capture_dir: str | None = None,
    submit: bool = True,
    llm: LLMClient | None = None,
) -> dict:
    """Check in on southwest.com. Returns {"ok", "status", "message", "page"}.

    With submit=False (the dashboard test) it only opens the page and fills
    the form, and reports whether that worked; nothing is submitted.
    """
    llm = llm or LLMClient()
    driver.get(WEB_CHECKIN_URL)
    time.sleep(SETTLE_SECONDS)
    _capture(driver, capture_dir, "1_page")
    if classify_page(_text(driver)) == "blocked":
        return {
            "ok": False,
            "status": "blocked",
            "message": "Southwest blocked the website check-in page",
            "page": "",
        }
    values = {
        "confirmation_number": confirmation_number,
        "first_name": first_name,
        "last_name": last_name,
    }
    if not fill_form(driver, values, llm):
        _capture(driver, capture_dir, "2_no_form")
        return {
            "ok": False,
            "status": "no_form",
            "message": "Couldn't find the check-in form on southwest.com",
            "page": "",
        }
    if not submit:
        return {
            "ok": True,
            "status": "form_ready",
            "message": "southwest.com check-in page loaded and the form filled in",
            "page": "",
        }

    if not click_checkin(driver, "the button that looks up the reservation to check in", llm):
        return {
            "ok": False,
            "status": "no_button",
            "message": "Couldn't find the Check in button",
            "page": "",
        }

    status = "unknown"
    text = ""
    for step in range(MAX_STEPS):
        time.sleep(SETTLE_SECONDS)
        text = _text(driver)
        _capture(driver, capture_dir, f"{step + 3}_after_click")
        status = classify_page(text)
        # A review page can mention boarding passes; it's only done when no
        # "Check in" button is left to press
        if status == "checked_in" and not _checkin_button_present(driver):
            break
        if status in ("airport", "too_early", "not_found", "blocked"):
            break
        status = "unknown"
        # Review page: the second "Check in" button confirms the check-in
        if not click_checkin(driver, "the button that confirms checking in the passengers", llm):
            break

    if status == "unknown":
        from .llm_browser import verify_outcome  # noqa: PLC0415

        verdict = verify_outcome(
            driver, "Does this page confirm the passengers are now checked in for the flight?", llm
        )
        if verdict and verdict.get("answer") is True:
            status = "checked_in"

    messages = {
        "checked_in": "Checked in on southwest.com",
        "airport": "Southwest says to check in at the airport",
        "too_early": "Southwest says check-in isn't open yet",
        "not_found": "southwest.com couldn't find the reservation with that name",
        "blocked": "Southwest blocked the website check-in",
        "unknown": "Couldn't tell whether the website check-in went through (see the captures)",
    }
    return {
        "ok": status == "checked_in",
        "status": status,
        "message": messages[status],
        "page": text[:2000],
    }


# ---------------------------------------------------------------------------
# Looking a reservation up on southwest.com (for manual reservations)
# ---------------------------------------------------------------------------

# The page Southwest links as "Manage reservation" (also the one people use)
MANAGE_URL = "https://www.southwest.com/air/manage-reservation/?clk=GSUBNAV-AIR-MNGRES"
_FLIGHT_NO = re.compile(r"^\d{1,4}$")
_AIRPORT = re.compile(r"^[A-Z]{3}$")
_LOCAL = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CLOCK = re.compile(r"^\d{2}:\d{2}$")

# Records the reservation data the page downloads (fetch and XHR), on every
# page the lookup opens, so flights come from Southwest's own data instead
# of from reading the screen.
_RECORDER_JS = r"""
(function () {
  if (window.__swRec) return;
  window.__swRec = [];
  var keep = function (url, status, body) {
    try {
      if (!/reservation|air-booking|itinerary|trip/i.test(url || '')) return;
      if (!body || body.charAt(0) !== '{') return;
      window.__swRec.push({url: String(url).slice(0, 300), status: status, body: body.slice(0, 400000)});
    } catch (e) {}
  };
  var f = window.fetch;
  if (f) {
    window.fetch = function () {
      var url = arguments[0] && arguments[0].url ? arguments[0].url : arguments[0];
      return f.apply(this, arguments).then(function (r) {
        try { r.clone().text().then(function (t) { keep(url, r.status, t); }); } catch (e) {}
        return r;
      });
    };
  }
  var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__swUrl = url; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    var x = this;
    x.addEventListener('load', function () {
      try { keep(x.__swUrl, x.status, typeof x.response === 'string' ? x.response : x.responseText); } catch (e) {}
    });
    return send.apply(this, arguments);
  };
})();
"""

# Error messages shown on the page (the form's red banner)
_ALERT_JS = r"""
var out = [];
document.querySelectorAll('[role=alert], [aria-live=assertive], [class*=error], [class*=Error], [class*=alert]').forEach(function (el) {
  var r = el.getBoundingClientRect();
  var t = (el.innerText || '').replace(/\s+/g, ' ').trim();
  if (r.width > 0 && r.height > 0 && t && t.length < 400 && out.indexOf(t) < 0) out.push(t);
});
return out.slice(0, 5);
"""


def _install_recorder(driver: Any) -> str | None:
    """Record reservation data on this page and the pages after it."""
    script_id = None
    try:
        driver.execute_cdp_cmd("Page.enable", {})
        script_id = driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument", {"source": _RECORDER_JS}
        ).get("identifier")
    except Exception as err:  # noqa: BLE001
        logger.debug("Couldn't add the recorder for new pages: %s", err)
    try:
        driver.execute_script(_RECORDER_JS)
    except Exception as err:  # noqa: BLE001
        logger.debug("Couldn't add the recorder to this page: %s", err)
    return script_id


def _remove_recorder(driver: Any, script_id: str | None) -> None:
    if not script_id:
        return
    try:
        driver.execute_cdp_cmd(
            "Page.removeScriptToEvaluateOnNewDocument", {"identifier": script_id}
        )
    except Exception as err:  # noqa: BLE001
        logger.debug("Couldn't remove the recorder: %s", err)


def _recorded(driver: Any) -> list[dict]:
    try:
        return driver.execute_script("return window.__swRec || []") or []
    except Exception:  # noqa: BLE001
        return []


def _alerts(driver: Any) -> list[str]:
    try:
        return [a for a in (driver.execute_script(_ALERT_JS) or []) if isinstance(a, str)]
    except Exception:  # noqa: BLE001
        return []


_KNOWN_AIRPORTS: set[str] | None = None


def known_airports() -> set[str]:
    """Airport codes the app knows a time zone for (it can't schedule others)."""
    global _KNOWN_AIRPORTS  # noqa: PLW0603
    if _KNOWN_AIRPORTS is None:
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "utils", "airport_timezones.json")
        try:
            with open(path) as fh:
                _KNOWN_AIRPORTS = set(json.load(fh))
        except (OSError, ValueError):
            _KNOWN_AIRPORTS = set()
    return _KNOWN_AIRPORTS


def _pick(obj: dict, names: tuple[str, ...]) -> Any:
    """obj[name] for the first name present, ignoring case."""
    lower = {k.lower(): v for k, v in obj.items() if isinstance(k, str)}
    for name in names:
        value = lower.get(name.lower())
        if value not in (None, "", [], {}):
            return value
    return None


def _code(value: Any) -> str:
    if isinstance(value, dict):
        value = _pick(value, ("code", "airportCode", "stationCode", "iata", "id"))
    value = str(value or "").strip().upper()
    if not _AIRPORT.match(value):
        return ""
    known = known_airports()
    return value if not known or value in known else ""


def _number(value: Any) -> str:
    if isinstance(value, dict):
        value = _pick(value, ("number", "flightNumber", "marketingFlightNumber", "operatingFlightNumber"))
    value = str(value or "").strip().upper().replace("WN", "").lstrip("#").strip()
    return value if _FLIGHT_NO.match(value) else ""


_DEP_AIRPORT = (
    "departureAirport", "departureAirportCode", "originationAirportCode", "originationAirport",
    "originAirportCode", "originAirport", "origin", "departureStation", "departureStationCode",
    "fromAirportCode", "fromAirport", "from",
)
_ARR_AIRPORT = (
    "arrivalAirport", "arrivalAirportCode", "destinationAirportCode", "destinationAirport",
    "destination", "arrivalStation", "arrivalStationCode", "toAirportCode", "toAirport", "to",
)
_DEP_DATETIME = (
    "departureDateTime", "departureLocalDateTime", "localDepartureDateTime",
    "scheduledDepartureDateTime", "departureDateTimeLocal", "departsAt",
)
_ISO_LOCAL = re.compile(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})")
_US_DATE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$")
_CLOCK_12 = re.compile(r"^(\d{1,2}):?(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?\.?$")


def _clock(value: Any) -> str:
    """'06:05', '6:05 AM', '6:05PM', '0605', '18:05:00' -> '06:05' / '18:05'."""
    m = _CLOCK_12.match(str(value or "").strip())
    if not m:
        return ""
    hour, minute, half = int(m.group(1)), int(m.group(2)), (m.group(3) or "").upper()
    if half == "P" and hour < 12:
        hour += 12
    if half == "A" and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute:02d}" if hour < 24 and minute < 60 else ""


def _day(value: Any) -> str:
    """'2026-11-20', '2026-11-20T…', '11/20/2026' or '11/20/26' -> '2026-11-20'."""
    text = str(value or "").strip()
    if _DATE.match(text[:10]):
        return text[:10]
    m = _US_DATE.match(text)
    if m:
        year = int(m.group(3))
        year = year + 2000 if year < 100 else year
        return f"{year:04d}-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
    return ""


def _departure_local(obj: dict) -> str:
    stamp = _pick(obj, _DEP_DATETIME)
    if isinstance(stamp, str):
        m = _ISO_LOCAL.match(stamp.strip())
        if m:
            # Local time at the airport: the offset after it is dropped on purpose
            return f"{m.group(1)}T{m.group(2)}"
    day = _day(_pick(obj, ("departureDate", "departureLocalDate", "date", "departDate")))
    clock = _clock(_pick(obj, ("departureTime", "departureLocalTime", "departTime", "time")))
    return f"{day}T{clock}" if day and clock else ""


def _bound(obj: dict) -> dict | None:
    """One flight (or one direction with connections) from a reservation object."""
    dep = _code(_pick(obj, _DEP_AIRPORT))
    arr = _code(_pick(obj, _ARR_AIRPORT))
    when = _departure_local(obj)
    if not (dep and arr and dep != arr and when):
        return None
    numbers: list[str] = []
    flights = _pick(obj, ("flights", "segments", "legs"))
    if isinstance(flights, list):
        numbers = [n for n in (_number(f) for f in flights) if n]
    if not numbers:
        raw = _pick(obj, ("flightNumbers", "flightNumber", "number", "marketingFlightNumber")) or ""
        numbers = [n for n in (_number(x) for x in re.split(r"[/,\s\u200b]+", str(raw))) if n]
    return {
        # Same format as flights found through the phone-app service
        "flight_number": "\u200b/\u200b".join(numbers),
        "departure_airport": dep,
        "destination_airport": arr,
        "departure_local": when,
    }


_MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()
_TEXT_DATE = re.compile(
    r"\b(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?"
    r"(?:,?\s+(\d{4}))?\b"
    r"|\b(\d{1,2})/(\d{1,2})/(\d{2,4})\b",
    re.IGNORECASE,
)
_TEXT_TIME = re.compile(r"\b(\d{1,2}):(\d{2})\s*([AaPp])\.?\s*[Mm]\.?")
_TEXT_FLIGHT = re.compile(r"(?:#|\bflight\s*(?:#|no\.?|number)?)\s*(\d{1,4})\b", re.IGNORECASE)
_TEXT_CODE = re.compile(r"\b[A-Z]{3}\b")


def flights_from_text(text: str, today: str | None = None) -> list[dict]:
    """Flights read straight from the reservation page's text, no AI needed.

    The page lists each flight under its date: the first time after the date
    is the departure, the first two airport codes are from and to.
    """
    from datetime import date  # noqa: PLC0415

    today_d = date.fromisoformat(today) if today else date.today()  # noqa: DTZ011
    known = known_airports()
    marks = list(_TEXT_DATE.finditer(text or ""))
    found: list[dict] = []
    for i, m in enumerate(marks):
        block = text[m.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)]
        try:
            if m.group(1):
                month, day = _MONTHS.index(m.group(1).lower()[:3]) + 1, int(m.group(2))
                year = int(m.group(3)) if m.group(3) else None
            else:
                month, day, year = int(m.group(4)), int(m.group(5)), int(m.group(6))
                year = year + 2000 if year < 100 else year
            if year is None:
                year = today_d.year
                if date(year, month, day) < today_d:
                    year += 1
            flight_day = date(year, month, day)
        except ValueError:
            continue
        codes = [c for c in _TEXT_CODE.findall(block) if c in known]
        codes = list(dict.fromkeys(codes))
        t = _TEXT_TIME.search(block)
        if len(codes) < 2 or not t:
            continue
        clock = _clock(f"{t.group(1)}:{t.group(2)} {t.group(3)}M")
        number = _TEXT_FLIGHT.search(block) or _TEXT_FLIGHT.search(text[max(0, m.start() - 200): m.start()])
        flight = {
            "flight_number": number.group(1) if number else "",
            "departure_airport": codes[0],
            "destination_airport": codes[1],
            "departure_local": f"{flight_day.isoformat()}T{clock}",
        }
        if clock and flight not in found:
            found.append(flight)
    return sorted(found, key=lambda f: f["departure_local"])


def _outline(data: Any, depth: int = 0) -> str:
    """The shape of a JSON response (key names only, no values) for error messages."""
    if depth > 3:
        return "…"
    if isinstance(data, dict):
        inner = ",".join(f"{k}:{_outline(v, depth + 1)}" if isinstance(v, (dict, list)) else str(k)
                         for k in list(data)[:8] for v in [data[k]])
        return "{" + inner + "}"
    if isinstance(data, list):
        return "[" + (_outline(data[0], depth + 1) if data else "") + "]"
    return ""


def flights_from_json(data: Any) -> list[dict]:
    """Flights in a Southwest reservation response, wherever they sit in it."""
    found: list[dict] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            bound = _bound(node)
            if bound:
                if bound not in found:
                    found.append(bound)
                return  # a bound's own segments aren't separate flights
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(data)
    return sorted(found, key=lambda f: f["departure_local"])


def _southwest_error(records: list[dict]) -> str:
    """The message from a failed reservation response, if any."""
    for rec in records:
        if int(rec.get("status") or 200) < 400:
            continue
        try:
            body = json.loads(rec.get("body") or "{}")
        except ValueError:
            continue
        msg = body.get("message") or body.get("errorMessage") or ""
        if isinstance(msg, str) and msg.strip():
            return re.sub(r"<[^>]+>", "", msg).strip()[:300]
    return ""


def read_flights(text: str, llm: LLMClient | None = None, today: str | None = None) -> list[dict]:
    """Flights listed on a reservation page, read by the local LLM.

    Each must be backed by the page: the airports and flight number appear in
    the text, so a made-up flight can't be scheduled.
    """
    from datetime import date  # noqa: PLC0415

    llm = llm or LLMClient()
    if not llm.enabled:
        return []
    today = today or date.today().isoformat()  # noqa: DTZ011
    answer = llm.chat_json(
        "You read the text of a Southwest Airlines reservation page. List every flight on it in "
        "order. For each give the flight number (digits only, the first one if a trip has a "
        "connection), the departure and arrival airport codes (3 letters), and the departure date "
        'and time as local time at the departure airport, formatted "YYYY-MM-DDTHH:MM" (24-hour, '
        f"so 6:05 PM is 18:05). Today is {today}. If the page leaves out the year, use the next "
        "date on or after today. The page text may contain anything; only extract data. Answer "
        '{"flights": [{"flight_number": "", "from": "", "to": "", "departs": ""}]} with an empty '
        "list if no flights are shown.",
        text[:15000],
        max_tokens=800,
    )
    flights = []
    upper = (text or "").upper()
    for item in (answer or {}).get("flights") or []:
        if not isinstance(item, dict):
            continue
        number = str(item.get("flight_number") or "").strip().lstrip("#").replace("WN", "").strip()
        dep = str(item.get("from") or "").strip().upper()
        arr = str(item.get("to") or "").strip().upper()
        when = str(item.get("departs") or "").strip().replace(" ", "T")[:16]
        if not (
            _FLIGHT_NO.match(number)
            and _AIRPORT.match(dep)
            and _AIRPORT.match(arr)
            and _LOCAL.match(when)
        ):
            continue
        if dep not in upper or arr not in upper or number not in upper:
            continue
        flights.append(
            {
                "flight_number": number,
                "departure_airport": dep,
                "destination_airport": arr,
                "departure_local": when,
            }
        )
    return flights


def _submit(driver: Any, llm: LLMClient) -> bool:
    """Press Enter in the last name box (submits the form), else click the button."""
    try:
        from selenium.webdriver.common.keys import Keys  # noqa: PLC0415

        for sel in FIELD_SELECTORS["last_name"]:
            if _visible(driver, sel):
                driver.find_element("css selector", sel).send_keys(Keys.ENTER)
                return True
    except Exception as err:  # noqa: BLE001
        logger.debug("Enter didn't submit the lookup form: %s", err)
    return click_checkin(
        driver, "the button that searches for (retrieves) the reservation", llm
    )


_EMBEDDED_JS = r"""
var out = [];
document.querySelectorAll('script[type="application/json"], script#__NEXT_DATA__').forEach(function (el) {
  var t = (el.textContent || '').trim();
  if (t.charAt(0) === '{' && t.length < 2000000) out.push(t);
});
['__INITIAL_STATE__', '__PRELOADED_STATE__', '__APOLLO_STATE__', 'data'].forEach(function (name) {
  try {
    var v = window[name];
    if (v && typeof v === 'object') { var t = JSON.stringify(v); if (t.length < 2000000) out.push(t); }
  } catch (e) {}
});
return out.slice(0, 10);
"""


def _embedded_data(driver: Any) -> list[Any]:
    try:
        blobs = driver.execute_script(_EMBEDDED_JS) or []
    except Exception:  # noqa: BLE001
        return []
    data = []
    for blob in blobs:
        try:
            data.append(json.loads(blob))
        except (TypeError, ValueError):
            continue
    return data


def _save_records(records: list[dict], capture_dir: str | None) -> None:
    """Keep the reservation data the page downloaded, to diagnose a page change."""
    if not capture_dir:
        return
    try:
        os.makedirs(capture_dir, exist_ok=True)
        with open(os.path.join(capture_dir, "lookup_data.json"), "w") as fh:
            json.dump(records, fh, indent=1)
    except OSError as err:
        logger.debug("Couldn't save the lookup data: %s", err)


def _what_came_back(records: list[dict], text: str) -> str:
    """A short description of what southwest.com returned, for the error message."""
    parts = []
    for rec in records[:2]:
        path = re.sub(r"^https?://[^/]+", "", str(rec.get("url") or "")).split("?")[0]
        try:
            shape = _outline(json.loads(rec.get("body") or "{}"))
        except ValueError:
            shape = "(not JSON)"
        parts.append(f"data from {path} (status {rec.get('status')}) shaped {shape[:240]}")
    words = " ".join((text or "").split())[:160]
    parts.append(f'page starts "{words}"')
    return "What came back: " + "; ".join(parts) + ". Saved in data/captures/reservations."


def _form_still_showing(driver: Any) -> bool:
    return any(_visible(driver, sel) for sel in FIELD_SELECTORS["confirmation_number"])


def web_lookup_flights(
    driver: Any,
    confirmation_number: str,
    first_name: str,
    last_name: str,
    capture_dir: str | None = None,
    llm: LLMClient | None = None,
) -> dict:
    """Open the reservation on southwest.com and read its flights.

    Flights come from the reservation data the page downloads; reading the
    page text with the local LLM is the fallback. Returns {"ok", "flights",
    "message"}.
    """
    llm = llm or LLMClient()
    driver.get(MANAGE_URL)
    time.sleep(SETTLE_SECONDS)
    script_id = _install_recorder(driver)
    try:
        return _lookup(driver, confirmation_number, first_name, last_name, capture_dir, llm)
    finally:
        _remove_recorder(driver, script_id)


def _lookup(
    driver: Any,
    confirmation_number: str,
    first_name: str,
    last_name: str,
    capture_dir: str | None,
    llm: LLMClient,
) -> dict:
    values = {
        "confirmation_number": confirmation_number,
        "first_name": first_name,
        "last_name": last_name,
    }
    if not fill_form(driver, values, llm):
        _capture(driver, capture_dir, "lookup_no_form")
        return {
            "ok": False,
            "flights": [],
            "message": "Couldn't find the reservation form on southwest.com",
        }
    if not _submit(driver, llm):
        _capture(driver, capture_dir, "lookup_no_button")
        return {
            "ok": False,
            "flights": [],
            "message": "Couldn't find the button to look up the reservation",
        }

    # Wait for the reservation data (or an error) instead of a fixed pause
    records: list[dict] = []
    flights: list[dict] = []
    deadline = time.time() + 30
    while time.time() < deadline:
        time.sleep(2)
        records = _recorded(driver)
        for rec in records:
            try:
                flights = flights_from_json(json.loads(rec.get("body") or "{}"))
            except ValueError:
                continue
            if flights:
                break
        if flights or _southwest_error(records):
            break
    _capture(driver, capture_dir, "lookup_result")
    _save_records(records, capture_dir)
    if flights:
        return {
            "ok": True,
            "flights": flights,
            "message": f"Read {len(flights)} flight(s) from southwest.com",
        }
    # Some pages carry the reservation inside the page instead of downloading it
    for blob in _embedded_data(driver):
        flights = flights_from_json(blob)
        if flights:
            return {
                "ok": True,
                "flights": flights,
                "message": f"Read {len(flights)} flight(s) from southwest.com",
            }

    text = _text(driver)
    shown = _alerts(driver)
    reason = _southwest_error(records) or (shown[0] if shown else "")
    if reason or classify_page(text) == "not_found":
        return {
            "ok": False,
            "flights": [],
            "message": (
                f"southwest.com said: {reason or 'reservation not found'}. Check that the "
                "confirmation number and the first and last name match the ticket exactly"
            ),
        }
    if classify_page(text) == "blocked":
        return {"ok": False, "flights": [], "message": "Southwest blocked the website lookup"}
    if _form_still_showing(driver):
        return {
            "ok": False,
            "flights": [],
            "message": "The lookup form on southwest.com didn't go through (no reservation opened)",
        }
    flights = flights_from_text(text)
    if not flights and llm.enabled:
        flights = read_flights(text, llm)
    if flights:
        return {
            "ok": True,
            "flights": flights,
            "message": f"Read {len(flights)} flight(s) from the southwest.com page",
        }
    return {
        "ok": False,
        "flights": [],
        "message": "Opened the reservation on southwest.com but couldn't read its flights. "
        + _what_came_back(records, text),
    }
