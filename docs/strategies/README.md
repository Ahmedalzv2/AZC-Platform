# Per-asset strategy notes

This folder documents the *current* operating strategy for each symbol the AZC trader is whitelisted to fire on. One markdown file per symbol, file name = MEXC contract symbol with `_` separator (e.g. `SOL_USDT.md`).

## Why this exists

Future operators (human or agent) need to be able to answer, for any given symbol:

- Which strategy is the trader actually running?
- What knob values is it using right now, and where do they come from?
- What does the backtest say the expected R/trade and net $ on $50 is?
- What's the rationale — why this strategy, why not another?
- What live evidence (post-mortem files, drift-gate state) confirms or contradicts the backtest?

Reading the per-asset file should be enough to answer those without grepping `azc-trader.mjs` or the backtest harness.

## When to update a file here

- **Strategy change** — new setup type, new knob values, regime classification flip → update the *Strategy* + *Knobs* sections, append a dated note under *Change history*.
- **Backtest refresh** — re-running `tests/backtest-azc-trader.mjs` with new fixtures → update the *Backtest evidence* section, keep prior numbers in *Change history* for diffing.
- **Live drift** — drift gate downshifts or blocks the symbol, or live R/trade departs >30% from backtest → flag in *Live status* and decide whether to re-screen.
- **Adding a new symbol** — pass the 365d realistic-TTL bar in the backtest, add a row to `SYMBOLS` in `azc-trader.mjs`, **then** create `<SYMBOL>_USDT.md` here. No file in this folder for a symbol = symbol is not whitelisted.

## File template

Use this skeleton when adding a new symbol. Keep sections in order so cross-symbol diffs are clean.

```markdown
# <SYMBOL>_USDT

**Status:** whitelisted | dropped — <reason>
**Last reviewed:** YYYY-MM-DD
**Source of truth for execution:** `azc-trader.mjs` SYMBOLS array + `trader-config.mjs` knobs (currently global, no per-asset override)

## Strategy

One paragraph: which ICT setup is firing, on what timeframe, what's the entry / SL / TP rule.

## Knobs in use

| Knob | Value | Source | Per-asset override? |
|---|---|---|---|
| RR | 1.8 | `trader-config.mjs` | no — global |
| MIN_FVG_BODY_PCT | 0.0015 | `trader-config.mjs` | no — global |
| ... | ... | ... | ... |

## Backtest evidence (365d realistic-TTL)

- Trades: N
- Win rate: X%
- R/trade: ±0.XXXR (after fees)
- Net $ on $50: ±$X.XX
- Date of run + fixture window
- Pointer to the harness invocation that produced these numbers

## Why this strategy for this asset

Plain English. What about this asset's tape suits the FVG retest? What would have to be true to switch setup type?

## Live status

- Live trades since last config change: N
- Live R/trade vs backtest: ±X.XXR delta
- Drift gate state: enabled | downshifted | blocked
- Pointer to most recent `trade-learnings/{wins,losses,be}/` files

## Change history

- **YYYY-MM-DD** — what changed and why. One line, no novella.
```

## What this folder is *not*

- **Not the execution config.** The trader reads its knobs from `trader-config.mjs`, not from these files. If you change a number here without changing the code, the live bot ignores it. (PR B in the roadmap below adds the override mechanism.)
- **Not a backtest log.** Detailed per-run numbers belong in `trade-learnings/INSIGHTS.md` and the harness JSON output. These files capture the *currently chosen* strategy and rationale, not every experiment.
- **Not a strategy textbook.** ICT theory lives in the dashboard's `index.html` info modals. These files are pragmatic: what the bot does *here*, for *this* asset, *right now*.

## Roadmap

The per-asset doc system rolls out in three PRs:

- **A — scaffolding (this PR).** Folder + README + initial files for SOL and XRP using the current global config.
- **B — per-asset config overrides.** Wire `trader-config.mjs` to accept a per-symbol overrides map. Default = global, zero behaviour change. Each `<SYMBOL>_USDT.md` gains a "per-asset override?" column that means something.
- **C — walk-forward per-asset tuning.** Only after ~30 clean live trades on the post-#221 stop-verify fix. Grid-search knobs per symbol with train/test split, populate each .md with the optimal values + train/test numbers, ship overrides.

C is gated on **live evidence**, not just backtest curve-fitting — see CLAUDE.md trade-mode policy for the rationale.
