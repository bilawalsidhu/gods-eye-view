# Rebrand grep report — `God's Eye` / `GodsEye` / `gods-eye` / `GODS_EYE` (2026-09-18)

Generated after the OnDemand Spatial rename on branch `ondemand-serverless`. Scope: every tracked and untracked (non-ignored) file except `node_modules/` and `dist/`. Patterns: case-sensitive `God's Eye`, `GodsEye`, `gods-eye`, `GODS_EYE`, plus the case-insensitive union `god'?s[ -_]?eye` (the per-file `-i hits` column).

**Totals:** 146 files, 1559 case-insensitive hits — case-sensitive: `God's Eye` 51, `GodsEye` 42, `gods-eye` 139, `GODS_EYE` 82.

## Categories

| Category | Hits | Meaning | Status |
|---|---|---|---|
| ALIAS | 82 | `GODS_EYE_FLOW_VERSION` — the accepted alias (checked first) of `ONDEMAND_SPATIAL_FLOW_VERSION` | allowed exception (alias constant) |
| CREDIT | 1 | the single upstream credit line in the first-run launcher (`src/ui/templates/welcome.html`) and its CSS class | allowed exception (one credit line) |
| FORMERLY | 1 | the single 'formerly God's Eye View' note in `docs/ONDEMAND_PROXY_DESIGN.md` | allowed exception |
| UPSTREAM | 53 | upstream repository/commit references: `bilawalsidhu/gods-eye-view`, fork `mk42-ai/gods-eye-view`, Pinokio app URL, `git clone …/gods-eye-view.git` + `cd gods-eye-view`, commit `0d41b6be`, UA suffix, the old export zip name | allowed exception (upstream refs) |
| FROZEN-V1 | 64 | frozen v1 workflow definition: node prompts that self-describe as the "God's Eye pipeline", `WORKFLOW_CREATED_AS`, the name the live workflow was created under — kept byte-identical because live v1 (id 6aace534859f7b0abb53d99a) was renamed by display name only | NOT in the user's exception list — retained by design (a prompt edit = a v2 definition + live update) |
| RETAINED-ID | 1250 | functional identifiers: `godsEyeView.*` localStorage keys (persisted user data), `window.__godsEyeView` QA/debug global, `godsEyeView_*` Cesium stage names, registered client ids (`gods-eye-view-transit`, `*-proxy/1.0` UAs, `Digitraffic-User: gods-eye-view`, `GodsEyeView/1.0`) and the `scripts/qa-*.mjs` tooling that drives them | NOT in the user's exception list — retained (renaming would wipe saved scenes/layouts or break operator-registered client ids); flagged for decision |
| EVIDENCE | 98 | recorded live values in audit/evidence documents (quoted API payloads, recorded externalUserId values, runtime-env lists of past runs, grep snapshots, recorded page titles) | documentation of history — left verbatim |
| RENAME-NOTE | 10 | prose that explains the rename itself (old → new ledgers, 'created as', provenance comments, re-derived test digests) | documentation of the rename |
| OTHER | 0 | unclassified | must be empty |

## Per-file report

