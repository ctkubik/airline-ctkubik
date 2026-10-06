# Running on a Mac Mini (native macOS)

This guide sets the app up to run directly on a Mac, with no Docker. It's the recommended way to
host it on a Mac Mini. The app starts by itself when the Mac starts, restarts itself if it crashes,
and keeps the Mac awake so a 3 a.m. check-in never gets missed.

Works on Apple Silicon (M1 to M4) and Intel Macs running macOS 13 Ventura or newer.

## Table of Contents
- [Install (one double-click)](#install-one-double-click)
- [How it runs](#how-it-runs)
- [Make the Mac start up on its own](#make-the-mac-start-up-on-its-own)
- [Local AI with LM Studio (optional)](#local-ai-with-lm-studio-optional)
- [Reach it from your phone (optional)](#reach-it-from-your-phone-optional)
- [Everyday commands](#everyday-commands)
- [Updating](#updating)
- [Moving over from Docker](#moving-over-from-docker)
- [Troubleshooting](#troubleshooting)

## Install (one double-click)

1. On the [GitHub page](https://github.com/ctkubik/airline-ctkubik), click **Code > Download ZIP**,
   then open the downloaded ZIP so it unzips.
2. In the unzipped folder, double-click **Install on Mac.command**.

That's it. A Terminal window shows the progress (5 to 10 minutes the first time), and when it's done
the dashboard opens in your browser with your login details.

**The first time only**, macOS blocks files downloaded from the internet that aren't from the App
Store or a registered developer. You'll see *"Install on Mac.command" Not Opened*. Click **Done**,
open **System Settings > Privacy & Security**, scroll down, click **Open Anyway** next to the
message about "Install on Mac.command", and confirm. (On macOS 14 and older you can instead
Control-click the file and choose **Open**.) If macOS asks whether Terminal may access your
Downloads folder, click **Allow**.

Prefer no warnings at all? Open **Terminal** and paste this one line instead. It downloads the latest
version and runs the same installer:
```shell
curl -fsSL https://raw.githubusercontent.com/ctkubik/airline-ctkubik/master/macos/bootstrap.sh | bash
```

You don't need Homebrew, git, or admin rights. The installer:
1. Copies the app to `~/airline-ctkubik` (your home folder)
2. Downloads private copies of Python 3.13 and Node 22 into the app folder (checksums verified),
   and Google Chrome if you don't have it (signature verified)
3. Builds the dashboard and creates your login with a random password
4. Turns on the local AI features if LM Studio is installed
5. Starts the two background services and adds **Airline Check-In** to your Applications folder,
   which opens the dashboard
6. Asks for your Mac password once, in a normal macOS dialog, to install Rosetta (Apple's
   built-in Intel translator, which the automated Chrome browser needs on Apple Silicon Macs), stop
   the Mac from sleeping, and turn it back on after a power cut. It only asks for what's missing.
7. Offers to open the automatic-login setting (see below), then shows your username and password
   with a **Copy Password** button and opens the dashboard

Then follow [Part 4 of the setup guide](SETUP.md#part-4-first-time-setup-in-the-app) to add your
Southwest account and notifications.

## How it runs

Three background services, managed by macOS's built-in `launchd`:

| Service | What it does | Log file |
|---------|--------------|----------|
| `com.airline-checkin.web` | The dashboard at http://localhost:3000 | `data/logs/web.log` |
| `com.airline-checkin.worker` | Logs in to Southwest, checks you in, tracks fares | `data/logs/worker.log` |
| `com.airline-checkin.watchdog` | Every 5 minutes, alerts you if the worker stopped or froze | `data/logs/watchdog.log` |

Everything the app stores (database, screenshots, logs, nightly backups in `data/backups`) lives in
the `data` folder inside the app folder. Settings live in `.env` in the same folder. Southwest
passwords are stored encrypted; the key is in your login Keychain (item "airline-checkin").

**If the whole Mac goes down**, nothing on it can warn you. For that, create a free check at
[healthchecks.io](https://healthchecks.io) (period 5 minutes, grace 10 minutes), connect it to your
phone, and add its ping URL to `.env` as `HEALTHCHECK_PING_URL=...`, then `./macos/ctl.sh restart`.

The worker drives a real Google Chrome window. You'll see Chrome open on the Mac Mini's screen when
it works. That's on purpose: Southwest blocks hidden ("headless") browsers more often. Leave that
window alone.

## Make the Mac start up on its own

The services run inside your user session, so after a restart (a macOS update, a power cut) the Mac
has to log you in without anyone at the keyboard:

1. **System Settings > Users & Groups > Automatically log in as** and pick your user.
   (This option is hidden while FileVault is on. Turn FileVault off in **Privacy & Security** if
   you want unattended restarts.)
2. Locking the screen is fine. The services keep running while the screen is locked or the
   display is off.
3. **System Settings > General > Software Update > Automatic updates**: consider turning off
   "Install macOS updates" so the Mac doesn't restart itself on a travel day. Install updates
   yourself when no check-in is coming up.

If you skipped the power settings during install, run them now:
```shell
sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1
```

Test it: restart the Mac, wait two minutes, and run `./macos/ctl.sh status`.

## Local AI with LM Studio (optional)

If [LM Studio](https://lmstudio.ai) runs on the Mac, the app can use its model for three things:

| Feature | Where | What it does |
|---------|-------|--------------|
| Plain-English diagnostics | Activity > Diagnostics | An **Explain this** button turns a raw API error into a short explanation and what to do |
| Describe a trip | Fare Watches > New Watch | Type "Mom's visit, Phoenix to Chicago the week of Nov 20, nonstop" and it fills in the form |
| Smarter seat upgrades | Automatic | When Southwest changes its website and the built-in selectors miss a button or the seat map, the model finds it. It also reads the page after a seat change and only reports a seat as selected when Southwest confirms it |

The check-in itself never uses the model. It stays plain, predictable code.

Set it up:
1. Install LM Studio and download an instruction-tuned model. A 7B to 14B model is a good fit for
   a Mac Mini: for example Qwen3 8B, Llama 3.1 8B Instruct or Gemma 3 12B. Use 4-bit quantization
   on a 16 GB Mac.
2. Load the model and set its **context length to 16384 or more**. Seat maps are large; a 4096
   context is too small for the seat-map feature (the other features work either way).
3. In LM Studio's **Developer** tab, start the server (port 1234). In LM Studio's settings, turn on
   running the server when LM Studio starts, and add LM Studio to **System Settings > General >
   Login Items** so it comes back after a restart.
4. Run the installer again (double-click **Install on Mac.command**). It sees LM Studio and turns the
   features on. If you installed LM Studio first, this already happened.
5. In the dashboard, **Settings > Local AI** should say **Connected**.

By default the app uses the first chat model LM Studio has. To pin one, add
`LLM_MODEL=<model identifier from LM Studio>` to `.env` in `~/airline-ctkubik`, then run
`./macos/ctl.sh restart`.

If LM Studio is closed or the model is slow, the app carries on without it.

## Reach it from your phone (optional)

- **Same Wi-Fi:** http://your-mac-name.local:3000 (the installer prints the exact address)
- **Anywhere, private:** install [Tailscale](https://tailscale.com) on the Mac and your phone, then
  open `http://<mac-name>:3000`
- **Public URL:** Cloudflare Tunnel. Create a tunnel as in [SETUP.md](SETUP.md#option-b-cloudflare-tunnel--a-real-public-url-httpsflightsyournamecom)
  but point the public hostname at `http://localhost:3000`, then on the Mac:
  ```shell
  brew install cloudflared   # needs Homebrew from https://brew.sh
  sudo cloudflared service install <your-tunnel-token>
  ```

Create real user accounts on the **Users** page before exposing a public URL.

## Everyday commands

Day to day you don't need any of these: open **Airline Check-In** from your Applications folder.
For checking on things, run these in Terminal from the app folder (`cd ~/airline-ctkubik`):

| Command | What it does |
|---------|--------------|
| `./macos/ctl.sh status` | Shows whether the services are running and the dashboard answers |
| `./macos/ctl.sh logs` | Follows the log files (Ctrl+C to stop) |
| `./macos/ctl.sh restart` | Restart after editing `.env` |
| `./macos/ctl.sh stop` / `start` | Stop or start the services (stopping also pauses the watchdog, so it won't alert) |
| `./macos/uninstall.sh` | Removes the background services (keeps your data and `.env`) |

## Updating

Run the installer again: download a fresh ZIP and double-click **Install on Mac.command**, or paste
the one-line Terminal command from [Install](#install-one-double-click). It rebuilds and restarts,
and keeps your data, settings and login.

## Moving over from Docker

1. Stop the container: `docker compose down`
2. Copy your Docker folder's `data` folder and `.env` file into `~/airline-ctkubik` (create the
   folder if needed).
3. Double-click **Install on Mac.command**. It keeps the copied data and login.

Docker Desktop can stay installed but doesn't need to run.

## Troubleshooting

**`Operation not permitted` in the logs.** The app folder is in Documents, Desktop, Downloads or
iCloud Drive. Move it to your home folder and run the installer again.

**Dashboard doesn't load.** Run `./macos/ctl.sh status`, then `tail -50 data/logs/web.log`.

**Check-ins fail with 403 errors.** Southwest's bot protection flagged the browser. Make sure you
haven't set `BROWSER_MODE=headless`. Open the Activity page, and with local AI on, click
**Explain this** on the diagnostic.

**Chrome won't start / "Bad CPU type" in the worker log.** On Apple Silicon the automated browser
needs Rosetta. Run the installer again and enter your password, or run
`softwareupdate --install-rosetta` in Terminal. Otherwise, open Chrome once by hand so macOS finishes setting it up,
update Chrome (Chrome menu > About Google Chrome), then `./macos/ctl.sh restart`. The worker
downloads a matching driver automatically.

**Nothing runs after a restart.** Automatic login isn't on (see [Make the Mac start up on its own](#make-the-mac-start-up-on-its-own)), so the services are waiting
for someone to log in.

**Local AI says "Not reachable".** LM Studio isn't running, its server isn't started, or no model is
loaded. Check the Developer tab in LM Studio.
