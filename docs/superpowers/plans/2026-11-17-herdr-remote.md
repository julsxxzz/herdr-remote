# herdr-remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js web app that runs beside herdr-core on a Windows host and lets the owner watch, answer and get push notifications from their Herdr agent sessions on an Android phone over Tailscale.

**Architecture:** One Node process bound to 127.0.0.1, fronted by `tailscale serve`. It spawns `hc` child processes: one long-lived `hc events --json` feeding an in-memory terminal store; one `hc attach <t> --observe` per open live view, piped to xterm.js over a WebSocket; one short-lived `hc send` / `hc keys` per reply. The store emits status transitions to a notifier, which sends Web Push. The frontend is vanilla JS (no bundler) served by the same process.

**Tech Stack:** Node ≥ 20.11 (ESM, `node:http`, `node:test`), `ws`, `web-push`, `@xterm/xterm` (served from `node_modules`, no CDN). No framework, no bundler.

**Spec:** `docs/superpowers/specs/2026-11-17-herdr-remote-design.md`

## Global Constraints

- Server binds `127.0.0.1` only; a different `bind` is allowed only when `access: "proxy"` and the user set it explicitly (spec §5.6).
- Never Funnel. Never reachable without the identity check (`Tailscale-User-Login` == configured owner) in `access: "tailscale"` mode.
- Every `hc` call: `child_process.spawn(cmd, argvArray)` — **never** `shell: true`, never string-built commands.
- Watching is read-only: only `hc attach <t> --observe`. xterm.js `disableStdin: true`; nothing from a term socket is ever forwarded to `hc`.
- The app writes no Herdr state except via `hc send` / `hc keys` (no `hc label`, never `herdr.seen`).
- `hc send` without `--force` (keep the dialog refusal).
- Push payloads carry only agent name, space name, address and fixed text — never screen text, cwd or title.
- Config/state live in `%APPDATA%\herdr-remote\` (override: env `HERDR_REMOTE_HOME` or `--home <dir>`). Nothing machine- or person-specific in the repo, test fixtures included (use `C:\\work\\demo`-style paths, `owner@example.com`).
- Session cookie: `hr_session`, HttpOnly, Secure, SameSite=Strict, Path=/, 30-day sliding. Only a hash of the PIN and of session tokens is stored.
- Licence Apache-2.0; README says not affiliated with Herdr.
- `package.json`: `"type": "module"`, `"engines": {"node": ">=20.11"}`, `"bin": {"herdr-remote": "src/cli.js"}`, `"license": "Apache-2.0"`.
- Default port `4780`.

## Facts about `hc` 0.1.21 (measured 2026-11-17, use these, don't re-derive)

- `hc ls --json` → `{"hidden_finished":N,"terminals":[{address, agent, cwd, state:"live", status?:"working"|"blocked"|"done"|"idle", turn, where:"Space / Tab"}]}` (`status` absent for plain shells).
- `hc events --json`: line 1 = `{"channel":null,"seq":91,"terminals":[Terminal…]}` (includes `state:"finished"` ones). Then one JSON-RPC line per change: `{"jsonrpc":"2.0","method":"event","params":{"type":T,"terminal":"t1h","seq":92,"data":{…changed fields only…}}}`. Seen types: `created` (data = full Terminal), `labels` (`{labels:{where:"herdr-remote / 1"}}`), `foreground`, `status` (`{status:{app,state,kind?},records,reported}`), `turn`, `size`, `title`, `finished` (`{exit_code,finished_ms,reason,signal}`), `removed` (`{}`), `heartbeat` (every 15 s), `missed` (subscriber fell behind → resnapshot).
- Terminal fields used: `address, state ("live"|"finished"), status ({app, state, kind}|null), turn, cols, rows, labels.where, foreground.name, argv, cwd, title`. `status.state` ∈ idle/working/done/blocked/error; `status.kind` ∈ permission/question/auth (blocked only).
- `hc attach <t> --observe --history N` streams raw VT bytes on stdout with stdin closed; works on a busy Claude Code session from another process (15.6 KB in 6 s).
- `hc send <t> <text>` / `hc keys <t> <keys…>`; `hc send` refuses while blocked. `--` before the text works (`hc send t9 -- --help` sends `--help`). Errors: non-zero exit (3 = not_found) and, when piped, stderr is JSON `{"error":{"kind":"not_found","message":"no terminal \"t9\"","hint":"see `hc ls --all`"}}`.

## Open check (owner, before Task 8 is called done)

Spec §7 risk 2: trigger a Claude Code permission prompt in Herdr and run `hc get <t> --json` — does `status.state` become `blocked`? If not, add a follow-up task for a fallback detector before shipping. Also: enable **MagicDNS** and **HTTPS certificates** in the Tailscale admin console.

## Review Focus

1. **Reply text that looks like an option or shell syntax** (`-h`, `--force`, `"quoted" & | %PATH%`, multi-line) must be sent verbatim and never parsed as a flag → `hc send` argv uses `--` before the text (Task 2 test).
2. **`hc events` dies or herdr-core restarts** → list keeps updating (ls polling while down, events restarted with backoff) (Task 4 test).
3. **Terminal finishes or is removed while watched** → client gets `{type:"ended"}`, socket closes, `hc attach` child is killed; closing the phone tab also kills it (Task 7 tests).
4. **Server starts with many terminals already `done`/`blocked`** → no push storm: the first snapshot emits no transitions (Task 3 test).
5. **Push subscription expired (404/410 from FCM)** → it is removed from state and other subscriptions still get the push (Task 8 test).

---

## File Structure

```
package.json, LICENSE, README.md, .gitignore (+ .dev/)
src/
  cli.js            bin entry: start | setup | install-task | uninstall-task
  main.js           wires everything, listens
  config.js         paths, load/save config.json + state.json, validation
  hc.js             spawn wrapper for every hc command
  terminals.js      TerminalStore: snapshot/event reducer, list view model, transitions
  watcher.js        runs `hc events`, restarts, ls-poll fallback
  auth.js           identity, origin, PIN hash, sessions, rate limiter, cookies
  server.js         HTTP: REST API + static + security headers
  live.js           WebSockets: /ws/list and /ws/term
  push.js           web-push wrapper + subscription store
  notifier.js       transition → push rules
  setup.js          interactive setup (+ pure helpers)
  supervisor.js     restart-on-crash + log file
  startup-task.js   Task Scheduler at-logon task
