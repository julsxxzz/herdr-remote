# herdr-remote

A small web app you run on the Windows PC where [Herdr](https://herdr.dev) runs. Open it from your Android phone over Tailscale to watch your agent sessions live, answer them, and get a push notification when one needs you or finishes.

Not affiliated with Herdr. It is a separate project that talks to herdr-core through its `hc` command.

**Tested:** Windows 11 + Node 22 host, desktop Chrome at phone width. Real-phone end-to-end: pending (see the [manual end-to-end checklist](docs/e2e-checklist.md)).

## Why

Away from your desk, agents (Claude Code, Codex, ...) stop and wait for you: a permission prompt, a question, a plan to approve. Nothing moves until you are back. Herdr's own phone app does not find a Windows desktop install, so this fills the gap: a live terminal view, a few answer buttons, and a buzz on your phone.

## What it does

- Lists your agent sessions grouped by Herdr space, most urgent first (needs you, working, done, idle).
- Shows a session live in a real terminal view (xterm.js). Watching is read-only: it never resizes or types into the session on your PC.
- Answers: key buttons (Enter, Tab, Esc, arrows, 1 2 3, Ctrl+C, Shift+Tab) and a text box that sends a line. Ctrl+C needs two taps: the first arms it, a second tap within 2 seconds sends it.
- Push notifications when an agent needs you and when it finishes. Both can be switched off in Settings.
- Desk mode: a toggle that pauses all pushes while you are at the computer.

Out of scope for v1: macOS/Linux hosts, iPhone, starting new work from the phone, several users per install.

## Prerequisites

- Windows 10/11 with Herdr (or herdr-core alone). `hc` must be on PATH (tested with 0.1.21). The server must run on the same PC as herdr-core.
- Node.js 22 or newer.
- Tailscale on the PC and on the phone, same tailnet. The free personal plan is enough.
- In the Tailscale admin console: MagicDNS and HTTPS certificates enabled (DNS page). Setup stops and tells you if HTTPS is not ready. Do this before pairing the phone: push subscriptions and the home-screen install are tied to the `https://<machine>.<tailnet>.ts.net` address.
- Android with Chrome.

## Install

```powershell
git clone <this repo's URL> herdr-remote
cd herdr-remote
npm install
npm run setup
npm start
```

`npm run setup` is interactive. It:

1. Checks `hc` runs and lists your terminals (asks for the path if `hc` is not on PATH).
2. Checks Tailscale is running with HTTPS certificates, and asks for the allowed Tailscale login (default: the one you are signed in with).
3. Asks for a PIN (at least 6 characters, typed hidden) and generates push (VAPID) keys.
4. Offers to run `tailscale serve --bg 4780` for you. If you say no, run it yourself.
5. Offers to start herdr-remote at Windows login.
6. Prints the URL to open on your phone, e.g. `https://box.example.ts.net`.

`npm start` runs the server under a supervisor that restarts it after a crash. Use `node src/cli.js start --foreground` to run it in the current console instead (no restart). The server listens on `127.0.0.1:4780` only; `tailscale serve` is the only way in. Never use Tailscale Funnel.

Commands (`herdr-remote` if installed with the `bin` entry, otherwise `node src/cli.js`):

| Command | What it does |
|---|---|
| `start [--foreground] [--home <dir>]` | Run the server; restarts on crash unless `--foreground`. Refuses (exit 78) if another copy already runs for the same home. |
| `stop [--home <dir>]` | Stop the running server, supervised or `--foreground` (prints `stopped` or `not running`). |
| `setup [--proxy] [--home <dir>]` | Interactive setup. Safe to re-run, but only while the server is stopped (it refuses otherwise). |
| `install-task [--home <dir>]` | Start at Windows login (Task Scheduler task `herdr-remote`, hidden window). |
| `uninstall-task [--home <dir>]` | Remove that task. |

The start-at-login task is created from an XML definition (`<home>\herdr-remote-task.xml`, next to the hidden launcher `start-hidden.vbs`). It triggers only when you log on to Windows (your `DOMAIN\user` account), runs without elevation, has no time limit (Task Scheduler's default would stop it after 72 hours) and keeps running on battery. A normal, non-admin prompt is enough to install it. `uninstall-task` removes the task and both files.

To change settings later: `herdr-remote stop`, then `npm run setup`, then `npm start` again. The running server keeps its config in memory, so setup refuses to run while it answers on its port.

Config and state live in `%APPDATA%\herdr-remote\` (override with `--home <dir>` or the `HERDR_REMOTE_HOME` environment variable). Logs are in `<home>\logs\server.log` (rotated at 5 MB to `server.log.1`).

## Phone steps

1. On the phone, open the URL setup printed in Chrome (Tailscale must be connected).
2. Enter the PIN. You do this once per device.
3. Chrome menu, Add to Home screen. Open the app from the icon.
4. In the app: Settings, Enable notifications, allow the permission. Use Send test notification to check it.

## Keep the PC awake

The phone can only reach the app while the PC is on and awake. Set Windows power settings to never sleep while plugged in. The app cannot do this for you.

## Using it

- Sessions needing you are at the top. Tap one for the live view.
- The live view starts fitted to the screen width. A very wide terminal (say 200 columns) is shown at half size and you pan sideways; the minimum fit scale is 50%. Turning the phone to landscape also helps.
- Zoom with the buttons just above the terminal: `−` and `+` zoom out and in (25% to 200%), and the middle button shows the current zoom (`Fit`, or a percentage such as `80%`); tap it to fit the width again. You can also pinch with two fingers on the terminal; one finger still scrolls and pans. On a desktop browser, Ctrl + mouse wheel zooms. Whenever the terminal is wider than the screen, you pan sideways inside the terminal. Your zoom is remembered on each device.
- Drag with one finger to scroll; flick to keep it gliding. Dragging down past the top of the screen scrolls up into the session's history (the last 1000 lines are loaded when you open it). While you are scrolled up, new output does not pull you down; tap `↓ Latest` at the bottom right to jump back. On a desktop browser the mouse wheel does the same. Pulling down at the top never reloads the app.
- Replies take about a second to show: each send starts a fresh `hc` process.
- The text box refuses to send while the session shows a dialog (Herdr's safety). Answer dialogs with the key buttons.
- The app never marks sessions as seen in Herdr, so things you handled from the phone may still look unread on the PC.
- No notification is sent for a session you are looking at on the phone right now.
- Claude Code's plain questions and "shall I go ahead?" pauses end the turn and show as done, not blocked, so the "finished" push is what tells you about them.

## Security model

- Tailnet only: the server binds `127.0.0.1` and is exposed only through `tailscale serve`. It is never on the public internet.
- Owner login: `tailscale serve` adds the signed-in user's login; only the one login set during setup is allowed. Anyone else gets 403.
- PIN once per device, then a session cookie (HttpOnly, Secure, SameSite=Strict) valid 30 days, renewed while you use it. Only a hash of the PIN and of session tokens is stored. PIN attempts are rate limited.
- Settings, Sign out everywhere ends all sessions, closes open live views and forgets every device's push subscription (a device re-registers when you sign in on it again). Changing the PIN in setup also signs every device out.
- Because the app can type into your agents, keep your Tailscale login and devices secure.
- Pushes go through Google's FCM (that is how Web Push works on Android). They are encrypted and carry only the agent name, the space name, the terminal address and fixed text (for example "Claude Code in api needs you" / "Tap to open"), never screen content, paths or titles.
- Nothing personal is stored in the repo; your config is in the app-data folder above.

## Switching tailnets or accounts

The web address and the login change. Run `herdr-remote stop`, re-run `npm run setup`, start the server again, then open the new URL on the phone, enter the PIN again and enable notifications again (old subscriptions and sessions are cleared).

## Troubleshooting

- **"This account or network isn’t allowed to open herdr-remote."** (HTTP 403): the phone is signed in to Tailscale as a different login than the one set up. Sign in with the right account, or re-run setup with the right login.
- **Page does not load:** is the PC awake, is the server running (check `<home>\logs\server.log`), and is `tailscale serve --bg 4780` active (`tailscale serve status`)?
- **"needs setup" / server exits at start:** config is missing or invalid. Run `npm run setup`. The supervisor does not restart in this case.
- **"herdr-remote is already running (pid N) — use "herdr-remote stop" first."**: `server.pid` names a live process and something answers on the configured port, so a copy for this home is most likely running. Leave it, or stop it first. A pid file left behind by a logoff or shutdown is replaced automatically when nothing answers on the port. If herdr-remote isn't actually running (another program holds the port), delete `<home>\server.pid` (the message prints the full path); the same hint follows a `stop` that times out.
- **"port 4780 already in use — is herdr-remote already running?"** in the log: another copy (or another program) holds the port. Run `herdr-remote stop`, or free the port. The supervisor does not restart in this case either.
- **"herdr-remote is running — stop it first: herdr-remote stop"** from setup: stop the server, run setup, then start it again.
- **No push:** the address must be the https `ts.net` one (HTTPS certificates enabled); notification permission must be allowed in Android/Chrome site settings; desk mode must be off; the matching trigger must be on in Settings; and you must have tapped Enable notifications on this device after the last setup change.
- **Messages arrive as if from an agent terminal, or new terminals get a parent:** herdr-remote strips `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET` and `HC_SCOPE` from every `hc` it runs, so messages are sent as from a plain client even when herdr-remote is started inside a Herdr terminal.
- **`hc` not found:** put herdr-core's folder (default `%LOCALAPPDATA%\Programs\herdr-core\`) on PATH, or re-run setup and give the full path to `hc`.
- **Start-at-login does not start it:** run `node src/cli.js install-task` again, then check `schtasks /Query /TN herdr-remote /V /FO LIST` (its "Run As User" must be your account) and the log file.

## Uninstall

1. `node src/cli.js stop`, then `node src/cli.js uninstall-task` (removes the login task).
2. `tailscale serve --https=443 off` (stops exposing it).
3. Delete `%APPDATA%\herdr-remote` (config, PIN hash, keys, logs).
4. Remove the app icon from the phone and delete the folder you cloned.

## Advanced: other networks (unsupported)

`npm run setup -- --proxy` sets `access: "proxy"` for people who put their own HTTPS front end (Cloudflare Tunnel with Access, a reverse proxy on a VPN, ...) in front of the server. This is not tested beyond a local smoke test and not supported. You are responsible for TLS and for keeping it off the open internet.

- The Tailscale identity check is off. The PIN is still required, with rate limiting, Secure cookies and the Origin check.
- Setup asks for the public origin (for example `https://remote.example.com`) and optionally one identity header and the value to trust (for example `Cf-Access-Authenticated-User-Email` = `you@example.com`).
- The server still binds `127.0.0.1` unless you explicitly set `bind` in `config.json`.

## Development

`npm test` runs the unit tests against a fake `hc`. `npm run dev` runs the server in the foreground with config in `.dev/`.

## Licence

Apache-2.0, see [LICENSE](LICENSE). Not affiliated with Herdr.
