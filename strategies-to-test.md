# strategies-to-test.md

Strategies to FOLLOW (test + track outcomes by Name) for the AZC Platform.
Every block is extracted from this repo's real strategy/ICT code — nothing invented.
Source modules cited per block. All timestamps are unix-ms; fixture bars are flat
JSON arrays of `{t,o,h,l,c,v}` (verified schema).

Fixture root: `/root/apps/ict-autopilot/tests/fixtures/`

## Provenance map (where each idea comes from)

| Strategy family | Repo source |
|---|---|
| US100 ICT (sweep → FVG → MSS) | `index.html` "7 Confirmation Triggers (v5)" + ICT method cards (FVG/OB/CHoCH/MSS/BSL-SSL/Judas/Dealing-Range/Kill-Zone) + `detectUnmitigatedFvg` / `htfBias` in `trader-signal.mjs` + `trader-killzones.mjs` |
| Crypto FVG-retest (production AZC) | `trader-signal.mjs` (`detectUnmitigatedFvg`, `buildSetup`, `checkPostOnlyTtlFill`) + `trader-config.mjs` constants + `trader-fire-decision.mjs` gates |
| 4h trend Donchian + chandelier trail | `strategy-trend-trail.mjs` (`decideStep`, `efficiencyRatio`, `STRATEGY_PARAMS`) |
| 4h mean-rev fade Donchian | `strategy-meanrev.mjs` (`meanRevSignal`, `buildMeanRevLevels`, `MR_PARAMS`) |

## Summary table

| Name | Asset / symbol | TF | Hypothesis (1-line) |
|---|---|---|---|
| us100-ict-sweep-fvg-mss-v1 | NQ=F (US100 futures) | 5m | ICT: in-killzone liquidity sweep → unmitigated FVG → displacement MSS in HTF-bias direction, enter FVG-mid retest for ≥3R. |
| us100-ict-sweep-fvg-mss-ndx-v1 | ^NDX (US100 cash) | 5m | Same ICT model on cash index (NY-session bars only) — data-source sensitivity check vs NQ=F. |
| sol-azc-fvg-retest-v1 | SOL-USD | 5m | Production AZC signal: HTF-SMA-aligned unmitigated 5m FVG, enter mid retest, RR 1.8 — control to re-confirm the fee-wall. |
| xrp-azc-fvg-retest-v1 | XRP-USD | 5m | Same production AZC FVG signal on XRP. |
| doge-trend-donchian-trail-v1 | DOGE-USD | 4h | 4h Donchian-30 breakout + chandelier ATR-trail, gated by Kaufman ER≥0.35; trend-follow, let winners run. |
| sol-trend-donchian-trail-v1 | SOL-USD | 4h | Same 4h trend-trail on SOL. |
| xrp-trend-donchian-trail-v1 | XRP-USD | 4h | Same 4h trend-trail on XRP. |
| sol-meanrev-fade-donchian-v1 | SOL-USD | 4h | Fade 4h Donchian-30 extremes back to the mean, fixed RR 1.2, ~1 trade/sym/week. |
| xrp-meanrev-fade-donchian-v1 | XRP-USD | 4h | Same 4h mean-rev fade on XRP. |
| ada-meanrev-fade-donchian-v1 | ADA-USD | 4h | Same 4h mean-rev fade on ADA. |
| ltc-meanrev-fade-donchian-v1 | LTC-USD | 4h | Same 4h mean-rev fade on LTC — the one symbol the 5y study flagged trend-poison / mean-rev-positive; isolate it. |

---

## PART 2 — US100 ICT model

### Repo's actual US100 ICT model (decision-support, manual)

Source: `index.html` Rules tab "7 Confirmation Triggers (v5)" + the ICT method cards,
with FVG/HTF-bias math reused from `trader-signal.mjs`. The 7 triggers are:

1. HTF bias confirmed (Monthly+Weekly+Daily aligned)
2. Price in deep Q1 (long) / Q4 (short) of the HTF dealing range (premium/discount)
3. Key liquidity **completed** sweep — BSL or SSL actually taken, not anticipated
4. FVG or OB formed on 1m–5m **after** the sweep
5. **1m CHoCH or MSS in setup direction — NON-NEGOTIABLE**
6. ICT Macro / Silver Bullet kill-zone window active
7. R:R ≥ 1:3 to nearest HTF liquidity target

