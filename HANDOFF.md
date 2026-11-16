# Handoff — herdr-remote

Start a Claude Code session in this folder and say something like:

> Read docs/superpowers/specs/2026-11-17-herdr-remote-design.md and plan the
> build (writing-plans), then implement it.

## State

- Design approved on 2026-11-17 (decisions log: spec §5.9). No code yet.
- Live view, typing (send / keys / Tab / Enter / Esc / arrows) and sub-second
  latency were tested on a real Windows host — evidence in spec §8.
- Open source, meant for other Herdr users: one owner per install, v1 =
  Windows host + Android phone. Keep personal details out of the repo.
- The server must run on the computer where Herdr / herdr-core runs.

## Do first

1. On your tailnet (personal account), enable MagicDNS and HTTPS certificates
   in the Tailscale admin console; sign the computer and phone in to it.
2. Check whether Herdr ever reports `blocked` for Claude Code permission
   prompts (spec §7 risk 2) — it decides whether a fallback detector is needed.