public/
  index.html, style.css, app.js, api.js, list.js, term.js, settings.js,
  sw.js, manifest.webmanifest, icon.svg
test/
  fixtures/fake-hc.mjs
  *.test.js         one per src module
```

---

### Task 1: Scaffold + config

**Files:**
- Create: `package.json`, `LICENSE` (Apache-2.0 full text), `src/config.js`, `test/config.test.js`
- Modify: `.gitignore` (add `.dev/`)

**Interfaces:**
- Produces:
  - `configDir({env = process.env, platform = process.platform, home} = {}) → string` — `home` arg wins, then `env.HERDR_REMOTE_HOME`, then win32 `path.join(env.APPDATA, 'herdr-remote')`, else `path.join(env.XDG_CONFIG_HOME ?? ~/.config, 'herdr-remote')`.
  - `loadConfig(dir) → Config` / `saveConfig(dir, cfg)`; `loadState(dir) → State` / `saveState(dir, state)`. Missing file → defaults; writes are atomic (write `*.tmp`, rename) and create `dir`.
  - `DEFAULT_CONFIG = { port: 4780, bind: '127.0.0.1', hcPath: null, access: 'tailscale', allowedLogin: null, publicOrigin: null, pinHash: null, vapid: null, proxyIdentityHeader: null, proxyIdentityValue: null }`
  - `DEFAULT_STATE = { deskMode: false, notifyBlocked: true, notifyDone: true, subscriptions: [], sessions: {} }`
  - `validateConfig(cfg) → string[]` (empty = OK).

- [ ] **Step 1: `npm init`-equivalent `package.json`** with the Global Constraints fields, scripts `"start": "node src/cli.js start"`, `"setup": "node src/cli.js setup"`, `"dev": "node src/cli.js start --foreground --home .dev"`, `"test": "node --test test/"`; `npm install ws web-push @xterm/xterm`.
- [ ] **Step 2: Write failing tests** in `test/config.test.js`:
  - `configDir({env:{APPDATA:'C:\\A'}, platform:'win32'})` → `path.join('C:\\A','herdr-remote')`; `HERDR_REMOTE_HOME` overrides; `home` overrides both.
  - `loadConfig(emptyTmpDir)` deep-equals `DEFAULT_CONFIG`; save→load round-trips; `loadState` merges defaults into a partial file (`{deskMode:true}` → other defaults present).
  - `validateConfig` errors: missing `pinHash`; missing `publicOrigin`; missing `vapid`; `access:'tailscale'` without `allowedLogin`; `access:'tailscale'` with `bind:'0.0.0.0'`; `access:'proxy'` with `bind:'0.0.0.0'` is allowed; unknown `access` value.
- [ ] **Step 3: Run** `npm test` → FAIL (module missing).
- [ ] **Step 4: Implement `src/config.js`.**
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat: scaffold package and config store`.

### Task 2: `hc` wrapper + fake `hc`

**Files:**
- Create: `src/hc.js`, `test/fixtures/fake-hc.mjs`, `test/hc.test.js`