Kill zones as stated in the repo (timezone = **GST / Dubai = UTC+4**), converted to UTC:

| Window | GST | UTC |
|---|---|---|
| London KZ | 08:00–10:00 | 04:00–06:00 |
| NY AM KZ | 13:00–15:00 | 09:00–11:00 |
| ICT Macro AM | 18:50 | 14:50 |
| Dead zone (no trades) | 19:00–22:00 | 15:00–18:00 |
| Silver Bullet PM | 22:50–23:10 | 18:50–19:10 |
| Hard cutoff | 23:30 | 19:30 |

**Backtest honesty / data caveats (read before implementing):**
- Trigger 5 (1m CHoCH) is non-negotiable in the live model but **cannot be backtested
  on Yahoo** — Yahoo retains ~7 days of 1m and ~60 days of 5m. The block below sets
  TF=5m / 60-day history and replaces the 1m-CHoCH with a **5m displacement-close MSS
  proxy** (a candle closing beyond the prior swing in the setup direction). State this
  in results; it is an approximation, not the live A+ trigger.
- The repo's GST-anchored kill-zone windows were authored for the 24h **FPMARKETS:US100
  CFD**, not a US cash index. For **NQ=F** the real displacement clusters in the US cash
  session (≈13:30–16:00 UTC). `killzones_utc` is therefore a **parameter** — test the
  repo's converted windows AND a standard NY-AM set, report which carries the edge.
- **^NDX only prints during US regular hours** (13:30–20:00 UTC) so London/Silver-Bullet
  windows are absent in its data; that is why NQ=F is the primary symbol and ^NDX is a
  variant. US100 price in this repo must come from futures, never cash (`^NDX` ≈ −3k vs
  NQ) — the ^NDX block exists only to measure data-source sensitivity, not for live use.

---

