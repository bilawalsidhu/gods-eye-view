# County EMS

Enable **Data Layers → Events → County EMS**, then open
**COUNTY EMS** on the right rail. Its **View counties** action moves
the map to the supported counties. The right-side app holds the active list, coverage/freshness
status and county actions; Data Layers retains the layer toggle, standard feed
count and category filters. Disabling the layer hides the app and its launcher.
An enabled empty or failed feed keeps the app available, showing its empty/stale/error state.
The list updates from the existing feed without a separate polling loop.

Choose counties with the **County coverage** checkboxes in the app. Data Layers
contains the master layer switch and **Fire**, **EMS**, **Traffic** filters;
county selection is configured only in the app. WebCAD/source buttons have been
removed. Sources and freshness opens a read-only disclosure of per-county status.

| County, Pennsylvania | Published coverage | Map placement |
| --- | --- | --- |
| Chester | Active Fire/EMS/Traffic | County GIS street/address/place matching |
| Montgomery | Active Fire/EMS/Traffic | County-published map points |
| Lancaster | Active Fire/Medical/Traffic | Matching public LCWC map points |
| Delaware | Recent public Fire/EMS dispatch pages, active status unknown | Public community points when available |
| Dauphin | Active Fire/Medical/Traffic and controlled burns | List only; coordinates not published |
| Pike | Today's **completed** press reports | List only; off by default |
| York | Active Fire/EMS/Traffic | List only; coordinates not published |
| Adams | Active calls with explicitly classifiable Fire/EMS/Traffic natures | List only; coordinates not published |
| Lebanon | Recent pager summaries through 717 Alerts, active status unknown | Non-centroid published fire/traffic points only; EMS stays list only |

The category filters in Data Layers and the app stay in sync, filtering the map
and list together. All three categories start on. Traffic includes the source's
traffic/road reports; it is not a full police-call feed. County and category
choices are saved automatically in this browser profile and restored after
reloads, app restarts and device reboots, including groups with every option
unchecked. Shared links still carry only the layer on/off state; they do not
replace these local filter preferences. MCP queries the full combined source
with its own optional county/category filters. Excluding a selected report closes
its card and cancels its pending detail lookup. Selecting a report without
coordinates opens its public details and units inside the app, without moving
the camera to a guessed location. Pike's checkbox and reports explicitly say
completed; enabling it does not turn those reports into active incidents.

- **Fire:** orange flame icon.
- **EMS:** red cross icon.
- **Traffic:** red/blue police-siren icon.

Mapped reports show category icons only. Click an icon to open its card;
click empty map space to dismiss it. The app list can also select an incident and
fly to its location. The card shows labelled location/municipality fields,
incident number/type, dispatch time, station or agency, and the county's public
unit IDs, statuses and status-entry timestamps when available. Cards show up to eight public unit updates, with a link to the full county page.
Unit counts and a separate unit-status update time distinguish these details
from feed freshness.
Click the card's source link to open its published source page.
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
are not sent in location queries. Chester lookup does not use a commercial geocoder; Lebanon can use points already published by 717 Alerts, which identifies its own geocoder.

## Setup and lifecycle

No API key is required. Use `npm run dev` or build and preview. Static file
hosting alone cannot provide the proxy. The combined route is `/api/county-ems`, the layer id is
`chester-county-ems`, and share token `03` stores only enabled state. Selection is transient. The layer is off by default and
supports voice visibility controls through County EMS, each supported county name and the existing Chester aliases.
MCP and voice share the dedicated queries described below.

While enabled, browser refresh is every 60 seconds (paused by the manager in
hidden tabs). The server shares in-flight work and permits at most one snapshot
attempt per 60 seconds for Chester, Delco, Adams and Lebanon; 120 seconds for Montgomery and Lancaster; and 240 seconds for Dauphin, Pike and York, including failures. Chester source responses have byte caps and
two bounded 6-second attempts for transient transport errors or HTTP 502/503/504
(no immediate retry for HTTP 429); GIS resolution has an 8-second deadline per report, four workers,
and a 16-second aggregate location budget. Browser acquisition has a 45-second
deadline. Fixed endpoints only; redirects refused, GET only. The snapshot accepts no URL parameters.

