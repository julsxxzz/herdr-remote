# herdr-remote — design

Date: 2026-11-17 · Status: design approved for planning

A small, open-source web app you run on the computer where Herdr runs, and
open from your phone's browser over Tailscale. It shows your Herdr
coding-agent sessions live, lets you answer them, and pushes a notification
when one needs you. Each person runs their own copy for their own Herdr.

**v1 support:** Windows host + Android phone (Chrome). That is the only
tested setup; see §2 for what is out of scope.

---

## 1. Why

- People run coding agents (Claude Code, Codex, …) in **Herdr** because its
  interface is easy to mod. Herdr's official phone app talks to herdr-core
  over SSH, but on a **Windows** machine running the Herdr desktop app it
  doesn't find anything: its Windows probe looks for `herdr.exe` in fixed
  folders plus a `herdr-mobile-bridge.exe` or a Herdr TUI socket, none of
  which the Windows desktop app installs (verified from the app's own probe
  commands, §9).
- Other tools (e.g. Orca) have shown the value of a phone companion: **watch
  agents work** and **unblock them** when away from the desk.
- Away from the desk, sessions **get stuck waiting for you** (permission
  prompts, questions, plan approvals) and nothing moves until you're back.

**Success:** away from the computer, your phone buzzes when an agent needs
you; you open the app, see that session exactly as it looks in Herdr (live,
colours, Claude Code's boxes), answer it in a couple of taps, and watch it
carry on. A new user can set it up from the README in under ~20 minutes.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**
1. List live agents/terminals, grouped by Herdr space, most urgent first
   (needs you → working → done/idle).
2. Open one and watch it **live** — a real terminal render, not text snapshots.
3. Answer it: key buttons (Enter, Tab, Esc, ↑ ↓ ← →, 1 2 3, Ctrl+C,
   Shift+Tab) and a text box that sends a line.
4. **Push notifications** on Android when an agent needs you or finishes.
5. Reachable from anywhere over Tailscale; never from the public internet.
6. **Usable by other Herdr users:** no personal details in code or docs,
   everything machine-specific in config, a clear install + setup guide.

**Non-goals (v1)**
- macOS / Linux hosts and iPhone. Don't add Windows-only assumptions where a
  portable option is just as easy (use `hc` from PATH, `path` module, no
  hard-coded `C:\…`), but don't build or document other platforms yet.
- Starting new work from the phone (new spaces/tabs, new agents, workflows).
- A shared/multi-user server. **One owner per install**, one computer.
- Replacing the Herdr desktop app or its mods.

**Anti-goals (would be a failure even if it "works")**
- The phone view **resizes or disturbs the session on the computer**
  (watching must be read-only; §5.2).
- Anything **reachable from the public internet**, or reachable inside the
  tailnet **without the owner's identity check** — the app can type into agents.
- Sending terminal contents to any third-party service. Push payloads carry
  no screen text (agent + space name only); private code may be on screen.
- Laggy enough that you'd rather wait to get back to the desk (target §3).
- Personal data (hostnames, usernames, emails, tailnet names, keys) committed
  to the repo.

## 3. Constraints & environment

- **Host:** Windows 10/11 with the Herdr app (or herdr-core alone) installed.
  The server **must run on the same machine as herdr-core** (it runs `hc`).
  Developing elsewhere is fine; running elsewhere is not.
- **herdr-core:** `hc` (tested with 0.1.21). Default Windows install folder
  `%LOCALAPPDATA%\Programs\herdr-core\` (on the user PATH). Apache-2.0, built
  for app builders (`hc schema`, `hc connect`). Source: `herdrdev/herdr-core`
  (linked from herdr.dev/core). Find `hc` via PATH; allow a config override.
- **Node.js:** an LTS version; state the minimum in `package.json` `engines`.
- **Phone:** Android with Chrome and the Tailscale app.
- **Network:** Tailscale is the supported setup (an unsupported "bring your
  own HTTPS" mode exists for other networks, §5.6). Free personal plan is
  enough. The tailnet needs
  **MagicDNS + HTTPS certificates** enabled (admin console) — Web Push and the
  service worker require the `https://<machine>.<tailnet>.ts.net` origin from
  `tailscale serve`. Push subscriptions and the home-screen install are tied
  to that origin, so set this up **before** pairing the phone. Use
  `tailscale serve`, never Funnel.
- **The computer must stay awake** to be reachable (no sleep while plugged in).
  README covers this; the app can't fix it.
- **Latency target:** a reply visible in the live view in ≲1 s over Tailscale
  (measured baseline: 0.58–0.86 s with a fresh `hc` process per send, §9).

## 4. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| **A** | **Node.js server** wrapping `hc`; xterm.js in the browser; `web-push`; `tailscale serve` for HTTPS | One language (JS) end to end; mature libs for terminals and push; Herdr modders already write JS. Needs Node on the host. | **Chosen** |
| B | Same design as a single Go executable | No Node install, lighter. Two languages (Go + browser JS). | Not chosen |
| — | Herdr mod | Mods can't run servers (no Node APIs / sockets). | Ruled out |
| — | Native Android app over SSH + `hc connect` | Weeks of work (terminal renderer, store builds) for the same result. | Ruled out |

## 5. Design (decided)

### 5.1 Shape

```
Android Chrome ──HTTPS (Tailscale)──► tailscale serve ──► http://127.0.0.1:<port>
                                                          Node server (host)
                                                            ├─ REST: list, send, keys
                                                            ├─ WebSocket: live terminal stream
                                                            ├─ watcher: hc events → push
                                                            └─ spawns `hc …` child processes
```

- Server binds **127.0.0.1 only**. The only way in is `tailscale serve`.
- Static frontend (mobile-first page + service worker + web app manifest),
  served by the same Node process; installable to the home screen.

### 5.2 Live view (verified feasible, §9)

- Per viewer: spawn `hc attach <t> --observe` with plain pipes (no PTY needed —
  verified it streams without a console). Pipe stdout bytes over a WebSocket
  to **xterm.js**. Kill the child when the socket closes.
- `--observe` = never types or resizes → the session on the computer is untouched.
- The stream is sized to the host terminal (often 120+ cols); get `cols`/`rows`
  from `hc get <t> --json` or the events feed and size xterm.js before the
  first paint. On the phone: fit to width by default, with a "fit / 100%"
  toggle and horizontal pan. Builder picks the mechanism.
- Optional `--history N` on open to show recent scrollback.

### 5.3 Answering (verified, §9)

- Text box → `hc send <t> "<text>"` (pastes + Enter; waits for a person's
  unfinished draft; **refuses while the program shows a dialog** unless
  `--force` — keep that safety; dialogs are answered with keys).
- Key bar → `hc keys <t> <names…>` (enter, esc, tab, up/down/left/right,
  1/2/3, ctrl+c, shift+tab; any `hc keys` name).
- Pass arguments as an argv array to `child_process.spawn` — **never** through
  a shell (the text is user input).
- Optimisation (not v1-blocking): keep one long-lived `hc connect` session and
  speak its protocol (`hc schema` gives the JSON Schema) instead of spawning
  `hc` per action, to cut the ~0.3–0.5 s Windows process-start cost.

### 5.4 Agent list

- Drive updates from **`hc events --json`** (emits whole terminal snapshots
  including `status`, `cols`/`rows`, `labels` such as `herdr.space`,
  `herdr.tab`, `herdr.seen`). Fall back to polling `hc ls --json` if the events
  process dies; restart it. `hc ls --json` fields: `address`, `agent`, `cwd`,
  `state`, `status` ∈ working/blocked/done/idle, `turn`, `where` = "Space / Tab".
- Group by space; sort blocked → working → done → idle.
- Push list updates to open pages over the WebSocket (or SSE).

### 5.5 Push notifications (Android)

- Standard Web Push: service worker + `PushManager.subscribe` with VAPID keys
  (generated per install at setup, stored in local config, never in the repo);
  server uses the `web-push` npm package.
- Delivery goes through Google's FCM (that's how Web Push works on Android);
  the payload is encrypted and carries only "‹agent› in ‹space› …" — never
  screen text.
