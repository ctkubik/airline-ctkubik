"""Minimal config stub for the worker.
Only provides the values needed by webdriver.py and other lib modules."""

import os
import sys

IS_DOCKER = os.environ.get("AUTO_SOUTHWEST_CHECK_IN_DOCKER") == "1"
IS_MACOS = sys.platform == "darwin"

# Everything the app stores (database, captures, generated credentials) lives
# here. Docker mounts /app/data; a native macOS install points this at the
# repo's ./data folder via macos/run.sh.
DATA_DIR = os.environ.get("DATA_DIR", os.path.join("/app", "data"))
CAPTURES_DIR = os.path.join(DATA_DIR, "captures")

# How Chrome is displayed:
#   xvfb     - headed Chrome inside a virtual X display (Docker / Linux servers)
#   headed   - a real Chrome window (macOS; needs a logged-in user session)
#   headless - no window at all (more likely to be flagged by Southwest's WAF)
_DEFAULT_BROWSER_MODE = "xvfb" if IS_DOCKER else "headed" if IS_MACOS else "headless"
BROWSER_MODE = os.environ.get("BROWSER_MODE", _DEFAULT_BROWSER_MODE).lower()
if BROWSER_MODE not in ("xvfb", "headed", "headless"):
    BROWSER_MODE = _DEFAULT_BROWSER_MODE


class ConfigError(Exception):
    pass
