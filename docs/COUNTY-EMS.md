# County EMS

Enable **Data Layers → Events → County EMS**, then open
**COUNTY EMS** on the right rail. Its **View counties** action moves
the map to the supported counties. The right-side app holds the active list, coverage/freshness
status and county actions; Data Layers retains the layer toggle, standard feed
count and category filters. Disabling the layer hides the app and its launcher.
An enabled empty or failed feed keeps the app available, showing its empty/stale/error state.
The list updates from the existing feed without a separate polling loop.

The **Chester County, PA** and **Montgomery County, PA** buttons choose county coverage. They stay in sync between Data Layers and the app, with both counties enabled initially. Every row and card identifies its county.

The **Fire**, **EMS** and **Police / traffic** toggles in Data Layers and the
app stay in sync and filter the map icons and active list together. All three
start on. Police / traffic corresponds to the public WebCAD Traffic table,
not a complete police-call feed. The app shows
matching/total counts; switching every category off keeps the app available with
**No matching incidents**. Excluding the selected report closes its map card and
cancels its pending detail lookup. Filters apply in the current app session;
MCP can query the full public feed or apply its own category filter.

Both counties publish public Fire, EMS and Traffic reports:

- **Fire:** orange flame icon.
- **EMS:** red cross icon.
- **Traffic:** red/blue police-siren icon.

Resolved reports show category icons only. Click an icon to open its card;
click empty map space to dismiss it. The app list can also select an incident and
fly to its location. The card shows labelled location/municipality fields,
incident number/type, dispatch time, station or agency, and the county's public
unit IDs, statuses and status-entry timestamps when available. Cards show up to eight public unit updates, with a link to the full county page.
Unit counts and a separate unit-status update time distinguish these details
from feed freshness.
Click the card's source link to open that incident's official county page.
Times are labelled America/New_York. Coverage is limited to supported county sources.

Repeated approximate-intersection/address/place tags are omitted from icons,
cards and list entries. The layer-level notice and matching limitations below
still explain that GIS positions are approximate. Source locations and documented
GIS name corrections remain visible; no scene coordinates are invented.

## Chester County street placement

WebCAD does not supply coordinates. The server queries the county's own GIS:

1. For `ROAD A & ROAD B` (or `/`), look up those named roads within the reported
   municipality, including roads on its boundary. Normalize documented spelling
   differences such as AV/AVE, LA/LN, HW/HWY and WY/WAY. An omitted directional
   prefix may match a directional road, but a supplied N/S/E/W must agree.
2. Accept endpoints within three meters only when their road-level codes agree.
   A geometric crossing alone is insufficient: this avoids treating overpasses
   as junctions. Multiple junction nodes within 60 meters can form an approximate
   divided-road intersection; more distant alternatives remain unresolved.
3. For a numbered address, require the supplied number, matching street and
   municipality in county Site Address Points. Apartment/unit text does not
   change the building position. Multiple address points farther than 20 meters
   apart are ambiguous and remain unresolved.

4. For a place-only description, query county Common Place primary, nonsensitive
   records in the same municipality. Accept the exact name or its CONDOS,
   CONDOMINIUMS or APARTMENTS suffix only when one name and one position agree.
   This is named-place precision, never an inferred address.
5. After an exact intersection miss, one documented correction applies only to
   Valley Forge Rd / Yellow Springs Rd in Tredyffrin Township: query Valley Creek
   Rd / Yellow Springs Rd. The card shows the GIS match alongside the original
   report. No global road rename or fuzzy nearest-road substitution is used.

**All matched positions remain approximate.** Matching does not establish the
exact dispatch scene, entrance, vehicle position, or which side of a road is
involved. Source errors, street aliases absent from GIS, partial roads, missing
cross streets and place-only descriptions can remain unresolved. Those reports
stay in the incident list with **No location match**, without a map pin.
Actual GIS request failures instead show **Location lookup failed**. Coverage
counts distinguish mapped, unresolved and lookup errors; only lookup errors
degrade an otherwise fresh feed. Unresolved names alone do not indicate outage.
Unresolved reports never fall back to municipality-center pins.

Only road/place names, address numbers and municipality qualifiers are sent to the
county GIS service. Medical descriptions, incident IDs and station identifiers
are not sent in location queries. No commercial geocoder is used.

## Setup and lifecycle

