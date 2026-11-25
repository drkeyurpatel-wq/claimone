-- ════════════════════════════════════════════════════════════════════
-- WhatsApp desk: only the bot may ask whether a mobile is staff, and
-- the close question is the bot's alone.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update auth.users set email = '9876500001@claimone.local' where id = '00000000-0000-0000-0000-0000000000d1';
set role authenticated;

select t.act_as('00000000-0000-0000-0000-0000000000b0');
select t.check((select full_name = 'Desk Shilaj' and role = 'desk' from clm_wa_staff('+91 98765 00001')), 'bot finds the desk login by mobile');
select t.check((select count(*) = 0 from clm_wa_staff('9000000000')), 'an unknown number is not staff');

select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ select * from clm_wa_staff('9876500001') $$, 'Only the bot');
select t.expect_error($$ insert into clm_wa_sessions (tenant_id, phone, claim_id, action, staff_name)
  select tenant_id, '9876500001', id, 'close', 'x' from clm_claims limit 1 $$, 'row-level security');

reset role;
select 'ALL WHATSAPP TESTS PASSED' as result;
