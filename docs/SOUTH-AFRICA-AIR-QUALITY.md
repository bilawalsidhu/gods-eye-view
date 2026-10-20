# South African air quality

The existing Weather → Air quality layer now offers Canada (ECCC AQHI) and
South Africa (SAAQIS). Canada remains the default so existing share links retain
their meaning. The South African provider needs no personal API key.

## National scope and municipal coverage

The adapter discovers the complete SAAQIS national station catalog on every
uncached acquisition. It has no city, municipality, or province allowlist.
Moving the map to any municipality scopes its readout and labels to observations
in that view. Municipalities without a reporting station show an explicit
no-observations message. A reading is a station observation, not a municipal
average, and a nearby station outside the view is not substituted.

This is national **access**, not a claim that every municipality is monitored.
SAAQIS identifies provinces and station coordinates, not authoritative municipal
membership. No municipality assignments are inferred from station names or
bounding rectangles. Municipal-boundary search and a completeness census of
municipalities would require a separately versioned current boundary dataset.
An inspected DFFE boundary service contained April 2011 boundaries; it was not
used to label current municipalities.

## Access verification — 20 October 2026

Live HTTPS requests, with certificate verification enabled, confirmed:

- SAAQIS's public anonymous session endpoint returns a short-lived token and
  session cookie. The public `regions` and bulk `regions/data/latest` requests
  work through the portal's `/api` endpoint.
- The catalog contained 235 uniquely identified stations with usable names and
  coordinates across all nine provinces.
  The Western Cape raw catalog had 31 entries; 26 had recent valid observations
  for at least one supported pollutant in the initial audit. Counts vary with
  reporting time and normalization.
- The repeatable normalized audit at 05:43 UTC retained 235 stations and found
  110 reporting at least one supported pollutant within six hours. Free State
  had no qualifying recent measurements at that time. That is a data gap, not
  evidence of clean air.
- The OpenAQ v3 locations endpoint returned HTTP 401 without an API key. No
  OpenAQ key was configured. Authenticated South African OpenAQ coverage was
  therefore **not verified**, and OpenAQ is not used as a hidden fallback.

Run `node scripts/qa-south-africa-air-quality.mjs --live` for a new timestamped
province/station audit, including a Western Cape station list. It prints no
session credentials. Totals should not be pinned in tests.

Normalized snapshot at 05:43 UTC (any supported pollutant within six hours):

| Province | Catalog stations | Reporting stations |
|---|---:|---:|
| Eastern Cape | 12 | 6 |
| Free State | 7 | 0 |
| Gauteng | 47 | 11 |
| KwaZulu-Natal | 37 | 15 |
| Limpopo | 26 | 15 |
| Mpumalanga | 40 | 23 |
| North West | 29 | 13 |
| Northern Cape | 6 | 1 |
| Western Cape | 31 | 26 |

Primary references:

