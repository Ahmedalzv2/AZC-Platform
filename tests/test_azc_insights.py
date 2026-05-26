import json
import tempfile
import unittest
from pathlib import Path

from tools.azc_insights import build_drift_gates, build_report, main


LOSS = """# XRP_USDT SHORT — LOSS

- Fired:    2026-05-26T17:49:34.133Z
- Grade:    top2
- Bias:     bear
- Session:  asia
- Lane:     mexc-micro-capital

## Setup
- Entry:    1.3319
- SL:       1.3345  (risk dist 0.0026)
- TP:       1.3271  (R:R 1.85:1)
- Confluences: htf-agree:bear, tier:top2, fvg-body:0.20%, fvg-dist:0.064%

## Execution
- Fill price: 1.3310
- Exit price: 1.3345
- Outcome:    LOSS
- Realised:   -0.2312 USD  -1.00R  (after fees + funding)
- Gross:      -0.1768 USD  (directional P/L only)
- Fee open:   +0.0000 USD
- Fee close:  +0.0544 USD
- Funding:    +0.0000 USD  (0 × 8h windows · held 0.2h)
"""

WIN = """# LTC_USDT SHORT — WIN

- Fired:    2026-05-26T16:52:18.837Z
- Grade:    top2
- Bias:     bear
- Session:  ny-am
- Lane:     mexc-micro-capital

## Setup
- Entry:    52.2200
- SL:       52.3200  (risk dist 0.1000)
- TP:       52.0300  (R:R 1.90:1)
- Confluences: htf-agree:bear, tier:top2, fvg-body:0.15%, fvg-dist:0.057%

## Execution
- Fill price: 52.1900
- Exit price: 52.0500
- Outcome:    WIN
- Realised:   +0.0180 USD  1.70R  (after fees + funding)
- Gross:      +0.0714 USD  (directional P/L only)
- Fee open:   +0.0000 USD
- Fee close:  +0.0534 USD
- Funding:    +0.0000 USD  (0 × 8h windows · held 0.3h)
"""


def write_sample_tree(root: Path) -> tuple[Path, Path]:
    learn = root / "trade-learnings"
    (learn / "losses").mkdir(parents=True)
    (learn / "wins").mkdir(parents=True)
    (learn / "losses" / "2026-05-26-1749-XRP_USDT-SHORT.md").write_text(LOSS)
    (learn / "wins" / "2026-05-26-1652-LTC_USDT-SHORT.md").write_text(WIN)
    state = root / ".trader-state"
    state.mkdir()
    events = [
        {"ts": 1, "kind": "scan", "scan": [{"symbol": "XRP_USDT", "skip": "htf-disagree"}, {"symbol": "BTC_USDT", "skip": "far-from-fvg"}]},
        {"ts": 2, "kind": "decision", "action": "skip", "vetoed_by": "no-candidates"},
        {"ts": 3, "kind": "scan", "scan": [{"symbol": "XRP_USDT", "skip": "htf-disagree"}]},
    ]
    (state / "trader-events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    return learn, state / "trader-events.jsonl"


class AzcInsightsTest(unittest.TestCase):
    def test_build_report_rolls_up_trades_and_skip_reasons(self):
        with tempfile.TemporaryDirectory() as tmp:
            learn, events = write_sample_tree(Path(tmp))

            report = build_report(learn, events)

            self.assertEqual(report["performance"]["trades"], 2)
            self.assertEqual(report["performance"]["wins"], 1)
            self.assertEqual(report["performance"]["losses"], 1)
            self.assertAlmostEqual(report["performance"]["net_usd"], -0.2132, places=4)
            self.assertAlmostEqual(report["performance"]["net_r"], 0.70, places=4)
            self.assertEqual(report["by_symbol"]["XRP_USDT"]["losses"], 1)
            self.assertEqual(report["by_side"]["SHORT"]["trades"], 2)
            self.assertEqual(report["by_session"]["asia"]["losses"], 1)
            self.assertEqual(report["skip_reasons"][0], {"reason": "htf-disagree", "count": 2})
            self.assertIn("Session asia is negative", report["recommendations"])

    def test_drift_gate_exporter_flags_bad_slices_for_review_only(self):
        report = {
            "generated_at": "2026-05-26T00:00:00+00:00",
            "by_side": {
                "LONG": {"trades": 6, "wins": 1, "losses": 5, "be": 0, "net_r": -4.10, "win_rate": 0.1667, "expectancy_r": -0.6833},
                "SHORT": {"trades": 4, "wins": 3, "losses": 1, "be": 0, "net_r": 2.20, "win_rate": 0.7500, "expectancy_r": 0.5500},
            },
            "by_session": {
                "asia": {"trades": 7, "wins": 1, "losses": 6, "be": 0, "net_r": -2.11, "win_rate": 0.1429, "expectancy_r": -0.3014},
                "ny-am": {"trades": 5, "wins": 3, "losses": 2, "be": 0, "net_r": 1.10, "win_rate": 0.6000, "expectancy_r": 0.2200},
            },
            "by_symbol": {
                "BTC_USDT": {"trades": 3, "wins": 0, "losses": 3, "be": 0, "net_r": -3.00, "win_rate": 0.0, "expectancy_r": -1.0},
                "LTC_USDT": {"trades": 3, "wins": 2, "losses": 1, "be": 0, "net_r": 1.20, "win_rate": 0.6667, "expectancy_r": 0.4},
            },
        }

        drift = build_drift_gates(report)

        self.assertTrue(drift["review_only"])
        self.assertEqual(drift["schema"], "azc-drift-gates/v1")
        self.assertIn("These are proposed gates only", drift["warning"])
        self.assertEqual(
            [gate["key"] for gate in drift["gates"]],
            ["side:LONG", "session:asia", "symbol:BTC_USDT"],
        )
        self.assertEqual(drift["gates"][0]["proposed_action"], "block")
        self.assertEqual(drift["gates"][1]["proposed_action"], "downshift")
        self.assertNotIn("mexc", json.dumps(drift).lower())
        self.assertNotIn("secret", json.dumps(drift).lower())

    def test_cli_writes_json_markdown_and_drift_without_exchange_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            learn, events = write_sample_tree(root)
            out_json = root / "report.json"
            out_md = root / "report.md"
            out_drift = root / "drift.json"

            exit_code = main([
                "--learn-root", str(learn),
                "--events", str(events),
                "--json-out", str(out_json),
                "--md-out", str(out_md),
                "--drift-out", str(out_drift),
            ])

            self.assertEqual(exit_code, 0)
            data = json.loads(out_json.read_text())
            drift = json.loads(out_drift.read_text())
            markdown = out_md.read_text()
            self.assertEqual(data["performance"]["trades"], 2)
            self.assertTrue(drift["review_only"])
            self.assertIn("# AZC Insights", markdown)
            self.assertIn("htf-disagree", markdown)
            self.assertNotIn("MEXC_SECRET", markdown)
            self.assertNotIn("API_KEY", markdown)
            self.assertNotIn("MEXC_SECRET", out_drift.read_text())
            self.assertNotIn("API_KEY", out_drift.read_text())


if __name__ == "__main__":
    unittest.main()
