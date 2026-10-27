# Merge notes — ClaimOne + H1 Claims (27 Oct 2026)

## Sources

- **ClaimOne** — built 13 Aug 2026 in chat; never pushed to GitHub, no Supabase project. Validation engine, its 16 tests, the submit-gate design and the leakage-analysis idea were recovered from that conversation.
- **H1 Claims** — `drkeyurpatel-wq/hmis`, `app/(dashboard)/claims/*`, `lib/claims/*`, `bot/*`, `lib/nhcx/*`, tables `clm_*` in Supabase project `health1-hmis` (paused). The `clm_*` schema was never committed to the repo; it was rebuilt here from the code that used it.

Nothing in Supabase needed freeing: ClaimOne never had a project, and `health1-hmis` was already paused.

## Kept from each

| Area | Kept | From |
|---|---|---|
| Status model | 16 statuses, 7 claim types | H1 Claims |
| Document rules | stage + payer + hospital + claim type, most specific wins, amount thresholds | ClaimOne (claim type added) |
| Submission gate | only *verified* documents count; enforced server-side | ClaimOne (now in a DB trigger) |
| Screens | desk, workstation, pre-auth queue, queries, settlements, MIS, payers, bot | H1 Claims |
| Screens | readiness meter, leakage report | ClaimOne |
| Multi-tenancy | `tenant_id` + RLS everywhere | ClaimOne |
| Realtime, WhatsApp templates, portal bot, NHCX builders | | H1 Claims |

## Dropped as redundant

| Dropped | Replaced by |
|---|---|
| ClaimOne's 3 claim types | H1's 7 types + a separate *stage* |
| `clm_doc_checklists` (H1) — matched uploads to checklist by file name | `clm_doc_rules` + `doc_code` on each document |
| `clm_rejections` (H1) | `clm_disallowances` (deductions and rejections, categorised, preventable flag) |
| Stored `is_sla_breached` on claims and queries | computed live in `clm_v_open_queries` |
| Two dashboards, two detail pages | one each |
| Client-side status updates (`updateClaim({status})`) | `/api/claims/[id]/transition` → `clm_transition()` → trigger |
| Bot's `fetchPayerByCode` (unused) and hard-coded payer UUIDs | payer looked up by code at run time |
| `hmis_claims`, `ar_claim_*` (a third and fourth claims model inside HMIS, used by NHCX and collections) | not carried; NHCX builders kept as a library |

## Bugs fixed on the way

| Bug in H1 Claims | Effect | Fix |
|---|---|---|
| Settlement: `net = settlement − deduction`, TDS hard-coded 0 | cash received overstated by the TDS on every claim | `net = approved − TDS`, checked in TS and SQL |
| Settlement set `medpay_synced = true` without syncing | doctor payouts looked done when nothing was sent | only the MedPay sync may set it (trigger) |
| Document bucket public; links stored as public URLs | discharge summaries one URL away from anyone | private bucket, tenant/claim folders, 10-minute signed links |
| Search pasted user text into a PostgREST `or()` filter | a comma or bracket broke or widened the query | input stripped of filter syntax |
| Bot compared new status with the *claim number* | every claim "updated" on every poll | compares with the claim's status |
| Bot re-filed every `preauth_pending` claim every 15 min | duplicate pre-auths on the portal | picked once; attempt recorded before filing |
| Bot re-downloaded the same letters twice a day forever | duplicate documents | skips claims that already have the bot letter |
| Bot mapped portal "Settled" → `settled` | settled without amount, TDS or UTR | maps to `settlement_pending`; a person records the settlement |
| Bot logged extracted portal text | patient data in logs | logs length only |
| Bot uploaded screenshots to a public bucket | screenshots of patient records public | kept on the mini PC, pruned after 7 days |
| Bot OTP check ran *after* waiting for login success | always timed out | detects OTP and stops with a clear reason |
| 15- and 30-minute bot jobs overlapped on the hour | two browsers on one portal login | jobs run one at a time |
| Bot used the service-role key | one stolen mini PC = every record | bot is a normal user with role `bot` |
| Scorecard `COUNT(*)` on a LEFT JOIN | unused payers showed 1 claim | `COUNT(c.id)` |
| Triggers defined but never attached; duplicates later | no claim numbers, no audit, then double audit | one trigger each, covered by tests |
| NHCX "JWE" with placeholder key/IV/tag | FHIR bundle (patient data) sent base64-only | refuses to send until real encryption exists |
| Any status could be written from the browser | settled/written-off without checks | state machine + gate + role checks in the trigger |
| Uploads arrived as `uploaded` but nothing ever moved them on | checklist meaningless | verify / reject (with reason) flow, audited |

## Still missing

- PMJAY workflow (TMS portal, HBP package master, photo capture at admission/discharge) — only document rules exist
- Appeals as a tracked workflow (today: rejected → resubmit with a note)
- Bank-statement reconciliation of UTRs (`is_reconciled` is never set)
- TDS reconciliation against Form 26AS
- Ratnafin: which receivables are financed
- Payer tariff/package master and billed-vs-package check
- Query escalation (`escalation_level` is stored, nothing raises it)
- Session timeout for idle desk logins
- NHCX: encryption, participant registry, callback endpoint
- Portal bot: every TPA config is unverified — URLs and selectors were written without seeing the portals
