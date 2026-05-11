---
description: Bootstrap a fresh Claude Code session on ict-autopilot — reads CLAUDE.md, merges green PRs, then asks what's next.
---

# Resuming work on ict-autopilot

Run these checks in order before responding to the user:

1. **Read `CLAUDE.md` at the repo root.** It has the standing operating rules (workflow, comm style, code conventions), the trade-mode policy v4 (SILVER + US100 + SOL + GOLD = futures auto-exec at user-configurable leverage 1–200×, others spot), the user's explicit YOLO acceptance for 200× testing, and the full inventory of what's already wired — so you don't rebuild anything that exists.

2. **`git log main -10 --oneline`** — see what landed recently.

3. **List open PRs** via `mcp__github__list_pull_requests`. For any PR on this branch (`claude/continue-dashboard-updates-NZF8K`) where both CI runs are green and there are no unresolved review comments, **squash-merge it** with `merge_pull_request`. Then `subscribe_pr_activity` if there are still-open PRs so CI events come through automatically.

4. **`npm test 2>&1 | tail -5`** — confirm the suite is healthy (should be 350+ tests passing in ~2s).

5. **Verify branch state**: `git status` and `git log --oneline -3` so you know what's local-only.

Then ask the user what they want to work on next.

## Reminders that override defaults

- The user has accepted the risk of running $1.20 isolated at 200× on SOL + SILVER + GOLD via MEXC perp. **Do not re-warn about leverage** — they live in High-Leverage Survival Mode (mechanical SL/TP 0.7×(100/lev)%, 1:1 R:R, Scalp 1m, 0.30% proximity gate, 5s kline fast-refresh). The kill-switch (floating button bottom-right) is the only safety surface.

- Workflow contract (already approved, don't re-confirm per PR): **test → push → wait CI green → auto-merge → present**. Skip `AskUserQuestion` for obvious choices; reserve it for material trade-offs.

- Commit messages stay tight: subject ≤ 70 chars, body ≤ 4 bullets. Single concern per PR.

- Worker URL is user-deployed at `https://mexc-cors-proxy.ahmedalzar3ooni.workers.dev`. **Do not modify `worker.js`** unless the user asks; the signing scheme (HMAC-SHA256 of `apiKey + reqTime + paramString`) is already correct.

- The MEXC API key has Contract Trade enabled and IP whitelist OFF (user confirmed). Test Connection should return `HTTP 200 · MEXC code 0`.
