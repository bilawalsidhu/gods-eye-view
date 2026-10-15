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

## Source contract and verification

The contributor supplied a GeoJSON response fetched from the published WFS on
2026-10-15; its server timestamp is `2026-10-15T04:45:32.946Z`. The bounded
sample returned two of 103 matching observations. Only field names and
synthetic records using this schema are stored in tests.

| WFS field                                          | Meaning / normalization                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `geometry.coordinates`                             | Point in WGS84, longitude then latitude; agrees with the sample's duplicate `Longitud` / `Latitud` properties                            |
| `Fecha_Local_UTC-3`                                | `YYYY-MM-DD HH:mm:ss` in the explicitly named UTC-3 offset; add three hours to obtain UTC, independent of the host timezone              |
| `Satelite`                                         | Observed `GOES19`; normalize to `GOES-19`                                                                                                |
| `Fire_Radiative_Power`                             | FRP in MW, consistent with the official FAQ; missing/negative/non-numeric values remain null                                             |
| Confidence, brightness, day/night                  | Not supplied by this product; do not infer a measured value                                                                              |
| `totalFeatures`, `numberMatched`, `numberReturned` | Check completeness; the two-feature inspection sample is deliberately incomplete and must not be used as the application's full snapshot |

For example, local `2026-10-14 21:20:00` represents
`2026-10-15T00:20:00Z`. The response timestamp describes the HTTP response;
it must not replace a detection's acquisition time. GeoServer feature IDs are
not stable detection identities; selection uses provider, satellite, position
and acquisition time.

The catalog and FAQ were readable in this session. Direct WFS requests timed
out both through the web tool and a GitHub-hosted runner
(`UND_ERR_CONNECT_TIMEOUT`). The supplied sample confirms the source schema;
it does not establish prolonged availability or successful acquisition from
every deployment. The runtime reports this failure instead of manufacturing
empty coverage. The sample's newest acquisition is several hours older than
the response; cache refresh cadence does not guarantee satellite-data latency.

## Operation

Set `CONAE_GOES_ENABLED=1` in the server environment or checkout's `.env` and
restart the dev/preview server. Then enable the existing Active Fires layer.
No browser-exposed key, layer token, new toggle or npm dependency is introduced.

- Without a FIRMS key, only CONAE is requested; NASA `status.hasKey` remains false.
- With a FIRMS key, independent provider snapshots are combined. Separate
  satellite/acquisition observations are retained, including repeat views of
  the same location. Counts refer to observations, not unique fire incidents.
- CONAE's fixed 24-hour product includes detections relevant to Argentina.
  The integration follows the product's returned extent, not a political
  country mask. Coverage and reporting latency are controlled by CONAE.
- CONAE has a 10-minute in-memory cache, a shared refresh, a 20-second request
  timeout and a 60-second failure backoff. It never writes to the FIRMS disk cache.
- The WFS request asks for at most 50,001 records so the 50,000-record ceiling can
  be detected. HTTP bodies are limited to 32 MiB. Known incomplete responses,
  unsupported CRS, malformed collections and invalid rows fail closed, preserving
  a previous snapshot when available. A valid empty collection is different
  from a failed download.
- Cached detections are re-filtered at serve time to the last 24 hours, with a
  10-minute allowance for clock skew. An unavailable provider can yield a stale
  snapshot or a partial combined result; total failure returns HTTP 502.
- Existing FIRMS polling, sequential upstream acquisition, key handling and
  30-minute memory/disk cache stay in place.
- Selected GOES cards say thermal detection and identify CONAE; confidence is
  not published. Mixed/GOES aggregate cells say detections. Marker size and
  color reuse the layer's visual heuristics, not a scientific severity score.
  Satellite pixel centers and repeated detections must not be read as precise
  ground locations, fire perimeters or damage estimates.

The official catalog publishes these services for use, but no product-specific
redistribution license was established. This change fetches data at runtime,
bundles no CONAE detections and does not describe the data as MIT/CC0.
Attribution is recorded in `DATA_SOURCES.md` and the app's Data attribution
popover. Operators should check the provider's current terms for their use.

## Reproducible validation

Run `node scripts/check-conae-goes.mjs` from the target server to exercise the
real bounded request, parser and freshness filter. It prints a source name,
count and timestamps, with no API key. A successful empty result establishes
service access but does not establish current fire detections.

Unit tests use synthetic observations and do not contact CONAE or consume NASA
quota. They cover UTC-3 rollover, invalid dates/positions, missing measurements,
truncation, body limits, concurrency, cache expiry, failure backoff, opt-out,
CONAE-only operation, mixed sources, total failure, source identity, cards,
selection context and the fire query tool.

`node scripts/qa-firms.mjs --url http://localhost:4173 --fixtures` covers the
existing FIRMS rendering/selection states plus a keyless GOES observation in
the actual app. Fixture/browser success is not live-source acceptance.

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
