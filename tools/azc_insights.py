from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


MONEY_RE = re.compile(r"Realised:\s*([+-]?\d+(?:\.\d+)?)\s+USD\s+([+-]?\d+(?:\.\d+)?)R", re.I)
HEADER_RE = re.compile(r"^#\s+([A-Z0-9_]+)\s+(LONG|SHORT)\s+—\s+(WIN|LOSS|BE)", re.I)
FIELD_RE = re.compile(r"^-\s*([^:]+):\s*(.*)$")


@dataclass(frozen=True)
class Trade:
    symbol: str
    side: str
    outcome: str
    fired: str | None
    grade: str
    bias: str
    session: str
    realised_usd: float
    realised_r: float
    path: str


def parse_trade(path: Path) -> Trade:
    text = path.read_text(errors="replace")
    header = HEADER_RE.search(text)
    if not header:
        raise ValueError(f"Invalid learning header: {path}")

    fields: dict[str, str] = {}
    for line in text.splitlines():
        match = FIELD_RE.match(line.strip())
        if match:
            fields[match.group(1).strip().lower()] = match.group(2).strip()

    money = MONEY_RE.search(text)
    realised_usd = float(money.group(1)) if money else 0.0
    realised_r = float(money.group(2)) if money else 0.0
    session = fields.get("session", "unknown").split()[0].strip() or "unknown"
    if session == "—":
        session = "unknown"

    return Trade(
        symbol=header.group(1).upper(),
        side=header.group(2).upper(),
        outcome=header.group(3).upper(),
        fired=fields.get("fired"),
        grade=fields.get("grade", "unknown").split()[0],
        bias=fields.get("bias", "unknown").split()[0],
        session=session,
        realised_usd=realised_usd,
        realised_r=realised_r,
        path=str(path),
    )


def load_trades(learn_root: Path) -> list[Trade]:
    trades: list[Trade] = []
    for bucket in ("wins", "losses", "be"):
        for path in sorted((learn_root / bucket).glob("*.md")):
            trades.append(parse_trade(path))
    return trades


def load_skip_reasons(events_path: Path | None) -> list[dict[str, Any]]:
    if not events_path or not events_path.exists():
        return []

    counts: Counter[str] = Counter()
    for line in events_path.read_text(errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        for item in event.get("scan") or []:
            reason = item.get("skip")
            if reason:
                counts[str(reason)] += 1
        veto = event.get("vetoed_by")
        if veto:
            counts[str(veto)] += 1
    return [{"reason": reason, "count": count} for reason, count in counts.most_common()]


def empty_stats() -> dict[str, Any]:
    return {"trades": 0, "wins": 0, "losses": 0, "be": 0, "net_usd": 0.0, "net_r": 0.0, "win_rate": 0.0, "expectancy_r": 0.0}


def add_trade(stats: dict[str, Any], trade: Trade) -> None:
    stats["trades"] += 1
    if trade.outcome == "WIN":
        stats["wins"] += 1
    elif trade.outcome == "LOSS":
        stats["losses"] += 1
    else:
        stats["be"] += 1
    stats["net_usd"] += trade.realised_usd
    stats["net_r"] += trade.realised_r


def finalize(stats: dict[str, Any]) -> dict[str, Any]:
    trades = stats["trades"]
    if trades:
        stats["win_rate"] = round(stats["wins"] / trades, 4)
        stats["expectancy_r"] = round(stats["net_r"] / trades, 4)
    stats["net_usd"] = round(stats["net_usd"], 4)
    stats["net_r"] = round(stats["net_r"], 4)
    return stats


def grouped_stats(trades: Iterable[Trade], key: str) -> dict[str, dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = defaultdict(empty_stats)
    for trade in trades:
        add_trade(groups[getattr(trade, key)], trade)
    return {name: finalize(stats) for name, stats in sorted(groups.items())}


def build_recommendations(report: dict[str, Any]) -> list[str]:
    recs: list[str] = []
    for name, stats in report["by_session"].items():
        if stats["trades"] and stats["net_r"] < 0:
            recs.append(f"Session {name} is negative")
    for name, stats in report["by_symbol"].items():
        if stats["trades"] >= 2 and stats["net_r"] < 0:
            recs.append(f"Symbol {name} is negative")
    if report["skip_reasons"]:
        top = report["skip_reasons"][0]
        recs.append(f"Top gate blocker: {top['reason']} ({top['count']} hits)")
    return recs


def build_report(learn_root: str | Path, events_path: str | Path | None = None) -> dict[str, Any]:
    learn_root = Path(learn_root)
    events = Path(events_path) if events_path else None
    trades = load_trades(learn_root)

    performance = empty_stats()
    for trade in trades:
        add_trade(performance, trade)

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {"learn_root": str(learn_root), "events": str(events) if events else None},
        "performance": finalize(performance),
        "by_symbol": grouped_stats(trades, "symbol"),
        "by_side": grouped_stats(trades, "side"),
        "by_session": grouped_stats(trades, "session"),
        "by_grade": grouped_stats(trades, "grade"),
        "skip_reasons": load_skip_reasons(events),
        "trades": [trade.__dict__ for trade in trades],
    }
    report["recommendations"] = build_recommendations(report)
    return report


def render_stats_table(groups: dict[str, dict[str, Any]]) -> str:
    if not groups:
        return "_No data._\n"
    lines = ["| Key | Trades | W | L | BE | WR | Net R | Net USD |", "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for key, stats in groups.items():
        lines.append(
            f"| {key} | {stats['trades']} | {stats['wins']} | {stats['losses']} | {stats['be']} | "
            f"{stats['win_rate']:.1%} | {stats['net_r']:+.2f} | {stats['net_usd']:+.4f} |"
        )
    return "\n".join(lines) + "\n"


def render_markdown(report: dict[str, Any]) -> str:
    perf = report["performance"]
    lines = [
        "# AZC Insights",
        "",
        f"_Generated {report['generated_at']}. Read-only analytics sidecar; does not place orders or read secrets._",
        "",
        "## Performance",
        f"- Trades: {perf['trades']} · WR {perf['win_rate']:.1%} · expectancy {perf['expectancy_r']:+.2f}R · net {perf['net_r']:+.2f}R / {perf['net_usd']:+.4f} USD",
        "",
        "## By symbol",
        render_stats_table(report["by_symbol"]),
        "## By side",
        render_stats_table(report["by_side"]),
        "## By session",
        render_stats_table(report["by_session"]),
        "## Top skip reasons",
    ]
    if report["skip_reasons"]:
        lines.extend(f"- {row['reason']}: {row['count']}" for row in report["skip_reasons"][:10])
    else:
        lines.append("_No scan events found._")
    lines.extend(["", "## Recommendations"])
    if report["recommendations"]:
        lines.extend(f"- {item}" for item in report["recommendations"])
    else:
        lines.append("- No negative slice found yet. Keep collecting data.")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only AZC trade learning analytics sidecar.")
    parser.add_argument("--learn-root", default="trade-learnings")
    parser.add_argument("--events", default=".trader-state/trader-events.jsonl")
    parser.add_argument("--json-out")
    parser.add_argument("--md-out")
    args = parser.parse_args(argv)

    report = build_report(args.learn_root, args.events)
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if args.md_out:
        Path(args.md_out).write_text(render_markdown(report))
    if not args.json_out and not args.md_out:
        print(render_markdown(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
