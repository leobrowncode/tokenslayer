# Agent State

> This file is a compact resume point for autonomous development agents.
> Git, GitHub PRs/issues and the actual repository remain the source of truth.

## Current project status

- Completed through: v0.1.0 overlay, plus the tokens-only taskbar strip
- Current phase: taskbar strip under review
- Current objective: minimal strip on the Windows taskbar showing today's tokens for each tool in use (Cursor / Claude Code / Codex)

## Completed

- Collectors for Claude Code (JSONL transcripts plus OAuth usage API), Codex (session JSONL, rate limits) and Cursor (`state.vscdb` plus cursor.com usage API)
- Electron overlay: global bar, per-tool cards, collapsed mode, alert icon and advice panel, tray, toasts, shortcuts, config file
- Windows packaging via electron-builder (NSIS and portable), GitHub Actions workflow
- "In use" detection (`src/core/activity.ts`): running process (`tasklist` / `ps`) or activity within `activity.recentMinutes`
- Default `overlay.mode: "taskbar"`: one-line strip docked on the taskbar (`src/core/taskbar.ts` geometry), tokens only; the old UI is `overlay.mode: "panel"`

## Active work

- Issue: none
- Branch: `cursor/taskbar-strip-c7e2`
- Pull request: taskbar strip PR (draft)
- Status: review

## Important decisions

- No native modules: Cursor's SQLite DB is read with the built-in `node:sqlite` (Electron 45 ships Node 24).
- `src/core` must stay Electron-free so it can be unit-tested and run by `npm run probe`.
- Network calls are opt-out, go only to the vendor's own domain, and never refresh or modify credentials.
- The renderer CSP forbids inline style attributes; set styles through CSSOM (`el.style.setProperty`).
- A tool is only shown when its data exists (`detected`) and it is in use; the strip shows nothing else than per-tool tokens today. Alerts go through toasts and the tray icon.
- The strip is dragged by hand (pointer events + `overlay:drag` IPC), not with `-webkit-app-region: drag`, so right-click still opens the menu. Its right edge is the anchor.
- On Windows the strip re-asserts topmost every 1.5 s because clicking the taskbar raises it above other topmost windows.

## Known limitations / blockers

- Cursor's local schema and the cursor.com / Anthropic usage endpoints are undocumented. Parsers are defensive, but they have not been checked against a live account.
- Not yet run on a real Windows desktop (built and UI-tested on Linux/X11 only). Strip placement over the real taskbar and the topmost re-assert need a check on Windows 10/11.
- Claude Code installed via npm runs as `node.exe`, so it is only detected through recent activity. The Claude desktop app is also `claude.exe`; it only counts if `~/.claude/projects` exists.

## Validation baseline

```bash
npm test
npm run typecheck
npm run build
npm run dist:win:zip   # works on Linux too
```

- Tests: 33 (vitest)
- CI: `.github/workflows/build.yml`

## Next action

1. Fetch latest GitHub state and check whether the taskbar strip PR was merged or has review comments.
2. Check strip placement and z-order on a real Windows 10/11 taskbar (default `rightMargin` 360).

## Last updated

- Date: 2026-10-21
- Active PR/commit: branch `cursor/taskbar-strip-c7e2`
