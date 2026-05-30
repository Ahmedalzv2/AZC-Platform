# strategies-tested-results.md

Results for the 11 requests in [`strategies-to-test.md`](./strategies-to-test.md),
run through the backtest-lab tester (fee-accurate, IS/OOS walk-forward) on
2026-05-30. Tracked by Name.

**Bottom line: 0 of 11 cleared the bar (real = |t|≥2, p<0.05, AND holds OOS).**
Every pre-registered expectation was confirmed. Nothing was promoted to the
gallant showcase. The tester also caught one in-sample mirage (LTC mean-rev).

Method: 4h trend/mean-rev ran on the tester's fee-accurate bracket engines
(`azc_trend` / `azc_meanrev`, the repo-parity strategies) over the 1825d 60m
fixtures resampled to 4h. The 5m FVG-retest and US100 ICT ran as causal
`custom_python` `build_signals` (no lookahead; trade lifecycle simulated bar by
bar). Significance is one-sided for a *positive* edge, so a negative/zero edge
reports p≈1.0.

## Verdict table

| Name | Verdict | Trades | Ret% | full t | OOS t | Holds OOS | Matches prior |
|---|---|---|---|---|---|---|---|
| doge-trend-donchian-trail-v1 | NOT SIGNIFICANT | 190 | −0.4 | −0.00 | 1.47 | no | yes (t_HAC<1.2) |
| sol-trend-donchian-trail-v1 | NOT SIGNIFICANT | 196 | +4.0 | 0.42 | 0.39 | no | yes |
| xrp-trend-donchian-trail-v1 | NOT SIGNIFICANT | 195 | +1.5 | 0.19 | 0.03 | no | yes |
| sol-meanrev-fade-donchian-v1 | DEAD | 358 | −19.5 | −2.01 | −1.54 | no | yes |
| xrp-meanrev-fade-donchian-v1 | DEAD | 313 | −9.2 | −0.95 | −0.72 | no | yes |
| ada-meanrev-fade-donchian-v1 | DEAD | 358 | −9.0 | −1.01 | −0.14 | no | yes |
| ltc-meanrev-fade-donchian-v1 | IS-ONLY (fails OOS) | 332 | +20.7 | **2.10 (p=.03)** | 1.06 | no | yes (the outlier) |
| sol-azc-fvg-retest-v1 | FEE-DEAD | 954 | gross +20.6 / net −71 | gross t=1.33 | −3.56 | no | yes (fee-wall) |
| xrp-azc-fvg-retest-v1 | FEE-DEAD | 815 | gross +0.4 / net −70 | gross t=0.10 | −5.50 | no | yes (fee-wall) |
| us100-ict-sweep-fvg-mss-v1 | DATA-LIMITED | 0–1 | — | — | — | n/a | untestable on Yahoo |
| us100-ict-sweep-fvg-mss-ndx-v1 | DATA-LIMITED | 0 | — | — | — | n/a | untestable on Yahoo |

## Notes per family

**4h trend Donchian + chandelier trail (DOGE/SOL/XRP, 5y, canonical don=30, ER≥0.35,
6 bps taker + 10 bps slip).** All three not statistically significant in-sample and
none hold out-of-sample. Re-confirms the repo's 5y/all-taker finding (production
trend +0.048–0.074R but Newey-West net t_HAC<1.2). Not a real edge.

**4h mean-rev fade Donchian (SOL/XRP/ADA, 5y, canonical don=30/RR=1.2, 7 bps).**
Net-negative and not significant. Dead.

**LTC mean-rev — the in-sample mirage.** LTC alone looks real in-sample: +20.7%,
**t=2.10 (p=0.032)**, low drawdown −5.6%. But out-of-sample it collapses to t=1.06
and does not hold. This is exactly what the OOS gate exists to catch: the repo's
"LTC mean-rev-positive outlier" is an in-sample artifact, **not bankable**.

**AZC 5m FVG-retest (SOL/XRP, 365d, production signal, 7.5 bps taker).** FEE-DEAD,
independently re-confirmed. SOL has a faint gross edge (+20.6%, t=1.33 — not even
significant before fees) annihilated to −71% net; even at an optimistic 3.75 bps
maker model it is −35% IS / −8.8% OOS. XRP has essentially zero gross edge. Neither
clears the bar in any config or fee model.

**US100 ICT sweep→FVG→MSS (NQ=F, ^NDX).** DATA-LIMITED — not a tuning miss, a data
problem. Yahoo retains ~60 days of 5m, and the full confluence (HTF bias →
discount/premium quartile → completed sweep → unmitigated FVG → displacement MSS →
kill-zone → FVG-mid retest) yields **0–1 trades** in that window for NQ=F (floor
≥30) and 0 for ^NDX. Two compounding bottlenecks: the discount/premium quartile gate
makes an in-zone sweep rare, and after a displacement candle price seldom returns to
the FVG mid inside the kill-zone TTL. Both repo-GST and standard NY-AM kill-zone sets
produced 0 trades, so neither could be compared.

Caveats (as flagged in the request doc, held to honestly):
- The live model's non-negotiable **1m CHoCH** trigger is unrecoverable from Yahoo
  5m; a **5m displacement-close MSS proxy** was substituted. Results approximate the
  live model by construction.
- **^NDX is cash** (NY hours only, ≈−3k vs NQ=F) — included only for data-source
  sensitivity, never for live use.
- To validate the ICT model at all you need a **sub-5m, multi-year futures feed**
  (a real data vendor), not free Yahoo data.

## Promotion

None. All lab runs are saved in the tester's Browse run-store (main, by strategy
name). The gallant showcase holds **real, OOS-surviving** strategies only and
remains empty after this batch.
