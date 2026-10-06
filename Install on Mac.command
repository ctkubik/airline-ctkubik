#!/bin/bash
# Double-click this file in Finder to install (or update) Airline Check-In on
# this Mac. It copies the app to your home folder and sets everything up.
cd "$(dirname "$0")" || exit 1
exec /bin/bash macos/bootstrap.sh --source .