- [SAAQIS public portal](https://saaqis.environment.gov.za/)
- [Western Cape monitoring network](https://www.westerncape.gov.za/eadp/air-quality-management)
- [Cape Town monitoring and SAAQIS publication](https://www.capetown.gov.za/media-and-news/air-quality-monitoring-expanded-at-milnerton-lagoon/)
- [OpenAQ's South African acquisition documentation](https://github.com/openaq/openaq-fetch/blob/main/src/adapters/southafrica.js)
- [OpenAQ authentication](https://docs.openaq.org/using-the-api/quick-start)

The public portal is technically accessible; a general open-data redistribution
licence was not identified during this audit. Attribute SAAQIS and each original
monitoring network. Do not describe the observations as MIT-licensed merely
because GEV's adapter code is MIT-licensed. Confirm applicable reuse terms with
the data owner before distributing a hosted archive or bulk exports.

## Measurement semantics

The pollutant selector supports PM2.5, PM10, NO2, SO2, O3, CO, CO2, NO, NOX and
H2S where valid source readings exist. Data is requested on the source's
60-minute timebase. Preserve returned concentration units; no mass/mixing-ratio
conversion, AQI conversion, risk category, regulatory exceedance or emissions
estimate is inferred.

CO2 here is a concentration, not tonnes of CO2 emitted. Source-invalid and
inactive channels, negative/null values, unsupported units, implausibly future
timestamps and readings older than six hours are excluded from current display.
Use each channel's timestamp before the enclosing station timestamp. Unzoned
source timestamps are interpreted as SAST (UTC+02:00). A two-hour-old newest
observation marks the layer stale using its existing freshness policy.

Neutral markers and labels avoid suggesting AQHI health bands. The readout
lists stations in view alphabetically, rather than ranking incomparable units.
Analyst records preserve pollutant, units, averaging period, network owner,
observation time and observation kind.

## Architecture and operations

- `southAfrica.js`: pure catalog/measurement normalization and freshness rules.
- `server/providers/southAfricaAirQuality.js`: fixed upstream URLs, private
  anonymous sessions, strict TLS, 45-second total request deadline, 8 MiB body
  cap, bounded catalogs/channels, coalesced acquisition, 20-minute memory cache.
- `/api/air-quality/south-africa`: GET-only national snapshot, in development
  and built preview. No arbitrary upstream URL or credential is accepted.
- `providers.js`: injected source composition, bounded client response and
  cancellation. Switching provider/pollutant clears the previous display and
  prevents late responses from replacing the current selection.
- `index.js`: existing layer lifecycle, shared Weather card controls, in-view
  label cohort, disposal and analyst records. Camera movement updates presentation
  without requesting upstream data or rebuilding station entities.
- Existing share token `4` is unchanged. Provider and pollutant are serialized;
  absent provider options retain the historical Canada default.

On refresh failure, the server can return the last successful snapshot for up
to six hours, explicitly marked stale. The client checks observation ages again;
cache time never makes old observations current. A failed acquisition imposes
a one-minute retry cooldown. Requests are shared and bounded; a disconnected
client does not cancel another client's acquisition.

## Extending to another country

Register a provider descriptor in `AIR_QUALITY_PROVIDERS`, implement an injected
source adapter, and add its composition and parameter validation. Keep original
network identity, units, time semantics, quality flags and attribution. Separate
modelled estimates from observations. Preserve existing provider defaults and
share tokens; add fixtures for missing coverage, stale data, units and failures.

Coordinate further provider UI work with upstream PR #1204 (India CPCB), and
query-tool integration with issue #1213. Neither branch is imported here.

## Validation

- Unit tests: `src/layers/airQuality/southAfrica.test.mjs` and
  `server/providers/southAfricaAirQuality.test.mjs`, plus existing layer tests.
- Deterministic real-app gate:
  `node scripts/qa-south-africa-air-quality.mjs` (dev server on port 4173).
- Optional live source audit: append `--live`.
- Repository gates: `npm test`, `npm run build`, `npm run test:track`,
  formatting, package boundaries, i18n and layer-token checks.

## Provider-reported index (verified 20 October 2026)

The public SAAQIS portal publishes `IndexValAndColorString` for index type 1:
1–3 Good (green), 4–5 Moderate (yellow), 6–7 Unhealthy (orange),
8–9 Very Unhealthy (red), 10 Hazardous (purple).
Its public `Scripts/modules/StationModule.js` requests
`stations/index/latest`; we verified `stations/index/latest?hoursBack=6`
through the same anonymous portal session. The payload supplies station
`datetime` and per-pollutant `indexes` with numeric index and description.
This is a source-reported index, not a locally calculated WHO or US EPA index.
A complete calculation-method document has not been verified. In particular,
`PollutantTimeBase: 0` is not interpreted as an averaging duration.

GEV joins a rating only to the identical station, pollutant and observation
 timestamp, validates integer scores 1–10 and the published category, and keeps
concentrations separate from index scores. Unsupported scales, mismatches,
missing ratings and sentinel values stay neutral with an explicit unavailable
badge. Index endpoint failure does not discard concentrations. CO2 does not
inherit another pollutant's rating. The legend identifies the SAAQIS method;
category text accompanies colour, and station details state hourly averaging,
source, timestamp and provisional status. Existing observation freshness rules
continue to apply to rated observations.

Primary references: https://saaqis.environment.gov.za/ and
https://saaqis.environment.gov.za/Scripts/modules/StationModule.js .

## OpenAQ Africa and provider extension

OpenAQ is an optional observation provider in the same Air quality card. Open
**POWER UP → OPENAQ**, follow its free registration link, paste the private key
and save. This uses the existing `KEY_SETUP_KEYS` registry and local settings
write/restart path. The variable is `OPENAQ_API_KEY`; it is never client-exposed.
Provider Settings remains development/loopback-only. Preview and other hosts use
environment configuration. No credential is needed for ECCC or SAAQIS.

The standalone defaults offer Canada, South Africa and Africa/OpenAQ. The latter
uses a configured UN M49 Africa country/area scope, including island territories,
with OpenAQ's countries and paginated locations APIs. There is no city or station
allowlist. The regional acquisition factory accepts a different scope without
changing normalization or rendering. This does not imply monitors exist in every
country or municipality. Live coverage cannot be verified without an account key.

Requests are demand-driven while enabled: up to 24 stations per refresh, shared
60-second cache and in-flight coalescing, at most 45 requests/minute and 1,800/hour
in this server process. Other installations sharing a key also consume its quota.
HTTP 429 respects Retry-After; authentication failures remain explicit. Catalog
refresh is hourly. Stations with catalog timestamps older than six hours are
excluded from the current sweep; their return is discovered on catalog refresh.
The card distinguishes catalog size, recent stations checked, countries reporting
and incomplete loading. No upstream polling continues after the layer is disabled.
A batch already in flight may finish. Last-good data on transient errors is marked
stale; observations older than six hours are omitted at every client read.

OpenAQ supplies concentrations, not ratings. Records retain original units,
network/owner, licences, observation time and unknown averaging duration. A
SAAQIS station may also be distributed through OpenAQ: providers are alternatives,
not summed together or advertised as independent coverage. Actual overlap needs
an authenticated audit; no heuristic merges unrelated stations by proximity.

### Injecting a provider

`createAirQualitySource({ providers })` replaces the full default catalog.
Each definition owns `id`, `title`, `label`, `network`, `coverage`, `sourceLabel`,
`parameters`, `observation`, optional `legend`, explanatory text and a source
implementing `getSnapshot({ parameter, signal })`. Optional `getCoverage()` returns
coverage/progress metadata. Sources acquire and normalize; the existing layer owns
Cesium, lifecycle, overlay labels and Weather-card descriptors. No browser/Node
imports belong in a portable source. A legacy source without definitions remains
ECCC-only. Duplicate/invalid definitions fail construction. Provider IDs are
bounded URL-safe identifiers; share links preserve custom IDs with an extension
encoding while old ECCC/SAAQIS aliases retain their meaning. A host must supply the
corresponding definition to use such a link. Custom pollutant serialization still
uses the published supported-pollutant codec and must be extended explicitly.

Example host composition (no renderer edits or new settings UI):

```js
const source = createAirQualitySource({ providers: [{
  id: 'community-network', title: 'Community', label: 'Community air quality',
  network: 'Community network', coverage: 'Regional observations',
  observation: true, parameters: ['PM2.5'], legend: [],
  source: communityObservationSource,
}] });
```

Validation: OpenAQ normalization/proxy/injection tests, existing setup and share
codec tests, `scripts/qa-openaq.mjs` (explicit synthetic fixtures, never writes
credentials), and the South African browser gate. Follow CONTRIBUTING.md for
full unit/build/tracking checks. See https://docs.openaq.org/using-the-api/api-key,
https://docs.openaq.org/using-the-api/rate-limits and
https://docs.openaq.org/api/operations/locations_get_v3_locations_get .
