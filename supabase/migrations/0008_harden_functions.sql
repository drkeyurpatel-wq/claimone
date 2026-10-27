-- Supabase grants EXECUTE on new functions to PUBLIC, so the per-function
-- "revoke from anon" lines earlier had no effect. Close it for every
-- ClaimOne function: signed-out callers get nothing; signed-in users keep
-- the helpers RLS needs. Also pin search_path on the remaining functions.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;

alter function clm_can_write() set search_path = public;
alter function clm_submission_stage(text, text) set search_path = public;
alter function clm_norm_ref(text) set search_path = public;
alter function clm_deduction_category(text) set search_path = public;
