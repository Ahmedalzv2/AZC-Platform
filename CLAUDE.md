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

## Trade-mode policy (v5 + onward)

- Auto-exec trio on MEXC perp: **SOL, SILVER, GOLD** — all default 200×
  for the ultra-trade scalp loop. Cap 200×.
- US100 stays futures-mode for trade-call signals but doesn't auto-fire
  (CFD-only, not on MEXC).
- Everything else (BTC, ETH, BNB, XRP, SUI, ASTR) = spot, buy-low /
  sell-high accumulation. No auto-exec.
- High-Leverage Survival Mode kicks in at ≥ 100×: mechanical SL/TP
  (SL = 0.7 × 100/lev %, **TP = 2× SL for 1:2 R:R**), Scalp 1m auto-
  default, HTF auto-fire skipped, 1m kline fast-refresh every 5s.
- **Ultra-trade scalp gates** on high-lev assets: proximity widened to
  **0.50%**, HTF agreement check skipped — the 1m FVG signal alone fires,
  accepting counter-bias scalps for more total trades.
- One-at-a-time gate: scalp + force-fire skip while any asset holds an
  open position. 60s per-asset cooldown post-fire.

## YOLO test is on (don't re-warn)

User is running $1.20 isolated at 200× on the trio. They've explicitly
accepted: liquidation distance ≈ 0.5%, mechanical levels, no rails.
**The kill-switch is the only safety surface.** Don't re-litigate the
risk on every fire — just ship the feature they asked for.

## Communication style

- Short responses. State results + decisions directly. No running
  commentary on internal deliberation.
- Comments in code: only WHY, never WHAT. Don't reference the current
  task or callers.
- No emojis in code unless the UI uses them (the trading dashboard does).
- "Honest answer" framing for things I can't actually verify (live
  trading state, browser-side behaviour).

## Repo-specific facts

- Tests: `npm test`. 344+ tests, ~2s. Always run before push.
- Branch: develop on `claude/continue-dashboard-updates-NZF8K`.
- Worker URL is user-deployed Cloudflare Worker proxying signed MEXC
  contract API calls. Worker code is `worker.js` at repo root.
- Worker subscribed PR-activity: when creating a PR, prefer
  `subscribe_pr_activity` over Monitor-polling — events come direct.

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
