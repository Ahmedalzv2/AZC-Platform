# Claude — repo-specific skill operating notes

These are patterns learned the hard way during sessions; they override
the built-in skill defaults when the two conflict. Loaded on demand from
CLAUDE.md instead of inline so the per-turn context stays small.

## `/loop`

- **ScheduleWakeup is often unavailable** in this environment. Probe with
  `ToolSearch query="select:ScheduleWakeup"` once. If absent, the loop
  collapses to "iterate inline until natural stopping point, then stop."
  Don't pretend you'll wake up later.
- **Most `/loop` invocations here are CPU-bound** — backtest sweeps,
  parameter searches, walk-forward validation. Default mode is: list the
  iterations you plan, execute them all in this turn (parallel via
  `run_in_background` when independent), commit after each meaningful
  iteration so progress is durable, stop when a leader emerges or returns
  diminish. Skip the ScheduleWakeup dance.
- **Save progress after each iteration.** Long sweeps (12+ iterations
  happened on the SW methodology search) need git commits per checkpoint
  — never let one bash crash lose 30 minutes of compute. Each `git commit
  -m "iter N: …"` is cheap insurance.
- **Stop conditions** (any one is enough): a clear leader appears with
  IS/OOS both positive, three iterations in a row don't move the leader,
  or the search space is exhausted. Don't keep iterating just because the
  skill suggests you could.
- **Don't stop on the first leader if the user said "find the best"** —
  the user's "/loop … find the best" phrasing in this repo always means
  exhaust the sensible parameter cube (assets × TFs × SL/TP × filters)
  before declaring a winner. Stopping after one promising config and
  asking is wrong — keep going until durability tests fail to surface a
  better cell across 3+ iterations.
- **Clarify only on irreducible ambiguity.** If the prompt is "/loop run
  tests on SILVER" — just run. If it's "/loop find the best" with no
  asset specified — ask once (cheap) before burning compute on the wrong
  axis. Default to running, not asking.
- **Compact intermediate reports.** Per-iteration: one line — "iter N:
  best cell so far = X · OOS exp = Y". Save the table for the final
  verdict only. Tables in every iteration drown the signal.

## `/compact` + skill-usage auto-improvement

- `.claude/hooks/skill-usage.sh` logs every skill invocation to
  `/tmp/claude-skill-usage.log` on Stop (which includes /compact). On
  /start, **always** check that log for skills used in recent sessions
  and review whether the operating notes here need updating based on the
  most recent friction. The log is the trigger; this section is where
  the durable improvements land.
