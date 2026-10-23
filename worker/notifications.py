"""Notification sender: reads services from the database and sends with Apprise.

Every alert has a severity, and every notification service has a level that
says which severities it wants:

    level 1  Everything      check-ins, seat changes, fare drops, problems
    level 2  Important       fare drops, seat changes and problems (no routine successes)
    level 3  Problems only   failed or missed check-ins, safety-net warnings, app down

Alerts about a trip go to the services that belong to that trip's traveler
(the Southwest account it came from, or the account a manual reservation is
assigned to) plus every service set to "everyone". Alerts that aren't about
one traveler (the app is down, test messages) go to every service.
"""

from __future__ import annotations

import json
import logging
import re

import apprise
from db import add_log, get_connection, get_notification_configs

from lib.log import get_logger

logger = get_logger(__name__)

INFO = "info"
IMPORTANT = "important"
CRITICAL = "critical"
_SEVERITY_RANK = {INFO: 1, IMPORTANT: 2, CRITICAL: 3}


def account_for_flight(conn, flight_id: str | None) -> str | None:
    """The traveler (Southwest account id) a flight belongs to, if known."""
    if not flight_id:
        return None
    row = conn.execute(
        "SELECT COALESCE(r.account_id, r.owner_account_id) AS account_id "
        "FROM flights f JOIN reservations r ON r.id = f.reservation_id WHERE f.id = ?",
        (flight_id,),
    ).fetchone()
    return row["account_id"] if row else None


def account_for_confirmation(conn, confirmation_number: str | None) -> str | None:
    if not confirmation_number:
        return None
    row = conn.execute(
        "SELECT COALESCE(account_id, owner_account_id) AS account_id FROM reservations "
        "WHERE confirmation_number = ? ORDER BY is_active DESC LIMIT 1",
        (confirmation_number,),
    ).fetchone()
    return row["account_id"] if row else None


def wants(config: dict, severity: str, account_id: str | None, personal: bool) -> bool:
    """Whether a notification service should receive this alert."""
    level = int(config.get("notification_level") or 1)
    if _SEVERITY_RANK.get(severity, 2) < min(max(level, 1), 3):
        return False
    if not personal:
        return True  # system-wide alerts reach everyone
    try:
        scope = json.loads(config.get("account_ids") or "null")
    except (TypeError, ValueError):
        scope = None
    if not scope:
        return True  # service is set to "everyone"
    return account_id is not None and account_id in scope


def explain_failure(service_url: str, log_text: str) -> str:
    """Turn Apprise's log output into a short reason a person can act on."""
    lines = [ln.split(" - ", 2)[-1].strip() for ln in log_text.splitlines() if ln.strip()]
    text = " ".join(lines)
    text = text[-400:] if text else ""
    low = text.lower()
    hint = ""
    if service_url.startswith(("tgram://", "telegram://")):
        if "unauthorized" in low or "401" in low or ("not found" in low and "chat" not in low):
            hint = "Telegram didn't accept the bot token. Copy it again from BotFather."
        elif "chat not found" in low:
            hint = (
                "Telegram can't find that chat. Open the bot, tap Start, "
                "send it a message, then test again."
            )
        elif "blocked" in low:
            hint = "The chat blocked the bot. Unblock it in Telegram."
        elif "kicked" in low or "not a member" in low:
            hint = "The bot was removed from that group. Add it back."
        elif "upgraded to a supergroup" in low:
            hint = (
                "The group became a supergroup and has a new chat ID. "
                "Run the Telegram setup again."
            )
    if not hint and ("connection error" in low or "timed out" in low or "timeout" in low):
        hint = "Couldn't reach the service. Check that this computer is online."
    if hint and text:
        return f"{hint} ({text})"
    return hint or text or "The service didn't accept the message (no reason given)."


def record_delivery(conn, config_id: str | None, ok: bool, error: str = "") -> None:
    """Remember the last delivery result for a service (shown in Settings)."""
    if not config_id:
        return
    try:
        conn.execute(
            "UPDATE notification_configs SET last_status = ?, last_error = ?, "
            "last_sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
            ("ok" if ok else "failed", None if ok else error[:500], config_id),
        )
        conn.commit()
    except Exception as e:  # never let bookkeeping stop an alert
        logger.warning("Couldn't record delivery result: %s", e)


