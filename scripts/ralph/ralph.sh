#!/usr/bin/env bash
set -euo pipefail

# Ralph — Autonomous AI agent loop for HeyJamie
# Adapted from https://github.com/snarktank/ralph
#
# Usage:
#   bash scripts/ralph/ralph.sh [MAX_ITERATIONS]
#   bash scripts/ralph/ralph.sh --help

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
PROMPT_FILE="$SCRIPT_DIR/prompt.md"
ARCHIVE_DIR="$SCRIPT_DIR/archive"

DEFAULT_MAX_ITERATIONS=10
SLEEP_BETWEEN=2

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Ralph — Autonomous AI agent loop for HeyJamie

Usage:
  bash scripts/ralph/ralph.sh [MAX_ITERATIONS]

Arguments:
  MAX_ITERATIONS  Maximum loop iterations (default: 10)

Setup:
  1. Copy scripts/ralph/prd.json.example to scripts/ralph/prd.json
  2. Edit prd.json with your stories
  3. Run: npm run ralph

The loop invokes Claude Code with --dangerously-skip-permissions for each
iteration, piping prompt.md as the task. Each iteration picks the next
incomplete story from prd.json, implements it, runs quality checks, commits,
and updates progress.

The loop exits when:
  - Claude outputs <promise>COMPLETE</promise> (all stories done)
  - MAX_ITERATIONS is reached

Files:
  scripts/ralph/prd.json       Your stories (gitignored, create from .example)
  scripts/ralph/progress.txt   Progress log (gitignored, auto-created)
  scripts/ralph/prompt.md      Prompt template piped to Claude Code
  scripts/ralph/archive/       Previous run archives (gitignored)
USAGE
  exit 0
fi

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

MAX_ITERATIONS="${1:-$DEFAULT_MAX_ITERATIONS}"

if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "Error: MAX_ITERATIONS must be a positive integer, got: $MAX_ITERATIONS"
  exit 1
fi

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

if [[ ! -f "$PRD_FILE" ]]; then
  echo "Error: $PRD_FILE not found."
  echo "Copy prd.json.example to prd.json and edit it with your stories."
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found. Install Claude Code first."
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: 'jq' not found. Install it with: brew install jq"
  exit 1
fi

# ---------------------------------------------------------------------------
# Branch management
# ---------------------------------------------------------------------------

BRANCH_NAME=$(jq -r '.branchName // empty' "$PRD_FILE")

if [[ -z "$BRANCH_NAME" ]]; then
  echo "Error: prd.json must have a 'branchName' field."
  exit 1
fi

cd "$PROJECT_ROOT"

CURRENT_BRANCH=$(git branch --show-current)

if [[ "$CURRENT_BRANCH" != "$BRANCH_NAME" ]]; then
  echo "Current branch: $CURRENT_BRANCH"
  echo "PRD branch:     $BRANCH_NAME"

  # Archive previous run if progress exists
  if [[ -f "$PROGRESS_FILE" ]]; then
    echo "Archiving previous run's progress..."
    mkdir -p "$ARCHIVE_DIR"
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    cp "$PROGRESS_FILE" "$ARCHIVE_DIR/progress-$TIMESTAMP.txt"
    if [[ -f "$PRD_FILE" ]]; then
      cp "$PRD_FILE" "$ARCHIVE_DIR/prd-$TIMESTAMP.json"
    fi
  fi

  # Create or checkout the branch
  if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
    echo "Checking out existing branch: $BRANCH_NAME"
    git checkout "$BRANCH_NAME"
  else
    echo "Creating new branch from master: $BRANCH_NAME"
    git checkout -b "$BRANCH_NAME" master
  fi
fi

# ---------------------------------------------------------------------------
# Initialize progress file if missing
# ---------------------------------------------------------------------------

if [[ ! -f "$PROGRESS_FILE" ]]; then
  cat > "$PROGRESS_FILE" <<EOF
# Ralph Progress Log
Started: $(date '+%Y-%m-%d %H:%M:%S')
---

## Codebase Patterns
(populated by iterations as they discover reusable patterns)
---
EOF
  echo "Created initial progress file."
fi

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

echo ""
echo "========================================"
echo "  Ralph Loop — HeyJamie"
echo "  Branch:     $BRANCH_NAME"
echo "  Max iters:  $MAX_ITERATIONS"
echo "========================================"
echo ""

for (( i=1; i<=MAX_ITERATIONS; i++ )); do
  echo "--- Iteration $i / $MAX_ITERATIONS ---"
  echo ""

  # Pipe the prompt to Claude Code
  OUTPUT=$(claude --dangerously-skip-permissions --print < "$PROMPT_FILE" 2>&1) || true

  echo "$OUTPUT"
  echo ""

  # Check for completion signal
  if echo "$OUTPUT" | grep -q '<promise>COMPLETE</promise>'; then
    echo "========================================"
    echo "  All stories complete!"
    echo "========================================"
    exit 0
  fi

  if (( i < MAX_ITERATIONS )); then
    echo "Sleeping ${SLEEP_BETWEEN}s before next iteration..."
    sleep "$SLEEP_BETWEEN"
  fi
done

echo "========================================"
echo "  Reached max iterations ($MAX_ITERATIONS)."
echo "  Some stories may still be incomplete."
echo "========================================"
exit 1