| File | -i hits | God's Eye | GodsEye | gods-eye | GODS_EYE | Classification |
|---|---|---|---|---|---|---|
| `.agents/skills/community-pr/SKILL.md` | 1 | 0 | 0 | 1 | 0 | UPSTREAM 1 |
| `.env.example` | 4 | 0 | 1 | 0 | 3 | ALIAS 3, FROZEN-V1 1 |
| `.github/ISSUE_TEMPLATE/config.yml` | 3 | 0 | 0 | 3 | 0 | UPSTREAM 3 |
| `CHANGELOG.md` | 10 | 2 | 1 | 3 | 1 | RETAINED-ID 5, UPSTREAM 1, ALIAS 1, EVIDENCE 1, FROZEN-V1 1, RENAME-NOTE 1 |
| `CONTRIBUTING.md` | 2 | 0 | 0 | 2 | 0 | UPSTREAM 2 |
| `DATA_SOURCES.md` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `README.md` | 6 | 0 | 0 | 6 | 0 | UPSTREAM 6 |
| `SECURITY.md` | 1 | 0 | 0 | 1 | 0 | UPSTREAM 1 |
| `api/ondemand/_config.js` | 3 | 0 | 1 | 0 | 2 | ALIAS 2, FROZEN-V1 1 |
| `api/ondemand/health.js` | 1 | 0 | 0 | 0 | 1 | ALIAS 1 |
| `api/ondemand/workflow.js` | 1 | 0 | 0 | 0 | 1 | ALIAS 1 |
| `docs/APPLICATION.md` | 1 | 0 | 0 | 0 | 0 | RETAINED-ID 1 |
| `docs/BRANDING.md` | 10 | 0 | 0 | 5 | 1 | RETAINED-ID 6, RENAME-NOTE 2, UPSTREAM 1, ALIAS 1 |
| `docs/CURRENT-STATE.md` | 9 | 0 | 0 | 1 | 0 | RETAINED-ID 8, UPSTREAM 1 |
| `docs/KNOWN-ISSUES.md` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `docs/MAINTAINER_WORKFLOW.md` | 1 | 0 | 0 | 1 | 0 | UPSTREAM 1 |
| `docs/ONDEMAND_API_CURRENT.md` | 2 | 0 | 0 | 0 | 0 | EVIDENCE 2 |
| `docs/ONDEMAND_PROXY_DESIGN.md` | 9 | 1 | 0 | 0 | 8 | ALIAS 8, FORMERLY 1 |
| `docs/SCENE-DOCUMENT.md` | 1 | 0 | 0 | 0 | 0 | RETAINED-ID 1 |
| `docs/SERVERLESS_LIMITATIONS.md` | 3 | 0 | 0 | 0 | 3 | ALIAS 3 |
| `docs/audit/RUN-REPORT.md` | 9 | 0 | 0 | 8 | 1 | UPSTREAM 7, EVIDENCE 1, ALIAS 1 |
| `docs/audit/ai-provider-hits.txt` | 1 | 0 | 0 | 1 | 0 | EVIDENCE 1 |
| `docs/audit/build-log-tail.txt` | 2 | 0 | 0 | 2 | 0 | EVIDENCE 2 |
| `docs/audit/dashboard-registration-pack.md` | 41 | 4 | 12 | 4 | 4 | EVIDENCE 29, FROZEN-V1 6, ALIAS 4, RENAME-NOTE 1, UPSTREAM 1 |
| `docs/audit/deployment-verification.md` | 19 | 1 | 1 | 3 | 14 | ALIAS 14, UPSTREAM 3, EVIDENCE 1, FROZEN-V1 1 |
| `docs/audit/gate0-snapshot.md` | 31 | 5 | 0 | 18 | 0 | EVIDENCE 23, RETAINED-ID 8 |
| `docs/audit/gate3-row1-earthquake-verification.md` | 2 | 0 | 0 | 0 | 2 | ALIAS 2 |
| `docs/audit/gate3-row1-registration.md` | 12 | 1 | 2 | 1 | 2 | EVIDENCE 9, ALIAS 2, FROZEN-V1 1 |
| `docs/audit/gates.md` | 13 | 0 | 1 | 7 | 5 | UPSTREAM 5, ALIAS 5, FROZEN-V1 2, EVIDENCE 1 |
| `docs/audit/media-grounding-verification.md` | 1 | 1 | 0 | 0 | 0 | EVIDENCE 1 |
| `docs/audit/provider-hits.txt` | 30 | 3 | 0 | 22 | 0 | EVIDENCE 25, RETAINED-ID 5 |
| `docs/audit/speech-services-verification.md` | 1 | 0 | 0 | 0 | 0 | EVIDENCE 1 |
| `docs/media/README.md` | 4 | 0 | 0 | 4 | 0 | UPSTREAM 4 |
| `docs/ondemand-skills/README.md` | 5 | 1 | 2 | 0 | 0 | RENAME-NOTE 4, FROZEN-V1 1 |
| `docs/ondemand-skills/ondemand-spatial-structured-response-writer.md` | 1 | 0 | 1 | 0 | 0 | FROZEN-V1 1 |
| `docs/ondemand-workflows/README.md` | 11 | 1 | 4 | 4 | 2 | FROZEN-V1 9, ALIAS 2 |
| `docs/ondemand-workflows/contract-baseline.emulator.json` | 1 | 0 | 0 | 0 | 1 | ALIAS 1 |
| `docs/ondemand-workflows/contract-baseline.json` | 2 | 0 | 1 | 0 | 1 | ALIAS 1, FROZEN-V1 1 |
| `docs/ondemand-workflows/ondemand-spatial-advanced-v1.json` | 24 | 19 | 5 | 0 | 0 | FROZEN-V1 24 |
| `docs/ondemand-workflows/verification-2026-09-18.json` | 2 | 0 | 2 | 0 | 0 | FROZEN-V1 2 |
| `package.json` | 3 | 0 | 0 | 3 | 0 | UPSTREAM 3 |
| `scripts/dev-fresh.sh` | 1 | 0 | 0 | 0 | 0 | RETAINED-ID 1 |
| `scripts/precompute-cctv-heights.mjs` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `scripts/qa-application.mjs` | 3 | 0 | 0 | 0 | 0 | RETAINED-ID 3 |
| `scripts/qa-attribution-b12.mjs` | 15 | 0 | 0 | 0 | 0 | RETAINED-ID 15 |
| `scripts/qa-cables-overlay.mjs` | 7 | 0 | 0 | 0 | 0 | RETAINED-ID 7 |
| `scripts/qa-cables-render-probe.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/qa-cables-shot.mjs` | 4 | 0 | 0 | 0 | 0 | RETAINED-ID 4 |
| `scripts/qa-camera-controls.mjs` | 17 | 0 | 0 | 0 | 0 | RETAINED-ID 17 |
| `scripts/qa-cctv-v2.mjs` | 61 | 0 | 0 | 0 | 0 | RETAINED-ID 61 |
| `scripts/qa-cockpit-plates.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/qa-cockpit-utility.mjs` | 50 | 0 | 0 | 0 | 0 | RETAINED-ID 50 |
| `scripts/qa-directions.mjs` | 15 | 0 | 0 | 0 | 0 | RETAINED-ID 15 |
| `scripts/qa-director-camera.mjs` | 7 | 0 | 0 | 0 | 0 | RETAINED-ID 7 |
| `scripts/qa-director-interactions.mjs` | 27 | 0 | 0 | 0 | 0 | RETAINED-ID 27 |
| `scripts/qa-director-packs.mjs` | 17 | 0 | 0 | 0 | 0 | RETAINED-ID 17 |
| `scripts/qa-director-sharing.mjs` | 29 | 0 | 0 | 0 | 0 | RETAINED-ID 29 |
| `scripts/qa-director-timing.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/qa-draw-tool.mjs` | 18 | 0 | 0 | 0 | 0 | RETAINED-ID 18 |
| `scripts/qa-enrich-ambient.mjs` | 15 | 0 | 0 | 0 | 0 | RETAINED-ID 15 |
| `scripts/qa-failstate-b10.mjs` | 11 | 0 | 0 | 0 | 0 | RETAINED-ID 11 |
| `scripts/qa-firms.mjs` | 11 | 0 | 0 | 0 | 0 | RETAINED-ID 11 |
| `scripts/qa-firstrun.mjs` | 4 | 0 | 0 | 0 | 0 | RETAINED-ID 4 |
| `scripts/qa-floor-hold.mjs` | 6 | 0 | 0 | 0 | 0 | RETAINED-ID 6 |
| `scripts/qa-floor-verify.mjs` | 6 | 0 | 0 | 0 | 0 | RETAINED-ID 6 |
| `scripts/qa-flyroute-cinema.mjs` | 4 | 0 | 0 | 0 | 0 | RETAINED-ID 4 |
| `scripts/qa-focus-evidence.mjs` | 27 | 0 | 0 | 0 | 0 | RETAINED-ID 27 |
| `scripts/qa-heading-b3.mjs` | 38 | 0 | 0 | 0 | 0 | RETAINED-ID 38 |
| `scripts/qa-height-datum.mjs` | 20 | 0 | 0 | 0 | 0 | RETAINED-ID 20 |
| `scripts/qa-infra-lod.mjs` | 11 | 0 | 0 | 0 | 0 | RETAINED-ID 11 |
| `scripts/qa-l9-matrix.mjs` | 24 | 0 | 0 | 0 | 0 | RETAINED-ID 24 |
| `scripts/qa-label-readability.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/qa-labels.mjs` | 8 | 0 | 0 | 0 | 0 | RETAINED-ID 8 |
| `scripts/qa-layer-panel.mjs` | 3 | 0 | 0 | 0 | 0 | RETAINED-ID 3 |
| `scripts/qa-location-controls.mjs` | 16 | 0 | 0 | 0 | 0 | RETAINED-ID 16 |
| `scripts/qa-map-source-controls.mjs` | 13 | 0 | 0 | 0 | 0 | RETAINED-ID 13 |
| `scripts/qa-map-source-tray.mjs` | 50 | 0 | 0 | 0 | 0 | RETAINED-ID 50 |
| `scripts/qa-nepal-media-playback.mjs` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `scripts/qa-overlay-baseline.mjs` | 18 | 0 | 0 | 0 | 0 | RETAINED-ID 18 |
| `scripts/qa-perf.mjs` | 17 | 0 | 0 | 0 | 0 | RETAINED-ID 17 |
| `scripts/qa-radio.mjs` | 156 | 0 | 0 | 0 | 0 | RETAINED-ID 156 |
| `scripts/qa-scene-controls.mjs` | 27 | 0 | 0 | 0 | 0 | RETAINED-ID 27 |
| `scripts/qa-sprites-b5.mjs` | 13 | 0 | 0 | 0 | 0 | RETAINED-ID 13 |
| `scripts/qa-traffic-baseline.mjs` | 8 | 0 | 0 | 0 | 0 | RETAINED-ID 8 |
| `scripts/qa-traffic-jamviz-ab.mjs` | 10 | 0 | 0 | 0 | 0 | RETAINED-ID 10 |
| `scripts/qa-traffic-navigation.mjs` | 8 | 0 | 0 | 0 | 0 | RETAINED-ID 8 |
| `scripts/qa-traffic-preset-ab.mjs` | 8 | 0 | 0 | 0 | 0 | RETAINED-ID 8 |
| `scripts/qa-traffic.mjs` | 6 | 0 | 0 | 0 | 0 | RETAINED-ID 6 |
| `scripts/qa-transit-browser.mjs` | 7 | 0 | 0 | 0 | 0 | RETAINED-ID 7 |
| `scripts/qa-transit-controls.mjs` | 3 | 0 | 0 | 0 | 0 | RETAINED-ID 3 |
| `scripts/qa-transit-heading.mjs` | 4 | 0 | 0 | 0 | 0 | RETAINED-ID 4 |
| `scripts/qa-transit-recovery.mjs` | 6 | 0 | 0 | 0 | 0 | RETAINED-ID 6 |
| `scripts/qa-transit-scenes.mjs` | 22 | 0 | 0 | 0 | 0 | RETAINED-ID 22 |
| `scripts/qa-transit.mjs` | 49 | 0 | 0 | 0 | 0 | RETAINED-ID 49 |
| `scripts/qa-ui-disposal.mjs` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `scripts/qa-vessel-cards.mjs` | 7 | 0 | 0 | 0 | 0 | RETAINED-ID 7 |
| `scripts/qa-vessel-datum.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/qa-view-target-prewarm.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/qa-visual-effects.mjs` | 14 | 0 | 0 | 0 | 0 | RETAINED-ID 14 |
| `scripts/qa-visual-input.mjs` | 19 | 0 | 0 | 0 | 0 | RETAINED-ID 19 |
| `scripts/qa-voice-routing.mjs` | 24 | 0 | 0 | 0 | 0 | RETAINED-ID 24 |
| `scripts/qa-voice-wav.mjs` | 5 | 0 | 0 | 0 | 0 | RETAINED-ID 5 |
| `scripts/track-regression.mjs` | 119 | 0 | 0 | 0 | 0 | RETAINED-ID 119 |
| `server/ondemand/config.js` | 10 | 0 | 2 | 0 | 8 | ALIAS 8, RENAME-NOTE 1, EVIDENCE 1 |
| `server/ondemand/config.test.mjs` | 16 | 0 | 1 | 0 | 15 | ALIAS 15, FROZEN-V1 1 |
| `server/ondemand/handlers.test.mjs` | 7 | 0 | 0 | 0 | 7 | ALIAS 7 |
| `server/ondemand/workflow-definition.js` | 11 | 10 | 1 | 0 | 0 | FROZEN-V1 11 |
| `server/ondemand/workflow-definition.test.mjs` | 1 | 0 | 1 | 0 | 0 | FROZEN-V1 1 |
| `server/providers/aircraft/adsb-lol.js` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `server/providers/aircraft/opensky.js` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `server/providers/cctv.js` | 2 | 0 | 0 | 2 | 0 | RETAINED-ID 2 |
| `server/providers/cctv/constants.js` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `server/providers/cctv/media.js` | 3 | 0 | 0 | 3 | 0 | RETAINED-ID 3 |
| `server/providers/cctv/sources.js` | 2 | 0 | 0 | 2 | 0 | RETAINED-ID 2 |
| `server/providers/gbfs.js` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `server/providers/overpass/constants.js` | 1 | 0 | 0 | 1 | 0 | UPSTREAM 1 |
| `server/providers/radio/constants.js` | 1 | 0 | 1 | 0 | 0 | RETAINED-ID 1 |
| `server/providers/regional/news.js` | 2 | 0 | 2 | 0 | 0 | RETAINED-ID 2 |
| `server/providers/regional/place.js` | 2 | 0 | 0 | 2 | 0 | UPSTREAM 2 |
| `server/providers/space/celestrak.js` | 2 | 0 | 0 | 2 | 0 | RETAINED-ID 1, UPSTREAM 1 |
| `server/sources/demo-timezone.js` | 1 | 0 | 0 | 1 | 0 | UPSTREAM 1 |
| `src/app/tools.js` | 4 | 0 | 0 | 0 | 0 | RETAINED-ID 4 |
| `src/cockpitCloudEffects.js` | 1 | 0 | 0 | 0 | 0 | RETAINED-ID 1 |
| `src/data/cctvFintraffic.test.mjs` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `src/data/cctvNswSource.test.mjs` | 4 | 0 | 0 | 4 | 0 | RETAINED-ID 4 |
| `src/data/transitFeeds.js` | 1 | 0 | 0 | 1 | 0 | RETAINED-ID 1 |
| `src/data/transitProxy.js` | 2 | 0 | 0 | 2 | 0 | RETAINED-ID 1, UPSTREAM 1 |
| `src/data/transitProxy.test.mjs` | 4 | 0 | 0 | 4 | 0 | RETAINED-ID 4 |
| `src/layers/cctv/policy.js` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `src/layers/transit/selection.js` | 1 | 0 | 0 | 0 | 0 | RETAINED-ID 1 |
| `src/overpassProxy.test.mjs` | 2 | 0 | 0 | 2 | 0 | RETAINED-ID 2 |
| `src/pinokioUpdatePreview.test.mjs` | 3 | 0 | 0 | 3 | 0 | UPSTREAM 3 |
| `src/registry/capabilities.json` | 1 | 0 | 0 | 1 | 0 | UPSTREAM 1 |
| `src/scenes/director.js` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `src/scenes/director.test.mjs` | 9 | 0 | 0 | 0 | 0 | RETAINED-ID 9 |
| `src/tooling/importDirections.test.mjs` | 2 | 0 | 0 | 2 | 0 | UPSTREAM 2 |
| `src/tooling/panelStorageDocs.test.mjs` | 12 | 0 | 0 | 0 | 0 | RETAINED-ID 12 |
| `src/tooling/transitQa.test.mjs` | 9 | 0 | 0 | 0 | 0 | RETAINED-ID 9 |
| `src/ui/panelPositionControls.js` | 4 | 0 | 0 | 0 | 0 | RETAINED-ID 4 |
| `src/ui/templates/welcome.html` | 2 | 1 | 0 | 1 | 0 | UPSTREAM 1, CREDIT 1 |
| `src/ui/visualEffects.js` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `src/voice/actionSchemas.test.mjs` | 1 | 1 | 0 | 0 | 0 | RENAME-NOTE 1 |
| `src/voice/gevActions.js` | 2 | 0 | 0 | 0 | 0 | RETAINED-ID 2 |
| `src/voice/gevRealtime.test.mjs` | 6 | 0 | 0 | 0 | 0 | RETAINED-ID 6 |
| `src/voice/realtimePreferences.js` | 3 | 0 | 0 | 0 | 0 | RETAINED-ID 3 |
| `src/voice/realtimeViewport.js` | 1 | 0 | 0 | 0 | 0 | RETAINED-ID 1 |

