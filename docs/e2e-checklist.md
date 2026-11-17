# Manual end-to-end checklist (real Android phone)

Owner checks that cannot be automated. Record results in the "Tested" line of the README.

- [ ] Run `npm run setup` in tailscale mode; open the `ts.net` URL on Android Chrome.
- [ ] Enter the PIN; the session list loads.
- [ ] Add to Home screen; open from the icon.
- [ ] Settings, Enable notifications; Send test notification arrives.
- [ ] Let a Claude Code session finish a turn with the phone locked; the "finished" push arrives.
- [ ] Tap the push; it opens that session's live view.
- [ ] Send a reply from the phone; it appears on the PC within about 1 s.
- [ ] Make Claude Code ask a question with options (e.g. "Use the AskUserQuestion tool to ask me which colour I prefer, with options Red and Blue."). When the session shows as needing you, the Send button reads `Type into dialog` and the hint about "Type something" shows under the reply box.
- [ ] Press the "Type something" option's number on the key bar, type an answer, tap `Type into dialog`: it turns to a highlighted `Tap again to type` and nothing is sent. Wait 2 s: it goes back. Tap twice: the answer reaches Claude Code.
- [ ] While armed, edit the text: it disarms. In a session that isn't showing a dialog, Send sends on the first tap as before.
- [ ] A permission prompt that shows as blocked also gets `Type into dialog` with the same two-tap confirm.
- [ ] Two taps with the keyboard up: the keyboard stays up through both taps (and through key-bar taps), and the Send button does not move while its label changes.
- [ ] Tap `Type into dialog` twice very quickly (under half a second): the second tap is ignored, the button stays `Tap again to type`; a slower second tap types.
- [ ] Arm, then answer the dialog on the PC (or let it change) before the second tap: nothing is sent and the app says the dialog changed / closed.
- [ ] Arm, then press a key-bar key: it disarms.
- [ ] Tap the reply box while a dialog shows: the answering layout hides the header details and zoom buttons, and the dialog stays visible in the terminal.
- [ ] Turn desk mode on; no push arrives.
- [ ] Open a wide terminal (about 200 columns): fits at half size and pans; zooming in and landscape both help.
- [ ] On that wide terminal, pinch out and in with two fingers: text zooms around your fingers (25% to 200%), the page itself never zooms, and one finger still scrolls and pans.
- [ ] Tap `+` and `−`: the zoom steps up and down and the middle button shows the percentage. Tap it: back to `Fit`.
- [ ] Set a zoom, reload the page (or close and reopen the app): the same zoom is back.
- [ ] In a session with long output, drag down with one finger: it scrolls past the screen into older output (history), and a flick keeps it gliding and slowing down.
- [ ] While scrolled up, new output arrives without pulling the view down; `↓ Latest` shows at the bottom right and tapping it jumps to the newest output (the button then hides).
- [ ] While scrolled up or while a flick is still gliding, the key bar, the reply box and `↓ Latest` still take taps; touching the terminal stops a flick.
- [ ] After scrolling into history, start a drag on the far right edge of the terminal (where the thin scrollbar shows): it scrolls once with your finger, no jump.
- [ ] Pull down hard at the very top of the history in the live view: the page never reloads. On the session list, pull-to-refresh reloads as usual.
- [ ] Pinch at the bottom edge of the terminal with one finger landing on the key bar: no key is sent and no zoom jump happens.
- [ ] Key bar shows `1 2 3 4 ↑ ↓` / `Enter Tab ⇧Tab ← → Esc`; a successful key shows a brief ✓, a successful reply shows `Sent ✓`; in landscape the keys are one row.
- [ ] `node src/cli.js install-task`, then reboot or log off and on: the server is running. Then `uninstall-task` removes it.
- [ ] After `install-task` and a log on: Task Manager shows one `node` for herdr-remote (no supervisor), plus `hc` and the hidden `wscript.exe` launcher. End that `node` task: within a few seconds it is back (the phone reconnects, a new `starting (pid …)` line is in `<home>\logs\server.log`). End it twice more: it still comes back (after 2 s, then 4 s).
- [ ] With the task running, `node src/cli.js stop` prints `stopped`, the server is gone and stays gone (no restart a minute later).
- [ ] The PIN prompt in `npm run setup` hides the typed characters in a real terminal.
- [ ] Does Herdr ever report `blocked` for a Claude Code permission prompt? (Design spec section 7, risk 2. If never, a permission dialog mid-turn stays "working" and needs a fallback.)
