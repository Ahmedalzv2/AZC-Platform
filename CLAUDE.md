# CLAUDE.md — operating manual for this repo

## Workflow (default behaviour, don't re-ask)

1. **Run tests → push → wait CI green → auto-merge → present.** User
   approved this once; don't re-confirm per PR.
2. **Smaller PRs.** One concern per PR. Commit subject ≤ 70 chars, body
   ≤ 4 bullets, no novella explanations.
3. **No AskUserQuestion for obvious choices.** If a default is clearly
   right (sane fallback, security-positive, matches stated intent), just
   pick + ship. Reserve questions for material trade-offs.
4. **Batch reads.** When you'll touch a function and its callers, one
   larger Read beats 4 small ones.
5. **Skip Monitor polling when CI is short.** A single `get_check_runs`
   call after ~10s is fine; reserve Monitor for genuinely long waits.

## Trade-mode policy (v8 — US100 manual, MEXC micro-capital separate)

This repo is the AZC Platform codebase. Ahmed's public review surface is
`https://ahmedalzv2.github.io/AZC-Platform/`: news, market read, signals,
trade state, and execution reasoning. Do not turn the UI back into a
per-asset settings console.

User correction 2026-05-23: **US100/NASDAQ is manual-trigger ICT decision support.** Do not build autonomous US100 execution unless explicitly asked later.

A separate **~$50 MEXC micro-capital lane** is allowed for crypto/asset experimentation because MEXC zero-fee trading can be an edge. Keep this separate from US100.

Resulting policy:

- **US100**: manual ICT/futures prompts only. Session-driven, decision-support, Telegram/card/outcome flow. No autonomous execution.
- **MEXC crypto/assets**: guarded micro-capital experimentation only. Start dry-run, then paper/shadow, then live only behind hard safety gates.
- **Safety gates before live MEXC**: server-side secrets only, dry-run default ON, explicit live-mode arming, hard daily loss cap, one open position max, tiny fixed risk, no martingale, no revenge trading, no re-entry spam, visible kill switch, full audit journal. Do not restore a MEXC daily trade-count cap unless Ahmed explicitly asks; the loss cap is the real safety and every resolved trade feeds learning files.
- **Everything not explicitly in the MEXC test lane**: Spot Watch only. HTF buy/sell zones, accumulate low, distribute high. No leverage/scalp alerts by default.
- **Auto-fire**: live MEXC execution must be deliberately armed and protected by the safety gates above. The floating one-tap AUTO button is the intended user control for arm/disarm; avoid adding more per-asset arming controls.
- **Leverage spec / IN-POSITION gates / per-asset cooldowns** remain in code for users who manually flip an asset to futures mode via `setTradeMode(symbol, 'futures')`; nothing fires by default.

## Communication style

- Short responses. State results + decisions directly. No running
  commentary on internal deliberation.
- Comments in code: only WHY, never WHAT. Don't reference the current
  task or callers.
- No emojis in code unless the UI uses them (the trading dashboard does).
- "Honest answer" framing for things I can't actually verify (live
  trading state, browser-side behaviour).
- Simplicity first. Prefer the minimal 2-line solution over the 30-line
  "enterprise" one. If a rewrite makes the change bigger than the
  request, you've gone too far.

## Repo-specific facts

- Tests: `npm test` (fast, ~2s). Always run before push.
- Dev branch is set per-session by the harness — use whichever branch
  the session instructions name, not a branch hard-coded here.
- Worker URL is user-deployed Cloudflare Worker proxying signed MEXC
  contract API calls. Worker code is `worker.js` at repo root.
- When creating a PR, prefer `subscribe_pr_activity` over Monitor-polling
  — events come direct.

## What's already wired (don't rebuild)

- ICT Advanced Gap Theory: FVG (BISI/SIBI), iFVG, BPR, Liquidity Voids,
  NDOG, NWOG — all in `_analyzeKlines` per TF.
- Manual fire pipeline: `_onClickForceFire` → `forceFireAsset` →
  `placeMexcFuturesOrder`. Auto-fire remains wired for tests only.
- Diagnostics in the Live Trading modal: Last Connection Test, Open
  Positions panel (5s poll), Last Fire per asset, Scalp Tick Diagnostics
  (1s refresh while modal open).
- FIRE STATUS badge on Live Chart: READY / NEAR / WAITING / BLOCKED /
  IN POSITION (with live PnL) / SPOT.
- Force Fire button: bypasses proximity, fires at live price with
  mechanical SL/TP. Two surfaces — Live Chart card + per-asset block.
- Floating kill-switch (bottom-right): one-tap master STOP/START.
- Spot Watch: HTF-derived buy/sell zones for spot assets, quiet toasts
  on AT BUY / AT SELL transitions, sell-zone narrative.

## Skill-specific operating notes

These are patterns I learned the hard way during sessions; they override
the built-in skill defaults when the two conflict.

### `/loop`

- **ScheduleWakeup is often unavailable** in this environment. Probe with
  `ToolSearch query="select:ScheduleWakeup"` once. If absent, the loop
  collapses to "iterate inline until natural stopping point, then stop."
  Don't pretend you'll wake up later.
- **Most `/loop` invocations here are CPU-bound** — backtest sweeps,
  parameter searches, walk-forward validation. Default mode is: list the
  iterations you plan, execute them all in this turn (parallel via
  `run_in_background` when independent), commit after each meaningful
  iteration so progress is durable, stop when a leader emerges or returns
  diminish. Skip the ScheduleWakeup dance.
- **Save progress after each iteration.** Long sweeps (12+ iterations
  happened on the SW methodology search) need git commits per checkpoint
  — never let one bash crash lose 30 minutes of compute. Each `git commit
  -m "iter N: …"` is cheap insurance.
- **Stop conditions** (any one is enough): a clear leader appears with
  IS/OOS both positive, three iterations in a row don't move the leader,
  or the search space is exhausted. Don't keep iterating just because the
  skill suggests you could.
- **Don't stop on the first leader if the user said "find the best"** —
  the user's "/loop … find the best" phrasing in this repo always means
  exhaust the sensible parameter cube (assets × TFs × SL/TP × filters)
  before declaring a winner. Stopping after one promising config and
  asking is wrong — keep going until durability tests fail to surface a
  better cell across 3+ iterations.
- **Clarify only on irreducible ambiguity.** If the prompt is "/loop run
  tests on SILVER" — just run. If it's "/loop find the best" with no
  asset specified — ask once (cheap) before burning compute on the wrong
  axis. Default to running, not asking.
- **Compact intermediate reports.** Per-iteration: one line — "iter N:
  best cell so far = X · OOS exp = Y". Save the table for the final
  verdict only. Tables in every iteration drown the signal.

### `/compact` + skill-usage auto-improvement

- `.claude/hooks/skill-usage.sh` logs every skill invocation to
  `/tmp/claude-skill-usage.log` on Stop (which includes /compact). On
  /start, **always** check that log for skills used in recent sessions
  and review whether the operating notes here need updating based on the
  most recent friction. The log is the trigger; this section is where
  the durable improvements land.

## Session handoff

This file is the **durable** operating manual — rules that don't change
session to session. Anything that does change (last PR shipped, current
bug under investigation, where the user left off) lives in PR
descriptions and recent commits, not here. Run `/start` at the top of a
session to bootstrap; ask the user for the current focus rather than
relying on stale notes.
