// Single source of truth for the AZC trader methodology constants.
//
// Both the live trader (azc-trader.mjs) and the proof harness
// (tests/backtest-azc-trader.mjs) import from here so they cannot
// silently drift. If you tune a knob, change it here and the backtest
// automatically reflects production by default.
//
// Pure data — no side effects, no env reads, safe to import from tests
// without booting the trader.

export const HTF_MIN       = 60;
export const HTF_SMA       = 20;
export const LOOKBACK_BARS = 40;

export const RR                  = 1.8;
export const MAX_HOLD_MS         = 120 * 60 * 1000;
export const COOLDOWN_MS         = 15 * 60 * 1000;

export const FVG_BUFFER_PCT      = 0.10;
export const TOUCH_TOLERANCE_PCT = 0.0008;
// Raised from 0.0010 → 0.0015 on 2026-05-26 after sweeping the realistic-
// TTL backtest (PR #231, 365d/SOL+XRP, n=446 trades):
//   0.0010 (old)  →  +0.034R/trade · +$19.81/year/$50 · 951 trades
//   0.0015 (new)  →  +0.095R/trade · +$24.09/year/$50 · 446 trades
// Halves volume but triples per-trade R and lifts WR 35.8% → 37.7%.
// The 22% net-$ improvement is real; sample healthy at 446 trades.
export const MIN_FVG_BODY_PCT    = 0.0015;
export const MIN_STOP_PCT        = 0.0020;

// Graduated risk — sizes to conviction. For the $50 micro-capital lane
// this is deliberately AGGRESSIVE experimental risk, not "tiny risk".
// $2.50 (5%) per stand-out best candidate is real exposure on a tiny
// bankroll; the safety story is the live drift-gate + position/cooldown
// controls below, not a per-trade hard cap. Documented intentionally so
// docs and code agree.
export const RISK_PCT_DEFAULT = 0.02;   // 2% base       ($1.00 @ $50)
export const RISK_PCT_TOP_2   = 0.03;   // 3% top-2 pick ($1.50 @ $50)
export const RISK_PCT_BEST    = 0.05;   // 5% stand-out  ($2.50 @ $50)

// History-based loss throttling REMOVED (2026-05-26). Operator directive:
// "execute when there is opportunity, otherwise don't enter." The
// data-driven drift gates (side + session, activate at 20+ trades, see
// SIDE_GATE_* below) replace the old 2L risk-halve / 3L killzone pause /
// 5L hard halt cascade. Per-trade risk tiering, one-position max,
// per-symbol cooldown, audit journal, and kill switch remain.

// 24/7 firing — backtest comparison showed +80% trades / +61% total R
// over 90d vs killzone-gated, at -6pp win rate. Volume wins. The
// killzone label is still recorded on every fire for post-mortem.
export const KILLZONE_GATE_ENABLED = false;

// Side-aware live drift gate. Backtest at 90d/2398 trades says both
// LONG (+0.182R/trade) and SHORT (+0.283R/trade) are net-positive, so
// the default posture is ENABLED for both. These thresholds only kick
// in if live LIVE diverges from backtest after a meaningful sample:
//
//   below SIDE_GATE_DOWNSHIFT_R  → halve risk on that side
//   below SIDE_GATE_BLOCK_R      → skip fires on that side entirely
//
// SIDE_GATE_MIN_SAMPLE guards against acting on small-sample noise.
// Lowered 2026-05-26 from 20 → 10. The 5L hard halt was removed the
// same day, so the side/session gates are now the only data-driven
// safety against a sustained-bleed direction. 10 trades is enough to
// reject the most blatant divergence (live -0.38R vs backtest +0.18R
// on the LONG side wouldn't survive past trade 10 with this band)
// while still requiring more signal than a one-bad-session streak.
export const SIDE_GATE_MIN_SAMPLE   = 10;
export const SIDE_GATE_DOWNSHIFT_R  = -0.10;
export const SIDE_GATE_BLOCK_R      = -0.30;

// Trade-history cutoff for side/session drift-gate sampling. Trades
// resolved before this timestamp are excluded from the gate's
// expectancy calculation — they happened during the stop-verify panic-
// close bug (PR #221, merged 2026-05-26T15:43:42Z) and don't represent
// the methodology's real behaviour. Without this filter, 10
// bug-contaminated LONG losses keep the LONG side gated to "blocked"
// for ~14 healthy live trades before naturally diluting. Set to 0 to
// disable the cutoff and use all history.
export const SIDE_GATE_SAMPLE_SINCE_TS = 1779810222000;  // 2026-05-26T15:43:42Z (PR #221 merge)