- **Triggers — both on by default, each can be switched off in settings:**
  - status → `blocked`: "‹agent› in ‹space› needs you".
  - `working` → `done`: "‹agent› in ‹space› finished — waiting for you".
    Claude Code's plain-text questions and "shall I go ahead?" pauses end the
    turn and show as `done`, not `blocked`, so this trigger is essential.
- **Desk mode:** a toggle in the app. While on, no pushes are sent (list and
  live view still update). Off by default; persisted server-side. No automatic
  idle detection in v1.
- De-duplicate: one notification per transition per terminal (key on address
  + `turn`).
- Suppress for a terminal whose live view is **visible** on the phone right now
  (client reports Page Visibility over the WebSocket).
- Tapping a notification opens that session's live view directly.

### 5.6 Access control

1. Network: 127.0.0.1 bind + `tailscale serve` (tailnet only; never Funnel).
2. Identity: `tailscale serve` adds `Tailscale-User-Login` (and name) headers;
   allow only the configured owner login. Reject requests without it.
3. A PIN / passphrase set during setup, entered **once per device**; then a
   session cookie (HttpOnly, Secure, SameSite=Strict) valid **30 days**,
   sliding. Sessions stored server-side; **"sign out everywhere"** in v1.
   Rate-limit PIN attempts; store only a hash of the PIN.
