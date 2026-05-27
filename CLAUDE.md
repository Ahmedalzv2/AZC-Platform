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
- **Safety gates before live MEXC**: server-side secrets only, dry-run default ON, explicit live-mode arming, one open position max, tiny/conviction-based risk, no martingale, no revenge trading, no re-entry spam, visible kill switch, full audit journal, fee/funding-aware P&L, and live drift gates for side/session degradation review. Do not restore a MEXC daily trade-count cap or fixed daily-dollar cap unless Ahmed explicitly asks; every resolved trade feeds learning files.
- **Everything not explicitly in the MEXC test lane**: Spot Watch only. HTF buy/sell zones, accumulate low, distribute high. No leverage/scalp alerts by default.
- **Auto-fire**: live MEXC execution must be deliberately armed and protected by the safety gates above. The floating one-tap AUTO button is the intended user control for arm/disarm; avoid adding more per-asset arming controls.
- **Leverage spec / IN-POSITION gates / per-asset cooldowns** remain in code for users who manually flip an asset to futures mode via `setTradeMode(symbol, 'futures')`; nothing fires by default.
- **Incident handling**: when MEXC P&L changes unexpectedly, read the actual exchange tape before blaming the bot. Separate bot trades from manual/force-fire/direct-exchange trades, distinguish frozen margin from realised loss, neutralize naked exposure first, and refuse “make it back” revenge escalation.

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

Repo-specific overrides for `/loop` and `/compact` live in
[`docs/claude-skill-notes.md`](docs/claude-skill-notes.md). Read that file
before invoking either skill in this repo — loaded on demand so the
per-turn context stays small.

## Session handoff

This file is the **durable** operating manual — rules that don't change
session to session. Anything that does change (last PR shipped, current
bug under investigation, where the user left off) lives in PR
descriptions and recent commits, not here. Run `/start` at the top of a
session to bootstrap; ask the user for the current focus rather than
relying on stale notes.
