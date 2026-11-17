# remote-for-herdr

A small web app you run on the Windows PC where [Herdr](https://herdr.dev) runs. Open it from your Android phone over Tailscale to watch your agent sessions live, answer them, and get a push notification when one needs you or finishes.

> **Unofficial. Not affiliated with or endorsed by Herdr.** It is a separate project that talks to herdr-core through its `hc` command.

**Tested:** Windows 11 + Node 22 host, desktop Chrome at phone width. Real-phone end-to-end: pending (see the [manual end-to-end checklist](docs/e2e-checklist.md)).

## Install

Check the [prerequisites](#prerequisites) first (Herdr's `hc`, Node.js 22+, Tailscale with HTTPS certificates). Then, in a normal (non-admin) PowerShell:

```powershell
npm i -g remote-for-herdr
remote-for-herdr setup
```

That is the recommended way: start-at-login needs a stable install, and a global install stays where it is. To just try it without installing:

```powershell
npx remote-for-herdr setup
```

npx runs it from a temporary cache that npm may clean up, so setup never installs start-at-login from there. If you say yes to start-at-login, it starts the app in the background instead: the app keeps running until you stop it, log off or restart the PC, and nothing restarts it after a crash. Your setup is saved in `%APPDATA%\remote-for-herdr` either way. To keep it for good:

```powershell
npm i -g remote-for-herdr
remote-for-herdr install-task
remote-for-herdr restart
```

`restart` stops the copy started from npx and starts the app again through the new start-at-login task. You do not need to run setup again.

`remote-for-herdr setup` is interactive. It:

1. Checks `hc` runs and lists your terminals (asks for the path if `hc` is not on PATH).
2. Checks Tailscale is running with HTTPS certificates, and asks for the allowed Tailscale login (default: the one you are signed in with).
3. Asks for a PIN (at least 6 characters, typed hidden) and generates push (VAPID) keys.
4. Offers to run `tailscale serve --bg 4780` for you. If you say no, run it yourself.
5. Asks whether to start remote-for-herdr at Windows login (Enter means yes). If yes, it installs the task and starts the app right away, then waits until it answers. If no, it prints the command to start it.
6. Prints the URL to open on your phone, e.g. `https://box.example.ts.net`, and a QR code of it to scan with the phone's camera.

Check it any time with `remote-for-herdr status` (running or not, its pid, the phone URL, whether start-at-login is installed).

**Update:**

```powershell
npm i -g remote-for-herdr@latest
remote-for-herdr restart
```

**Uninstall:**

```powershell
remote-for-herdr stop
remote-for-herdr uninstall-task
npm rm -g remote-for-herdr
```

Then, if you like: `tailscale serve --https=443 off`, delete `%APPDATA%\remote-for-herdr` (config, PIN hash, keys, logs) and remove the app icon from the phone. See [Uninstall](#uninstall).

### Upgrading from herdr-remote

This project used to be called herdr-remote. Install `remote-for-herdr` as above (`npm i -g remote-for-herdr`), then run `remote-for-herdr restart` (`setup`, `start` and `install-task` do it too; `status` only tells you the move is pending). On that first run it moves your config from `%APPDATA%\herdr-remote` to `%APPDATA%\remote-for-herdr` (if the folder cannot be moved, it is copied and the old one kept). It stops the old server first if it still runs from there; if that server does not stop, nothing is moved and it tells you its pid. It also replaces the old `herdr-remote` start-at-login task with the new `remote-for-herdr` one. Your PIN, push keys and Tailscale settings are kept, so the phone link does not change: just re-open the app on the phone. `HERDR_REMOTE_HOME` still works (`REMOTE_FOR_HERDR_HOME` is the new name), and the `herdr-remote` command remains as an alias for now. If you ran it from a git clone, you can delete that folder afterwards. If you had a herdr-remote start-at-login task, run the upgrade from the global install, not through `npx`: from npx's temporary cache the task cannot be moved, so nothing is changed and you are asked to `npm i -g remote-for-herdr` first.

## Why

Away from your desk, agents (Claude Code, Codex, ...) stop and wait for you: a permission prompt, a question, a plan to approve. Nothing moves until you are back. Herdr's own phone app does not find a Windows desktop install, so this fills the gap: a live terminal view, a few answer buttons, and a buzz on your phone.

## What it does

- Lists your agent sessions grouped by Herdr space, most urgent first (needs you, working, done, idle).
- Shows a session live in a real terminal view (xterm.js). Watching is read-only: it never resizes or types into the session on your PC.
- Answers: key buttons (1 2 3 4, arrows, Enter, Tab, Shift+Tab, Esc) and a text box that sends a line.
- Push notifications when an agent needs you and when it finishes. Both can be switched off in Settings.
- Desk mode: a toggle that pauses all pushes while you are at the computer.

Out of scope for v1: macOS/Linux hosts (only Windows is tested), iPhone, starting new work from the phone, several users per install.

## Prerequisites

- Windows 10/11 with Herdr (or herdr-core alone). `hc` must be on PATH (tested with 0.1.21). The server must run on the same PC as herdr-core.
- Node.js 22 or newer (with npm).
- Tailscale on the PC and on the phone, same tailnet. The free personal plan is enough.
- In the Tailscale admin console: MagicDNS and HTTPS certificates enabled (DNS page). Setup stops and tells you if HTTPS is not ready. Do this before pairing the phone: push subscriptions and the home-screen install are tied to the `https://<machine>.<tailnet>.ts.net` address.
- Android with Chrome.

## Running it

With start-at-login installed, the app starts hidden when you log on to Windows and is restarted after a crash; you do not need to start it by hand. Otherwise `remote-for-herdr start` runs the server under a supervisor that restarts it 1 to 30 seconds after a crash. Use `remote-for-herdr start --foreground` to run it in the current console instead (no restart): it is the lightest way to run it, one Node process instead of two (see [Memory](#memory)). The server listens on `127.0.0.1:4780` only; `tailscale serve` is the only way in. Never use Tailscale Funnel.

Commands (`remote-for-herdr ...`; from a source checkout, `node src/cli.js ...`):

| Command | What it does |
|---|---|
| `setup [--proxy] [--home <dir>]` | Interactive setup. Safe to re-run, but only while the server is stopped (it refuses otherwise). |
| `status [--home <dir>]` | Whether it is running (pid, port), the phone URL, whether start-at-login is installed, the config folder. |
| `start [--foreground [--log]] [--home <dir>]` | Run the server; restarts on crash unless `--foreground`. `--log` sends its output to `<home>\logs\server.log` instead of the console. Refuses (exit 78) if another copy already runs for the same home. |
| `stop [--home <dir>]` | Stop the running server, supervised, `--foreground` or started at login (prints `stopped` or `not running`). |
| `restart [--home <dir>]` | Stop it, then start it again through the start-at-login task. Without the task, it starts the app in the background (no restart after a crash or at login) and says how to add the task. |
| `install-task [--home <dir>]` | Start at Windows login (Task Scheduler task `remote-for-herdr`, hidden window). Also removes an old `herdr-remote` task. |
| `uninstall-task [--home <dir>]` | Remove that task (both the `remote-for-herdr` and an old `herdr-remote` one; ends its hidden launcher; a running server stays up until `stop`). |

The start-at-login task is created from an XML definition (`<home>\remote-for-herdr-task.xml`, next to the hidden launcher `start-hidden.vbs`). It triggers only when you log on to Windows (your `DOMAIN\user` account), runs without elevation, has no time limit (Task Scheduler's default would stop it after 72 hours) and keeps running on battery. A normal, non-admin prompt is enough to install it. `uninstall-task` ends the task's hidden launcher, then removes the task and both files. It does not stop a running server: that keeps running, with no restart after a crash, until `remote-for-herdr stop`. Ending the task in Task Scheduler ("End") likewise ends only the launcher: the server keeps running, but is no longer restarted.

The task runs the server directly (`start --foreground --log`), without the supervisor, to save a whole Node process (see [Memory](#memory)). The hidden launcher waits for it and, if it crashes (or is ended in Task Manager), runs it again after 1 s, then 2, 4, 8, 16 and 30 s between tries (back to 1 s once a run lasted a minute). `remote-for-herdr stop` (also while it waits to restart it), a missing setup or a busy port end it for good, as before. Task Scheduler's "restart on failure" (every minute, up to 999 times) is only a backstop in case the launcher itself fails. The launcher holds the full paths to `node.exe` and to the installed package: run `install-task` again after moving the install or upgrading/reinstalling Node (an `npm i -g remote-for-herdr@latest` update keeps the same path).

To change settings later: `remote-for-herdr stop`, then `remote-for-herdr setup` (it starts the app again at the end if you keep start-at-login). The running server keeps its config in memory, so setup refuses to run while it answers on its port.

Config and state live in `%APPDATA%\remote-for-herdr\` (override with `--home <dir>` or the `REMOTE_FOR_HERDR_HOME` environment variable; the old `HERDR_REMOTE_HOME` still works). Logs are in `<home>\logs\server.log` (rotated at 5 MB to `server.log.1`).

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
- Zoom with the buttons just above the terminal: `−` and `+` zoom out and in (25% to 200%), and the middle button shows the current zoom (`Fit`, or a percentage such as `80% · Fit`); tap it to fit the width again. Fit can be more than 200% when a narrow terminal fills a wide screen; `−` or a pinch from there starts at 200%. You can also pinch with two fingers on the terminal; one finger still scrolls and pans. On a desktop browser, Ctrl + mouse wheel zooms. Whenever the terminal is wider than the screen, you pan sideways inside the terminal. Your zoom is remembered on each device.
- Drag with one finger to scroll; flick to keep it gliding. Dragging down past the top of the screen scrolls up into the session's history (the last 1000 lines are loaded when you open it). While you are scrolled up (or zoomed in and not at the bottom), new output does not pull you down; tap `↓ Latest` at the bottom right to jump back. After a reconnect (for example when the phone wakes up) the view starts again at the latest output. On a desktop browser the mouse wheel does the same. Pulling down in the live view never reloads the app; on the session list, pull down to reload as usual.
- Key bar: `1 2 3 4 ↑ ↓` on the top row, `Enter Tab ⇧Tab ← → Esc` below (Esc is the outlined key at the right edge). A key that reached the terminal shows a small ✓ for a moment; Send shows `Sent ✓`. In landscape the keys form one row.
- While you type a reply, the header details and the zoom buttons fold away so the terminal (and its dialog) stays as big as possible; tapping keys or Send keeps the keyboard up. They come back when you leave the text box.
- Replies take about a second to show: each send starts a fresh `hc` process.
- Answer dialogs (questions, permission prompts) with the key buttons. While a session shows a dialog, the Send button reads `Type into dialog` and asks for a second tap: Herdr normally refuses typing into a dialog, so the app only types into one when you confirm.
- To answer a dialog's "Type something" option: press its number on the key bar (for example `3`, or move to it with `↓`), type your answer in the text box, tap `Type into dialog`, then tap `Tap again to type` (wait about half a second; a quicker second tap is ignored, and it must come within 2 seconds). While armed, the hint shows which dialog you are typing into. Ctrl+Enter (⌘+Enter) follows the same two-step rule; holding it down does nothing. The confirm disarms after 2 seconds, when you change the text, when you press a key-bar key, or when the dialog changes. The hint under the box warns you: until "Type something" is chosen, letters and digits you send act as key presses in the dialog.
- Only the dialog you saw is typed into: if it changed or was answered (for example from the PC) before your second tap, nothing is sent and the app says so. If it closed while you were confirming, Send ignores taps for a second and then sends normal replies again.
- Typing into other dialogs, permission prompts included, works the same way and needs the same confirm. Be careful: text typed into a prompt that isn't waiting for text can be read as key presses.
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

The web address and the login change. Run `remote-for-herdr stop`, re-run `remote-for-herdr setup` (it starts the server again if you keep start-at-login), then open the new URL on the phone, enter the PIN again and enable notifications again (old subscriptions and sessions are cleared).

## Troubleshooting

- **"This account or network isn’t allowed to open remote-for-herdr."** (HTTP 403): the phone is signed in to Tailscale as a different login than the one set up. Sign in with the right account, or re-run setup with the right login.
- **Page does not load:** is the PC awake, is the server running (check `<home>\logs\server.log`), and is `tailscale serve --bg 4780` active (`tailscale serve status`)?
- **Server never starts at logon (start-at-login task):** open `taskschd.msc`, find `remote-for-herdr` and check its "Last Run Result" (1 means the launcher could not start node at all), then `<home>\logs\server.log`. After moving the install or upgrading/reinstalling Node, run `remote-for-herdr install-task` again: the launcher holds the full paths to both.
- **"needs setup" / server exits at start:** config is missing or invalid. Run `remote-for-herdr setup`. Neither the supervisor nor the start-at-login task restarts it in this case.
- **"remote-for-herdr is already running (pid N) — use "remote-for-herdr stop" first."**: `server.pid` names a live process and something answers on the configured port, so a copy for this home is most likely running. Leave it, or stop it first. A pid file left behind by a logoff or shutdown is replaced automatically when nothing answers on the port. If remote-for-herdr isn't actually running (another program holds the port), delete `<home>\server.pid` (the message prints the full path); the same hint follows a `stop` that times out.
- **"port 4780 already in use — is remote-for-herdr already running?"** in the log: another copy (or another program) holds the port. Run `remote-for-herdr stop`, or free the port. Neither restarts it in this case either.
- **"remote-for-herdr is running — stop it first: remote-for-herdr stop"** from setup: stop the server, run setup, then start it again.
- **No push:** the address must be the https `ts.net` one (HTTPS certificates enabled); notification permission must be allowed in Android/Chrome site settings; desk mode must be off; the matching trigger must be on in Settings; and you must have tapped Enable notifications on this device after the last setup change.
- **Messages arrive as if from an agent terminal, or new terminals get a parent:** remote-for-herdr strips `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET` and `HC_SCOPE` from every `hc` it runs, so messages are sent as from a plain client even when remote-for-herdr is started inside a Herdr terminal.
- **`hc` not found:** put herdr-core's folder (default `%LOCALAPPDATA%\Programs\herdr-core\`) on PATH, or re-run setup and give the full path to `hc`.
- **Send says a dialog is open / `Type into dialog` appears:** the session is showing a question or permission prompt, and Herdr refuses plain typing there. Answer with the key bar, or choose "Type something" and use the two-tap confirm (see Using it). "A dialog just opened — wait a moment" means Herdr refused a plain send because a dialog opened a moment ago; the button turns on once the list shows the dialog.
- **"The dialog changed — nothing was sent."**: between your two taps the dialog was answered, closed or replaced by another one. Nothing reached the agent. Look at the terminal and try again.
- **"May or may not have been delivered — check the terminal before resending"**: `hc` did not answer in time. The text may still have arrived; look at the terminal before sending it again.
- **Start-at-login does not start it:** run `remote-for-herdr install-task` again, then check `schtasks /Query /TN remote-for-herdr /V /FO LIST` (its "Run As User" must be your account) and the log file.

## Uninstall

1. `remote-for-herdr stop`, then `remote-for-herdr uninstall-task` (removes the login task, and an old `herdr-remote` one).
2. `tailscale serve --https=443 off` (stops exposing it).
3. Delete `%APPDATA%\remote-for-herdr` (config, PIN hash, keys, logs).
4. `npm rm -g remote-for-herdr` (or delete the folder, for a source checkout).
5. Remove the app icon from the phone.

## Advanced: other networks (unsupported)

`remote-for-herdr setup --proxy` sets `access: "proxy"` for people who put their own HTTPS front end (Cloudflare Tunnel with Access, a reverse proxy on a VPN, ...) in front of the server. This is not tested beyond a local smoke test and not supported. You are responsible for TLS and for keeping it off the open internet.

- The Tailscale identity check is off. The PIN is still required, with rate limiting, Secure cookies and the Origin check.
- Setup asks for the public origin (for example `https://remote.example.com`) and optionally one identity header and the value to trust (for example `Cf-Access-Authenticated-User-Email` = `you@example.com`).
- The server still binds `127.0.0.1` unless you explicitly set `bind` in `config.json`.

## Memory

Measured on Windows 11 with Node 22.13.1, idle after 20 s and then with one live view open on a terminal printing 3 bursts of 20,000 lines (working set / private bytes, MB). Every child also has its own hidden `conhost.exe` (about 7.5 / 1.2 MB each), counted in the totals.

| Way to run | Supervisor (node) | Server (node) | hc events | hc attach (1 live view) | Total with conhosts |
|---|---|---|---|---|---|
| Before this change: `remote-for-herdr start` and the start-at-login task (supervisor + server) | 46.5 / 55.6 | 50.9 / 56.6 | 11.3 / 1.7 | 11.3 / 1.7 | 149.6 / 120.4 |
| Now: `remote-for-herdr start` (unchanged, supervisor + server) | 46.7 / 55.3 | 51.4 / 57.3 | 11.4 / 1.7 | 11.3 / 1.7 | 150.4 / 120.8 |
| Now: start-at-login task (`start --foreground --log`) | none | 51.1 / 57.1 | 11.4 / 1.7 | 11.4 / 1.7 | 96.0 / 64.1 |

So the start-at-login task now uses about 53.6 MB less working set and 56.3 MB less private memory than before (149.6 / 120.4 down to 96.0 / 64.1: the supervisor's Node process and its console host are gone); the hidden `wscript.exe` launcher stays resident to restart the server (not measured here). Node/V8 flags were tried on the server and none is used (`SERVER_NODE_FLAGS` in `src/supervisor.js` is empty): `--max-semi-space-size=1`, `--optimize-for-size`, `--max-old-space-size=128`, `--v8-pool-size=1` and their combination each changed the server by less than 2 MB with the same burst latency (about 250 ms), and `--lite-mode` stops it from starting at all (it turns off WebAssembly, and Node 22 then throws as soon as the server imports `node:http`, which loads its bundled undici).

## Development

From a clone of [the repository](https://github.com/julsxxzz/remote-for-herdr): `npm install`, then `node src/cli.js <command>` (`npm run setup`, `npm start` work too). `npm test` runs the unit tests against a fake `hc`. `npm run dev` runs the server in the foreground with config in `.dev/`.

The installed app (manifest) is named "remote-for-herdr"; its home-screen label (`short_name`) is "Herdr Remote", kept to 12 characters so Android does not cut it off under the icon.

## Licence

Apache-2.0, see [LICENSE](LICENSE). Unofficial; not affiliated with Herdr.