No API key is required. Use `npm run dev` or build and preview. Static file
hosting alone cannot provide the proxy. The combined route is `/api/county-ems`, the layer id is
`chester-county-ems`, and share token `8` stores only enabled state. Selection is transient. The layer is off by default and
supports voice visibility controls through “County EMS”, “Montgomery County EMS” and the existing Chester aliases.
MCP and voice share the dedicated queries described below.

While enabled, browser refresh is every 60 seconds (paused by the manager in
hidden tabs). The server shares in-flight work and permits at most one snapshot
attempt per 60 seconds for Chester and 120 seconds for Montgomery, including failures. Chester source responses have byte caps and
two bounded 6-second attempts for transient transport errors or HTTP 502/503/504
(no immediate retry for HTTP 429); GIS resolution has an 8-second deadline per report, four workers,
and a 16-second aggregate location budget. Browser acquisition has a 45-second
deadline. Fixed endpoints only; redirects refused, GET only. The snapshot accepts no URL parameters.

Selecting an incident loads `/api/county-ems/details?incident=<id>`.
Only validated detail links from the active snapshot can be fetched; client-supplied
URLs are never accepted. Details load on demand, with a shared 60-second per-incident
cache/cooldown, at most four concurrent requests, 128 cached incidents, a six-second
upstream deadline for Chester (ten seconds for Montgomery) and a 256 KB body cap. Detail HTML becomes bounded plain-text unit
fields; it is never forwarded or executed. IDs absent from the shared snapshot return 404.
Unit lookup failures preserve the summary and mark retained unit details stale,
without changing the main feed's health. Empty public status tables are shown as
such; no private dispatch notes, patient records or inferred unit information is added.
Selection changes and disable cancel client requests; late replies cannot repaint.

Resolved locations cache in memory for 24 hours; unmatched names for five minutes,
failed lookups for one minute,
with a 512-entry limit. No background fetch, disk archive or incident history.
GIS result truncation, oversized responses and out-of-county coordinates are
rejected. A GIS failure does not discard reports. Lookup failures are reported as degraded coverage; successful queries with no
match remain fresh and explicitly unresolved. A valid empty snapshot clears old reports;
malformed source tables and transport failures preserve last-good reports as
stale. A source clock older than three minutes or over one minute in the future
is stale. The offset-less autumn repeated hour uses the earlier valid instant.

## Sources and rights