4. CSRF: same-origin + SameSite cookie; WebSocket checks Origin.

**Escape hatch — "bring your own HTTPS" (advanced, unsupported):**
Tailscale is the one supported, documented setup. The server must not hard-
depend on it:
- A config mode (e.g. `access: "tailscale"` default, `access: "proxy"`) where
  the `Tailscale-User-Login` check is off and the server sits behind any HTTPS
  front end the user provides (Cloudflare Tunnel + Access, a reverse proxy on a
  VPN, …). Still binds 127.0.0.1 unless the user explicitly sets a bind address.
- In proxy mode the **PIN is mandatory** and can't be disabled; keep rate
  limiting, Secure cookies and the Origin check. Optionally trust one
  configured identity header (e.g. `Cf-Access-Authenticated-User-Email`) with
  an allowed value, off by default.
- Setup skips Tailscale steps in this mode and prints a clear warning; the
  README has a short "Advanced: other networks" section stating it's
  unsupported and the user is responsible for keeping it off the open
  internet (e.g. put an auth layer like Cloudflare Access in front).
- Not tested in v1 beyond a local smoke test (proxy mode on localhost).

The app **never writes Herdr state** other than typing via `hc send` /
`hc keys`: it does not set `herdr.seen` or other labels (items handled from the
phone may still look unread in Herdr — acceptable for v1).

### 5.7 Install, setup, running

- **Install:** clone + `npm install` + `npm start` in v1. Structure the package
  so `npx herdr-remote` can work later (a `bin` entry), but publishing to npm
  is not required for v1.
- **Setup command** (e.g. `npm run setup` / `herdr-remote setup`), interactive:
  checks `hc` is found and lists sessions; checks Tailscale is installed and
  logged in; asks for the allowed Tailscale login (default: the current
  `tailscale status --json` self user); sets the PIN; generates VAPID keys;
  runs or prints `tailscale serve --bg <port>`; prints the phone URL.
