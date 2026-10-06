"""Watchdog: alerts when the check-in worker dies or freezes.

The worker can't report its own death, so this runs as a separate process:
on macOS launchd starts it every 5 minutes (macos/run.sh watchdog); in Docker
supervisord runs it with --loop. It reads the heartbeats the worker writes to
the database (see safety_net.py) and sends one alert when they go stale, then
an all-clear when they recover.

    python watchdog.py          check once and exit
    python watchdog.py --loop   check every 5 minutes forever
"""

from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import get_connection

from lib.log import get_logger

logger = get_logger(__name__)

ALIVE_STALE_MINUTES = 5  # heartbeat thread writes every minute
LOOP_STALE_MINUTES = 45  # one loop can legitimately take a while (logins, seat upgrades)
STARTUP_GRACE_MINUTES = 5


def _state(conn, key: str) -> tuple[str | None, datetime | None]:
    row = conn.execute(
        "SELECT value, updated_at FROM system_state WHERE key = ?", (key,)
    ).fetchone()
    if not row:
        return None, None
    updated = datetime.fromisoformat(row["updated_at"].replace(" ", "T")).replace(
        tzinfo=timezone.utc
    )
    return row["value"], updated


def _set(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, datetime('now')) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value),
    )
    conn.commit()


def _next_checkin(conn, now: datetime) -> datetime | None:
    rows = conn.execute(
        "SELECT departure_time FROM flights WHERE checkin_status IN ('pending', 'scheduled') "
        "AND departure_time > ?",
        (now.strftime("%Y-%m-%dT%H:%M:%S"),),
    ).fetchall()
    times = []
    for (dep,) in rows:
        try:
            d = datetime.fromisoformat(dep)
        except ValueError:
            continue
        d = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
        times.append(d - timedelta(days=1))
    future = [t for t in times if t > now - timedelta(hours=1)]
    return min(future) if future else None


def diagnose(conn, now: datetime) -> str | None:
    """Return a description of the problem, or None if the worker looks healthy."""
    _, alive_at = _state(conn, "worker_alive")
    _, loop_at = _state(conn, "worker_loop")
    if alive_at is None:
        # Never started (or a fresh install still starting): only complain
        # once the watchdog itself has been around for a while.
        _, first_seen = _state(conn, "watchdog_first_seen")
        if first_seen is None:
            _set(conn, "watchdog_first_seen", "1")
            return None
        if now - first_seen < timedelta(minutes=STARTUP_GRACE_MINUTES):
            return None
        return "the check-in worker has never started"
    if now - alive_at > timedelta(minutes=ALIVE_STALE_MINUTES):
        minutes = int((now - alive_at).total_seconds() // 60)
        return f"the check-in worker stopped running {minutes} minutes ago"
    if loop_at and now - loop_at > timedelta(minutes=LOOP_STALE_MINUTES):
        minutes = int((now - loop_at).total_seconds() // 60)
        return f"the check-in worker is running but has been stuck for {minutes} minutes"
    return None


def check_once(notify=None) -> str | None:
    if notify is None:
        from notifications import send_notification as notify

    now = datetime.now(timezone.utc)
    conn = get_connection()
    try:
        problem = diagnose(conn, now)
        alerted, _ = _state(conn, "watchdog_alerted")
        if problem and alerted != "1":
            nxt = _next_checkin(conn, now)
            when = (
                f" The next check-in opens {nxt.astimezone().strftime('%a %-I:%M %p')}."
                if nxt
                else ""
            )
            notify(
                "Airline Check-In needs attention",
                f"Heads up: {problem}.{when} It restarts automatically; if this alert "
                "doesn't clear in a few minutes, restart the Mac or run ./macos/ctl.sh restart, "
                "and check in by hand if a check-in is close.",
                "critical",
            )
            _set(conn, "watchdog_alerted", "1")
            logger.error("Watchdog alert sent: %s", problem)
        elif not problem and alerted == "1":
            notify(
                "Airline Check-In is running again", "The check-in worker recovered.", "critical"
            )
            _set(conn, "watchdog_alerted", "0")
            logger.info("Watchdog: worker recovered")
        return problem
    finally:
        conn.close()


def main() -> None:
    if "--loop" in sys.argv:
        while True:
            try:
                check_once()
            except Exception as err:  # noqa: BLE001 - keep watching
                logger.error("Watchdog check failed: %s", err)
            time.sleep(300)
    else:
        check_once()


if __name__ == "__main__":
    main()
