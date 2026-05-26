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
export const MIN_FVG_BODY_PCT    = 0.0010;
export const MIN_STOP_PCT        = 0.0020;

// Graduated risk — sizes to conviction. For the $50 micro-capital lane
// this is deliberately AGGRESSIVE experimental risk, not "tiny risk".
// $2.50 (5%) per stand-out best candidate is real exposure on a tiny
// bankroll; the safety story is the consecutive-loss cascade below,
// not a per-trade hard cap. Documented intentionally so docs and code
// agree.
export const RISK_PCT_DEFAULT = 0.02;   // 2% base       ($1.00 @ $50)
export const RISK_PCT_TOP_2   = 0.03;   // 3% top-2 pick ($1.50 @ $50)
export const RISK_PCT_BEST    = 0.05;   // 5% stand-out  ($2.50 @ $50)

// Cascade from soft to hard. 2L halves tier risk; 3L pauses until the
// next killzone boundary; 5L halts until UTC midnight. Win/BE resets.
export const RISK_DOWNSHIFT_AFTER_LOSSES = 2;
export const STREAK_PAUSE_AFTER_LOSSES   = 3;
export const MAX_CONSECUTIVE_LOSSES      = 5;

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
// 20 is a compromise: enough to distinguish edge from variance at the
// methodology's ~47% WR, small enough that real regime shifts trip the
// gate within a few sessions.
export const SIDE_GATE_MIN_SAMPLE   = 20;
export const SIDE_GATE_DOWNSHIFT_R  = -0.10;
export const SIDE_GATE_BLOCK_R      = -0.30;
