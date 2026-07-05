#!/usr/bin/env bash
set -uo pipefail

# Companion to fallow-gate.sh. Regenerates Istanbul coverage (coverage/coverage-final.json)
# before the fallow gate runs, so per-function CRAP in `fallow audit` reflects the
# current tests instead of stale/missing coverage.
#
# Runs only on agent `git commit` / `git push`, matching the gate. Best-effort and
# always exits 0: it never blocks a commit. If test:coverage fails (e.g. a failing
# test or missing tooling), it prints a notice and lets the gate proceed with whatever
# coverage already exists. Keeping this separate leaves fallow-gate.sh untouched so a
# future `fallow hooks install` won't clobber the gate.

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

INPUT="$(cat)"
CMD="$(jq -r '.tool_input.command // empty' <<<"$INPUT")"

# Same git commit/push detection as fallow-gate.sh.
if ! printf '%s\n' "$CMD" | grep -Eq '(^|[[:space:];|&()])git[[:space:]]+(commit|push)([[:space:]]|$)'; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
cd "$PROJECT_DIR" 2>/dev/null || exit 0

# No coverage script, nothing to do.
if ! command -v npm >/dev/null 2>&1; then
  exit 0
fi
if ! npm run 2>/dev/null | grep -q "^  test:coverage$"; then
  exit 0
fi

if ! npm run --silent test:coverage >/tmp/fallow-coverage.log 2>&1; then
  echo "fallow-coverage: test:coverage failed; gate will use existing coverage. See /tmp/fallow-coverage.log" >&2
fi

exit 0
