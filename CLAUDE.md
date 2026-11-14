# ClaimOne — insurance claims desk (Health1)

Next.js 15 (App Router) · React 19 · Supabase (Postgres + Auth + Storage + Realtime) · Tailwind · Vitest. Portal bot in `bot/` (Node 22, Playwright).

## Non-negotiable

- Anon key only — app and bot. No service-role key anywhere.
- Status changes are enforced by `clm_claims_before_update` (SQL). TS copies only drive UI; `src/lib/engine/rules.test.ts` checks parity.
- Gate logic exists twice: `clm_unmet_mandatory_docs()` (SQL) and `resolveRules()` (TS). Change both + both test suites. The gate only blocks when `clm_tenants.paper_gate` is true (0020; off by default — papers are filed on the TPA sites, the desk works from the ledger).
- Master (`/master`, code in `src/lib/rcm/ledger.ts`; `/ledger` redirects) is the home screen: one row per patient, one cell per stage (Pre-auth · Discharge · Claim · Payment — `view` in ledger.ts merges the step cells; tapping opens the step due). Master shows active files only; settled/closed files with no cut pending or disputed live in `/archive` (same `LedgerScreen`, `archive` prop). Typed payments go through `clm_record_case_payment`. Navigation (src/components/AppShell.tsx GROUPS): Master (Active cases · Archive) · Payments (Upload — one box, file type detected in `recon/detect.ts`, bank money auto-matched by `recon/auto.ts` · To check — unmatched bank money, bills not on Master, letter payments not in bank) · Reports (Dashboard · Money owed · Deductions — money owed is read one way, `rcm/reports.ts` `loadOwed`, aged from the bill date; the weekly summary prints from Dashboard) · Records · Setup, each with sub-tabs; no hidden More menu. Report screens share `components/report/kit.tsx`.
- PMJAY payments come as the claim-paid sheet downloaded from TMS, uploaded weekly on Payments → Upload (`recon/payments.ts` `parseTms`; Registration ID = PMJAY case ID, Program ID = card ID; dates arrive as Excel day numbers). Every row is final, so `clm_apply_pmjay_tms` (0037) closes the whole case — payment, TDS, deduction = claimed − approved, nothing left owed — matches by case ID only (never patient name), corrects old-sheet IDs that lost their 16th digit, leaves disputed cases alone, and is safe to upload again. Bill lookups by case ID go through definer helpers (`clm_case_bills`, `clm_find_receivable`) — under RLS the case-ID index is not used.
- After any payment upload the result box says what the file did, not row counts: pending bills before → after per payer, files moved to Archive, and what is still pending by where it stands — approved and awaited, claim submitted and unpaid (with those past 30 days from discharge to chase), disputed, older bills (`recon/pending.ts` `takeSnapshot` / `outcome`, `components/pay/UploadOutcome.tsx`). Submitted claims have no bill until decided, so they are counted there from `clm_claims`.
- PMJAY has no pre-auth and no enhancement: Admission approved (case ID) → Discharge → Claim → Payment (`worklist.ts`, `ledger.ts`, `journey.ts`).
- Every deduction carries a reason: `REASON_OPTIONS` in `engine/settlement.ts` (SQL copy `clm_reason_ok`), or "Other" with text. Required by `clm_decide_cut` on files from `clm_tenants.reason_from` (1 Nov 2026). `unspecified` = not entered yet; Reports → Deductions lists those and sets them (`clm_set_deduction_reason` — booked deductions are immutable, so it reverses and re-books). Deductions MIS reads `clm_v_deduction_lines` (by reason, speciality, procedure, consultant, centre, payer; `rcm/deductions.ts`).
- A payment with a UTR is in the bank — Master/Archive say "In bank" from `clm_v_case_banked.with_utr` (0038). An uploaded bank statement only verifies it: the blue tick (`Cell.verified`, from `banked`). Never word a paid file as "not in bank"; the only prompt is "UTR not entered" on a typed payment without one.
- No deletes of claims, documents, settlements, audit rows.
- deduction = claimed − approved; net = approved − TDS.
- No patient data in logs or error messages. PHI columns are tagged in `0005_phi_tags.sql`.
- Indian number formatting (`toLocaleString('en-IN')`, ₹ L / Cr).

## Before every push

`npm test` · `npm run build` · `supabase/tests/run.sh` (plain Postgres; prints ALL DATABASE RULE TESTS PASSED).

## Seams

Identity → `src/lib/auth/session.ts` (swap to H1 Identity). Patient lookup → new-claim page. MedPay → only it sets `medpay_synced` (needs `set_config('claimone.source','medpay')`).
