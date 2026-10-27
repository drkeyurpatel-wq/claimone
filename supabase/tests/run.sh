#!/usr/bin/env bash
# Runs the schema, seed and rule tests against a throwaway database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh
set -eo pipefail
cd "$(dirname "$0")/.."
DB=claimone_test_$$
createdb "$DB"
trap 'dropdb "$DB"' EXIT
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1" >/dev/null; }
run tests/00_supabase_stub.sql
for f in migrations/*.sql; do run "$f"; done
run seed.sql
for f in tests/[1-9]*.sql; do
  out=$(psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" 2>&1) || { echo "$out" | grep -E "ERROR" ; echo "FAILED: $f"; exit 1; }
  echo "$out" | grep -E "PASSED"
done
