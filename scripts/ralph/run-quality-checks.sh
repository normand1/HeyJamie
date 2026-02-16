#!/usr/bin/env bash
set -euo pipefail

# Run HeyJamie quality checks (build + optional integration test).
#
# Usage:
#   bash scripts/ralph/run-quality-checks.sh
#   bash scripts/ralph/run-quality-checks.sh --scenario excalidraw-diagram
#   bash scripts/ralph/run-quality-checks.sh --scenario excalidraw-diagram --min-score 90

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SCENARIO=""
MIN_SCORE=80

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)
      SCENARIO="$2"
      shift 2
      ;;
    --min-score)
      MIN_SCORE="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'USAGE'
Run HeyJamie quality checks.

Usage:
  bash scripts/ralph/run-quality-checks.sh [OPTIONS]

Options:
  --scenario <name>    Run integration test for the named scenario
  --min-score <n>      Minimum scorePercent to pass (default: 80)
  --help               Show this help

Tier 1 (always runs):
  tsc          TypeScript type checking
  vite build   Frontend build

Tier 2 (when --scenario is set):
  Runs the eval script for the named scenario and checks scorePercent.

Available scenarios:
  excalidraw-diagram
  arxiv-quantum-rl-transformers
  arxiv-html-preference
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

cd "$PROJECT_ROOT"

# ---------------------------------------------------------------------------
# Tier 1: Build
# ---------------------------------------------------------------------------

echo "=== Tier 1: TypeScript check ==="
if ! npx tsc; then
  echo "FAIL: TypeScript check failed."
  exit 1
fi
echo "PASS: TypeScript check."
echo ""

echo "=== Tier 1: Vite build ==="
if ! npx vite build; then
  echo "FAIL: Vite build failed."
  exit 1
fi
echo "PASS: Vite build."
echo ""

# ---------------------------------------------------------------------------
# Tier 2: Integration test (optional)
# ---------------------------------------------------------------------------

if [[ -n "$SCENARIO" ]]; then
  echo "=== Tier 2: Integration test — $SCENARIO ==="

  EVAL_SCRIPT="$PROJECT_ROOT/scripts/eval-${SCENARIO}.mjs"
  REPORT_FILE="/tmp/ralph-eval-${SCENARIO}.json"

  if [[ ! -f "$EVAL_SCRIPT" ]]; then
    echo "FAIL: Eval script not found: $EVAL_SCRIPT"
    exit 1
  fi

  echo "Running: node $EVAL_SCRIPT --output $REPORT_FILE"
  if ! node "$EVAL_SCRIPT" --output "$REPORT_FILE"; then
    echo "FAIL: Integration test script exited with error."
    exit 1
  fi

  if [[ ! -f "$REPORT_FILE" ]]; then
    echo "FAIL: Report file not created: $REPORT_FILE"
    exit 1
  fi

  # Extract scorePercent from report JSON
  SCORE=$(python3 -c "import json,sys; r=json.load(open('$REPORT_FILE')); print(r['scorePercent'])" 2>/dev/null || echo "")

  if [[ -z "$SCORE" ]]; then
    echo "FAIL: Could not read scorePercent from $REPORT_FILE"
    exit 1
  fi

  echo "Score: ${SCORE}% (minimum: ${MIN_SCORE}%)"

  if (( SCORE < MIN_SCORE )); then
    echo "FAIL: Score ${SCORE}% is below minimum ${MIN_SCORE}%."
    exit 1
  fi

  echo "PASS: Integration test — ${SCENARIO} (${SCORE}%)."
  echo ""
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo "========================================"
echo "  All quality checks passed!"
echo "========================================"
