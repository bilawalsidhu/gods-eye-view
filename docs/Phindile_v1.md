# MzansiView contribution record

Phindile Sandi · 3 November 2026

Phindile initiated and directed MzansiView, selected the Durban-first focus and dedicated Supabase architecture, and used AI coding assistance to adapt the inherited Vue/Vite/Cesium application. This does not claim sole authorship of the inherited platform or generated implementation. God’s Eye View by Bilawal Sidhu and its contributors supplies the globe, camera, controls, layers, providers and testing infrastructure. LICENSE retains the MIT notice; third-party data has separate terms described in DATA_SOURCES.md.

## Preserved foundation

Repository: https://github.com/WestKamo/MzansiView

Existing draft PR: https://github.com/WestKamo/MzansiView/pull/1

Branch: feat/mzansi-durban-foundation

Foundation commit: https://github.com/WestKamo/MzansiView/commit/99259ac5ed5751d6634247ab9d297348e2cbf7e0

The checkout began clean at this commit. Existing Durban branding, startup camera, three attributed reference anchors, map picking, browser favourites and share restoration were retained.

## Verified cloud changes

The account inspection confirmed WhyGodWhy inactive and storage active. Neither was modified. The dedicated MzansiView project was created in WestKamo’s Org in eu-west-1 after approval of the quoted $0 monthly project cost. It reported ACTIVE_HEALTHY.

Applied migrations: mzansi_core and mzansi_sources. They add PostGIS places with spatial indexes, source metadata, profiles, owner-scoped bookmarks and saved views, private role assignments and import logs, bounded geographic RPCs, and admin import procedures. Three existing reference anchors were seeded. Supabase’s security advisor returned no findings after these migrations. This is not equivalent to passing cross-user RLS tests.

## Local implementation awaiting verification

Implementation additions include email sign-in, registration and recovery controls, sign-out, cloud bookmarks, saved camera views and filters, explicit copying of local favourites, source freshness, a bounded summary, admin draft review, and an authenticated import Edge Function source. The Edge Function has not been deployed. No administrator was assigned. No scheduler was configured.

Hosted mode disables unaudited upstream layers using the existing availability mechanism and retains the direct USGS earthquake feed. It suppresses local key setup and server Google-token acquisition. Provider audit and browser verification remain incomplete.

A production build passed after the initial account components and explorer integration, before the final hosted-mode changes. It reported large bundles. Feature test execution was interrupted without recorded results. A boundary command encountered a sandbox subprocess error. No fresh full-suite pass is claimed.

## Outstanding work

Complete meaningful cross-user RLS, geographic boundary and import idempotency tests; validate auth redirects, recovery, cloud persistence and mobile/desktop WebGL flows; finish provider audit and usage controls; deploy and test the import function; acquire and review additional licensed Durban facilities; configure an appropriate scheduled import; document and verify backups/restoration; review code and run the complete checks; commit/push onto the existing branch and update PR #1; deploy and verify a frontend preview.

Public facility retrieval failed with provider rejection/timeouts. No additional facilities were fabricated or published. Source metadata for OpenStreetMap records identifies ODbL and OpenStreetMap contributors. The starter anchors retain source links but broader reuse rights require review.

A Vercel project creation request failed because explicitly selected build-machine settings are unavailable on Hobby. No successful preview URL is recorded. Subsequent work was interrupted. No production deployment or PR merge occurred.

## Verification follow-up — 3 November 2026

The requested verification was attempted again. The broad test run was interrupted before a summary; its partial log includes failing upstream suites, so no full-suite pass is claimed. Focused feature runs also did not complete with a recorded result. The boundary check returned `spawnSync git EPERM` in the sandbox. A fresh production build was interrupted during transformation. The changed Vue components, cloud helpers and stylesheet were formatted with Prettier, and `git diff --check` passed. A transactional database verification script is provided in `supabase/tests/access.sql`; its execution result was not captured and must not be described as passing. Changes are committed for review with these verification limitations outstanding.


## Continuation review — 3 November 2026

Reviewed the cloud foundation from commit c8d0314. Fixed stale account data responses, guarded favourite migration against account switches, and respected camera navigation refusal when restoring views. Updated the explorer tests for the persistent panel and new collection selector. Added tests for configuration, camera validation, provenance and provider normalization/retries. The production build and 11 focused tests passed. The Supabase transaction-based access test passed and rolled back its fixtures. No claim is made here of a deployed importer or completed hosted sign-in verification. These changes were implemented with AI assistance; original upstream attribution remains intact.
