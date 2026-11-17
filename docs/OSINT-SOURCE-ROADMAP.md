# OSINT Source Expansion Roadmap

**Status:** research baseline; no new provider adapter is enabled by this document.  
**Research date:** 2026-11-17  
**Target:** Gods-eye-view (GEV), globe-first public-source OSINT and anomaly context.

## 1. Scope and operating principles

Expand GEV with reproducible, public, source-attributed context for geopolitical events, military-related public activity, maritime and aviation patterns, environmental anomalies, GNSS integrity, and satellite-observed change.

This is an analytical and documentary system, not a tactical command-and-control tool. New work should prioritize historical, delayed, regional, and aggregated signals. Do not add person tracking, private-data collection, targeting workflows, weapon guidance, or features that expose sensitive real-time locations or routes of individual military units. A source observation is not proof of an operation.

Every source adapter must:
- be read-only by default and use documented public APIs or permitted downloads;
- keep credentials server-side, never in browser bundles, source files, fixtures, screenshots, logs, or commits;
- preserve raw response metadata separately from normalized records;
- record source ID, retrieval time, event time, request parameters, source URL, licence/terms, and freshness;
- use bounded requests, response-size limits, timeouts, pagination, caching, retry/backoff, and provider rate limits;
- preserve null/unknown values; never convert missing data into a negative observation;
- show source health, staleness, coverage gaps, and attribution in the UI;
- distinguish observation, source assertion, analyst inference, and conclusion.

## 2. Existing capabilities found upstream

The current upstream source register already documents substantial coverage. Avoid duplicating these integrations:
- OpenSky Network and adsb.lol for public ADS-B flight context and GNSS integrity indicators;
- AISStream for live AIS vessel observations;
- CelesTrak for satellite catalog/TLE data;
- NASA GIBS and CMR/HLS for imagery discovery and visualization;
- NASA FIRMS for active-fire detections;
- GDELT for event/news context;
- USGS for earthquakes;
- GDACS for disaster alerts;
- NOAA weather products, OpenStreetMap, IMF PortWatch, and the existing conflict/news layer;
- the existing military-aircraft layer and GNSS layer.

Existing code seams worth reusing:
- `src/layers/airQuality/source.js`: currently ECCC AQHI; add OpenAQ as an additional provider, not a replacement.
- `src/layers/gnss/source.js`: currently obtains aircraft-reported GNSS integrity through the same-origin proxy; add space-weather context independently.
- `src/layers/military/`: existing public aircraft layer; do not create a second military-flight poller.
- `src/layers/news/`: existing news/event ingestion; use it for source-backed conflict context rather than inventing a parallel headline feed.
- `src/data/analystEngine.js`: pure query engine over data already held by layers; extend through its existing manifest/record seam rather than adding hidden network calls.

## 3. Recommended additional sources

| Priority | Source | Access / cost | Useful signal | Important limitation |
| --- | --- | --- | --- | --- |
| P0 | NOAA SWPC JSON | Public, keyless | Solar flares, geomagnetic activity, Kp and alerts; correlate with GNSS quality anomalies | Space-weather context only; never proof of jamming or military action |
| P0 | UCDP GED | Free downloadable datasets, CC BY 4.0; API token requested from maintainer, 5,000 requests/day | Georeferenced organized-violence events and historical baselines | Event coding, publication lag, and dataset definitions matter; cite codebook and version |
| P1 | Copernicus Data Space STAC / OData | Free registered account with published quotas | Sentinel-1 SAR and Sentinel-2 imagery for retrospective change detection and corroboration | Large data volumes; cloud, revisit, processing and licensing constraints; not a live feed |
| P1 | OpenAQ API v3 | Free API key; 60 requests/minute and 2,000/hour | Air-quality observations as environmental context around reported events | Sensor coverage and provider-specific data licences vary; pollution is not attribution |
| P1 | Global Fishing Watch | Free API key; non-commercial CC BY-NC 4.0; 50,000 requests/day and 1,500,000/month | Aggregated fishing activity, vessel encounters and possible AIS-dark activity as maritime context | Non-commercial only; fishing coverage is not comprehensive maritime or military coverage |
| P2 | ACLED | myACLED account and OAuth-based API access | Event-level political violence and demonstrations for cross-checking | Confirm current eligibility, redistribution and commercial terms before implementation |
| P2 | ReliefWeb API | Approved appname required | Humanitarian reports, disaster and conflict situation reporting | Appname approval and publisher rights; contextual reporting, not a sensor feed |
| P2 | Official defence / alliance / UN publications | Public RSS/pages where available | Primary-source announcements, exercises, deployments and official statements | Publisher-controlled formats; source assertions must not be treated as independently verified facts |

