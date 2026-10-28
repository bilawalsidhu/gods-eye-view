# CABA traffic enforcement locations

The **CABA Traffic Enforcement** layer in Infrastructure displays the published
locations of fixed traffic enforcement devices in Ciudad Autónoma de Buenos Aires.
It is off by default. Select a point to inspect its address, fiscalizador type,
provenance and catalog retrieval time.

This is an inventory, with no imagery, plate readings, direction of view or
operating-status observations. A catalog retrieval timestamp does not establish
when a device was installed, active or last observed. The official description
excludes cameras enforcing exclusive public-transport lanes and entry into
restricted areas; coverage is not all CCTV in
Buenos Aires, the metropolitan area or Argentina.

## Source and attribution

- Publisher: Gobierno de la Ciudad de Buenos Aires / Buenos Aires Data.
- Dataset: https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular
- CSV: https://data.buenosaires.gob.ar/dataset/camaras-fijas-control-vehicular/resource/juqdkmgo-311-resource/download
- License: [CC BY 2.5 Argentina](https://creativecommons.org/licenses/by/2.5/ar/).
- Portal resource metadata last changed: 2025-07-23, checked 2026-10-14.
  This metadata date is not a per-device observation time.
- Transformation: parse CSV fields and decimal-comma coordinates, validate a
  generous CABA envelope, convert to GeoJSON points and collapse identical rows.
  The original address and fiscalizador type are retained.

The app's Data attribution credit links the publisher and license and identifies
the conversion. The MIT code license does not replace this dataset license.

## Acquisition and lifecycle

The local provider exposes `GET /api/caba-traffic-enforcement` in both Vite dev
and preview. It requests only the fixed official resource, permits at most three
HTTPS redirects on the city's data/CDN hosts, caps downloads at 2 MiB and 5,000
rows, and times out after 20 seconds. CSV decoding accepts UTF-8 and the official CDN's legacy Windows-1252 encoding, preserving accented headers and addresses. Successful responses share a 24-hour cache;
concurrent requests coalesce. Failed refreshes return an unavailable error.
Caller-selected URLs and query parameters are rejected.

The full CSV is acquired at runtime, not the portal's 100-row preview or an
unverified third-party mirror. No count is hard-coded. Missing columns, malformed
CSV, empty inventories or invalid coordinates fail visibly rather than generating
a misleading empty layer.

`src/layers/trafficEnforcement/source.js` supplies `getFeatures({signal})`.
Application hosts can replace or omit the source through the catalog contract.
The shared infrastructure renderer retains successfully parsed features for the
layer's lifetime, rebuilds entities on re-enable, and releases scene resources,
selection and context records on disable/destroy. Reload the app to request a
new inventory; toggles do not poll the publisher. Destruction aborts acquisition
and discards late results.

Layer ID: `caba-traffic-enforcement`. Provisional share token: `6`; rerun the
allocator against merge-time main before merging. Voice supports visibility and
entity context; aggregate analyst queries are not exposed for this inventory.

## Validation

Use the Node version required by CONTRIBUTING.md. Run:

```bash
npm run format
npm run format:check
npm run check:boundaries
npm run layer-token:check -- --base-ref upstream/main
node --test src/layers/trafficEnforcement/*.test.mjs server/providers/cabaTraffic.test.mjs src/data/infrastructure.test.mjs
npm test
npm run build
```

With a dev server at http://localhost:4173:

```bash
npm run test:track
node scripts/qa-infra-lod.mjs --url http://localhost:4173
node scripts/qa-caba-traffic.mjs --url http://localhost:4173
```

The CABA browser gate uses deterministic fixtures to check point/context
provenance, cleanup across toggles, share-state round trips and visible failures.
`--headful` uses the native browser GPU; provider fixtures replace only application fetches and leave Cesium workers untouched. It does not validate live access to the city's CSV. Also enable the layer against
the real provider and inspect its returned count and at least one location before
marking the contribution ready for review.

### Local validation, 2026-10-15

Node 24.22.0 on Linux passed 6,717 tests, including both allocation gates; the
Windows-only native DACL test was skipped. Build, formatting, package boundaries,
setup doctor and published-token checks passed. The official CSV download through
the real provider returned 224 records. Its legacy encoding was reproduced in a
regression test that failed before the decoder correction and passed afterward.

The catalogue includes both GNSS and CABA after synchronization with upstream
`5d05a0a`; manifest-derived schema pins and share-token allocation fixtures reflect
that combined state. The Unicode validator timing fixture is materialized before
timing, so V8's lazy repeated-string allocation is excluded while the existing
200 ms validation bound stays unchanged.

### Token reconciliation with main, 2026-10-26

Synchronized #1143 with upstream main
`15de9d738c4a85be1a96726c6114181caef87eeb` (including #1297, #1418 and
#1419). Removed only CABA's obsolete unpublished registry entry and reservation,
then ran `npm run layer-token:next -- caba-traffic-enforcement`: the official
allocator returned `6`. CABA now uses `6` in the registry and ledger. S2
GhostMaps retains its published `5`; every other published reservation is
unchanged. The official checker reports **32 published, 1 new** against that
main revision. The registry has 33 shareable layers; the application catalog
has 34 including local-only ADS-B.

PR #1415's provisional assignments are not published reservations in this base.
Its branch and reservations were not changed. If another PR publishes `6`
before CABA merges, rerun the documented official allocation procedure against
fresh main; do not preemptively skip free tokens or renumber published layers.
Old links produced by #1143's unpublished `5` allocation must be regenerated:
`5` unambiguously belongs to published S2 GhostMaps, with no CABA compatibility
alias that could misinterpret legitimate GhostMaps links.

The navigation regressions exercise the production long-hash parser and
`/share/<code>` parser/codec through `ShareLinkManager`, then restore actual
layer lifecycle state through `LayerStateCoordinator` and `DataLayerManager`
using fixture modules. Each format restores both layers, CABA alone, S2 alone
and neither in succession; CABA alone disables S2 and S2 alone disables CABA.
The short-code regression also pins `ARCfnioY_6RHUgEgRw`, independently generated
with the published main codec/ledger, to preserve the existing S2 bitmap index.
This validates parsing and lifecycle restoration, not rendered map imagery.

Voice schema hashes and catalog/allocation fixtures were reconciled with both
layers present. The generated CABA capability contract adds exactly 160
characters to main's 52,000-character Realtime prompt budget; the budget test
accounts explicitly for that addition without changing tool arguments or
removing existing guidance.

Validation on Node 24.22.1:

- `npm test`: full ordinary unit plan 8,813 passed, 0 failed, 2 platform
  skips (Docker Compose CLI unavailable and native Windows DACL validation);
  all 15 isolated allocation probes passed on the calibrated Node 24 runtime.
- `npm run layer-token:check -- --base-ref upstream/main`: passed; all other
  reservation rows also compared equal to main after excluding CABA.
- Focused layer-state/ledger, voice-schema and first-run tests: 135 passed.
- Share codecs, legacy conversion, path, navigation, language, celestial,
  restoration notices and share-tool tests: 120 passed, including the fixed
  published S2 short code.
- `npm run i18n`: Spanish, Russian and Simplified Chinese complete, 2,730
  messages per catalog. Catalog integration tests passed after conflict
  resolution and updated application-layer counts.
- `npm run format:check`, `npm run check:boundaries`, `npm run doctor`,
  `npm run changelog:check` and `npm run build`: passed. Build retains its
  existing large-chunk advisory.
- `node scripts/qa-caba-traffic.mjs` and `npm run test:track -- --url
  http://127.0.0.1:4184`: attempted, but Chromium 152.0.7977.75 aborted at
  startup with `chrome/browser/process_singleton_posix.cc:297: socket()
  failed: Operation not permitted (1)`, despite the gates' no-sandbox flags.
  The tracking attempt used a reachable dev server in the same process
  environment. Neither gate reached a page or produced visual evidence.
  Browser-rendered restoration, live-source UI, screenshots and recording
  therefore remain unverified; no browser assertion was relaxed.
