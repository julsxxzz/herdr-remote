# Handoff — herdr-remote

## State

- v1 is built on branch `feat/v1`: server, phone web app, setup, supervisor,
  `stop` command and start-at-login task. `npm test` runs the unit tests
  against a fake `hc`.
- Design: `docs/superpowers/specs/2026-11-17-herdr-remote-design.md`.
  Plan: `docs/superpowers/plans/2026-11-17-herdr-remote.md`.

## Remaining

1. Owner end-to-end run on a real phone: `docs/e2e-checklist.md`.
2. Spec §7 risk 2: check whether Herdr reports `blocked` for Claude Code
   permission prompts. If not, add a fallback detector.
3. Latency follow-up: replies start a fresh `hc` process each time; try a
   long-lived `hc connect` session instead.