## STRATEGY TEST REQUESTS

    STRATEGY TEST REQUEST
    Name:             us100-ict-sweep-fvg-mss-v1
    Asset / symbol:   NQ=F  (Nasdaq-100 futures, US100)
    Data provider:    yahoo
    Timeframe:        5m
    History:          60 days (Yahoo intraday retention limit — say so in results)
    Hypothesis:       During an active kill zone, after a completed liquidity sweep
                      (prior N-bar swing high/low taken then reclaimed), an unmitigated
                      5m FVG forms in the HTF-bias direction and price is in premium
                      (short) / discount (long); a displacement MSS confirms; entering at
                      the FVG mid retest with stop beyond the sweep extreme yields ≥3R to
                      the next opposing liquidity pool.
    Entry / exit:     build_signals(df, params) -> position in [-1,1]:
                      1. HTF bias = sign(close - SMA(close, htf_sma)) on an htf_resample
                         of the 5m bars (htf_sma default 20, htf_resample default 12 -> 1h).
                      2. Dealing range over range_lookback bars; long only if price in
                         lower quartile (Q1/discount), short only if upper quartile
                         (Q4/premium). (index.html Dealing-Range card)
                      3. Sweep: a bar makes a new sweep_lookback-bar low then closes back
                         above that prior low (bullish SSL sweep) — or new high then closes
                         back below (bearish BSL sweep). (BSL/SSL + Judas cards)
                      4. FVG after sweep: detectUnmitigatedFvg() 3-bar gap (bar[i-2].h <
                         bar[i].l = bull; bar[i-2].l > bar[i].h = bear), unmitigated = mid
                         not yet traded through, in the bias+sweep direction, body/price
                         >= fvg_min_body_pct. (trader-signal.mjs)
                      5. MSS proxy: a displacement candle closing beyond the prior swing in
                         setup direction (replaces the live 1m CHoCH — note in results).
                      6. Kill-zone gate: bar time-of-day in killzones_utc.
                      Entry: long/short at FVG mid (fvg.mid) on retest within ttl_bars; else
                      cancel. Stop: beyond the sweep extreme (sweep low for long / high for
                      short). Target: rr * stop_distance. Exit on stop, target, or session
                      cutoff (19:30 UTC). Position = +1/-1 while open, 0 otherwise.
    Direction:        both
    Parameters:       sweep_lookback [10,20,40]; range_lookback [40,80,120];
                      fvg_min_body_pct [0.0005,0.001,0.0015]; htf_sma [20,50];
                      htf_resample [12 (1h),48 (4h)]; rr [2,3]; ttl_bars [3,6,12];
                      killzones_utc {repo-GST-converted | NY-AM 13:30-16:00}.
    Fees:             7 bps per side (futures ~ index; both legs taker)
    Constraints:      session window via killzones_utc; min trades >= 30 to report;
                      drop result if 1m-CHoCH proxy note is omitted.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds out-of-sample.

    STRATEGY TEST REQUEST
    Name:             us100-ict-sweep-fvg-mss-ndx-v1
    Asset / symbol:   ^NDX  (Nasdaq-100 cash index, US100)
    Data provider:    yahoo
    Timeframe:        5m
    History:          60 days (NY regular-hours bars only, 13:30-20:00 UTC)
    Hypothesis:       Identical ICT sweep->FVG->MSS model as v1, on the cash index, to
                      measure data-source sensitivity (cash prints NY session only; no
                      London/Silver-Bullet windows). Expected weaker/sparser than NQ=F.
    Entry / exit:     Same build_signals as us100-ict-sweep-fvg-mss-v1.
    Direction:        both
    Parameters:       Same grid as v1, but killzones_utc forced to the NY-AM set
                      (cash has no other sessions).
    Fees:             7 bps per side
    Constraints:      min trades >= 20 (fewer bars available); NY session only.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds out-of-sample.

    STRATEGY TEST REQUEST
    Name:             sol-azc-fvg-retest-v1
    Asset / symbol:   SOL-USD  (local: tests/fixtures/SOL-365d-Min5.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/SOL-365d-Min5.json)
    Timeframe:        5m   (HTF bias from a 60m resample, per=12)
    History:          365 days
    Hypothesis:       The literal production AZC signal: an unmitigated 5m FVG aligned
                      with a 60m SMA-20 bias, entered at the FVG mid, RR 1.8. Tracked as a
                      CONTROL to re-confirm the known fee-wall — gross edge is faint and
                      net edge died after real MEXC taker fees; we want to verify that
                      finding still holds, not to fund it.
    Entry / exit:     build_signals(df, params) per trader-signal.mjs buildSetup():
                      bias = sign(close - SMA(60m_resample, htf_sma=20)); FVG via
                      detectUnmitigatedFvg on 5m; require fvg.dir == bias.dir;
                      fvg.body/price >= min_fvg_body_pct (0.0015); |price-mid|/mid <=
                      touch_tolerance_pct (0.0008). Entry = fvg.mid. SL = farEdge +/-
                      body*fvg_buffer_pct (0.10), floored so stop_dist/price >=
                      min_stop_pct (0.0020). TP = entry +/- stop_dist*RR (1.8). Fill model:
                      POST_ONLY-style — only fills if price touches mid within ttl_bars
                      (checkPostOnlyTtlFill). Exit on SL/TP. Position +1/-1 while open.
    Direction:        both
    Parameters:       rr [1.5,1.8,2.0]; min_fvg_body_pct [0.001,0.0015,0.002];
                      touch_tolerance_pct [0.0008,0.0015]; min_stop_pct [0.002,0.005];
                      fvg_buffer_pct [0.10]; htf_sma [20]; ttl_bars [3,6,12].
    Fees:             7.5 bps per side (trader-config FEE_TAKER_RATE 0.00075; both legs
                      taker = worst case. Also report a maker-entry/taker-close variant.)
    Constraints:      fee-drag gate: skip setups whose close fee > 0.15R (FEE_DRAG_MAX_R);
                      min trades >= 100.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS. Prior expectation: FAILS
                      net of fees — flag clearly if it unexpectedly clears the bar.

    STRATEGY TEST REQUEST
    Name:             xrp-azc-fvg-retest-v1
    Asset / symbol:   XRP-USD  (local: tests/fixtures/XRP-365d-Min5.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/XRP-365d-Min5.json)
    Timeframe:        5m   (HTF bias from a 60m resample, per=12)
    History:          365 days
    Hypothesis:       Same production AZC FVG-retest control on XRP (the other live symbol).
    Entry / exit:     Same build_signals as sol-azc-fvg-retest-v1.
    Direction:        both
    Parameters:       Same grid as sol-azc-fvg-retest-v1.
    Fees:             7.5 bps per side (both-leg taker; also report maker-entry variant)
    Constraints:      fee-drag gate 0.15R; min trades >= 100.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

    STRATEGY TEST REQUEST
    Name:             doge-trend-donchian-trail-v1
    Asset / symbol:   DOGE-USD  (local: tests/fixtures/DOGE-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/DOGE-1825d-Min60.json)
    Timeframe:        4h   (resample the 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       A 4h close breaking the prior 30-bar Donchian channel, only when the
                      market is trending (Kaufman ER>=0.35), entered as continuation with a
                      chandelier ATR trail, captures durable crypto trend. This is the only
                      config that survived 3y multi-regime walk-forward net of real fees.
    Entry / exit:     build_signals per strategy-trend-trail.mjs decideStep():
                      ENTRY: if close > max(high, last `don`=30 bars) -> long; if close <
                      min(low, 30) -> short; gated by efficiencyRatio(regimeN=20) >= erMin
                      (0.35), else flat. Initial stop = entry -/+ atrMult(2)*ATR(14) (=1R).
                      MANAGE: chandelier trail = high/low-water-mark -/+ trail(3)*ATR-at-
                      entry; stop = max(initialStop, hwm - trailDist) for long. EXIT: trail
                      stop only, no fixed TP (taker close). Position +1 long / -1 short
                      while open, 0 flat. Evaluate stop on PRIOR hwm/lwm then update (no
                      lookahead).
    Direction:        both
    Parameters:       don [20,30,40]; atr_n [14]; atr_mult [2]; trail [2,3,4];
                      regime_n [20]; er_min [0.25,0.35,0.40].
    Fees:             6 bps per side taker (STRATEGY_PARAMS.takerRate 0.0006) + 10 bps
                      slippage per leg (slipBps) — model both legs.
    Constraints:      risk 0.5%/trade; report max drawdown (er_min ~halves DD 39%->23%).
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS. NOTE: repo's own 5y/all-
                      taker study put production trend at +0.048-0.074R but Newey-West
                      net t_HAC < 1.2 (NOT significant) — this run is the re-test of that.

    STRATEGY TEST REQUEST
    Name:             sol-trend-donchian-trail-v1
    Asset / symbol:   SOL-USD  (local: tests/fixtures/SOL-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/SOL-1825d-Min60.json)
    Timeframe:        4h   (resample 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       Same 4h Donchian-breakout + chandelier-trail trend model on SOL — one
                      of the three production-basket symbols.
    Entry / exit:     Same build_signals as doge-trend-donchian-trail-v1.
    Direction:        both
    Parameters:       Same grid as doge-trend-donchian-trail-v1.
    Fees:             6 bps/side taker + 10 bps slippage/leg
    Constraints:      risk 0.5%/trade; report max DD.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

    STRATEGY TEST REQUEST
    Name:             xrp-trend-donchian-trail-v1
    Asset / symbol:   XRP-USD  (local: tests/fixtures/XRP-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/XRP-1825d-Min60.json)
    Timeframe:        4h   (resample 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       Same 4h trend-trail model on XRP — third production-basket symbol.
    Entry / exit:     Same build_signals as doge-trend-donchian-trail-v1.
    Direction:        both
    Parameters:       Same grid as doge-trend-donchian-trail-v1.
    Fees:             6 bps/side taker + 10 bps slippage/leg
    Constraints:      risk 0.5%/trade; report max DD.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

    STRATEGY TEST REQUEST
    Name:             sol-meanrev-fade-donchian-v1
    Asset / symbol:   SOL-USD  (local: tests/fixtures/SOL-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/SOL-1825d-Min60.json)
    Timeframe:        4h   (resample 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       Fading 4h Donchian-30 extremes back toward the mean (close above the
                      30-bar high -> short; below the 30-bar low -> long) with a fixed RR
                      1.2 captures a fee-surviving edge because it fires only ~1x/sym/week.
                      Repo 365d anchored WF: +0.090R/trade OOS at real maker/taker.
    Entry / exit:     build_signals per strategy-meanrev.mjs meanRevSignal():
                      on last closed 4h bar, hh=max(high last don=30), ll=min(low last 30),
                      a=ATR(14). If close > hh -> dir SHORT (fade); if close < ll -> dir
                      LONG (fade). risk = atr_mult(2)*ATR. Entry = next-bar open (live: fill
                      price). Stop = entry -/+ risk. TP = entry +/- rr(1.2)*risk
                      (buildMeanRevLevels). Exit on stop/TP. Position +1 long / -1 short.
    Direction:        both
    Parameters:       don [20,30,40]; atr_mult [1.5,2,2.5]; rr [1.0,1.2,1.5]; atr_n [14];
                      fade [true].
    Fees:             7 bps per side (both-leg; also report all-taker worst case +0.060R).
    Constraints:      min trades >= 50; expect low trade count (~1/week/symbol).
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

    STRATEGY TEST REQUEST
    Name:             xrp-meanrev-fade-donchian-v1
    Asset / symbol:   XRP-USD  (local: tests/fixtures/XRP-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/XRP-1825d-Min60.json)
    Timeframe:        4h   (resample 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       Same 4h Donchian-fade mean-rev model on XRP.
    Entry / exit:     Same build_signals as sol-meanrev-fade-donchian-v1.
    Direction:        both
    Parameters:       Same grid as sol-meanrev-fade-donchian-v1.
    Fees:             7 bps per side
    Constraints:      min trades >= 50.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

    STRATEGY TEST REQUEST
    Name:             ada-meanrev-fade-donchian-v1
    Asset / symbol:   ADA-USD  (local: tests/fixtures/ADA-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/ADA-1825d-Min60.json)
    Timeframe:        4h   (resample 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       Same 4h Donchian-fade mean-rev model on ADA (repo WF reported 8/10
                      symbols positive; ADA included to widen the cross-section).
    Entry / exit:     Same build_signals as sol-meanrev-fade-donchian-v1.
    Direction:        both
    Parameters:       Same grid as sol-meanrev-fade-donchian-v1.
    Fees:             7 bps per side
    Constraints:      min trades >= 50.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

    STRATEGY TEST REQUEST
    Name:             ltc-meanrev-fade-donchian-v1
    Asset / symbol:   LTC-USD  (local: tests/fixtures/LTC-1825d-Min60.json)
    Data provider:    local_file  (file: /root/apps/ict-autopilot/tests/fixtures/LTC-1825d-Min60.json)
    Timeframe:        4h   (resample 60m fixture, per=4)
    History:          5 years (1825d)
    Hypothesis:       Same 4h Donchian-fade model on LTC specifically — the repo's 5y study
                      flagged LTC as trend-POISON yet the only mean-rev-positive symbol, so
                      isolate it to confirm whether mean-rev carries LTC where trend fails.
    Entry / exit:     Same build_signals as sol-meanrev-fade-donchian-v1.
    Direction:        both
    Parameters:       Same grid as sol-meanrev-fade-donchian-v1.
    Fees:             7 bps per side
    Constraints:      min trades >= 50.
    Success criteria: real (|t| >= 2, p < 0.05) AND holds OOS.

---

## Counts

- **11 strategy test requests** across **6 assets**:
  - US100 (NQ=F + ^NDX): 2 — ICT sweep→FVG→MSS
  - SOL: 3 — FVG-retest control, trend-trail, mean-rev
  - XRP: 3 — FVG-retest control, trend-trail, mean-rev
  - DOGE: 1 — trend-trail
  - ADA: 1 — mean-rev
  - LTC: 1 — mean-rev
- By family: ICT US100 ×2, AZC FVG-retest ×2, 4h trend-trail ×3, 4h mean-rev ×4.
- Data: 2 yahoo (US100 intraday, 60d), 9 local_file fixtures (365d 5m / 1825d 60m→4h).
