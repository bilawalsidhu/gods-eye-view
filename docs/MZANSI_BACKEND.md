# Dedicated Supabase integration

## Provisioning blocker

The requested project is `MzansiView` in `WestKamo's Org`. Creation on 3 November
2026 was refused because the account already owns two active free projects.
No project was created, and neither existing project was paused or modified.
The owner must free an active slot or upgrade before provisioning can continue.

## Integration boundary

Keep the existing Vue/Cesium frontend. The current local reference dataset and
browser favourites are a complete offline-data mode, not a simulated database.
After provisioning, introduce a typed data service between the places panel and
Supabase, keeping the local collection explicitly selectable as reference data.

Use PostgreSQL/PostGIS for sources and places, authenticated user-owned bookmarks
and saved views, and a private schema for imports and protected role assignments.
Expose bounded, caller-permission RPCs for viewport and radius queries with spatial
indexes. Enable RLS and least-privilege grants on every exposed table; public users
read only published places and signed-in users manage only their own records.
Never derive admin permissions from user-editable metadata. Store provider secrets
server-side and use only the project URL and publishable key in browser code.

Use authenticated Edge Functions for small provider imports and protected API
calls, scheduled with Cron. Keep long-running stream consumers in a separate
worker if they are introduced. Provider retention, licence and attribution rules
apply independently of the application's MIT source licence.

## Before enabling cloud mode

1. Provision the dedicated project and inspect its actual configuration.
2. Develop schema changes against a development database; verify spatial results,
   anonymous read restrictions, cross-user isolation and admin privileges.
3. Generate and review migrations with the current Supabase CLI.
4. Integrate email authentication, bookmarks and saved views with explicit loading,
   error, signed-out and expired-session states.
5. Test failed imports, deduplication and stale-data reporting.
6. Migrate each enabled upstream server integration before static deployment.
   The inherited Vite server/proxy features do not automatically run on a CDN.

Do not deploy the inherited local provider-settings panel publicly as an admin
interface. No credentials or Supabase project identifiers belong in this document.
