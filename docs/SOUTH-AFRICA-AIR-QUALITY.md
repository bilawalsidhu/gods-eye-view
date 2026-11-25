# South African air quality

The Weather → Air quality layer draws South Africa's SAAQIS stations with the
other observation networks (OpenAQ, India's CPCB) in one station set, on one
view at a time: the US AQI computed per station (the default, and the layer's
one index) or one pollutant. The South African provider needs no personal API
key, and
it is **off by default**: SAAQIS is read through the portal's own session API
and no reuse licence is established for it, so the server contacts the portal
only when the operator sets `SAAQIS_ENABLED=1` (in `.env`; see below). Without
it `/api/air-quality/south-africa` answers "not configured", no request is made,
and the layer leaves South Africa out with no card line and no failure.

## National scope and municipal coverage

The adapter discovers the complete SAAQIS national station catalog on every
uncached acquisition. It has no city, municipality, or province allowlist.
Moving the map to any municipality scopes its readout and labels to observations
in that view. A view without a reporting station counts 0 stations, lists none
in HIGHEST IN VIEW and its tiles read a dash. A reading is a station
observation, not a municipal average, and a nearby station outside the view is
not substituted.

This is national **access**, not a claim that every municipality is monitored.
SAAQIS identifies provinces and station coordinates, not authoritative municipal
membership. No municipality assignments are inferred from station names or
bounding rectangles. Municipal-boundary search and a completeness census of
municipalities would require a separately versioned current boundary dataset.

## Access and licensing

Run `node scripts/qa-south-africa-air-quality.mjs --live` for a timestamped
province and station audit, including Western Cape. Totals vary with reporting
time. The audit omits session credentials.

Primary references:

- [SAAQIS public portal](https://saaqis.environment.gov.za/)
- [Western Cape monitoring network](https://www.westerncape.gov.za/eadp/air-quality-management)
- [Cape Town monitoring and SAAQIS publication](https://www.capetown.gov.za/media-and-news/air-quality-monitoring-expanded-at-milnerton-lagoon/)
- [OpenAQ's South African acquisition documentation](https://github.com/openaq/openaq-fetch/blob/main/src/adapters/southafrica.js)

The portal is publicly accessible. No general open-data redistribution licence
has been identified. Attribute SAAQIS and each original
monitoring network. Do not describe the observations as MIT-licensed merely
because GEV's adapter code is MIT-licensed. Confirm applicable reuse terms with
the data owner before distributing a hosted archive or bulk exports.

## Measurement semantics

The pollutant views are PM2.5, PM10, NO2, SO2, O3 and CO, beside the US AQI
computed from them. Data is requested on the source's 60-minute timebase.
Readings keep their returned concentration units. To rate them, the layer
converts them once (`src/layers/airQuality/units.js`): mg/m³ to µg/m³, and gas
mixing ratios (ppb, ppm) to µg/m³ (CO to mg/m³) at 25 °C with the US EPA's
factors, for both the pollutant views and the US AQI. No regulatory exceedance
or emissions estimate is inferred.

Source-invalid and inactive channels, negative/null values, unsupported units,
implausibly future timestamps and readings older than six hours are excluded
from current display. Use each channel's timestamp before the enclosing station
timestamp. Unzoned source timestamps are interpreted as SAST (UTC+02:00). A
two-hour-old newest observation marks the layer stale using its freshness
policy.

Each view rates every station on one scale, so the readout ranks the stations
in view on it: by US AQI in the AQI view, and by EEA hourly category, then
concentration, in a pollutant view. Unrated stations come last, in name order.
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
  cancellation. Switching view clears the previous display and prevents late
  responses from replacing the current selection.
- `index.js` owns the lifecycle, Weather card, labels and analyst records.
  Camera movement regroups stations and redraws the field. When the timeline
  is at now, OpenAQ is asked for the new view 400 ms after the camera stops.
  The national providers (SAAQIS and CPCB) keep their snapshots.
- The share link carries the view only (the US AQI or one pollutant); whether
  stations are shown and the selected station are session state. There is no
  provider setting: every provider is read together.
- Off by default: `saaqisEnabled()` in `server/providers/southAfricaAirQuality.js`
  reads `SAAQIS_ENABLED`; only `1` switches the route on. The browser QA gate
  does not need it: it answers the route itself with synthetic snapshots, so it
  runs whether or not the variable is set.

On refresh failure, the server can return the last successful snapshot for up
to six hours, explicitly marked stale. The client checks observation ages again;
cache time never makes old observations current. A failed acquisition imposes
a one-minute retry cooldown. Requests are shared and bounded; a disconnected
client does not cancel another client's acquisition.

## Extending to another country

Add a provider definition to `createDefaultAirQualityProviders` (`providers.js`),
implement an injected source adapter, and add its parameter validation. Keep original
network identity, units, time semantics, quality flags and attribution. Separate
modelled estimates from observations. Preserve existing provider defaults and
share tokens; add fixtures for missing coverage, stale data, units and failures.

India's CPCB is already a provider on the same contract (`cpcb.js`).

## Validation

- Unit tests: `src/layers/airQuality/southAfrica.test.mjs` and
  `server/providers/southAfricaAirQuality.test.mjs`, plus existing layer tests.
- Deterministic real-app gate:
  `node scripts/qa-south-africa-air-quality.mjs` (dev server on port 4173).
- Optional live source audit: append `--live`.
- Repository gates: `npm test`, `npm run build`, `npm run test:track`,
  formatting, package boundaries, i18n and layer-token checks.

## Provider-reported index (not used)

The public SAAQIS portal publishes an index of its own (index type 1, 1–10,
from `stations/index/latest`). GEV neither requests nor shows it: the layer's
one index is the US AQI it computes from concentrations, and no network's own
index is used (the same rule retired Canada's AQHI). Station details state
hourly averaging, source, timestamp and provisional status.

## OpenAQ and CPCB

OpenAQ and India's CPCB use the keys `OPENAQ_API_KEY` and `DATA_GOV_IN_API_KEY`
in Provider Settings. SAAQIS needs no key. SAAQIS and CPCB cover their
countries. OpenAQ follows the map. Nearby copies from different providers match
one-to-one within 150 m. Reference monitors have priority, followed by rating on
the active scale, direct publication and recency. See
[acquisition and limits](CURRENT-STATE.md#air-quality) and
[attribution](../DATA_SOURCES.md).

## Injecting a provider

`createAirQualitySource({ providers })` replaces the full default catalog.
Its composite `getSnapshot({ provider, ...request })` requires a registered
provider ID and passes the remaining request fields to that provider’s source.
Each definition owns `id`, `title`, `label`, `network`, `sourceLabel`, `parameters`,
optional `requiresKeyId`, `direct`, `viewDriven` and `worldwide` (named first and
shown as Global), explanatory text and a source implementing
`getSnapshot({ parameter, mode, view, signal })`: one pollutant, or with
`mode: 'aqi'` every pollutant a station reports. Optional `getCoverage()` returns
coverage/progress metadata. Sources acquire and normalize. The layer owns
drawing, lifecycle, overlay labels and Weather-card descriptors. No browser/Node
imports belong in a portable source. Every definition is a station network; a
source without definitions is one network of its own, offering every view.
Duplicate/invalid definitions fail construction. Provider IDs are bounded
URL-safe identifiers; share links carry the view only, never a provider. Custom
pollutant serialization still uses the published supported-pollutant codec and
must be extended explicitly.

The snapshot adapter refuses redirects and accepts at most 50,000 readings. Set
`keyed: false` for a keyless route. Cached snapshots and coverage belong to the
source instance. Create a new source when switching accounts.

Example host composition (no renderer edits or new settings UI):

```js
const source = createAirQualitySource({ providers: [{
  id: 'community-network', title: 'Community', label: 'Community air quality',
  network: 'Community network',
  parameters: ['PM2.5'],
  source: communityObservationSource,
}] });
```

Validation: OpenAQ normalization/proxy/injection tests, existing setup and share
codec tests, `scripts/qa-openaq.mjs` (explicit synthetic fixtures, never writes
credentials), and the South African browser gate. Follow CONTRIBUTING.md for
full unit/build/tracking checks. See https://docs.openaq.org/using-the-api/api-key,
https://docs.openaq.org/using-the-api/rate-limits and
https://docs.openaq.org/api/operations/locations_get_v3_locations_get .
