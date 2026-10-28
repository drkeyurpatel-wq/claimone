-- ════════════════════════════════════════════════════════════════════
-- Bot inbox: the bot drops downloaded statements; staff use them.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- the bot drops a statement for its centre
select t.act_as('00000000-0000-0000-0000-0000000000b0');
insert into clm_bot_inbox (tenant_id, centre_id, source_label, file_name, rows, row_count)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Medi Assist website', 'payments.xlsx',
        '[["Claim No","Net Paid","UTR"],["CL-1","1000","U1"]]', 2);
-- the same statement again is refused
select t.expect_error($$ insert into clm_bot_inbox (tenant_id, centre_id, source_label, file_name, rows, row_count)
  values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'Medi Assist website', 'payments (1).xlsx',
          '[["Claim No","Net Paid","UTR"],["CL-1","1000","U1"]]', 2) $$, 'duplicate key');
-- the bot cannot touch bills or payments
select t.expect_error($$ select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[{"bill_no":"B","net_amount":1}]') $$, 'Read-only');

-- desk staff cannot drop statements, but see them and mark them used
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ insert into clm_bot_inbox (tenant_id, centre_id, source_label, file_name, rows, row_count)
  values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'x', 'x', '[["a"]]', 1) $$, 'row-level security');
select t.check((select count(*) = 1 from clm_bot_inbox where used_at is null), 'desk sees the downloaded statement');
update clm_bot_inbox set used_at = now() where file_name = 'payments.xlsx';
select t.check((select used_by = '00000000-0000-0000-0000-0000000000d1' from clm_bot_inbox where file_name = 'payments.xlsx'), 'marked used by the desk user');
select t.expect_error($$ update clm_bot_inbox set rows = '[["changed"]]' $$, 'cannot be changed');

-- another hospital sees nothing
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.check((select count(*) = 0 from clm_bot_inbox), 'other hospital sees no statements');

reset role;
select 'ALL BOT INBOX TESTS PASSED' as result;
