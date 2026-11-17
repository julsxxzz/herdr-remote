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
- [ ] Open a wide terminal (about 200 columns): fits at half size and pans; 100% and landscape both help.
- [ ] `node src/cli.js install-task`, then reboot or log off and on: the server is running. Then `uninstall-task` removes it.
- [ ] The PIN prompt in `npm run setup` hides the typed characters in a real terminal.
- [ ] Does Herdr ever report `blocked` for a Claude Code permission prompt? (Design spec section 7, risk 2. If never, a permission dialog mid-turn stays "working" and needs a fallback.)