**Interfaces:**
- Produces:
  - `createHc({ command = 'hc', prefixArgs = [], env } = {}) → Hc` (tests pass `command: process.execPath, prefixArgs: [fakeHcPath]`).
  - `Hc.run(args: string[], {timeoutMs = 15000} = {}) → Promise<{code:number, stdout:string, stderr:string}>` (kills on timeout, code `-1`).
  - `Hc.ls() → Promise<object[]>` (the `terminals` array), `Hc.get(address) → Promise<object>`.
  - `Hc.send(address, text) → Promise<{ok:true} | {ok:false, error:string}>` — argv `['send', address, '--', text]`; `error` = `JSON.parse(stderr).error.message` if that parses, else trimmed stderr, else `"hc exited with code N"`.
  - `Hc.keys(address, names: string[]) → Promise<same>` — argv `['keys', address, '--', ...names]`.
  - `Hc.observe(address, {history = 0} = {}) → ChildProcess` — argv `['attach', address, '--observe', '--history', String(history)]`, `stdio: ['ignore','pipe','pipe']`.
  - `Hc.events() → ChildProcess` — argv `['events', '--json']`.
  - `isValidAddress(s) → boolean`: `/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,63}$/`. `isValidKeyName(s) → boolean`: `/^[a-z0-9][a-z0-9+_-]{0,19}$/i`. Wrapper methods throw `TypeError` on invalid input before spawning.
- Fake hc contract (`FAKE_HC_DIR` env): appends `JSON.stringify(argv)` to `$DIR/calls.jsonl`; `ls` prints `$DIR/ls.json`; `get` prints `$DIR/get.json`; `send`/`keys` exit with the number in `$DIR/exit` (default 0) and write `$DIR/stderr` to stderr; `events` prints `$DIR/events.jsonl` then stays alive (exits 3 if `$DIR/events-exit` exists); `attach` writes `$DIR/screen.bin` then stays alive until killed (exits 0 at once if `$DIR/attach-exit` exists).

- [ ] **Step 1: Write the fake** (`fake-hc.mjs`, plain Node, no deps).
- [ ] **Step 2: Write failing tests** in `test/hc.test.js`:
  - `send('t3', '--force "a" & b\nline2')` → last `calls.jsonl` entry deep-equals `['send','t3','--','--force "a" & b\nline2']`; result `{ok:true}`.
  - With `exit`=1 and `stderr`=`{"error":{"kind":"blocked","message":"it is showing a dialog"}}` → `{ok:false, error:'it is showing a dialog'}`; with plain-text stderr `oops` → `error:'oops'`.
  - `keys('t3', ['shift+tab','enter'])` → argv `['keys','t3','--','shift+tab','enter']`.
  - `send('-x', 'hi')` and `keys('t3', ['--force'])` reject with `TypeError` and write no call.
  - `ls()` returns the parsed `terminals` array; `observe('t3',{history:200})` stdout yields the bytes of `screen.bin`, and `child.kill()` ends it.
- [ ] **Step 3: Run** `npm test` → FAIL.
- [ ] **Step 4: Implement `src/hc.js`.**
- [ ] **Step 5: Run** `npm test` → PASS.
- [ ] **Step 6: Commit** `feat: hc process wrapper with argv-only spawning`.

### Task 3: Terminal store

**Files:**
- Create: `src/terminals.js`, `test/terminals.test.js`

**Interfaces:**
- Produces:
  - `class TerminalStore extends EventEmitter`:
    - `reset({seq, terminals}, {emitTransitions = true} = {})` — replaces all; when `emitTransitions` compares old vs new status per address.
    - `apply({type, terminal, seq, data})` — ignores `seq <= this.seq`; `created` inserts `data`; `removed` deletes; every other type shallow-merges `data` into the record, except `labels` which merges into `record.labels`; `heartbeat` no-op.
    - `get(address) → ListItem | null` (live only), `list() → ListItem[]` (live only, sorted).
    - Events: `'changed'` (no args) after any change; `'transition'` `{address, from, to, turn, item}` whenever `statusOf` changes (`from`/`to` are status strings).
  - `toListItem(t) → {address, agent, space, tab, status, kind, turn, cols, rows}` — `status = t.status?.state ?? 'idle'`; `kind = t.status?.kind ?? null`; `space`/`tab` from `labels.where` split on the first `' / '` (no `where` → space `'Other'`, tab `''`); `agent = displayAgent(t)`.
  - `displayAgent(t) → string` — source `t.status?.app ?? t.foreground?.name ?? basename(t.argv?.[0] ?? '?')`, strip `.exe`, map `claude-code`→`Claude Code`, `codex`→`Codex`.
  - `URGENCY = { blocked: 0, error: 0, working: 1, done: 2, idle: 3 }`; `list()` sorts by urgency, then space (localeCompare), then address.
  - `lsToTerminal(item) → Terminal` — `{address, state: item.state, status: item.status ? {state: item.status, app: item.agent} : null, turn, cwd, labels: {where: item.where}, foreground: {name: item.agent}}`.

