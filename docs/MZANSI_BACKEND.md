# Dedicated Supabase integration

Updated 3 November 2026. The dedicated MzansiView project now exists in WestKamo’s Org, eu-west-1, on the Free plan with a quoted project cost of $0/month. Unrelated projects were not modified.

`supabase/migrations/` contains the applied core schema and starter-source migrations. The schema uses PostGIS geography points, RLS, explicit grants, caller-permission geographic RPCs, private admin roles and import logs. The security advisor reported no findings. Cross-user tests are still required.

Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_MZANSI_HOSTED=true` for the intended preview. Never supply service-role or secret keys to Vite. These settings are build-time values. The local `.env.local` is ignored.

The import Edge Function source is in `supabase/functions/import-durban`. It verifies the session with Auth and checks database admin permission, uses fixed bounded provider requests, retries, logs, cooldown and draft-only imports. It is not yet deployed or verified. Configure exact `ALLOWED_ORIGINS` and Auth redirect allowlists before a hosted release. Do not enable arbitrary preview-origin wildcards. Role assignment must be performed by an authorized database administrator for a verified user, never editable user metadata.

No scheduled import, backup/restore verification, additional facility import, or frontend preview has been completed. See [the contribution record](Phindile_v1.md) for exact evidence and remaining work. The frontend additions are committed for review and remain unverified.
