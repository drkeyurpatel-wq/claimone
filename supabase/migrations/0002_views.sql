-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — reporting views
-- security_invoker = true: every view runs with the caller's RLS, so a
-- view can never show another tenant's or another centre's rows.
-- ════════════════════════════════════════════════════════════════════

-- Ageing of money still owed by payers.
-- Clock starts at submission (or discharge, or creation for old rows).
create or replace view clm_v_aging with (security_invoker = true) as
with open_claims as (
  select c.tenant_id, c.centre_id, c.payer_id, c.id,
         coalesce(c.approved_amount, c.claimed_amount, c.estimated_amount, 0) as amount,
         (current_date - coalesce(c.submitted_at::date, c.discharge_date, c.created_at::date)) as age_days
  from clm_claims c
  where c.status in ('claim_submitted','claim_under_review','claim_query',
                     'claim_approved','claim_partial','settlement_pending')
)
select o.tenant_id, o.centre_id, ce.code as centre_code, o.payer_id, p.name as payer_name,
       case when o.age_days <= 30 then '0-30'
            when o.age_days <= 60 then '31-60'
            when o.age_days <= 90 then '61-90'
            when o.age_days <= 180 then '91-180'
            else '180+' end as aging_bucket,
       count(*)::int as claim_count,
       sum(o.amount) as total_amount
from open_claims o
join clm_payers p on p.id = o.payer_id
join clm_centres ce on ce.id = o.centre_id
group by 1,2,3,4,5,6;

-- Payer scorecard. H1 Claims used COUNT(*) on a LEFT JOIN, which counted
-- 1 claim for payers with none. COUNT(c.id) fixes that.
create or replace view clm_v_payer_scorecard with (security_invoker = true) as
select p.id as payer_id, p.name as payer_name, p.type as payer_type,
       count(c.id)::int as total_claims,
       count(c.id) filter (where c.status in ('settled','closed'))::int as settled_count,
       count(c.id) filter (where c.status in ('claim_rejected','preauth_rejected','written_off'))::int as rejected_count,
       count(c.id) filter (where c.is_query_pending)::int as pending_queries,
       round(avg(c.settlement_date - c.submitted_at::date) filter (where c.settlement_date is not null and c.submitted_at is not null), 1) as avg_settlement_days,
       round(100.0 * count(c.id) filter (where c.status in ('claim_rejected','written_off'))
             / nullif(count(c.id) filter (where c.status in ('claim_rejected','written_off','settled','closed','claim_approved','claim_partial','settlement_pending')), 0), 1) as rejection_rate_pct,
       sum(c.claimed_amount) as total_claimed,
       sum(c.approved_amount) filter (where c.status in ('settled','closed')) as total_approved,
       sum(c.settled_amount) as total_settled,
       sum(c.deduction_amount) as total_deductions,
       round(100.0 * sum(c.deduction_amount) / nullif(sum(c.claimed_amount) filter (where c.status in ('settled','closed')), 0), 1) as deduction_pct
from clm_payers p
left join clm_claims c on c.payer_id = p.id
group by p.id, p.name, p.type;

-- Open queries with live SLA state (H1 stored is_sla_breached, which went
-- stale because nothing updated it; computing it here is always current).
create or replace view clm_v_open_queries with (security_invoker = true) as
select q.*, c.claim_number, c.patient_name, c.centre_id, c.payer_id, p.name as payer_name,
       (now() > q.sla_deadline) as is_sla_breached,
       round(extract(epoch from (q.sla_deadline - now())) / 3600.0, 1) as hours_left
from clm_queries q
join clm_claims c on c.id = q.claim_id
join clm_payers p on p.id = c.payer_id
where q.status in ('open','in_progress','escalated');

-- One timeline per claim: status changes, gate decisions, documents,
-- queries and settlement — newest first in the UI.
create or replace view clm_v_timeline with (security_invoker = true) as
select t.claim_id, 'status_change'::text as event_type,
       coalesce(t.from_status, 'new') || ' → ' || t.to_status as event_text,
       t.trigger_source as source, t.notes, t.created_at
from clm_state_transitions t
union all
select e.claim_id, e.event_type,
       case e.event_type
         when 'doc_verified' then 'Verified: ' || (e.payload->>'name')
         when 'doc_rejected' then 'Rejected: ' || (e.payload->>'name')
         when 'submit_blocked' then 'Submission blocked'
         else e.event_type end,
       'user', e.payload->>'note', e.created_at
from clm_events e
union all
select d.claim_id, 'document_uploaded', 'Uploaded: ' || d.document_name, d.source, null, d.created_at
from clm_documents d
union all
select q.claim_id, 'query_raised', 'Query #' || q.query_number || ': ' || left(q.query_text, 120), q.source, null, q.raised_at
from clm_queries q
union all
select q.claim_id, 'query_responded', 'Replied to query #' || q.query_number, 'user', left(q.response_text, 200), q.responded_at
from clm_queries q where q.responded_at is not null
union all
select s.claim_id, 'settlement',
       'Settled ₹' || to_char(s.net_amount, 'FM99,99,99,990') || coalesce(' · UTR ' || s.utr_number, ''),
       s.source, null, s.created_at
from clm_settlements s;

-- Leakage: where money is lost, by payer, category and doctor.
create or replace view clm_v_leakage with (security_invoker = true) as
select d.tenant_id, c.centre_id, c.payer_id, p.name as payer_name,
       coalesce(c.treating_doctor_name, '—') as doctor_name,
       d.kind, d.category, d.is_preventable,
       date_trunc('month', d.recorded_at)::date as month,
       count(*)::int as items,
       sum(d.amount) as amount
from clm_disallowances d
join clm_claims c on c.id = d.claim_id
join clm_payers p on p.id = c.payer_id
group by 1,2,3,4,5,6,7,8,9;

grant select on clm_v_aging, clm_v_payer_scorecard, clm_v_open_queries, clm_v_timeline, clm_v_leakage to authenticated;

-- Readiness of every claim waiting for its next submission (ClaimOne's
-- "blocked" KPI): which stage it goes to next and what is still missing.
create or replace view clm_v_readiness with (security_invoker = true) as
with nxt as (
  select c.id as claim_id, c.centre_id, c.payer_id, c.status,
         coalesce(c.claimed_amount, c.estimated_amount, 0) as amount,
         case
           when c.claim_type = 'reimbursement' and c.status in ('draft','claim_query','claim_rejected') then 'reimbursement'
           when c.status in ('draft','preauth_query','preauth_rejected') then 'preauth'
           when c.status in ('preauth_approved','preauth_enhanced','claim_query','claim_rejected') then 'final'
         end as next_stage
  from clm_claims c
)
select n.claim_id, n.centre_id, n.payer_id, n.status, n.amount, n.next_stage,
       count(u.doc_code)::int as unmet_count,
       string_agg(u.doc_label, ', ' order by u.doc_label) as unmet_labels
from nxt n
left join lateral clm_unmet_mandatory_docs(n.claim_id, n.next_stage) u on true
where n.next_stage is not null
group by 1,2,3,4,5,6;

grant select on clm_v_readiness to authenticated;
