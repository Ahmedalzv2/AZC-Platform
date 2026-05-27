# XRP_USDT

**Status:** whitelisted
**Last reviewed:** 2026-05-27
**Source of truth for execution:** `azc-trader.mjs` SYMBOLS array + `trader-config.mjs` knobs (currently global, no per-asset override)

## Strategy

5m FVG retest, HTF-1h trend-filtered — same setup as SOL_USDT. Detect the last unmitigated 5m fair-value gap, wait for price to retrace to its mid, fire in the gap's direction. Stop sits beyond the far edge of the FVG plus a `FVG_BUFFER_PCT`-of-body buffer (with `MIN_STOP_PCT` floor). Take-profit at `RR × stopDist`. POST_ONLY maker entries, 180s TTL.

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
- Trades: **245**
- Win rate: **38.0%** (BE breakeven at RR=1.8 is 35.7%)
- R/trade: **+0.113R** (after fees)
- Net $ on $50: **+$15.78** over 365 days — XRP carries most of the SOL+XRP aggregate edge
- TTL cancels and other realism caveats: see [SOL_USDT.md](SOL_USDT.md#backtest-evidence-365d-realistic-ttl); same gate, same caveats

XRP's R/trade is materially better than SOL's (+0.113R vs +0.073R) — most of that comes from cleaner short-side setups during periods when SOL chops sideways but XRP trends. The aggregate SHORT +0.144R/trade vs LONG +0.050R/trade is mostly an XRP-SHORT story.

## Why this strategy for this asset

XRP has the cleanest 5m FVG behaviour of the screened set — its volatility profile is rangier than SOL but with sharp directional impulses that the FVG retest is built for. The realistic-TTL gate also matters here: XRP's maker fills are faster than SOL's because of tighter spreads, so the 180s TTL clips fewer would-be fires.

What would change the strategy: a regime shift where XRP's spreads widen (e.g. low-volume weekends or US listing-status news), or a sustained period where the short side loses its asymmetric edge. Either would push us to either gate fires by spread (would need a new tick poll) or downshift risk on the underperforming side via the existing side-gate.

## Live status

- Live trades since the #221 stop-verify fix (2026-05-26 15:43 UTC): minimal sample — gate excludes 17 pre-fix trades
- Live R/trade vs backtest: insufficient sample to compare
- Drift gate state (boot): LONG=enabled, SHORT=enabled (both below `SIDE_GATE_MIN_SAMPLE`)
- Resolved trades: `trade-learnings/{wins,losses,be}/*XRP*.md`

## Change history

- **2026-05-27** — file created. Documents the global config currently shipping. No behaviour change.