Selecting an incident loads `/api/county-ems/details?incident=<id>`.
Only validated detail links from the current snapshot can be fetched; client-supplied
URLs are never accepted. Chester and Montgomery details use their existing shared 60-second caches and
four-request concurrency caps. York fetches only the selected current report's
opaque public details link and caches its assigned units for a minute. Lancaster,
Delco, Dauphin, Pike and Lebanon expose assignments already in the summary;
Adams returns the source's public unit movements from the cached snapshot.
Source reads have deadlines and body/row limits. HTML becomes plain-text fields,
never executable markup. IDs absent from the current snapshot return 404.
No private dispatch notes, patient records or inferred unit information are added.
Selection changes and disable cancel client requests; late replies cannot repaint.

Resolved locations cache in memory for 24 hours; unmatched names for five minutes,
failed lookups for one minute,
with a 512-entry limit. No background fetch, disk archive or incident history.
GIS result truncation, oversized responses and out-of-county coordinates are
rejected. A GIS failure does not discard reports. Lookup failures are reported as degraded coverage; successful queries with no
match remain fresh and explicitly unresolved. A valid empty snapshot clears old reports;
malformed source tables and transport failures preserve last-good reports as
stale. Chester and Adams/Lebanon clocks older than three minutes are stale; slower public lists use source-specific freshness windows. Retrieval-only feeds label their check time rather than inventing a source update time. Future clocks beyond one minute are stale. The offset-less autumn repeated hour uses the earlier valid instant.

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
including county checkboxes only in the app, synchronized category changes from both surfaces, list-only public units and opt-in completed-report labels,
actual icon selection, public unit fields, mapping coverage, empty-snapshot clearing and disable. It writes
its screenshot to `qa-shots/chester-county-ems/selected.png`. Set
`QA_RECORDING_PATH` to a `.webm` path to also record the interaction.
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
A county outage preserves its cached reports as stale and leaves other
counties' feeds usable. The Sources and freshness disclosure shows separate county clocks and availability.
No source incident archive is kept.

