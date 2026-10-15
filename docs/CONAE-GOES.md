# CONAE GOES in Active Fires

## Goal

Add CONAE's public GOES thermal detections to the existing Active Fires layer.
Build directly on upstream main; do not depend on another pull request.

## Evidence and current architecture

Reviewed upstream commit 871523593f76c56404e4b5da99d6daea5701cd25 on 2026-10-15.

- The official [CONAE OGC catalog](https://catalogos.conae.gov.ar/catalogo/catalogoGeoServiciosOGC.html)
  documents GOES products for the last ten minutes and last 24 hours. The
  published WFS service is `https://geoservicios.conae.gov.ar/geoserver/FocosDeCalor/wfs`;
  the daily layer is `FocosDeCalor:FocosGOES_24hs`.
- The official [fire viewer FAQ](https://geoportal.conae.gov.ar/mapstore/faq/visor-incendios/faq.html)
  says the GOES product has no confidence attribute. It describes these
  detections as early indications of thermal activity, recommends considering
  FRP and persistence, and recommends comparison with other sensors.
- A thermal detection does not establish an individual wildfire. Distinct
  acquisitions of a location are separate observations.
- Active Fires already separates acquisition from rendering:
  `server/providers/firms.js` -> `src/layers/firms/source.js` ->
  `firmsAdapt.js` -> the existing scene, selection, cards and analyst records.
- The FIRMS proxy fetches VIIRS NOAA-20/21/SNPP and MODIS sequentially, retains its
  own memory/disk cache for 30 minutes, and filters observations to 24 hours.
  Its quota and key handling should remain owned by that provider.
- Existing adaptation converts missing confidence to zero and labels that
  value low. GOES requires preserving the absence of confidence through cards,
  context and analyst records. A quality category must not be invented.
- The layer's `requiresKeyId` supplies guidance only while
  `stats.keyRequired` is true. A configured, working keyless source can
  therefore populate Active Fires without inventing a NASA key.
- Source labels currently name NASA in several places. Attribution must follow
  the actual source, including partial failures.

## Initial implementation plan

1. Inspect WFS schema, a bounded live sample, acquisition timestamps, spatial
   reference, units, record counts and use conditions.
2. Add both GOES time windows, a provider selector and source filters.
3. Introduce common source registration and combine the provider snapshots.
4. Carry sensor-specific metadata through rendering, selection and analytics.
5. Add unit, live acquisition and browser validation.

## Refined minimum scope

1. Use only the published 24-hour GOES product. Do not also ingest its overlapping
   ten-minute subset.
2. Add an explicit server-side opt-in. Fetch public data at runtime; bundle no
   third-party detections and add no npm dependencies or new map layer/token.
3. Keep the FIRMS fetch/cache path and add a separate bounded CONAE memory cache.
   Combine completed snapshots at the API boundary, with source identity and
   honest partial/unavailable/stale states.
4. Reuse existing rendering and selection. Preserve absent GOES confidence
   rather than mapping it to zero; keep unknown scientific measurements null.
5. Keep separate sensor observations rather than claiming event-level
   deduplication. Identify source and acquisition time and explain the spatial
   and temporal limits of the product.
6. Document enablement, attribution and validation; test relevant contracts and
   run the repository's required checks where execution is available.

Deferred: generic OGC browsing, arbitrary service URLs, provider UI controls,
event tracking, burned-area estimates, confidence conversion, persistence
analysis and other CONAE products.

## Source validation pending

The catalog and FAQ were readable from this session. The WFS root timed out and
bounded GetFeature/DescribeFeatureType requests could not be retrieved by the
web tool. This does not establish that the service is unavailable to other
clients. No field names, acquisition timezone or live schema have been assumed.

The managed development environment reports pending/offline with no execution
capabilities. A short, read-only CI probe in the contributor's branch is being
prepared to inspect the public service from another execution environment.
The probe is not a runtime integration or evidence of successful playback.

## Acceptance checks

- An observed WFS schema and sample support the parser's exact field mapping,
  time interpretation and measurement units.
- Malformed, non-point, invalid-position, missing-time, old and future records
  do not become current map detections. Empty data remains distinct from failure.
- Requests use fixed registered URLs, bounded bytes/records/time, redirect
  restrictions, a shared refresh and failure backoff.
- FIRMS-only behavior remains intact; CONAE-only and mixed snapshots preserve
  provenance and report partial failure.
- Absent confidence is absent in cards and analyst data. No missing value is
  described as a measured zero.
- Run format, format:check, check:boundaries, npm test, npm run build,
  npm run test:track and scripts/qa-firms.mjs as applicable.
