#!/bin/bash
# export-logs.sh — snapshot the Kimi Code session wire logs into logs/
#
# Non-negotiable per Noah: the full conversation log (main agent AND
# every subagent) must be exported continuously, so that automatic
# context compaction can never lose history. Compaction is not
# observable in advance, so this runs after every work chunk.
#
# What gets exported, per run, into logs/<timestamp>/:
#   agents/*/wire.jsonl   — full conversation of main + all subagents
#   logs/kimi-code.log    — runtime log
#   state.json            — session state
# plus logs/latest -> the newest snapshot.
#
# logs/ is gitignored by default (the repo is public). To publish logs,
# force-add specific snapshots: git add -f logs/<timestamp>/

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS_HOME="$HOME/.kimi-code/sessions"

# Newest session dir for this working directory (wd_ prefix match).
WD_KEY="wd_$(basename "$REPO_ROOT")"
# The research workspace holds the repo one level down; match on the
# parent dir name too so the script works from either location.
PARENT_KEY="wd_$(basename "$(dirname "$REPO_ROOT")")"

SESSION_DIR="$(ls -dt "$SESSIONS_HOME"/${WD_KEY}_*/session_* 2>/dev/null | head -1 || true)"
if [ -z "$SESSION_DIR" ]; then
    SESSION_DIR="$(ls -dt "$SESSIONS_HOME"/${PARENT_KEY}_*/session_* 2>/dev/null | head -1 || true)"
fi
if [ -z "$SESSION_DIR" ]; then
    echo "[export-logs] no session dir found under $SESSIONS_HOME" >&2
    exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
DEST="$REPO_ROOT/logs/$TS"
mkdir -p "$DEST"

cp "$SESSION_DIR/state.json" "$DEST/" 2>/dev/null || true
[ -f "$SESSION_DIR/logs/kimi-code.log" ] && cp "$SESSION_DIR/logs/kimi-code.log" "$DEST/" || true

for agent_dir in "$SESSION_DIR"/agents/*/; do
    agent="$(basename "$agent_dir")"
    mkdir -p "$DEST/agents/$agent"
    [ -f "$agent_dir/wire.jsonl" ] && cp "$agent_dir/wire.jsonl" "$DEST/agents/$agent/"
done

ln -sfn "$TS" "$REPO_ROOT/logs/latest"

# Prune: keep the 50 newest snapshots.
cd "$REPO_ROOT/logs"
ls -d 20* 2>/dev/null | sort -r | tail -n +51 | xargs rm -rf 2>/dev/null || true

echo "[export-logs] snapshot: logs/$TS ($(du -sh "$DEST" | cut -f1), $(find "$DEST" -name wire.jsonl | wc -l | tr -d ' ') agent logs)"
