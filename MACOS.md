# Running on a Mac Mini (native macOS)

This guide sets the app up to run directly on a Mac, with no Docker. It's the recommended way to
host it on a Mac Mini. The app starts by itself when the Mac starts, restarts itself if it crashes,
and keeps the Mac awake so a 3 a.m. check-in never gets missed.

Works on Apple Silicon (M1 to M4) and Intel Macs running macOS 13 Ventura or newer.

## Table of Contents
- [How it runs](#how-it-runs)
- [Step 1: Install Homebrew](#step-1-install-homebrew)
- [Step 2: Download the app](#step-2-download-the-app)
- [Step 3: Run the installer](#step-3-run-the-installer)
- [Step 4: Make the Mac start up on its own](#step-4-make-the-mac-start-up-on-its-own)
- [Step 5 (optional): Local AI with LM Studio](#step-5-optional-local-ai-with-lm-studio)
- [Step 6 (optional): Reach it from your phone](#step-6-optional-reach-it-from-your-phone)
- [Everyday commands](#everyday-commands)
- [Updating](#updating)
- [Moving over from Docker](#moving-over-from-docker)
- [Troubleshooting](#troubleshooting)

## How it runs

Two background services, managed by macOS's built-in `launchd`:

| Service | What it does | Log file |
|---------|--------------|----------|
| `com.airline-checkin.web` | The dashboard at http://localhost:3000 | `data/logs/web.log` |
| `com.airline-checkin.worker` | Logs in to Southwest, checks you in, tracks fares | `data/logs/worker.log` |

Everything the app stores (database, screenshots, logs) lives in the `data` folder inside the app
folder. Settings live in `.env` in the same folder.

The worker drives a real Google Chrome window. You'll see Chrome open on the Mac Mini's screen when
it works. That's on purpose: Southwest blocks hidden ("headless") browsers more often. Leave that
window alone.

## Step 1: Install Homebrew

Homebrew is the standard installer for developer tools on a Mac. Open **Terminal** (Applications >
Utilities > Terminal) and paste the command from [brew.sh](https://brew.sh). Follow its prompts, and
run the two "Next steps" commands it prints at the end.

Check it worked:
```shell
brew --version
```

## Step 2: Download the app

Put the app in your home folder. **Not** in Documents, Desktop, Downloads or iCloud Drive: macOS
blocks background services from reading those folders.

```shell
cd ~
git clone https://github.com/ctkubik/airline-ctkubik.git
cd airline-ctkubik
```

(If macOS asks to install the "command line developer tools" for `git`, click Install, then run
the command again.)

## Step 3: Run the installer

```shell
./macos/install.sh
```

It takes a few minutes the first time. It:
1. Installs Python 3.13, Node 22 and Google Chrome (skips anything you already have)
2. Sets up the worker and builds the dashboard
3. Creates `.env` with a random login password
4. Starts both background services
5. Offers to change power settings so the Mac never sleeps and turns back on after a power cut.
   Say **y** and enter your Mac password.

At the end it prints your login:
```
All set.
  Dashboard:  http://localhost:3000
  Username:   admin
  Password:   3f9c1a7b2e4d6f80   (saved in .env)
```

Open http://localhost:3000, log in, and follow [Part 4 of the setup guide](SETUP.md#part-4-first-time-setup-in-the-app)
to add your Southwest account and notifications.

## Step 4: Make the Mac start up on its own

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

## Step 5 (optional): Local AI with LM Studio

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
4. In the app folder, edit `.env` and add:
   ```
   LLM_ENABLED=true
   LLM_MODEL=qwen/qwen3-8b
   ```
   Use the model identifier LM Studio shows for your model. Leave `LLM_MODEL` out to use whichever
   model is loaded.
5. Restart: `./macos/ctl.sh restart`
6. In the dashboard, **Settings > Local AI** should say **Connected**.

If LM Studio is closed or the model is slow, the app carries on without it.

## Step 6 (optional): Reach it from your phone

- **Same Wi-Fi:** http://your-mac-name.local:3000 (the installer prints the exact address)
- **Anywhere, private:** install [Tailscale](https://tailscale.com) on the Mac and your phone, then
  open `http://<mac-name>:3000`
- **Public URL:** Cloudflare Tunnel. Create a tunnel as in [SETUP.md](SETUP.md#option-b-cloudflare-tunnel--a-real-public-url-httpsflightsyournamecom)
  but point the public hostname at `http://localhost:3000`, then on the Mac:
  ```shell
  brew install cloudflared
  sudo cloudflared service install <your-tunnel-token>
  ```

Create real user accounts on the **Users** page before exposing a public URL.

## Everyday commands

Run these from the app folder (`cd ~/airline-ctkubik`):

| Command | What it does |
|---------|--------------|
| `./macos/ctl.sh status` | Shows whether both services are running and the dashboard answers |
| `./macos/ctl.sh logs` | Follows both log files (Ctrl+C to stop) |
| `./macos/ctl.sh restart` | Restart after editing `.env` |
| `./macos/ctl.sh stop` / `start` | Stop or start both services |
| `./macos/uninstall.sh` | Removes the background services (keeps your data and `.env`) |

## Updating

```shell
cd ~/airline-ctkubik
git pull
./macos/install.sh
```

The installer is safe to re-run. It rebuilds and restarts, and keeps your data and settings.

## Moving over from Docker

1. Stop the container: `docker compose down`
2. Your data is already in `./data` (the same folder Docker used), and your `.env` is reused.
3. Run `./macos/install.sh`.

Docker Desktop can stay installed but doesn't need to run.

## Troubleshooting

**`Operation not permitted` in the logs.** The app folder is in Documents, Desktop, Downloads or
iCloud Drive. Move it to your home folder and run the installer again.

**Dashboard doesn't load.** Run `./macos/ctl.sh status`, then `tail -50 data/logs/web.log`.

**Check-ins fail with 403 errors.** Southwest's bot protection flagged the browser. Make sure you
haven't set `BROWSER_MODE=headless`. Open the Activity page, and with local AI on, click
**Explain this** on the diagnostic.

**Chrome won't start / driver errors.** Open Chrome once by hand so macOS finishes setting it up,
update Chrome (Chrome menu > About Google Chrome), then `./macos/ctl.sh restart`. The worker
downloads a matching driver automatically.

**Nothing runs after a restart.** Automatic login isn't on (see Step 4), so the services are waiting
for someone to log in.

**Local AI says "Not reachable".** LM Studio isn't running, its server isn't started, or no model is
loaded. Check the Developer tab in LM Studio.