def deliver(conn, config: dict, title: str, message: str) -> tuple[bool, str]:
    """Send one message to one service. Returns (ok, reason when it failed)."""
    url = (config.get("service_url") or "").strip()
    apobj = apprise.Apprise()
    if not apobj.add(url):
        reason = "The app can't read this service URL. Check its format (for Telegram: tgram://bot_token/chat_id)."
        record_delivery(conn, config.get("id"), False, reason)
        return False, reason
    with apprise.LogCapture(level=logging.WARNING) as captured:
        try:
            ok = bool(
                apobj.notify(title=title, body=message, body_format=apprise.NotifyFormat.TEXT)
            )
        except Exception as e:
            ok = False
            logger.error("Error sending notification: %s", e)
            captured.write(f"x - ERROR - {e}\n")
        log_text = captured.getvalue()
    reason = "" if ok else explain_failure(url, log_text)
    record_delivery(conn, config.get("id"), ok, reason)
    return ok, reason


def service_label(config: dict) -> str:
    if config.get("label"):
        return config["label"]
    scheme = re.match(r"^([a-z0-9+.-]+)://", config.get("service_url") or "", re.IGNORECASE)
    return f"{scheme.group(1)} service" if scheme else "notification service"


def send_notification(
    title: str,
    message: str,
    severity: str = IMPORTANT,
    *,
    flight_id: str | None = None,
    account_id: str | None = None,
    confirmation_number: str | None = None,
    force: bool = False,
    only_config_id: str | None = None,
    results: list | None = None,
) -> int:
    """Send to every matching service. Returns how many services accepted it.

    Pass flight_id, account_id or confirmation_number for alerts about a
    trip so they reach that traveler; omit all three for system-wide alerts.
    force=True ignores levels and routing (used for test messages).
    only_config_id limits it to one service. Pass a list as results to get
    {"label", "ok", "error"} for each service tried.
    """
    conn = get_connection()
    sent = 0
    try:
        configs = get_notification_configs(conn)
        if not configs:
            return 0
        personal = bool(flight_id or account_id or confirmation_number)
        if account_id is None:
            account_id = account_for_flight(conn, flight_id) or account_for_confirmation(
                conn, confirmation_number
            )
        # A trip with no known traveler (unassigned manual reservation) goes
        # to everyone rather than no one.
        if personal and account_id is None:
            personal = False

        for config in configs:
            if not force and not wants(config, severity, account_id, personal):
                continue
            if only_config_id and config.get("id") != only_config_id:
                continue
            label = service_label(config)
            ok, reason = deliver(conn, config, title, message)
            if results is not None:
                results.append({"label": label, "ok": ok, "error": reason})
            if ok:
                sent += 1
                logger.info("Notification sent via %s", label)
            else:
                logger.warning("Notification failed for %s: %s", label, reason)
                if results is None:  # callers that collect results log them
                    add_log(conn, f"Notification to {label} failed: {reason}", "warning")
    finally:
        conn.close()
    return sent


def notify_checkin_success(
    confirmation_number: str,
    route: str,
    passenger: str,
    seat: str = "",
    flight_id: str | None = None,
) -> None:
    """Send notification for successful check-in."""
    title = f"Check-In Success: {confirmation_number}"
    msg = f"Successfully checked in {passenger} for flight {route}."
    if seat:
        msg += f" Seat: {seat}"
    send_notification(
        title, msg, INFO, flight_id=flight_id, confirmation_number=confirmation_number
    )


def notify_checkin_failed(
    confirmation_number: str, route: str, passenger: str, error: str, flight_id: str | None = None
) -> None:
    """Send notification for failed check-in."""
    title = f"Check-In Failed: {confirmation_number}"
    msg = (
        f"Failed to check in {passenger} for flight {route}. Error: {error}\n"
        "Check in now in the Southwest app or at southwest.com."
    )
    send_notification(
        title, msg, CRITICAL, flight_id=flight_id, confirmation_number=confirmation_number
    )


def notify_fare_drop(
    confirmation_number: str, route: str, price_info: str, flight_id: str | None = None
) -> None:
    """Send notification for fare drop."""
    title = f"Fare Drop: {confirmation_number}"
    msg = f"Lower fare found for {route}: {price_info}"
    send_notification(
        title, msg, IMPORTANT, flight_id=flight_id, confirmation_number=confirmation_number
    )


def notify_test(only_config_id: str | None = None) -> list[dict]:
    """Send a test message to every service (or one). Returns each result."""
    results: list[dict] = []
    send_notification(
        "SW Check-In Test",
        "This is a test notification from your Southwest Auto Check-In system.",
        force=True,
        only_config_id=only_config_id,
        results=results,
    )
    return results
