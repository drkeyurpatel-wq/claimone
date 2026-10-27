#!/usr/bin/env bash
# Runs the schema, seed and rule tests against a throwaway database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=claimone_test_$$
createdb "$DB"
trap 'dropdb "$DB"' EXIT
run() { psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$1" >/dev/null; }
run tests/00_supabase_stub.sql
for f in migrations/*.sql; do run "$f"; done
run seed.sql
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f tests/10_rules.sql
