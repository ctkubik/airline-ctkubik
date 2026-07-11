## Auto-Southwest Check-In

A web application that automatically checks you in to your Southwest Airlines flights. Features a full web dashboard for managing accounts, monitoring flights, tracking fare changes, recording original booking prices, and configuring seat preferences. Includes a comprehensive check-in data capture system for learning Southwest's assigned seating API. Built on top of [jdholtz/auto-southwest-check-in](https://github.com/jdholtz/auto-southwest-check-in) with a complete web frontend and enhanced worker process.

**Repository**: [github.com/ctkubik/airline-ctkubik](https://github.com/ctkubik/airline-ctkubik)

> **New to Docker?** Follow the **[Step-by-Step Setup Guide](SETUP.md)** — it covers installing Docker, starting the app, notifications, fare-watch API keys, and getting a public URL with Cloudflare Tunnel, assuming no prior experience.

**Note**: If you are checking into an international flight, make sure to fill out all the passport information beforehand.

## Table of Contents
- [Step-by-Step Setup Guide](SETUP.md) *(start here if you're new to Docker)*
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
    * [Quick Start (Docker)](#quick-start-docker)
    * [Remote Access](#remote-access)
    * [Option 2: Web App (Railway)](#option-2-web-app-railway)
    * [Option 3: CLI Only](#option-3-cli-only)
- [Web App Usage](#web-app-usage)
    * [Users](#users-users)
    * [Fare Watches](#fare-watches-fare-watches)
    * [Seat Upgrades (experimental)](#seat-upgrades-experimental)
- [CLI Usage](#cli-usage)
- [Configuration](#configuration)
    * [Environment Variables](#environment-variables)
    * [Seat Preferences](#seat-preferences)
    * [Notifications](#notifications)
- [Check-In Data Capture](#check-in-data-capture)
- [Self-Healing Diagnostics](#self-healing-diagnostics)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [FAQ](#faq)

## Features

### Core
- **Automatic Check-In**: Checks in to flights exactly 24 hours before departure
- **Web Dashboard**: Monitor all flights, accounts, and check-in status from a browser
- **Login Authentication**: Password-protected web interface with HMAC-signed auth cookies

### Account Management
- **Account Monitoring**: Log in with your Southwest account to automatically track all reservations
- **Display Names**: Assign friendly names to accounts for easy identification (e.g., "Mom", "Dad")
- **A-List Support**: Flag accounts as A-List or A-List Preferred status
- **Auto Seat Upgrade** *(experimental — see [Seat Upgrades](#seat-upgrades-experimental))*: automatic seat upgrade attempts 48 hours before departure for A-List accounts
- **Smart Deactivation**: Accounts only deactivate after 3 consecutive confirmed credential failures; transient errors are retried automatically

### Flight Tracking
- **Manual Reservations**: Add individual reservations by confirmation number
- **Route Display**: Full departure and destination airport codes (e.g., MKE -> PHX)
- **Live Countdown Timers**: Real-time countdown to check-in time on every flight
- **Status Tracking**: Pending, scheduled, checking_in, success, and failed states
- **Assigned Seat Display**: Shows seat assignment after check-in (Southwest's new assigned seating model)

### Fare Watches (any airline)
- **Named searches**: Create a watch per trip — "Mom's visit in October", "Spring break to Florida"
- **Multi-airline**: Checks fares across carriers via the free [Amadeus](https://developers.amadeus.com) flight-search API (Southwest fares are tracked natively by the rest of the app)
- **Date windows**: Watch a whole departure/return window, not just one date
- **Drop alerts**: Push/SMS notification when the lowest fare drops (or is under your target price)

### Multi-User Login
- **User accounts**: Admins create accounts for family members (member or admin role)
- **Safe for a public URL**: bcrypt-hashed passwords, signed HttpOnly session cookies, no default credentials

### Fare Monitoring
- **Automatic Fare Checks**: Checks for fare drops every 4 hours using fresh session tokens
- **Fare History**: Complete timeline of price checks per flight with color-coded changes (green = drop, red = increase)
- **Original Fare Tracking**: Manually enter what you paid when booking; displayed alongside fare changes
- **Smart Notifications**: Only notifies on NEW fare drops (deduplicates; won't spam for the same price)
- **Fare Drop Alerts**: Push/SMS notification when a lower fare (> $1 savings) is detected

### Notifications
- **Push Notifications**: Send alerts via Telegram, Discord, Slack, email, and 100+ other services using [Apprise](https://github.com/caronc/apprise)
- **SMS Text Notifications**: Built-in Twilio quick setup form for text message alerts
- **Test Notifications**: One-click test button to verify notification delivery
- **Check-in Notifications**: Alerts on successful or failed check-in attempts
- **Fare Drop Notifications**: Alerts when a lower fare becomes available

### Check-In Learning System
- **Screenshots**: Captures browser screenshots before and after every check-in
- **Full API Recording**: Stores complete request/response bodies for both check-in POST requests (untruncated)
- **Network Traffic Capture**: Records ALL network requests/responses during the check-in window via Chrome DevTools Protocol
- **DOM Snapshots**: Captures the full page HTML at key moments
- **Capture Viewer**: View screenshots, API responses, and network logs in the web UI
- **Zero Latency Impact**: All heavy capture work happens AFTER the time-critical check-in completes

### System
- **Browser-Routed API Calls**: All Southwest API requests are routed through a persistent headless Chrome session to bypass WAF/anti-bot protections on cloud hosting
- **Self-Healing Diagnostics**: Structured diagnostic entries logged when API calls fail, tracking Southwest API changes over time
- **Activity Log**: Full worker activity log with level filtering (info/warning/error) and pagination
- **API Diagnostics Tab**: Expandable entries showing expected vs actual behavior, headers sent, response bodies

## Architecture

The web app runs as a single Docker container with two processes managed by supervisord:

```
┌─────────────────────────────────────────────┐
│              Docker Container               │
│                                             │
│  ┌──────────────┐    ┌──────────────────┐   │
│  │  Next.js App │    │  Python Worker   │   │
│  │  (Frontend + │◄──►│  (Check-in       │   │
│  │   API Routes)│    │   Engine)        │   │
│  └──────┬───────┘    └────────┬─────────┘   │
│         │                     │             │
│         └────────┬────────────┘             │
│                  ▼                          │
│           ┌────────────┐                    │
│           │   SQLite   │                    │
│           │  Database  │                    │
│           └────────────┘                    │
└─────────────────────────────────────────────┘
```

| Component | Technology |
|-----------|------------|
| Frontend | Next.js 14 (App Router) + Tailwind CSS |
| API | Next.js API Routes (read/write SQLite via `better-sqlite3`) |
| Database | SQLite (via `better-sqlite3` for Node, `sqlite3` for Python) |
| Auth | Multi-user accounts (bcrypt) + HMAC-signed session cookies (Edge-compatible middleware) |
| Worker | Python 3.13 with SeleniumBase + headless Chromium |
| Browser Session | Persistent Chrome instance routing API calls via `fetch()` to bypass WAF |
| Process Manager | supervisord (runs Next.js + Python worker) |
| Notifications | Apprise (Telegram, Twilio SMS, Discord, Slack, email, etc.) |
| Data Capture | Chrome DevTools Protocol for screenshots, network traffic, and DOM snapshots |

## Installation

### Quick Start (Docker)

Runs on any machine with [Docker](https://docs.docker.com/get-docker/) installed — an old laptop, a mini PC, or a Raspberry Pi. This is the recommended (and free) way to host the app. If you've never used Docker, the **[Step-by-Step Setup Guide](SETUP.md)** walks through everything below in detail.

```shell
git clone https://github.com/ctkubik/airline-ctkubik.git
cd airline-ctkubik
docker compose up -d --build
```

That's it. Open [http://localhost:3000](http://localhost:3000) and log in with the credentials shown in the container logs:

```shell
docker compose logs app | head -20
```

On first boot the app generates a random password and cookie secret and saves them in the `./data` volume, so they survive restarts. To choose your own credentials instead:

```shell
cp .env.example .env    # edit AUTH_USERNAME / AUTH_PASSWORD / AUTH_SECRET
docker compose up -d --build
```

All application state (database, capture files, generated credentials) lives in `./data` — back up that folder and you can rebuild the container freely.

### Remote Access

The web UI listens on port 3000 on your machine. To reach it from your phone or another network, don't port-forward — use one of these free options:

- **[Tailscale](https://tailscale.com)** (recommended): install it on the host machine and your phone/laptop. The dashboard becomes reachable at `http://<machine-name>:3000` from anywhere, with nothing exposed to the public internet.
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)**: gives the app a public HTTPS URL on a domain you own while it keeps running at home. Built in:
  1. In [Cloudflare Zero Trust](https://one.dash.cloudflare.com) go to **Networks > Tunnels > Create a tunnel** (Cloudflared type), and add a public hostname that points to `http://app:3000`
  2. Copy the tunnel token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN=...`
  3. Start everything with `docker compose --profile tunnel up -d`

  Before exposing a public URL, create real user accounts on the **Users** page so each family member has their own login.

### Option 2: Web App (Railway)

> **Note**: Railway no longer has a free tier (Hobby plan is ~$5/month). For free hosting, use the Docker quick start above on a machine at home.

1. **Fork the repository** on GitHub
2. **Create a Railway project**: **New Project** > **Deploy from GitHub repo**, select your fork — Railway auto-detects the `Dockerfile`
3. **Add a persistent volume** with mount path `/app/data` (Command Palette: `Cmd+K` / `Ctrl+K` > "Create Volume")
4. **Set environment variables** in the **Variables** tab:
   ```
   AUTH_USERNAME=your_username
   AUTH_PASSWORD=your_secure_password
   AUTH_SECRET=a_random_secret_string_at_least_20_chars
   ```
5. **Generate a public domain** under **Settings** > **Networking**, then log in at your Railway URL

> **Tip**: If the volume isn't persisting data, add the environment variable `RAILWAY_RUN_UID=0` to your service.

### Option 3: CLI Only

Use the original command-line interface without the web dashboard.

#### Prerequisites
- [Python 3.9+]
- [Pip]
- [Any Chromium-based browser]

#### Setup
```shell
git clone https://github.com/ctkubik/airline-ctkubik.git
cd airline-ctkubik
pip3 install -r requirements.txt
```

#### Run
```shell
# Check in by confirmation number
python3 southwest.py CONFIRMATION_NUMBER FIRST_NAME LAST_NAME

# Or log in to monitor all flights
python3 southwest.py USERNAME PASSWORD
```

#### CLI Docker
```shell
docker build -f Dockerfile.cli -t sw-checkin-cli .
docker run -d sw-checkin-cli CONFIRMATION_NUMBER FIRST_NAME LAST_NAME
```

## Web App Usage

### Dashboard (`/`)
Overview of your check-in system:
- **Stats cards**: Active accounts, total reservations, upcoming check-ins, successful/failed counts
- **Upcoming check-ins** with live countdown timers
- **Recent activity feed** from the worker process

### Accounts (`/accounts`)
Manage your Southwest accounts:
- **Display names**: Assign friendly names (click the pencil icon to rename inline)
- **A-List toggle**: Click the tier badge to mark accounts as A-List/A-List Preferred
- **Auto Seat Upgrade**: Enable to attempt seat upgrades 48 hours before departure
- **Enable/disable** account monitoring
- **Delete** accounts and their linked reservations
- Accounts survive transient login errors; only deactivate after 3 consecutive confirmed credential failures

### Reservations (`/reservations`)
Track all reservations:
- Reservations are **auto-discovered** when accounts are monitored
- **Add manual reservations** by confirmation number + passenger name
- **Route summaries** in collapsed view (e.g., "MKE -> PHX, PHX -> DEN")
- **Expand** to see flights with routes, departure times, check-in countdowns, and status

### Flights (`/flights`)
Monitor all tracked flights with fare and capture data:
- **Card layout**: Confirmation, passenger, route, departure date/time, fare change, seat, countdown, status
- **Original fare**: Click "$ Set fare" to record what you paid when booking
- **Fare tracking**: Latest fare check result color-coded (green = lower fare, red = increase, gray = same)
- **Click to expand**: Three sections:
  - **Fare History**: Timeline of all fare checks with price changes
  - **Activity Log**: Worker logs specific to this flight
  - **Check-In Captures**: Screenshots, API responses, network logs, and DOM snapshots from check-in
- Flights auto-refresh every 30 seconds

### Activity (`/activity`)
Three tabs for monitoring system behavior:

**Activity Log tab:**
- Filter by level: All, Info, Warning, Error
- Shows all worker actions with timestamps and flight context
- Auto-refreshes every 15 seconds

**Diagnostics tab:**
- Structured API diagnostic entries
- Filter by category (auth_failure, api_error, checkin_failure, fare_check_failure, etc.)
- Click to expand: expected vs actual behavior, headers sent, response body
- Helps track Southwest API changes over time

### Settings (`/settings`)
Configure preferences and notifications:

**Seat Preferences:**
- Select preferred seat letters (A-F toggle buttons, blue = selected)
- Set preferred rows (comma-separated, e.g., `1,2,3,4,5,6`)
- Set fallback seat letters (orange = selected) for when preferred seats are unavailable

**SMS Text Notifications:**
- Built-in Twilio quick setup form
- Enter Account SID, Auth Token, From Number, To Number
- Auto-generates the Apprise URL and adds it as a notification service

**Notification Services:**
- Add any notification service using Apprise URL format
- **Send Test Notification** button to verify delivery (processed within 60 seconds)
- Supports 100+ services including Telegram, Discord, Slack, email, SMS

### Users (`/users`)
Admin-only page to manage who can log in:
- **Add users** with a username, password, display name (e.g. "Grandma"), and role
- **Members** can use the whole dashboard except user management; **admins** can also manage users
- **Reset passwords**, disable, or delete accounts
- The `AUTH_USERNAME`/`AUTH_PASSWORD` pair from `.env` (or the auto-generated one) is a built-in break-glass admin login and is bootstrapped as the first admin account

### Fare Watches (`/fare-watches`)
Named multi-airline fare tracking for trips you're planning:

1. Get free API keys: sign up at [developers.amadeus.com](https://developers.amadeus.com), create an app, and put `AMADEUS_CLIENT_ID` / `AMADEUS_CLIENT_SECRET` in `.env`
2. Create a watch: name it (e.g. "Mom's visit in October"), set origin/destination airports and a departure window — optionally a return window, traveler count, nonstop-only, and a target price
3. The worker checks each watch every 6 hours (`FARE_WATCH_INTERVAL_HOURS` to change) and records the cheapest fare found
4. You get a notification (Telegram/SMS/etc. — same services as check-in alerts) when the price drops or a fare is found under your target

Notes: the free Amadeus tier starts in a **test environment** with limited/cached data — good enough to try it; request (free) production keys in their dashboard for real coverage. Amadeus covers most airlines but **not Southwest**; Southwest fares are tracked natively on the Flights page.

### Seat Upgrades (experimental)
The A-List auto seat-upgrade automates Southwest's desktop website in a real browser. Southwest changes that site frequently, so this feature is fragile: it may fail to find the seat map and can report a seat as selected without Southwest actually confirming it. Failures no longer interfere with check-ins (the browser is always restored, attempts are rate-limited, and check-ins take absolute priority), but treat any "seat selected" notification as unconfirmed until you verify in the Southwest app. The capture/audit system records every attempt (screenshots + DOM) under the flight's captures to help debug. Leave the per-account toggle off if you don't want it attempted at all.

## CLI Usage

For the full usage of the CLI script, run:
```shell
python3 southwest.py --help
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_USERNAME` | Web UI login username | `admin` |
| `AUTH_PASSWORD` | Web UI login password | auto-generated on first boot (see container logs) |
| `AUTH_SECRET` | Secret key for signing auth cookies (use 20+ random chars) | auto-generated on first boot |
| `DB_PATH` | Path to SQLite database file | `/app/data/checkin.db` |
| `RAILWAY_RUN_UID` | Set to `0` if Railway volume has permission issues | (unset) |

There are no insecure default credentials: if `AUTH_PASSWORD`/`AUTH_SECRET` are unset, the Docker entrypoint generates random values, persists them in the data volume, and prints the login password in the container logs. Outside Docker (e.g. Railway), you must set them yourself — the app refuses logins until they are set.

### Seat Preferences

Southwest uses assigned seating (effective January 27, 2026). Configure your preferences in the Settings page:

- **Preferred Letters**: Seat letters to target first (e.g., A, F for window seats)
- **Preferred Rows**: Row numbers where preferred letters are prioritized (e.g., 1-6 for front/extra legroom)
- **Fallback Letters**: Alternative seat letters if preferred are unavailable (e.g., A, C, D, F for aisle/window)

For **A-List members**: Enable "Auto Seat Upgrade" on your account to attempt upgrading to Extra Legroom or Preferred seats 48 hours before departure. Toggle A-List status by clicking the tier badge on the Accounts page.

### Notifications

Notifications are sent for:
- **Check-in success/failure**: Includes confirmation number, route, and passenger name
- **Fare drops**: Only on NEW drops (won't repeat for same price); includes amount and route
- **Test messages**: Via the "Send Test Notification" button in Settings

#### Notification Service Examples

| Service | URL Format |
|---------|------------|
| Telegram | `tgram://BotToken/ChatID` |
| Twilio SMS | Use the built-in SMS setup form, or: `twilio://AccountSid:AuthToken@+FromPhone/+ToPhone` |
| Discord | `discord://WebhookID/WebhookToken` |
| Slack | `slack://TokenA/TokenB/TokenC/Channel` |
| Email (SMTP) | `mailto://user:pass@gmail.com` |
| Pushover | `pover://user@token` |
| AWS SNS | `sns://AccessKeyID/SecretAccessKey/Region/+PhoneNumber` |

See the full list of [Apprise supported notifications](https://github.com/caronc/apprise#supported-notifications).

## Check-In Data Capture

Every check-in triggers a comprehensive data capture to learn how Southwest's assigned seating system works. This data is stored on the persistent volume and viewable in the web UI.

### What Gets Captured

| Data | When | File |
|------|------|------|
| Pre-check-in screenshot | Before check-in | `01_pre_checkin.png` |
| Check-in step 1 request/response | During check-in | `02_checkin_step1_*.json` |
| Check-in step 2 request/response | During check-in | `03_checkin_step2_*.json` |
| Post-check-in screenshot | After check-in | `04_post_checkin.png` |
| Post-check-in DOM | After check-in | `05_post_checkin_dom.html` |
| All network traffic | Full window | `network_log.json` |
| Manifest | After capture | `manifest.json` |

### Design Principles
- **Zero latency impact**: Screenshots and network harvesting happen AFTER the time-critical check-in POST requests complete
- **Store raw data**: Full untruncated API responses; no interpretation or filtering
- **Progressive discovery**: Logs response structures and `_links` entries to discover seat selection endpoints as Southwest evolves their API

### Viewing Captures
On the Flights page, expand a flight that has checked in. The **Check-In Captures** section shows:
- Screenshot thumbnails (click for full size)
- Clickable links for JSON API response files
- DOM snapshot links
- Network event count and total capture size

Storage: `/app/data/captures/{flight_id}/` (typically 1-5 MB per capture)

## Self-Healing Diagnostics

The system includes a structured diagnostics framework to track Southwest API changes:

- **Every API failure** is logged with: category, endpoint, expected vs actual behavior, headers sent, and response body
- **Categories**: `auth_failure`, `api_error`, `api_change`, `checkin_failure`, `fare_check_failure`, `unexpected_response`
- **View diagnostics** in the Activity page > Diagnostics tab
- **Expandable entries** show full detail for debugging
- **Fare check diagnostics**: Captures the full `change_link` object and error response when fare checks fail

This enables progressive adaptation to Southwest's API changes without requiring code updates for every change. Check the Diagnostics tab when things aren't working to see exactly what Southwest is returning.

## Troubleshooting

### Web App
- **Dashboard shows all 0s**: Ensure the worker process is running. Check the Activity page for logs. The worker polls every 60 seconds.
- **Flights not appearing**: Check Activity > Diagnostics for API errors. The worker needs to successfully log in and retrieve reservations before flights appear.
- **403 errors in diagnostics**: The browser session handles this automatically - it restarts the browser every 25 minutes or when a 403 is detected.
- **Login fails**: Verify `AUTH_USERNAME` and `AUTH_PASSWORD` environment variables are set correctly.
- **Data lost after redeploy**: Ensure a persistent volume is mounted at `/app/data`. On Railway, use the Command Palette (`Cmd+K`) to create a volume.
- **Notifications not sending**: Check that notification URLs are correctly formatted. Use the "Send Test Notification" button. The test is processed on the next worker poll cycle (up to 60 seconds).
- **Repeated fare notifications**: The system deduplicates notifications. If you received spam from an earlier version, this is fixed - only new fare drops trigger alerts now.
- **Account deactivated unexpectedly**: Accounts now only deactivate after 3 consecutive confirmed "Invalid credentials" errors. Transient errors (timeouts, 502/503, browser crashes) are retried automatically. Re-enable the account from the Accounts page.
- **Fare checks showing 400 errors**: The worker re-fetches fresh session tokens before each fare check. If 400 errors persist, check the Diagnostics tab for the full error response from Southwest.

### CLI
To troubleshoot the CLI, run with the `--verbose` flag for debug messages, or `--debug-screenshots` for browser screenshots (stored in `logs/`).

If you run into any issues, please file it via [GitHub Issues]. Please attach any relevant logs (found in `logs/auto-southwest-check-in.log`) to the issue.

For common questions, visit the [FAQ](#faq). For discussions, start a [GitHub Discussion].

## Contributing
Contributions are always welcome. Please read [Contributing.md](CONTRIBUTING.md) if you are considering making contributions.

## FAQ

<details>
<summary>Do I Need to Set up a Different Instance for Each Passenger on My Reservation?</summary>

This script will check the entire party in under the same reservation, so there is no need to create more than one instance per reservation.

However, this is not the case if you have a companion attached to your reservation. See the next question for information on checking in a companion.
</details>

<details>
<summary>Will This Script Also Check in the Companion Attached to My Reservation?</summary>

Unfortunately, this is not possible due to how Southwest's companion system works. To ensure your companion is also checked in, you can add their reservation or account separately.
</details>

<details>
<summary>How Does the Seat Selection Work with Southwest's New Assigned Seating?</summary>

Southwest switched from open seating to assigned seats on January 27, 2026. The app adapts to this:

- **At check-in (24h before)**: The app checks in and captures the full API response including any seat assignment data
- **For A-List members (48h before)**: If "Auto Seat Upgrade" is enabled, the app attempts to select/upgrade your seat based on your preferences in Settings
- **Seat preferences**: Configure preferred seat letters, rows, and fallback letters in Settings
- **Check-in captures**: Every check-in records screenshots, full API responses, network traffic, and DOM snapshots so we can progressively learn how Southwest's seat selection API works

The seat selection feature uses a progressive discovery approach - it logs Southwest's API response structures in the Activity page and stores them as check-in captures, allowing the logic to be refined as the API evolves.
</details>

<details>
<summary>How Does Fare Monitoring Work?</summary>

The worker checks fares every 4 hours for all upcoming flights:

1. Re-fetches the reservation from Southwest to get a fresh session token
2. Navigates the change-flight API to find current prices
3. Compares with the same fare class you booked
4. Records the price difference in the fare history
5. Sends a notification ONLY if the fare has dropped further than the last check

You can also manually record what you paid for each flight by clicking "$ Set fare" on the Flights page. This shows alongside the fare change data so you can see the full picture.

Note: Fare checks use fresh session tokens each time (Southwest tokens expire after inactivity), and all API calls go through the browser session to bypass WAF protections.
</details>

<details>
<summary>What Is the Difference Between the Web App and the CLI?</summary>

| Feature | Web App | CLI |
|---------|---------|-----|
| Interface | Browser dashboard | Command line |
| Account monitoring | Automatic, continuous | Manual, one-time |
| Fare checking | Every 4 hours, with history | With config file |
| Original fare tracking | Manual input per flight | Not available |
| Seat management | UI with preferences | Not available |
| Notifications | Telegram, SMS, Discord, etc. | With config file |
| Data persistence | SQLite database | None (in-memory) |
| Check-in captures | Screenshots, API data, network logs | Debug screenshots only |
| Hosting | Railway, Docker, VPS | Local machine |
| Activity logs | Web-based viewer with filtering | Log files |
| Diagnostics | Structured API tracking | Verbose flag |

Use the **Web App** for always-on monitoring. Use the **CLI** for quick one-time check-ins.
</details>

<details>
<summary>How Do API Calls Work on Cloud Hosting?</summary>

Southwest's website uses a WAF (Web Application Firewall) that blocks raw HTTP requests from cloud/datacenter IPs. The web app solves this by routing all API calls through a persistent headless Chrome browser session (`BrowserSession` class). The browser passes the WAF anti-bot challenge, and subsequent API calls are made via JavaScript `fetch()` inside the browser context, inheriting all cookies and WAF tokens.

The browser session auto-restarts every 25 minutes to keep WAF tokens fresh, and restarts immediately if a 403 error is detected. This applies to all Southwest API interactions: reservation retrieval, fare checking, check-in, and seat upgrades.
</details>

<details>
<summary>Why Was My Account Deactivated?</summary>

Accounts are only deactivated after **3 consecutive confirmed "Invalid credentials" errors** from Southwest. This prevents a single transient error from permanently disabling monitoring.

Transient errors (timeouts, 502/503 gateway errors, browser crashes, CAPTCHAs) are treated as temporary and retried on the next cycle. The failure counter resets to 0 on any successful login.

If your account was deactivated, you can re-enable it from the Accounts page by clicking the "Enable" button. If it keeps deactivating, double-check your Southwest username and password.
</details>

<details>
<summary>I Get a [SSL: CERTIFICATE_VERIFY_FAILED] Error. How Can I Fix It?</summary>

If you are on MacOS, this error most likely occurred because your Python installation does not have any root certificates. To install these certificates, follow the directions found at [this Stack Overflow question].
</details>

<details>
<summary>The Worker Is Stuck on 'Starting browser session'. How Can I Fix It?</summary>

Depending on your network speed or compute power, it may take 3 to 5 minutes to start the browser and load the Southwest website. If you are still running into this issue after 8+ minutes, check the deploy logs.

If running Docker, try running with the `--privileged` flag. On Railway, this is handled automatically.
</details>


[Python 3.9+]: https://www.python.org/downloads/
[Pip]: https://pip.pypa.io/en/stable/installation/
[Any Chromium-based browser]: https://en.wikipedia.org/wiki/Chromium_(web_browser)#Browsers_based_on_Chromium
[Python virtual environment]: https://virtualenv.pypa.io/en/stable/
[Docker]: https://www.docker.com/
[GitHub Issues]: https://github.com/ctkubik/airline-ctkubik/issues
[GitHub Discussion]: https://github.com/ctkubik/airline-ctkubik/discussions
[Pull Request]: https://github.com/ctkubik/airline-ctkubik/pulls
[this Stack Overflow question]: https://stackoverflow.com/questions/42098126/mac-osx-python-ssl-sslerror-ssl-certificate-verify-failed-certificate-verify