### Primary documentation

- NOAA SWPC data directory: https://services.swpc.noaa.gov/products/
- UCDP downloads and licensing: https://ucdp.uu.se/downloads/
- UCDP API documentation: https://ucdp.uu.se/apidocs/
- Copernicus STAC documentation: https://documentation.dataspace.copernicus.eu/APIs/STAC.html
- Copernicus quotas: https://documentation.dataspace.copernicus.eu/Quotas.html
- OpenAQ API key: https://docs.openaq.org/using-the-api/api-key
- OpenAQ rate limits: https://docs.openaq.org/using-the-api/rate-limits
- Global Fishing Watch API: https://api-doc.globalfishingwatch.org/
- Global Fishing Watch terms and limits: https://globalfishingwatch.org/our-apis/documentation/docs/license-rate-limits
- ACLED API access: https://acleddata.com/api-documentation/getting-started
- ReliefWeb API: https://apidoc.reliefweb.int/

## 4. Proposed integration sequence

### Phase A — source health and provenance (no new map layer)
1. Add a provider registry with stable IDs, endpoint families, auth mode, licence, attribution, polling class, cache TTL, and data sensitivity.
2. Add a source-health view: last success, last failure, response age, quota/backoff state, and coverage caveat.
3. Add a common provenance envelope to all new normalized records.
4. Add synthetic fixtures and schema/contract tests before enabling network calls.

### Phase B — low-cost contextual feeds
1. Add NOAA SWPC as a GNSS context provider, separate from aircraft-reported integrity facts.
2. Add OpenAQ as a second air-quality provider behind the existing air-quality source interface.
3. Add UCDP GED as a versioned, historical conflict-event dataset. Prefer a downloadable, checksummed release for the first iteration; add API access only after token handling and paging tests.

### Phase C — imagery and maritime context
1. Add Copernicus STAC discovery first; do not automatically download full scenes. Record product IDs, acquisition time, platform, orbit direction, polarisation, cloud cover where applicable, footprint and asset links.
2. Build a user-requested, retrospective image-comparison workflow with baseline/after dates, change masks and explicit uncertainty. Do not create a real-time facility-monitoring or tactical targeting workflow.
3. Evaluate Global Fishing Watch only for non-commercial, aggregated maritime context after terms review and API key setup.

### Phase D — corroboration and analyst workflow
1. Correlate event records across independent source families (news/event data, official statements, satellite observations, environment, and public movement aggregates).
2. Track source lineage so syndicated stories and derivative datasets are not counted as independent corroboration.
3. Maintain a claim ledger with supporting and contradictory evidence, source locators, confidence, caveats and status.
4. Keep analyst conclusions separate from raw detections and provider classifications.

## 5. Anomaly model

Use named anomaly classes, not a single opaque "military activity score":

