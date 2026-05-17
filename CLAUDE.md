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

## Trade-mode policy (v6 — post-90d-OOS research)

The 200× ICT auto-scalp loop is **closed**. 90d Binance/MEXC OOS
backtests across SOL/BTC/ETH/SILVER at 200×/100×/50×/25×/10× found
**zero** positive-EV configs on >100 fills. Forward-bias diagnostic
confirmed crypto ICT signals are statistically indistinguishable from
random (delta-mean −0.018% to +0.009%). SILVER had a real signal
(+0.11–0.16% at 1–4h horizons) but trade machinery friction ate it.
The artifacts live at `tests/backtest-scalp.mjs` + `tests/forward-bias.mjs`
— don't re-litigate without re-running them.

Resulting policy:

- **US100**: ICT manual trade-call (already wired). Session-driven, this
  is where ICT was designed to work. Unchanged.
- **GOLD + SILVER**: ICT manual trade-call. 10–25× when fired (no auto-
  fire). Treat like US100 — session-driven, eyes on the setup.
- **SOL + BTC + ETH + BNB + XRP + SUI + ASTR**: Spot Watch only. HTF
  buy/sell zones, accumulate low, distribute high. No leverage, no
  scalp. ICT doesn't apply to 24/7 assets with no session structure.
- **Auto-fire**: globally disabled. `_scalpAutoFireEnabled = false`.
  Signal generation, FIRE STATUS badges, force-fire button, and the
  kill-switch UI all stay live (useful as manual-eyes inputs). Tests
  opt in via `setScalpAutoFire(true)`.
- **Leverage**: floor 10×, cap 25× universally. Dropdown ladder is
  `[10, 15, 20, 25]`. Default per-asset is 10×. Margin sizing is a
  separate concern (decided later). The old high-leverage survival /
  trailing-TP / hold-time-kill machinery is deleted — all orders now
  ship plain LIMIT (type=1) with a structural SL.
- One-at-a-time gate + 60s per-asset cooldown remain on the force-fire
  path so the user can't accidentally double-fire by mashing buttons.

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
- Auto-exec pipeline: `scalpMonitorTick` → `_suggestedEntryForTf` →
  `_highLevLevels` → `placeMexcFuturesOrder`. 5-min cooldown per asset.
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
