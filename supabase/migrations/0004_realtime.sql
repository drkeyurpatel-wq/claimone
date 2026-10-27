-- Live updates for the claims desk (bot results, colleagues' changes).
-- Realtime respects RLS, so each user only receives rows they can read.
alter publication supabase_realtime add table clm_claims, clm_queries;
