# Chester County, Pennsylvania incidents

Enable **Data Layers → Events → Chester County, PA incidents**, then choose
**View Chester County**. This layer includes all three public WebCAD tables:

- **Fire:** orange flame icon.
- **EMS:** red cross icon.
- **Traffic:** red/blue police-siren icon.

Each resolved report has its own marker labeled with the reported intersection
or address and **Approximate intersection**, **Approximate address**, or
**Approximate named place**. Selecting
a list item opens its details and flies to street scale. The card retains the
incident number/type, original location, municipality, dispatch time, and
station or agency. Times are labeled America/New_York. **County WebCAD** opens
the official source. Coverage remains Chester County, Pennsylvania only.

## How street placement works

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
hosting alone cannot provide the proxy. The route is `/api/chester-county-ems`, the layer id is
`chester-county-ems`, and share token `8` stores only enabled state. Selection is transient. The layer is off by default and
is intentionally outside the voice-query manifest.

While enabled, browser refresh is every 60 seconds (paused by the manager in
hidden tabs). The server shares in-flight work and permits at most one snapshot
attempt per 60 seconds, including failures. Source responses have byte caps and
two bounded 6-second attempts for transient transport errors or HTTP 502/503/504
(no immediate retry for HTTP 429); GIS resolution has an 8-second deadline per report, four workers,
and a 16-second aggregate location budget. Browser acquisition has a 45-second
deadline. Fixed endpoints only; redirects refused, GET only, no URL parameters.

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
  src/layers/chesterCountyEms/index.test.mjs
QA_BASE_URL=http://localhost:4177 node scripts/qa-chester-county-ems.mjs
```

The browser gate uses synthetic records only and checks all three categories,
list selection, mapping coverage, empty-snapshot clearing and disable. It writes
its screenshot to `qa-shots/chester-county-ems/selected.png`. Set
`QA_RECORDING_PATH` to an `.mp4` path to also record the interaction.

PR evidence uses only synthetic records: [screenshot](media/chester-county-incidents-synthetic.png)
and [demo recording](media/chester-county-incidents-demo.mp4) (2× playback).
