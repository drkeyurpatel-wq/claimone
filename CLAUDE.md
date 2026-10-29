# ClaimOne — insurance claims desk (Health1)

Next.js 15 (App Router) · React 19 · Supabase (Postgres + Auth + Storage + Realtime) · Tailwind · Vitest. Portal bot in `bot/` (Node 22, Playwright).

## Non-negotiable

- Anon key only — app and bot. No service-role key anywhere.
- Status changes are enforced by `clm_claims_before_update` (SQL). TS copies only drive UI; `src/lib/engine/rules.test.ts` checks parity.
- Gate logic exists twice: `clm_unmet_mandatory_docs()` (SQL) and `resolveRules()` (TS). Change both + both test suites. The gate only blocks when `clm_tenants.paper_gate` is true (0020; off by default — papers are filed on the TPA sites, the desk works from the ledger).
- The ledger (`/ledger`, `src/lib/rcm/ledger.ts`) is the home screen: one row per patient, one cell per step. Typed payments go through `clm_record_case_payment`; every other screen sits under More.
- No deletes of claims, documents, settlements, audit rows.
- deduction = claimed − approved; net = approved − TDS.
- No patient data in logs or error messages. PHI columns are tagged in `0005_phi_tags.sql`.
- Indian number formatting (`toLocaleString('en-IN')`, ₹ L / Cr).

## Before every push

`npm test` · `npm run build` · `supabase/tests/run.sh` (plain Postgres; prints ALL DATABASE RULE TESTS PASSED).

## Seams

Identity → `src/lib/auth/session.ts` (swap to H1 Identity). Patient lookup → new-claim page. MedPay → only it sets `medpay_synced` (needs `set_config('claimone.source','medpay')`).