- [ ] **Step 1: Write failing tests** with a hand-written fixture shaped like the Facts section (generic paths only):
  - First `reset(snapshot, {emitTransitions:false})` with t1 `done`, t2 `blocked`, t3 finished → **zero** `transition` events; `list()` = [t2, t1] (finished excluded).
  - `apply(status working)` then `apply(status done)` on t1 → transitions `idle/done→working`, `working→done` with current `turn`.
  - Event with `seq` ≤ current ignored.
  - `created` → appears; `labels {where:'api / 2'}` → `space:'api', tab:'2'`, other labels kept; `size {cols:90, rows:30}` → item updated; `finished` → gone from `list()`; `removed` → `get()` null.
  - `toListItem` for a plain shell (`status:null`, `foreground.name:'powershell.exe'`) → `{status:'idle', agent:'powershell'}`.
  - `lsToTerminal` on the `hc ls` sample → `toListItem` gives `status:'done', agent:'Claude Code', space:'demo', tab:'1'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: terminal store with event reducer and transitions`.

### Task 4: Events watcher

**Files:**
- Create: `src/watcher.js`, `test/watcher.test.js`

**Interfaces:**
- Consumes: `Hc.events()`, `Hc.ls()`, `TerminalStore.reset/apply`, `lsToTerminal`.
- Produces: `startWatcher({hc, store, log = console, backoffMs = [1000, 2000, 5000, 10000, 30000], pollMs = 5000}) → {stop(): void}`.
  - Reads stdout line by line (`readline`). First line with `terminals` → `store.reset(line, {emitTransitions: !firstEverSnapshot})`. `method === 'event'` → `store.apply(params)`; `params.type === 'missed'` → kill child (restart gives a fresh snapshot). Unparseable lines are logged and skipped.
  - On child exit: restart after the next backoff step; reset the step index if the child had lived > 60 s. While no child is running, poll `hc.ls()` every `pollMs` → `store.reset({seq: store.seq, terminals: items.map(lsToTerminal)})`.
  - `stop()` kills the child and clears timers.

- [ ] **Step 1: Write failing tests** (fake hc, tiny `backoffMs:[50]`, `pollMs:50`):
  - events fixture → store reflects snapshot then events; initial snapshot emits no transitions.
  - with `events-exit`: fake exits → within 200 ms the store is refreshed from `ls.json` and `events` was spawned again (count `events` calls in `calls.jsonl` ≥ 2).
  - a `missed` line causes a respawn.
  - `stop()` → no further calls after 200 ms.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: hc events watcher with restart and ls fallback`.

### Task 5: Auth

**Files:**
- Create: `src/auth.js`, `test/auth.test.js`

**Interfaces:**
- Produces:
  - `hashPin(pin: string) → string` — `scrypt` (N=16384, r=8, p=1, 32-byte key, 16-byte random salt), format `scrypt$<saltB64>$<hashB64>`. `verifyPin(pin, stored) → boolean` (`timingSafeEqual`). `isAcceptablePin(pin) → boolean`: ≥ 6 chars.
  - `checkIdentity(headers, cfg) → {ok: boolean, login: string|null}` — tailscale: `headers['tailscale-user-login']` equals `cfg.allowedLogin` case-insensitively; proxy: ok unless `proxyIdentityHeader` is set, then that header must equal `proxyIdentityValue`.
  - `checkOrigin(headers, cfg) → boolean` — `headers.origin === cfg.publicOrigin`.
  - `createSessions({state, save, now = Date.now}) → {create(): string, check(token): boolean, revokeAll(): void}` — token = 32 random bytes base64url; stored in `state.sessions[sha256hex(token)] = {created, lastSeen}`; valid if `now() - lastSeen < 30 days`; `check` slides `lastSeen` and calls `save` at most once per hour per session; expired entries deleted on check.
  - `createRateLimiter({max = 5, windowMs = 900000, now = Date.now}) → {check(key) → {allowed, retryAfterMs}, fail(key), succeed(key)}` — after `max` failures within `windowMs`, blocked until the window ends.
  - `sessionCookie(token) → string` = `hr_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`; `readSessionToken(cookieHeader) → string|null`.

- [ ] **Step 1: Write failing tests**: hash/verify round-trip, wrong PIN false, two hashes of same PIN differ; identity: tailscale missing header → not ok, `Owner@Example.com` vs `owner@example.com` → ok, other login → not ok; proxy without header config → ok, with config and wrong value → not ok; origin exact match only (`https://box.example.ts.net` ok, `http://…` and missing → false); sessions: created token checks true, unknown false, `now` + 31 days with no use → false, use every 20 days for 90 days → still true, `revokeAll` → false, state never contains the raw token; limiter: 5 fails → 6th `check` not allowed with `retryAfterMs > 0`, after `windowMs` allowed again, `succeed` clears.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: identity, PIN, session and rate-limit auth`.

### Task 5b: Herdr details on list items (owner request, 2026-11-17)

**Files:**
- Modify: `src/terminals.js` (`toListItem`), `test/terminals.test.js`