- [Chester County DES WebCAD](https://www.chesco.org/3963/WebCad-Active-Incidents):
  public reports, county copyright, no open redistribution license identified.
- [Road Centerlines](https://services.arcgis.com/G4S1dGvn7PIgYd6Y/arcgis/rest/services/Road_Centerlines/FeatureServer/0)
  and [Site Address Points](https://services.arcgis.com/G4S1dGvn7PIgYd6Y/arcgis/rest/services/Site_Address_Points/FeatureServer/0):
  © Chester County GIS. Their item metadata links CC BY-NC-SA 3.0. Approximate
  matched positions are derived data subject to those terms, not the MIT code
  license. See `DATA_SOURCES.md` for item metadata links.

- [County Common Place](https://services.arcgis.com/G4S1dGvn7PIgYd6Y/arcgis/rest/services/Common_Place/FeatureServer/1):
  © Chester County GIS; no open license identified in item metadata.
- Junction correction evidence: the [township agenda](https://www.tredyffrin.org/files/assets/township/v/1/document-central/meeting-agendas/board-of-supervisors-agendas/2025-bos-agendas/11052025-bos-public-meeting-agenda.pdf)
  uses Valley Forge / Yellow Springs; [NPS Knox Bridge](https://www.nps.gov/places/knox-covered-bridge.htm)
  identifies Yellow Springs / Route 252 (Valley Creek). County GIS confirms
  shared level-zero road endpoints.

All data loads at runtime. No live reports or GIS dataset ship in the repository.
The code is MIT-licensed; source records and derived GIS locations retain their
separate terms. Respect incident-data rights and GIS noncommercial/share-alike
terms when operating or sharing an instance.

## Code and validation

- `server/providers/chesterCountyEms/parser.js`: strict three-table parsing and
  timezone conversion; category-qualified identities avoid fire/EMS collisions.
- `server/providers/chesterCountyEms/locations.js`: county road/address matching,
  ambiguity rejection and bounded cache.
- `server/providers/chesterCountyEms.js`: on-demand proxy and snapshot lifecycle.
- `src/layers/chesterCountyEms/`: source, colored SVG billboards, shared world
  overlay labels/cards, store-driven list controls and lifecycle tests.

```sh
node --import=./build/registerVue.js --test \
  server/providers/chesterCountyEms.test.mjs \
  server/providers/chesterCountyEms/locations.test.mjs \
  src/layers/chesterCountyEms/index.test.mjs \
  src/ui/chesterCountyPanel.test.mjs
QA_BASE_URL=http://localhost:4177 node scripts/qa-chester-county-ems.mjs
```

The browser gate uses synthetic records only and checks all three categories,
including synchronized changes from Data Layers and the county app,
actual icon selection, public unit fields, mapping coverage, empty-snapshot clearing and disable. It writes
its screenshot to `qa-shots/chester-county-ems/selected.png`. Set
`QA_RECORDING_PATH` to an `.mp4` path to also record the interaction.
For installed Brave on macOS, `PUPPETEER_EXECUTABLE_PATH` can select its binary
and `QA_BROWSER_ANGLE=metal` can use the native renderer for the capture.

PR evidence uses only synthetic records: [screenshot](media/chester-county-incidents-synthetic.png)
and [demo recording](media/chester-county-incidents-demo.mp4) (synthetic recording).

## Montgomery County, Pennsylvania

Montgomery uses the county's complete [WebCAD list](https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp)
and the read-only [Active CAD Incidents map layer](https://gis.montcopa.org/arcgis/rest/services/Hosted/Montgomery_County_Active_CAD_Incidents_View/FeatureServer/0).
The HTML list preserves reports omitted from the county-scoped map. Coordinates
are used only when incident identity, location and municipality match the active
report and fall within the county map's published safety bounds. They are
county-published approximate positions, not Chester GIS matches or exact scenes.
Unmatched reports remain in the list.

The source is refreshed on demand at most once per two minutes; the county
describes a five-minute CAD publication interval. Its public unit fragment is
loaded only for a selected active incident, with a minute cache, bounded bodies,
deadlines and a four-request concurrency cap. Unit times omit dates: the card
retains the original clock text and labels the check time as retrieval time.
A county outage preserves its cached reports as stale and leaves the other
county's feed usable. The app shows separate county clocks and availability.
No source incident archive is kept.

The county [publishes an RSS feed for readers and aggregators](https://www.montgomerycountypa.gov/departments/department-public-safety/webcad-active-incidents/webcad-incident-status-rss-feed).
No open redistribution licence was identified for the HTML or GIS view.
County records load at runtime; the repository includes synthetic test data only.

## AI and MCP queries

- get_county_incidents: queries both counties, with optional county
  (chester-pa, montgomery-pa), category, municipality, text and limit filters.
  It includes county identity, per-county health, source clocks and unresolved reports.
- get_county_incident_details: accepts an ID from that list and returns public
  unit statuses. Montgomery IDs include a montgomery-pa prefix to avoid collisions.
  Unit timestamps without a date retain their reported time text and null UTC date.
- The existing Chester-specific tools and /api/chester-county-ems stay scoped
  to Chester for compatibility. The combined source uses /api/county-ems.
  The internal layer ID and enabled-only share token remain unchanged.

The older tools remain available:

- `get_chester_county_incidents`: lists the county DES public feed, including
  unmapped reports. Optional `category` (`fire`, `ems`, `traffic`), municipality,
  text search and `limit` filters keep answers bounded. Results carry dispatch
  times, source freshness, mapping coverage, approximate GIS positions or null,
  and a suggested view that enables this layer.
- `get_chester_county_incident_details`: takes a returned category-qualified
  `id` (for example `ems:F26000001`) and reads that active report's public unit
  IDs, statuses and entry timestamps. Unavailable unit data preserves the report
  with `details_available: false`; stale unit status is distinct from feed age.

Listing tools makes no source requests. Calling a query uses the same local
proxy, minute caches and source limits as the map, even if the browser layer is
currently off. No point is invented for unresolved reports, and no patient
records or private dispatch notes are exposed. The spatial analyst engine does
not count these reports as geolocated entities; voice uses the dedicated tools
so unresolved reports remain included. Reconnect an existing MCP/voice session
to load the updated tool list.

## Adding another county

Register its stable ID, public source name and official URL in
src/layers/chesterCountyEms/counties.js. Implement bounded snapshot and optional
public-detail adapters under server/providers/countyEms/, then register them in
createCountyFeeds. Qualify incident IDs with the county, retain unmapped rows,
expose independent freshness/failure state, and document source terms. The
county filter and generic MCP county enum read the shared county catalog.

[Lancaster County's official live list](https://www.lcwc911.us/live-incident-list)
is a candidate for a later adapter; it is not included in the current coverage.
