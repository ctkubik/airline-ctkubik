# Step-by-Step Setup Guide (No Docker Experience Needed)

This guide takes you from a blank computer to a fully working app: automatic
Southwest check-ins, fare watches across other airlines, notifications on your
phone, logins for your whole family, and (optionally) a public web address you
can use from anywhere.

No prior Docker knowledge is assumed. Budget 30–60 minutes for everything.

## Table of Contents
- [How this works (30-second version)](#how-this-works-30-second-version)
- [What you need](#what-you-need)
- [Part 1: Install Docker](#part-1-install-docker)
- [Part 2: Download the app](#part-2-download-the-app)
- [Part 3: Start the app](#part-3-start-the-app)
- [Part 4: First-time setup in the app](#part-4-first-time-setup-in-the-app)
- [Part 5: Fare watches for other airlines (Amadeus keys)](#part-5-fare-watches-for-other-airlines-amadeus-keys)
- [Part 6: Access it from anywhere](#part-6-access-it-from-anywhere)
- [Part 7: Everyday operations](#part-7-everyday-operations)
- [Troubleshooting](#troubleshooting)

## How this works (30-second version)

**Docker** is a program that runs apps in isolated boxes called *containers*,
so you never have to install Python, Node, Chrome, or anything else this app
needs — Docker builds all of that into the container for you.

**Docker Compose** is the part of Docker that reads a file in this project
(`docker-compose.yml`) describing how to build and run the app. You don't
"download an app into Docker Compose" — you download this project's folder,
and one command (`docker compose up`) tells Docker to build and run everything
in it.

The app itself is two programs in one container: a website (the dashboard you
log into) and a background worker (the thing that does check-ins and fare
checks). Your data is stored in a `data/` folder next to the project, so you
can rebuild or update the app without losing anything.

## What you need

- **A computer that stays on.** Check-ins happen at exact moments (24 hours
  before departure), so the app must be running then. Good options: an old
  laptop or desktop, a mini PC, or a Raspberry Pi 4/5. Your daily-driver
  laptop works too, as long as it's on and awake around check-in times.
- **Administrator access** on that computer (to install Docker).
- That's it. Everything below is free unless noted.

## Part 1: Install Docker

Pick your operating system:

### Windows 10/11
1. Download **Docker Desktop** from
   [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
2. Run the installer. If it asks about **WSL 2**, accept (it's the recommended
   backend); the installer sets it up for you.
3. Restart when prompted, then open **Docker Desktop** and wait until the
   whale icon in the taskbar stops animating ("Docker Desktop is running").
4. In Docker Desktop settings, enable **"Start Docker Desktop when you sign in"**
   so the app survives reboots.
5. Open **PowerShell** (Start menu → type "PowerShell") for the commands below.

### Mac
1. Download **Docker Desktop** from
   [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
   (choose Apple Silicon or Intel to match your Mac).
2. Open the `.dmg`, drag Docker into Applications, and launch it.
3. In Docker's settings, enable **"Start Docker Desktop when you sign in"**.
4. Open **Terminal** (Cmd+Space → "Terminal") for the commands below.

### Linux (Ubuntu/Debian) or Raspberry Pi
Run this in a terminal (it installs Docker Engine + Compose):
```shell
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```
Then **log out and back in** (so the group change takes effect). Docker starts
automatically on boot on Linux.

> **Raspberry Pi note**: use Raspberry Pi OS **64-bit** (or Ubuntu Server
> 64-bit). A Pi 4 or 5 with at least 4 GB of RAM is recommended — the app runs
> a real Chrome browser internally.

### Verify Docker works
In your terminal:
```shell
docker --version
docker compose version
```
Both should print version numbers. If you get "command not found" or "cannot
connect to the Docker daemon", see [Troubleshooting](#troubleshooting).

## Part 2: Download the app

Two ways — use whichever you're comfortable with.

**Option A: with git** (installed by default on Mac/Linux; on Windows, get it
from [git-scm.com](https://git-scm.com/download/win)):
```shell
git clone https://github.com/ctkubik/airline-ctkubik.git
cd airline-ctkubik
```

**Option B: without git** (Download ZIP):
1. Go to [github.com/ctkubik/airline-ctkubik](https://github.com/ctkubik/airline-ctkubik)
2. Click the green **Code** button → **Download ZIP**
3. Unzip it somewhere permanent (e.g. `Documents/airline-ctkubik`)
4. In your terminal, `cd` into that folder, e.g.:
   ```shell
   cd ~/Documents/airline-ctkubik
   ```

Everything in the rest of this guide is run **from inside this folder**.

## Part 3: Start the app

One command:
```shell
docker compose up -d --build
```

What happens: Docker downloads the base images, builds the app (compiling the
dashboard takes a while), and starts it in the background. **The first build
takes 5–15 minutes** — later restarts take seconds. You'll see lots of build
output; that's normal.

When it finishes, get your login password (the app generated one for you):
```shell
docker compose logs app | head -30
```
Look for the block:
```
==============================================================
 Auto Southwest Check-In

 Web UI:   http://localhost:3000
 Username: admin
 Password: 4e99...
==============================================================
```

Open **http://localhost:3000** in a browser on the same computer and log in.
From another device on your home network, use the computer's local IP instead,
e.g. `http://192.168.1.50:3000` (find it with `ipconfig` on Windows or
`ip addr` / `ifconfig` on Mac/Linux).

**Prefer your own password?** Copy the example env file and edit it:
```shell
cp .env.example .env      # Windows PowerShell: copy .env.example .env
```
Open `.env` in any text editor, set `AUTH_USERNAME`, `AUTH_PASSWORD`, and
`AUTH_SECRET` (any long random string), then apply it:
```shell
docker compose up -d
```
(Changes to `.env` always need `docker compose up -d` to take effect.)

> **Heads up**: `AUTH_SECRET` also encrypts your stored Southwest passwords.
> If you ever change it, log back in and re-enter your Southwest account
> passwords on the Accounts page.

## Part 4: First-time setup in the app

1. **Add your Southwest account** — Accounts page → enter your Southwest
   username/password → the app finds all your reservations automatically and
   checks you in 24 hours before each flight. Or add individual trips by
   confirmation number on the Reservations page (no Southwest login needed).
2. **Set up notifications** — Settings page. Two easy options:
   - **Text messages**: fill in the Twilio quick-setup form (requires a
     [Twilio](https://www.twilio.com) account; pay-per-text, pennies).
   - **Telegram (free)**: create a bot with [@BotFather](https://t.me/BotFather),
     then add a notification service with the URL format
     `tgram://BOTTOKEN/CHATID`. Any of
     [Apprise's 100+ services](https://github.com/caronc/apprise#supported-notifications)
     work here.
   - Click **Send Test Notification** to confirm delivery (arrives within a
     minute).
3. **Create logins for your family** — Users page → Add User. Give each person
   their own username/password with the **Member** role (they can use
   everything except user management). Do this before exposing a public URL.
4. **Set up family logins and ownership** — Users page → add each family
   member with the **Member** role. Then on the Accounts page (as admin) set
   each Southwest account's **Owner** to the right person. From then on, each
   member sees only their own accounts, flights, and credits when they log in,
   while you (admin) see everyone's.
5. **Travel credits** — the app auto-syncs flight credits from each monitored
   account (shown as **synced** on the Credits page), and reminds you 30 and 7
   days before any credit expires. You can also add credits manually for people
   without a monitored account.
6. **Leave "Auto Seat Upgrade" off** unless you want to experiment — it's an
   experimental feature that automates Southwest's website and is unreliable
   (see the README's [Seat Upgrades](README.md#seat-upgrades-experimental)
   section).

## Part 5: Fare watches for other airlines (Amadeus keys)

The **Fare Watches** page tracks prices across airlines (United, Delta,
American, Frontier, etc. — everything except Southwest, which no third-party
API carries; Southwest fares are tracked natively on the Flights page). It
uses the free Amadeus flight-search API, which needs a one-time signup:

1. Go to [developers.amadeus.com](https://developers.amadeus.com) and click
   **Register** (free, no credit card)
2. After logging in, open **My Self-Service Workspace** → **Create new app**
   (name it anything, e.g. "fare-watch")
3. Copy the **API Key** and **API Secret** it shows you
4. Add them to your `.env` file:
   ```
   AMADEUS_CLIENT_ID=your_api_key_here
   AMADEUS_CLIENT_SECRET=your_api_secret_here
   ```
5. Apply: `docker compose up -d`

Now create a watch: **Fare Watches → New Watch**. Give it a name ("Mom's
visit in October"), the airports, and a departure window — optionally a
return window, traveler count, nonstop-only, and a target price. The app
checks every 6 hours and notifies you (same services as check-in alerts) when
the price drops or comes in under your target.

> **Good to know**: new Amadeus accounts start in their **test environment** —
> limited, cached fare data that's fine for trying the feature. For real
> coverage, open your app in the Amadeus dashboard and request **production
> keys** (also free at this usage level), then set `AMADEUS_ENV=production`
> in `.env`.

## Part 6: Access it from anywhere

Out of the box the app is only reachable on your home network. Two free ways
to change that — **pick one**:

### Option A: Tailscale — private, easiest, no domain needed

Best if only your household/family will use it and everyone is willing to
install a small app on their phone/laptop.

1. Create a free account at [tailscale.com](https://tailscale.com)
2. Install Tailscale on the computer running Docker, and on each phone/laptop
   that should have access ([tailscale.com/download](https://tailscale.com/download));
   log each into the same account (or use its "Invite" feature for family)
3. From any of those devices, open `http://<machine-name>:3000` — Tailscale's
   admin panel shows each machine's name and address

Nothing is exposed to the public internet; there's nothing else to secure.

### Option B: Cloudflare Tunnel — a real public URL (https://flights.yourname.com)

Best if you want family to just open a website with no software installed.
Free from Cloudflare, but it requires **a domain name you own** (roughly
$10/year — Cloudflare itself sells them at cost, which is the easiest path).

**Step 1 — Cloudflare account + domain**
1. Create a free account at [cloudflare.com](https://www.cloudflare.com)
2. If you don't own a domain: in the Cloudflare dashboard go to
   **Domain Registration → Register Domain** and buy one (e.g.
   `kubikfamily.com`)
3. If you already own one elsewhere: **Add a domain** in the dashboard and
   follow its instructions to point your registrar's nameservers at
   Cloudflare (takes minutes to a few hours to activate)

**Step 2 — Create the tunnel**
1. Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com)
   (Cloudflare Zero Trust — the free plan is fine; it may ask you to pick a
   team name)
2. **Networks → Tunnels → Create a tunnel**
3. Choose **Cloudflared** as the connector type and name it (e.g.
   `southwest-checkin`)
4. On the "Install and run a connector" screen, **don't run their command** —
   just copy the **token**: it's the long string of letters/numbers after
   `--token` in the command they show (starts with `eyJ`)
5. Click **Next** to the **Route tunnel / Public Hostname** step and fill in:
   - **Subdomain**: `flights` (or whatever you like)
   - **Domain**: your domain
   - **Service Type**: `HTTP`
   - **URL**: `app:3000`  ← exactly this; it's the app's name inside Docker
6. Save the tunnel

**Step 3 — Start the tunnel on your machine**
1. Add the token to your `.env` file:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJhbGciOi...the-whole-long-string
   ```
2. Start the app **with the tunnel profile** (use this command from now on):
   ```shell
   docker compose --profile tunnel up -d
   ```
3. In the Cloudflare Tunnels page your tunnel should show **HEALTHY** within a
   minute, and `https://flights.yourdomain.com` now serves your dashboard —
   with HTTPS handled automatically.

**Step 4 — Lock it down (do this immediately)**
- Make sure your admin password is strong (set `AUTH_PASSWORD` in `.env`)
- Create individual **Member** accounts on the Users page for each family
  member — don't share the admin login

### Which should I pick?
Tailscale if "family installs one app" is acceptable — it's simpler and
nothing is public. Cloudflare Tunnel if you want a plain URL anyone in the
family can open from any browser.

## Part 7: Everyday operations

All commands run from the project folder.

| Task | Command |
|------|---------|
| See app logs (live) | `docker compose logs -f app` |
| Restart the app | `docker compose restart app` |
| Stop everything | `docker compose down` |
| Start again | `docker compose up -d` (add `--profile tunnel` if you use the tunnel) |
| Apply `.env` changes | `docker compose up -d` |
| Check status/health | `docker compose ps` |

**Updating to a new version of the app**
```shell
git pull
docker compose up -d --build
```
(ZIP users: download the new ZIP, replace the folder — but **keep your `data/`
folder and `.env` file** — then run the same build command.)

**Backups**: everything that matters (database, credentials, capture files)
lives in the `data/` folder. Copy that folder somewhere safe now and then, or
back it up with any tool you already use. To restore: put it back and
`docker compose up -d`.

## Troubleshooting

**"cannot connect to the Docker daemon" / "docker: command not found"**
Docker isn't running. Windows/Mac: open the Docker Desktop app and wait for it
to say running. Linux: `sudo systemctl start docker`. If `docker` works only
with `sudo` on Linux, you skipped the `usermod` step in Part 1 (run it, then
log out/in).

**Port 3000 already in use** (`bind: address already in use`)
Another program is using port 3000. Edit `docker-compose.yml` and change
`"3000:3000"` to `"3080:3000"`, run `docker compose up -d`, and use
`http://localhost:3080` instead.

**Forgot the login password**
Set your own in `.env` (`AUTH_PASSWORD=something-strong`) and run
`docker compose up -d` — the env value always wins. Or delete
`data/.auth-password` and restart to generate a fresh one (shown in the logs).

**I changed `.env` but nothing happened**
`docker compose restart` is not enough for env changes — run
`docker compose up -d`, which recreates the container with the new values.

**The dashboard loads but flights show errors / 403s**
Southwest's bot protection occasionally blocks requests. Check
**Activity → Diagnostics** in the app for details. Running from a home
internet connection (not a cloud server) is the most reliable setup; errors
usually clear on the next cycle.

**Login works on the computer itself but not from my phone (same Wi-Fi)**
Use the computer's LAN IP (`http://192.168.x.x:3000`), and check the
computer's firewall allows inbound connections on port 3000. On Windows,
Docker Desktop normally prompts once — click Allow.

**Build fails on Raspberry Pi**
Make sure the OS is 64-bit (`uname -m` should print `aarch64`). 32-bit
systems can't run this app's browser.

**Fare watches say "Setup needed" or never update**
The Amadeus keys are missing or wrong — recheck Part 5, and remember
`docker compose up -d` after editing `.env`. Individual watch errors appear
in red on the watch card.

**Tunnel shows DOWN in Cloudflare**
The tunnel container isn't running: `docker compose --profile tunnel up -d`,
then `docker compose logs tunnel`. Most common cause is a truncated
`CLOUDFLARE_TUNNEL_TOKEN` — recopy the entire string.
