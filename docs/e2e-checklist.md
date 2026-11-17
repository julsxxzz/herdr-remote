# Manual end-to-end checklist (real Android phone)

Owner checks that cannot be automated. Record results in the "Tested" line of the README.

- [ ] Run `npm run setup` in tailscale mode; open the `ts.net` URL on Android Chrome.
- [ ] Enter the PIN; the session list loads.
- [ ] Add to Home screen; open from the icon.
- [ ] Settings, Enable notifications; Send test notification arrives.
- [ ] Let a Claude Code session finish a turn with the phone locked; the "finished" push arrives.
- [ ] Tap the push; it opens that session's live view.
- [ ] Send a reply from the phone; it appears on the PC within about 1 s.
- [ ] Turn desk mode on; no push arrives.
- [ ] Open a wide terminal (about 200 columns): fits at half size and pans; zooming in and landscape both help.
- [ ] On that wide terminal, pinch out and in with two fingers: text zooms around your fingers (25% to 200%), the page itself never zooms, and one finger still scrolls and pans.
- [ ] Tap `+` and `−`: the zoom steps up and down and the middle button shows the percentage. Tap it: back to `Fit`.
- [ ] Set a zoom, reload the page (or close and reopen the app): the same zoom is back.
- [ ] In a session with long output, drag down with one finger: it scrolls past the screen into older output (history), and a flick keeps it gliding and slowing down.
- [ ] While scrolled up, new output arrives without pulling the view down; `↓ Latest` shows at the bottom right and tapping it jumps to the newest output (the button then hides).
- [ ] Pull down hard at the very top of the history, and on the session list: the page never reloads (no pull-to-refresh).
- [ ] `node src/cli.js install-task`, then reboot or log off and on: the server is running. Then `uninstall-task` removes it.
- [ ] The PIN prompt in `npm run setup` hides the typed characters in a real terminal.
- [ ] Does Herdr ever report `blocked` for a Claude Code permission prompt? (Design spec section 7, risk 2. If never, a permission dialog mid-turn stays "working" and needs a fallback.)
