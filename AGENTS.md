# AGENTS.md — operating manual for this repo

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
- **Leverage**: production cap is 25× for MEXC futures. Default per-asset
  is 10×. The UI ladder allows smaller manual values too
  (`[1, 2, 3, 5, 7, 10, 15, 20, 25]`). Legacy high-leverage survival /
  trailing-TP / hold-time-kill helpers still exist for regression tests
  and forced harness scenarios, but are unreachable from normal UI policy.
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

## Session handoff

This file is the **durable** operating manual — rules that don't change
session to session. Anything that does change (last PR shipped, current
bug under investigation, where the user left off) lives in PR
descriptions and recent commits, not here. Run `/start` at the top of a
session to bootstrap; ask the user for the current focus rather than
relying on stale notes.