**Interfaces:**
- Consumes: Terminal shape from "Facts about hc" (`title`, `status.{title,msg,progress,kind}`, `records` = map of `{app, state, title}`, `labels['herdr.seen']`, `turn`).
- Produces: `toListItem(t)` gains these keys (existing keys unchanged):
  - `title`: `t.title || null`
  - `activity`: `t.status?.title || Object.values(t.records ?? {}).find(r => r?.title)?.title || null`
  - `message`: `t.status?.msg || null`
  - `progress`: integer 0–100 from `t.status?.progress`, else `null` (clamp; non-numbers → `null`)
  - `unread`: `true` only when `labels['herdr.seen']` is present and `Number(labels['herdr.seen']) < t.turn`; missing label or non-numeric → `false`. Read-only: nothing writes `herdr.seen`.
  - (`kind` already exists: permission / question / auth.)
- Push payloads must NOT gain any of these (spec §2 anti-goal: no screen text); Task 8's payload-keys test enforces it.

- [ ] **Step 1: Write failing tests**: a terminal with `title:'Ship issue 7'`, `records:{a:{app:'claude-code',state:'working',title:'Analyse issue 7'}}`, `status:{app:'claude-code',state:'working',progress:40,msg:'Running tests'}` → `{title:'Ship issue 7', activity:'Analyse issue 7', message:'Running tests', progress:40}`; `status.title` wins over records; `title:''` → `null`; `progress:250` → `100`, `'x'` → `null`; `herdr.seen:'3'`, `turn:4` → `unread:true`; `'4'`/`4` → `false`; no label → `false`; a `title` event and a `status` event (with `records`) applied via `store.apply` update `get()` accordingly.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat: herdr title, activity, progress and unread on list items`.

### Task 6: HTTP server (REST + static)

**Files:**
- Create: `src/server.js`, `test/server.test.js`, placeholder `public/index.html`

**Interfaces:**
- Consumes: Task 1 state/config, Task 2 `Hc`, Task 3 store, Task 5 auth. `push` and `notifier` from Task 8 are injected; tests pass stubs `{publicKey:'K', subscribe(){}, unsubscribe(){}, sendAll: async()=>({sent:1, removed:0})}`.
- Produces: `createServer({config, state, saveState, hc, store, sessions, limiter, push, publicDir, vendorDir, log}) → http.Server` (not listening). `vendorDir` = `node_modules/@xterm/xterm`.
- Request pipeline (in order): `checkIdentity` → else `403` text `Not allowed`; for non-GET: `checkOrigin` and `content-type: application/json` → else `403`; JSON body ≤ 16 KB → else `413`; `/api/*` except `/api/login` and `/api/session` need a valid session → else `401 {error:'signin'}`.
- Routes:
  - `GET /api/session` → `{signedIn: boolean}`
  - `POST /api/login {pin}` → `204` + `Set-Cookie`; `401 {error:'wrong_pin'}`; `429 {error:'too_many', retryAfterMs}`. Limiter key = identity login or `'proxy'`.
  - `POST /api/logout-everywhere` → `204`.
  - `GET /api/terminals` → `{items: store.list(), deskMode}`.
  - `POST /api/terminals/:address/send {text}` → `204`; `400` if text empty/whitespace or > 4000 chars; `404` if `store.get(address)` null; `409 {error}` when `hc.send` returns `ok:false`.
  - `POST /api/terminals/:address/keys {keys}` → same codes; `keys` 1–16 valid key names.
  - `GET /api/settings` → `{deskMode, notifyBlocked, notifyDone}`; `PUT /api/settings` partial booleans → saved, returns full settings; non-boolean → `400`.
  - `GET /api/push/key` → `{publicKey}`; `POST /api/push/subscribe {subscription}`; `POST /api/push/unsubscribe {endpoint}`; `POST /api/push/test` → `{sent, removed}`.
  - Static: `/` → `index.html`; files under `publicDir` (no `..` escape → `404`); `/vendor/xterm.js` → `vendorDir/lib/xterm.js`, `/vendor/xterm.css` → `vendorDir/css/xterm.css`.
- Headers on every response: `Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `/api/*` adds `Cache-Control: no-store`.

- [ ] **Step 1: Write failing tests** (real server on port 0, fake hc, `access:'tailscale'`, `allowedLogin:'owner@example.com'`, `publicOrigin:'https://box.example.ts.net'`; helper `req(method, path, {headers, body, cookie})`):
  - no identity header → 403 on `/` and `/api/terminals`; wrong login → 403.
  - POST without/with wrong `Origin` → 403; with `text/plain` content-type → 403.
  - `/api/terminals` without cookie → 401; login wrong PIN ×5 then 6th → 429; correct PIN → 204 with cookie containing `HttpOnly`, `Secure`, `SameSite=Strict`.
  - signed in: `/api/terminals` returns store items; send `'--help'` to known address → 204 and fake argv ends `['--','--help']`; unknown address → 404; empty text → 400; fake `exit`=1 → 409 with stderr text.
  - keys `['ctrl+c']` → 204; `['rm -rf']` → 400.
  - `PUT /api/settings {deskMode:true}` → state saved; `{deskMode:'yes'}` → 400.
  - `logout-everywhere` → old cookie now 401.
  - `/vendor/xterm.js` 200; `/../package.json` 404; CSP header present.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: http api with auth pipeline and static files`.

### Task 7: WebSockets (list + live terminal)

**Files:**
- Create: `src/live.js`, `test/live.test.js`

**Interfaces:**
- Consumes: store (`list`, `get`, `'changed'`), `Hc.observe`, auth (`checkIdentity`, `checkOrigin`, `readSessionToken`, `sessions.check`), `notifier.setVisible(clientId, address|null)` (Task 8; tests stub it).
- Produces: `attachWebSockets(server, {config, state, store, hc, sessions, notifier, log, maxObservers = 8, maxBufferedBytes = 4*1024*1024}) → {close(): void}` using `new WebSocketServer({noServer:true})` on `'upgrade'`. Upgrade refused (write `HTTP/1.1 401`/`403` and destroy) unless identity, Origin and session are valid.
- `/ws/list`: on open send `{type:'list', items, deskMode}`; on store `'changed'` re-send, throttled to one per 250 ms. Client → `{type:'visible', address: string|null}` → `notifier.setVisible(id, address)`; on close `setVisible(id, null)`.
- `/ws/term?address=<a>&history=<n>` (`history` 0–2000, default 200): unknown/invalid address → close `4404`. Over `maxObservers` → close `4429`. Else send `{type:'size', cols, rows}` from `store.get`, spawn `hc.observe`, forward stdout chunks as **binary** frames; on store size change for that address send `{type:'size'}` again. Child exit → send `{type:'ended'}`, close `1000`. Socket close → `child.kill()`. `bufferedAmount > maxBufferedBytes` → close `1013`. Incoming messages ignored.

- [ ] **Step 1: Write failing tests** (server from Task 6 + `attachWebSockets`, client `ws`):
  - upgrade without cookie or with wrong Origin → connection error (401/403).
  - `/ws/list` gets initial list; `store.apply(...)` → a second `list` arrives; sending `visible` calls the stub with the address; closing calls it with `null`.
  - `/ws/term?address=t1` → first message JSON `size` with the store's cols/rows, then binary equal to `screen.bin`.
  - closing the client socket → fake attach process is gone (track the child via an injected `hc` wrapper exposing the spawned child; assert `child.exitCode !== null || child.killed` within 500 ms).
  - with `attach-exit` → client receives `{type:'ended'}` and close code 1000.
  - unknown address → close code 4404.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: websocket list feed and read-only live terminal stream`.

### Task 8: Push + notifier

**Files:**
- Create: `src/push.js`, `src/notifier.js`, `test/push.test.js`, `test/notifier.test.js`

**Interfaces:**
- Produces:
  - `createPush({vapid: {publicKey, privateKey}, subject, state, saveState, webpush, log}) → {publicKey, subscribe(sub), unsubscribe(endpoint), sendAll(payload) → Promise<{sent, removed}>}` — `subject` = `config.publicOrigin` (no email). Dedupe subscriptions by `endpoint`. Send options `{TTL: 3600, urgency: 'high'}`. On `statusCode` 404 or 410 remove the subscription and save; other errors logged, not removed. `webpush` injectable (default `import webpush from 'web-push'`).
  - `generateVapidKeys() → {publicKey, privateKey}` (wraps `webpush.generateVAPIDKeys`, used by setup).
  - `createNotifier({state, push, log}) → {onTransition(tr), setVisible(clientId, address|null)}`:
    - skip if `state.deskMode`;
    - `to === 'blocked' && from !== 'blocked' && state.notifyBlocked` → title `` `${agent} in ${space} needs you` ``;
    - `from === 'working' && to === 'done' && state.notifyDone` → title `` `${agent} in ${space} finished — waiting for you` ``;
    - skip if any client currently visible on `address`;
    - dedupe key `` `${address}:${turn}:${to}` `` (keep last 1000);
    - payload `JSON.stringify({title, body: 'Tap to open', address, tag: address, url: '/#/t/' + address})`.
- [ ] **Step 1: Write failing tests**:
  - push: `subscribe` twice same endpoint → one entry; `sendAll` with fake `webpush.sendNotification` rejecting `{statusCode:410}` for sub A and resolving for B → `{sent:1, removed:1}`, A gone from state, `saveState` called.
  - notifier (fake push records payloads): working→done notifies with exact title `Claude Code in api finished — waiting for you`; idle→blocked → `Claude Code in api needs you`; blocked→blocked no; done→idle no; same address+turn+to twice → one push; deskMode → none; `notifyDone:false` → done ignored, blocked still sent; `setVisible('c1','t1')` suppresses t1 but not t2; `setVisible('c1', null)` re-enables; payload has no keys other than `title, body, address, tag, url`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: web push sender and transition notifier`.

### Task 9: `main.js` + frontend

**Files:**
- Create: `src/main.js`, `public/index.html`, `public/style.css`, `public/app.js`, `public/api.js`, `public/list.js`, `public/term.js`, `public/settings.js`, `public/sw.js`, `public/manifest.webmanifest`, `public/icon.svg`

**Interfaces:**
- Consumes: all of Tasks 1–8.
- Produces: `startServer({home, log = console}) → Promise<{server, stop()}>` in `src/main.js` — loads config/state, exits with `Run "npm run setup" first: <errors>` if `validateConfig` fails, resolves `hc` from `config.hcPath ?? 'hc'`, wires store → `notifier.onTransition`, listens on `config.bind:config.port`, `stop()` kills watcher and all observers.
- Frontend (ES modules, no build; xterm loaded via `<script src="/vendor/xterm.js">`, global `Terminal`):
  - Hash routes: `#/` list, `#/t/<address>` live view; login screen whenever `/api/session` says not signed in or any call returns 401.
  - **List:** one `/ws/list` socket for the whole app (reconnect 1/2/5 s; header dot "● live" / "○ offline"). Sections NEEDS YOU (blocked, error) / WORKING / DONE / IDLE, each row `space · agent`, tab, address, status icon, plus (Task 5b) a second line with `activity` (else `title`), the blocked `kind` as a label (Permission / Question / Sign-in), `message` and a thin `progress` bar when present, and an unread dot when `unread`; tap opens view. The live-view header shows the same title/activity/status. Desk-mode toggle in footer.
  - **Live view:** `new Terminal({cols, rows, disableStdin: true, scrollback: 1000, fontSize: 14, cursorBlink: false})`; on `size` → `term.resize`; binary → `term.write(new Uint8Array(buf))`; on (re)connect `term.reset()` first; `ended` → banner "Session ended". **Fit/100% toggle:** fit = CSS `transform: scale(containerWidth / naturalWidth)` with `transform-origin: 0 0` and the wrapper height set to the scaled height, recomputed on `resize`/`size`; 100% = no transform, `overflow-x: auto`.
  - **Key bar:** `1 2 3 Enter Esc Tab ⇧Tab ↑ ↓ ← → Ctrl+C` → keys `1 2 3 enter esc tab shift+tab up down left right ctrl+c`; Ctrl+C needs a second tap within 2 s (button label changes to "Tap again"). Min tap target 44 px.
  - **Reply box:** textarea + Send → `/send`; on 409 show the server's error inline plus the hint "Answer the dialog with the keys above".
  - **Visibility:** list socket gets `{type:'visible', address}` when a live view is open and `document.visibilityState === 'visible'`, else `null`.
  - **Settings sheet:** Enable notifications (on tap: `Notification.requestPermission`, `navigator.serviceWorker.ready`, `pushManager.subscribe({userVisibleOnly: true, applicationServerKey})`, POST subscribe), Send test, notify-on-blocked / notify-on-done toggles, desk mode, Sign out everywhere.
  - **sw.js:** `push` → `showNotification(title, {body, tag, data: {url}, icon: '/icon.svg', badge: '/icon.svg', renotify: true})`; `notificationclick` → focus an open client and `navigate(url)`, else `clients.openWindow(url)`. No offline caching.
  - **manifest:** `name` "herdr-remote", `display: standalone`, `start_url: "/"`, dark `background_color`/`theme_color`, `icons: [{src:'/icon.svg', sizes:'any', type:'image/svg+xml'}]`.
  - Dark by default, system font, no external fonts or CDNs.

- [ ] **Step 1: Implement `src/main.js`** and run `npm test` → all earlier tests still PASS.
- [ ] **Step 2: Create a dev config**: run `node src/cli.js setup --proxy --home .dev` once Task 10 exists — until then write `.dev/config.json` by hand: `access:'proxy'`, `publicOrigin:'http://127.0.0.1:4780'`, `pinHash` from `node -e "import('./src/auth.js').then(m=>console.log(m.hashPin('123456')))"`, `vapid` from `generateVapidKeys()`.
- [ ] **Step 3: Implement the frontend files.**
- [ ] **Step 4: Verify in a desktop browser at phone size** (use the `run` / claude-in-chrome skill, 412×915 viewport): `node src/cli.js start --foreground --home .dev` (or `node -e` calling `startServer({home:'.dev'})` before Task 10), sign in with `123456`, list shows the real Herdr terminals grouped by urgency, opening a **throwaway** `hc run --bg powershell.exe` terminal shows its live screen fitted to width, `Get-Date` via the reply box appears in < 1 s, Tab/Enter/↑ keys work, 100% toggle pans horizontally, killing the terminal shows "Session ended". Never type into the owner's real agent sessions while testing.
- [ ] **Step 5: Commit** `feat: mobile web frontend and server entry point`.

### Task 10: CLI, setup, supervisor, start-at-login

**Files:**
- Create: `src/cli.js`, `src/setup.js`, `src/supervisor.js`, `src/startup-task.js`, `test/setup.test.js`, `test/startup-task.test.js`

**Interfaces:**
- Consumes: `configDir`, `loadConfig/saveConfig/loadState/saveState`, `hashPin`, `isAcceptablePin`, `generateVapidKeys`, `createHc`, `startServer`.
- Produces:
  - `cli.js` (shebang `#!/usr/bin/env node`): `start [--foreground] [--home d]`, `setup [--proxy] [--home d]`, `install-task`, `uninstall-task`, `--help`.
  - `parseTailscaleStatus(json) → {running: boolean, loginName: string|null, dnsName: string|null, httpsReady: boolean}` — `running = BackendState === 'Running'`; `loginName = User[Self.UserID].LoginName`; `dnsName = Self.DNSName` without trailing dot; `httpsReady = CertDomains?.length > 0`.
  - `originFromDnsName(dnsName) → 'https://' + dnsName`.
  - `runSetup({home, proxy, prompt, exec, log})` — `prompt`/`exec` injectable. Steps: find `hc` (`hc --version`; offer `hcPath` override if missing) and print `hc ls` count; tailscale mode: `tailscale status --json` → stop with instructions if not running or `!httpsReady` ("Enable HTTPS certificates in the Tailscale admin console → DNS"); ask allowed login (default `loginName`); proxy mode: print the unsupported warning, ask `publicOrigin`, optional identity header/value, PIN mandatory; PIN (ask twice; on re-run "Keep current PIN? [Y/n]"); VAPID only if missing; if `publicOrigin` or `allowedLogin` changed vs. previous config → clear `subscriptions` and `sessions` and print "Re-open the new URL on your phone and enable notifications again" (spec §7 risk 4); offer to run `tailscale serve --bg <port>`; offer `install-task`; print the phone URL.
  - `supervisor.js`: `superviseServer({home, logFile})` — forks `src/main.js` via `child_process.fork` with `--home`, appends its stdout/stderr to `<home>/logs/server.log` (rotate to `server.log.1` at 5 MB), restarts on non-zero exit with backoff 1/2/5/10/30 s (reset after 60 s up), exits on SIGINT.
  - `startup-task.js`: `taskCommands({nodePath, cliPath, home}) → {vbs: string, create: string[], remove: string[]}` — writes `<home>/start-hidden.vbs` (`CreateObject("WScript.Shell").Run """<node>"" ""<cli>"" start", 0, False`), `create = ['schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'herdr-remote', '/TR', 'wscript.exe "<vbs>"']`, `remove = ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote']`. `installTask`/`uninstallTask` run them with `spawn` (argv).
- [ ] **Step 1: Write failing tests**: `parseTailscaleStatus` on a fixture (`owner@example.com`, `box.example.ts.net.`, `CertDomains: []`) → `httpsReady:false`, dnsName without dot; `originFromDnsName`; `runSetup` with scripted `prompt` answers and stub `exec` in a temp home → config valid per `validateConfig`, `pinHash` verifies, second run with a different login clears `subscriptions`/`sessions` but keeps VAPID; proxy mode with empty PIN re-prompts; `taskCommands` paths quoted correctly when they contain spaces.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Smoke:** `node src/cli.js setup --proxy --home .dev` then `node src/cli.js start --home .dev` → `.dev/logs/server.log` shows "listening on 127.0.0.1:4780"; kill the child with Task Manager → it restarts.
- [ ] **Step 6: Commit** `feat: setup command, supervisor and start-at-login task`.

### Task 11: README + end-to-end on the phone

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README** (spec §5.7 list): what it is + not affiliated with Herdr; tested setup Windows + Android Chrome; prerequisites (Herdr/herdr-core, Node ≥ 20.11, Tailscale on both devices, MagicDNS + HTTPS certificates); install (`git clone`, `npm install`, `npm run setup`, `npm start`); phone steps (open the printed URL, enter PIN, Add to Home screen, Settings → Enable notifications); keep-awake note; security model in plain words (tailnet only, owner login, PIN once per device, 30-day session, sign out everywhere, push carries no screen text, uses Google FCM); switching tailnets = re-run setup + re-pair; troubleshooting (403 = wrong Tailscale login; no push = HTTPS/notifications permission/desk mode; `hc` not found); uninstall (`herdr-remote uninstall-task`, `tailscale serve --https=443 off`, delete `%APPDATA%\herdr-remote`); "Advanced: other networks (unsupported)" section; licence.
- [ ] **Step 2: Grep the repo for personal data** — `git grep -nIiE "users\\\\[a-z]+\\\\|@gmail|ts\\.net" -- . ':!docs'` → only `example` placeholders.
- [ ] **Step 3: Owner end-to-end on the real phone** (spec §7 risk 3): setup in tailscale mode, open the ts.net URL on Android Chrome, install to home screen, enable notifications, send test → arrives; let a Claude Code session finish a turn with the phone locked → "finished" push arrives; tap → opens that live view; answer → visible on the computer; turn desk mode on → no push. Record results in the README's "Tested" line.
- [ ] **Step 4: Commit** `docs: README with setup, security model and troubleshooting`.
