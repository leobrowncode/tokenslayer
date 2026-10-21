# Agent State

> This file is a compact resume point for autonomous development agents.
> Git, GitHub PRs/issues and the actual repository remain the source of truth.

## Current project status

- Completed through: v0.1.0, the first working overlay
- Current phase: initial implementation under review
- Current objective: Windows overlay showing Cursor / Claude Code / Codex token usage, with compact / new-chat alerts

## Completed

- Collectors for Claude Code (JSONL transcripts plus OAuth usage API), Codex (session JSONL, rate limits) and Cursor (`state.vscdb` plus cursor.com usage API)
- Electron overlay: global bar, per-tool cards, collapsed mode, alert icon and advice panel, tray, toasts, shortcuts, config file
- Windows packaging via electron-builder (NSIS and portable), GitHub Actions workflow

## Active work

- Issue: none
- Branch: `cursor/token-usage-overlay-c063`
- Pull request: initial implementation PR (draft)
- Status: review

## Important decisions

- No native modules: Cursor's SQLite DB is read with the built-in `node:sqlite` (Electron 45 ships Node 24).
- `src/core` must stay Electron-free so it can be unit-tested and run by `npm run probe`.
- Network calls are opt-out, go only to the vendor's own domain, and never refresh or modify credentials.
- The renderer CSP forbids inline style attributes; set styles through CSSOM (`el.style.setProperty`).

## Known limitations / blockers

- Cursor's local schema and the cursor.com / Anthropic usage endpoints are undocumented. Parsers are defensive, but they have not been checked against a live account.
- Not yet run on a real Windows desktop (built and UI-tested on Linux/X11 only).

## Validation baseline

```bash
npm test
npm run typecheck
npm run build
npm run dist:win:zip   # works on Linux too
```

- Tests: 27 (vitest)
- CI: `.github/workflows/build.yml` (unknown until first run)

## Next action

1. Fetch latest GitHub state and check whether the PR was merged or has review comments.
2. Fix any real-world schema mismatches reported for Cursor / Claude / Codex.

## Last updated

- Date: 2026-10-21
- Active PR/commit: branch `cursor/token-usage-overlay-c063`
