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


def _code(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("code") or value.get("airportCode") or ""
    value = str(value or "").strip().upper()
    return value if _AIRPORT.match(value) else ""


def _number(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("number") or value.get("flightNumber") or ""
    value = str(value or "").strip().upper().removeprefix("WN").lstrip("#").strip()
    return value if _FLIGHT_NO.match(value) else ""


def _bound(obj: dict) -> dict | None:
    """One flight (or one direction with connections) from a reservation object."""
    dep = _code(
        obj.get("departureAirport") or obj.get("originationAirportCode") or obj.get("origin")
    )
    arr = _code(
        obj.get("arrivalAirport") or obj.get("destinationAirportCode") or obj.get("destination")
    )
    date = str(obj.get("departureDate") or "")[:10]
    clock = str(obj.get("departureTime") or "")[:5]
    if not (dep and arr and _DATE.match(date) and _CLOCK.match(clock)):
        return None
    numbers: list[str] = []
    flights = obj.get("flights") or obj.get("segments") or []
    if isinstance(flights, list):
        numbers = [n for n in (_number(f) for f in flights) if n]
    if not numbers:
        raw = obj.get("flightNumbers") or obj.get("flightNumber") or obj.get("number") or ""
        numbers = [n for n in (_number(x) for x in re.split(r"[/,\s\u200b]+", str(raw))) if n]
    if not numbers:
        return None
    return {
        # Same format as flights found through the phone-app service
        "flight_number": "\u200b/\u200b".join(numbers),
        "departure_airport": dep,
        "destination_airport": arr,
        "departure_local": f"{date}T{clock}",
    }


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
    flights = read_flights(text, llm) if llm.enabled else []
    if flights:
        return {
            "ok": True,
            "flights": flights,
            "message": f"Read {len(flights)} flight(s) from the southwest.com page",
        }
    return {
        "ok": False,
        "flights": [],
        "message": (
            "Opened the reservation on southwest.com but couldn't read its flights "
            f"(page saved in captures/reservations for a closer look; {len(records)} data "
            "response(s) seen)"
        ),
    }