- `ENVIRONMENTAL_ANOMALY`: unusual fire, air-quality, seismic, or weather observation relative to local baseline.
- `GNSS_QUALITY_ANOMALY`: unusual aircraft-reported integrity or positioning-quality indicators.
- `SPACE_WEATHER_CONTEXT`: geomagnetic/solar conditions that may explain GNSS degradation; context, not causal attribution.
- `MARITIME_PATTERN_ANOMALY`: aggregate changes in public vessel/fishing activity or data availability.
- `AVIATION_ACTIVITY_ANOMALY`: regional aggregate changes in public aviation observations, with explicit coverage and classification uncertainty.
- `CONFLICT_EVENT_REPORT`: source-reported event from UCDP, GDELT, ACLED or an official publication.
- `SATELLITE_CHANGE_CANDIDATE`: retrospective image difference requiring human review and independent corroboration.

Each anomaly should include:
`anomaly_id`, `class`, `observed_at`, `event_time_start`, `event_time_end`, `geometry`, `spatial_resolution`, `source_ids`, `evidence_ids`, `baseline_window`, `observed_value`, `expected_range`, `confidence`, `alternative_explanations`, `freshness`, and `review_status`.

Confidence must not be computed by simply counting sources. Score source independence, provenance, temporal alignment, spatial precision, known coverage, and contradictory evidence. Missing observations must remain "unknown", never "normal".

## 6. Credential and privacy handling

The credentials previously pasted into a chat should be treated as exposed and rotated at the provider. Do not copy them into this repository.

Suggested server-side secret names after rotation:
- `FIRMS_MAP_KEY`
- `OPENAQ_API_KEY`
- `NASA_EARTHDATA_TOKEN` (short-lived token only; prefer the provider-supported authentication flow)
- `UCDP_API_TOKEN`
- `GFW_API_TOKEN`
- Copernicus OAuth client credentials stored only in the deployment secret manager.

Only placeholder names belong in `.env.example`. Never put actual values in GitHub Actions, client-side `VITE_*` variables, test fixtures, or logs. Use least privilege, rotation, bounded access and redaction.

## 7. Acceptance tests

Before a provider is enabled:
- schema validation rejects malformed, oversized, duplicate and out-of-range records;
- tests cover empty, partial, stale, delayed, rate-limited and unavailable responses;
- time fields distinguish provider event time, publication time and retrieval time;
- geographic coordinates, units, datum and timezone are normalized explicitly;
- attribution and source terms are present in the source register and UI;
- credentials are not present in browser bundles, fixtures, logs or Git history;
- raw inputs are preserved immutably with retrieval metadata and hashes;
- synthetic tests demonstrate that one source failure cannot blank unrelated layers;
- correlation tests include contradictory evidence and alternative explanations;
- Android/Termux remains able to run the unit tests and build without requiring paid services.

## 8. Decision

Implement NOAA SWPC, OpenAQ and UCDP first. They add distinct explanatory value while fitting existing GEV layer seams. Treat Copernicus STAC and Global Fishing Watch as the next research integrations, gated by account setup, quota and licence review. ACLED and ReliefWeb remain optional until access and reuse terms are confirmed.

This roadmap is a research/design artifact. It does not claim that any new provider has been connected, that the credentials have been rotated, or that runtime integration tests have passed.


## 8. Upstream synchronization review (2026-11-17)

The previous source-roadmap pull request was merged into `main`. A fresh comparison against upstream confirms that the fork contains the upstream snapshot at `624c229bc2a86fc1e47ed34c95fc7cefa2ac1676`; the fork's current main is a descendant of that snapshot. The three-commit comparison result is the fork's merge/roadmap history, not three missing upstream commits. Do not re-import the same upstream history.

The upstream snapshot includes these changes relevant to GEV:
- **Lifecycle cleanup:** launch and satellite layers unregister their world-clock sources on destroy and register on init. Keep the regression test pattern used by the earthquakes layer.
- **Renderer basemap contract:** basemap changes are routed through the globe/renderer port. New map providers should use that contract rather than calling Cesium directly.
- **Flight and vessel context previews:** entity cards can use renderer-owned previews. Keep rendering resources scoped to card visibility and dispose auxiliary contexts when cards close.
- **Voice action override:** application-provided `voice.openStories({ isCurrent })` takes precedence over the default Stories page behavior.

