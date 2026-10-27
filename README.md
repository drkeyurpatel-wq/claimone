# ClaimOne

Insurance claims desk for Health1 — pre-auth to settlement — built to be sold to other hospitals later.

This repository merges the two earlier builds:

| From | What came across |
|---|---|
| **ClaimOne** (Aug 2026, standalone) | Document rules engine with most-specific-rule-wins, submission gate, readiness meter, multi-tenant design, leakage analysis |
| **H1 Claims** (Apr 2026, inside the old `hmis` repo) | 16-stage claim lifecycle, 7 claim types, pre-auth / query / settlement screens, payer scorecard, ageing, timeline, WhatsApp updates, Realtime, TPA portal bot, NHCX FHIR builders |

What was dropped, and why, is in [`docs/MERGE_NOTES.md`](docs/MERGE_NOTES.md).

## How it works in one paragraph

A claim starts as a **draft**. Every move to a new status goes through the database, which allows only the moves in `clm_allowed_transitions`. A move that *submits* something (pre-auth, final claim, reimbursement) is refused while any required document for that stage is not **verified** — uploaded is not enough. Which documents are required comes from `clm_doc_rules`: platform defaults, overridden by payer, claim-type or hospital rules (most specific wins). Settlement records approved, TDS, net and UTR in one transaction and itemises the deduction, which feeds the leakage report. The portal bot signs in as a normal user with role `bot` and can only change three fields through one function.

## Layout

```
supabase/migrations/   0001 schema + rules + RLS · 0002 views · 0003 storage · 0004 realtime · 0005 PHI tags
supabase/seed.sql      31 payers and the default document rules (billing head to confirm)
supabase/tests/        database rule tests — run.sh against plain Postgres
src/lib/engine/        pure TypeScript: validation (gate), transitions, settlement maths — unit tested
src/lib/claims/        types, browser data access, store (Zustand + Realtime), server-side WhatsApp
src/app/api/claims/    transition, settle, document review, signed document URL
src/app/(app)/claims/  desk, claim workstation, new claim, pre-auth, queries, settlements, leakage, MIS, payers, rules, bot
src/lib/nhcx/          NHCX FHIR builders — not wired; encryption deliberately refuses to run
bot/                   Playwright portal bot for the hospital mini PC
```

## Run it

```bash
npm install
cp .env.example .env.local          # Supabase URL + ANON key only
npm test                            # 37 engine/API tests
npm run build
```

Database (a new Supabase project, or the shared one once H1 Identity exists):

```bash
supabase db push                    # applies supabase/migrations in order
psql "$DATABASE_URL" -f supabase/seed.sql
```

Database rule tests (needs only a local Postgres, no Supabase):

```bash
PGHOST=localhost PGUSER=postgres supabase/tests/run.sh   # ends with "ALL DATABASE RULE TESTS PASSED"
```

First users — until the common login exists, create them in Supabase Auth and add a profile:

```sql
insert into clm_tenants (code, name) values ('health1', 'Health1 Super Speciality Hospitals') returning id;
insert into clm_centres (tenant_id, code, name) values ('<tenant>', 'shj', 'Shilaj'), ('<tenant>', 'vst', 'Vastral'), ...;
insert into clm_user_profiles (user_id, tenant_id, full_name, role, centre_ids)
values ('<auth user id>', '<tenant>', 'Name', 'manager', null);   -- null = every centre
```

Roles: `admin` (payers, rules, everything) · `manager` (rules, write-off) · `desk` (day-to-day) · `viewer` (read-only) · `bot` (no screens).

## Rules for whoever works on this next

1. **Anon key only.** The app and the bot never hold the service-role key. A permissions error means a policy needs fixing.
2. **Status changes stay in the database.** The trigger `clm_claims_before_update` is the authority. The TypeScript copies (`transitions.ts`, `validation.ts`) only decide which buttons to show; `rules.test.ts` fails if the state machine drifts from the SQL.
3. **The gate has two implementations that must agree:** `clm_unmet_mandatory_docs()` in SQL and `resolveRules()` in TypeScript. Change both, and both test suites.
4. **No deletes.** Claims, documents, settlements and audit rows are never deleted. Wrong file → mark invalid with a reason, upload again.
5. **Money identity:** deduction = claimed − approved; net = approved − TDS. Enforced in `clm_record_settlement` and `settlement.ts`.
6. Run `npm test`, `npm run build` and `supabase/tests/run.sh` before every push.

## Wiring to the new stack

| Seam | File | Replace with |
|---|---|---|
| Who is signed in | `src/lib/auth/session.ts` | H1 Identity (HRMS) — map its user, tenant, role and centres |
| Patient / episode | `src/app/(app)/claims/new/page.tsx` | HMIS admission lookup when HMIS is live (eCW feed before that) |
| Centres, staff | `clm_centres`, `clm_user_profiles` | HRMS master lists |
| Settlement → doctor payout | `clm_claims.medpay_synced` | MedPay sync job (only it may set the flag) |
| Bank reconciliation | `clm_settlements.is_reconciled` | Bank statement matcher / H1 CashFlow |
