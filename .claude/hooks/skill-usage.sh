#!/bin/bash
# Stop hook: capture which /<skill>s were invoked in this session so the
# next /start can surface them for skill-improvement review.
#
# Append-only log at /tmp/claude-skill-usage.log. One line per Stop event
# (multiple lines per session are fine — easier to dedupe later than to
# miss a skill use).

set -uo pipefail

INPUT=$(cat)
SESSION=$(echo "$INPUT" | jq -r '.session_id // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')

[ -z "$SESSION" ] && exit 0
[ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ] && exit 0

# Extract every Skill tool invocation in the transcript. JSONL: jq runs
# per-line. .message.content is an array on assistant turns; the // empty
# guard skips lines without it.
SKILLS=$(jq -r '
  .message.content[]? // empty
  | select(type == "object" and .type == "tool_use" and .name == "Skill")
  | .input.skill // empty
' "$TRANSCRIPT" 2>/dev/null | sort -u | paste -sd ',' -)

[ -z "$SKILLS" ] && exit 0

echo "$(date -Iseconds) session=$SESSION skills=$SKILLS" >> /tmp/claude-skill-usage.log

exit 0