The upstream PR descriptions report successful tests/builds for the relevant changes, but this audit did not execute those tests locally. The fork's merged sync PR #1 was a very large update; a passing GitHub mergeability result is not a substitute for local validation. Run the repository's documented test, format, boundary, library, build, stub-renderer and conformance gates before a production release.

## 9. New source candidates and source-contract cautions

### Additional candidates

- **Global Energy Monitor (GEM):** open-access downloadable datasets describing energy infrastructure and resources. Useful as a static strategic-infrastructure baseline and for retrospective context. This is not a live activity feed. Review the licence and attribution attached to each specific dataset before bundling or redistributing it: https://globalenergymonitor.org/download-data/
- **OpenSanctions:** useful for carefully sourced entity-resolution and sanctions-context lookups, not for identifying military operations. Hosted API access requires an API key; public-interest work may qualify for a free key, while commercial API use is metered/paid. Treat this as access-gated, not a generally unlimited free API. Never auto-screen incidental people from live map observations; use only deliberate analyst-initiated entity research with false-match warnings: https://www.opensanctions.org/docs/api/ and https://www.opensanctions.org/docs/api/authentication/

### NOAA SWPC contract update

NOAA's SWPC data service exposes products, JSON, text and archive endpoints. Its 2026 service-change notice announced JSON format changes for several products, including planetary K-index and solar-wind magnetic-field summaries. Before implementing the SWPC adapter:
1. Pin the exact product endpoint(s) and document their current schema.
2. Preserve source timestamps and distinguish observed values from forecasts/alerts.
3. Add fixtures for both valid and malformed/changed payloads.
4. Reject unknown schema shapes rather than silently interpreting them.
5. Keep space-weather conditions as a contextual covariate, never as proof of GNSS interference or intentional action.

Official documentation: https://www.spaceweather.gov/content/data-access and https://www.weather.gov/media/notification/pdf_2026/scn26-21_Data_Format_Changes_Impacting_SWPC_Products.pdf

## 10. Implementation backlog and acceptance gates

The following are implementation tasks, not completed runtime integrations:

| ID | Work | Priority | Acceptance gate |
| --- | --- | --- | --- |
| GEV-OSINT-01 | Add provider-neutral provenance envelope and source-health status contract | P0 | Unit tests for missing timestamps, stale data, failed fetches, rate limits and unknown fields |
| GEV-OSINT-02 | Add NOAA SWPC context provider through server-side proxy | P0 | Pinned JSON fixtures, schema drift tests, no client secret, clear observation/forecast labels |
| GEV-OSINT-03 | Add OpenAQ as an additive provider to the existing air-quality source | P1 | Existing ECCC behavior unchanged; key remains server-side; provider attribution and sensor licence surfaced |
| GEV-OSINT-04 | Import versioned UCDP GED snapshots with checksums and codebook metadata | P1 | Reproducible import, source version recorded, duplicate/event-time tests, CC BY attribution |
| GEV-OSINT-05 | Add Copernicus STAC metadata discovery | P1 | OAuth kept server-side; bounded paging; metadata-only default; no automatic full-scene downloads |
| GEV-OSINT-06 | Evaluate GEM static infrastructure packs | P2 | Dataset-by-dataset licence review; version, download date, checksum and attribution |
| GEV-OSINT-07 | Evaluate OpenSanctions deliberate lookup workflow | P2 | Confirm public-interest eligibility and API terms; explicit user action; entity match score and false-positive caveat |
| GEV-OSINT-08 | Evaluate Global Fishing Watch aggregated historical maritime context | P2 | Non-commercial terms gate; no individual-vessel operational tracking or tactical use |

No item above is marked implemented by this documentation change. The next code change should be the P0 provenance/source-health contract and SWPC adapter, not a new standalone map layer. Reuse existing layer and server-provider seams, keep secrets server-side, and add synthetic tests before any live provider is enabled.
