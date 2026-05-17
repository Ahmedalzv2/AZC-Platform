# Add superpowers plugin to project — design

**Date:** 2026-05-17
**Status:** approved, pending implementation

## Goal

Make the `superpowers@claude-plugins-official` plugin auto-load for every new Claude Code session opened on this repo, on both local Windows and Claude Code Remote.

## Why

User runs Claude Code on two environments: this local Windows laptop (plugin already globally installed) and Claude Code Remote (fresh sessions with no plugins). Currently Remote sessions start without superpowers, so skills like brainstorming, TDD, debugging, and verification-before-completion are unavailable there.

## Changes

Two files, ~5 net lines.

### `.claude/settings.json`

Add one top-level key:

```json
"enabledPlugins": ["superpowers@claude-plugins-official"]
```

Documented field that enables the plugin at project scope. Honoured automatically wherever Claude Code reads project settings.

### `.claude/hooks/session-start.sh`

Insert a plugin-install step inside the existing `CLAUDE_CODE_REMOTE=true` branch, before `npm install`:

```bash
if command -v claude >/dev/null 2>&1; then
  claude plugin install superpowers@claude-plugins-official || true
fi
```

Idempotent — `claude plugin install` no-ops if already installed. `|| true` prevents a transient marketplace error from blocking the hook (and downstream `npm install`). Wrapped in `command -v claude` so the script still works in environments without the CLI on PATH.

## Trade-offs accepted

- **Cloud-Claude-Code behaviour for `enabledPlugins` is undocumented.** The SessionStart hook is the safety net — even if the field is ignored, the explicit install runs.
- **No version pin.** The marketplace identifier is unversioned; Remote will get whatever version is current. Acceptable — superpowers is the user's daily tool and is updated frequently. Pin later if a breaking change bites.
- **No removal of the high-leverage code path** noted in CLAUDE.md as a follow-up. Out of scope for this PR.

## Delivery

- Branch: `add-superpowers-plugin` (already created off `origin/main`).
- One commit. Subject: `add superpowers plugin to project settings`.
- No new tests (config + hook change, no test surface).
- PR: per repo workflow — run `npm test`, push, wait CI green, auto-merge.

## Out of scope

- Vendoring superpowers into the repo.
- Adding other plugins.
- Modifying CLAUDE.md or `/start` command.
