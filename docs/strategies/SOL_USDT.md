# SOL_USDT

**Status:** whitelisted
**Last reviewed:** 2026-05-27
**Source of truth for execution:** `azc-trader.mjs` SYMBOLS array + `trader-config.mjs` knobs (currently global, no per-asset override)

## Strategy

5m FVG retest, HTF-1h trend-filtered. Detect the last unmitigated 5m fair-value gap, wait for price to retrace to its mid, fire in the gap's direction. Stop sits beyond the far edge of the FVG plus a `FVG_BUFFER_PCT`-of-body buffer (with a `MIN_STOP_PCT` floor). Take-profit at `RR × stopDist`. Order is POST_ONLY maker — entries that don't fill within `MAKER_ORDER_TTL_MS` (180s) are cancelled rather than chased into a taker.

## Knobs in use

| Knob | Value | Source | Per-asset override? |
|---|---|---|---|
| RR | 1.8 | `trader-config.mjs` | no — global |
| MAX_HOLD_MS | 120 min | `trader-config.mjs` | no — global |
| COOLDOWN_MS | 15 min | `trader-config.mjs` | no — global |
| FVG_BUFFER_PCT | 0.10 | `trader-config.mjs` | no — global |
| TOUCH_TOLERANCE_PCT | 0.0008 | `trader-config.mjs` | no — global |
| MIN_FVG_BODY_PCT | 0.0015 | `trader-config.mjs` | no — global |
| MIN_STOP_PCT | 0.0020 | `trader-config.mjs` | no — global |
| HTF_MIN | 60 (1h) | `trader-config.mjs` | no — global |
| HTF_SMA | 20 | `trader-config.mjs` | no — global |
| RISK_PCT (default / top2 / best) | 2% / 3% / 5% | `trader-config.mjs` | no — global |
| LEVERAGE | 10× isolated | `azc-trader.mjs` | no — global |

## Backtest evidence (365d realistic-TTL)

- Run: `node tests/backtest-azc-trader.mjs --days=365 --assets=SOL,XRP` on 2026-05-27
- Trades: **201**
- Win rate: **37.3%** (BE breakeven at RR=1.8 is 35.7%)
- R/trade: **+0.073R** (after fees)
- Net $ on $50: **+$8.31** over 365 days
- TTL cancels (would-have-fired but maker order timed out): rolled into the 222 aggregate
- Side split for the SOL+XRP aggregate is `LONG +0.050R/trade · SHORT +0.144R/trade` — SHORT carries most of the edge

The realistic-TTL gate is bar-granular and over-counts fills by ~17-19% vs the 1m diagnostic, so the truthful live projection is closer to **~+0.060R/trade · ~+$6/year**. Still net-positive, but a small edge.

## Why this strategy for this asset

SOL has reliable 5m structure in killzone windows and trends cleanly enough that an unmitigated FVG mid acts as real liquidity rather than noise. The HTF-1h SMA filter keeps the bot from fighting an obvious daily trend, which on SOL pays — the regime is rarely choppy enough to invalidate the bias. The mechanical SL-far-edge-of-gap rule survives SOL's wick density because the buffer is proportional to FVG body size, not a fixed tick count.

What would change the strategy: a sustained drop in winrate below 33% over 30+ live trades, OR a regime where 5m FVGs stop being respected (visible as `lastScanSummary` showing many candidates but few fires resolving). Either would push us to either widen FVG body filter (more selective) or swap to an MSS-based setup.

## Live status

- Live trades since the #221 stop-verify fix (2026-05-26 15:43 UTC): minimal sample — gate excludes 17 pre-fix trades from the drift sample
- Live R/trade vs backtest: insufficient sample to compare
- Drift gate state (boot): LONG=enabled, SHORT=enabled (both below `SIDE_GATE_MIN_SAMPLE`)
- Resolved trades: `trade-learnings/{wins,losses,be}/*SOL*.md`

## Change history

- **2026-05-27** — file created. Documents the global config currently shipping (`trader-config.mjs` defaults). No behaviour change.