- **Config** lives outside the repo in the user's app-data folder
  (`%APPDATA%\herdr-remote\` on Windows): port, `hc` path override, allowed
  login, PIN hash, VAPID keys, push subscriptions, sessions, settings. Nothing
  machine- or person-specific is committed; `.gitignore` covers any local files.
- **Start at login:** setup offers to register a Task Scheduler "at log on"
  task (and remove it on uninstall); restart on crash.
- **README:** what it is, the tested setup (Windows + Android), prerequisites
  (Herdr, Node, Tailscale with MagicDNS + HTTPS), setup steps with the phone
  side (open URL, add to home screen, allow notifications), the stay-awake
  note, security model in plain words, troubleshooting, uninstall.
- **Licence:** Apache-2.0 (matches herdr-core). Mention it isn't affiliated
  with Herdr.

### 5.8 Screens (text sketch)

```
┌ herdr-remote ─────────── ● live ┐   ┌ ← api / Claude Code      ● working ┐
│ NEEDS YOU                       │   │ ┌──────────────────────────────────┐ │
│  ⚠ api · Claude Code      t3    │   │ │  (live xterm.js view of t3,      │ │
│ WORKING                         │   │ │   fit to width, pinch to zoom)   │ │
│  ⟳ web · 1                t14   │   │ └──────────────────────────────────┘ │
│ DONE                            │   │ [1][2][3][Enter][Esc][Tab][⇧Tab]     │
│  ✓ docs · Claude Code     t20   │   │ [↑][↓][←][→][Ctrl+C]                 │
│                    [desk mode ○]│   │ ┌ type a reply…           ┐ [Send]  │
└─────────────────────────────────┘   └──────────────────────────────────────┘
```

### 5.9 Decisions log

Owner's decisions: build on Herdr (not another tool); web app, approach A
(Node); real live terminal, not snapshots; push notifications; notify on both
`blocked` and `done`; quiet time via a manual **desk mode** toggle; usable by
other people (open source, one owner per install); **v1 = Windows + Android**;
**Tailscale is the supported setup, plus an advanced "bring your own HTTPS"
escape hatch** (§5.6).

Calls made while writing this (owner can override): MagicDNS + HTTPS certs as
a setup prerequisite; PIN once per device, 30-day sliding session, "sign out
everywhere"; never write Herdr labels; suppress pushes only for a session
visibly open on the phone; push payloads carry no screen text; starting new
work is out of v1; Apache-2.0 licence; config in `%APPDATA%\herdr-remote\`;
clone-and-run install in v1 with `npx` left possible.

## 6. Left to the builder

- Node framework (Express/Fastify/plain `http`), WebSocket lib, bundler or
  none, CSS approach.
- Fit-to-width/zoom mechanics for xterm.js on a phone.
- Exact `hc events` parsing (`hc events --help`, `hc schema`).
- Process supervision and log location.
- Visual design (simple, dark-mode friendly, big tap targets).
- Test strategy (unit-test the `hc` wrapper against a fake `hc`; one manual
  end-to-end on a real Android phone).

## 7. Risks / open checks for the first build session

1. **Watching a busy Claude Code session from outside.** Verified on an idle
   Claude Code terminal and on PowerShell; observing *the terminal running the
   test itself* returned nothing (self-attach). Confirm a busy agent streams
   when watched from the server process.
2. **Does `blocked` actually fire** for Claude Code permission prompts / plan
   approvals in Herdr? Only `working` and `done` were observed so far. Test
   first. If `blocked` never appears, a permission dialog mid-turn would stay
   `working` — then plan a fallback detector (e.g. recognise the dialog in the
   observed screen, or a long `working` with no output) before v1 ships.
3. **Push on Android Chrome** over the ts.net HTTPS address — first real test
   of the whole notification path.
4. **Tailscale changes** (switching accounts/tailnets) change the origin and
   the `Tailscale-User-Login` value; setup must be re-runnable to update them,
   and the README must say the phone needs re-pairing.
5. **Computer sleep** makes the app unreachable — README note.

## 8. Evidence (measured on a Windows host, 2026-11-17)

- `hc attach <t> --observe` with stdin from /dev/null and stdout to a file:
  streamed 3,464 bytes of VT output (full first paint) and stayed attached.
- Throwaway terminal printing the time every second, observed for 7 s: every
  tick arrived live.
- Throwaway PowerShell: `hc send` ran a command; `hc keys … G e t - D a t tab`
  tab-completed to `Get-Date`; `enter` ran it; `up esc` accepted — all visible
  in the observe stream.
- Latency, `hc send` → output visible in the observe stream: 577, 859, 607,
  743, 583 ms (includes spawning `hc` each time).
- Official Herdr phone app's Windows probe (captured via PowerShell
  script-block logging): checks `%USERPROFILE%\.local\bin\herdr-mobile-bridge.exe`,
  `%USERPROFILE%\.config\herdr\herdr.sock` / `sessions\*\herdr.sock`, and
  `herdr.exe` only in `%USERPROFILE%\.local\bin`, `.cargo\bin`, `bin`,
  `%LOCALAPPDATA%\herdr`, `%LOCALAPPDATA%\Programs\herdr`. With a `herdr.exe`
  placed there it then failed listing sessions (needs the bridge).
