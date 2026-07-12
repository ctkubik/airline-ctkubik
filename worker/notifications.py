"""Notification sender that reads config from the database and uses Apprise.

Supports per-user routing: when a user_id is given, the message goes to that
user's own services plus any shared/global services. Without a user_id it
broadcasts to every configured service (test messages, system-wide notices).
"""

import apprise

from db import get_connection, get_notification_configs, add_log
from lib.log import get_logger

logger = get_logger(__name__)


def send_notification(title: str, message: str, user_id: str | None = None) -> None:
    """Send a notification to the relevant configured services."""
    conn = get_connection()
    try:
        configs = get_notification_configs(conn, user_id=user_id)
        if not configs:
            return

        for config in configs:
            try:
                apobj = apprise.Apprise()
                apobj.add(config["service_url"])
                result = apobj.notify(title=title, body=message, body_format=apprise.NotifyFormat.TEXT)
                if result:
                    logger.info("Notification sent via %s", config["service_url"][:20] + "...")
                else:
                    logger.warning("Notification failed for %s", config["service_url"][:20] + "...")
                    add_log(conn, "Notification delivery failed for a service", "warning")
            except Exception as e:
                logger.error("Error sending notification: %s", e)
                add_log(conn, f"Notification error: {e}", "error")
    finally:
        conn.close()


def notify_checkin_success(
    confirmation_number: str, route: str, passenger: str, seat: str = "", user_id: str | None = None
) -> None:
    """Send notification for successful check-in."""
    title = f"Check-In Success: {confirmation_number}"
    msg = f"Successfully checked in {passenger} for flight {route}."
    if seat:
        msg += f" Seat: {seat}"
    send_notification(title, msg, user_id=user_id)


def notify_checkin_failed(
    confirmation_number: str, route: str, passenger: str, error: str, user_id: str | None = None
) -> None:
    """Send notification for failed check-in."""
    title = f"Check-In Failed: {confirmation_number}"
    msg = f"Failed to check in {passenger} for flight {route}. Error: {error}"
    send_notification(title, msg, user_id=user_id)


def notify_fare_drop(
    confirmation_number: str, route: str, price_info: str, user_id: str | None = None
) -> None:
    """Send notification for fare drop."""
    title = f"Fare Drop: {confirmation_number}"
    msg = f"Lower fare found for {route}: {price_info}"
    send_notification(title, msg, user_id=user_id)


def notify_test() -> bool:
    """Send a test notification to all services. Returns True if sent."""
    try:
        send_notification(
            "Concourse Test",
            "This is a test notification from Concourse, your family travel dashboard.",
        )
        return True
    except Exception:
        return False
