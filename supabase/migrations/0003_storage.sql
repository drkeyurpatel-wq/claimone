-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — document storage
-- H1 Claims made this bucket public so links would open, which put every
-- patient's discharge summary one guessable URL away. It is private now;
-- the UI asks for a signed URL that expires in 10 minutes.
--
-- Path convention: <tenant_id>/<claim_id>/<timestamp>_<name>.<ext>
-- ════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-documents', 'claim-documents', false, 20971520,
        array['application/pdf','image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy claim_docs_read on storage.objects for select
  using (bucket_id = 'claim-documents'
         and (storage.foldername(name))[1] = clm_current_tenant()::text
         and clm_can_see_claim(((storage.foldername(name))[2])::uuid));

create policy claim_docs_insert on storage.objects for insert
  with check (bucket_id = 'claim-documents'
              and (storage.foldername(name))[1] = clm_current_tenant()::text
              and clm_can_see_claim(((storage.foldername(name))[2])::uuid)
              and clm_current_role() in ('admin','manager','desk','bot'));

-- No update or delete policies: a document is never overwritten or removed.
-- A wrong file is marked 'invalid' with a reason and a new one is uploaded.
