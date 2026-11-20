# Ports & terminals — NGA World Port Index (issue #1779)

The **Ports & terminals** layer is an opt-in global *reference* map of ports
from the US National Geospatial-Intelligence Agency (NGA), World Port Index
(Pub 150). Toggle it under **Infrastructure**. Select a marker to read its
stable WPI number, name, country code, UN/LOCODE if present, and facility
availability. The panel offers country and positive-only container, solid
bulk, oil-terminal and LNG-terminal filters.

## Provenance and reuse

- Original publisher: [NGA World Port Index](https://msi.nga.mil/Publications/WPI).
- Secondary *government-hosted mirror*: [US Department of Energy, National
  Energy Technology Laboratory (NETL), ArcGIS layer
  17](https://arcgis.netl.doe.gov/server/rest/services/Hosted/CCS_EJ_SJ_Data/FeatureServer/17).
- [NGA WPI explanations](https://msi.nga.mil/Publications/WPI) describe
  underlying field semantics.
- [NGA public-information policy](https://www.nga.mil/resources/Privacy_Policy.html)
  and [NETL disclaimer](https://netl.doe.gov/home/disclaimer).
- Dataset URLs, publisher, and origin are always credited in the application's
  Data Attribution panel. Government agencies do not endorse this software.

**Separate clocks.** `mirrorLastEditAt` is the NETL layer's reported edit
timestamp (when available), `retrievedAt` is when this server retrieved its
snapshot, and `ngaPublicationDate` is explicitly null because this mirror
does not authenticate which NGA edition is published. Never label the mirror
timestamp as NGA's release date or assert that a listed port is currently
operating.

## Technical behavior

The GEV server retrieves WPI at runtime from the fixed NETL origin, through
`GET /api/ports`; browser clients cannot choose the upstream URL. ArcGIS
queries use WGS84 GeoJSON, selected fields only, `objectid ASC`, and ordered
offset pagination at 1,000 features/page. Every page is bounded to 4 MiB and
a 15-second timeout. There are at most 8 pages. The service validates
monotonically increasing `objectid` values and rejects repeated WPI IDs.
A terminating short page means `complete: true`; an exhausted cap is
`partial: true` with visible warnings and response header
`X-Data-Partial: true`. It does not claim missing ports have no facility.

Successful snapshots are cached for 24 hours, with a retry backoff and
a seven-day maximum stale retention. When a refresh fails, cached results
are marked stale and eventually expire; a cold-start fetch failure yields
HTTP 502 rather than an empty or made-up dataset. The client limits response
bytes and can cancel ongoing requests; disabling or destroying the layer
prevents a late response from redrawing. The registry token `03` shares
*the layer enabled state only*; country and facility filters are
session-local and intentionally omitted from share links.

## Facility semantics and commercial coverage

Only explicit Yes, Y, true, or numeric 1 means facility present. No, N,
false, or numeric 0 means absent in WPI; blanks, placeholders and unsupported
values mean *unknown*. Facility filtering includes confirmed affirmative
values only. A null is never inferred to mean No. WPI does not provide
verified, comprehensive current ownership, annual throughput, cargo
handling capacity, operational status or expansions. Every missing
commercial field is explicitly **Unavailable** in the card.

No port-wide throughput is assigned to a terminal; no reported proposed
capacity is treated as currently operating. A future enrichment should be
a separate, reviewed set of facts with WPI ID matching, source URL, unit,
reporting period, geographic scope, publication and review dates per field.

## Validation

- `node --test src/layers/ports/records.test.mjs`
- `node --test src/layers/ports/index.test.mjs`
- `node --test server/providers/ports.test.mjs`
- `npm run format:check`, `npm run check:boundaries`, `npm test`,
  `npm run build`

This implementation does not provide routing, navigational advice, live
terminal status or verified comprehensive port-commercial data.
