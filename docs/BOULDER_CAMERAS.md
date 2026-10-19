# Optional Boulder Area cameras

[`config/cctv_sources.boulder.json`](../config/cctv_sources.boulder.json) is an
opt-in example for the existing `CCTV_SOURCES_FILE` contract: **36 independently
addressable views, comprising 10 City of Boulder HLS streams and 26 Boulder
County Parks & Open Space still images at seven county sites**. “Boulder Area”
is regional coverage, not a municipal-boundary claim. City operation does not
mean a site lies within Boulder city limits. Locality labels distinguish Superior,
Hygiene/Longmont/Broomfield vicinity and the Boulder foothills.

No default source pack, browser player or security limit is changed. The server's
bounded HLS relay can fall back to lower-bandwidth renditions advertised by the
registered master when a child playlist or capped segment download fails; it
retains working quality and all existing byte, session and timeout limits.
This file contains URL references and descriptive/location metadata, **not footage,
recordings, posters or image captures**. It is not a complete camera census.

## Enable explicitly

After reviewing the source terms below, add to your ignored repository-root
`.env` and restart the local development server:

```dotenv
CCTV_SOURCES_FILE=config/cctv_sources.boulder.json
CCTV_FORCE_AUSTIN=0
```

Clear an existing `CCTV_SOURCES_JSON` if you want only this file's entries.
Relative file paths resolve against the provider's `sourceRoot` (normally the
application root), not the browser URL. The catalog caches results for 15 minutes;
a browser reload alone does not necessarily reload the file.

A nonempty file or inline catalog **suppresses the live packs** unless
`CCTV_FORCE_AUSTIN=1`. Despite its historical name, that flag lets **all enabled
live packs** load alongside the file, not just Austin. Individual kill switches
and opt-in flags still apply (it does not opt into NYC or Lithuania). Setting
`CCTV_PREFER_AUSTIN=1` alone does not retain live packs beside a nonempty file.
To retain enabled global coverage, deliberately change `CCTV_FORCE_AUSTIN` to `1`;
this adds upstream catalog requests and remains subject to per-pack and shared
caps, failures and `trimmedPacks`. File entries override live entries with the
same ID; inline entries override file entries. No guarantee is made that every
source fits a customized cap. Remove these overrides and restart to restore your
previous catalog configuration.

The server registers the URLs; clients select IDs, not arbitrary upstream URLs.
On current main, HLS uses `/api/cctv/media/:id`; stills use
`/api/cctv/frame/:id` and are refused by `/media`. A successful frame response
alone is not evidence of a webcam: check `X-CCTV-Source: upstream-image` rather
than `streetview` or `synthetic` fallback. Even `upstream-image` identifies origin,
not freshness. HLS buffering/limits and the bounded image proxy are unchanged.
No recording feature is added.

## Publication and coordinate provenance

The publication inventory was reviewed on **2026-10-17 UTC**. All media URL
strings in the JSON are the published stable masters/images, not guessed device
endpoints, expiring rendition URLs or segment links. HLS `snapshotUrl` is empty:
operator posters were not established to be refreshed camera frames.

### City streams (10)

