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


def send_notification(
    title: str,
    message: str,
    severity: str = IMPORTANT,
    *,
    flight_id: str | None = None,
    account_id: str | None = None,
    confirmation_number: str | None = None,
    force: bool = False,
) -> int:
    """Send to every matching service. Returns how many services accepted it.

    Pass flight_id, account_id or confirmation_number for alerts about a
    trip so they reach that traveler; omit all three for system-wide alerts.
    force=True ignores levels and routing (used for test messages).
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
            label = config.get("label") or config["service_url"][:20] + "..."
            try:
                apobj = apprise.Apprise()
                apobj.add(config["service_url"])
                if apobj.notify(title=title, body=message, body_format=apprise.NotifyFormat.TEXT):
                    sent += 1
                    logger.info("Notification sent via %s", label)
                else:
                    logger.warning("Notification failed for %s", label)
                    add_log(conn, f"Notification delivery failed for {label}", "warning")
            except Exception as e:
                logger.error("Error sending notification: %s", e)
                add_log(conn, f"Notification error ({label}): {e}", "error")
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


def notify_test() -> bool:
    """Send a test notification to every service. Returns True if any accepted it."""
    try:
        return (
            send_notification(
                "SW Check-In Test",
                "This is a test notification from your Southwest Auto Check-In system.",
                force=True,
            )
            > 0
        )
    except Exception:
        return False