## Decisions closed 2026-09-18

Recorded during the close-out of the OnDemand Spatial rebrand (branch
`ondemand-serverless`, decisions taken 2026-09-18). The counts below are the
per-category totals of this grep report (`RETAINED-ID` 1,250 hits,
`FROZEN-V1` 64 hits at the time of the report).

- **Group 1 — persisted-state / registered-client identifiers (1,250 hits:
  `godsEyeView.*` storage keys, `window.__godsEyeView`, `godsEyeView_*` Cesium
  stage names, `gods-eye-view-*` / `GodsEyeView/*` client identifiers, the
  `scripts/qa-*.mjs` tooling that drives them).** DECISION = **KEEP UNCHANGED.**
  Rationale: invisible to users; renaming persisted keys would wipe existing
  users' saved state (scenes, CCTV calibrations, panel layouts, voice-cost
  preferences) without a migration, and the client identifiers are registered
  with the feed operators. Revisit only if a storage-key migration is
  scheduled (then: read-old/write-new migration + a deprecation window, not a
  rename).
- **Group 2 — frozen v1 workflow-prompt strings (64 hits: the nine node
  prompts of workflow `6aace534859f7b0abb53d99a` that self-describe as the
  "God's Eye pipeline", `WORKFLOW_CREATED_AS`, the committed export and its
  provenance notes).** DECISION = **LEAVE IN v1**; fold the wording change into
  the v2 workflow publish when the workflow next changes for a functional
  reason. Published workflow versions are immutable — a prompt edit is a new
  definition, and the committed export must stay byte-identical to the live
  v1 object (`server/ondemand/workflow-definition.test.mjs` compares every
  prompt against it).
- Note: the live dashboard workflow was renamed by **display name only** on
  **2026-09-18 10:41:47Z** (`PATCH /automation/api/workflow/{id}/name` →
  HTTP 200); the workflow ID `6aace534859f7b0abb53d99a`, the v1 label, the
  trigger and the nine nodes are unchanged.
