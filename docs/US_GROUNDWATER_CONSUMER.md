# Water Wells consumer

The Infrastructure **Water Wells** layer streams historical well source records
prepared and hosted by Rainfolk. It uses GEV's ordinary standalone source assembly;
there is no preview launcher injection or query-string endpoint override. The
verified PR reconciliation baseline is GEV main `3ad3cc2ab773bb2d694a1e1605cf7ffe5d0dca46`.

## Data and interpretation

The default public release is:
`https://data.rainfolk.org/usgwd/e6dc61db1500b491671cf094602e2257814c5507e99618d717fbb4f6082d8291/index.json`.
It contains 12,452,285 mapped historical source records across all 50 states, from
14,260,581 retained records; 1,808,296 records have no admitted map position.
State presence does not imply complete
within-state coverage. These are source records, not independently surveyed or
deduplicated physical wells. Empty areas do not establish that no wells exist.

Original data is the United States Groundwater Well Database (USGWD), compiled
by Chung-Yi Lin, Alexandra Miller, Musab Waqar and Landon T. Marston from state
and federal agencies, including USGS. See [the paper](https://doi.org/10.1038/s41597-024-03186-3),
[HydroShare dataset](https://doi.org/10.4211/hs.8b02895f02c14dd1a749bcc5584a5c55)
and [CC BY 4.0 licence](https://creativecommons.org/licenses/by/4.0/).
Rainfolk normalizes fields, applies documented approximate datum conversions and
packages bounded spatial artifacts. Original IDs, acquisition hashes, dates and
flags remain attached. Public records can describe private/domestic wells;
ownership is not inferred per record. No private Rainfolk submissions are used.

## Run and configure

Use the ordinary GEV development workflow and open `http://localhost:4173`.
No well-data key is needed. Enable Water Wells and zoom below 50 km for individual
source-location points. Click a point for available depth, reported capacity,
screen dimensions or construction/report years; absent facts are omitted.
Coincident records keep their coordinates and use a small source-record chooser.
The application renders the layer row, keyboard record actions and coincident
chooser through the existing Vue/Pinia UI. The portable layer stays framework-free;
embedding hosts supply `recordUi.publishRecords(view)` and
`recordUi.publishChoices(view)` to present plain record labels and handlers. A null
view releases that surface. No Cesium entities are stored in Pinia.

Count grids remain internal. There are no numeric clusters, group panels or
automatic drilldown flights. Zooming out hides well detail; disabling clears it.
The row shows **Rainfolk** and elapsed time since this app accepted validated
data. That timer is not the observation date, publication date or live well status.

`VITE_RAINFOLK_WELLS_RELEASE` may select another explicitly verified published
release by its lowercase 64-character SHA-256. The provider origin remains fixed
at `https://data.rainfolk.org`; credentials, arbitrary provider origins, redirects, query
parameters and path escapes remain rejected. Unset selects the release above.
Restart development or rebuild the frontend after changing this public setting.
Merely uploading another prefix does not update existing clients. There is no
mutable `latest` or discovery endpoint in this contribution. A future stable
discovery mechanism is separate work, not a promised automatic refresh feature.

Embedding applications can replace the well source through
`createStandaloneLayerSources({ 'us-groundwater': source })` or application
catalog injection. `createBundledWellPackSource()` retains the six-site public
USGS fixture for offline tests and explicitly embedded consumers; it is not
merged into the default historical catalog. No national dataset is bundled.

## Network and host requirements

The consumer fetches `index.json`, viewport count chunks and nearby child/detail
packs. Hashes, declared byte lengths, population conservation, cancellation,
last-good retention, and bounded caches apply. Detail is limited to 2,000 records
and 16 MiB per view; unresolved detail is reported rather than invented.
A checksum establishes byte integrity, not factual location or current conditions.

The public feed permits credential-free cross-origin GET/HEAD with
`Access-Control-Allow-Origin: *`. Normal local origins are `http://localhost:4173`
and `http://127.0.0.1:4173`; custom ports, LAN hosts and external deployments do
not need individual origin entries for this feed. The consumer omits credentials;
any preflight for its Cache-Control request header must also succeed. These
read-only CORS permissions grant no upload, editing or deletion access.
The host CSP must permit `https://data.rainfolk.org` in connect-src. GEV's current
native CSP already permits HTTPS; this patch does not widen it or change CORS.

## Contribution checks

The unpublished well-layer token is **03**, the next free two-character token.
Published tokens **5**, **6** and **7** remain owned by S2 GhostMaps, Sea Marks
and Ski Pistes; on the merge-time published ledger every single-digit token
**0** through **9** is reserved, including **8** (Drone Airspace) and **9**
(Wildlife Sightings), and **00**, **01** and **02** belong to News, Shipwrecks
and Rail, so the next free token is **03**. Re-run
the allocator/checker against merge-time main.
Focused source/selection tests are beside the layer and application assembly.
The offline component browser gate is `scripts/qa-us-groundwater-offline.mjs`;
upstream also requires build, full unit suite, test:track, i18n, formatting and
boundary checks. Report actual outcomes and unrun browser gates in the PR.
A new-layer PR additionally requires globe/card screenshots and a short recording.
No upstream submission or data publication is implied by these instructions.

## Software and data notices

The upstream MIT notice remains unchanged. Copied Rainfolk source retains the
full [Rainfolk MIT notice](../LICENSES/Rainfolk-MIT.txt). Software MIT terms do
not relicense USGWD records; their CC BY 4.0 attribution, licence and modification
notice remain separate in DATA_SOURCES.md and the native credit display.

The [public-release source list](US_GROUNDWATER_SOURCES.md) records all 48 catalog partitions and the remaining agency-notice review limits.
