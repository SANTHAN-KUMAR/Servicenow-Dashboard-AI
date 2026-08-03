#!/usr/bin/env bash
# Every suite, in dependence order. Exits non-zero if any fails.
#
# The order is deliberate: the pure helpers first because everything above them
# assumes their arithmetic, then the form engine, then the renderer checks from
# cheapest to most thorough. A failure low down makes failures above it noise.
set -u
cd "$(dirname "$0")/../.."
fail=0
for t in product/tests/test_*.js; do
    printf '%-36s' "$(basename "$t")"
    if out=$(node "$t" 2>&1); then
        echo "$(echo "$out" | grep -Eo '[0-9]+ passed' | tail -1)"
    else
        echo "FAILED"; echo "$out" | sed 's/^/    /'; fail=1
    fi
done
exit $fail
