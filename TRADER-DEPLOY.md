# AZC Trader — server-side autonomous trader

`azc-trader.mjs` runs the strategy. systemd keeps it alive; the dashboard
provides the kill switch. Trader writes state to `.trader-state/state.json`
which the relay bind-mounts so the dashboard can read it.

## One-time install

```bash
# 1. Make sure /root/apps/ict-autopilot/relay.env has MEXC_API_KEY +
#    MEXC_API_SECRET filled in (already done as of 2026-05-24).

# 2. Install the systemd unit (must be root):
sudo cp /root/apps/ict-autopilot/azc-trader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now azc-trader.service

# 3. Confirm it's running:
systemctl status azc-trader --no-pager | head -20
tail -f /var/log/azc-trader.log
```

## Kill switch (from the dashboard)

Bottom-right corner of every page shows two stacked buttons:

- **AUTO** — the browser-side legacy auto-fire (we don't use this anymore)
- **TRADER** — the server-side AZC trader
  - Green "TRADER: ON · 0/3 · $0.00" → running, no position, X trades today
  - Blue "TRADER: IN-TRADE" → currently holds a position
  - Red "TRADER: STOPPED" → stop.flag is set, trader exited (systemd respects it)
  - Gray "TRADER: OFFLINE" → service not running

Click STOP → confirms → POSTs `/trader-stop` → relay touches
`.trader-state/stop.flag` → trader honors it within ≤30s (one cycle) → exits.

Click START (when stopped) → POSTs `/trader-start` → relay removes the flag
→ systemd auto-restart picks the trader back up within 10s.

## Manual kill (no UI)

```bash
sudo systemctl stop azc-trader        # immediate
# OR
touch /root/apps/ict-autopilot/.trader-state/stop.flag   # graceful (≤30s)
```

## State file

`/root/apps/ict-autopilot/.trader-state/state.json` is rewritten each cycle.
Useful fields: `tradesToday`, `dailyPnlUsd`, `pendingOrder`, `lastError`,
`cooldownUntil`, `lastCycleAt`. The relay exposes this at GET `/trader-state`.

## Learnings

Every closed position writes a markdown post-mortem under
`trade-learnings/{wins,losses,be}/YYYY-MM-DD-HHMM-SYM-SIDE.md`. The trader
itself does the write (via the same `writeLearningFile` helper the dashboard
uses), so no UI is required for the audit trail to populate.
