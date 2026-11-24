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

The pollutant views are PM2.5, PM10, NO2, SO2, O3 and CO, beside the US AQI
computed from them; CO2, NO, NOX and H2S readings are normalized from the same
snapshot but no view shows them. Data is requested on the source's 60-minute
timebase. Readings keep their returned concentration units. To rate
them, the layer converts them once (`src/layers/airQuality/units.js`): mg/m³
to µg/m³, and gas mixing ratios (ppb, ppm) to µg/m³ (CO to mg/m³) at 25 °C
with the US EPA's factors, for both the pollutant views and the US AQI. No
regulatory exceedance or emissions estimate is inferred.

CO2 here is a concentration, not tonnes of CO2 emitted. Source-invalid and
inactive channels, negative/null values, unsupported units, implausibly future
timestamps and readings older than six hours are excluded from current display.
Use each channel's timestamp before the enclosing station timestamp. Unzoned
source timestamps are interpreted as SAST (UTC+02:00). A two-hour-old newest
observation marks the layer stale using its existing freshness policy.

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
- `index.js`: existing layer lifecycle, shared Weather card controls, in-view
  label cohort, disposal and analyst records. Camera movement updates presentation
  without requesting upstream data or rebuilding station entities.
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

## Worldwide OpenAQ and provider extension

OpenAQ is an optional observation provider in the same Air quality card. Open
**POWER UP → OPENAQ**, follow its free registration link, paste the private key
and save. This uses the existing `KEY_SETUP_KEYS` registry and local settings
write/restart path. The variable is `OPENAQ_API_KEY`; it is never client-exposed.
Provider Settings remains development/loopback-only. Preview and other hosts use
environment configuration. No credential is needed for SAAQIS.

The standalone defaults compose South Africa, India and worldwide OpenAQ,
drawn together as one station set; Canada's stations come through OpenAQ. The OpenAQ default has no country, city or station allowlist. The map requests the
visible geographic bounds and focus point through the fixed local proxy. OpenAQ
location discovery starts within five degrees of the focus, then paginates the
whole visible rectangle, splitting dateline crossings. Each pass spends at most
one uncached catalog request and checks up to four nearby stations (two concurrent
hourly requests). Stable geographic catalog regions, including completed covering
regions, are reused for one hour, with at most 64 cached pages. Nearby pans reuse
observations and wait at least eight seconds before further enrichment. Progressive
refreshes yield when 16 requests remain in the minute budget so a new region can
still get initial readings. Camera movement is debounced by 400 ms. Cancelling the
last consumer of a view cancels its upstream work; coalesced active consumers keep
running. An unresolved camera waits for geographic bounds instead of triggering a
global scan.

