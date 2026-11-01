#!/usr/bin/env bash
# Posts an eval report as GitHub annotations (the summary lines, then the per-hand lines seven
# at a time), and copies it to the step summary. Usage: annotate.sh <report file> <title>
set -euo pipefail
f=$1 title=$2
[ -f "$f" ] || exit 0
{ echo '```'; cat "$f"; echo '```'; } >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
grep -E '^(schema-valid|overall score|answered by|response time|model )' "$f" | while IFS= read -r line; do echo "::notice title=$title::$line"; done
grep -E '^[a-z0-9-]+ +expected' "$f" | paste -d'|' - - - - - - - | sed 's/|/ %0A/g' | while IFS= read -r chunk; do echo "::notice title=$title (hands)::$chunk"; done