The county [publishes an RSS feed for readers and aggregators](https://www.montgomerycountypa.gov/departments/department-public-safety/webcad-active-incidents/webcad-incident-status-rss-feed).
No open redistribution licence was identified for the HTML or GIS view.
County records load at runtime; the repository includes synthetic test data only.

## Lancaster County, Pennsylvania

Lancaster uses the [official LCWC incident list](https://www.lcwc911.us/live-incident-list)
and the public Fire/EMS/Traffic map layers embedded by its
[official live map](https://www.lcwc911.us/live-incident-map).
Public map records must have IsPublic=1 and match the list's category, type,
municipality, intersection and dispatch minute. Unmatched list reports remain
available without a guessed point; ambiguous matches have no pin.

The list publishes assigned units, without movement statuses or status-entry
times. Cards label them as assignments and show when the source was checked.
No dates or unit movements are invented. Reports without a published incident
number are labelled Public report; their stable internal summary identity is
not presented as an official incident number. Source reads share a two-minute
cache, deadlines, response caps and last-good recovery.

## Delaware County, Pennsylvania — community paging

[Delco Dispatch](https://delcodispat.ch/d/pa/delco) is a community paging source.
It does not establish whether a call remains active or has closed. County EMS
therefore labels every Delco report **Recent dispatch; active status unknown**.

The adapter reads only the newest API page, at most 20 public messages within
two hours, without following archive pagination. Duplicate pages for the same
incident/category merge assigned unit names. Pages flagged private are excluded.
Raw messages, notes, apartment/suite fields and radio/capcode metadata are not
forwarded. Only published public coordinates inside the county safety bounds
are used; no location geocoding or patient-data enrichment is performed.

Received times are interpreted as Eastern time because the source publishes
local times without a zone; cards and AI results disclose that assumption.
Assigned units have no movement statuses or status-entry times. Counts cover
the limited recent-page window, not all county incidents. Fetch/check times
are retrieval times. A one-minute shared cache retains last-good data marked
stale on failure.

Neither source publishes an open redistribution licence identified by this
integration. Attribution stays with LCWC / County of Lancaster and Delco
Dispatch respectively; records load at runtime and only synthetic fixtures
are bundled.

## Dauphin, Pike, York and Adams, Pennsylvania

[Dauphin WebCAD](https://dpswebcad.dauphincounty.gov/webcad/) publishes event time,
municipality, street, cross streets and event type/subtype. Its clock is labelled
Reported, because the page does not identify that field as dispatch time. No
incident number, coordinates or units are invented.

[Pike's public press feed](https://webcad.pikepa.org/pages/public/FeedReader.asp)
is explicitly a completed-incidents list. The adapter requests only the current
Eastern date, with no archive crawl or protected WebCAD access. It retains the
published incident number, time received, location and assigned units. Pike is
off by default and every report is marked completed. No completion time is inferred.

[York's active list](https://ycdes.org/webcad/default.aspx) retains the published
box, street, cross street, nearest intersection and location fields. Dispatch
minutes remain minute precision. Clicking a current report fetches only its
listed opaque Details.aspx link, returning assigned unit IDs/descriptions without
invented movement times. No map coordinates are published by this source.

[Adams' active calls](https://incidents.adamscountypa.gov/) use the same public
/api/calls snapshot as the county page. Monitoring must be active with no system
error or degraded-data flag, even for an empty response. Otherwise the last good
snapshot is stale. Nature prefixes explicitly identifying Fire, EMS/Medical or
MVA/Traffic/Road Closure determine category; unrecognized natures are excluded
and counted in source metadata. Created times are labelled Reported. Public
unit statuses use clear/arrival/enroute precedence and retain full source dates.
This integration has synthetic tests for populated calls; the live Adams probe
returned a healthy empty list, so a populated live response remains unverified.

These public sources retain county attribution. No open redistribution licence
was identified. Source records load at runtime only; fixtures and evidence are
synthetic. Missing published coordinates are distinct from failed GIS lookups.

## Lebanon County, Pennsylvania — recent pager summaries

[Lebanon DES monitor](https://www.lcdes.org/monitor.html) is a public pager feed;
[717 Alerts](https://717alerts.com/county/lebanon) is the provided alternate.
The adapter uses the public live snapshot called by 717 Alerts, without a key or
account, because direct Node HTTPS to the DES monitor currently fails certificate
chain validation. TLS verification stays enabled. A change to the alternate's
public endpoint/schema fails closed and preserves stale last-good data.

Only Lebanon summaries within two hours are retained, excluding source-resolved
and redacted rows, with duplicate public report keys collapsed. Pager summaries
do not prove active status and are labelled accordingly. 717-assigned report
numbers are not presented as official county incident numbers. Received times
use the alternate's epoch value and disclose the source's Eastern interpretation.
No raw narratives, notes, audio or pager messages are forwarded. Assigned units
have no movement timestamps. EMS positions and municipality-centroid geocodes
are excluded; other published non-centroid points remain approximate.

Attribution: Lebanon County DES pager via independent 717 Alerts. The alternate's
[terms](https://717alerts.com/terms) describe a public information aggregator;
no open redistribution licence was identified. No live dataset is bundled.

## AI and MCP queries

- get_county_incidents: queries the supported sources, with optional county
  (chester-pa, montgomery-pa, lancaster-pa, delaware-pa, dauphin-pa, pike-pa, york-pa, adams-pa, lebanon-pa), category, municipality, text and limit filters.
  It includes county identity, per-county health, source clocks and unresolved reports.
- get_county_incident_details: accepts an ID from that list and returns public
  unit statuses. Montgomery IDs include a montgomery-pa prefix to avoid collisions.
  Unit timestamps without a date retain their reported time text and null UTC date.
  Assignment-only sources have no movement times; community results identify
  the community source, unknown active status, receipt-time assumption and limited window. Pike results explicitly return completed-report / completed status. Dauphin/Adams reported times are separate from dispatch times.
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

Supported sources are registered explicitly; adding a public URL alone does not enable an unreviewed source.


## Saved filter preferences

County checkboxes and Fire/EMS/Traffic filters use the browser-local key
gev:county-ems:filters:v1. Only the two filter ID arrays are stored; selections,
incident records, locations and unit details stay transient. Direct user/voice/tool
filter changes save only the changed group. Temporary scene or passive restore
changes do not overwrite saved choices. Existing profiles without saved filters
start with all categories and all counties except Pike selected. Malformed
preferences fall back safely. If browser storage is blocked, controls still work
for the current session. Use the same browser profile and app URL after restarting.
