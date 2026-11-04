-- ════════════════════════════════════════════════════════════════════
-- Administrative desk: starts as desk staff; a manager approves it.
-- Team list and changes are for managers only; nobody changes their own login.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', '9811111111@claimone.local');
insert into clm_user_profiles (user_id, tenant_id, full_name, role, centre_ids, workspace)
values ('00000000-0000-0000-0000-0000000000e1', 'a0000000-0000-0000-0000-000000000001', 'Admin Desk Person', 'desk',
        array['a1000000-0000-0000-0000-000000000001'::uuid], 'admin');
set role authenticated;

-- desk staff cannot see or change the team
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ select * from clm_team() $$, 'manager');
select t.expect_error($$ select clm_set_staff('00000000-0000-0000-0000-0000000000e1', 'manager') $$, 'manager');

-- the manager sees the request at the top, with the mobile number
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select t.check((select full_name = 'Admin Desk Person' and mobile = '9811111111' and role = 'desk' and workspace = 'admin'
                from clm_team() limit 1), 'request listed first');
select t.check((select count(*) = 0 from clm_team() where full_name = 'Desk Other'), 'other hospital group not listed');
select t.check(clm_set_staff('00000000-0000-0000-0000-0000000000e1', 'manager') = 'ok', 'approved');
select t.check((select role = 'manager' from clm_team() where full_name = 'Admin Desk Person'), 'now a manager');
-- switched off when they leave
select t.check(clm_set_staff('00000000-0000-0000-0000-0000000000d1', null, false) = 'ok', 'switched off');
select t.check((select not is_active from clm_team() where full_name = 'Desk Shilaj'), 'shown as off');
select t.check(clm_set_staff('00000000-0000-0000-0000-0000000000d1', null, true) = 'ok', 'switched back on');
-- limits
select t.expect_error($$ select clm_set_staff('00000000-0000-0000-0000-0000000000a1', 'desk') $$, 'own login');
select t.expect_error($$ select clm_set_staff('00000000-0000-0000-0000-0000000000e1', 'admin') $$, 'manager or desk');
select t.expect_error($$ select clm_set_staff('00000000-0000-0000-0000-0000000000e1', 'desk') $$, 'Only an admin');
select t.expect_error($$ select clm_set_staff('00000000-0000-0000-0000-0000000000d2', 'manager') $$, 'Unknown staff');
select t.expect_error($$ select clm_set_staff('00000000-0000-0000-0000-0000000000b0', 'manager') $$, 'Only an admin');
reset role;
select 'ALL ADMIN DESK TESTS PASSED' as result;