The four intersection composites are published on the
[traffic page](https://bouldercolorado.gov/traffic-cameras) through its
[player](https://webappsprod.bouldercolorado.gov/webcams/index.php). Each composite
is **one stream**, not four independently addressable cameras. The player's
[Map View](https://experience.arcgis.com/experience/e4de44f82f984e6a960b005ee046f6d8)
links [web map 0752a276025c4486a549efea8012c16f](https://www.arcgis.com/sharing/rest/content/items/0752a276025c4486a549efea8012c16f/data?f=json),
which identifies the City's [TrafficCameras layer](https://maps.bouldercolorado.gov/arcgis/rest/services/IT/TrafficCameras/MapServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=pjson).
The coordinates below are its WGS84 intersection points rounded to six decimals.

| Stable ID                              | Coordinate source                                                                                                                                                           | Latitude, longitude      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `boulder-broadway-canyon`              | TrafficCameras OBJECTID 1                                                                                                                                                   | 40.01587, -105.279285    |
| `boulder-foothills-arapahoe`           | TrafficCameras OBJECTID 2                                                                                                                                                   | 40.014612, -105.240758   |
| `boulder-28th-colorado`                | TrafficCameras OBJECTID 3                                                                                                                                                   | 40.008119, -105.258663   |
| `boulder-28th-iris`                    | TrafficCameras OBJECTID 4                                                                                                                                                   | 40.036467, -105.258448   |
| `boulder-doudy-draw`                   | [Doudy Draw directions](https://bouldercolorado.gov/trailhead/doudy-draw), Eldorado Springs vicinity                                                                        | 39.938209, -105.256494   |
| `boulder-flagstaff-nature-center-west` | [Flagstaff Summit East directions](https://bouldercolorado.gov/trailhead/flagstaff-summit-east), associated summit site, not the Nature Center mount                        | 40.004137, -105.303423   |
| `boulder-panorama-point-north`         | [Panorama Point directions](https://bouldercolorado.gov/trailhead/panorama-point)                                                                                           | 40.006076, -105.292562   |
| `boulder-wonderland-lake`              | [Wonderland Lake directions](https://bouldercolorado.gov/trailhead/wonderland-lake)                                                                                         | 40.050908, -105.282567   |
| `boulder-creek-new-britain`            | City identifies New Britain Building, 1101 Arapahoe Avenue; [OSM way 381266709](https://www.openstreetmap.org/way/381266709) address representative point                   | 40.0143926, -105.2796456 |
| `boulder-south-boulder-creek`          | Approximate CU South parcel anchor at [CU South Tennis Courts Parking, OSM way 86096360](https://www.openstreetmap.org/way/86096360); **not the warehouse or camera mount** | 39.9790906, -105.2324918 |

The four open-space streams come from the
[trailhead page](https://bouldercolorado.gov/trailhead-cameras) and its
[OSMP player](https://webappsprod.bouldercolorado.gov/webcams/osmp-cameras.php).
The creek streams have separate official pages and players:

- [Boulder Creek](https://bouldercolorado.gov/boulder-creek-webcam),
  [player and site description](https://webappsprod.bouldercolorado.gov/webcams/boulder-creek.php).
- [South Boulder Creek](https://bouldercolorado.gov/south-boulder-creek-webcam),
  [player](https://webappsprod.bouldercolorado.gov/webcams/south-boulder-creek.php).

The two OSM-derived points are credited to **© OpenStreetMap contributors,
[ODbL 1.0](https://www.openstreetmap.org/copyright)**. That coordinate attribution
is not a license for City video.

### County stills (26)

All images are intentionally linked from the County's
[Live Trailhead Cameras page](https://bouldercounty.gov/open-space/parks-and-trails/live-trailhead-cameras/).
The table enumerates the complete image inventory: each `site`/`view` pair maps
to `https://bouldercountyopenspace.org/photos/<site>/<view>.jpg` and stable ID
`boulder-county-<site>-<view>`. `url` and `snapshotUrl` are identical.

Coordinates come from the official
[GRParkingLots_Public WGS84 query](https://maps.bouldercounty.org/arcgis/rest/services/ParksOpenSpace/GRParkingLots_Public/MapServer/0/query?f=json&where=1%3D1&outFields=%2A&outSR=4326&returnGeometry=true),
found through the County's linked ArcGIS application
`9e46a99ba311483cb6211a3331a357fa` and web map
`4ed947c744ac4d77852dfbc6be98e75e`. They are approximate **parking/trailhead
markers**, shared by views at a site, not individual mounts. Full precision in
the JSON reproduces published geometry, not a precision/accuracy claim.

| Site / image directory                          | Views                              | GIS OBJECTID / selected point                          | Locality and source                                                                                                |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Carolyn Holmberg Preserve / `chp`               | `parkinglot`, `lake`               | 24 / Rock Creek Farm                                   | [Stearns Lake near Broomfield](https://bouldercounty.gov/open-space/activities/picnic-shelters/)                   |
| Coalton / `coalton`                             | `live1`, `live2`, `live3`, `live4` | 32 / Coalton Trailhead                                 | [Superior](https://bouldercounty.gov/open-space/parks-and-trails/coalton-trailhead/)                               |
| Lagerman / `lagerman`                           | `live1`, `live2`, `live3`, `live4` | 2 / Lagerman Reservoir                                 | [Longmont vicinity](https://bouldercounty.gov/open-space/parks-and-trails/lagerman/)                               |
| Heil Valley Ranch / `heil`                      | `live1`, `live2`, `live3`, `live4` | 40 / Corral Trailhead (not Wapiti or Picture Rock)     | [Boulder foothills; Boulder postal locality](https://bouldercounty.gov/venue/heil-valley-ranch-corral-trailhead/)  |
| Pella Crossing / `pella`                        | `live1`, `live2`, `live3`, `live4` | 1 / Pella                                              | [South of Hygiene](https://assets.bouldercounty.gov/wp-content/uploads/2017/04/pella-crossing-map.pdf)             |
| Ron Stewart Preserve at Rabbit Mountain / `rsp` | `live1`, `live2`, `live3`, `live4` | 22 / Rabbit Mountain                                   | [Longmont vicinity](https://bouldercounty.gov/venue/ron-stewart-preserve-at-rabbit-mountain/)                      |
| Walker Ranch / `walker`                         | `live1`, `live2`, `live3`, `live4` | 19 / Walker Ranch loop lot (not homestead/Myers Gulch) | [Boulder foothills; property has Boulder postal locality](https://bouldercounty.gov/venue/walker-ranch-homestead/) |

## Limitations are disclosed, not exclusion criteria

- County images are **stills, not video**. The County advertises approximately
  ten-minute updates during **05:00–22:00 local (America/Denver)**. Actual per-view
  age varies and can be substantially longer, including during that window.
  Overnight frames can retain the previous day's capture. Check the visible
  clock; retrieval time and HTTP Last-Modified are not calibrated capture times.
- In bounded daylight research on 2026-10-17, all 26 county images decoded
  completely; seven advanced over approximately 10.5 minutes and 19 did not.
  This is historical sampling, not a present outage diagnosis or cadence SLA.
  Coalton `live2`/`live3` recovered from earlier truncated images and remain in
  the pack despite variable delay.
- South Boulder Creek is a functional **downward ground/surface view**. The City
  describes a CU South warehouse-roof camera and says the creek itself is not
  shown. Its approximate parking/site anchor must not be read as a known mount.
- Doudy Draw was low-cadence; darkness, haze, vegetation and operator aim can
  limit other views. Moving playback does not establish calibrated latency.
- No heading, pitch, FOV, range, mount height, elevation or `poseSource` is
  supplied. GEV may display its existing **RAW PRIOR** defaults; any coverage or
  monitor geometry is an estimate, not calibrated image-to-ground alignment.
- No Chautauqua, airport, separate CU, Tundra or other research candidates are
  added. Prior personal playback evidence is not acceptance of this contribution
  on current main. Availability can change without notice.

## Rights: no media reuse permission established

The [City privacy policy](https://bouldercolorado.gov/privacy-policy) and camera
pages reviewed did not establish an explicit webcam-specific embedding,
proxying, caching or redistribution grant. The
[City Open Data CC0 terms](https://bouldercolorado.gov/services/open-data) cover
catalog datasets; coverage of these webcam streams was **not established**, so
CC0 is not assigned to them. Public map access/null license metadata is likewise
not a footage license.

The [County policy](https://bouldercounty.gov/privacy-policy/) prohibits framing
County pages and implied endorsement. Whether that provision or other terms
permit this direct-image display/proxy/cache use remains unresolved; page
framing and image delivery are not assumed interchangeable. No webcam-image
reuse grant was established. Public viewing, anonymous access, working CORS and
technical playback do not settle rights. Neither permission nor a blanket
prohibition is inferred from missing terms.

Review the current applicable terms and obtain operator clarification where
needed before deployment or redistribution. Retain factual operator names,
viewing links and coordinate credits; they do not imply endorsement or legal
clearance. **The project's MIT license does not license City or County media.**
No footage is bundled here, and runtime retrieval does not itself resolve the
outstanding permission questions. This example does not authorize recording,
republication or changes to operator cameras.

## In-app attribution

The existing always-on `DATA_CREDITS` catalog registers two factual source
acknowledgments in Cesium's **Data attribution** popover: City of Boulder and
Boulder County Parks & Open Space, with official viewing links. Both explicitly
say **optional configured pack; not enabled by default**, **media reuse rights
unresolved**, and **no endorsement implied**. A catalog acknowledgment does not
activate the pack, fetch media, claim feeds are active, or grant reuse rights.
This uses the existing static-credit policy, not a conditional registration path.

When the pack is configured, per-camera credit also reaches the selected CCTV
panel. The existing generic OSM popover credit and the two creek entries'
coordinate-specific OSM provenance remain separate from media rights. See
[in-app attribution policy](../DATA_SOURCES.md#in-app-attribution).

## Offline regression check

```bash
node --test src/data/cctvBoulder.test.mjs src/data/dataCredits.test.mjs
```

The regular `npm test` runner discovers this file. It pins all 36 IDs and URLs,
normalization, unknown pose, attribution, opt-in registration, zero-fetch catalog
loading, HLS/still routing and each county frame's registered URL/provenance.
Network responses in the frame test are explicitly synthetic transport bytes,
not retained camera images or a JPEG-decoding/playback acceptance test. It does
not poll the operators, start a server or claim present availability.
The credit regression exercises the real `registerDataCredits` surface without
fetching: both optional operator acknowledgments must reach the offscreen
popover with safe links, rights disclosure and non-endorsement wording.
