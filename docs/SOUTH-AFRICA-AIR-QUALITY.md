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