The server coalesces identical views, retains up to eight view caches for one hour,
and permits at most two distinct view acquisitions concurrently. A bounded cache
of up to 5,000 station checks reuses results for 20 minutes across overlapping views,
and supplies known observations even after view-cache eviction or during cooldown.
View caches and background/global callers share a conservative 45/minute,
1,800/hour process budget. Provider remaining/reset headers and numeric or HTTP-date
Retry-After can impose an earlier stop or longer cooldown. Other clients using the
same key still consume its provider quota. The card says when a network's
request budget is reached or it shows cached data, and, while OpenAQ is still
discovering a view, how many of its stations it has checked ("loading stations,
n of m"); it retains cached observations and retries when the cooldown expires.
A key OpenAQ refuses is said to be rejected on the card, and the server does not
send it upstream again until it changes or ten minutes pass. While the tab is
hidden the discovery loop waits. Timers
are cancelled on navigation, provider changes, disable and destroy. Loading,
partial discovery, failed/stale refreshes, and completed searches with no recent
readings remain distinct. SAAQIS and CPCB stay national providers; OpenAQ
discovery follows the map.

Hosts calling the proxy without a viewport retain global acquisition. Its locations
catalog is paginated incrementally (eight pages per refresh), with cursor state
retained between refreshes; there is no regional ten-page truncation. The same
acquisition factory still accepts an explicit country scope, including the Africa
configuration, for hosts that want a regional deployment.

Global observations use the documented parameter/latest endpoints instead of one
request per station. Supported parameter IDs are discovered from the API, and
pagination rotates between pollutants (up to 16 requests per refresh). Values join
the location catalog by location and sensor IDs, retaining original attribution.
Newly discovered locations appear as subsequent observation sweeps reach them.
A 60-second cache and coalesced requests share a 45/minute, 1,800/hour process
budget; other installations using the same key also consume its quota. HTTP 429
respects Retry-After. The catalog refreshes hourly; the existing catalog remains
available while the replacement is discovered. A defensive 100,000-station memory
limit fails explicitly rather than silently truncating coverage. Local snapshots
allow up to 64 MiB; each upstream page remains capped at 8 MiB.

The card reports stations with observations, recent catalog stations, countries
reporting and incomplete loading. Discovery is demand-driven while the layer is
enabled; disabling the viewport layer cancels its remaining acquisition. Transient errors expose
last-good data as stale. Observations older than six hours are removed. Worldwide
availability does not mean every country or city has a current monitor.

SAAQIS remains a national provider: the [South African government describes its
scope as South Africa](https://www.gov.za/news/media-statements/south-african-air-quality-information-systems-saaqis-launched-department).
Its adapter already discovers all returned regions, not a Western Cape allowlist.
No worldwide SAAQIS network was found.

OpenAQ supplies concentrations, not ratings. Viewport requests now include the
selected pollutant and fetch `/sensors/{id}/hours` for that sensor instead of an
unqualified latest value. The same eight-station acquisition cap applies; this
replaces the latest request rather than adding a second request per station.
Caches include the pollutant so changing tabs cannot reuse another pollutant's
observations. Records retain original units, network/owner, licences and the
explicit hour start/end, coverage and quality flag.

GEV compares valid hourly means for PM2.5, PM10, NO2, O3 and SO2 with the
[revised EEA hourly pollutant bands](https://airindex.eea.europa.eu/AQI/).
This is a **calculated comparison for one pollutant**, not an EEA station index,
local official index, regulatory compliance test or a claim about an entire city.
Decimal concentrations use inclusive upper bounds without rounding down. Gas
mixing ratios (ppb, ppm) convert to µg/m³ at 25 °C (`units.js`, the same
conversion as the US AQI); particle mixing ratios and unknown units stay
unrated. For OpenAQ hours GEV requires a closed
one-hour period, 100% hourly coverage and an explicit unflagged source result;
missing quality/coverage, unsupported pollutants and unknown averaging periods
remain neutral with an explanation. Readings older than six hours are excluded;
readings older than two hours are visibly marked older observations.

The shared Weather card is the slim tile card: its HIGHEST IN VIEW list ranks
the visible reporting stations on the view's scale, one line each, with the
station's details (and its originating network and licence) as the row's
tooltip, under a ramp legend. Categories appear as text and colour in the map
labels and tiles; the general and sensitive-population guidance stays on the
assessment in analyst records. The portable `interpretation.js` module keeps thresholds and per-pollutant semantics
out of the generic UI. The legend is the view's one scale: the EEA bands of
the selected pollutant, or the US AQI categories. No provider-reported rating
is shown. CO2 concentration is explicitly distinguished from an emissions rate.
A SAAQIS station may also be distributed through OpenAQ: two readings from
different providers within 150 m are one site (`merge.js`), and the one rated on
the view's scale, then the direct network's (SAAQIS), then the newer, is kept.

### Injecting a provider

`createAirQualitySource({ providers })` replaces the full default catalog.
Each definition owns `id`, `title`, `label`, `network`, `coverage`, `sourceLabel`,
`parameters`, optional `requiresKeyId`, `direct` and `viewDriven`, explanatory
text and a source implementing
`getSnapshot({ parameter, mode, view, signal })`: one pollutant, or with
`mode: 'aqi'` every pollutant a station reports. Optional `getCoverage()` returns
coverage/progress metadata. Sources acquire and normalize; the existing layer owns
Cesium, lifecycle, overlay labels and Weather-card descriptors. No browser/Node
imports belong in a portable source. Every definition is a station network; a
source without definitions is one network of its own, offering every view.
Duplicate/invalid definitions fail construction. Provider IDs are bounded
URL-safe identifiers; share links carry the view only, never a provider. Custom
pollutant serialization still uses the published supported-pollutant codec and
must be extended explicitly.

Example host composition (no renderer edits or new settings UI):

```js
const source = createAirQualitySource({ providers: [{
  id: 'community-network', title: 'Community', label: 'Community air quality',
  network: 'Community network', coverage: 'Regional observations',
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

### Authenticated worldwide audit — 20 October 2026

A private operator key was registered, verified and saved through the existing
Provider Settings endpoint. The countries API returned 159 catalog entries.
The progressive global audit discovered 25,965 supported stations and
17,291 recent pollutant records at 7,623 distinct stations in
113 countries/areas at this snapshot. Catalog discovery was complete;
observation pagination was still partial. These are observed counts, not promised
coverage. African results included South Africa, Uganda, Nigeria, Ghana, Kenya,
Senegal, Cameroon, Egypt, Morocco and Tanzania. Source network attribution is
retained; these figures do not establish independent coverage from SAAQIS.

Live testing found that a listed parameter can return HTTP 404 from its latest
endpoint. That feed is treated as unavailable without discarding other pollutants.
Transient request failures retain successful observations with stale/partial flags;
authentication failures remain explicit. Regression tests cover these cases.

Validation: 8,240 unit tests passed (one skipped), allocation gates passed,
production build passed, OpenAQ and SAAQIS browser gates passed, and the tracking
gate passed 109/109 on a fresh development server. An earlier tracking attempt
hit Vite's stale optimized-dependency HTTP 504; rebuilding dependencies resolved
it without changes to aircraft code. Formatting, translations and package
boundaries passed. The private key was absent from tracked files and built assets.
