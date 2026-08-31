# Data sources

The single source of truth for feed facts: endpoint, auth, cadence, licence, cost, and the
date someone actually called it and got a 200 back.

**The rule.** No endpoint goes in the verified table until it has been called successfully
and this file updated with the date. Nothing in the planned table may be relied on in code
until it has been called and moved up. If you are about to write an endpoint into an
adapter and it is marked NOT YET VERIFIED here, call it first. Guessing an endpoint shape
from documentation is how a layer ships broken.

Every row added to this file belongs in the same commit as the code that uses it.

**No bought data.** The business buys licensed wealth files and a vendor contact file
supplying address, email and phone at scale. This project is public sources only, so none of
that appears here and none of it ever will. The profile contract holds the contact
attributes anyway (ADR 008), and the fields a bought file would fill simply stay unset. Do
not add a vendor row to this table, and do not invent a value to stand in for one.

---

## Verified

Called live with a real 200 response, on 2026-08-19 or on 2026-08-20. The 2026-08-20
additions come from five keyless-source hunts run that day, and every one of them was
called from this laptop with no credential of any kind attached.

| Source | Endpoint | Auth | Cadence / rate limit | Format | Licence | Cost | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| adsb.lol | `https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}` | None | No published contractual limit. We poll at 8s, floor 5s in code. Throttles with HTTP 420, seen on the first poll of a run. **This is the shape the code sends, because it is the only viewport path adsb.fi also accepts.** `/v2/point/{lat}/{lon}/{nm}` works on adsb.lol and 400s on adsb.fi | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-20 |
| adsb.lol | `https://api.adsb.lol/v2/mil` | None | Throttles with HTTP 420. We poll no faster than 30s and fail over to adsb.fi | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.lol | `https://api.adsb.lol/v2/type/{icao_type}` | None | Same throttling behaviour as the rest of the v2 API | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.lol | `https://api.adsb.lol/v2/ladd` | None | Same throttling behaviour as the rest of the v2 API. Called on demand, not polled: the flag it carries also arrives on every ordinary viewport response | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-20 |
| adsb.lol | `https://api.adsb.lol/v2/pia` | None | Same throttling behaviour as the rest of the v2 API | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-20 |
| adsb.fi | `https://opendata.adsb.fi/api/v2/mil` | None | 1 request per second, stated by the provider | JSON, readsb v2 | **Non-commercial** | Free | 2026-08-19 |
| adsb.fi | `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` | None | 1 request per second | JSON, readsb v2 | **Non-commercial** | Free | 2026-08-19 |
| CelesTrak | `https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json` | None. **Answering HTTP 000 for four days as of 2026-08-20, and it is a block on this network rather than an outage. Use ReTLEctor** | **Never faster than once per 2 hours per group**, stated by the provider. Any non-200 must stop the poller outright, not back off. Abusive clients are firewalled permanently | JSON, OMM mean elements (not TLE line format) | **Not stated.** No attribution, copyright or citation requirement exists on any provider page (rechecked 2026-08-20). Credit is courtesy | Free | 2026-08-19 |
| USGS | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` | None | No rate limit published. The provider's own cache is 60s (`cache-control: max-age=60`). Planned cadence 2 minutes | GeoJSON | Public domain (US Government work) | Free | 2026-08-19 |
| NASA EONET | `https://eonet.gsfc.nasa.gov/api/v3/events/geojson` | None | **`X-RateLimit-Limit: 60` is published on every response.** The bare URL is 8.5MB and 7,728 features, so narrow it with `limit`, `days` or `category` before polling | GeoJSON, served as `application/rss+xml` | NASA open data, attribution requested | Free | 2026-08-19 |
| NASA GIBS | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/` | None | Tile service, no key. Respect normal tile-client behaviour | WMTS (XML capabilities, raster tiles) | NASA open data, acknowledgement requested | Free | 2026-08-19 |
| GeoNames | `https://download.geonames.org/export/dump/cities15000.zip` | None | Bulk file, not an API. Download at most once a week. The conditional request is verified: `If-None-Match` with the stored `ETag` answers **HTTP 304, zero bytes, 64ms** | Tab-separated text in a zip | CC BY 4.0 | Free | 2026-08-20 |
| Wikidata WDQS | `https://query.wikidata.org/sparql` | None, descriptive User-Agent required | Provider states: 60-second hard query deadline, 5 parallel queries per IP, 60 seconds of processing per 60 seconds per client, 30 error queries per minute, 429 on breach. One query per user action, never per keystroke. Server-side cache | SPARQL JSON results | CC0 | Free | 2026-08-19 |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php?action=query&list=geosearch` | None, descriptive User-Agent required | **No numeric read cap is published for the action API.** MediaWiki API:Etiquette asks for serial rather than parallel requests. The 1 request per second used here is our own floor | JSON | Per-file, mostly CC BY-SA or public domain | Free | 2026-08-19 |
| OpenStreetMap notes | `https://api.openstreetmap.org/api/0.6/notes.json?bbox={w},{s},{e},{n}` | None, descriptive User-Agent required | **No provider request figure exists.** The OSMF policy says the editing API is not for read-only projects and caps download threads at 2; `robots.txt` disallows `/api/` and `/note`. 1 request per second is our own floor | JSON | ODbL 1.0 | Free | 2026-08-19 |
| ADS-B Exchange (RapidAPI) | `https://adsbexchange-com1.p.rapidapi.com/v2/...` | **OUT OF SCOPE under the keyless rule, 2026-08-20, and separately a licence blocker.** **Paid RapidAPI key**, or a free key as a data feeder. **HTTP 401 without one, re-verified 2026-08-20.** The body varies: `Invalid API key` on 2026-08-19 and `Too many requests` on 2026-08-20 for the identical keyless request, so branch on the status and never on the message | **10,000 requests a month** on the only published plan, so a quota rather than a rate. A 5-second sweep spends the month in 14 hours, which is why this provider is demand-driven in code and never swept. Floor `ADSBEXCHANGE_MIN_INTERVAL_SECONDS` = 260s, being one month divided by the quota | JSON, readsb v2 | **Provider terms prohibit redistribution without written permission**, and serving positions to a browser is redistribution. Licence blocker on the layer, not a footnote | $10/month, free to feeders | 2026-08-20 |
| ADS-B Exchange (globe map) | `https://globe.adsbexchange.com/data/aircraft.json`, `/re-api/` | n/a | **Do not use.** 403 by administrative rule and disallowed in `robots.txt` | n/a | n/a | n/a | 2026-08-19 |
| airplanes.live | `https://api.airplanes.live/v2/...` | Access granted by email request. **Still HTTP 403 on 2026-08-20**, on `/v2/mil` and on a viewport path, with the same plain-text ask | **1 request per second, stated by the provider** in the `airplanes-live/api-archive` README. Held as `AIRPLANESLIVE_MIN_INTERVAL_SECONDS` in `sources/adsb.py` | JSON, readsb v2 | Provider terms, ask on request | Free | 2026-08-20 |
| adsb.one | `https://api.adsb.one/v2/...` | None documented | **Cloudflare-blocked from this network, HTTP 403 with a Cloudflare HTML body, re-verified 2026-08-20** | JSON, readsb v2 | Provider terms | Free | 2026-08-20 |
| Mastodon (`mas.to`) | `https://{instance}/api/v1/timelines/public` | None on instances that still allow it | 300 requests per 5 minutes per IP on default Mastodon config | JSON | Per-post, author's own; instance terms apply | Free | 2026-08-19 |
| GDELT DOC 2.0 | `https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=artlist&format=json&timespan={t}` | None, descriptive User-Agent required | **One request per five seconds**, stated by the provider in its own 429 body. One call bought a 429 penalty window of at least twelve minutes, so the floor is minutes not seconds. Cache per profile | JSON | GDELT terms, attribution required | Free | 2026-08-19 |
| Element 84 earth-search | `https://earth-search.aws.element84.com/v1/search` | None | No published cap, verified absent rather than quoted. One search per user action, cached server-side | STAC JSON. Assets are Cloud-Optimised GeoTIFF on S3, plus a keyless 343x343 `thumbnail` JPEG that a browser can render as-is | Copernicus free, full and open. Attribution mandatory | Free | 2026-08-19 |
| Copernicus Data Space | `https://catalogue.dataspace.copernicus.eu/odata/v1/Products` | None to search. **OAuth token to download** | Search keyless. Download quota sits on the token | OData JSON | Copernicus free, full and open | Free | 2026-08-19 |
| NASA Worldview snapshot | `https://wvs.earthdata.nasa.gov/api/v1/snapshot` | None | Renders one image per call, not a tile service. Cache per place and date | JPEG, PNG or GeoTIFF | NASA open data, acknowledgement requested | Free | 2026-08-19 |
| TfL JamCams | `https://api.tfl.gov.uk/Place/Type/JamCam` | **None.** A key raises the rate limit, it does not grant access | **500 calls per minute per data feed**, stated by TfL. Inventory is 1.1MB and is CDN-cached up to 24 hours, so refresh daily and never per view. Stills refresh on the order of minutes | JSON, stills as `image/jpeg` on S3 | TfL open data, credit string mandatory | Free | 2026-08-19 |
| New York 511 | `https://511ny.org/api/getcameras?format=json` | **None in practice, but the provider documents a key as required** and ignores the parameter rather than validating it | **10 calls per 60 seconds**, stated by the provider. 2,931 cameras in one 858KB response. Refresh the inventory on a slow cycle | JSON. Live video mostly HLS `.m3u8`, 9 records are `.mjpg` | NYSDOT open data. Restreaming needs a read | Free | 2026-08-19 |
| Fintraffic Digitraffic AIS | `https://meri.digitraffic.fi/api/ais/v1/locations` | None. `Digitraffic-User` header is requested, not required. **Regional, not global: measured lon 16.76 to 32.54, lat 57.67 to 65.80 on 2026-08-20** | 60 requests per minute per IP without the header, stated by the provider, 429 on excess. Provider cache is 60s, so 60s is the floor. **gzip is mandatory, HTTP 406 without it** | GeoJSON FeatureCollection with a `dataUpdatedTime` extension | CC BY 4.0, commercial use and redistribution permitted with credit | Free | 2026-08-20, live from the running app |
| Fintraffic Digitraffic AIS | `https://meri.digitraffic.fi/api/ais/v1/vessels` and `/api/ais/v1/vessels/{mmsi}` | None, as above | As above | **Bare JSON array**, not a FeatureCollection. Different top-level shape from `/locations` on the same API version | CC BY 4.0 | Free | 2026-08-20, live from the running app |
| Fintraffic Digitraffic AIS | `wss://meri.digitraffic.fi:443/mqtt` with `Sec-WebSocket-Protocol: mqtt` | None. CONNACK returned code 0 with no username and no password sent | **5 MQTT connections per minute per IP** without the header, stated by the provider. About 35 messages per second on `vessels-v2/#` | MQTT 3.1.1 over WSS. JSON payloads with **different field names and different units from REST** | CC BY 4.0 | Free | 2026-08-19 |
| Fintraffic Digitraffic port call | `https://meri.digitraffic.fi/api/port-call/v1/vessel-details` | None, as above | As above. gzip mandatory | Bare JSON array. Registry fields: IMO, name, callsign, nationality, port of registry, tonnage, dimensions, owner | CC BY 4.0 | Free | 2026-08-19 |
| Kystverket (Norway) AIS | `153.44.253.27` port `5631`, raw TCP, no TLS | None. The provider states access needs no registration | Broadcast stream rather than a request API, so no cap is stated. Persistent socket, not a poll | NMEA 0183 AIVDM-family sentences behind IEC 62320-1 TAG blocks | NLOD 2.0. Commercial use and redistribution permitted, attribution mandatory | Free | 2026-08-19 |
| adsbdb | `https://api.adsbdb.com/v0/aircraft/{hex_or_registration}` | None | 512 requests per minute per IP, read from the provider's own server source rather than a header. No rate-limit headers on any response | JSON in a `response` envelope | **None stated.** Aircraft data is credited to PlaneBase, a commercial database, with no redistribution grant | Free | 2026-08-20 |
| adsbdb | `https://api.adsbdb.com/v0/callsign/{callsign}` | None | As above | JSON, `response.flightroute` with nested `airline`, `origin` and `destination` | **Prohibited.** The route data "may not be copied, published, or incorporated into other databases" without named written permission | Free | 2026-08-19 |
| FAA Releasable Aircraft Database | `https://registry.faa.gov/database/ReleasableAircraft.zip` | None, **but a descriptive User-Agent is refused 403 by Akamai across the whole host** | Refreshed daily at 23:30 US central time, stated by the FAA. No request cap published | Zip, 69.6MB, 8 space-padded CSV files with a `.txt` extension. `MASTER.txt` is 316,030 rows | Public domain (US Government work) | Free | 2026-08-19 |
| Transport Canada CCARCS | `https://wwwapps.tc.gc.ca/Saf-Sec-Sur/2/CCARCS-RIACC/download/ccarcsdb.zip` | None. The descriptive User-Agent works here | No cadence published. `Last-Modified` moved on the day of verification | Zip, 4.3MB, 3 cp1252 quoted CSVs with **no header row**. 34,919 aircraft, 38,536 owner rows | Government of Canada Open Data Licence. **Clause 3.1(d) forbids linking the data to identify an individual** | Free | 2026-08-19 |
| CASA (Australia) aircraft register | `https://services.casa.gov.au/CSV/acrftreg.csv` | None, **but a descriptive User-Agent hangs with zero bytes; a full browser header set is what gets a reply** | No cadence published. `Last-Modified` moved on the day of verification | UTF-8 CSV with a BOM, 44 columns, 16,680 rows. **No ICAO 24-bit address anywhere in it** | CC BY 4.0 | Free | 2026-08-19 |
| ITU MARS | `https://www.itu.int/mmsapp/ShipStation/list`, GET then POST | None for the list and detail views | None published. Self-imposed 1 request per second. **Hard cap of 1,000 results, 15 rows per POST, no export** | HTML from ASP.NET with server-side session state and an encrypted `Breadcrumb` field | **ITU terms: personal, educational or non-commercial only. Distribution or commercial use needs prior written ITU permission** | Free | 2026-08-19 |
| ITU MID table | `https://www.itu.int/gladapp/Allocation/MIDs` | None | None published. Allocations do not move, so this is a monthly refresh into a local table, never a poller | HTML table, 249 rows carrying 292 distinct MIDs | ITU terms, as above | Free | 2026-08-19 |
| USCG PSIX | `https://cgmix.uscg.mil/xml/PSIXData.asmx`, SOAP 1.1 | None | None published. Cache per vessel, no sweeps | SOAP XML wrapping an **entity-escaped** `NewDataSet` document. No MMSI and no owner in any operation | Public domain (US Government work) | Free | 2026-08-19 |
| SEC EDGAR | `https://data.sec.gov/submissions/CIK{10-digit}.json` | None, **a declared User-Agent carrying a contact address is mandatory** | 10 requests per second, stated by the SEC | JSON. `filings.recent` is 16 parallel arrays and caps at 1,000 rows | Public domain (US Government work) | Free | 2026-08-19 |
| SEC EDGAR | `https://www.sec.gov/files/company_tickers.json` | As above | As above | JSON dict keyed by a positional index string, 10,387 entries | Public domain | Free | 2026-08-19 |
| SEC EDGAR full-text search | `https://efts.sec.gov/LATEST/search-index?q={q}&forms={f}` | As above | As above. Undocumented host, absent from the SEC's own developer pages | Raw Elasticsearch JSON. 100 hits per page, `from + size` capped at 10,000 | Public domain | Free | 2026-08-19 |
| SEC EDGAR ownership filings | `https://www.sec.gov/Archives/edgar/data/{cik}/{accession}/{document}.xml` | As above | As above. `/Archives/edgar/data` is explicitly allowed in `sec.gov/robots.txt` | Form 3, 4 and 5 `ownershipDocument` XML | Public domain | Free | 2026-08-19 |
| SEC EDGAR browse-edgar | `https://www.sec.gov/cgi-bin/browse-edgar?...&output=atom` | n/a | **Do not use.** It answers HTTP 200 with a valid Atom feed, and `sec.gov/robots.txt` disallows `/cgi-bin` by name | n/a | n/a | n/a | 2026-08-19 |
| ProPublica Nonprofit Explorer | `https://projects.propublica.org/nonprofits/api/v2/search.json` and `/organizations/{ein}.json` | None | None published. Treat as unstated, not unlimited, and cache hard. The data is a monthly IRS Business Master File extract, so it is never current | JSON. **No trustee, officer or director name field exists on either endpoint** | **ProPublica Data Store terms bar republishing or distributing the data in whole or in part on a stand-alone basis, and bar charging for access** | Free | 2026-08-19 |
| Companies House PSC bulk snapshot | `https://download.companieshouse.gov.uk/psc-snapshot-{date}_{n}of32.zip` | **None** | Daily snapshot, 2.2GB whole or 32 parts of about 72MB. Bulk ingest into a local index, never a poller | JSON Lines inside a zip member with a `.txt` extension | Open Government Licence 3.0 | Free | 2026-08-19 |
| FEC OpenFEC | `https://api.open.fec.gov/v1/schedules/schedule_a/` | **OUT OF SCOPE under the keyless rule, 2026-08-20.** `api_key` required. `DEMO_KEY` works and is still a key, so this is out until the constraint changes. Do not wire it in | **`x-ratelimit-limit: 10` observed on `DEMO_KEY`**, tighter than the 30 per hour api.data.gov documents. 1,000 per hour on a signed key. Trust the header | JSON, 81 fields per result, with a 40-field `committee` object inlined on every row | Public domain (US Government work) | Free | 2026-08-19 |
| Wikidata `wbsearchentities` | `https://www.wikidata.org/w/api.php?action=wbsearchentities` | None, descriptive User-Agent required | No numeric read cap published for the action API. Serial rather than parallel. 1 request per second is our own floor | JSON. `success` is an integer, `url` is protocol-relative | CC0 | Free | 2026-08-19 |
| Wikipedia REST summary | `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` | None, descriptive User-Agent required | **200 requests per second**, stated in the API's own OpenAPI spec | JSON, profile `Summary/1.5.0`. `coordinates` is `{lat, lon}` and is absent on a person | **CC BY-SA 3.0 and GFDL**, per the API's own declaration, not 4.0 | Free | 2026-08-19 |
| Wikipedia geosearch (action API) | `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&formatversion=2` | None, descriptive User-Agent required | No numeric read cap published. `gsradius` is capped at 10 to 10,000 metres and anything else is an error | JSON. A requested-but-absent property comes back as an explicit `null` | CC BY-SA 3.0 and GFDL | Free | 2026-08-19 |
| Wikimedia Commons imageinfo | `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url,extmetadata` | None, descriptive User-Agent required | As the geosearch row above | JSON. The licence, author and any required credit string live in `imageinfo[0].extmetadata` | Per file, carried on the record | Free | 2026-08-19 |
| Wikimedia upload (image bytes) | `https://upload.wikimedia.org/wikipedia/commons/thumb/{path}/{width}px-{file}` | None | Only the provider's standard thumbnail widths are served. Anything else is HTTP 400 with an HTML body | Image bytes | Per file, as above | Free | 2026-08-19 |
| Nominatim | `https://nominatim.openstreetmap.org/search?format=jsonv2` | None, descriptive User-Agent mandatory | **An absolute maximum of 1 request per second**, stated by the OSMF. Caching is mandatory, not advised. Systematic queries are named as unacceptable use. **Called at most once per unique query, measured 2026-08-20 through the running product: four identical searches, one upstream call, 563ms cold then 1.8ms** | JSON, a bare list. `lat` and `lon` are **strings**; `boundingbox` is 4 strings as `[south, north, west, east]` | ODbL 1.0. The response carries its own credit string | Free | 2026-08-20 |
| Overpass | `https://overpass-api.de/api/interpreter`, POST | None, descriptive User-Agent with contact required | **About 10,000 requests and under 1GB of download per day**, both stated by the provider. 2 concurrent slots for this IP per `/api/status`. Requests queue 15 seconds then are discarded | JSON when `[out:json]` is asked for, but **errors are HTML or plain text** | ODbL 1.0, self-declared in the body at `osm3s.copyright` | Free | 2026-08-19 |
| EOX Sentinel-2 cloudless | `https://tiles.maps.eox.at/wmts` | None | No published cap. `ows:Fees` is absent from the capabilities | WMTS XML capabilities plus 256x256 JPEG tiles | **CC BY 4.0 on the 2016 and 2017 mosaics only. CC BY-NC-SA 4.0 on 2018 through 2025** | Free, and a paid EOX licence for commercial use | 2026-08-19 |
| Kystdatahuset (Kystverket, Norway) | `https://kystdatahuset.no/ws/api/ais/realtime/geojson` | **None.** The OpenAPI document declares one `JWT Bearer` scheme and no global `security` requirement, and this path carries none. A call with the User-Agent header suppressed entirely returned the full body | **None stated**, in the OpenAPI document, on the access page or in `robots.txt` (`User-agent: *` / empty `Disallow:`). The cadence is set by the data: the provider serves "all ships that have reported positions within the last 10 minutes" and wipes positions after 20. A 60s poll sits well inside that and costs about 1MB gzipped. **`HEAD` is HTTP 405 with `Allow: GET`**, so a freshness check written as a HEAD reports the source down | GeoJSON FeatureCollection. **Geometry is a `LineString` and the current position is the LAST coordinate**, not the first. 3,542 features on 2026-08-23, 3,399 of them mapping to a vessel | **NLOD 1.0, which is what this endpoint's own document says.** `info.license` in the live OpenAPI document reads "Norwegian Licence for Open Government Data (NLOD) 1.0" and points at `data.norge.no/nlod/en/1.0`, re-read 2026-08-23. This file had recorded 2.0 for both Kystverket endpoints on the reasoning that it is one authority under one licence, and that reasoning still holds; the version does not. Nothing practical turns on it: both licence texts were read on 2026-08-23 and both grant copying, use and distribution provided the contributor is acknowledged, so the credit discharges either. `sources/kystdatahuset.py` serves 1.0 because stating a grant the provider did not state for this endpoint is the wrong way round to be wrong. Which of Kystverket's two statements governs is theirs to settle | Free | 2026-08-23, live from the running app |
| Transpordiamet (Estonia) | `https://gis.transpordiamet.ee/arcgis/rest/services/Hosted/AIS_vessels_feature_view/FeatureServer/0/query` | **None.** An ArcGIS FeatureServer with `capabilities: Query`. The portal declares `authInfo.isTokenBasedSecurity: true` for its admin endpoints and this query needs no token, no header and no cookie. **Not in the maritime folder**: the AIS layer sits in `Hosted`, while the folder named for vessel traffic (`Laevaliikluse_tiheduskaardid`) holds 52 `ImageServer` density rasters, so a quick sweep of this host concludes "density only" and moves on | **None stated.** `robots.txt` is HTTP 404, so there are no directives. Cadence read off the data: report ages ran 84s at the freshest, 148s median, 1,878s max, so a minute buys everything there is. `maxRecordCount` is 1,000 and `resultOffset` paging is verified at offset 600 | Esri JSON. **Default spatial reference is EPSG:3301, Estonian grid in METRES**: without `outSR=4326` a berth reads `x: 466890.13, y: 6529584.57` and every vessel fails a WGS84 contract. **`sys_timestamp` is a constant `-2209161600000`, which is 1900-01-01, on every record**; the real fix time is `timestamp`, a 13-digit ms epoch. **An error arrives as HTTP 200 with an `error` key.** `mmsi` is a 9-char string, `draught` is metres, `eta` is a real ms epoch rather than the packed AIS integer | **None stated.** `copyrightText` on the FeatureServer is an empty string, there is no terms page in the service directory and no licence on the viewer. Verified absent rather than assumed. Credit is courtesy; a licence read is needed before commercial redistribution | Free | 2026-08-23, live from the running app |
| Great Lakes St. Lawrence Seaway VIS (Canada and USA) | `https://vis.seaway.ca/graphql`, POST, operation `getAllVessels` | **None.** A cold POST carrying only a User-Agent and a content type, with no cookie, referer, session or authorization header, returned all 7,118 records. The public map's own bundle at `vis.greatlakes-seaway.com` names this endpoint, this operation and this argument, and contains the word "anonymous" nineteen times. The same schema exposes `currentUser`, `roles`, `directoryUsers` and pilot assignments: **query the AIS fields and nothing else** | **None stated**, on either host, in `robots.txt` (`User-agent: *` / empty `Disallow:` on both) or in any response header. Cadence read off the data: freshest report 119s, and the ten-minute window held 1,664 against 1,537 at five minutes | GraphQL. **`age` is not an age, it is an absolute ISO 8601 instant.** **The body is a SIXTY-DAY roster, not a snapshot**: median report 2.4 days old, p90 33.6 days, 4,100 of 7,118 over 24 hours, so it must be cut to a freshness window locally because the server's own `ageOrLastUpdatedDays` filter is in whole days. `sessionFilterOverrides` is a required argument with ~70 non-null booleans and no defaults, each of which silently narrows the answer. Errors arrive inside HTTP 200. `latitude: 91` / `longitude: 181` is the position sentinel. **`accuracyType: MALFUNCTION` on 6,103 of 7,118 does NOT mean a bad fix** and dropping on it loses four fifths of the feed. Two fields are called `id`; only `aisInformation.id` is the MMSI | **None stated.** No terms page on either host and no licence field in the response. Verified absent. Both operating corporations are public bodies, which points at open terms and is not a grant. Credit is courtesy; a licence read is needed before commercial redistribution | Free | 2026-08-23, live from the running app |
| ReTLEctor (CelesTrak cache) | `https://retlector.eu/{group}/json` and `https://retlector.eu/{norad_id}/json` | None | **60 requests per 60 seconds, stated by the provider**, and confirmed on the wire as `x-ratelimit-limit: 60`, `x-ratelimit-remaining`, `x-ratelimit-reset`. Honour the header, not a constant. `/{group}/status` returns `Last Updated`, `Age` and `Next Update` as a few hundred bytes of plain text, so freshness is checked before pulling 6.9MB. Groups refresh every 4 to 12 hours. `robots.txt` is HTTP 404 | **The exact CelesTrak OMM JSON contract**, same field names, same naive `EPOCH`, same types. The committed `celestrak_iss_omm.json` key set matches field for field | **Unresolved, and unchanged by using it.** ReTLEctor's code is MIT; the data is CelesTrak's, whose position this file already records as not stated | Free | 2026-08-20 |
| astrion-tech CelesTrak mirror | `https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/{group}.tle`, plus `satcat/satcat.csv` and `LAST_REFRESH` | None | None stated beyond GitHub's defaults. Refreshed every 30 minutes by GitHub Actions. `etag` and `last-modified` are served, so conditional requests cost nothing | TLE line triples, 8 groups only. **TLE means a hard 5-digit catalogue ceiling**, so every object catalogued since 2026-07-11 is absent or Alpha-5 encoded | **None declared at all**, which is worse than a restrictive one. The README asks consumers to respect CelesTrak's terms | Free | 2026-08-20 |
| SatNOGS DB | `https://db.satnogs.org/api/tle/?format=json` | None | **None published.** The provider says only "API access is open to anyone", so treat as unstated rather than unlimited. `robots.txt` disallows `/admin/` only. The host timed out twice at 20 and 25 seconds before answering in 0.60s, so a short client timeout reads it as dead | JSON, `tle0` / `tle1` / `tle2` / `tle_source` / `sat_id` / `norad_cat_id` / `updated`. **It names its own provenance per record**, which nothing else here does | **CC BY-SA 4.0**, stated by the provider. The cleanest orbital licence available, and ShareAlike binds any derived database | Free | 2026-08-20 |
| AMSAT | `https://www.amsat.org/tle/current/nasabare.txt` | None | **None published** on the file, the directory index or the page. Verified absent. Behind Cloudflare with `max-age=14400`; `etag` and `last-modified` both served, so a daily conditional fetch costs the provider nothing. `robots.txt` disallows `/dokuwiki/` only | Plain text, 3-line format, 99 amateur satellites. Rebuilt daily | **None stated**, on the file, the directory index or the page. Verified absent rather than assumed | Free | 2026-08-20 |
| tle.ivanstanojevic.me | `https://tle.ivanstanojevic.me/api/tle/{norad_id}` | None | None published, no rate-limit headers. `cache-control: no-cache, private`, `vary: User-Agent`. `robots.txt` permits everything. **Per-object lookup only, never swept**: there is no bulk route and 25,675 objects would be thousands of paged requests | JSON, Hydra/JSON-LD envelope, CORS open. TLE line pairs, never OMM | **None stated** | Free | 2026-08-20 |
| wheretheiss.at | `https://api.wheretheiss.at/v1/satellites/25544` and `/25544/tles` | None | **None published on the response.** The provider's documentation states roughly one request per second, unverified, so 1/s is our own floor rather than a quoted cap | JSON. A **computed position**, not elements: latitude, longitude, altitude in **kilometres**, velocity, visibility, footprint, timestamp | **None stated** | Free | 2026-08-20 |
| open-notify.org | `http://api.open-notify.org/iss-now.json` | None | None published | JSON, 113 bytes. **HTTP only, no TLS**, so a browser on an HTTPS page blocks it and the backend must proxy it. Latitude and longitude arrive as **strings** | **None stated** | Free | 2026-08-20 |
| NASA SSCWeb | `https://sscweb.gsfc.nasa.gov/WS/sscr/2/observatories` and `/WS/sscr/2/locations/{id}/{start},{stop}/geo/` | None | None published. `cache-control: no-transform, max-age=86400` | XML. Positions rather than elements, in the Earth-fixed `Geo` frame, as **parallel repeated `<X>`, `<Y>`, `<Z>` and `<RadialLength>` elements against a separate `<Time>` array**, in kilometres | NASA open data, acknowledgement requested | Free | 2026-08-20 |
| SpaceX Starlink public ephemerides | `https://api.starlink.com/public-files/ephemerides/MANIFEST.txt` and the per-satellite MEME files | None | None published. `robots.txt` is HTTP 404 | Plain text. **State-vector ephemerides, not mean elements**: 3 days at 60-second steps in frame `UVW`, km and km/s, plus a 21-element covariance. No SGP4 path. 11,001 files at about 2MB each, so about 22GB whole | **None stated** on the manifest or the files | Free | 2026-08-20 |
| Mike McCants element sets | `https://mmccants.org/tles/classfd.zip` and `/tles/inttles.zip` | None | None published. `etag`, `last-modified` and `accept-ranges: bytes` all served. `robots.txt` is HTTP 404 | Zip containing TLE text. 404 classified objects in `classfd.tle`, 63 integrated-forward objects in `inttles.zip` whose epochs sit in the **future** | **None stated** | Free | 2026-08-20 |
| NASA GIBS geostationary cloud layers | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{GOES-East_ABI_GeoColor,GOES-West_ABI_GeoColor,Himawari_AHI_Band3_Red_Visible_1km,Himawari_AHI_Band13_Clean_Infrared}/default/{Time}/{TileMatrixSet}/{z}/{y}/{x}.png` | None | None published, verified absent. `PT10M` product cadence, measured 62 to 72 minutes old at a single clock reading, so poll every 5 minutes against the endpoint's own `Time` default and label the layer with the frame's timestamp | Transparent PNG WMTS tiles. `GoogleMapsCompatible_Level7`, **Level6 for `Himawari_AHI_Band13_Clean_Infrared`**. GeoColor is true colour by day and infrared by night, so it never blanks on the dark half | NASA open data, acknowledgement requested | Free | 2026-08-20 |
| NASA GIBS HLS 30m true colour | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{HLS_S30_Nadir_BRDF_Adjusted_Reflectance,HLS_L30_Nadir_BRDF_Adjusted_Reflectance}/default/{Time}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png` | None | As the GIBS row above. Date-addressable daily, S30 back to 2015-11-28 across 17 ranges, L30 back to 2013-03-22 across 13 | PNG. **30m, eight times sharper than the 250m MODIS layer the app draws today.** Harmonised Landsat Sentinel-2 | NASA open data, acknowledgement requested. Public domain | Free | 2026-08-20 |
| NASA GIBS Blue Marble | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg` | None | As the GIBS row above | JPEG. **No `Time` dimension at all**: zero `<Value>` elements and no `<Default>`, so the dateless template is the correct one here and a date in the path is accepted and ignored. Ceiling `Level8`, so zoom 0 to 8. Cloud-free by construction | NASA open data, acknowledgement requested. Public domain | Free | 2026-08-20 |
| EUMETView (EUMETSAT GeoServer) | `https://view.eumetsat.int/geoserver/ows?service=WMS&version=1.3.0` | None | **None published and none discoverable.** Verified absent. `ows:Fees` is `none` and `AccessConstraints` is `none`. `mtg_fd:rgb_geocolour` is `PT10M`, `msg_fes:rgb_natural` `PT15M`, `mumi:worldcloudmap_ir108` `PT3H` | WMS 1.3.0 GetMap, PNG. 255 named layers. **The WMTS endpoint is HTTP 400; only WMS works** | **NOT ESTABLISHED, and this gates the layer.** `Fees: none` and `AccessConstraints: none` are machine-readable and verified. Every human-readable licence page is unreadable: `/eumetsat-data-licensing` answers 200 with a JavaScript shell to curl and 403 to a fetch service, `/copyright-notice` and `/our-satellites/data-policy` are both 404, and the data-policy PDF is 404. No licence name, no attribution string, no redistribution position. The satellite layers carry no `<Attribution>` and `<ContactInformation>` is present but empty | Free | 2026-08-20 |
| NOAA STAR NESDIS CDN | `https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/1808x1808.jpg` | None | **None published.** `cache-control: max-age=0,s-maxage=600` is the only cadence signal and matches a 10-minute product cycle. `robots.txt` is HTTP 404. **Freshness comes from the response `last-modified`**, because the filename is fixed and carries no timestamp | JPEG full disk in the satellite's own geostationary fixed grid, **not a tiled Web Mercator layer**. `latest.jpg` is 18,548,436 bytes; use `1808x1808.jpg` at 2,581,852 or `339x339.jpg` at 127,833 | NOAA, US federal government work, so public domain by default, but **no explicit licence statement was found on the CDN**, so record the position as unstated | Free | 2026-08-20 |
| JMA Himawari tiles | `https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json`, then `.../{basetime}/fd/{validtime}/{band}/{product}/{z}/{x}/{y}.jpg` | None | **None published** | Standard Web Mercator `{z}/{x}/{y}.jpg`, 10-minute cadence, 213 frames listed. **Zoom 0, 1 and 2 are all HTTP 404; minimum usable zoom is 3.** Off-disk is **opaque white with no alpha channel**, 44.2% of a zoom-3 composite, so it is a poor overlay next to GIBS's transparent PNGs. Infrared is the only product that works round the clock | **Not established.** `robots.txt` is HTTP 404 with an HTML body, so no crawl policy either way and the status has to be checked before the body is parsed | Free | 2026-08-20 |
| CIRA SLIDER | `https://slider.cira.colostate.edu/data/json/{satellite}/full_disk/geocolor/latest_times.json` | None | None published. `robots.txt` is HTTP 404. The old `rammb-slider.cira.colostate.edu` host answers **302 on every path including `robots.txt`** | JSON frame lists plus PNG tiles in the satellite's **native fixed-grid geostationary projection** with a `{zz}/{yyy}_{xxx}.png` scheme, so Cesium needs a reprojection step | **Not established.** CIRA is a Colorado State University co-operative institute with NOAA; no licence statement found | Free | 2026-08-20 |
| Microsoft Planetary Computer | `https://planetarycomputer.microsoft.com/api/stac/v1/search`, `/api/data/v1/item/preview.jpg`, `/api/data/v1/mosaic/register` | **None.** Microsoft's own words: the datasets "are anonymously accessible: you don't need to supply a subscription key", and a key "allows for less restricted rate limiting". The same shape as TfL JamCams, so keyless is the sanctioned route | **The provider states rate limiting exists and publishes no number.** Record as verified-absent. `robots.txt` is `User-agent: *` with no `Disallow` | STAC JSON, **and it honours `cql2-json` for real**, unlike earth-search. Keyless browser JPEG per scene at `preview.jpg?format=jpeg&max_size=512`, and a keyless on-demand XYZ mosaic. **Content-type on the JPEG is `image/jpg`, not `image/jpeg`** | Data is Copernicus free, full and open with attribution mandatory (`sentinel-2-l2a` declares `license: proprietary` with a `rel=license` link to the ESA Sentinel Data Terms). **Microsoft's own service terms are not fetchable**: `/` and `/terms` both return the same 2,356-byte React shell. No SLA, no published availability commitment | Free | 2026-08-20 |
| USGS LandsatLook STAC | `https://landsatlook.usgs.gov/stac-server/search` | None to search | None published, verified absent. `robots.txt` is HTTP 403 with an S3 `AccessDenied` XML body, so there is nothing to honour and nothing granting permission | STAC JSON, 18 collections, and it honours `cql2-json`. **Catalogue only: the imagery is not reachable keyless.** See the detail section | USGS Landsat Data Policy, public domain, no commercial restriction | Free | 2026-08-20 |
| AWS Open Data Terrain Tiles | `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png` | None | **None published**; it is a public S3 bucket. `robots.txt` is an S3 `NoSuchKey` 404. An EU replica bucket `elevation-tiles-prod-eu` exists in eu-central-1 | Terrarium-encoded PNG heightmaps, `height = (R*256 + G + B/256) - 32768`. Zoom 0 to **15**; zoom 16 is a 404. Cesium has no terrarium provider, so it goes through `CustomHeightmapTerrainProvider` | Open, but **attribution is mandatory across about thirteen source datasets** per `tilezen/joerd/docs/attribution.md`. A thirteen-line credit block | Free | 2026-08-20 |
| Natural Earth II, bundled in the `cesium` package | `/cesium/Assets/Textures/NaturalEarthII/{z}/{x}/{reverseY}.jpg`, served from our own origin | None | **Not applicable, zero network.** 536KB on disk, already copied by `frontend/vite.config.ts:35` | TMS JPEG tiles, zoom 0 to **2** only, full `-180 / -90 / 180 / 90` extent | Public domain (Natural Earth). **The Cesium provider carries no credit of its own**, so one has to be added explicitly | Free | 2026-08-20 |
| NASA GIBS geostationary cloud layers, as shipped | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{GOES-East,GOES-West}_ABI_Band13_Clean_Infrared` and `.../Himawari_AHI_Band13_Clean_Infrared`, `/default/{Time}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png` | None | `PT10M` product cadence, and the newest frame is never the current one. **Ask for `default` in the time dimension and GIBS names the frame it served in a `layer-time-actual` response header**, which it also lists in `access-control-expose-headers`, so a browser can read it: one `HEAD` per satellite replaces guessing. **Use it to learn the frame and never to draw:** `default` resolves per request, and four GOES-East tiles asked for in the same second at 15:40 UTC named three different frames (15:40, 15:30, 15:20), so drawing on it puts three frames side by side and calls it one picture. Measured 2026-08-23 at 10:25 UTC: 10:00 for both GOES, 09:30 for Himawari, so 25 and 55 minutes old in the same reading. At 09:57 UTC the newest slot with bytes behind it was 26 to 36 minutes old and the two newer slots answered 404 on three attempts each. Client re-probes every 10 minutes | PNG WMTS tiles, `GoogleMapsCompatible_Level6`, deepest level 6. **A 404 here means one of three things and only one is a fault.** A slot GIBS has not built answers 404 rather than a blank tile, and the newest slot always is one. A tile outside the satellite's own footprint also 404s rather than serving transparency: `GOES-East` at level 2, row 1, column 3 is 90°E to 180°E and answered 404 six times of six, while a tile inside the pyramid with no data is a 334-byte fully transparent PNG instead. And a 404 can simply be wrong: one tile URL answered 404, 404, then 200 with 80,131 bytes, so a single 404 is not evidence a tile is absent, and a coarse-level 404 is almost certainly this rather than a footprint edge (`Himawari` at level 1, row 0, column 1 contains the whole disk and answered 200 six times of six). Off-disk pixels inside a straddling tile are opaque and **exactly `(0,0,0)`**, 72% of a tile over the Sahara, while the darkest real pixel in the same tiles was above 64 of 255, so keying black out is safe at Cesium's default threshold. **On this product grey level is temperature, not cloudiness, so there is no grey that means "clear".** Measured 2026-08-23 as the grey histogram of one tile per climate: Amazon rainforest peaks at 48 to 95 and has nothing above 160; tropical Atlantic peaks at 96 to 111; Sahara by day and the western Pacific at 96 to 127; North Atlantic at 50°N at 112 to 143; South Pacific and Australia at 112 to 159; and the **Southern Ocean at 65°S has nothing at all below 144 and peaks at 160 to 175**, brighter than a good deal of real cloud because sea ice genuinely is that cold. 62 to 99 per cent of pixels in every tile are exactly grey, and NASA colourises only the cold end, so the tallest storms arrive cyan and green with a brightest channel *below* clear sky: `(0, 67, 90)` is a cold top. Any brightness threshold has to exempt coloured pixels or it punches holes through deep convection. **There is no `Himawari_AHI_GeoColor`**, so GeoColor cannot cover the western Pacific and Band 13 is the only product all three satellites publish. **There is no Meteosat layer at all**, so 0°E to 60°E has no cloud imagery from this source. `HEAD` works and returns `content-length` with no body | NASA open data, acknowledgement requested. The satellites are NOAA's and JMA's, so the credit names them | Free | 2026-08-23, live from the built bundle in a browser |
| Wikimedia Commons geosearch, as shipped | `https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&maxlag=5&generator=geosearch&ggscoord={lat}|{lon}&ggsradius={m}&ggslimit={n}&ggsnamespace=6&ggsglobe=earth&prop=imageinfo|coordinates&iiprop=url|user|extmetadata|mime|size|timestamp&iiextmetadatafilter=LicenseShortName|UsageTerms|LicenseUrl|Artist|AttributionRequired|ImageDescription&colimit=max` | None, descriptive User-Agent | **No published read cap, and the provider says so**: API:Etiquette states "There is no hard speed limit on read requests" and asks for requests "in series rather than in parallel". So 1 request per second is our own floor. **`maxlag` is required of us, not optional**: the same page says "If your task is not interactive, i.e. a user is not waiting for the result, you should use the maxlag parameter", and a poller is exactly that. **One request, not two**: `generator=geosearch` with `prop=imageinfo|coordinates` returns the coordinates and the licences together, which is the same page's advice to use "a generator instead of making a request for each result from another request". Verified 2026-08-24: 500 pages, all 500 with imageinfo, all 500 with coordinates, `batchcomplete: true`, 743KB. **`iiurlwidth` caps the whole query at 50 records and nothing says so**, which is why it is no longer sent: see the section below | JSON. **`formatversion=2` is mandatory in practice**: without it booleans are empty strings and pages are keyed by pageid instead of being a list. **Every error arrives inside an HTTP 200**, in an `error` key: `ggsradius=50000` gives `code: outofrange` ("must be between 10 and 10,000") and `maxlag=-1` gives `code: maxlag` with a `lag` figure, and the two need opposite handling because one is a bad request and the other is "come back shortly". **An over-limit `ggslimit` is a *warning*, not an error, and silently changes the count**: 600 answered 200, warned "must be between 1 and 500", and returned 64 results. **`missing: true` does not mean missing**: a Commons file queried against `en.wikipedia.org` answers `missing: true`, `imagerepository: shared` and a full `imageinfo` with `LicenseShortName: Public domain`, so the drop condition is the absence of `imageinfo`. **Coordinates carry a `globe`** and MediaWiki also stores Moon and Mars, so the earth entry is picked by name rather than by position. **`width` and `height` are `0` for `application/ogg`** (3 of 50), which is "not applicable" and not a dimension. **`Artist` is HTML**, real value `'Unknown author<span style="display: none;">Unknown author</span>'`, which renders once in a browser and twice through a naive tag stripper. **`AttributionRequired` is the string `'true'` or `'false'`**, both truthy. **`DateTimeOriginal` is free text**: `cir. 1948` is a real value. **A geosearch of namespace 6 returns audio as readily as photographs**. **`iiurlwidth` silently caps `prop=imageinfo` at 50 titles whatever `ggslimit` says**: 500 pages, 50 with `imageinfo`, `batchcomplete` absent and an `iicontinue` token, so the other 450 are unlicensable and dropped. Without it, 500 pages with 500 `imageinfo` and `batchcomplete: true`. **`iiextmetadatafilter` cuts the body 64%**, 2,081KB to 743KB, for a byte-identical parse. **`CirrusSearch` refuses under load with an HTTP 200**, `code: cirrussearch-too-busy-error` plus a `mediawiki-api-error` response header, 2 of 36 sustained calls. **A search that matches nothing has no `query` key at all**, 51 bytes reading `{"batchcomplete":true,"limits":{"coordinates":500}}`, so an empty answer and a broken one are the same shape. **`imageinfo.url` carries `utm_*` tracking parameters** (`utm_source=commons.wikimedia.org&utm_campaign=imageinfo`) which the media proxy strips | **Per file, never per source.** One London query returned CC BY-SA 4.0, CC0, CC BY 3.0, CC BY 2.0 and CC BY-SA 2.0 across 50 files. Each record carries its own licence, URL, author and attribution flag, and an item whose licence cannot be determined is dropped and counted | Free | 2026-08-23 |
| Mastodon public timeline (`mas.to`), as shipped | `https://mas.to/api/v1/timelines/public?limit=40` | None on instances that still serve anonymous clients | **The provider states its own budget on every response**: `x-ratelimit-limit: 300`, `x-ratelimit-remaining`, and `x-ratelimit-reset` as an ISO timestamp. `cache-control: max-age=15` is the instance's own cache window, so **15s is the floor**: polling faster than a provider's cache cannot return anything new. `robots.txt` allows `/` for `*` and disallows only `/media_proxy/`, `/interact/` and `/api/v1/instance/domain_blocks`, so this path is permitted; it also carries `Content-Signal: search=yes,ai-train=no,use=reference` | Bare JSON array of statuses, no envelope; paging is in a `Link` header. **No positional field of any kind**, re-verified 2026-08-23: nothing on the status, nothing on `account`, nothing in the `meta` block of a media attachment. `content` is HTML. `language` may be `null`. Undocumented-by-us fields now present and ignored: `card`, `quote`, `quote_approval`, `tagged_collections`, `edited_at`. **`mastodon.social` answers HTTP 422 `{"error":"This method requires an authenticated user"}` to the identical request `mas.to` answers 200 to**, so an instance list is configuration and 401, 403 or 422 drops that instance for the cycle | **Per post, and a status carries no rights field at all**, so a media attachment's licence cannot be determined and every one is dropped and counted per ADR 005. The handle and the link are stored because attribution needs them. This half of the layer is text | Free | 2026-08-23 |
| OpenStreetMap notes | `https://api.openstreetmap.org/api/0.6/notes.json?bbox={w},{s},{e},{n}` | None, and it answers: HTTP 200, 30,446 bytes, 100 features for a London box on 2026-08-23 | n/a | GeoJSON `FeatureCollection`. Technically fine and not the problem | **DROPPED ON THE PROVIDER'S OWN TERMS, 2026-08-23.** Not a key problem and not a technical one: the endpoint works. `operations.osmfoundation.org/policies/api/` states, verbatim, that "The editing API is provided in order to edit the map data, **not for read-only purposes or projects**", names planet.osm and Overpass as the routes for data users, and caps downloaders at 2 threads. `robots.txt` independently carries `Disallow: /api/` and `Disallow: /note` under `User-agent: *`. Two stated directives naming our exact use, so per AGENTS.md the stated route in is the route in, and neither planet.osm nor Overpass carries notes. ADR 005 names this as an upstream-coordinate source; it is not available to us | Free | 2026-08-23 |
| Wikimedia media bytes, proxied | `https://upload.wikimedia.org/wikipedia/commons/...` and `.../thumb/.../{width}px-...` | None | **Not polled.** Demand-driven and cached for 30 days per item, because a photograph does not change: a replaced Commons file arrives under a new URL. Served to browsers from our own origin, never hot-linked, per ADR 005. Hot-linking would spend the provider's rate limit through viewers we cannot see or slow down, and would tell Wikimedia which photograph on our globe each viewer opened | Raw media bytes. **The only media host**: both `url` and `thumburl` on a Commons file point here. **`thumbwidth` never describes the bytes at `thumburl`** and Wikimedia renders only to its own standard widths, verified 2026-08-23: `500px-` and `250px-` both answered 200 with real JPEG while **`512px-` answered HTTP 400 with 2,010 bytes of `text/html`**, so a client must never construct a width and must validate the body against its declared type before caching it. **The URLs carry the provider's own analytics** (`utm_source`, `utm_campaign`, `utm_content`); stripping them returned byte-identical content, 38,279 bytes either way. **Its coordinates are often a copied placeholder rather than an observation, and this is the trap that matters most on this source.** Measured 2026-08-24 as a 50-file geosearch within 10km of a centre: **Charing Cross returned all 50 files on one coordinate**, `51.5073509, -0.1277583`; Notre-Dame 259 of 500 on `48.856614, 2.352222`; Midtown Manhattan 37 distinct coordinates across 50 files with 32 carried by one file each; Reykjavik 30 distinct and rural Wales 27. The clustered files are bulk imports named "Rustic stovetop", "Binoculars" and "Small Dog Confidence", 45 of one Manhattan cluster uploaded by "File Upload Bot", and one London file's own description reads "Geolocation data has this at Charing...". **The provider quotes six to seven decimal places**, which is centimetres, and no two independent photographs have fixes agreeing to a centimetre, so an exact repeat is one value copied onto several records. Treating such a coordinate as source-supplied would assert an observed position that does not exist, so the adapter reclassifies it as derived and counts it. **No tolerance and no gazetteer are needed**: the test is inter-file agreement, not proximity to a known centroid. **A `thumburl` on `commons.wikimedia.org` is not a thumbnail**: for media it cannot render a preview of, MediaWiki substitutes its own static UI icon at `/w/resources/assets/file-type-icons/fileicon-ogg.png`, so that host is excluded from the proxy allowlist and the adapter no longer offers it as a preview. Sends `access-control-allow-origin: *`, so a browser *could* hot-link, which is why the rule is a decision rather than a limitation. **SVG is never served**: it is a document a browser runs script from, and serving one from our origin would put a provider's markup in our security context | Per file, established before a URL reaches the proxy: `MediaLicence` makes an unlicensed item unrepresentable, so the proxy has no licence decision to make and no way to bypass one | Free | 2026-08-23, live through the proxy |
| CARTO raster basemaps | `https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png` | None | **None published on the tile CDN.** No published cap means no permission either: treat as courtesy access and cache | PNG, rendered cartography rather than imagery | ODbL 1.0 on the OpenStreetMap data plus a CARTO credit. Both are attribution conditions | Free | 2026-08-20 |
| Mobility Database catalogue | `https://files.mobilitydatabase.org/feeds_v2.csv` | None | manual, weekly at most | CSV, 2,647,828 B | catalogue metadata; see robots note below | free | 2026-08-23 |
| 258 operator feeds | see `gtfsrt_feeds.csv` | None | per **host**: 350s passio3.com, 120s data.gouv.fr, 60s buscatch.jp, 30s otherwise | GTFS-RT protobuf | per feed, carried on every record | free | 2026-08-23 |
| Entur (Norway, national) | `https://api.entur.io/realtime/v1/gtfs-rt/vehicle-positions` | None | 30s | GTFS-RT protobuf, 304,907 B, 1,497 vehicles | NLOD 2.0, attribution | free | 2026-08-23 |
| transit.land REST | `https://transit.land/api/v2/rest/feeds?spec=gtfs-rt` | **API key** | n/a | JSON | n/a | n/a | 2026-08-23, HTTP 401 |

### Measured coverage

The Verified table has no coverage column, and coverage is the fact most often assumed rather
than measured. Everything below was measured on 2026-08-20 from a real body or a real tile
grid, never read off a provider's claim. Where a source straddles the antimeridian the figure
is given as bands, because a naive min and max reads `-180 to 180` for a single geostationary
satellite and is wrong by 200 degrees.

| Source | Measured coverage | How it was measured |
| --- | --- | --- |
| Fintraffic Digitraffic AIS | **lon 16.76 to 32.54, lat 57.67 to 65.80. 1,075 vessels, 1,075 distinct MMSI, 70 one-degree cells.** The Gulf of Finland, the Gulf of Bothnia, Aland and the Archipelago Sea | Every coordinate in one live `/locations` body |
| Kystdatahuset | lon 0.155 to 32.492, lat 56.23 to 80.338. 3,283 features, 3,275 distinct MMSI, 144 one-degree cells. Norwegian coast 2,349, Barents and Murmansk 138, western North Sea 99, Kattegat and Skagerrak 50, Svalbard 34. **Baltic proper: zero. Gulf of Finland and Bothnia: zero** | The last coordinate of every `LineString` in one live body |
| Kystdatahuset plus Fintraffic, merged on MMSI | **4,350 distinct vessels, 214 one-degree cells, 0.33% of the globe's cells.** MMSI intersection **zero**. Cell intersection **zero** | Set intersection of the two bodies above, captured in the same minute |
| Transpordiamet (Estonia) | lon 19.68 to 29.41, lat 56.98 to 60.71. 627 vessels, 627 distinct MMSI. Against the other two keyless members in the same minute: 397 already in Fintraffic, **zero** in Kystdatahuset, **230 in neither**. Reaches further south than Fintraffic, lat 56.98 against 57.67, which is the Latvian coast | One live FeatureServer query, 2026-08-23 |
| Seaway VIS (Canada and USA) | **lon -92.10 to -51.83, lat 41.42 to 51.61. 1,664 vessels inside a ten-minute window**, out of 7,118 served. MIDs 316 Canada 810, USA 338/366/367/368/369 about 756, plus 538 Marshall Islands, 636 Liberia, 311 Bahamas. The Great Lakes, the St Lawrence and the Gulf of St Lawrence. **The first ships on the globe outside northern Europe** | One live GraphQL POST, 2026-08-23 |
| All four keyless vessel providers merged on MMSI | **6,001 vessels, lon -92.12 to 34.25, lat 41.42 to 79.91, 379 one-degree cells = 0.58% of the globe.** By region: Norwegian coast and Skagerrak 41%, North America 31%, Baltic and Gulf of Finland 19%, Baltic approaches 6%, North Sea 3%, Barents 0.2%. 346 records seen by more than one provider. **Two continents, and that is the honest ceiling of keyless AIS** | Live from the running app, 2026-08-23 |
| Kystverket raw NMEA TCP | lon -13.345 to 31.505, lat 57.596 to 78.357, 224 positions, 65 cells in a 12-second read | Hand-decoded single-part type 1, 2 and 3 sentences |
| ReTLEctor `/active/json` | **lat -88.78 to +89.00, lon -179.97 to +179.98, altitude 132.4km to 128,888.7km. All 216 cells of a 10 by 30 degree grid, 100%.** Quadrants NW 4,142 / NE 3,972 / SW 3,973 / SE 4,312. Zero SGP4 failures out of 16,399 | All 16,399 objects propagated with SGP4 to the instant of the call, TEME converted to ECEF through GMST at the same instant |
| SatNOGS DB | lat -86.47 to +82.69, lon -179.05 to +178.82, 210 of 216 grid cells (97%). 1,579 of 1,669 propagated clean | As above |
| AMSAT | lat -82.47 to +82.31, lon -178.47 to +178.09, 78 of 216 grid cells (36%). 98 of 99 propagated | As above. 99 objects cannot fill a grid at one instant, so the spread is global and the count is small |
| Mike McCants `classfd.tle` | lat -81.37 to +82.67, lon -178.64 to +179.12, 175 of 216 grid cells (81%). 398 of 404 propagated | As above |
| astrion-tech `stations.tle` | lat -42.83 to +51.78, lon -146.35 to +168.54, 9 of 216 grid cells. 21 objects | As above. Its value is being a second host on a second network, not one file covering the world |
| GIBS `GOES-East_ABI_GeoColor` | lon -151.5 to 1.4, lat -76.5 to 76.5, 42.5% of longitude | 4x4 zoom-2 tile grid composited to 1024x1024, alpha channel scanned column by column |
| GIBS `GOES-West_ABI_GeoColor` | lon -180 to -60.5 and 146.6 to 180, lat -76.5 to 76.5, 42.5% of longitude | As above |
| GIBS `Himawari_AHI_Band13_Clean_Infrared` | lon -180 to -138.2 and 59.4 to 180, lat -79.7 to 79.7, 45.1% of longitude | As above |
| **GIBS geostationary trio, union** | **83.9% of longitude, with exactly one gap: 1.4E to 59.4E.** That 58-degree hole is Europe, Africa and the Middle East. **GIBS carries zero Meteosat layers**: 3,905 layer identifiers, 12 GOES, 3 Himawari, 0 matching Meteosat or MSG | Union of the three measurements above |
| EUMETView `mtg_fd:rgb_geocolour` | lon -81.2 to 81.2, 45.1% of longitude, and it covers **100.0% of the measured GIBS gap** | 1024x512 global GetMap render, alpha scanned column by column |
| EUMETView `mumi:worldcloudmap_ir108` | **lon -180 to 180, lat -81.6 to 81.6, 100.0% of longitude**, 87.8% of pixels opaque. One layer, whole globe, no compositing | As above |
| **GIBS trio plus `mtg_fd:rgb_geocolour`** | **100.0% of longitude, no gap** | Union of the measurements above |
| JMA Himawari tiles | lon -180 to -137.8 and 59.1 to 180, lat -85.1 to 85.1, 45.8% of longitude. **Adds no coverage GIBS does not already have** | Full 8x8 zoom-3 grid, 48 tiles at 200 and 16 at 404, composited and scanned for pixels that are neither pure white nor pure black |
| GIBS `BlueMarble_NextGeneration` | 64 of 64 zoom-3 tiles at HTTP 200, 63 distinct images, lat -85.05 to 85.05, lon -180 to 180 | Full 8x8 zoom-3 grid, each tile checked for a real JPEG or PNG magic number |
| GIBS `MODIS_Terra_CorrectedReflectance_TrueColor` | 61 of 64 zoom-3 tiles, the three failures all in the southernmost row as HTTP 404 | As above |
| EOX `s2cloudless-2025_3857` | 62 of 64 zoom-3 tiles with a real image, lat -85.05 to 85.05, lon -180 to 180. The two failures are Antarctic and arrive as **HTTP 200 with a 116-byte PNG** | As above |
| Microsoft Planetary Computer mosaic | Global over land inside Sentinel-2's own band, **zoom 9 and up only**. Zoom 4 to 8 are HTTP 204 with zero bytes. 200 at Tokyo, Sydney, Sao Paulo, Dubai, Anchorage, London, Kinshasa and Manaus; 204 over open Pacific and McMurdo | One zoom-11 tile request per city, plus one request per zoom level over the same London column |
| USGS National Map imagery | **United States only.** 64 of 64 at zoom 3 because a global low-resolution backdrop is served at coarse zooms, then Denver 200, London 404, Tokyo 404 at zoom 10 | Zoom-3 grid, then one zoom-10 tile per city |
| Esri World Elevation 3D | Global. `fullExtent` spans the full Web Mercator world in EPSG:3857. Sampled in a real Cesium viewer: Everest 8,839m, London 6m, Hawai'i 2,107m, Chilean Andes 4,605m | `sampleTerrainMostDetailed` against the rendered provider |
| AWS Terrain Tiles terrarium | Global and real. `z0/0/0` decodes to -7,527m to 5,657m, so ocean floor and mountains are both present | Terrarium PNG decoded with `height = (R*256 + G + B/256) - 32768` |

**Two facts from that table deserve saying in words, because both were assumed the other way
before they were measured.**

**Fintraffic Digitraffic is a regional provider, not a global one.** lon 16.76 to 32.54, lat
57.67 to 65.80. That is the Gulf of Finland, the Gulf of Bothnia and the Archipelago Sea, and
nothing else. It has been the vessel layer's only live source, so the layer has been Finnish
coastal waters presented as a world map. Adding Kystdatahuset triples the count and still
leaves the layer at 0.33% of the globe's one-degree cells. Anything that reads "vessels" in
this product means Northern Europe until a global provider exists, and there is no keyless
global one.

**The two vessel providers do not overlap at all.** Zero shared MMSI and zero shared cells,
measured in the same minute. So they are **complementary, not redundant**: either one going
down darks its whole region with no failover behind it, and no vessel position in this layer
will ever be corroborated by a second provider. That is a harder version of the ADR 010 and
ADR 011 conflict already recorded in `docs/pending-decisions.md`. For aircraft, two
aggregators repeat one transponder broadcast; for vessels, the two providers never see the
same ship.

### Model artefacts

The local ONNX weights ADR 015 requires. Not feeds: each is a one-off download, pinned by
hash, fetched on first use and never committed. Every hash below was computed locally from
the downloaded bytes and matched against the host's own digest.

| Source | Endpoint | Auth | Cadence / rate limit | Format | Licence | Cost | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Hugging Face | `https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model_qint8_arm64.onnx` | None | `ratelimit-policy: q=500;w=300` on the response header, so 500 API requests per 300 seconds anonymous | ONNX, 23,026,053 bytes | Apache 2.0, declared in `cardData.license` | Free | 2026-08-19 |
| Hugging Face | `https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/{text,vision}_model_int8.onnx` | None | As above | ONNX, 64,070,791 and 88,648,877 bytes | **None declared, on this repo or on the `openai` base model.** MIT is inherited from the upstream code repository, which is an inference and not a declaration | Free | 2026-08-19 |
| Hugging Face | `https://huggingface.co/Qdrant/clip-ViT-B-32-{vision,text}/resolve/main/model.onnx` | None | As above | ONNX fp32, 351,686,194 and 254,102,519 bytes. No int8 variant | **MIT, declared.** The licence-clean alternative to the Xenova export, at four times the size | Free | 2026-08-19 |
| ONNX Model Zoo | `https://github.com/onnx/models/raw/main/validated/vision/body_analysis/arcface/model/arcfaceresnet100-11-int8.onnx` | None | None published on GitHub raw | ONNX, 65,764,892 bytes, fixed `[1, 3, 112, 112]` input | Apache 2.0, in the model zoo README and the file's own SPDX header | Free | 2026-08-19 |
| OpenCV Zoo | `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx` | None | None published | ONNX, 229,738 bytes, fixed `[1, 3, 640, 640]` input | **MIT**, per the model directory's own LICENSE. The parent repo is Apache 2.0, so read the per-model file | Free | 2026-08-19 |
| Hugging Face | `https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/{encoder_model,decoder_model_merged}_int8.onnx` | None | As the other Hugging Face rows | ONNX, 92,326,127 and 156,750,845 bytes. Two graphs, not one | **None declared on the ONNX export.** Apache 2.0 per the `openai/whisper-small` base model card, MIT per the upstream code repository | Free | 2026-08-19 |

**InsightFace weights are barred and must not be used.** `buffalo_l`, `w600k_r50.onnx`,
`w600k_mbf.onnx` and SCRFD are the obvious pick for a face embedder. Their own model zoo
README states, verbatim: "ALL models are available for non-commercial research purposes
only." This is a demo of a commercial product, so they are out, and so is anything mirroring
them. Two of the ArcFace ONNX repos that come up first in a search
(`onnx-community/arcface-onnx`, `garavv/arcface-onnx`) are the same 136,619,444-byte file and
**neither declares any licence at all**, which is worse than a restrictive one.

**ADR 015's "four small ONNX" is wrong on both words.** CLIP is a text tower plus a vision
tower and Whisper-small is an encoder plus a decoder, so it is six graphs, and seven once the
face detector is counted. ArcFace takes a pre-aligned 112x112 crop and will not run without a
detector producing five landmarks, which the ADR does not name. YuNet closes that gap at
233KB, MIT, and 3.92ms per frame measured on this machine. The leanest workable int8 set is
491MB (MiniLM 23MB, CLIP 153MB, ArcFace 66MB, Whisper 249MB, YuNet 0.23MB). Taking the
declared-MIT Qdrant CLIP instead makes it 944MB.

### Build-time references

Not feeds. A build-time reference is read once by a person, written into a code constant and
never called by the running product. It gets a row for the same reason a feed does: someone
has to be able to check where a constant came from, and when.

| Source | Endpoint | Auth | Cadence / rate limit | Format | Licence | Cost | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ICAO Doc 8643 aircraft type designators | `https://www.icao.int/operational-safety/doc-8643-aircraft-type-designators` | None | **Not polled.** Read when the constant is edited, which was once | HTML landing page. No machine-readable form exists | **No data licence read.** ICAO publishes the document itself; what this project holds is a list of designator strings in a code constant | Free | 2026-08-20 |
| doc8643.com per-designator mirror | `https://doc8643.com/aircraft/{designator}` | None | **Not polled.** One request per designator, self-imposed 1 per second | HTML per designator: manufacturer, model, description code, wake category | **None stated** on the mirror | Free | 2026-08-20 |

Where it is used: `src/tracker/services/classify.py:53`, the business-jet designator set.

**There is no machine-readable ICAO endpoint.** ICAO's own search application at
`https://cfapps.icao.int/doc8643/` answers **HTTP 404 host-wide**, re-verified 2026-08-20. So
the designator set was read off per-designator pages on the mirror, one request each, and
every entry in the constant carries its Doc 8643 manufacturer and model verbatim beside it as
the citation.

**The ICAO path is exact and the shorter one is a 403.**
`/operational-safety/doc-8643-aircraft-type-designators` answers 200 and
`/doc-8643-aircraft-type-designators` answers **403** on the same host, both re-verified
2026-08-20. Dropping the prefix reads as a block rather than as a wrong URL.

**The mirror's index is gated and its per-designator pages are not.**
`https://doc8643.com/aircrafts` sat behind a Cloudflare challenge on the first attempt on
2026-08-20 and answered 200 with 20KB of real HTML on a re-check the same day, for a
descriptive User-Agent both times. Treat the index as intermittently gated and the
per-designator pages as the route in.

**The mirror has at least one real data error, so its description code column carries no
weight.** `FA6X`, the Dassault Falcon 6X, reads description code `L1P`, a single-engine
piston, for what is a twin jet. Read off the live page on 2026-08-20. The designator and the
model name on that page are right and they are what the constant keys on, so the
classification is unaffected. Nothing may be built on the description code.

Nine candidate designators answered 404 on the mirror and were dropped rather than guessed at:
`FA5X`, `MYST`, `C526`, `C552`, `GL8T`, `LJ29`, `LJ36`, `LJ54`, `CL65`.

**Nothing from Doc 8643 reaches a browser**, which is why there is no attribution string and
no licence-audit item for it. The designators are a filter inside the classification rules; a
card's type designator comes from the ADS-B feed under ODbL and its model name comes from
adsbdb.

### adsb.lol `/v2/point/{lat}/{lon}/{radius_nm}`

The viewport feed and the only aircraft source the running app polls for a local view.
Radius is capped at 250 nautical miles and the provider rejects anything larger, so the cap
is applied in code at `src/tracker/sources/adsb.py:304`. A wider area needs tiling.

Verified with `51.5 / -0.12 / 25`, which returned 65 aircraft (captured as
`tests/fixtures/adsb_point_live.json`, all 65 records carrying a position). Field
availability in that sample: `hex`, `lat`, `lon` on all 65, `flight` on 63, `t` and `r` on
59, `track` on only 28. That last figure is why the heading fallback chain at
`src/tracker/sources/adsb.py:129` is not an edge case.

Because the feed only understands circles, a bounding-box query becomes the circumscribed
circle plus local filtering (`src/tracker/sources/adsb.py:307`), which over-fetches by up
to about 27% at the corners.

adsb.lol publishes no contractual rate limit and plans to introduce keys earned by feeding
data. It does throttle in practice: on 2026-08-19 it answered this endpoint with HTTP 420
during a live run.

### adsb.lol `/v2/mil`

Every military aircraft the provider currently sees, worldwide, in one response. Verified
on 2026-08-19: 391 records, of which 310 carried a position (captured as
`tests/fixtures/adsb_mil_live.json`, 168KB). All 391 carried `dbFlags` bit 1.

This endpoint returns eight fields `/v2/point` does not (`dbFlags`, `calc_track`,
`lastPosition`, `gpsOkBefore`, `gpsOkLat`, `gpsOkLon`, `rr_lat`, `rr_lon`). That difference
is the reason for the permissive wire model, explained in `docs/architecture.md`.

**It answered HTTP 420 rate-limited on a later call.** 420 is not a standard status code
and is handled explicitly at `src/tracker/sources/base.py:21`. Consequences, both in code:
the cadence floor is 30 seconds (`src/tracker/app.py:41`), four times the viewport floor,
and failure falls over to adsb.fi.

Coverage is inherently partial. Military aircraft routinely fly with transponders off, and
the UI says so rather than implying a complete picture.

### adsb.lol `/v2/type/{icao_type}`

Every aircraft of one ICAO type designator, worldwide. Verified with `GLF6`, which returned
18 aircraft (captured as `tests/fixtures/adsb_type_glf6_live.json`). This is the endpoint
behind business-jet sweeps in phase 3.

### adsb.fi

The failover provider, and the reason a single parser serves both: adsb.fi, adsb.lol and
ADSBexchange all serve the readsb v2 schema.

`/v2/mil` is path-identical to adsb.lol, which is why the military failover works with no
code change.

**The viewport path has to be chosen for both providers, and only one shape works.** adsb.fi
answers HTTP 400 for adsb.lol's `/v2/point/{lat}/{lon}/{nm}`, which is adsb.lol only, and
failover replays the same path against the secondary base URL, so using it silently disabled
the viewport failover entirely. The shape both providers accept is
`/v2/lat/{lat}/lon/{lon}/dist/{nm}`, and it is now the only one the code sends
(`src/tracker/sources/adsb.py:56`).

**Verified live on 2026-08-20**, twice in one nine-minute run of the app. adsb.lol answered
`GET /v2/lat/51.5000/lon/-0.1200/dist/250` with HTTP 420, and
`GET https://opendata.adsb.fi/api/v2/lat/51.5000/lon/-0.1200/dist/250` answered HTTP 200, and
the aircraft layer kept its records. So both providers serve the shared shape and the
viewport failover works. This corrects the previous entry, which said it did not.

The envelope's batch timestamp is **seconds**, not milliseconds. The capture taken on
2026-08-19 sent `now: 1787170658.001` with a fractional `ptime` of 0.067, where adsb.lol
sent `now: 1787165611001` mirrored in `ctime`. Both providers serve the same schema and
neither declares the unit, so the adapter decides it on magnitude at
`src/tracker/sources/adsb.py:66`. Read as milliseconds, every adsb.fi aircraft arrives dated
1970-01-21 and can never win a recency comparison against another provider.

Licence is the blocker here, not the technology: adsb.fi open data is **non-commercial
use only**. Rate limit is one request per second.

### CelesTrak

Orbital element sets for the satellite layer (phase 2). Verified on 2026-08-19 against
NORAD 25544 (the ISS), captured as `tests/fixtures/celestrak_iss_omm.json`.

Four things that will cost you time if you skip them:

- The response is **OMM JSON mean elements**, not TLE line format. Field names are
  `MEAN_MOTION`, `ECCENTRICITY`, `INCLINATION`, `BSTAR` and so on. **`satellite.js` consumes
  this directly through `json2satrec`, a first-class export at 7.1.0, verified against the
  committed fixture. Do not synthesise TLE lines.** Corrected 2026-08-20: this file previously
  said `satellite.js` "takes a TLE by default, so either build the TLE lines or use its OMM
  entry point", which read as a choice. It is not one. CelesTrak ran out of 5-digit catalogue
  numbers on 2026-07-11, all new objects get 6-digit numbers, and the TLE format has five
  columns for the field, so a TLE path silently misses every object catalogued since. Size
  `NORAD_CAT_ID` for 9 digits and never zero-pad it to 5.
- `EPOCH` is a **naive** ISO timestamp (`2026-08-19T12:48:46.640160`) but is UTC by
  specification. Attach UTC in the adapter or every propagation is offset by the local
  timezone.
- **Always pass `FORMAT` explicitly.** The default changed to CSV on **2026-05-09**,
  stated on the provider's own GP data formats page, so a request without it silently stops
  being JSON. `satcat/records.php` is a different endpoint with a different default, **JSON**,
  so pass `FORMAT` on both and assume nothing.
- **Never fetch a group more than once per two-hour window.** CelesTrak permanently
  firewalls abusive clients, without appeal. That guard belongs in code with a test, not
  in configuration. This file's verification was done once today and deliberately not
  repeated while writing these notes.
- **A non-200 stops the poller. It does not back off.** The provider's usage policy states:
  "M2M software should immediately stop querying when it receives any non-HTTP 200 responses"
  and "Repeatedly ignoring them will end up sending your IP address to the firewall." So the
  `RateLimitedError` backoff pattern used for adsb.lol is the wrong pattern here. First
  non-200 latches the satellite poller off for the process and the layer reports itself
  unavailable with the reason. Use `https://celestrak.org` with no `www.`, because anything
  else is a 301 and a 301 is a non-200.
- **Serialise the epoch as `Z`, not `+00:00`.** `json2satrec` appends a `Z` when the string
  does not end in one, so `...+00:00` becomes `...+00:00Z`, which `new Date()` rejects, and
  the satrec comes back full of `NaN` **without throwing**. Pydantic's default JSON form for
  an aware datetime is `+00:00`. Measured: the naive CelesTrak string and the `Z` form both
  give `jdsatepoch=2461272.03387`, the `+00:00` form gives `NaN`. Every satellite lands at
  NaN, which renders as an empty layer rather than an error.

**Reachability, rechecked 2026-08-20 from a running server and by hand.** Still dead, and it
is a network fact rather than our code. DNS resolves `celestrak.org` to `104.168.149.178`, a
raw TCP connect to port 443 times out, and `curl --max-time 15` returns HTTP 000 with exit 28.
The app's own poller logged
`SourceError: celestrak: unreachable: ConnectTimeout:` and the satellite layer reported itself
unavailable with that reason on `/api/health` and `/api/capabilities`, serving
`{"count":0,"satellites":[]}` rather than claiming health. That is three checks across three
days and two networks, and **zero requests have ever been served**, so the two-hour budget is
untouched and the non-200 stop latch has never been exercised against a real response.

**Attribution: this file's previous claim was wrong.** It said "CelesTrak terms, attribution
required". Rechecked on 2026-08-20 across the usage policy, the GP data formats page, the
SupGP queries page, the SATCAT format page and the home page: there is no attribution,
copyright, citation or credit requirement anywhere. The only stated obligation is the request
rate. We still credit them, as courtesy and because every layer in this project renders a
credit, but the row now says the licence position is unstated rather than asserting terms
nobody published.

**The site was down on 2026-08-20 and the two outstanding group calls did not happen.** TCP
443 and 80 both failed to establish from two independent networks, with `connect=0.000000`
proving no request was served, so nothing counted against us. A dead port on both 80 and 443
is not what being firewalled looks like: their policy names 301, 403, 404 and 50x. The group
query (`GROUP=stations`, `GROUP=active`) shape and payload size remain **unverified** and sit
in the planned table.

**Two traps for the group query when it does run.** Analyst objects in the 80000 series carry
no `OBJECT_NAME` and no `OBJECT_ID`, so both are optional at the wire layer and unmappable
records are dropped and counted. And nothing on an OMM record signals decay: `propagate()`
returns `null` with a non-zero `satrec.error`, and the cheap guards are absence from the group
(use `replace_all`, not `upsert_many`) plus an epoch-staleness cut at the provider's own 3.5
days. Measured: a real ISS element set propagated 365 days past epoch still reported
`error=0` and a plausible 402km altitude, so a clean error code is not evidence of a usable
position.

**CelesTrak is not down. CelesTrak is refusing our network, and it has answered HTTP 000 for
four days.** Corrected 2026-08-20. This file and `sources/celestrak.py:58` both described the
silence as a transport failure that might clear on its own. It will not. Measured on 2026-08-20
from three independent networks against the same IP, `104.168.149.178`:

| Network | Result |
| --- | --- |
| This laptop, curl | `http=000`, connection timed out after 30,003ms on `celestrak.org:443`. `celestrak.com:443` behaved identically at 25s. DNS resolves cleanly |
| A third-party fetch service | `connect ECONNREFUSED 104.168.149.178:443` |
| GitHub Actions runners, via two mirrors | **HTTP 200 with that day's data**, ten minutes before the check |

Two different TCP failure modes from two networks against one IP, while a third network is
served. That is a firewall rule keyed on where the request comes from, not an outage. The
`astrion-tech/celestrak-mirror` README names the mechanism in as many words: a workflow
re-fetches "from runner IPs that CelesTrak does not block, so consumers behind blocked
datacenter ASNs (notably Hetzner) can still ingest the data".

**Four days of HTTP 000 is the run.** Two of those days are directly evidenced in this file,
2026-08-19 and 2026-08-20. `sources/celestrak.py:59` records the site serving a week before the
first failure, so the block began between 2026-08-13 and 2026-08-19. There is no appeal route in
CelesTrak's usage policy, so the working assumption is that it never comes back for us.

Three consequences.

- **Retrying is not a plan and redundancy is the only route.** The keyless replacements are
  ReTLEctor (the same OMM JSON contract, 16,399 objects, measured global), the astrion-tech
  mirror (a second host on a second network) and SatNOGS DB (a genuinely independent origin).
- **The two-hour-per-group floor now applies to a cache we do not own**, which is a different
  obligation from the one CelesTrak's policy states and should not be read as the same promise.
  ReTLEctor's groups refresh every 4 to 12 hours, so a 2-hour poll already asks twice as often
  as the data moves, and it sits well inside the 60-requests-per-60-seconds the cache states.
- **Every keyless full-catalogue mirror is CelesTrak wearing a different hostname.** ReTLEctor,
  `astrion-tech/celestrak-mirror`, `navsuite/celestrak-orbital-data`, `satvisorcom/satvisor-data`
  and `tle.ivanstanojevic.me` are **one origin between them**. Two of them agreeing is the same
  file fetched twice, not corroboration, which is exactly the ADR 010 error
  `docs/pending-decisions.md` already flags for ADS-B. The independent origins are CelesTrak,
  Space-Track (reachable only through SatNOGS), AMSAT, McCants, NASA SSCWeb and SpaceX.

### Satellite element sets without CelesTrak

Verified 2026-08-20. Three keyless providers, and the order matters.

**ReTLEctor is the primary**, because it is the only keyless source that hands over the exact
CelesTrak OMM JSON contract the layer already parses, the only one carrying 6-digit catalogue
numbers (326 of 16,399), and the only one whose coverage measures as the entire globe. Pointing
`sources/celestrak.py` at a second base URL is the whole integration and the committed fixtures
still pass. Fixtures: `tests/fixtures/retlector_active_omm_slice_live.json` (every 25th object
of `/active/json`, so the slice spans the catalogue rather than one launch),
`retlector_iss_omm_live.json` and `retlector_groups_live.json`.

Its traps:

- **Every numeric field arrives as `int` or `float` in the same response**, on fields SGP4
  needs. Measured across 16,399: `MEAN_MOTION_DDOT` int on 16,302 and float on 97, `BSTAR` int
  on 802, `INCLINATION` int on 85, `MEAN_MOTION_DOT` int on 14, `MEAN_ANOMALY` int on 3,
  `ARG_OF_PERICENTER` int on 1. A `strict=True` float field rejects the ints. Same class as
  earth-search's `eo:cloud_cover`.
- **`OBJECT_ID` is up to 10 characters, not 9.** Real values `2013-066AA`, `2013-066AB`,
  `2014-033AD`. A regex expecting `YYYY-NNN[A-Z]` drops them.
- `EPOCH` is naive with no `Z` and no offset on all 16,399, exactly as CelesTrak. The
  `json2satrec` trap above applies unchanged: attach UTC in the adapter and serialise as `Z`.
- **One person, one host, no SLA, and it exists precisely because CelesTrak bans people.** If
  CelesTrak bans it, the layer goes dark again, which is why the failover below is not optional.

**The astrion-tech mirror is the failover.** Different host, different network, same upstream
bytes, refreshed every 30 minutes, and its ISS element set matched ReTLEctor's to the digit,
which cross-validates both. It is TLE only, so it carries a hard 5-digit catalogue ceiling and
misses every object catalogued since 2026-07-11. Accept that as the price of a failover and say
so on the layer. Its own sanity gate is worth copying: a file is committed only when the fetch
passes a check, TLE line counts divisible by three and the SATCAT over 1MB. Fixture:
`tests/fixtures/astrion_mirror_stations_tle_live.txt`.

**SatNOGS DB is the independent origin.** CC BY-SA 4.0, and it names its own provenance per
record, which nothing else here does: Space-Track.org 1,520, Celestrak (supplemental) 83,
SatNOGS Team 21, Satellite Team 18, McCants 16, CalPoly 7. Under ADR 011 that makes most of it
Space-Track-origin rather than CelesTrak-origin, so it can corroborate the mirrors instead of
repeating them. Small, so it joins the union rather than carrying it. Fixture:
`tests/fixtures/satnogs_db_tle_slice_live.json`.

Its traps:

- **A long stale tail hides behind a healthy median.** Median element age 14.7 hours, p90 2,779
  hours (116 days), and the oldest record's TLE year field is `75`. A parser using `2000 + yy`
  dates it to 2075, which then wins every recency contest in the merge. **The TLE pivot is 57 to
  99 for the 1900s and 00 to 56 for the 2000s, and it is not optional.**
- **Alpha-5 is present**: one record's catalogue field has a non-digit first character.
- 90 of 1,669 fail SGP4 outright. Drop and count.
- Amateur and cubesat weighted. Starlink is absent entirely.

**The freshness policy, taken from the measured numbers rather than picked.** Draw an object
when its element epoch is under **72 hours** old: that covers 84.8% of SatNOGS, 96.0% of AMSAT,
and all of ReTLEctor's active set, whose p90 is 32 hours. Between 72 hours and **14 days**, draw
it and mark the position degraded on the card, because SGP4 error grows roughly a kilometre a
day in low orbit, so a week-old element set is a useful pin and a dishonest one if shown as
current. Over 14 days, drop and count. That threshold is what kills McCants' 15-day median.

**Measure that age on ingest from the element epochs in the body, never from mirror metadata.**
Not `pushed_at`, not `Last-Modified`, not a README table, not a `LAST_REFRESH` file.
`satvisorcom/satvisor-data` is the worked example and the reason the rule exists: pushed five
minutes before it was looked at, with a per-group refresh table in its README, and its two
largest files (`active.json` 14,875 objects, `starlink.json` 9,984) carry **March epochs, a
median age of 3,537 hours, 147 days**, while its small groups are 13 to 30 hours old. Nothing on
the surface says so. Fixture: `tests/fixtures/satvisor_mirror_stale_active_omm_slice_live.json`,
kept precisely because a mirror pushed minutes ago can be serving five-month-old data. Log a
median epoch age per group and report it on `/api/layers` next to the provider list. It is the
only honest health signal a cache can give us.

**Two single-object routes exist so the demo's hero pin is never missing.** `wheretheiss.at`
returns the ISS position, altitude, velocity and footprint in one keyless call with no
propagation code at all, and `open-notify.org` sits behind it. Neither is an independent origin:
`wheretheiss.at`'s TLE matched `tle.ivanstanojevic.me` byte for byte on both lines.
`wheretheiss.at` gives altitude in **kilometres**, so it converts in the adapter under the
metres-above-the-ellipsoid rule, and it returns a position with no element set behind it, so
there is no epoch to age-check and freshness comes from its own `timestamp` field.

**Two verified sources that are recorded and not built.** SpaceX's public Starlink ephemerides
are the highest-quality orbital data in the set, straight from the operator, and the wrong shape:
state vectors rather than mean elements, so no SGP4 and no `json2satrec`, and 11,001 files at
about 2MB each is roughly 22GB. Demand-driven per satellite is the only sane read. And NASA
SSCWeb returns keyless Earth-fixed positions for 85 currently-active named spacecraft, which
makes it an independent origin for a corroboration test; its `Geo` frame is already Earth-fixed,
so the existing `gstime` TEME-to-ECEF conversion must be **bypassed** for those records rather
than applied, or the whole thing rotates twice.

### USGS earthquake feed

`all_hour.geojson` is every earthquake in the last hour, worldwide, as GeoJSON. Captured as
`tests/fixtures/usgs_all_hour.json` and `usgs_all_hour_live.json`. Public domain as a US
Government work, so attribution is courtesy rather than a licence condition, and we credit it
anyway.

**The third coordinate is depth in kilometres, positive downward. It is not an altitude, and
nothing in the repo recorded this.** Observed `"coordinates": [-116.4973, 38.4743, 0.0106]`,
with the committed fixture ranging -0.85 to 165.5. Under this project's rule (metres above the
WGS84 ellipsoid) the conversion is `altitude_m = -depth_km * 1000`. Straight assignment puts a
165km-deep earthquake 165 metres above the ground and loses three orders of magnitude on
everything. A negative depth is legal and means above sea level.

**`bbox` is six elements with depth interleaved**:
`[minlon, minlat, mindepth, maxlon, maxlat, maxdepth]`, so `bbox[2]` is not a latitude and
`BoundingBox` in `contracts/geo.py` must never be fed this directly.

Three smaller traps. `time` and `updated` are epoch **milliseconds**, not ISO 8601, so divide
by 1000 and attach UTC in the adapter. `ids`, `sources` and `types` are comma-delimited strings
with leading and trailing commas (`",nn00923538,"`), so a naive `.split(",")` yields empty
first and last elements. And `properties.type` is `"earthquake"` on this sample but the feed
also carries quarry blasts and explosions, so it is a discriminator rather than a constant.

### NASA EONET

Natural event tracking (wildfires, storms, volcanoes) as GeoJSON. Events carry categories,
which is what the phase 5 icon set keys off.

**The bare URL this file records is 8,492,997 bytes and 7,728 features.** At a planned hourly
cadence that is 8.5MB an hour, which is not a sensible poll. Narrow it with `limit`, `days` or
`category` before it goes anywhere near a poller.

**`X-RateLimit-Limit: 60` is published on every response.** This file previously said no hard
limit was published. It is wrong.

**The content-type is `application/rss+xml` on a GeoJSON endpoint.** The body is valid JSON.
Any client dispatching on content-type refuses to parse it.

**22 features have no `date`, no `sources`, no `magnitudeValue` and no `magnitudeUnit` key at
all**, and they are the 22 `LineString` features (iceberg tracks). They carry `geometryDates`
instead. `properties["date"]` raises `KeyError` rather than returning `None`. The old committed
fixture had 29 features and all Points, so no test in the repo would have caught it;
`tests/fixtures/eonet_events_live.json` now holds all 22 LineStrings plus 100 Points.

Three more, all verified. `date` is `"2026-08-19T18:00:00Z"` and tz-aware, while
`geometryDates` entries are `"2026-06-25 00:00:00"`, space-separated and **naive**, so they
need UTC attaching in the adapter like CelesTrak's `EPOCH`. `closed` is null on all 7,728, so
the unfiltered call already returns only open events and "open" includes a 24-year-old wildfire
nobody closed: filter on `days`. And magnitude units are mixed and non-SI (`acres` 3,153,
`NM^2` 590, `kts` 55, absent or null 3,930), so `magnitudeValue` is not comparable across
categories.

### NASA GIBS

The default basemap, and the reason the app needs no Cesium ion token to render something
real. WMTS in EPSG:3857, verified via
`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml` on
2026-08-19. Daily true-colour layers are date-addressable, which is what phase 7 wires to
the timeline. `MODIS_Terra_CorrectedReflectance_TrueColor` is the layer for a daily timeline:
250m, global, one image per day since 2000-02-24. The `_Granule` variants are per-swath and the
Landsat WELD ones are annual or monthly.

**The capabilities document is 5,784,670 bytes with 1,315 layers and 10,010 ResourceURL
entries.** Fetch it once a day at most, cache it and slice it. Same discipline as the 1.1MB TfL
inventory.

Five traps, all verified on 2026-08-19:

- **CORRECTED 2026-08-20: the dateless tile template no longer 404s. It now returns HTTP 200
  with the wrong day's imagery, which is worse.** The layer advertises three templates: one with
  `{Time}`, one with no date segment and one with a literal `default` in the date position. The
  dated form is stable and unchanged (`.../default/2026-08-15/GoogleMapsCompatible_Level9/6/21/31.jpeg`
  still gives 200 at exactly 15,827 bytes), but the dateless sibling and the literal-`default`
  form both now give **200 at 27,420 bytes, which is today's imagery**. A loud 404 became a
  silent wrong-day image, the same class as the Worldview `TIME` trap. **Send the date always.**
- **CORRECTED 2026-08-20: the trap only applies to a layer that has a `Time` dimension.**
  `BlueMarble_NextGeneration` has none at all, zero `<Value>` elements and no `<Default>`, and
  all three template forms returned the identical 9,416-byte JPEG including one with an
  arbitrary `2004-08-01` in the date slot. So on a static layer a garbage date is accepted
  silently and a date error cannot be detected at all.
- **CORRECTED 2026-08-20: the `Time` `Default` being tomorrow is layer-specific, not a service
  rule.** `MODIS_Terra_Cloud_Fraction_Day` and `MODIS_Terra_Cloud_Top_Temp_Day` read
  `2026-08-21` on 2026-08-20, as recorded, but `MODIS_Terra_CorrectedReflectance_TrueColor` and
  the VIIRS true-colour layers read `2026-08-20`. Read it per layer.
- **The EPSG:4326 and EPSG:3857 endpoints report different `Time` defaults for the same layer,
  up to 30 minutes apart.** Both capabilities fetched back to back: `GOES-East_ABI_GeoColor`
  17:50:00Z on 4326 against 17:40:00Z on 3857; `Himawari_AHI_Band13_Clean_Infrared` 18:00:00Z
  against 17:30:00Z. **Take the default from the endpoint you are actually tiling from.**
- **An off-disk tile on a geostationary layer is HTTP 404 with an HTML body, not a transparent
  PNG.** At zoom 2, `GOES-East_ABI_GeoColor` returned 404 on 4 of 16 tiles, `GOES-West` on 6 of
  16, `Himawari_AHI_Band13` on 4 of 16. A geostationary disk is a circle on a rectangular grid,
  so about a quarter of tile requests legitimately have no data and **the Cesium imagery
  provider has to treat 404 as an empty tile rather than as an error to retry**, or a quarter of
  the layer logs failures and the retry traffic is pointless load on NASA. This is the one real
  integration cost on the recommended primary cloud layer.
- **A zoom past the layer ceiling is not always HTTP 400.** MODIS at `Level9` gives 400, as
  recorded below, but HLS at `Level12` requested at zoom 12 answered **HTTP 200 with a 334-byte
  transparent PNG**. Over-zoom errors on one layer and silently blanks on another, so a client
  handling only the 400 draws nothing and reports success.
- **The advertised `Default` date 404s per tile on a granule layer.**
  `HLS_S30_Nadir_BRDF_Adjusted_Reflectance` advertises `Default` `2026-08-18` inside its own
  last range, and London at zoom 10 on 2026-08-18 answered **HTTP 404** with a 196-byte HTML
  body while the same tile on 2026-08-13 answered 200 with 69,720 bytes. Coverage ranges are
  service-wide, not per tile, because HLS only exists where a satellite passed. Fixture:
  `tests/fixtures/gibs_hls_s30_default_date_404_live.html`.
- **The sub-daily coverage holes are far worse than the daily ones.** `GOES-East_ABI_GeoColor`
  advertises **100 separate `PT10M` ranges** with real gaps between them, for example
  `2026-08-13T09:30Z/09:40Z` then a jump to `10:00Z/10:00Z`. The eleven-`P1D`-ranges trap below
  is the mild version.
- **`gibs-a`, `gibs-b` and `gibs-c` are not redundancy.** All three answered 200 for the same
  tile, and `gibs.earthdata.nasa.gov` resolves to `18.165.201.35` while all three lettered hosts
  resolve to `18.165.201.43`. One CloudFront distribution behind four names. Any claim of
  provider redundancy on imagery has to come from somewhere other than NASA.
- **The capabilities census, 2026-08-20.** 1,315 layers on the EPSG:3857 endpoint, 3,905 layer
  identifiers counted on the EPSG:4326 one. Tile matrix sets in use: `Level6` 821, `Level7` 302,
  `Level8` 101, `Level9` 64, `Level12` 22, `Level13` 5. **27 layers reach Level12 or Level13,
  and two of them are 30m global true colour this file had never recorded**:
  `HLS_S30_Nadir_BRDF_Adjusted_Reflectance` and `HLS_L30_Nadir_BRDF_Adjusted_Reflectance`. 12
  GOES layers and 3 Himawari layers exist and **zero Meteosat or MSG layers do**, which is why
  the cloud layer needs a second provider.
  `Landsat_WELD_CorrectedReflectance_TrueColor_Global_Annual` is also Level12 and is dead: its
  latest advertised time value is `1998-12-01/2000-12-01/P1Y`, twenty-six years stale.
- **Coverage has real gaps: eleven separate `P1D` ranges, not one.** Missing windows include
  2000-04-26 to 2000-04-27, 2016-02-19 to 2016-02-26 and 2022-10-11 to 2022-10-22. A timeline
  stepping day by day hits dates that 404, so the valid ranges have to be parsed from the
  capabilities rather than assumed contiguous.
- **The tile matrix set is per layer, not global.** This layer links only
  `GoogleMapsCompatible_Level9`, so zoom 0 to 8, while the service advertises Level6 to
  Level13. Requesting zoom 10 on it is **HTTP 400** with a plain Apache page. Cesium has to be
  told the layer's real maximum level or every deep zoom is a 400.
- A date outside coverage is a 404 and an out-of-range zoom is a 400, both `text/html`, neither
  an OGC `ServiceExceptionReport`. That is different from the Worldview snapshot service on the
  same NASA domain, which returns XML at HTTP 200.

`gibs.earthdata.nasa.gov/robots.txt` is HTTP 404, so there is no crawl policy either way. No
numeric rate cap is published anywhere in the GIBS access documentation, so record that as
verified-absent rather than implying a provider figure.

### FAA LADD: the flag has a source, and it is not the FAA

**Verified live 2026-08-20.** The LADD attribute on
`tracker.contracts.aircraft.Aircraft.on_ladd` comes from `dbFlags` bit 8 on the readsb `/v2`
schema. readsb documents the whole bitfield in `README-json.md` as
`military = dbFlags & 1; interesting = dbFlags & 2; PIA = dbFlags & 4; LADD = dbFlags & 8`,
and adsb.lol publishes `/v2/ladd` on top of it, described in its own OpenAPI document as
"Aircrafts on LADD (Limiting Aircraft Data Displayed)" with a link to the FAA's programme page.

The measurements, so nobody has to re-take them:

- `GET https://api.adsb.lol/v2/ladd` answered HTTP 200 with **249 aircraft**, 248 at
  `dbFlags` 8 and one at 10 (LADD plus interesting). All 249 carried a registration and 225
  carried a position.
- A 250nm viewport on New York carried **26 LADD aircraft out of 539**, so the bit rides on
  ordinary position queries and not only on the dedicated endpoint. That is what makes the
  attribute available on the live layer rather than on a separate sweep.
- **16 of the 18 real Gulfstream G650s** in `tests/fixtures/adsb_type_glf6_live.json`, a
  payload already in the repo, carry it.

**This closes U1 in `docs/pending-decisions.md`.** The earlier reading, that no source for the
flag exists, was drawn from the FAA registry (which genuinely has no LADD field) and from an
`AGENTS.md` line that listed only bits 1 and 4. Both were true and neither was the whole
schema.

**The FAA does publish the list, and it is not a route open to us.** The participation list is
issued monthly, on the first Thursday, as `IndustryLADD` through the NAS Aeronautical Data
Exchange portal at `https://adx.faa.gov`, to Service Consumers who have signed FAA terms of
service. `https://www.faa.gov/pilots/ladd` itself answers **HTTP 403** to our client. So the
flag we carry is the provider's assertion, sourced from that list, rather than a fact we read
at source, and the code says so at `DB_FLAG_LADD`. Per ADR 009 nothing reads it as a
suppression instruction: a LADD aircraft resolves to its owner and renders like any other.

### ADS-B Exchange, and the three ways in

The reason this provider matters, in one line: **it does not filter.** adsb.lol and most
aggregators drop or fuzz aircraft that appear on FAA blocking programmes, and ADS-B Exchange
has never done that. So it carries aircraft no other feed carries, which is precisely the
population this project profiles. ADR 009 already decided we work through those opt-outs, and
ADR 010 makes ADS-B Exchange a first-class provider rather than an optional extra.

Three access routes, verified on 2026-08-19, and only two of them are usable.

**The paid API, which is the route.** `https://adsbexchange-com1.p.rapidapi.com/v2/mil/`
answered HTTP 401 with `{"message":"Invalid API key..."}` from RapidAPI itself, so the host,
the path shape and the gate are all confirmed live: it is the readsb `/v2` schema behind a
RapidAPI key.

**The 401 body is not stable and nothing should key on it.** Re-verified 2026-08-20 on
`/v2/lat/51.5/lon/-0.12/dist/25/`: the same missing-key request answered HTTP 401 with
`{"message":"Too many requests"}` rather than `Invalid API key`. RapidAPI's gateway picks the
message, so a client that branches on the string will read "throttled" when the real cause is
"no credential" and will back off instead of reporting itself unavailable. Branch on the 401.
The capability reason in `sources/adsb.py` quotes the `Invalid API key` wording as the thing we
observed first, which is accurate as history and is not a parse target. Entry pricing is around $10 a month for roughly 10,000 requests, which
continuous polling burns through in about a day, so the cadence has to be demand-driven
rather than a fixed poll. The provider also grants API access to anyone feeding data into the
network, which is the cheaper route if a receiver goes up. That feeder route is documented by
the provider and **has not been verified here**.

**The globe map, which is not the route.** `https://globe.adsbexchange.com/` serves the map
page (HTTP 200), but every data endpoint behind it is closed: `/data/aircraft.json` and
`/re-api/?binCraft` both answered **HTTP 403, "Request forbidden by administrative rules."**
And `https://globe.adsbexchange.com/robots.txt` disallows `/api/`, `/mapproxy/`, `/re-api/`
and `/globe_history/` by name while allowing only the static pages. That is the provider
stating a crawl directive, and honouring `robots.txt` in code is one of this project's own
rules, so scraping the map is out on two independent counts before anyone reaches the terms.

One thing that keeps ADS-B Exchange in the verified table despite no payload having been
seen: it serves the readsb `/v2` schema, and that schema is verified here against three other
providers with captured fixtures. The shape is known-good from adsb.lol. AISHub is the
opposite case, a shape unique to itself with no payload captured, which is why it sits in the
planned table below.

**The commercial route, which may already exist.** ADS-B Exchange has been owned by **JETNET
since 2023**, and Altrata licenses JetNet aircraft ownership data. A redistribution
permission may therefore be obtainable internally rather than bought, and that conversation
is worth having before anyone pays a RapidAPI invoice. It needs to happen anyway: **the
provider's terms prohibit redistributing or publishing the data**, and serving positions to
a browser is redistribution. That is a licence blocker on this layer, recorded in the audit
below.

### airplanes.live and adsb.one

Two more community networks that also decline to filter, both serving the identical readsb
`/v2` schema, which is why they cost nothing in parser work.

**airplanes.live** answered HTTP 403 on `/v2/mil` with a plain-text ask rather than a wall:
`{"error": "Please contact us at contact@airplanes.live. Your email MUST include any links, a
description of the project, and any information you deem appropriate."}` So access is gated
on asking, not on paying. Sending that email is a phase 3 task, and until it is answered
nothing in code may assume the shape of a successful response.

**adsb.one** answered HTTP 403 behind Cloudflare from this network on 2026-08-19. That may be
this IP rather than the provider's policy, so it stays a candidate rather than a plan.

### AISHub

Crowd-sourced AIS from a contributor network, and the third vessel source alongside
Fintraffic Digitraffic and aisstream.io. Worldwide coverage, free, and gated behind a
condition none of the other feeds in this project has.

**You have to run a receiver.** Verified on `https://www.aishub.net/join-us` on 2026-08-19,
in their own words: every contributor must provide at least one raw AIS feed in NMEA format,
and API access to the aggregated feed requires that feed to hold **coverage of at least 10
vessels averaged over 7 days, at least 90% uptime, downsampling no coarser than 60 seconds
and delay no worse than 10 seconds**. You stream raw NMEA to a UDP port they allocate by
email, and the account and API key follow once the feed is up and meets the bar.

**The obvious shortcut is prohibited by name.** Their terms bar synthesized or artificially
generated NMEA, scraped or stolen data, and **data from publicly available AIS sources or
services**. So you cannot bootstrap membership by piping aisstream.io or Digitraffic back
into AISHub. Access costs a real antenna within VHF range of real shipping, which is a
procurement and siting task rather than a coding one, and it is the long lead time on this
source.

**The endpoint and its parameter contract**, from `https://www.aishub.net/api` on
2026-08-19:

```
https://data.aishub.net/ws.php?username=&format=&output=&compress=
                              &latmin=&latmax=&lonmin=&lonmax=&mmsi=&imo=&interval=
```

`format` is 0 for AIS-encoded values or 1 for human-readable. `output` is `xml`, `json` or
`csv`. `compress` is 0, 1 (ZIP), 2 (GZIP) or 3 (BZIP2). The bounding box is four separate
parameters, `mmsi` and `imo` accept comma-separated lists, and `interval` caps the age of
returned positions in minutes, which is the parameter that keeps a poll cheap.

Five traps, all from the same page, and each one is the kind that ships a broken layer:

- **`output` defaults to `xml`.** Pass it explicitly every time, exactly like CelesTrak's
  `FORMAT`.
- **There are two failure bodies, not one, and both are HTTP 200.** Measured 2026-08-20 in one
  sweep, same host, same query string, one parameter apart:
  - **No `username` parameter at all: HTTP 200, `content-length: 0`, `content-type: text/html`.**
    An empty body with no JSON in it. This is the empty-200 case this file and `AGENTS.md` both
    recorded as untested, and it is now measured.
  - **A bad `username`: HTTP 200 with a JSON error envelope.** `username=NOSUCHUSER` answered
    **105 bytes**, verbatim:
    `[{"ERROR":true,"USERNAME":"NOSUCHUSER","FORMAT":"HUMAN","ERROR_MESSAGE":"Invalid username or password!"}]`
  So an adapter has to survive a body that will not parse as JSON as well as one that parses into
  a status envelope. `response.json()` raises on the first and succeeds on the second.
- **The byte count was never a safe check, and this file quoted one.** The envelope length includes
  the username echoed back, so the same failure was 115 bytes for `TRACKER_NO_SUCH_USER` on
  2026-08-19 and 105 bytes for `NOSUCHUSER` on 2026-08-20. Corrected 2026-08-20: do not compare
  lengths. The check that holds is `body[0]["ERROR"] is True` on a body that parsed, and a body that
  did not parse or came back empty is a failed poll, counted, never an empty vessel list treated as
  "no ships anywhere". `tests/fixtures/aishub_ws_invalid_username_live.json` holds the complete
  2026-08-19 body.
- **The over-frequent-call half of the claim is still untested.** Their own note says "The web
  service will return nothing if executed more frequently", and confirming it needs two calls
  inside a minute, which is the abuse the cadence rule exists to stop. Treat it as unverified, not
  as wrong. It is worth noting that a throttled response and a no-username response would now look
  identical, both being an empty 200, so the adapter cannot tell them apart and does not try.
- **The response is an array whose element 0 is a status envelope**, not a flat list of
  vessels. So a success body is an envelope followed by the vessel data, and anything doing
  `for vessel in response` iterates the metadata object as if it were a ship. This is new: the
  note below used to say no payload had been seen at all.
- **Once per minute, hard.** Not a courtesy figure, it is the documented behaviour, so the
  cadence floor is a constant in code with a test, same treatment as CelesTrak's two hours.
- **`format=0` values are scaled integers.** Longitude and latitude are degrees multiplied by
  600000 (1/10000 minute), course over ground is degrees times 10, speed over ground is knots
  times 10, draught is metres times 10. `format=1` gives degrees, knots and metres directly,
  which is why the adapter uses it.
- **Sentinels, not nulls.** Course over ground 3600 (`format=0`) or 360.0 (`format=1`) means
  not available; speed over ground 1024 or 102.4 means not available; heading 511 means not
  available in both; `IMO` 0 means absent. Each maps to `None` in the domain, never to a
  bearing of 360 degrees or a stationary vessel. The bottom of each range is not available
  either: a negative course, heading or speed maps to `None` rather than being handed to the
  strict field, where the rejection would cost the whole ship over one optional attribute.
- **`RECORDS` in the envelope is the only cross-check this provider offers, so it is read.** An
  envelope claiming more records than the vessel array carries is a truncated answer and is
  counted as a failed poll, on a feed that answers both a bad username and an over-frequent
  call with HTTP 200. `RECORDS` of zero above an empty array is **not** an error: the client
  takes a bounding box, an MMSI list and an interval, so a box over quiet water is a correct
  zero and refusing it would report the provider unavailable for a right answer.

Two smaller shape notes. The timestamp field is named `TIME` in the JSON output and `TSTAMP`
in the XML and CSV outputs, for the same value. In human-readable form it arrives as
`"2021-07-09 08:06:53 GMT"`, which parses naive and needs UTC attached in the adapter, the
same fix CelesTrak's `EPOCH` needs. And `NAME` is capped at 20 characters upstream, so a
truncated vessel name is upstream truth rather than our bug.

**No success payload has been seen.** The gate is now verified: the host answers, the error
envelope is captured, and `"FORMAT":"HUMAN"` echoed back confirms `format=1` is the
human-readable mode. What is still missing is a body containing vessels, so the source stays
NOT YET VERIFIED and the wire model must be written against a real captured success response
rather than against the parameter table above. That is the file's own rule and this source is
exactly what it was written for.

`robots.txt` on the API host `data.aishub.net` is HTTP 404, so there is no crawl directive
there. `www.aishub.net/robots.txt` disallows only `/admin/`.

### GeoNames `cities15000`

The city layer. Every populated place above 15,000 people, with name, country, admin
division, population, timezone and coordinates. Verified on 2026-08-19 by downloading the
whole file: HTTP 200, 3,306,600 bytes, `Last-Modified` and `ETag` both served, so the weekly
refresh is a conditional `If-None-Match` request that normally costs nothing.

**The conditional request is now verified rather than assumed.** Called on 2026-08-20 with the
`ETag` the running product had cached, `"327468-65970ccb25bfc"`:

```
HTTP/1.1 304 Not Modified
ETag: "327468-65970ccb25bfc"
[bytes=0 time=0.063775]
```

Zero bytes and 64 milliseconds against 3,306,600 bytes for the file, so the weekly refresh costs
effectively nothing in the normal case. The running product also proves the in-process floor is
doing its job before the network is involved at all: a restart six hours after the last download
indexed 34,072 cities in 65 milliseconds from the cached zip and issued no request to
`download.geonames.org` at all. Both measured on a live run, output in `docs/status.md`.

**Three corrections, all made 2026-08-19 against the real file.** This file was wrong in three
separate ways at once and one of them would have put cities in the wrong hemisphere.

1. **The row count is 34,099, not "roughly 26,000".** Measured from the unzipped member,
   8,406,754 bytes. GeoNames' own readme says "ca 25.000" and is also wrong. `cities1000` is
   about 130,000 rows per the readme, not the 140,000 this file used to claim.
2. **The encoding is valid UTF-8 with no BOM, not "latin-1-tolerant".** The whole file decodes
   as UTF-8. Reading it as latin-1 raises nothing and silently mangles every non-ASCII name:
   `Warisan` with a macron becomes mojibake with no exception. Decode as UTF-8 and let a
   decode error be an error.
3. **The column positions were wrong under both counting conventions.** This file and
   `AGENTS.md` both said "Column 6 is latitude and column 7 is longitude". The readme's own
   order gives, one-based: 5 latitude, 6 longitude, **7 feature class**. Zero-based: index 4
   latitude, index 5 longitude. Proved over the whole file: index 4 ranges -54.81 to 78.22
   with zero values outside +/-90, index 5 ranges -176.17 to 179.36 with **9,075 values
   outside +/-90**. Anyone coding to the old numbers reads the single character `P` where a
   float belongs, which at least fails loudly.

**A 200 carrying an HTML error page is worse than an outright 503.** Found by review on
2026-08-20. A CDN or proxy error page served with HTTP 200 is a usable-looking body that is not
a zip. Cached before it is checked, it destroys the working gazetteer, takes a fresh mtime, and
the weekly floor then short-circuits onto the poison for a week with no further request, while
the failure reason is discarded so the product reports that the refresh never ran. A 503 keeps
the good copy and reports the reason, so the unchecked path was strictly the worse outcome. The
body is checked before it is written, and an unreadable copy on disk sets the reason too.

**An ETag file can outlive its zip.** A tmp reaper, a manual delete or a truncated write leaves
the validator on disk with nothing to validate. Sending it asks GeoNames to confirm a file we
cannot serve, and the 304 that comes back is unusable by construction, so the layer stays empty
until the upstream zip happens to change. The validator is only sent when the zip is in hand.

It is a bulk file, not an API, which is the point: cities do not move, so this is a weekly
download into a local index rather than a poller. `cities1000` exists if a denser set is
ever wanted, at roughly 140,000 rows. Licence is CC BY 4.0, confirmed in
`https://download.geonames.org/export/dump/readme.txt` on the same date, so the credit line
is a licence condition and not a courtesy.

The file is UTF-8 tab-separated text with no header row and a fixed 19-column layout,
confirmed as exactly 19 fields on all 34,099 rows. **Coordinate order is latitude then
longitude**, the opposite of our contract order, so it gets flipped in the adapter. There are
zero double-quote characters and zero carriage returns in the whole file, so a plain
`split("\t")` is safe and `csv.reader` is a hazard rather than a help, because `"` is its
default quote character.

Four more things measured over the full file, each of which would otherwise be found by a
user rather than a test:

- **It contains dead places.** 27 rows are PPLH (historical), PPLQ (abandoned) or PPLW
  (destroyed) and they carry a live-looking population: `Pittwater` AU at 63,482, `Sant Marti`
  ES at 235,719, `Pechersk` UA at 100,900. Unfiltered, the gazetteer resolves a post to a city
  that no longer exists. A further 2,376 PPLX rows are sections of a city rather than cities.
- **`feature class` is `P` on every row here**, so it carries no information. All the signal
  is in `feature code`, 17 distinct values.
- **1,307 names appear more than once** (Victoria 9 times, Richmond 9, Springfield 8). Name
  alone is never a key. London ranks correctly with no tie-break work: London GB at 8,961,989
  against London CA at 422,324, a factor of 21.
- **`modification date` is a bare `yyyy-MM-dd` with no time and no zone**, so it cannot become
  a `UtcDatetime` without inventing a time. Carry it as a date, or pin it to midnight UTC and
  record that the time is ours.

Licence is CC BY 4.0, confirmed in `https://download.geonames.org/export/dump/readme.txt` on
2026-08-19, so the credit is a licence condition and not a courtesy. CC BY wants a link to the
source and a link to the licence, so the bare text string in the attribution table below is
thin on its own.

### Wikidata WDQS

The person and organisation layer. Verified on 2026-08-19 with a live SPARQL query for
instances of city (`wd:Q515`), which returned HTTP 200 and JSON results.

The provider's own stated limits, quoted from the WDQS User Manual: a **60-second hard query
deadline**, 5 parallel queries per IP, 60 seconds of processing time per 60 seconds per client
(User-Agent plus IP), and **30 error queries per minute** with HTTP 429 on breach. The error
budget is the one worth knowing: a bad query in a retry loop burns the allowance and gets the
client throttled with no successful traffic at all. Every query ships with a `LIMIT`.

**Correction, 2026-08-19: "a generic User-Agent gets blocked" is not reproducible.** A bare
default curl User-Agent got HTTP 200 with a correct answer. The Wikimedia Foundation policy
says enforcement "may be enforced in specific cases as needed", so the practical position is
the opposite of a hard gate and it is worse: a policy breach that succeeds in development and
gets blocked later without notice. There is no failing test to write against it. The
descriptive User-Agent has to be a constant in the client with a test asserting it is sent.

Three shape traps found on 2026-08-19 against the phase 6 attribute queries:

- **A missing value is an absent key, not a null.** `head.vars` lists every projected variable
  whether or not anything bound. This is the opposite convention to the MediaWiki action API,
  which returns an explicit `null` for a requested-but-absent property. Two Wikimedia APIs, two
  conventions, in one feature.
- **`wdt:` throws date precision away, silently.** `wdt:P569` returns
  `"1971-06-28T00:00:00Z"` whether the precision is a day or a year, so a year-only date of
  birth reads as 1 January. If a date of birth is a match key it has to come through the
  `psv:` value node with `wikibase:timePrecision` (11 day, 10 month, 9 year), or the resolver
  scores a false match on a fabricated date.
- **P625 coordinates are longitude first**, as a WKT `Point` literal: Pretoria is
  `Point(28.188 -25.746)`. That matches our contract with no flip, which is the opposite of
  GeoNames and NASA Worldview, so no adapter here can be copied from either.

Two sizing facts phase 6 should know before it promises a residence attribute. Of six P551
residence statements across two well-populated people, only three carried a `pq:P580` start
time, so **roughly half of Wikidata's residence data is undated and fails our own contract**.
And three of the six carried no reference at all, with one of the references being a news
article, which under ADR 011 is one origin with that article rather than a second source.
Wikidata is a thin location source, not a rich one.

Vessel coverage, verified the same day: **38,129 items carry an MMSI (P587)**. P458 is the
IMO number, P8047 country of registry, P127 owned by. MMSI and flag are well populated;
ownership is not, at 1 of 12 sampled rows. A malformed query returns a **plain-text HTTP 504**
reading `upstream request timeout`, so a parser that assumes JSON on any response throws.

### Wikimedia Commons geosearch

Reference imagery for a place, and the one image source whose coordinates come from the
upstream rather than from parsing text. Verified on 2026-08-19 against London
(`51.5074|-0.1278`, 1,000m radius), HTTP 200.

Licences are per file, not per source, so the file's own licence and author have to be
fetched with it and rendered on the card. There is no blanket credit string that covers
this source. Where a file carries an `Attribution` value the uploader set it as the required
credit and it must be used verbatim, for example `(c) European Union, 2026`.

**`list=geosearch` returns pages, not files, and it is worse than that.** Verified 2026-08-19:
30 namespace-6 results, none carrying `url`, `thumburl`, `mime`, `imageinfo` or a licence, and
the top hit was an `.ogg` audio file. An "images near here" layer built on it ships broken
tiles. The one-call fix is
`generator=geosearch` with `prop=imageinfo|coordinates`, which returns the licences inline and
keeps the coordinates. Using `generator=geosearch` with `prop=imageinfo` alone **drops `lat`,
`lon` and `dist`**, which is the entire reason geosearch was called. `dist` is lost either way
and has to be computed locally.

**The silent data-loss trap: `missing: true` does not mean the file is missing.** Querying a
File page against a local wiki rather than Commons returns `"missing": true`,
`"imagerepository": "shared"` **and a full `imageinfo` block with a valid licence**, because
the file lives on Commons and the licence is served from there. Captured in
`tests/fixtures/commons_imageinfo_shared_file_live.json`. **The drop condition is the absence
of an `imageinfo` key, never the presence of `missing`.** An adapter that drops on `missing`
throws away every Commons-hosted file reached through a local wiki and reports it as
unlicensable. `imagerepository` is what distinguishes the three states: `""` nowhere, `"local"`
on this wiki, `"shared"` on Commons.

Six more traps in the same response, all verified:

- **`thumbwidth` and `thumbheight` never describe the bytes at `thumburl`.** Asking for
  `iiurlwidth=512` returned `thumbwidth: 512` against a URL whose decoded JPEG is **960
  wide**. Wikimedia renders to its own standard widths and hands back whichever covers the
  request; only 20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920 and 3840 are served, and a
  direct request for anything else is HTTP 400 with an HTML body. Any face bounding box, crop
  or embedding preprocessing computed against `thumbwidth` is misaligned rather than wrong,
  which for phase 14 reads as degraded match rates rather than a bug. Read the dimensions off
  the decoded image or parse the `NNNpx-` segment out of the URL. If the original is narrower
  than the request there is no thumbnail at all and `thumburl` equals `url`.
- **`extmetadata.value` is not always a string.** `CommonsMetadataExtension` is the float
  `1.2`. Type it `str | float | int`.
- **The boolean-ish fields are strings and disagree on capitalisation**: `Copyrighted` is
  `"True"` while `AttributionRequired` is `"true"`. Never `bool()` them; compare
  case-insensitively.
- **`Artist` and `Credit` carry raw HTML** and must be sanitised rather than printed. The worst
  captured case is `Unknown author<span style="display: none;">Unknown author</span>`, which a
  naive tag-strip renders as "Unknown authorUnknown author". Some hrefs are protocol-relative.
- **The dates ADR 015 needs are naive and inconsistently formatted.** `DateTimeOriginal` came
  back as `"2025-09-21 11:33:09"` on one file and `"2025-06-25"` on another. The only properly
  formatted timestamp on the record is `imageinfo.timestamp`, and that is the upload time, not
  the capture time. So the adapter needs two naive parse forms plus UTC attachment, and it has
  to record which field it used.
- **`GPSLatitude` and `GPSLongitude` are strings with latitude first**, datum WGS-84. Under
  ADR 015 that is where the camera was, not where a person was. `coprop=type` distinguishes
  `camera` from `object`, and which one arrived has to reach the domain contract because they
  are different claims. Filter on `globe == "earth"`: Wikimedia holds coordinates on the Moon
  and Mars.

**The 50-record ceiling was `iiurlwidth`, not `ggslimit`, and it is the trap that cost most
here.** Measured 2026-08-24 against a 500-page geosearch of London. With `iiurlwidth=500` the
response carried 500 pages, **50 `imageinfo` blocks**, 342KB, no `batchcomplete`, and an
`iicontinue` token offering the rest. Because the drop rule is the absence of `imageinfo`, the
other 450 were discarded as unlicensable, so raising `ggslimit` alone bought 450 dropped records
and 32% more bytes for not one extra post. Removing `iiurlwidth` gave **500 `imageinfo` blocks,
2,081KB and `batchcomplete: true`**. MediaWiki resolves a `prop` module for at most 50 titles per
request when a thumbnail render is asked for, and nothing in the payload states it.

The thumbnail address is derivable instead, so nothing is lost: `/commons/6/66/Name.jpg` becomes
`/commons/thumb/6/66/Name.jpg/500px-Name.jpg`, and for **all 47 raster files in a live 50-record
response the derived URL was byte-identical to the one the API returned**. The three non-rasters
were the only difference, and there the API answers with its own static UI icon on
`commons.wikimedia.org`, which is not a rendition of the item. A derived thumbnail for
`application/ogg`, `video/webm` and `image/tiff` answers **HTTP 400**, because Wikimedia renders
those under other names, so only `image/jpeg`, `image/png` and `image/gif` get one. Those are
99.86% of a 4,000-record census across ten viewports (jpeg 99.60%, png 0.23%, gif 0.03%). This
also stops us asking the thumbnailer to render fifty images per viewport that we then do not
fetch, which is expensive work for the provider in a way that JSON is not.

**500 is the number because a city is not legible below it**, and it is the provider's own stated
ceiling rather than one we picked. Distinct coordinates against `ggslimit`, no `iiurlwidth`: at
Times Square 37, 41, 95, 153, 300 for 50, 100, 200, 300, 500, still doubling between the last
two. At Charing Cross **19 distinct coordinates from 50 all the way through 300**, because the
nearest 300 files there sit on 19 copied placeholder points, and real places only appear past
300. Bytes are 745KB median across twelve city viewports, 712KB best, 1,600KB worst (Berlin).
`iiextmetadatafilter` is what makes that affordable: filtered to the six keys the adapter reads,
a 500-record London response falls from 2,081KB to 743KB with a byte-identical parse.

**The count is a ceiling and not a total, even zoomed in.** A 359m circle on Charing Cross still
returns a full 500 files, so the layer reports the truncation the same way it reports a clamped
radius.

**Two failures share one shape and only one of them means "nothing here".** A search that matches
nothing, verified mid-Pacific, mid-South-Atlantic and Antarctic interior, returns HTTP 200 and 51
bytes: `{"batchcomplete":true,"limits":{"coordinates":500}}`, with no `query` key and no `error`.
`CirrusSearch` under load returns HTTP 200 with `code: cirrussearch-too-busy-error`, 2 of 36
sustained calls, which is distinguishable because it carries an `error`. A third shape was seen
three times, 57 bytes with neither `error` nor `query`, at two locations that reliably return 500
pages on their own, and **its body was not captured**, so whether it is distinguishable from the
genuine empty is unproven. Until it is, a response with no `query` is treated as a failure rather
than as "no photographs here": the cost is a wrong notice over open ocean, and the alternative is
reporting zero photographs at Delhi.

Two of the 30 geosearch results sat at `dist: 0` with coordinates equal to the query point to
four decimal places, one of them the `.ogg`. That is a generic "London" coordinate copied onto
a file, so a radius search that trusts `dist` ranking puts the least reliable records first.
Filter on `mime` starting `image/` before anything else.

### OpenStreetMap notes

Crowd-sourced text at a real coordinate: a note is a free-text comment a mapper left at a
location. Verified on 2026-08-19 over a London bounding box, HTTP 200.

This is the honest half of the social layer. The coordinate is the subject of the note
rather than a guess derived from its words, and it carries no claim about where the author
was. Coordinates are `[longitude, latitude]`, matching our contract with no flip. Notes are
user-submitted text, so they are the least trustworthy input in the system and get the
treatment in `AGENTS.md` under Data sourcing.

**The terms are a problem and this file did not record it.** The OSMF API Usage Policy states
"The editing API is provided in order to edit the map data, **not** for read-only purposes or
projects" and "Large or frequent data users must use the download service 'planet.osm'".
`api.openstreetmap.org/robots.txt` names `/api/` and `/note` in its disallow list and adds the
comment "Scraping puts a high load on our donated resources and will lead to your IP being
blocked." Polling `/api/0.6/notes.json` is exactly the read-only use of the editing API the
policy rules out. This is a terms position, not a technical block: the endpoint answers 200.
The permitted route is the notes bulk dump under `planet.openstreetmap.org`. **No provider
requests-per-second figure exists**, so the "roughly 1 request per second" this file used to
state as a cap was our own guess presented as theirs.

Five shape traps, verified 2026-08-19 over a 100-feature London response:

- **Dates are not ISO 8601.** The live format is `"2026-08-19 22:07:42 UTC"`: space separator,
  literal ` UTC` suffix, no `T`, no `Z`. `datetime.fromisoformat` rejects it. The OSM wiki
  documents `2015-01-01T18:56:48Z`, so an adapter written from the docs fails on every record.
  Applies to `date_created`, `closed_at` and every `comments[].date`.
- **Field presence flips on status.** `comment_url` and `close_url` appear only on open notes;
  `reopen_url` and `closed_at` only on closed ones. All four optional.
- **Anonymous comments drop three keys rather than nulling them.** 12 of 195 comments have no
  `uid`, no `user` and no `user_url`.
- **Closed notes come back by default**, contrary to the wiki. 27 of 100 were closed, because
  the real default is `closed=7`. Pass `closed=0` if only open notes are wanted.
- **`limit` defaults to 100 and truncates with no flag.** The London box hit exactly 100, so
  the response was a truncated page and nothing said so. Maximum is 10,000, and the maximum
  bbox area is 25 square degrees.

### Mastodon public timeline

Geolocated social posts, with the caveat that makes the layer what it is: **a Mastodon
status object carries no coordinates.** Verified on 2026-08-19 against `mas.to`, HTTP 200,
and the returned status keys are `account`, `card`, `content`, `created_at`, `tags`,
`media_attachments`, `language`, `visibility` and the counts. There is no latitude, no
longitude and no place object anywhere in the shape.

So any position on a post is derived from its text and its hashtags, and the card says so
in those words. See ADR 005.

**ADR 005 is proved, not assumed.** The whole 40-status payload was walked recursively and
every key at every depth collected: 96 distinct keys, and **zero** matching
`lat|lon|lng|coord|geo|place|position|location|point|bbox|address|country|region|city|gps`.

The key list this file used to record is a correct subset of a 28-key status object. It omitted
`quote`, `quote_approval`, `tagged_collections`, `edited_at`, `poll`, `reblog`, `uri`, `url`,
`sensitive`, `spoiler_text`, `mentions`, `emojis`, `in_reply_to_id`, `in_reply_to_account_id`
and `application`. Traps worth having:

- **`media_attachments[].meta.focus.x` and `.y` are the only `x`/`y` in the payload and they
  are the image crop focal point**, roughly -1 to 1. A find-the-coordinates heuristic reads
  them as a position and pins every photo post at null island.
- **`account.fields` is the nearest thing to a location in the object and it is unusable.** A
  real observed value is `("Location", "Habitual Wildfire Evac Zone")`, and the values contain
  raw HTML anchors.
- `language` can be `null` and is multilingual by default: 29 English, 3 Spanish, 3 null, plus
  German, Korean, French and Japanese in 40 posts. Any text-to-gazetteer resolution has to cope
  or drop and count.
- `application` appeared on 1 status of 40: optional, not nullable. `created_at` is tz-aware
  with a `Z` so no UTC attachment is needed.
- `remote_url` on an attachment points at another instance's CDN, because content is federated.
  Media proxying follows a host we did not choose.

**Instance policy: 200 is the more common answer.** Tested with `?limit=5` on 2026-08-19:
`mas.to`, `mstdn.social`, `fosstodon.org`, `hachyderm.io` and `mastodon.world` all answered
200. `mastodon.social` **and `infosec.exchange`** both answered 422
`{"error":"This method requires an authenticated user"}`. Five of seven serve it. The
drop-the-instance-for-the-cycle design is right, and `infosec.exchange` belongs in the same
bucket as `mastodon.social`.

**A licence condition this file did not record.** `mas.to/robots.txt` carries
`Content-Signal: search=yes,ai-train=no,use=reference`, preceded by a statement that the
restrictions are express reservations of rights under Article 4 of EU Directive 2019/790.
`ai-train=no` bars training or fine-tuning on the content. `ai-input` is not signalled either
way, and the ADR 014 and ADR 015 work runs local models **over** post content rather than
training on it, which falls on the unsignalled side. That is defensible, and it is
machine-readable, per instance and can change without notice, so the signal has to be read
rather than assumed.

**`mastodon.social` no longer serves this endpoint anonymously.** It answered HTTP 422
`{"error":"This method requires an authenticated user"}` on 2026-08-19, with and without
`local=true`. `mas.to` answered 200 for the identical request. Instance policy is per
instance and changes without notice, so the instance list is configuration and a 401, 403
or 422 from one instance drops it for the cycle rather than failing the feed.

### GDELT DOC 2.0 article search

The news-mention source behind person location evidence in phase 6, and the input to the
occupancy estimate's contradiction check in phase 12 (ADR 011, ADR 012). Verified on
2026-08-19 with `query="Elon Musk"&mode=artlist&maxrecords=3&format=json&timespan=3d`,
HTTP 200, real articles returned.

Four facts worth having before anyone writes the adapter.

**It states its own rate cap in a 429, and the first request got one.** The body reads
"Please limit requests to one every 5 seconds", so the floor is five seconds, in code, with
the article search cached per profile. The 429 body is **plain text, not JSON**, and it is
prepended to the body even on a subsequent 200, so a parser must find the JSON rather than
assume the whole body is JSON.

**`mode=artlist` returns no coordinates.** Each article carries exactly eight keys: `url`,
**`url_mobile`**, `title`, `seendate`, `socialimage`, `domain`, `language` and
`sourcecountry`. The same key-pattern scan run over Mastodon found one geographic match here,
`sourcecountry`, which is where the outlet is, not where the person was, and conflating the two
would be a fabricated location.

**`seendate` is ISO 8601 *basic* format**, `20260818T054500Z`, no separators.
`datetime.fromisoformat` rejects it; `strptime("%Y%m%dT%H%M%SZ")` is needed. `language` is a
display name (`"English"`), not an ISO code.

**One successful call bought a 429 penalty window of at least twelve minutes.** Timeline from
this IP on 2026-08-19: one 200 on `artlist`, then 429 on every attempt for the following twelve
minutes with no intervening traffic. So a cadence floor of exactly five seconds still collects
429s, and a 429 has to trigger a real exponential backoff measured in minutes rather than a
retry on the next poller tick. The 429 body carries **no `Content-Type` header at all**.

**GDELT GEO 2.0 is unreachable.** `https://api.gdeltproject.org/api/v2/geo/geo` answered
**HTTP 404** twice on 2026-08-19, with Apache's default error page, while DOC 2.0 on the same
host answered 200. The URL is right, so this is the endpoint being down rather than a bad path.
Nothing may be designed on top of it.
The place comes from the article text matched against the phase 4 city gazetteer, so a
mention is `derived` and city-level like a Mastodon post, never `upstream`.

**A mention is a report about a person, not an observation of one.** It carries the article
as its source and the publication date as its date, and it needs corroboration from an
independent origin before it is asserted, per ADR 011. Syndication makes this bite: the same
wire story on twelve domains is one source, not twelve.

**Results are multilingual by default.** The verified response mixed English, Persian and
other languages, so language is a filter decision the adapter makes explicitly rather than
something to be surprised by.

### Sentinel-2 scenes: Element 84 earth-search

The source that answers "show me this place on this date". The NASA GIBS basemap cannot: it
is a tile service pinned to a global daily mosaic. This returns the actual Sentinel-2 scenes
covering a bounding box in a date range. Verified on 2026-08-19 with a POST to `/v1/search`
over a London bounding box for 1 to 19 August 2026, HTTP 200, two scenes returned.

Keyless. The search is a POST carrying `collections`, `bbox` and `datetime`. Each feature
holds per-band assets plus `visual`, the true-colour composite, as a Cloud-Optimised GeoTIFF
on S3.

**Both London scenes came back at essentially 100% cloud cover**, confirmed exactly on
2026-08-19: `eo:cloud_cover` of `100` and `99.999177` for 2026-08-18. Keep the trap and fix the
framing, because that is a fact about one day rather than a verdict on the source. Over 1 July
to 19 August 2026 the same bounding box returned **36 scenes under 20% cloud**, the best at
0.004104 on 2026-07-29. Copernicus agrees at 8 products for the same window. The layer is fine.
Filtering is the whole job, and a search that does not filter or rank on `eo:cloud_cover`
returns white rectangles and looks broken. Put the scene's own date on the card, because it
will often not be the date that was asked for.

**CQL2 is silently ignored, at HTTP 200.** The root document's `conformsTo` list carries no
CQL2 filter class, and sending `filter-lang: cql2-json` with
`{"op":"<","args":[{"property":"eo:cloud_cover"},20]}` answered 200 with `numberMatched: 174`
and five results at 100, 99.998772, 99.998385, 100 and 99.999177. **The filter was discarded
with no error.** A developer writes the filter, gets a 200 and ships white rectangles.
Captured as `tests/fixtures/earthsearch_s2_cql2_ignored_live.json`.

**What does work is the legacy STAC `query` extension.** `{"query": {"eo:cloud_cover":
{"lt": 20}}}` with `"sortby": [{"field": "properties.eo:cloud_cover", "direction": "asc"}]`
took the same search from 174 matches to **36** and sorted correctly. The 174-against-36 pair
is the proof one filter bit and the other did not.

**`eo:cloud_cover` arrives as an `int` or a `float` in the same response.** `100` came back as
a JSON integer and `99.999177` as a float. A strict `float` field rejects the integer under
pydantic `strict=True`. The same int-or-float mix appears across every `s2:*_percentage` field.

**There is a `thumbnail` asset and this file did not record it.** `preview.jpg`, `image/jpeg`,
343x343, 2,563 bytes, keyless, no requester-pays. It is a card image rather than an inspectable
one, but it removes the "no browser image exists" framing. There is **no `overview` key**.
Range requests work on `visual` (`TCI.tif` answered HTTP 206 on `-r 0-1023`), so a server-side
COG window read is available when a real cut is needed.

**`proj:centroid` is `{lat, lon}`, latitude first**, while the feature `bbox`, the `geometry`
and our contracts are all longitude first. One flip, in one field, in an otherwise
lon-first payload. Pagination is a `next` link carrying a composite cursor string of timestamp,
item id and collection, not an offset.

Sentinel-2 revisits a given point roughly every five days, so imagery for today does not exist
for most places on most days. The contract carries the scene timestamp, never the requested
one, and a request with no usable scene returns nothing rather than the nearest cloudy thing.

A Cloud-Optimised GeoTIFF is not a browser image. Serving `visual` to Cesium means a
server-side tile cut or a rendered snapshot, which is what the Worldview snapshot API below is
for.

### Copernicus Data Space OData catalogue

The first-party catalogue for the same Sentinel data, and the fallback if the AWS mirror goes
away. Verified on 2026-08-19, HTTP 200, real product records returned.

**The filter this file used to record returns the wrong kind of thing.**
`$filter=Collection/Name eq 'SENTINEL-2'&$top=1` is technically true and practically wrong: the
single product it returns is
`S2A_OPER_AUX_GNSSRD_POD__20171211T090149_...`, a 1.8MB GNSS orbit auxiliary file from 2015
with `ContentType: application/octet-stream`. The SENTINEL-2 collection holds auxiliary and
calibration products alongside imagery, so anyone copying the old filter gets orbit files.
**`contains(Name,'MSIL2A')` is the minimum discriminator**, and the working imagery filter also
needs `OData.CSC.Intersects` plus a `ContentDate/Start` window.

Server-side cloud filtering is a real OData predicate here and it errors rather than ignoring
you, which is the opposite of earth-search:
`Attributes/OData.CSC.DoubleAttribute/any(att:att/Name eq 'cloudCover' and att/OData.CSC.DoubleAttribute/Value lt 20.0)`.

Four shape traps:

- **`Footprint` is a string, not an object**: `geography'SRID=4326;POLYGON ((...))'`, WKT
  wrapped in OData syntax. `GeoFootprint` is proper GeoJSON, longitude first. Use that one.
- **`Attributes` is a list of `{Name, Value, ValueType}` objects, not a mapping**, and it only
  appears with `$expand=Attributes`. `cloudCover` lives in there. Both `ValueType` and
  `@odata.type` have to be read to know whether `Value` is a number or a string.
- **`EvictionDate` is `9999-12-31T23:59:59.999999Z`, a "never" sentinel.** It parses cleanly
  because `datetime.max` is year 9999, so nothing errors: it just renders as an eviction date
  in the year 9999. Same class as the Companies House `9999` sentinel below.
- **The two catalogues date the same scene differently.** For tile 30UXC on 2026-08-18,
  earth-search `properties.datetime` is `11:16:45.333Z` and Copernicus `ContentDate.Start` is
  `11:06:19.024Z`, ten minutes and 26 seconds apart, because one is the granule sensing time
  and the other the datatake start. Deduplicating across the two on timestamp fails. Match on
  the MGRS tile plus the calendar date, or on the granule identifier, which is the same string
  in both.

**No rate limit, quota or throttling policy is published** for the OData API, and the
documented examples are unauthenticated, so the keyless catalogue position is verified-absent
rather than quoted. Both catalogues reported the same cloud figure for the same underlying
record (100 and 100.0), which is cross-source corroboration on a fact rather than a claim.

Search is keyless. Download is not: product bytes need an OAuth token from the Copernicus
identity service and the token carries a quota. So the catalogue is usable today for "what
imagery exists here", and the download path needs an account registered before any code
depends on it.

### NASA Worldview snapshot API

The rendered-image route, and the one that needs no GeoTIFF handling at all. Verified on
2026-08-19 for a London box on 2026-08-15, HTTP 200, `image/jpeg`, 41KB.

Give it a layer, a date, a bounding box and a size, and it renders. That makes it the right
source for a picture on a profile card or an event card, where the need is an image of a place
on a day rather than pixels to analyse.

**Its `BBOX` is `south,west,north,east` in `EPSG:4326`, latitude first.** Proved twice on
2026-08-19 with the same box, same layers, same size and only the order swapped: latitude first
returned a 54,795-byte PNG of the Thames valley, longitude first returned **HTTP 200 and a
valid 1,889-byte PNG of empty Indian Ocean**. Both fixtures are committed. NASA's own blog post
states `BBOX (format: minLat,minLon,maxLat,maxLon)`. The flip happens in the adapter and
nowhere else, with a test, because the only tell on the wire is a 29x size difference and that
is only because ocean compresses.

**Errors arrive as HTTP 200 with `Content-Type: text/xml`.** Verified for a missing `REQUEST`,
a missing `HEIGHT`, a missing `BBOX` and an invalid `CRS`, all 200. Captured as
`tests/fixtures/worldview_snapshot_error_http200_live.xml`. So the adapter branches on
content-type, not on status: a 200 that is not an `image/*` is an error, counted, and must never
replace a cached image. A bad **layer** is different again, HTTP 500 whose body is the literal
string `Internal Server Error: ` prepended to an XML `ServiceExceptionReport`, so an XML parser
fed the whole body throws. Same class as the GDELT plain-text prefix.

The parameter matrix, all tested. Required: `REQUEST`, `BBOX`, `WIDTH`, `HEIGHT`. Optional and
dangerous: `CRS` defaults to EPSG:4326, **`FORMAT` defaults to PNG** at 3.7x the JPEG size, and
**`TIME` is optional and silently substitutes a default date**, returning a real image of the
wrong day at HTTP 200. Always send `FORMAT` and `TIME`. `RESOLUTION` does not substitute for
`WIDTH`/`HEIGHT`. **`CRS=EPSG:3857` is rejected here** with `InvalidCRS`, and 3857 is exactly
what the GIBS tile service uses, so one shared CRS constant across the two breaks the snapshot
call.

**The API is undocumented and carries no contract.** No parameter reference, no published
limits, and its only public documentation is one worked example in a NASA blog post about
replacing the deprecated Image Download service. It works today. Nothing says it will keep
working, and this file previously presented it as a settled interface. The 41KB size recorded
for the earlier verification is not a stable fact either: it tracks `WIDTH` and `HEIGHT`, and
the same call at 800x600 is 57,651 bytes.

### TfL JamCams

889 London traffic cameras, and they need no key at all. Verified on 2026-08-19, HTTP 200, and
one still pulled live from S3 at `image/jpeg`, 14.8KB.

This file previously recorded an app key as required. It is not, at this volume. A key raises
the rate limit rather than granting access.

Coordinates are `lat` and `lon` at the top of the record. Everything else sits inside
`additionalProperties` as key-value pairs, so the adapter reads `available`, `imageUrl`,
`videoUrl` and `view` out of a list rather than off the object. Confirmed on all 889 records,
and note the `category` differs between them: `payload` for the first three, `cameraView` for
`view`, so an adapter keyed on `category` alone misses one.

**`available` is the string `"true"` or `"false"`, not a boolean.** 790 and 99 respectively, so
`if ap["available"]:` is true for both.

**`available` from the inventory is not a liveness signal, and this is the bug this file
warned about while recording the wrong fix.** The inventory is served from TfL's CDN up to a
day stale: the verification response carried `x-cache: HIT` and `age: 28798`, eight hours, with
`s-maxage: 86400`. So the `available` flags and the `modified` timestamps lag the real cameras
by hours. The still's own `Last-Modified` is the only fresh evidence a camera is up, so the
liveness check belongs on the image fetch rather than on the inventory field. A still pulled on
2026-08-19 was `Last-Modified` five minutes before the wall clock, which is what "refresh on
the order of minutes" means.

**`view` is free text, not a bearing and not an enum.** Observed values include
`East Facing (Home)`, `Home`, `North`, `A23 N/B`. Do not derive a `0 <= x < 360` bearing from
it. `children` and `childrenUrls` are empty on all 889, and `$type` is a .NET type string that
a permissive wire model ignores.

The inventory response is 1.1MB. Fetch it daily, not per view. The provider's stated cap is
**500 calls per minute per data feed**, with the right reserved to throttle. `api.tfl.gov.uk`
has no `robots.txt`: it answers its own `EntityNotFoundException` object at 404.

**The mandatory credit is three strings, not one**, and this file previously carried one. See
the attribution table below.

### New York 511 traffic cameras

2,931 cameras across New York State, keyless, with coordinates on every record. Verified on
2026-08-19, HTTP 200, 858KB.

This is the live-video source rather than a stills source. 1,561 records are enabled and carry
a `VideoUrl`, which is an HLS playlist (`.m3u8`) on the state's video host. There is no
still-image field anywhere in the record, so a camera here is a stream or it is nothing.

1,066 of the 2,931 are `Disabled`. There is a second flag, `Blocked`, at zero across the whole
feed on the verification date, which the operator sets to pull a camera during an incident.
Both are honoured before a camera is offered, and a blocked camera is removed rather than
greyed out.

**`Disabled == false` is not enough to render a camera.** Four enabled records carry impossible
coordinates: three at `0.0, 0.0` (Gulf of Guinea) and one at `40.812794, +73.221827`, which is
China with the longitude sign dropped. All four carry a live `.m3u8`. A New York State
plausibility box is required, or the globe shows four live New York cameras in the ocean and in
Asia. `0.0, 0.0` is a null sentinel, not a position. Test and junk records are in the live feed
too (`Name: "test"` in the Atlantic, `KATHYS CAMERA`, `"."`, `"0"`), and the disabled filter
catches those four but not the four above. Two legitimate cameras are in Philadelphia.

**`VideoUrl` is not always HLS.** Of 1,763 non-null values, 1,752 end `.m3u8`, **nine end
`.mjpg`**, one is the single character `"."` and one is `"0"`.

**Eleven records ship plaintext basic-auth credentials to a directly addressable camera over
plain HTTP**, in the form `http://live:<password>@<public-ip>:22250/mjpg/video.mjpg`. All
eleven are `Disabled: true`. These are device credentials on public IPs, not stream tokens.
Fetching one is an authenticated connection to a camera rather than a request to a state video
service, which sits uncomfortably close to the line `AGENTS.md` draws against aggregators of
unsecured private cameras. **The rule is a scheme and host allowlist**: accept
`https://*.nysdot.skyvdn.com` only, drop and count everything else, and never store or log
those values. The credentials are redacted in
`tests/fixtures/ny511_cameras_live.json` and the URL shape is preserved.

**Presence of a URL and the disabled flag are independent.** 202 records are disabled and carry
a `VideoUrl`; 304 are enabled with none. Both have to pass.

**`DirectionOfTravel` exists and its sentinel is `"Unknown"`**, on 1,549 of 2,931. It is a
string enum, not a bearing. `Latitude` and `Longitude` are named fields but appear
latitude-first in the JSON, so any positional read flips them. `Url` is a 511NY map page with a
sequential integer unrelated to `ID`.

**The provider documents a key as required and a throttle this file did not record.**
`511ny.org/developers/help` states "Requires a developer key" and "Throttling is enabled. 10
calls every 60 seconds." The endpoint contradicts that: no key, a bogus key and no key at all
returned byte-identical responses, so the parameter is ignored rather than validated. Record
the keyless access as undocumented rather than as a supported route, register for a key anyway,
and take 10 calls per 60 seconds as the cadence constant. `511ny.org/robots.txt` does not
disallow `/api/`, and `511ny.org/about/terms` is a 404, so there is no terms page to read.

Restreaming someone else's HLS through our proxy is a different licence question from proxying
a JPEG. Settle it before the layer ships publicly.

State 511 programmes are not interchangeable. WSDOT answered HTTP 401 without a key on
2026-08-19. Each state is its own adapter and its own row in this file.

### Reference photographs of named people

The reference set behind the face-matching path in ADR 013. Wikidata P18 resolved to Commons:
`SELECT ?img WHERE { wd:Q317521 wdt:P18 ?img }`, verified on 2026-08-19, HTTP 200, returning a
`Special:FilePath` URL on Commons.

That gives a licensed photograph attached to a known entity, which is what a reference face has
to be. The file's own licence travels with it like any other Commons item. A person with no P18
has no reference face, so no match is possible and none is asserted. This is a per-entity
lookup on a user action, cached, never a bulk scrape of Commons.

The half this file was missing, verified 2026-08-19: the returned URI is `http`, not https, its
filename is percent-encoded, following it costs four redirects and hands back the 8.26MB
original with no licence attached, and `/wiki/Special:` sits under a robots.txt `Disallow`. So
the URI is an identifier to be decoded and put through the Commons API, never a link to follow.
See the Wikipedia and Commons notes above for the `missing: true` trap, the thumbnail-dimension
trap and the standard-widths-only rule, all three of which sit directly on this path.

### Fintraffic Digitraffic AIS

The primary keyless vessel source in the plan, and it had **no row in this file at all**,
verified or planned, until 2026-08-19. Three interfaces, three different shapes, all keyless,
all CC BY 4.0 with commercial use explicitly permitted.

**It is a regional provider, not a global one, measured 2026-08-20: lon 16.76 to 32.54, lat
57.67 to 65.80.** 1,075 vessels, 1,075 distinct MMSI, 70 one-degree cells, taken from every
coordinate in one live `/locations` body. That is the Gulf of Finland, the Gulf of Bothnia,
Aland and the Archipelago Sea, and nothing else. It has been the vessel layer's only live
source, so **the layer has been Finnish coastal waters presented as a world map**. Adding
Kystdatahuset triples the count to 4,350 vessels and still leaves the layer at 214 one-degree
cells, 0.33% of the globe's. The two providers share zero MMSI and zero cells, so they are
complementary rather than redundant and neither has a failover behind it. See the Measured
coverage section for the figures and what the layer rail has to say.

**Driven live from the running app on 2026-08-20**, which is the first time this project has
served real ships rather than a recorded payload. Five cycles over nine minutes, each on the
60-second floor, keeping 658, 661, 659 and 663 vessels through the strict `Vessel` contract.
The first cycle produced 658 renderable ships 0.24 seconds after the poller started. Both
endpoints answered HTTP 200 on every cycle. Three things this run adds to the notes below:

- **The SAR-aircraft filter fires on live traffic, not just on the capture.** Three of the four
  logged cycles dropped exactly one record for `MMSI is a sar_aircraft, not a ship station`.
  The ITU `111` prefix arriving in a vessel feed is recurring rather than a one-off in a
  fixture, so the prefix check is load-bearing every minute.
- **Live contract rejections are small and real**: two records per cycle failed the `Vessel`
  contract outright. Dropped and counted, positions unaffected.
- **The `from` parameter is sent on every call**, as `?from=1787219700000`, so the 24-hour
  default never applies. Without it the layer would render a day of ghost ships.

Those drop counts reached the log and not the API when the run was made, because
`parse_locations` returned the vessel tuple alone. Fixed on 2026-08-20: it returns the count
with the vessels and `/api/layers` serves it per provider. See `docs/status.md`.

`/api/ais/v1/locations` returned HTTP 200, 1,058 features, 441KB decompressed, with every key
present on every record and zero nulls anywhere. The current host and path is
`https://meri.digitraffic.fi/api/ais/v1/...`: the historic unversioned `/api/v1/locations`
answers 404, and so does `/api/ais/v1/locations/latest`. Confirmed against the provider's own
OpenAPI document at `https://meri.digitraffic.fi/swagger/openapi.json`.

Ten traps, and the first four each produce wrong output rather than an error:

- **`properties.timestamp` on `/locations` is the AIS UTC second-of-minute, 0 to 63, not an
  epoch.** Per ITU-R M.1371, 60 means not available, 61 manual input, 62 dead reckoning, 63
  inoperative. Anything parsing it as a time produces 1970. The real time is
  `timestampExternal`, a 13-digit **millisecond** epoch.
- **The same field name means a millisecond epoch on `/api/ais/v1/vessels`.** Same API version,
  same word, opposite meaning, and the provider says so itself: "the timestamp in the metadata
  message is in milliseconds while in the location message it is in seconds". This is the
  `/v2/mil` versus `/v2/point` problem again and it is the single most likely thing to ship
  broken.
- **The default response is 24 hours of history, not a live snapshot.** The OpenAPI document
  states for `from`: "Default value is 24 hours in the past." The oldest record in the default
  body was 23 hours 42 minutes stale. A poller that calls the bare endpoint and renders
  everything shows a day of ghost ships parked where they were yesterday. Pass `from`
  explicitly or filter on `timestampExternal` in the adapter. `from` defaults the same way on
  `/vessels`.
- **`bbox` is silently ignored.** `?bbox=17,57,32,66` answered HTTP 200 with **1,059** features,
  the whole world set. There is no `bbox` parameter in the OpenAPI document and unknown query
  parameters are dropped rather than rejected. The supported spatial filter is `radius` in km
  with `latitude` and `longitude`: `?radius=50&latitude=60.1&longitude=24.9` returned 70
  features. Verified parameters: `mmsi`, `from`, `to`, `radius`, `latitude`, `longitude`.
- **gzip is mandatory and the failure is HTTP 406** with a plain-text body and an empty
  content-type, verbatim: `Use of gzip compression is required with Accept-Encoding: gzip
  header.` A parser that assumes JSON on any non-2xx throws, the same class as the GDELT 429.
  Captured as `tests/fixtures/digitraffic_gzip_required_406_live.txt`.
- **Sentinels, not nulls. Nothing is ever null and no field is ever absent.** Out of 1,058
  records: `cog == 360.0` on 110, `sog == 102.3` on 9, `heading == 511` on 184, `rot == -128`
  on 184, `navStat == 15` on 47. `rot` of 127 or -127 mean turning faster than 5 degrees per 30
  seconds, not a rate. `cog` legitimately reads 0.0 on 37 records, so 360.0 is the only
  not-available value and a naive `0 <= x < 360` check rejects 110 real records rather than
  mapping them to `None`.
- **The vessel-locations endpoint contains aircraft.** MMSI `111265583` and `111265584` are in
  the feed, named `LIFEGUARD 003` and `LIFEGUARD 004` with Swedish aircraft registrations, one
  doing 36 knots. The `111` prefix is the ITU allocation for SAR aircraft. Filter on the prefix
  or the ship layer gets helicopters in it. Other reserved prefixes: `00` coast station, `0`
  group, `99` aid to navigation, `98` auxiliary craft, `970`/`972`/`974` SART, MOB and EPIRB.
- **MMSI is not a guaranteed-unique merge key on this feed.**
  `tests/fixtures/digitraffic_ais_vessel_metadata_junk_mmsi_live.json` holds
  `{"mmsi": 999999999, "name": "NATO WARSHIP", ...}`. `999999999` is a placeholder rather than
  an allocation, so two warships broadcasting it collide into one record while ADR 010's
  one-record-per-MMSI test still passes. The captured snapshot had zero duplicates across 1,058
  records, so it is intermittent rather than constant, which makes it worse.
- `dataUpdatedTime` is per query, not a global sweep clock: a filtered call returned a value a
  day older than the unfiltered one.
- **ETag conditional requests return a real HTTP 304 with 0 bytes.** That is the cheap way to
  stay inside the request cap.
- **`timestampExternal` is not bounded by anything upstream, so bound it here.** A value of
  1893456000000 dates a fix to 1 January 2030, which gives the record an age of zero and wins
  every recency contest in the union until the clock catches up. That is the accidental
  provider precedence ADR 010 forbids, arriving through a timestamp instead of a preference
  order. The adapter refuses a fix more than a minute ahead of our own clock and drops it. The
  bound cannot use `dataUpdatedTime`, because that field was measured a full day behind its own
  contents.
- **A value below 1e11 on either timestamp field is refused rather than converted.** Both REST
  fields are 13-digit milliseconds, but the same API sends the same instant in 10-digit seconds
  as `time` on the MQTT `location` topic. Read as milliseconds a seconds epoch dates the fix to
  January 1970 and loses every merge silently. Refused and counted, not switched to seconds:
  reading it as seconds would invent a plausible 2026 timestamp out of a junk value.
- **An empty answer to the *unfiltered* query is a failed poll, not an empty sea.** The bare
  call is the whole Baltic inside a ten-minute window and returned 1,058 features when it was
  measured, so zero means something broke upstream. Same stance as CelesTrak on an empty
  element array. Reported healthy with a count of zero, the store expires every ship one TTL
  later and the browser is told to remove them. A radius or box query over quiet water is
  allowed to see nothing, so the rule is scoped to the bare call.

`/api/ais/v1/vessels` is a **bare JSON array with no envelope**, a different top level from
`/locations` on the same API version. `draught` there is an int in **decimetres** (49 means
4.9m, 255 means 25.5m or greater, 0 means not available) while `draught` on
`/api/port-call/v1/vessel-details` is a float in **metres** (8.15). Same word, two units, two
endpoints, one host. `eta` is the raw AIS 20-bit packed field, not a date: month in bits 19-16,
day 15-11, hour 10-6, minute 5-0, decoded and checked against three real records. **`eta ==
1596` is the not-available value and is the single most common value in the body**, 198 of 950,
with `eta == 0` on 38 more. 238 records in total decode to month > 12 or day 0, so about a
quarter of the field is unusable, and there is no year in it at all. `imo == 0` means not
available on 322 of 950. Missing text is an **empty string, not a null**: `callSign` empty on
5, `destination` on 91, so a `min_length=1` strict field drops 91 real ships.

**The two endpoints must be joined on `mmsi` and the join is not total.** 1,058 positions
against 950 metadata records, so a vessel with a position and no name is normal rather than an
error. `navStat` exists only on `/locations` and every metadata field only on `/vessels`.

**So the two fetches are independent and only the positions leg is load-bearing.** A failure on
`/vessels` leaves the positions rendering with the last static data we hold, because a vessel
with a position and no metadata is the normal case for 108 of 1,058 records. The one exception
is HTTP 429: that binds the positions request that would follow, so it is raised rather than
absorbed. **Both arrays are validated one record at a time**, so a single junk field costs one
record and not the payload. One fractional `rot` in 110 features used to reject all 110, and
with no AISHub username and no aisstream key Fintraffic is the only vessel provider, so the
layer emptied one TTL later.

**The MQTT payloads are not the REST payloads, and the provider's own documentation has the
topic name wrong.** `https://www.digitraffic.fi/en/marine-traffic/` documents
`vessels-v2/<mmsi>/locations`. Subscribing to `vessels-v2/+/locations` was **accepted with
granted QoS 0** and delivered **zero position messages in 27 seconds**, while
`vessels-v2/status` came through fine. The actual leaf is **`location`, singular**, read off
the wire from `vessels-v2/#`. The broker grants a subscription to a topic that will never
publish, so the failure mode is a layer that connects, reports healthy and renders nothing.
Confirmed in `tests/fixtures/digitraffic_mqtt_vessels_v2_live.ndjson`: 600 messages, 558
`location`, 40 `metadata`, 2 `status`, zero on any plural leaf. The provider's instructions
page also names `vessels/status` where the live topic is `vessels-v2/status`.

On the MQTT payloads themselves: `lat` and `lon` are **separate scalar fields** rather than a
GeoJSON array, so the ordering rule does not apply and a shared REST/MQTT parser gets one
direction wrong. `time` is a **10-digit epoch in seconds** where REST's `timestampExternal` is
13-digit milliseconds, and on the metadata topic `timestamp` **is** milliseconds. There is **no
`mmsi` field at all**: the MMSI exists only in the topic string. `refA` to `refD` replace
`referencePointA` to `D`, and `type` replaces `shipType`, so the word `type` means three
different things across this one API. The provider also warns that a client subscribed only to
quiet topics gets disconnected, so subscribe to the status topic as well.

`/api/port-call/v1/vessel-details` is the registry endpoint and it does the job this file had
pencilled in for ITU MARS: MMSI to IMO, name, callsign, nationality, port of registry, ship
type, ice class, gross and net tonnage, deadweight, dimensions, engine power and
`vesselSystem.shipOwner`. Its traps: **`from` defaults to now, so a bare call returns `[]`**
and an adapter reading that as "no such vessel" concludes the registry is empty. `shipOwner`,
`shipTelephone1` and `shipEmail` use a **single space `" "`** as the missing-value sentinel, not
null and not empty, on 10 of 17 records for the owner and all 17 for the contact fields, and a
strict `str` field accepts `" "` happily. **`mmsi` is `0` when absent, on 8 of 17 records**, so
indexing on MMSI without filtering zero collapses eight unrelated ships onto one key.
**`radioCallSignType` can be `"FAKE"`**, on 4 of 17, and any call-sign join to MARS or PSIX must
exclude those or it matches the wrong vessel with full confidence. `vesselTypeCode` is
Portnet's code list, not the AIS one: 50 means container ship here and pilot vessel in AIS
coding. Date-only fields arrive as Finnish-local midnight expressed in UTC
(`2022-12-04T22:00:00.000Z` is 5 December in Helsinki), so they pass the contract and render one
day out. `maxSpeed` is null and `height` is 0.0 in the same object, both meaning unknown.

**The AIS metadata store and the port-call registry are disjoint on the same key.** MMSI
305904000 exists in `/api/port-call/v1/vessel-details` and **404s** on
`/api/ais/v1/vessels/{mmsi}`, because one holds what Finnish receivers heard and the other holds
Portnet registry data. A registry lookup must hit vessel-details. Error bodies there are JSON
`{status, error, message, path, timestamp}` with a nanosecond-precision timestamp.

**Coverage is Finland and the Baltic.** Observed longitude 17.0 to 32.5, latitude 57.6 to 65.9,
which independently confirms longitude is first: a latitude of 32 in the Baltic is impossible.
Global superyacht coverage is effectively nil, which is the reason not to delete the MARS option
outright.

**One operational note on the `Digitraffic-User` header.** The provider's instructions say "Do
not send any personal information, such as a person's name or email address, in the header",
which bites this project's convention of putting a contact address in the User-Agent. Keep the
contact in `User-Agent` and send an application-only string in `Digitraffic-User`.

### Kystverket (Norway) raw AIS

Live, keyless, NLOD 2.0, and it had no row in this file. It is not HTTP: it is a raw TCP socket
serving NMEA 0183 sentences at `153.44.253.27` port `5631`. Verified 2026-08-19 with a plain
socket: connection immediate, **135,832 bytes and 1,742 sentences over 45.9 seconds**, about 38
sentences per second, carrying 874 distinct MMSI in position reports alone. The payloads were
hand-decoded to prove real positions on the Norwegian coast. Captured as
`tests/fixtures/kystverket_ais_nmea_live.txt`.

**`ais.kystverket.no:5631` times out.** The documented IP is the only way in, which is a
fragility worth writing down.

Seven traps:

- **The talker ID is not `AIVDM`.** Observed `BSVDM` 1,690, `B2VDM` 27, `B1VDM` 25, and **zero**
  `AIVDM`. `BS` is base-station VDM. Any parser keyed on the literal `!AIVDM` matches nothing at
  all. Kystverket's own documentation calls them "AIVDM/AIVDO sentences", which is wrong about
  what comes down the wire.
- **A third of the traffic is multipart and it carries the vessel names.** 584 of 1,742
  sentences had a total-parts count above 1, almost entirely type 5 static and voyage data split
  across two sentences and reassembled on the sequential message ID. A decoder that skips
  multipart sees positions and never sees a single ship name, IMO number or destination.
- **The TAG block has its own checksum, separate from the sentence's.** `\s:...,c:...*0D\` then
  `!BSVDM,...*2A`. Strip the block before validating the sentence checksum. 1,729 of 1,742
  sentences carried a TAG block and 13 did not.
- **`c:` is a 10-digit epoch in seconds**, against Digitraffic REST's 13-digit milliseconds. Two
  AIS feeds, two epoch units, in the same phase.
- **Small craft are excluded at source.** Kystverket state the open stream excludes fishing
  vessels under 15 metres and recreational craft under 45 metres. This is not an all-ships feed
  and the vessel count will never match a commercial tracker's.
- **It is a persistent socket, not a poll.** Nothing about the existing `Poller` pattern with an
  interval floor fits it. It needs a long-lived reader task with reconnect, and every
  provider-cadence rule in this repo is written for HTTP polling.
- Coverage is 40 to 60 nautical miles from the Norwegian coastline from over 50 base stations,
  so regional rather than global.

**Licence: NLOD 2.0, and it permits commercial use and redistribution** with mandatory
attribution, read from the licence text at `https://data.norge.no/nlod/en/2.0/`. Two clauses
matter here: the licensee may not sub-license or transfer the licence, and the licence does not
cover information containing personal data under the Norwegian Personal Data Act without a
legitimate basis. That carve-out is worth a look given this project joins vessel positions to
named individuals, though a commercial vessel's MMSI is not personal data on its own. There is
a separate restricted tier that does bar distribution to third parties; the open stream is not
subject to it.

**There is no keyless global AIS feed reachable from here.** Every keyless AIS source that works
is regional. Tested and failed on 2026-08-19: BarentsWatch live AIS **401**, BarentsWatch
`openaisFiltered` **404** (the old open path is gone), BarentsWatch historic serves a Swagger
shell while its live sibling needs a token, and the Danish Maritime Authority archive
`https://web.ais.dk/aisdata/` **fails TLS** on a `*.govcloud.dk` certificate that expired
2025-06-12. There is no community AIS equivalent of adsb.lol: AISHub, MarineTraffic and
VesselFinder all gate the aggregate behind a receiver requirement or a paid plan. So phase 2 is
two regional keyless feeds and no global coverage without either an aisstream.io key or an
antenna.

### Kystdatahuset (Kystverket, Norway)

Verified 2026-08-20. **The one new live keyless vessel provider anywhere**, and it supersedes
the raw NMEA TCP socket the plan carried for Norway. Same authority, same receivers, same NLOD
licence, over plain HTTP, with names, IMO numbers, call signs and destinations already decoded.
3,283 vessels in one GET, 3,571,020 bytes raw and 1,019,926 gzipped.

**Wired in and re-verified live on 2026-08-23**, as the second keyless member of the vessel
union. Two GETs 163 seconds apart returned 3,542 and 3,543 features in 3,685,163 bytes, and the
parser kept 3,399 vessels, dropped 124 and superseded 19 duplicate reports, which closes exactly
against the feature count. Every drop is a non-vessel or a record with no position: 70 empty
geometries, 29 unallocated MIDs, 21 auxiliary craft on the `98` prefix, and one each of a coast
station, a handheld DSC set, an aid to navigation and a SAR helicopter.

Fixture: `tests/fixtures/kystdatahuset_ais_realtime_live.json`, **120 features** sliced from the
2026-08-23 body, chosen so every trap below is in the committed bytes rather than hand-written.
No field was altered and no value was scrubbed: an MMSI and a vessel name are public vessel
identifiers, not data about a natural person. Tracks longer than 40 coordinates are truncated
**from the front**, keeping the newest end, so the direction trap survives the slice. Two
corrections to what an earlier draft of this section said it would be: it is 120 features rather
than 80, it carries no `_fixture_selection` map, and it **does** carry two duplicate-MMSI pairs,
so that trap is asserted against the real bytes rather than needing a hand-built case. There is
no `kystdatahuset_head_405_live.txt`: nothing in the adapter ever issues a HEAD, so the trap is
avoided by construction rather than parsed.

**Keyless, proved rather than assumed.** The OpenAPI document at `/ws/swagger/v1/swagger.json`
declares one `JWT Bearer` scheme and no global `security` requirement, and this path carries
none. A call with the User-Agent header suppressed entirely returned the full body.

Kystverket state the coverage themselves: "vessels within the Norwegian economic zone and the
protection zones off Svalbard and Jan Mayen", and the open feed **excludes fishing vessels
under 15 metres and recreational craft under 45 metres**. So the count will never match a
commercial tracker even inside the box, and that is the provider's choice rather than a gap in
our parsing.

Twelve traps, all measured on the real body.

- **The geometry is a `LineString`, not a `Point`, and the current position is the LAST
  coordinate.** Every one of 3,212 features in the first poll was a LineString. Verified against
  course over ground on three fast movers: the track runs oldest-first. **Taking
  `coordinates[0]` puts every moving ship up to ten minutes behind where it is, silently**, and
  the layer looks merely stale rather than wrong. Assert this with a test.
- **42 of 3,212 features carry `"coordinates": []`.** An empty list, not null and not absent.
  Indexing `[-1]` on it raises `IndexError`. Histogram: 0 pairs on 42 features, 2 on 1,910, 3 on
  124, up to 89,180 pairs across the body.
- **The empty-geometry share is not 1%, it moves between 2% and 21%, and it is real named ships
  rather than beacons.** Measured 2026-08-23 across five polls: 77 of 3,542 at 09:53 UTC, then
  252 of 1,467, 319 of 1,492, 358 of 1,898 and 349 of 1,827 by 10:21. The records carry a
  `date_time_utc`, a name, a length and a status and no position anywhere: SJOBAS, AQUA MARINE,
  CAMPUS BLAA, FRANCO. **93% of the ships with no geometry at 10:20 UTC had one at 09:53 UTC**,
  and only 6% of one poll's empties recovered a geometry in the next poll 19 seconds later. So
  the set churns rather than being a fixed group of untrackable vessels, and losing it is the
  provider withholding a position it held minutes earlier. Dropping and counting is the only
  correct handling, because there is no position in the payload to use, but it means the vessel
  store's time to live decides whether a ship flickers off the globe or rides out the gap. That
  is a decision about the TTL, not an adapter bug.
- **`POST /api/ais/positions/for-mmsis-time` is the obvious way to backfill those ships and it is
  broken, and it fails with HTTP 200.** Keyless, verified 2026-08-23, and it answered
  `{"success":false,"msg":"42P01: relation \"ais202608.ais_20260823\" does not exist"}` with a
  200 and an empty `data` array, leaking that the provider partitions AIS by day and that the
  day's partition had not been created. Same trap class as Flickr and the MediaWiki action API:
  **branch on `success`, never on the status code.** Not wired in.
- **`draught` is `int` on 1,965 features and `float` on 1,247 in the same response.** A
  `strict=True` float field rejects 1,965 real ships. Same class as `eo:cloud_cover`.
- **`date_time_utc` is naive and arrives in two formats.** `2026-08-20T18:22:44` on most and
  `2026-08-20T18:32:16.19084` with fractional seconds on 172 of 3,212. Attach UTC in the
  adapter, per the CelesTrak precedent.
- **`ship_name` carries a decode-confidence suffix inside the string.** Real values
  `'BUOY OK 1      [86%]'`, `'GH 3           [50%]'`, `'ANDOYVAERING B [73%]'`: space-padded,
  then `[NN%]`. A name used for display or as a match key has to be stripped of it. 11 names are
  empty strings, not null. Assert this with a test.
- **Sentinels rather than nulls, and the same values as Digitraffic**: `cog` 360.0 on 472,
  `true_heading` 511 on 1,011, `imo` 0 on 1,593, `draught` 0 on 1,228, `length` 0 on 117.
  `destination` is an empty string on 681 of 3,212.
- **Non-ship MMSIs are present, and they are not the `111` SAR-aircraft case already recorded**:
  26 at `109xxxxxx`, 6 at `941xxxxxx`, 4 at `982xxxxxx`, 2 at `119xxxxxx`, 1 at `992xxxxxx`. By
  name they are AIS fishing-gear beacons and man-overboard units. `109` and `941` sit outside the
  ITU MID allocation entirely, so the MID validation this project already does drops them, which
  is the right outcome.
- **7 duplicate MMSI within one response**, all Norwegian MID 257. One MMSI, two features, two
  tracks. **ADR 010's one-record-per-key test has to resolve inside a single provider's payload,
  not only across providers.** The committed fixture slice does not carry a duplicate pair, so
  this trap needs its own hand-built case rather than a fixture assertion.
- **`HEAD` returns HTTP 405 with `Allow: GET`.** A freshness or liveness check written as a HEAD
  reports the source down. Same shape as the FAA zip trap, different cause.
- **No `bbox` parameter exists.** The only filters are `timeStamp` and `aisShipType`, and
  unknown parameters are dropped rather than rejected. Viewport pruning is ours to do.

**The bounding box lies about the Baltic.** The lon 32.492 maximum comes from Barents and
Murmansk, not the Gulf of Finland. There are zero vessels in the Baltic proper and zero inside
Fintraffic's measured box. Reading the box without counting the cells would suggest an overlap
that does not exist.

**Do not build the Kystverket raw TCP socket now.** It still works (36,862 bytes and 468 lines
in a 12-second read on 2026-08-20, and the `BSVDM` talker trap reconfirmed: 449 BSVDM, 13
B2VDM, 5 B1VDM, **zero AIVDM**), and it is now redundant. The socket path costs a long-lived
reader with reconnect that no existing `Poller` shape fits, a 6-bit de-armourer, multipart type
5 reassembly, two checksum layers including the IEC 62320-1 TAG block, and `BSVDM` talker
handling, all to arrive at a worse version of a GeoJSON endpoint. Its row stays as a documented
fallback if Kystdatahuset ever closes.

### The national AIS sweep: twenty-nine authorities, four keyless live feeds

Done 2026-08-23, because the layer had been built one country at a time and nobody had gone
through the list properly. **Every row below was called from this machine on that date.** The
conclusion, stated before the evidence: **keyless live AIS exists in northern Europe and on the
Great Lakes, and nowhere else we can find.** Four authorities publish it. Twenty-five do not.

**What counted as a hit**: an endpoint returning live individual vessel positions with an MMSI,
a latitude, a longitude and a timestamp, reachable with no key, no registration, no token, no
email approval and no signed agreement. A **vessel density raster is not a hit** and several
authorities publish those instead; a **historical archive is not a hit** either.

| Authority | Verdict | Evidence |
| --- | --- | --- |
| **Fintraffic (Finland)** | **KEYLESS LIVE, in use** | `meri.digitraffic.fi/api/ais/v1/locations`. Already the layer's first member |
| **Kystverket / Kystdatahuset (Norway)** | **KEYLESS LIVE, in use** | `kystdatahuset.no/ws/api/ais/realtime/geojson` |
| **Transpordiamet (Estonia)** | **KEYLESS LIVE, in use** | ArcGIS FeatureServer, found by enumerating the portal's service directory behind an Experience Builder viewer |
| **Seaway VIS (Canada and USA)** | **KEYLESS LIVE, in use** | `vis.seaway.ca/graphql`, found by reading the public map's JavaScript bundle |
| Denmark, Søfartsstyrelsen | **GATED, and priced** | The authority's own page states live AIS costs DKK 1,800 to 5,600 a year; only historical data is free. `web.ais.dk` is dead on top of that: its certificate expired 12 June 2025 and the connection is reset even with verification disabled, while plain HTTP times out. `aisdata.ais.dk` serves historical zips only |
| Sweden, Sjöfartsverket | GATED | No public API or download; live vessel-traffic extracts come from the paid RAIS database |
| Latvia, Maritime Administration | No feed | Ordinary authority website, no AIS section |
| Lithuania, LTSA | Blocked | Cloudflare interactive challenge on a plain descriptive User-Agent. `geoportal.lt` has no vessel layer |
| Poland, Urząd Morski / SIPAM | Dead / no feed | `mapy.umgdy.gov.pl` resolves but answers on neither 80 nor 443. SIPAM publishes ENC and hydrographic WMS, no positions |
| Germany, WSV / BSH | No feed | The federal shore-based AIS network is documented for internal use; the coastal portal advertises **vessel density** products sourced annually from EMSA |
| Iceland, Vegagerðin and Landhelgisgæslan | No feed | VTS monitoring is internal; the Coast Guard links a chart viewer |
| Faroe Islands, FMA | No feed | Ship register site, no AIS |
| Ireland, Marine Institute | **KEYLESS but useless** | The ERDDAP server at `erddap.marine.ie` is genuinely open, and across 75 datasets there is no general vessel feed: the AIS-shaped one carries **MMSI prefix 992**, the ITU aid-to-navigation block, and its stations are named weather buoys. The only ship data is its own two research vessels' underway logs |
| Netherlands, Rijkswaterstaat | No feed | All six JavaScript bundles of the fairway-information app grepped for ais/vessel/ship/geoserver: static fairway, lock and bridge infrastructure only. The national portal's shipping layer is static planning cartography |
| Belgium, MDK and VTS-Scheldt | No feed | Legacy CMS, soft-404s on every path, no discoverable map API |
| United Kingdom, MCA | No feed, confirmed | The `data.gov.uk` AIS dataset exists as a stub with **zero resources attached**. The only other UK offering is a 2011-2015 vessel **density grid** |
| France, national portals | No feed | Static anchorage and traffic-separation polygons, a 2012-13 AIS-derived study, a vessel registry |
| France, Flotte Océanographique | **KEYLESS LIVE but unusable** | `localisation.flotteoceanographique.fr/api/v2/positions` is open and genuinely global, lon -28.31 to 159.24, lat -21.46 to 48.65. It is **9 research vessels and carries no MMSI at all**, so there is no merge key under ADR 010, and two of the nine were 13 and 53 days stale. Recorded because it is real and because the reason it is out is the contract rather than the access |
| Spain, Puertos del Estado | No feed | Open data surface is oceanographic buoys |
| Portugal, DGRM | No feed | Two search hits, both irrelevant |
| Italy, Guardia Costiera | Blocked | Akamai WAF answers 403 on a descriptive User-Agent, `robots.txt` included |
| Greece, Ministry of Shipping and Coast Guard | Blocked | Akamai WAF 403 on both hosts |
| Canada, CCG and DFO | No feed | No live AIS dataset published; the Seaway row above is the Canadian answer |
| USA, NAIS / USCG NavCen | GATED | The provider's own page states access is restricted |
| USA, MarineCadastre / BOEM | HISTORICAL | Monthly zip archive tool, confirmed not live |
| USA, NOAA nowCOAST | Dead | The `/arcgis/rest/services` path was retired 19 April 2023 and the replacement host does not resolve |
| Australia, AMSA | HISTORICAL | The Craft Tracking System publishes monthly datasets |
| New Zealand, data.govt.nz | Unverified | A bot-challenge page blocked the catalogue API |
| Singapore, MPA | GATED | SG-MDH support ended 30 January 2026 and its host no longer resolves; the successor OCEANS-X is behind Incapsula with a marketplace and subscription model |
| Japan, JCG MICS | GATED | Portal gates behind terms-of-use acceptance |
| South Korea, GICOMS | GATED | Its own site states access needs the technical team's approval |
| Taiwan, TIPC ports | No feed | VTS is internal to port control |
| Brazil, Marinha and ANTAQ | GATED | The Navy's interior-navigation API requires approved-provider status |
| Chile, DIRECTEMAR | GATED | SITPORT is mobile-app only. A Chilean logistics site that looks like a government feed is **embedding the commercial MarineTraffic widget** |
| Argentina, Prefectura Naval | GATED | Registration by national ID number required |
| South Africa, Transnet | GATED | Restricted to authorised government users |
| India, VTMS / port authorities | No feed | Nothing public found |
| UAE, Dubai Trade | GATED | Registered service; the federal open-data maritime page answers 403 |
| Global aggregators | GATED, re-confirmed | **Global Fishing Watch** answers `{"error":"invalid token"}` with HTTP 401 without a token, verified rather than assumed. AISHub needs a physical receiver, aisstream.io needs a key |

**The one genuinely global keyless source of ship positions, and why it is useless.** NOAA
NDBC publishes WMO Voluntary Observing Ship reports at
`https://www.ndbc.noaa.gov/data/realtime2/ship_obs.txt`, keyless, 1.56MB, HTTP 200, and
`robots.txt` disallows only two named crawlers. It is genuinely global: 9,211 observations
spanning lat -83.4 to 89.3 and lon -179.2 to 179.8, 58 thirty-degree cells. It fails on
identity, absolutely. **There are 9 distinct `SHIP_ID` values across all 9,211 rows**, eight of
which are five-digit WMO buoy numbers and the ninth is the literal string `SHIP`, because the
WMO scheme lets a vessel mask its call sign and essentially all of them do. **Zero rows carry a
nine-digit MMSI.** Under ADR 010 the merge key is the vessel's own identity, so every one of
those observations would collapse into a single record: the 999999999 placeholder problem
multiplied by nine thousand. Position resolution is one decimal place, about 11km, timestamps
are hour-resolution, and the median report is 12 hours old with a maximum of 23. Keyless,
global, and not a vessel layer. Verified 2026-08-23.

**The Kystverket raw NMEA socket was measured rather than assumed, and it is not worth
building.** `153.44.253.27:5631`, raw TCP, no TLS, no registration, and it works: a 101-second
capture gave 3,952 sentences, 3,930 with IEC 62320-1 TAG blocks, and decoded to **2,200
distinct MMSI with a position** plus 769 names from type 5 and 24 sentences. The documented
talker trap reconfirmed: 3,810 `BSVDM`, 97 `B2VDM`, 29 `B1VDM`, **16 `BSVDO`** which this file
had not recorded before, and **zero `AIVDM`**. Its box is wider than Kystdatahuset's, lon -8.71
to 37.20 against 0.58 to 32.06. But against a Kystdatahuset poll in the same minute it added
only **309 ships** on a 3,271-ship union, and under ADR 011 it is the same authority's
receivers so it is one origin and adds no corroboration. The cost is a persistent socket that
no existing `Poller` shape fits, a 6-bit de-armourer, multipart reassembly and two checksum
layers. **309 ships in water we already cover does not pay for that**, and now there is a
number behind that sentence rather than an assertion.

### Vessel sources that are closed, and one that moved host

Verified negative 2026-08-20. Recorded so nobody spends the day again.

**aiscatcher.org is the closest thing to an adsb.lol for ships and it is closed three ways,
none of them the User-Agent.** The root serves 200 and 36,884 bytes of HTML, and
`static/map.bundle.js` names the real endpoints (`/api/stations.json`, `/api/path`,
`/api/station/coverage_h3`, `/api/vas?<station>` behind `hubVUrl = "/api/v"`). All of them
answer **403** with a Cloudflare block page. First, `robots.txt` disallows `/api/`, `/hub/`,
`/ships`, `/stations`, `/tiles/`, `/livemap`, `/ship/ais/`, `/search/` and `/stats` by name, and
`Allow:` covers only `/static/`, `/about`, `/howto`, the root and the sitemap. Second, the same
file names our own client, `User-agent: ClaudeBot` / `Disallow: /`, alongside GPTBot, CCBot and
Bytespider, plus a Content-Signal reservation of rights under Article 4 of EU Directive 2019/790
with `ai-train=no`. Third, `static/turnstile.js` shows the API sitting behind a Cloudflare
Turnstile human challenge: any 403 triggers `triggerTurnstile()` and the request is retried only
after a person passes it. That is a deliberate anti-automation gate, not a CDN bot filter, so
`cloudscraper` is barred here by this project's own rule. The site looks open, which is the
trap: a shallow probe concludes the API just needs the right path. Fixture:
`tests/fixtures/aiscatcher_robots_live.txt`, which is the load-bearing artefact for the negative.

**The Danish Maritime Authority archive moved host, which explains the TLS failure recorded
here.** `https://web.ais.dk/aisdata/` still fails, HTTP 000 after a 30-second timeout on both
schemes. `dma.dk`'s own AIS page now links to `http://aisdata.ais.dk/`, a directory-listing
shell over an S3 bucket, and both the shell and the bucket listing answer keylessly. Reading
someone else's bucket over HTTPS is not cloud infrastructure under this project's rule, so it is
usable. It is also **historical and eighteen months stale**: year prefixes run 2006 to 2025 and
stop, there is no 2026 prefix, and the newest keys are `2025/aisdk-2025-02-19.zip` through
`aisdk-2025-02-26.zip`, at 540 to 590MB each. Useless for a live layer. Two traps for anyone who
does use it, from the bucket's own readme: **latitude and longitude use a comma as the decimal
separator** (`57,8794` / `17,9125`), and latitude is column 4 with longitude column 5, so
latitude comes first, the opposite of our contract order. Fixture:
`tests/fixtures/dma_aisdata_s3_listing_2025_live.xml`.

**Everything else called on 2026-08-20 and found empty.** Estonia's Transport Administration
ArcGIS (`gis.vta.ee`) has a folder literally named `AIS` and it holds boundaries, warnings and
anchorages, no vessels: read the layer list before believing the folder name. Ireland's Marine
Institute ERDDAP has one AIS hit, `ais_met_hydro`, which is weather from aid-to-navigation
stations. Australia's AMSA Ship Tracking Service answers 200 with a login form, and
`data.gov.au` returns 121 AIS hits that are all 2013 to 2015 density rasters. Canada's
`open.canada.ca` returns 61 AIS hits, all DFO density products 2014 to 2020. NOAA's
MarineCadastre folder holds `AISVesselTransitCounts2019` through `2025`, which are annual
aggregates and not positions, and the USCG Nationwide AIS feed is not public. HELCOM and EMODnet
both answer keylessly with plausible maritime WMS layers that are **density rasters**, and a
raster cannot populate an entity layer. The Netherlands, New Zealand, Iceland, Singapore, Sweden
and Havbase are variously 404, Cloudflare-challenged, DNS failures, keyed or unreachable.

**Global keyless AIS does not exist, and no further hunting will produce it.** It needs an
aisstream.io key (free, and a free key is still a key), an AISHub membership (a physical VHF
antenna within range of real shipping), or a paid aggregator. That is a decision for Alexander
Fanthome rather than a finding.

### adsbdb

Aircraft registry lookup for phase 3, verified 2026-08-19. `/v0` is the current version prefix,
and `GET /v0/online` reports `api_version: 0.6.5`, so the URL major version and the software
version are different numbers.

**Re-verified through the running product on 2026-08-20.** `GET /api/aircraft/adca0b` on a live
server drove one upstream `GET https://api.adsbdb.com/v0/aircraft/ADCA0B`, HTTP 200, which
resolved a live Gulfstream G650 to `registered_owner: "21st Century Fox America Inc"`. Four card
opens on that address produced exactly one upstream call, so the cache holds for the session.
The lookup also disagreed with the feed on the type: adsb.lol sent `GLF6` and adsbdb sent
`G650`, and both sides are served on the record rather than one overwriting the other.

Everything is wrapped in a `response` envelope. The aircraft object carries `type` (a marketing
name), `icao_type` (the designator), `manufacturer`, `mode_s`, `registration`,
`registered_owner`, the owner's country, an operator flag code and two photo URLs.

**There is no separate `operator` field.** The plan says the lookup gives "owner, operator, type
and photo". It gives one owner-or-operator string, `registered_owner`, and nothing that
distinguishes a beneficial owner from an operator.

Traps:

- **Coverage is incomplete and a live hex will often miss.** Against the repo's own
  `adsb_point_live.json`, the first 20 hexes gave 13 x 200 and 7 x 404. Four of the seven are
  ground vehicles and towers, but three are real aircraft with real registrations that adsbdb
  does not hold. So **roughly 19% of genuine aircraft resolve to nothing, and a 404 is normal
  operation rather than a fault.**
- **404 is the only failure mode and it is indistinguishable from bad input.** An unknown hex, a
  lowercase hex, an uppercase hex and the literal garbage `ZZ` all return
  `404 {"response":"unknown aircraft"}`. The callsign endpoint returns a **different** string,
  `"unknown callsign"`, so there are two error bodies to handle.
- **Case does not matter but the reply is always uppercase.** adsb.lol emits lowercase. Fold one
  way before using it as a merge key.
- **The path accepts either a Mode S hex or a registration.** `/v0/aircraft/N628TS` and
  `/v0/aircraft/A835AF` return byte-identical bodies, so a registration that looks like a hex is
  ambiguous by construction.
- `registered_owner_operator_flag_code` is a flag-image code, not an ICAO operator code: it read
  `G650` for a private Gulfstream.
- **No rate-limit headers on any response.** The 512-per-minute figure comes from the provider's
  own server source (`UPPER_LIMIT 1024`, `LOWER_LIMIT 512`, one-minute window), where exceeding
  512 blocks for 60 seconds and exceeding 1,024 blocks for 300. You cannot discover remaining
  budget from a response.
- **Airport `elevation` on the callsign endpoint is in FEET.** Heathrow reads 83, which is 25
  metres. Nothing in the payload says so. Convert with `FEET_TO_METRES` or every airport
  altitude is out by 3.3x. Coordinates arrive as separate `latitude` and `longitude` scalars
  with latitude first, and precision is inconsistent between the two airport objects in one
  response, so digit count is not accuracy.
- `/v0/airline/{icao}` returns a JSON **array** under `response`, unlike every other endpoint.

**The combined form halves the call count**: `GET /v0/aircraft/{hex}?callsign={callsign}`
returns both `aircraft` and `flightroute` in one envelope, which matters against a 512-per-minute
cap.

**Licence: the route half is prohibited and the aircraft half is unlicensed.** The provider's
README states the flight route data "may not be copied, published, or incorporated into other
databases without the explicit permission of David J Taylor, Edinburgh". Serving an
origin-destination pair to a browser is publishing it and storing it in our SQLite file is
incorporating it. That is the same class of blocker as ADS-B Exchange and it lands on the
callsign endpoint only. **Consequence: the route pair ADR 012 wants for occupancy reasoning
cannot come from adsbdb without written permission from a named individual.** The aircraft
lookup has no licence at all and is credited to PlaneBase, a commercial database, with no
redistribution grant, so this file's old "Check before commercial use" was too soft: there is
nothing to check. Photos are hot-linked from airport-data.com and `AGENTS.md` forbids
hot-linking, so `url_photo` is proxied and cached like any other image.

**No flightroute payload is committed to `tests/fixtures/`.** Committing one is itself a copy
and the terms forbid copying. The recorded body sits outside the repo as recon evidence and
whether it comes in is Alexander's call.

### Near-realtime cloud imagery

Verified 2026-08-20. Every freshness figure is measured against one clock reading of
`2026-08-20T18:42:53Z`.

**NASA has already reprojected the geostationary fleet into Web Mercator and publishes it as
WMTS, so Cesium renders it with no reprojection at all.** That is the whole finding. Three
`WebMapTileServiceImageryProvider` layers on `GoogleMapsCompatible_Level7` (`Level6` for the
Himawari infrared band) give a measured 83.9% of longitude at a `PT10M` product cadence, with
transparent PNG tiles. GeoColor is the layer to draw, because it is true colour by day and
infrared cloud by night, so it never blanks on the dark half of the globe.

**The honest refresh interval is 10 minutes at the provider and 20 to 70 minutes on screen.**
The products are produced every 10 minutes, but measured age at a single clock reading was 62 to
72 minutes for GIBS and 23 to 33 minutes for EUMETView. So poll every 5 minutes against the
endpoint's own `Time` default, expect the newest frame to be roughly half an hour to an hour
old, and **label the layer with the frame's own timestamp rather than the fetch time**. Same
rule as every other feed here: carry the observation time, never the request time.

**EUMETView closes the gap and its licence is not established, so the layer ships with a
58-degree hole until it is.** `mtg_fd:rgb_geocolour` covers 100.0% of the measured
1.4E-to-59.4E GIBS gap at `PT10M`, taking the union to a measured 100.0% of longitude with no
gap, and `mumi:worldcloudmap_ir108` is a single keyless layer covering the whole globe at `PT3H`
so one WMS layer draws clouds everywhere with no compositing. Both are on `view.eumetsat.int`,
whose licence position is recorded in the Verified table as NOT ESTABLISHED. Under this file's
own rule a licence goes in only once verified, so the GIBS half ships now and the EUMETView half
waits for a static EUMETSAT data-policy document. **Until then the cloud layer has a measured
58-degree hole over Europe, Africa and the Middle East, and that is said out loud rather than
papered over.** Fixtures: `tests/fixtures/eumetview_wms_cloud_layers_live.xml` (the service
header plus eight `<Layer>` blocks verbatim with their time dimensions) and
`eumetview_worldcloudmap_ir108_global_live.png`.

EUMETView's traps:

- **`CRS=EPSG:4326` is latitude-first here, and getting it wrong gives HTTP 502 with a zero-byte
  body and no content-type.** This is a **fifth** bounding-box convention for this project and
  the worst-behaved. Proved with a box that is valid one way and invalid the other:
  `CRS=EPSG:4326&BBOX=-170,-80,170,80` is 502 with 0 bytes, while `CRS=CRS:84` with the identical
  box is 200 with an 81,525-byte PNG. The capabilities states it: `<BoundingBox CRS="EPSG:4326"
  minx="-89.99" miny="-180" maxx="89.99" maxy="180"/>`, where `minx` is a latitude. A zero-byte
  502 reads as a dead upstream rather than a bad request, so an axis-order bug will be diagnosed
  as "EUMETSAT is down". **Use `CRS:84` for longitude-first or `EPSG:3857` for Web Mercator**,
  both advertised and both verified 200. Flip in the adapter with a test, the way the Worldview
  `BBOX` flip already is.
- **`TIME` is optional and omitting it returns a different image at HTTP 200.** A no-`TIME`
  request returned 500,266 bytes against 499,270 for the explicit-latest request, with different
  pixel hashes. Send `TIME` always. Same class as the Worldview `TIME` trap.
- **`nearestValue="1"` means a wrong timestamp silently snaps to a real frame** rather than
  erroring, so a units or format mistake produces a plausible image of the wrong moment.
- **The WMTS endpoint does not work; only WMS does.** `gwc/service/wmts` GetCapabilities is HTTP
  400 with a GeoWebCache error page and the RESTful tile form is 400 `text/xml`.
- **`view.eumetsat.int/robots.txt` returns HTTP 200 with the site's Angular index page**, 709
  bytes of `text/html`, not a robots file. A tolerant robots parser fed that HTML finds no
  directives and reports the path allowed. The absence of a crawl policy has to be established
  from the content type, not from the status code.

**Two verified sources not to build.** The NOAA STAR NESDIS CDN is by far the freshest thing
found at 7 minutes old, and it is a full-disk JPEG in the satellite's own geostationary
projection: reprojecting and tiling 5,424 by 5,424 pixels every ten minutes on this laptop to
arrive at what GIBS already publishes is the wrong trade. Keep it as the "show me the current
full disk as a picture" source, the role the Worldview snapshot API already plays for a place on
a day. And JMA's tiles are real Web Mercator and genuinely redundant for the Himawari sector,
but **off-disk is opaque white with no alpha channel**, 44.2% of a zoom-3 composite, so as a
Cesium overlay it would paint the rest of the world white. Chroma-keying white to transparent
also eats the genuine white of the brightest cloud tops. Fixture:
`tests/fixtures/jma_himawari_targettimes_fd_live.json`.

**CIRA SLIDER is fresh for GOES and 45 days dead for Meteosat, which is the one sector we needed
it for.** `meteosat-0deg`'s newest geocolor frame is 2026-07-06T17:15:00Z, 64,887 minutes stale,
**while still returning a valid HTTP 200 and a well-formed `timestamps_int` array**. A layer
built on it would connect, report healthy and draw July's clouds. `meteosat-iodc` returns a body
that is not JSON at all, so the parse throws rather than reporting an empty feed. Fixtures:
`tests/fixtures/slider_goes19_latest_times_live.json` and
`slider_meteosat0deg_stale_latest_times_live.json`, the second kept precisely because a freshness
check that trusts this source reports a working layer.

**RainViewer is negative twice over.** `api.rainviewer.com/public/weather-maps.json` answers
HTTP 200 with a structurally valid body whose `satellite.infrared` array is **empty**. Nothing
errors, nothing is missing, the layer simply draws nothing and reports healthy. Separately,
`api.rainviewer.com/robots.txt` is `User-agent: *` / `Disallow: /`, a blanket directive over the
whole host. Fixture: `tests/fixtures/rainviewer_weather_maps_empty_satellite_live.json`.

**Redundancy per sector, which is what the constraint actually asks for.** Americas and Pacific:
GIBS GOES-East and GOES-West, with the NOAA CDN as a fresher but reprojection-heavy second
string. Asia-Pacific: GIBS Himawari, with JMA's own XYZ tiles as a genuine keyless second string.
Europe, Africa, Middle East, Indian Ocean: **EUMETView only, with no independent second**,
because GIBS carries zero Meteosat layers, SLIDER's Meteosat is 45 days stale and DWD is
robots-blocked. That sector is the thin one and it is the same single-provider fragility the
redundancy rule exists to fix.

### Basemap and place-card imagery

Verified 2026-08-20.

**`BlueMarble_NextGeneration` is the globe basemap.** Public domain, cloud-free by construction
because it is a composite rather than a daily pass, no `Time` dimension so no date segment to get
wrong, ceiling `Level8` which is exactly the range a globe basemap needs, and measured faster
than the daily MODIS layer (mean 0.218s against 0.317s over ten sequential zoom-8 tiles). The
daily true-colour layers stay for the timeline.

**Microsoft Planetary Computer is the strongest new find and it does three things nothing else
keyless does.** It honours `cql2-json` for real, which is the direct contrast with earth-search:
same box and window, unfiltered top result `eo:cloud_cover` 99.999, and with a
`filter-lang: cql2-json` cloud-under-1 filter the top result is 0.011. It serves a keyless
browser-renderable JPEG per scene at Sentinel-2's native 10m. And it serves a keyless on-demand
mosaic: POST a STAC search to `/api/data/v1/mosaic/register`, take the `searchid`, then serve XYZ
tiles of every matching scene. Fixtures: `tests/fixtures/mpc_stac_s2a_search_live.json`,
`mpc_mosaic_register_live.json`, `mpc_item_preview_512_live.jpg`.

Its traps:

- **HTTP 204 with zero bytes and no content-type** for any mosaic tile below zoom 9, or over a
  place with no matching scene. Not a 404, not an empty PNG, nothing to content-sniff. **So the
  mosaic cannot draw a globe**: it is a zoom-in overlay that must sit on a real basemap, and a
  tile client treating 204 as an error logs noise across the whole world view.
- **No `numberMatched` in a search response.** `numberReturned` is present; `numberMatched` and
  `context` are both absent, so the proof technique that works on earth-search is unavailable and
  you cannot tell how many scenes matched.
- **Raw blob assets are not keyless but the signer is.** The `visual` href on
  `sentinel2l2a01.blob.core.windows.net` answers HTTP 409 with no token, and
  `/api/sas/v1/token/{account}/{container}` answers 200 keyless with a token carrying an
  `msft:expiry` about 45 minutes out. Same class as the Windy ten-minute token: never cache a
  signed URL past its expiry. **The tiler and the previews need none of it**, which is why they
  are the route to use.
- The `rendered_preview` asset href in every item is a 1024x1024 PNG at 2,883,695 bytes, far too
  heavy for a card; `format=jpeg&max_size=512` cuts it to 133,239 bytes.
- **Content-type on the JPEG is `image/jpg`, not `image/jpeg`**, so a strict check on the
  canonical spelling rejects a good image.
- Two path shapes exist for mosaic tiles, and getting the wrong one returns **HTTP 422 with a
  JSON `detail` array**, not a 404.
- No published SLA, no fetchable terms, and Microsoft has been moving this estate toward the paid
  Planetary Computer Pro. It answered every call made on 2026-08-20. It is the right card path
  and it must not be the only one.

**USGS LandsatLook is a catalogue whose pictures are behind a login, and the failure is silent.**
The search is keyless, global and honours `cql2-json`, which makes two of three keyless STAC APIs
that do and leaves earth-search the odd one out. But the `thumbnail` and
`reduced_resolution_browse` hrefs are HTTPS on `landsatlook.usgs.gov` and look keyless: they
answer **HTTP 302** to `ers.cr.usgs.gov`, and following the redirect lands on the USGS EROS
Registration System **login page served at HTTP 200 with `text/html`**. A browser `img` tag
renders a broken image and any client checking only the status code records a success and stores
a login page as a satellite photograph. Same class as the Flickr `stat: fail` at 200. Fixtures:
`tests/fixtures/landsatlook_stac_search_live.json` and
`landsatlook_thumbnail_ers_login_http200_live.html`. **The keyless route to Landsat imagery is
GIBS `HLS_L30_Nadir_BRDF_Adjusted_Reflectance`**, which is the same Landsat data harmonised, at
30m, on the public-domain NASA host, with no login.

**earth-search's Landsat half has the same shape of problem for a different reason.** Its
`landsat-c2-l2` `thumbnail` hrefs are `s3://usgs-landsat/...` URIs, which a browser cannot fetch
at all, and the HTTPS equivalent answers 403: "Anonymous users cannot invoke requests against
Requester Pays buckets." So earth-search's Landsat is a catalogue and its Sentinel-2 half is both
a catalogue and a picture source. Its `preview.jpg` thumbnail is confirmed at 343x343, and **the
byte size is per scene, not fixed**: this file records 2,563 bytes and a scene measured on
2026-08-20 was 35,733. Do not assert a size.

**On a granule layer the Worldview snapshot fills the missing part with black at HTTP 200.** The
30m HLS card image over London carries a black nodata wedge across the bottom-left corner where
the granule edge falls, so a card can render half an image and report success. Fixture:
`tests/fixtures/worldview_snapshot_hls30_london_live.jpg`. The snapshot API does render the 30m
HLS layer, which makes it the cleanest keyless card path in existence: one GET, no STAC search,
no GeoTIFF, no token, at 30m instead of 250m.

**What to show when the requested date has no imagery.** Sentinel-2 revisit is about five days
and Landsat 8 and 9 are 16 days each, so for most places on most dates nothing was captured.
Search a window rather than a date, take the least cloudy scene in it, and put **that scene's own
timestamp** on the card with how far it is from the date asked for. Say the number: "nearest
clear pass, 13 August 2026, seven days before the date requested, 0.01% cloud". When the window
is empty, say so and stop: no nearest-cloudy-thing, no 250m smear standing in for 10m, no basemap
tile dressed up as a dated observation. Widening the bracket is the right knob rather than
lowering the cloud bar, because a cloudy image looks broken while an older clear one looks
correct and is labelled.

**`s2maps-tiles.eu` is a stated refusal and must not be worked around.** It answers HTTP 403
with a 93-byte body reading "Request forbidden by administrative rules", byte-for-byte the ADS-B
Exchange globe-map wording this file already names as the worked example of a stated directive.
`tiles.maps.eox.at` is the sanctioned host for the identical mosaics and answers 200, so there is
nothing to gain. Fixture: `tests/fixtures/s2maps_tiles_eu_403_live.html`.

**Probe a tile service at the zoom you intend to draw, not at zoom 3.** USGS National Map
imagery returns 64 of 64 tiles at zoom 3 because a global low-resolution backdrop is served at
coarse zooms, and collapses to 404 outside the United States at zoom 10. A zoom-3 coverage probe
would have recorded it as a global provider.

**The honest redundancy count for the globe basemap is one.** NASA GIBS is the only keyless,
global, licence-clean provider, and its four hostnames are one CloudFront distribution. EOX is
CC BY-NC-SA on 2018 to 2025 so only the 2016 and 2017 mosaics are usable commercially, which
makes the redundant basemap nine-year-old imagery. Esri is licence-blocked. Planetary Computer
and earth-search cannot draw below zoom 9. USGS National Map is the United States only. The two
mitigations are local rather than another provider, and both fit a laptop with disk persistence
encouraged: **cache `BlueMarble_NextGeneration` zoom 0 to 5 to disk** (1,365 tiles, about 14MB,
so the globe always draws at a distance with the network down; zoom 0 to 8 would be 87,381 tiles
and about 870MB, which is not worth it), and **cut our own tiles from the keyless Sentinel-2 COGs
on `sentinel-cogs.s3.us-west-2.amazonaws.com`**, which answer HTTP 206 to a range request, if a
tiler is ever needed. More code than calling a provider, and it is the fallback that cannot be
withdrawn.

### CesiumJS with no ion token

Verified 2026-08-20 against Cesium 1.144.0, by reading the unminified bundle and then driving a
real browser against the running app and against a standalone keyless page.

**The app already runs with no token of any kind.** Twelve seconds after load the running app
made 89 requests to `gibs.earthdata.nasa.gov` and 87 to localhost, **zero to any Cesium or ion
host**, zero HTTP 400 or above, zero console errors and no Cesium error panel.
`frontend/src/globe/viewer.ts:89` already passes `baseLayer`, `baseLayerPicker: false` and
`geocoder: false`, which closes all three network touchpoints.

**"No token configured" is not "no token used", and that is the trap.** Cesium 1.144 ships a
hard-coded ion JWT at `frontend/node_modules/cesium/Build/CesiumUnminified/index.js:69093` whose
`aud` claim reads **"1.144 Release - Delete on October 1, 2026"**, `iat` 2026-07-25T05:54:50Z.
`api.cesium.com/v1/assets/2/endpoint` answers **401** with no credential and **200** with that
bundled token, and so do asset 1 (Cesium World Terrain) and asset 96188 (Cesium OSM Buildings).
So any ion-backed default works today on Cesium's own key and 401s in October, in a product that
has never seen the failure in testing. A bare `new Viewer(div)` was measured firing the ion
endpoint, then Bing metadata carrying a third-party Bing key handed straight to the browser,
then Bing tiles **over plain HTTP**. Neither the key nor the scheme is ours to manage. Fixtures:
`tests/fixtures/cesium_ion_asset2_401_no_token_live.json` and
`cesium_ion_asset2_bundled_demo_token_live.json`.

`Ion.defaultAccessToken = ''` is the guard, and it needs a test behind it: with the token blanked
an accidental ion call throws `Request has failed. Status Code: 401` and the console logs it, so
the mistake becomes loud instead of a six-week fuse.

**Terrain is not an ion touchpoint by default.** `Globe`'s constructor sets
`new EllipsoidTerrainProvider()` at `index.js:218166` and `Viewer` only touches terrain if
`terrain` or `terrainProvider` is passed. A bare `new Viewer(div)` reported
`terrainProvider = "EllipsoidTerrainProvider"`. So there is nothing to turn off and the risk runs
the other way: passing `Terrain.fromWorldTerrain()` or picking "Cesium World Terrain" in the base
layer picker opts **in** to ion asset 1. Flat terrain costs this product almost nothing, because
every entity is an aircraft at altitude, a ship at sea level, a satellite in orbit or a city
label, and none of them touches the ground.

**The ion logo is a false credit.** `getDefaultCredit()` at `index.js:223909` renders a link to
`cesium.com` titled "Cesium ion" bottom-left, while the app uses nothing from ion, and it sits
next to twelve real licence-condition credits, which undermines all of them. CesiumJS itself is
Apache-2.0 and asks for no logo. `CreditDisplay.cesiumCredit = new Credit('', false)` removes it
and leaves an empty wrapper div.

**`Credit`'s `showOnScreen` parameter defaults to false** (`index.js:68503`), so the
`new Credit('Imagery courtesy of NASA EOSDIS GIBS')` at `viewer.ts:71` lands behind the "Data
attribution" click rather than on screen. And `Credit.isIon()` is literally
`this.html.indexOf('ion-credit.png') !== -1`, so a provider credit that happens to contain that
filename is silently swallowed into the logo container.

**GIBS is credited in three DOM surfaces today and only one is always visible.** Cesium's own
lightbox, the project's `#attribution` panel and the layer rail footer. The two lists disagree
about **scope** rather than wording: Cesium knows only what its own providers told it, the
project's panel knows every upstream feed the backend touches, and they will never be the same
list. Passing `creditContainer` moves Cesium's entire credit block inside our element and removes
`.cesium-widget-credits` from the viewer's own container, so there is one credit surface rather
than two competing ones.

**There is no keyless global 3D building source, so the buildings layer is a delete rather than a
swap.** `data.osmbuildings.org`'s `anonymous` tier now answers 403, `data.3dbag.nl`'s versioned
path is a 404 and Netherlands-only anyway, and swisstopo's tileset works keylessly and covers
Switzerland. The Overpass route measured at **1.0MB of JSON for one square kilometre** of central
London, 866 building ways, of which **15 carry a `height` tag (1.7%) and 333 carry
`building:levels` (38%), so 62% have no height information at all** and would be extruded at a
guess, which fails this project's own no-fabricated-value rule. **Deleted on 2026-08-20.**
`routes_meta.py` used to publish a `buildings` capability whose reason string read "Set
TRACKER_CESIUM_ION_TOKEN to stream 3D buildings", and the layer rail builds one row per
advertised layer, so that sentence was on screen in the running app asking the user for a
Cesium key in a product whose constraint is no keys at all. The capability, the
`buildings_layer_available` property and the `cesium_ion_token` setting are all gone, and
`tests/api/test_routes.py` asserts that no capability reason mentions a Cesium key.

**Two Cesium classes are traps rather than options.** `VRTheWorldTerrainProvider` still ships and
its default host `www.vr-theworld.com` answers 404, so it constructs cleanly and fails at
tile-load time with an empty terrain and no error. `assets.agi.com/stk-terrain`, Cesium's
pre-ion terrain host, is a 404. And **`ArcGisMapServerImageryProvider.fromBasemapType` is the
wrong door**: it reads `ArcGisMapService.defaultAccessToken`, for which Cesium also hard-codes a
default at `index.js:113892`. Same expiring-borrowed-key trap as ion, different vendor. `fromUrl`
does not touch it.

### FAA Releasable Aircraft Database

Verified 2026-08-19. The URL has not moved. **73,031,563 bytes, 69.6MB**, 16% larger than the
FAA page's stated 60MB, downloading in 3 seconds, expanding to 532,556,660 bytes across eight
files whose real extension is `.txt` rather than `.csv`. `MASTER.txt` is **316,030 data rows**,
matching the plan's estimate, and `ACFTREF.txt` is 93,982.

**The cadence in this file was wrong: it is daily, not weekly.** The FAA's own page states "The
data in the download is refreshed daily at 11:30 pm central time." No request cap is published,
and there is no reason to fetch more than once a day.

**49 U.S.C. section 44114(b) is a third FAA privacy programme and ADR 009 does not cover it.**
ADR 009 worked through two, LADD and privacy ICAO addresses. This is a separate one and it bites
the ownership spine rather than the aircraft layer: a private owner can ask that personally
identifiable information such as names and addresses be withheld from broad dissemination or
display on a publicly available FAA website. **4,773 of 316,030 `MASTER.txt` rows arrive with an
empty `NAME` and 4,771 with an empty `STREET`**, which is 1.51%. There is nothing for the product
to decide or work through: the withholding already happened upstream, the record arrives empty,
and it is dropped and counted like any other unmappable record. Without this note somebody loses
a day hunting for suppression logic that does not exist.

**A descriptive User-Agent is refused with HTTP 403 across the whole host, `robots.txt`
included.** The error page is Akamai's (`errors.edgesuite.net`). The identical request with a
Chrome User-Agent answers 206 with a real `Content-Range`. **This is a direct conflict with
`AGENTS.md`, which requires a descriptive User-Agent with contact details on scraped sources.**
`registry.faa.gov/robots.txt`, fetched with the browser string, disallows only
`/aircraftinquiry/*.asp`, so robots.txt permits the download and the bot filter blocks the
honest identification. `HEAD` also fails (503 from a cached Akamai error page dated 2013), so
`curl -I` is not a usable size probe and a `Range: bytes=0-0` GET is.

**Mode S joins directly with no derivation, and the decoy column is next to it.** `[33] MODE S
CODE HEX` is 6 uppercase hex characters on all 20,000 rows sampled, zero blanks. `[21] MODE S
CODE` is 8-digit **octal**, and `int(octal, 8)` formatted as `%06X` equalled the hex column on
**20,000 of 20,000 rows**. Two columns, one number, two bases. Picking the wrong one gives
`50002263` where you wanted `A004B3` and it will never match anything.

Joined against the repo's live ADS-B fixtures: of 326 A-prefix hexes, 11 hit and 315 missed, and
**every single miss is a US military aircraft** in the AE block. Military aircraft are not on the
civil register. All 11 civil hexes resolved and the registration matched on 11 of 11 after
prepending the `N`.

Traps, every one of which would otherwise be found three times:

- **UTF-8 BOM on the header line.** Open with `encoding='utf-8-sig'` or the first column is
  literally named `﻿N-NUMBER`.
- **Trailing comma on the header and every data row**, so there is a 35th empty column that is
  not a field.
- **Every field is space-padded to a fixed width inside a CSV.** `NAME` came back as
  `'BENE MARY D'` plus 39 spaces. Strip everything, always.
- **`N-NUMBER` has no `N` prefix.** Zero of 20,000 rows start with `N`. Prepend it to join on
  registration.
- **`MODE S CODE HEX` is uppercase and adsb.lol is lowercase.** Fold before comparing.
- **Dates are bare `YYYYMMDD` strings**, naive by construction with no stated zone.
- **No quoting at all.** Zero `"` characters in 20,000 lines, so a name containing a comma
  corrupts the row with no way to detect it.
- **1.51% of records have no owner name.** 4,773 of 316,030 rows have a blank `NAME` and 4,771 a
  blank `STREET`. This is the FAA's 49 U.S.C. 44114(b) PII withholding programme, it is **not
  LADD**, ADR 009 does not cover it, and the withholding has already happened upstream so the
  record simply arrives empty. Nothing to decide, but this repo should stop implying ADR 009
  covers every FAA privacy path.
- `ACFTREF` has **no ICAO type designator**: `MODEL` is `"767-322"`, not `"B763"`. The join
  `MASTER.MFR MDL CODE` to `ACFTREF.CODE` is complete, 0 of 316,030 missing, so a plain dict
  lookup is safe. `AC-WEIGHT` is a class string, not a number, and `SPEED` is `0000` on most
  rows meaning unknown rather than stationary.

**There is no extract-date field anywhere in the data**, which ADR 008 needs. Use the HTTP
`Last-Modified` on the zip (`Wed, 19 Aug 2026 04:57:29 GMT`, RFC 7231 and explicitly GMT). Zip
entry mtimes are naive local central time and need a hardcoded timezone plus a DST rule, so
avoid them. The FAA page's own upload-date table has empty values in the served HTML.

### Transport Canada CCARCS

Verified 2026-08-19, HTTP 200, **4,510,340 bytes**, three files expanding to 37,616,401 bytes.
The descriptive tracker User-Agent works here with no bot filter. The download page is an
ASP.NET postback behind a licence agreement, and posting the form 302s to
`/Saf-Sec-Sur/2/CCARCS-RIACC/download/ccarcsdb.zip`, so recording the direct URL is legitimate
rather than a workaround. 34,919 aircraft rows and 38,536 owner rows, up to 12 owners on one
mark.

**Mode S is present but derivation IS required, so the plan's "no derivation" claim holds for
the FAA only.** Field 44 (`carscurr.txt` index 42) is a **24-character binary string**: every
value on all 34,919 rows is exactly 24 characters of `0` or `1`, zero blanks.
`f'{int(binary, 2):06x}'` gives the ADS-B hex, and **all 34,919 derive into the `c0` block**.
Reading it as hex or as an integer silently produces the wrong aircraft. Verified against the
committed extract: `AAC` gives `c00003`, `AAJ` gives `c0000a`, `AAM` gives `c0000d`.

Against the live fixtures, 13 C-prefix hexes gave 2 hits and 11 misses, and **every miss is a
Royal Canadian Air Force aircraft in the `c2`/`c3` sub-block**. Useful rule: **CCARCS is `c0`
only, so a `c2` or `c3` hex is Canadian military and will never resolve.** Skip the lookup
rather than counting a miss.

Traps:

- **The files are cp1252, not UTF-8.** All three fail UTF-8 decoding, confirmed against the
  committed extract at byte 342. French columns carry accented characters. Decode as cp1252 or
  every French field throws.
- **Neither data file has a header row.** The column names exist only in `carslayout.txt`, which
  is why the layout file is committed alongside the extracts.
- **`MARK` is leading-space padded and carries no country prefix.** Raw `' AAC'`, and no row
  starts with `C-`. Use `TRIMMED_MARK` and prepend `C-` to join on registration.
- **Blank and single-column junk lines are present**, two in each data file. Filter on the
  expected column count.
- **The layout file's own field coding is wrong.** It documents `TYPE_OF_OWNER_E` as
  "1=Individual, 2=Company, M=Manufacturer"; the actual values are the strings `Individual`
  (24,780) and `Entity` (13,756) and nothing else. Trust the data, not the dictionary.
- **`ACTIVE_FLAG` matters.** 2,200 of 38,536 owner rows are `I` for an inactive address.
  Ingesting one as current attaches a person to somewhere they left.
- Dates are `YYYY/MM/DD`, a third format alongside the FAA's `YYYYMMDD` and CASA's
  `DD/MM/YYYY`. Country fields are space-padded to 100 characters. Every field is double-quote
  delimited, unlike the FAA files which use no quoting, so one parser cannot serve both blindly.
- No extract-date field. Use HTTP `Last-Modified`; the zip entry mtimes are an hour later than
  it and inconsistent with it.

**Two blockers, both needing a decision rather than code.** `wwwapps.tc.gc.ca/robots.txt` is 28
bytes and reads `User-agent: *` / `Disallow: /`, which covers the zip. And the Government of
Canada Open Data Licence, clause 3.1(d), verbatim: "you shall not merge or link the data made
available through the GC Open Data Portal with any product or database for the purpose of
identifying an individual, family or household". Joining a CCARCS owner name to a person profile
is exactly that, and it is the only reason phase 5 wants this source. **CCARCS is usable for
aircraft attributes and prohibited for the owner-to-profile join.** Clause 3.1(c) also requires
any distribution to be evidenced by a written agreement, which is awkward for a public web
product. The mandatory attribution is in the table below.

### CASA (Australia) aircraft register

Verified 2026-08-19, HTTP 200, **7,003,192 bytes**, 44 columns, 16,680 data rows. The listing
page is on `www.casa.gov.au` and the file is on `services.casa.gov.au`.

**It kills the plan's Mode S claim.** `docs/plan/implementation-plan.md:420-421` says the
Canadian and Australian registers both carry Mode S codes. Searched all 44 column names for
`mode`, `hex`, `24`, `transp`, `icao` and `addr`: the only hits are `Model`, `Engmodel`,
`Propmodel` and **`ICAOtypedesig`**, which is the ICAO **type designator** (`SR22`, `B429`),
populated on all 16,680 rows and not remotely a 24-bit address. **CASA cannot be joined to
ADS-B on hex at all.** The only join key is the registration mark, which means going through a
live feed's `r` field and inheriting whatever error that carries.

**The access gate is worse than the FAA's, because it fails silently.** With the descriptive
tracker User-Agent, HTTP/2 fails with `INTERNAL_ERROR` and HTTP/1.1 **hangs until timeout with
zero bytes received**. TCP 443 connects and DNS resolves to Akamai. A bare Chrome User-Agent is
**not enough**: the full browser header set (`Accept`, `Accept-Language`, `sec-ch-ua`,
`Sec-Fetch-*`, `Upgrade-Insecure-Requests`) is what gets a reply. So in an adapter this looks
like a network problem rather than a block, and the distinction has to be logged.
`www.casa.gov.au/robots.txt` permits the data path, and `services.casa.gov.au/robots.txt` is a
404 IIS page.

Traps:

- **`Mark` is exactly 3 characters on all 16,680 rows with the `VH-` prefix stripped**, and
  there are 26 marks that themselves begin with `VH`, so `VH-VHA` is a real registration. A
  "does it already start with VH" guard is wrong: check the length.
- **Dates are `DD/MM/YYYY`.** 6,325 of 16,680 `Datefirstreg` values, **38%**, have a first
  component of 12 or less, so a US-order or guessing parser silently reads more than a third of
  the register wrong and throws on the rest. Verified against the committed extract at 85 of 200.
- **UTF-8 BOM** on the header line, as the FAA files.
- **8,730 of 16,681 lines contain a double quote**, so more than half the file is quoted and a
  naive `split(',')` corrupts it. The FAA files have zero quotes. Do not reuse one parser.
- **`MTOW` has no unit column and it is kilograms**, verified against known types (an SR22 reads
  1633, which is 3,600 lb). Constant, not config.
- **Currently-registered aircraft only.** CASA's page says historic entries are not published,
  so a deregistered aircraft vanishes rather than being marked and an ownership attribute goes
  stale with no signal. The FAA ships `DEREG.txt` for exactly this; CASA and CCARCS do not.
- **The operator is a second full address block** (`regopName` through `regopCommdate`), which is
  more than the FAA or CCARCS give. `regholdCountry` is not all Australia: 108 United States,
  61 Ireland, 30 Japan, 73 blank.
- **CASA's own page warns the registration holder is not the beneficial owner.** CASR 47.055
  says a registration certificate is not evidence of a legal or beneficial property interest, and
  there is only one holder regardless of co-owners. That matters for ADR 011 scoring: this is a
  primary record of *registration*, not of *ownership*.

**Licence: CC BY 4.0, and it is the cleanest in the group by a distance**, the only aviation
register here that permits commercial redistribution outright. Publication is statutory under
CASR 47.030. Conditions in the attribution table below.

**Every one of the three registries strips the country prefix from the registration and none of
them carries an extract date in the data.** Both are one-line adapter facts.

### ITU MARS and the ITU MID table

Verified 2026-08-19. MARS is an ASP.NET MVC page, not an API: `GET` the list page to mint a
session cookie and an encrypted `Breadcrumb` hidden field, then **POST to the same URL** with
the search fields. There is no anti-forgery token, so it is scriptable. A search on MMSI
310627000 returned the QUEEN MARY 2 row at HTTP 200.

**Three corrections to this file's old row.**

1. **"Registration may be needed for bulk access" is wrong on the mechanism.** No registration
   for bulk access exists. The real constraint is a hard cap: a broad search returned the literal
   string `Number of results exceeds the search limit of 1000` and paged 1 of 67 at 15 rows a
   page. No CSV, no export, no all-rows button. Registration (ITU TIES over SAML) gates exactly
   one thing, the Emergency Contact view.
2. **"MMSI to name and flag" undersells it and mis-states the flag.** The detail page carries the
   registered **Owner**, **Gross Tonnage**, **Capacity for persons**, EPIRB hex and
   classification. And **the flag is the `Geographical Area` column, not `Administration`**:
   QUEEN MARY 2 is Bermuda-registered and shows `Administration = G` for the United Kingdom,
   because Administration is the ITU member that notified the station. Read it as the flag and
   every Red Ensign yacht comes out British.
3. **"ITU terms" is too soft.** The ITU terms of use permit "personal, educational, or
   non-commercial purposes" and prohibit distribution or commercial use "without obtaining prior
   written permission from ITU". That is a commercial-deployment blocker and it belongs in the
   licence audit beside ADS-B Exchange.

`Search.GeneralClassification.SelectedId` includes `PL` for pleasure and leisure craft, so
**private yachts are in this database**, which is the whole reason the phase 5 join is worth
building.

Traps:

- **The detail page is a second request per vessel** and its id is MARS's own primary key, not
  the MMSI, so you cannot address a record directly: search, then POST the id. The follow-on GET
  carries a `?context=` blob of encrypted server state and is not a stable permalink.
- **Fields fill by administration, not uniformly.** QUEEN MARY 2's record has `Owner`,
  `Gross Tonnage`, `Capacity for persons` and the vessel ID all **empty** while a Cayman yacht
  has all four. Empty is empty; do not infer.
- **A record can have no MMSI at all** (EPIRB or handheld-DSC-only stations). An adapter keyed
  on MMSI drops and counts them.
- **`Ship (Vessel) Identification Number` is not reliably an IMO number.** Cayman pleasure craft
  returned 6-digit Cayman official numbers, and QUEEN MARY 2, which definitely has IMO 9241061,
  has the field empty. MARS is not an MMSI-to-IMO bridge.
- **The upstream data itself is mis-keyed** on at least one record: `Former Ship Name` holds a
  call sign and `Former Call Sign` is empty. A strict contract has to tolerate it.
- `Owner` is a corporate vehicle, not a person. Under ADR 011 one registry extract is a primary
  record and may assert alone, but the beneficial owner behind the vehicle never can on this
  evidence.
- An empty field renders as an empty `<label>` rather than a missing element, so a scraper keyed
  on label presence reads every field as present.
- `Update Date` is `DD/MM/YYYY` with no time and no zone, it is the notification date rather
  than an observation, and it can be years stale.
- **The whole thing is stateful HTML.** Two concurrent scrapes on one cookie jar read each
  other's search state.

**The Emergency Contact view is gated, and the gate is a HTTP 200.**
`viewCommand=ViewEmergencyContact` answered 200 with an auto-submitting SAML form and a final
URL of `https://auth.itu.int/my.policy`. So a naive scraper stores a login page as a vessel
record, and anything reading MARS must treat a redirect to `auth.itu.int` as a failure and count
it. The fields we actually want are all public; the emergency contact person is not available to
us, which is the right outcome for this project anyway.

**The MID table's real endpoint is the iframe target, not the page.**
`https://www.itu.int/en/ITU-R/terrestrial/fmd/Pages/mid.aspx` is a SharePoint shell whose only
content is an iframe pointing at `https://www.itu.int/gladapp/Allocation/MIDs`, which is
fetchable on its own: HTTP 200, 119,621 bytes, one table, 249 data rows, **292 distinct MIDs**
in the range 201 to 775.

Three traps, and the first one silently drops the UK:

- **One cell can hold several MIDs.** `232 233 234 235` maps to the United Kingdom, and the same
  pattern covers France, Spain, Greece, the Netherlands, Malta, Cyprus and Denmark. A regex
  requiring exactly three digits drops **25 rows including all of those**, giving 224 MIDs
  instead of 292.
- **MID does not uniquely determine a flag.** MID `306` appears three times, for three Dutch
  Caribbean territories. The prefix gives a *set*, and under ADR 011 that is a value you cannot
  assert, only narrow.
- **Allocated-to strings are ITU long form with territory suffixes**, not ISO codes, so joining
  them to Digitraffic's ISO alpha-2 `nationality` needs a mapping table and the territory rows
  have no ISO code at all. MIDs in the 8xx and 9xx ranges do not exist in the table but real
  MMSIs use them via the ITU-R M.585 prefix rules, so `mmsi[:3]` blindly gives `999` for the
  NATO WARSHIP record, which is not a MID.

The committed fixture is a **transform, not a raw body**: the 249 rows parsed out of the HTML
into `{"rows": [{"mid_cell", "allocated_to"}]}` with `mid_cell` kept verbatim so the multi-MID
cells survive as evidence.

### USCG PSIX

Verified 2026-08-19, keyless, public domain. `getVesselSummaryXMLString` over SOAP 1.1 answered
HTTP 200 with a real record. The cross-registry chain works: MMSI 310627000 to a MARS call sign
of ZCEF6 to PSIX IMO 9241061 and flag BERMUDA. **PSIX is how you get an IMO number MARS does not
hold.**

**There is no MMSI parameter and no MMSI in any response.** Request fields are `VesselID`,
`VesselName`, `CallSign`, `VIN`, `HIN`, `Flag`, `Service`, `BuildYear`.

Traps:

- **The XML is double-encoded.** The SOAP body is a single `getVesselSummaryXMLStringResult`
  element containing an entity-escaped `NewDataSet` document. Unescape, then parse again. The
  non-`XMLString` twins return a .NET `DataSet`, which is worse.
- **`Identification` is the IMO number, unlabelled**, and for a US-documented vessel it is a
  USCG official number instead with nothing in the response saying which.
- **Field names differ between request and response**: you send `CallSign`, you get
  `VesselCallSign`; `VesselID` in, `VesselId` out.
- **No owner. Anywhere.** The documented field list for all seven operations was read:
  particulars, dimensions, tonnage, documents, deficiencies, cases and operation controls. None
  carries an owner or an address. **PSIX does not answer the ownership question.**
- `getVesselDimensions` is in **feet**, so convert in the adapter.
- `getVesselSummary` accepts wildcards on `Service`, so a careless call pulls a very large
  result set.
- `cgmix.uscg.mil/robots.txt` answers **HTTP 302 to a validation-error page**, so there is no
  retrievable crawl policy. Absence is not permission: throttle hard, cache per vessel, no
  sweeps. No rate limit is published.

### SEC EDGAR

The cleanest source in phase 6 by a distance: public domain, 10 requests per second stated by
the SEC, and no redistribution restriction. Verified 2026-08-19 across five endpoints.

**A natural person has their own CIK and their own submissions document**, so one call returns
every insider filing that person has ever made across every issuer. `entityType` is `"other"`
for a person and `"operating"` for a company, and there is no explicit is-a-person flag.

**Form 3, 4 and 5 XML is the only structured officer and director statement in EDGAR**, and it
is the phase 6 demo: `rptOwnerCik`, `rptOwnerName`, `isOfficer`, `officerTitle`, `isDirector`,
with `issuerName` as the employer, dated to `periodOfReport`, keyless.

**Full-text search returns person CIKs from a person name.** `efts.sec.gov/LATEST/search-index`
answered 200 with `hits.total.value: 336` for a quoted name, returning both the person's CIK and
the issuer's. Feed the person CIK back into the submissions endpoint and you have a keyless
person to company to dated filing graph.

Traps, in order of how much they cost:

- **An undeclared User-Agent is HTTP 403 with an HTML body.** Both a suppressed User-Agent and
  curl's default got 403 titled "Your Request Originates from an Undeclared Automated Tool". Any
  string carrying a contact address passes. **Ship the User-Agent as a constant in code with a
  test**, the same treatment Nominatim already gets, or every EDGAR call 403s with HTML that a
  JSON parser throws on rather than reports.
- **`sec.gov/robots.txt` allows `/Archives/edgar/data` and disallows `/cgi-bin`.** So
  `browse-edgar` is out even though it answers 200 with a valid Atom feed. There is no
  `Crawl-delay` anywhere in the file, so the 10 per second from the developer page is the only
  cap. `data.sec.gov/robots.txt` is a 404 from an S3 origin.
- **Deep paging on full-text search fails with HTTP 200 and an error body**:
  `{"errorType":"ResponseError","errorMessage":"...Result window is too large..."}` at
  `from=10000`. Check for `errorType` before trusting any 2xx from that host. Page size is fixed
  at 100. `hits.total.relation` can be `"gte"`, so do not print the count as exact without
  checking it.
- **The text index starts in 2001 while EDGAR itself goes back to 1994.** Verified empirically:
  a 1996-1999 window returned 0 hits and the same query for 2001 returned 3,081.
- **`filings.recent` caps at 1,000 rows** and older history is only reachable through
  `filings.files[].name`. A parser reading only `recent` silently loses history for any active
  filer. It is 16 parallel arrays, not a list of objects, so you zip them by index.
- **`primaryDocument` for an ownership form carries an XSL renderer prefix**
  (`xslF345X06/form4.xml`), and fetching that path returns `text/html`. Drop any leading `xsl*/`
  component and keep the basename. The basename is not always `form4.xml`.
- **The relationship flags are omitted when false, not set to false.** An officer filing has
  `isOfficer` and `officerTitle` and no `isDirector` at all; a director filing has only
  `isDirector` and no `officerTitle`. A wire model requiring all four booleans rejects every
  filing in EDGAR. Default them to `False` on absence.
- **`rptOwnerName` is `SURNAME FORENAME`, space-separated, with no comma and inconsistent
  casing** between filers. There is no reliable split on a multi-word surname: carry the string
  and match on the CIK. FEC's `contributor_name` is `LAST, FIRST` with a comma, so the resolver
  has two conventions to reconcile.
- **`rptOwnerStreet1` and `addresses.mailing` are the issuer's address, not the person's home
  address.** Insiders file at the company address by convention. Ingesting either as a dated
  home address under ADR 008 would be a real bug that no test catches.
- Every scalar in the XML is wrapped (`<transactionShares><value>1439</value></...>`) and can
  carry a sibling `footnoteId`. `transactionShares` can be absent entirely.
- **Dates and zones are mixed inside one document.** `acceptanceDateTime` is aware `Z`;
  `filingDate`, `reportDate`, `periodOfReport` and `signatureDate` are date-only and naive; the
  directory listing's `last-modified` is naive **US Eastern** and the same event reads four hours
  later in `acceptanceDateTime`. `formerNames[].from` is midnight US Eastern expressed as UTC, so
  taking the date part off the UTC string is right for winter and wrong for summer.
- Missing values are inconsistently `null` or `""` in the same document. `ein` is an unhyphenated
  string here, an int on ProPublica and a hyphenated string in `strein`: three formats for one
  identifier.
- `company_tickers.json` is a dict keyed by a **positional index string**, not by CIK, and
  `cik_str` is an **int** despite the name, so the submissions URL needs a 10-digit zero pad.
  Never key a store on the outer index.
- The directory listing at `.../{accession}/index.json` serves a JSON body with
  `content-type: text/html`, and its `size` field is a string, or `""` for index entries.

**DEF 14A is not the phase 6 path.** A real proxy statement answered 200 at 1,248,425 bytes
with 292,226 characters of prose and 1,052 inline-XBRL tags, **none of which is a director or
officer name**: the tagging is pay-versus-performance. Board nominees and committee memberships
are prose in HTML tables. Extracting a board list means a language model over 292k characters
per company per year, which is a phase 15 problem. Form 4 gives the same people as structured
XML for free. DEF 14A is only the source for a non-filing director, which is rare.

### ProPublica Nonprofit Explorer

Verified 2026-08-19 on both endpoints, and **it contradicts this file's own row.**

**The trustees claim is wrong. There is no trustee, officer or director name field of any kind.**
Every key was enumerated: 34 on `organization`, 129 on `filings_with_data[0]`, 5 on
`filings_without_data[0]`, and **not one of the 168 is a person name**. ProPublica's own API
documentation lists two endpoints and no personnel field. The two near misses are traps:
`careofname` is the IRS Business Master File mailing-label line (`"% WILLIAM H GATES III TTEE"`),
free text with a leading `%` and an abbreviation and no role field, present at the IRS's
discretion; and `compofficers` is officer **compensation**, a number, not officer identity.
Treating either as a structured trustee is exactly the single-source assertion ADR 011 forbids.

**What it does give is real and is the other half of the row**: assets, income, ten years of
filings, ruling date, NTEE code, foundation code and tax period. That part is sound.

Traps: `cur_page` is 0-indexed while `num_pages` is a count. `ein` is an int and `strein` the
hyphenated string. `have_filings`, `have_extracts` and `have_pdfs` are `null` rather than
`false`. `score` is a raw relevance number with no ceiling and **must never be fed into an
ADR 011 confidence calculation**. `tax_prd` is a six-digit `YYYYMM` int while `tax_period` is a
date string, in one document. The Yes/No flags are single-character strings (`"N"`, `"Y"`,
`"1"`). And `data_source: "current_2026_07_21"` is the extract vintage: the data is a monthly
IRS extract, so **any date on a ProPublica-derived attribute is the extract date, not the fetch
date**.

**The document routes are closed twice over.** `download-filing` answered **HTTP 403**, and
`projects.propublica.org/robots.txt` disallows `/nonprofits/download-filing*`,
`/nonprofits/download-xml*`, `/nonprofits/search*`, `/nonprofits/full_text_search*` and
`/nonprofits/display_990*` by name. The `/nonprofits/api/v2/` path is not matched by any of
those, so the API itself is permitted and only the documents are blocked. Note `download-xml*`
is disallowed too, so ProPublica's mirror of the raw 990 XML is off limits.

**The licence is sharper than "ProPublica terms".** From their Data Store terms, verbatim: "You
can't republish the raw data in its entirety or otherwise distribute the data (in whole or in
part) on a stand-alone basis", "You can't charge people money to look at the data or sell
advertising specifically against it", "You can't sub-license or resell the data to others", and
"If you use the data for publication, you must cite ProPublica." Serving a foundation's assets
to a browser as a card is arguably distributing part of the data on a stand-alone basis, and the
commercial restriction is a second and separate problem for a product demo. This belongs in the
licence audit alongside ADS-B Exchange and AISHub. No rate limit is published, so treat it as
unstated rather than unlimited.

**The route to real 990 trustee names is dead and its replacement is a bulk ingest.** The
`irs-form-990` S3 bucket answers a list request with **zero `Contents` elements** and any
per-filing key with 404 `NoSuchKey`: the IRS retired the dataset, so any library building
`{object_id}_public.xml` URLs is broken. The live replacement is the IRS bulk 990 XML at
`https://apps.irs.gov/pub/epostcard/990/xml/{year}/{year}_TEOS_XML_{nn}.zip`, HEAD 200,
71,497,607 bytes for one 2026 month and roughly 1.1GB a year, holding
`Form990PartVIISectionAGrp` with `PersonNm` and `TitleTxt`. It is a local-index ingest in the
same category as GeoNames, not a phase 6 quick win, and the contents were deliberately not
downloaded so the XML shape stays unverified.

### Companies House

**The bulk PSC snapshot is keyless and carries real named people, which this file's "Free key"
row implied was impossible.** Verified 2026-08-19 with no credential of any kind: the daily
snapshot is 2.2GB whole or 32 parts of about 72MB, and a 2MB range fetch inflated to 13,544
records. Each line is `{"company_number": ..., "data": {...}}` and a real individual record
carries structured name elements, a partial date of birth, nationality, country of residence, an
address, dated `natures_of_control` bands, a stable per-person-per-company id in `links.self`
and an `etag`. In a 400-record sample, 361 were individuals and 39 corporate entities. **This
alone makes the UK side of phase 6 demoable without a key.**

Traps, several of which matter:

- **`date_of_birth` has `month` and `year` only. There is no `day` key.** That is the statutory
  suppression on the public register, not a data gap, so a contract expecting a full date fails
  on every record. It is also a weak match key: month plus year gives roughly 1 in 1,200
  discrimination, nowhere near the ADR 011 assertion threshold on a name match.
- **`address` is the service address, not the residential address.** Companies House suppress
  the usual residential address. Do not present it as a home address under ADR 008. Same shape
  of trap as SEC's `rptOwnerStreet1`, and neither would be caught by a test.
- **`appointment_verification_end_on: "9999-12-31T00:00:00Z"` is a sentinel meaning no end
  date.** It parses cleanly as a datetime, so nothing errors: it renders as "verified until the
  year 9999". Map year 9999 to `None`. Same class as the Copernicus `EvictionDate`.
- **Three name fields that can disagree**: `name` includes the title, `preferred_name` does not,
  and `name_elements` is the structured form. Use `name_elements`; never string-split `name`.
- **`natures_of_control` are percentage bands**, not numbers, which fits ADR 011's
  "corroboration raises confidence, never precision" and does not fit any code wanting a stake
  percentage.
- **A PSC is not an officer.** There is no `officer_role` and no `occupation` in this feed, so a
  job title still needs the key-gated `/officers` endpoint.
- **A corporate PSC record has a completely different sub-shape**: no `name_elements`, no
  `date_of_birth`, no `nationality`, and an extra `identification` block. Branch on `kind`
  before mapping.
- `notified_on` is date-only and naive while the verification timestamps are aware `Z`, mixed
  within one record. The zip member has a `.txt` extension and JSONL content, so do not sniff on
  extension.

**The REST API gate is verified and it distinguishes two states usefully.** No credential
answers **HTTP 401** `{"error":"Empty Authorization header","type":"ch:service"}`; a wrong key
answers **HTTP 401** `{"error":"Invalid Authorization"}`. Empty means no key is configured, so
report the layer unavailable through `LayerCapability`; invalid means a key is configured and
wrong, which is a real error worth surfacing. The distinction is free and should not be
collapsed. Auth is HTTP Basic with the key as username and a blank password, confirmed in the
provider's own guide. The rate limit is 600 requests per five minutes, also confirmed, **and
the penalty shape matters: a breach locks you out for the remainder of the window** rather than
for a retry-after interval, so the floor has to be a real token bucket rather than a sleep.

**The Free Company Data Product has no people in it.** Its page text contains neither "officer"
nor "director": it is registered office, SIC codes and status. The officers bulk is a separate
paid product. Keyless UK people means the PSC snapshot and nothing else.

### FEC OpenFEC

**Name, home address, employer and job title for anyone who has given over $200 to a federal
campaign, on `DEMO_KEY` with no signup.** Verified 2026-08-19: no key is **HTTP 403**
`API_KEY_MISSING` (note 403, not 401), and `DEMO_KEY` answered 200 with 81 fields per result and
`x-ratelimit-limit: 10` on the response header. **This is the highest-harm source in phase 6 by
a wide margin** and it gets the full ADR 008 treatment as a matter of course: PII-marked, dated,
sourced, suppressible.

**The observed rate limit contradicts the documentation.** api.data.gov documents `DEMO_KEY` at
30 requests per hour; OpenFEC's own header says 10. Trust the header. This file's 1,000 per hour
is correct for a signed key.

Traps:

- **`sort=-contribution_receipt_date` returns undated rows, not the newest rows.** The field is
  nullable, descending sort puts nulls first, and `pagination.last_indexes` came back with
  `sort_null_only: true` confirming it. Since ADR 008 drops and counts an undated entry, the
  entire first page is silently discarded. Exclude nulls explicitly.
- **The name filter is full text, not exact.** A filter for one person returned both that name
  and a similar surname in the same page. Never treat a `contributor_name` filter as an identity
  match.
- **The same contribution appears more than once.** Two rows differed only in `committee_id` and
  the length of `contributor_zip`: one earmarked contribution reported by both the conduit and
  the recipient. A naive aggregate double-counts. Deduplicate on `sub_id` or on
  `(image_number, transaction_id)`.
- **The address on a payroll-deduction row is frequently the employer's**, not the donor's, with
  `receipt_type_full` carrying `PAYROLL DEDUCTION` as the tell. Do not ingest one as a residence.
- **`contributor_zip` is 5 or 9 digits, unhyphenated, and inconsistent for the same person.**
  Normalise to 5 before using it as a match key.
- `entity_type: 'IND'` and `is_individual: True` must both be filtered on; `ORG`, `COM`, `PAC`
  and `CCM` rows have no person and their `contributor_employer` is meaningless. `contributor`
  and `contributor_id` were both `None`: the useful data is in the `contributor_*` scalars.
- `pagination.count` came back at 165,887,681 with `is_count_exact: false`. Never render the
  count without checking the flag. `pagination.pages` is not usable: offset paging is capped and
  you page with `last_indexes.last_index`.
- The 40-field `committee` object is inlined on **every** result row, including the committee's
  `treasurer_name`, and it is the largest part of the payload. Strip it at the wire layer.
- `contribution_receipt_date` is nullable and date-only; `load_date` is **naive** and is the
  FEC's own load timestamp rather than the transaction date. Do not substitute one for the other.
- **An unnarrowed name search times out.** A person-name query with no window answered **HTTP
  504** `{"message":"Query timed out"}`, and the same query with
  `two_year_transaction_period=2024` answered 200 in normal time. So that parameter is
  effectively mandatory on any name search, and a person's full history is one call per two-year
  cycle. **On a 10-per-hour `DEMO_KEY` that is two people an hour**: phase 6 needs a signed key
  or the FEC bulk files for anything beyond one demo profile.
- **Two error envelopes on one API**: the 403 is `{"error":{"code","message"}}` and the 504 is
  `{"message","status"}`. A single error model will not fit both.
- `pdf_url` points at `docquery.fec.gov`, whose `robots.txt` sets **`Crawl-delay: 10`** and whose
  path is under `/cgi-bin`.

**`api.open.fec.gov/robots.txt` disallows `/v1/*`**, which is the entire API. See the provisional
position below.

### Nominatim

Verified 2026-08-19, HTTP 200 on `format=jsonv2`. Top level is a **bare JSON list**, not an
object. London UK ranks first as the plan requires.

**Re-verified 2026-08-20 through the running product**, which is a different test from a curl:
`GET /search?q=buckingham+palace&format=jsonv2&limit=5` answered HTTP 200 and resolved to
`relation/5208404` at `-0.1430045, 51.5008349` with the full address string, plus a second hit for
a Buckingham Palace in Teton County, Wyoming. Two things worth recording from that run. The query
is **folded before it leaves**, to `buckingham palace`, so the cache key is insensitive to case
and accents rather than storing an entry per spelling. And four identical `/api/search` requests
cost **exactly one** upstream call, 563ms for the first and 1.8 to 4.7ms after, which is the
provider's mandatory caching requirement met and measured rather than designed.

- **`lat` and `lon` come back as strings**, `"51.5074456"`, which a `strict=True` float field
  rejects. Convert in the wire-to-domain mapping.
- **`boundingbox` is four strings in latitude-first order**, `[south, north, west, east]`. That
  is a different order again from the OSM notes API's `bbox={w},{s},{e},{n}`, from Overpass's
  `(south, west, north, east)` and from our own `[longitude, latitude]`. **Four bbox conventions
  in one project**, and this is where somebody puts London in the Atlantic.
- **`jsonv2` returns `category` plus `addresstype` and there is no `class` key.** The older
  `format=json` uses `class`. Pin one format string, the same discipline as CelesTrak's `FORMAT`.
- **`address` and `extratags` are absent entirely, not null, when not requested**, and `address`
  has no fixed key set: the `ISO3166-2-lvl{n}` keys are numbered dynamically by admin level.
  Model it as an open dict.
- **`limit` is a ceiling, not a count.** `limit=5` returned 3, because Nominatim collapses
  duplicates. Do not assert a length equal to the limit.
- **The top hit for "London" is named "Greater London"**, an `osm_type=relation` boundary
  polygon whose `lat`/`lon` is a representative point rather than a city centre. London, Ontario
  does not appear in the top 3.
- `importance` is the ranking field and is not comparable across query terms. `addresstype` is
  not a place type: on a street address it was `office`.

**The provider's caps, quoted:** "No heavy uses (an absolute maximum of 1 request per second)",
"Results must be cached on your side", and under unacceptable use, "Systematic queries. This
includes reverse queries in a grid, searching for complete lists of postcodes, towns etc." So
caching is mandatory rather than advised, and **the city list must come from the GeoNames dump,
never from Nominatim.** The API hands us the exact credit string to render in every record's
`licence` field, so use that rather than a hand-written one.

**Its refusals carry a delay and it has to be stored, not just reported.** Added 2026-08-20
after a review found the figure was computed and thrown away. A 429 with `Retry-After: 120` was
followed by another request one second later, 120 of them inside the window the provider asked
us to stay out of, while the reason string handed back to the browser read "backing off 120s".
The client now holds a cooldown of its own: the provider's figure on a 429 or 420, and a flat
120s on the 403 block page, which carries no `Retry-After` at all. A 500 is deliberately not
treated as a refusal, only as a failure. Repeatedly re-sending one failing query is the exact
pattern the policy calls faulty, so a failure is never cached but is never immediately retried
either.

**A 200 whose records all fail to map is a failure, not "no such place".** Also added
2026-08-20. `lat` and `lon` are declared as strings on purpose, so a switch to JSON numbers
drops every record in the response. Caching that empty answer would report the query as unknown
for the life of the process, long after the provider was fixed, with an INFO log line as the
only trace. The adapter raises instead and the search response carries the reason.

**Five fields the provider sends are deliberately not carried:** `boundingbox`, `category`,
`type`, `addresstype` and `place_rank`. Nothing ranks, renders or flies on them, search flies
the camera to a point at a fixed altitude, and `place_rank` behind its documented `le=30` bound
would have dropped a whole live result the day the provider exceeded its own ceiling. The traps
above are recorded here and in the adapter's module docstring so a later reader starts from the
right order rather than measuring it again.

### Overpass

Verified 2026-08-19 with a POST to `/api/interpreter`, HTTP 200, plus `/api/status` which
reported `Rate limit: 2` and `2 slots available now` for this IP.

- **The query bounding box is latitude-first, `(south, west, north, east)`**, the opposite order
  from the OSM notes API and from Nominatim's response bbox.
- **`lat`/`lon` are floats here while Nominatim returns strings for the same values.** Two
  OSM-derived endpoints, two types, so the adapters cannot share a coordinate parser.
- **`way` and `relation` elements carry no `lat`/`lon`** unless the query asks for `out center`
  or `out geom`. Half of London's museums are mapped as building ways, so a POI query without
  `center` silently returns positionless elements. This one is flagged from documented behaviour
  rather than proved live: **verify it before writing the adapter.**
- **`tags` is entirely optional and unbounded**, and `name` is frequently missing on real OSM
  nodes. Drop and count anything without the tags we need.
- **Errors are HTML or plain text even when `[out:json]` was requested**, with 429 on rate limit
  and 504 on resource exhaustion. Same class as the GDELT plain-text 429.
- **Requests queue rather than fail fast**: the provider states a request waits up to 15 seconds
  for a slot and is then discarded, so a client timeout under about 20 seconds looks like a
  network fault when the queue is simply full.
- `timestamp_osm_base` is the data cut rather than the response time and is `Z`-suffixed, so use
  it as the as-of date. Declaring a `maxsize` above the instance default is a good way to earn a
  504.

**The stated cap has two halves and this file recorded one.** Quoted from the provider: "users
are expected to send a maximum of about 10000 requests per day and keep their download volume
below about **1 GB per day**." Also stated: a default run time of 180 seconds and a default
memory of 512 MiB. With the live `Rate limit: 2` from `/api/status`, the real operating
constraint is **2 requests in flight, 10,000 a day and 1GB a day.** Corrected 2026-08-19.

### Wikipedia REST summary and geosearch

Two different APIs, and this file filed one under the other.

**Geosearch is not in the REST API.** The full `rest_v1` OpenAPI spec was pulled (HTTP 200,
106,848 bytes) and there is no geosearch path in it. Geosearch is the action API GeoData
extension at `/w/api.php?action=query&list=geosearch`: a different host path, a different error
contract and a different missing-value convention. Corrected 2026-08-19.

**The licence the REST API declares is CC BY-SA 3.0 and GFDL, not 4.0.** Quoted from the spec's
own `info.description`: "content accessed via this API is licensed under the CC-BY-SA 3.0 and
GFDL licenses". The site-wide wiki text licence is 4.0. The API's declaration is the one binding
an API consumer, so either the row says 3.0 plus GFDL or it states both and says which applies
where. The same spec states the rate cap: "Limit your clients to no more than 200 requests/s to
this API."

REST summary traps:

- **`coordinates` is `{"lat": ..., "lon": ...}`, a named object**, so the adapter constructs the
  point by name and must never iterate the dict's values, which come out latitude first.
- **`coordinates` is absent entirely on a person.** A person summary is biography text and an
  image, nothing positional.
- **`timestamp` is the article's last-revision time, not a date about the subject.** It is the
  honest as-of date for the scrape and the wrong date for any claim inside the extract.
- **Image URLs carry analytics query strings** appended by the API
  (`?utm_source=...&utm_campaign=api`). Anything caching or hashing by URL has to strip them or
  the same file from two endpoints looks like two files.
- **The summary image is a different file from Wikidata P18.** ADR 013 says the reference face is
  P18 resolved to Commons, so phase 14 must not take the convenient image out of the REST
  summary. They are different photographs of the same person.
- `extract_html` and `titles.display` contain HTML; use `titles.normalized` for a plain string.
- **A page that does not exist returns 404 with `{"status":404,"type":"Internal error"}`.** Do
  not log that as a server fault or page anyone about it.
- `type` was `"standard"` on every page tested, including one expected to be a disambiguation, so
  treat it as an open string rather than a closed enum.

Geosearch traps:

- **`gsradius` is capped at 10 to 10,000 metres, and exceeding it is an error at HTTP 200.**
  `gsradius=50000` answered 200 with `{"error":{"code":"outofrange",...}}`. A client branching on
  status and then reaching for `query.geosearch` gets a `KeyError` rather than a clean error.
  **The action API's error contract is an `error` key in a 200 body, and it has to be checked on
  every action API call in this group**, `wbsearchentities` and `imageinfo` included. A wide-area
  geosearch has to be tiled.
- **A requested-but-absent property comes back as an explicit JSON `null`**, the opposite of
  WDQS. `name` and `region` were null on all 20 records.
- **A requested `gsprop` can be silently omitted.** `globe` was asked for and no record carried
  it, with no warning. Never index a `gsprop` field blindly. **Globe is a real filter you need**,
  because Wikimedia holds coordinates on the Moon and Mars, and `prop=coordinates` with
  `coprop=globe` does expose it.
- **`formatversion=2` is mandatory in practice.** Without it booleans come back as empty strings
  and page collections are keyed by pageid instead of being an array. Same class as CelesTrak's
  `FORMAT` and AISHub's `output`.
- **There is no timestamp anywhere in a geosearch response**, on the record or the batch. Under
  this project's rule that an undated location is dropped, geosearch supplies no upstream date at
  all, so the date would have to be our fetch time and that is not a fact about the place.
  Somebody has to decide whether a nearby panel is a location claim or a display list, because as
  a location claim it cannot pass the contract.
- **There is no article URL**, only `pageid` and `title`, so the CC BY-SA link has to be
  constructed as `https://en.wikipedia.org/?curid={pageid}`. That is a required construction, not
  a nicety.
- **Geosearch returns any geotagged article, not places.** The nearest hits to the centre of
  London were a wildlife photograph and a sculpture, with `Inner London` at 29 metres carrying
  `dim: 30000`. `dim` is the feature's own scale in metres and varied by three orders of
  magnitude in one six-row response: it is the field that tells you a result is a region rather
  than a point. Filter on `type` and sanity-check `dim` against the zoom.

**`wbsearchentities` needs a filter behind it.** It answered 200, but `type=item` is the only
filter it offers, so a search for a person returns a podcast episode, a book edition and a
Twitter-acquisition event alongside the person. **Label alone does not disambiguate**: three
separate items in one response were all labelled exactly "Elon Musk". So a name match against a
Wikidata label is a blocking key, never a score, and the search box needs debounce, then
`wbsearchentities`, then one batched WDQS `P31` lookup for the returned Q-ids, cached
server-side. `description` is optional and absent on some items, `aliases` appears only on alias
matches (where `match.text` and `label` differ), `url` is **protocol-relative** with no scheme,
and `success` is the integer 1 rather than a boolean.

**Every endpoint in this group sits under a `Disallow` for a crawler.** `query.wikidata.org`
disallows `/sparql` and `/bigdata`; `en.wikipedia.org`, `commons.wikimedia.org` and
`www.wikidata.org` all disallow `/w/`, `/api/` and `/wiki/Special:`; only
`upload.wikimedia.org` is open, disallowing just the commons archive directory. That does not
make API use prohibited, because robots.txt governs crawlers and Wikimedia publishes these as
APIs with their own governing documents. It does set two hard rules: **nothing that walks URLs
may ever be pointed at these paths**, which means no browser-side call and no crawler, and the
`Special:FilePath` URI that P18 returns is an identifier to be resolved through the API, never a
link to follow. **No `Crawl-delay` binds us**: the only one in any of those files is scoped to
`SemrushBot`, so the 1-per-second cadence used throughout is our own courtesy floor.

**The P18 URI is not a usable image URL.** It arrives as
`http://commons.wikimedia.org/wiki/Special:FilePath/...`, scheme `http`, percent-encoded, and
following it costs four redirects and hands back the 8.26MB original with no licence attached.
Decode the filename and put it through the API as `titles=File:...`. And **P18 on an
organisation is a building, not a face**: Google's P18 is the Googleplex. Any code treating "has
P18" as "has a reference face" feeds a building into the face embedder.

### EOX Sentinel-2 cloudless

Verified 2026-08-19: capabilities at `https://tiles.maps.eox.at/wmts` answered HTTP 200 with
67,911 bytes, and a real 256x256 London tile came back at 19,514 bytes.

**Ten mosaic years, 2016 to 2025, each existing twice, once per projection.** 2025 is the
latest; `s2cloudless-2026_3857` is a 404. **The 2016 mosaic has no year suffix at all**
(`s2cloudless`, `s2cloudless_3857`), which breaks any `f"s2cloudless-{year}"` construction.

**The licence is harder than this file recorded, in two ways.** It said "CC BY-NC on newer
mosaics". Read from EOX's own capabilities `ows:Abstract` per layer: **2016 and 2017 are CC BY
4.0; 2018 through 2025 are CC BY-NC-SA 4.0.** ShareAlike is the harder clause, because it
requires derivative works under the same licence, which a proprietary product cannot do. And it
covers **eight of the ten years**, not just "newer" ones. EOX's licence summary page names our
exact use case: commercial purposes require an EOX Commercial Attribution-RestrictedUse 1.2
licence, and the uses it lists include **"Web services and commercial dashboards"**. A
wealth-profile demo built for Altrata is a commercial dashboard. **If this is ever shown
commercially, only 2016 and 2017 are usable and they are nine years stale. Default to NASA GIBS,
which is public domain.**

Traps:

- **Every ResourceURL template in the capabilities is `http://`, all 46 of them.** A browser on
  an HTTPS page blocks those as mixed content, and the `http://` URL answers a 302 to https,
  which does not save a blocked mixed-content request. Rewrite the scheme when reading the
  capabilities; never use the template verbatim.
- **Errors return a decodable image body, not an error document.** A bad layer answered HTTP 404
  with **no `Content-Type` header at all** and a valid 1,225-byte 256x256 RGBA PNG, with the
  reason in `x-mapcache-error`. `robots.txt` behaves the same way: HTTP 400 with a PNG body.
  **Content-sniffing an EOX response tells you it is an image even when the request failed.**
  Read the status code and `x-mapcache-error`, and never treat a decodable image as success.
- **`EPSG:3857` is not a valid tile matrix set identifier here**: it is a 404. The `_3857` layers
  accept `g` (which is `900913`, Mercator by another name) and `GoogleMapsCompatible`, 22 levels;
  the 4326 layers accept `WGS84` only and cap at 18.
- **There is no `robots.txt`** (400 with the PNG body), so nothing to honour and nothing granting
  permission either. `ows:Fees` is absent and no rate limit is published.

**Attribution must be linked, not just displayed.** `ows:AccessConstraints`, quoted: "Proper
attribution is required for any usage... including the respective links e.g. 'Terrain { Data (c)
OpenStreetMap contributers and others, Rendering (c) EOX }' with links to
http://www.openstreetmap.org/copyright, https://maps.eox.at/#data, and https://eox.at."

### Flickr

**Flickr signals total authentication failure with HTTP 200, and this file recorded it as a
rejection.** Verified three ways on 2026-08-19: no `api_key` parameter, an empty `api_key` and a
31-character bogus key all returned **HTTP 200** with the identical 79-byte body
`{"stat":"fail","code":100,"message":"Invalid API Key (Key has invalid format)"}`.
`raise_for_status()` passes, `response.json()` parses, and the adapter then either throws a
`KeyError` on `d["photos"]` or, worse, treats an empty result as "no photos in London". **Check
`stat == "ok"` before anything else, count the failure, and never let it empty a store.** Same
handling as the AISHub trap. Second trap on the same call: with `format=json` and no
`nojsoncallback=1` the body is wrapped in `jsonFlickrApi(...)`, which is not JSON.

Everything below is **from the provider's documentation, not from a response body**, because no
key is configured. `bbox` is `min_lon, min_lat, max_lon, max_lat`, longitude first, matching our
contract. `accuracy` is a 1 to 16 scale where about 11 is city and 16 is street, which is the
field deciding whether a Flickr geotag is city-level for ADR 005 and ADR 015. **The `license`
parameter is not optional under this project's rules**: omitting it returns everything including
licence 0, All Rights Reserved, and `AGENTS.md` drops any item whose licence cannot be
determined. Pass `license=4,5,7,8,9,10,11,12` for redistributable items and carry the per-photo
`license` id into the domain contract via `extras=license`.

**Two provider figures this file did not record**, both quoted: "If your application stays under
3600 queries per hour across the whole key... you'll be fine", and "Flickr will return at most
the first 4,000 results for any given search query." The 4,000 ceiling is a design constraint on
any bbox sweep, because a busy city exceeds it and there is no way to page past it, so the query
has to be narrowed by date or by a tighter bbox.

---

## Provisional and unratified: robots.txt over published bulk data

**This is not a decision and it is not in an ADR.** ADRs record Alexander Fanthome's decisions,
and he has not taken this one. What follows is the provisional reading the build is running on,
recorded here so it is visible and reversible. The full reasoning, the contradictions behind it
and seven other provisional readings are in `docs/pending-decisions.md` (items R1 to R8, U1 and U2),
which is scratch working rather than a repo document.

**The conflict.** `AGENTS.md` says "Honour `robots.txt`, published crawl delays and stated
request caps in code." Two sources the plan depends on disallow the paths we need:

- **`https://download.geonames.org/robots.txt` is `User-agent: *` / `Disallow: /`**, every path
  and every robot, and `cities15000.zip` sits behind it. Verified 2026-08-19, re-verified
  2026-08-20, unchanged. The file answered HTTP 200 at 3,306,600 bytes with `ETag` and
  `Last-Modified` served, is published under CC BY 4.0 and is documented by GeoNames for exactly
  this use. Phase 4's whole city layer, all 34,072 rows, now sits on this reading as well.
- **`https://meri.digitraffic.fi/robots.txt` is 31 bytes and contains `Disallow: /api/`**,
  verified 2026-08-19 and re-verified 2026-08-20, which covers every Fintraffic endpoint in the
  verified table above. Digitraffic publishes that API, its OpenAPI document, its licence and a
  per-client identification header inviting programmatic use.

  **The robots file itself is only served to a client that offers gzip, found 2026-08-20.** Without
  `Accept-Encoding: gzip` the path answers **HTTP 200** with the single line `Use of gzip
  compression is required with Accept-Encoding: gzip header.` and no directives at all. With gzip it
  answers the real 31 bytes. So a robots checker that does not negotiate compression cannot read
  the crawl policy it claims to honour, and it gets a success status while failing to. Same class of
  trap as `registry.faa.gov` answering HTTP 403 on its own `robots.txt`, recorded as U3, except this
  one looks like a permissive empty policy rather than a block.

Two more sit in the same class: `api.open.fec.gov/robots.txt` disallows `/v1/*`, the whole API
the FEC issues keys for, and `wwwapps.tc.gc.ca/robots.txt` is `Disallow: /` over the CCARCS zip.

**The provisional reading, per `docs/pending-decisions.md` R4: robots.txt binds crawling, and a
documented API call or a once-weekly conditional fetch of a published data file is not
crawling.** GeoNames puts its dump on a host separate from its website; Digitraffic and the FEC
both hand out client identification for programmatic use. A single `If-None-Match` request a
week is not spidering.

**The consistency debt this creates, and how it is paid.** ADS-B Exchange's globe map is
currently excluded partly *because* its `robots.txt` disallows the paths by name. Under this
reading that argument no longer carries the exclusion on its own. The exclusion is therefore
restated on the two grounds that stand without robots.txt at all: `/data/aircraft.json` and
`/re-api/` both answer **HTTP 403 "Request forbidden by administrative rules"**, and the
provider's terms **prohibit redistribution** while serving positions to a browser is
redistribution. Both are already verified above and neither depends on a crawl directive.

**Status: provisional, unratified, and load-bearing in code.** Where the reading is relied on,
the constant or the branch carries the reason beside it and names `docs/pending-decisions.md`, so
reversing it is a grep rather than an excavation. If Alexander rules the other way, the GeoNames
weekly download, the Fintraffic vessel layer, the FEC lookup and the CCARCS ingest all stop, and
phases 2, 4, 5 and 6 lose a source each.

## Out of scope: needs a key or a credential

**Stated by Alexander Fanthome on 2026-08-20: no API keys at all.** Not a free key, not a
registration, not "email us and we will let you in". A source needing a credential is out of
scope for this project, whatever its data is worth.

Nothing below is deleted, because a row that disappears gets rediscovered and wired in six
weeks later. Each one stays, marked, with what it would have been for and what replaced it.
**Do not wire any of these in.** If one becomes necessary, that is a decision for Alexander
Fanthome and it changes the constraint, not the code first.

| Source | What it was for | The gate | Keyless replacement |
| --- | --- | --- | --- |
| aisstream.io | Global live ship positions over WebSocket | Free API key. The handshake is keyless (`HTTP/1.1 101`) and authentication is in the first application message, so a bad key is indistinguishable from a dropped socket | **None. There is no keyless global AIS.** Kystdatahuset plus Fintraffic reach 0.33% of the globe's cells |
| AISHub | Crowd-sourced worldwide vessel positions | A username granted only to members streaming raw NMEA off a physical AIS receiver: 10 vessels averaged over 7 days, 90% uptime. Feeding it data from other public AIS services is prohibited by name, so there is no software route in | As above |
| ADS-B Exchange | Unfiltered aircraft, including FAA-blocked airframes | Paid RapidAPI key, HTTP 401 without one. Its terms also prohibit redistribution, so it is barred twice over | None. adsb.lol is the only live unfiltered provider, and the provider-attributable count for every other member of the aircraft union is zero |
| Space-Track.org | The authoritative orbital catalogue | Account. Both `/basicspacedata/query` and `/publicfiles/query` answer HTTP 401 with the same body, so there is no anonymous corner of the host | **SatNOGS DB**, which names Space-Track as the origin of 1,520 of its 1,669 records and is CC BY-SA 4.0 |
| Cesium ion | 3D buildings (asset 96188) and world terrain (asset 1) | Client-side ion token. `api.cesium.com` answers 401 with no credential. **Cesium 1.144 ships its own demo JWT whose `aud` reads "1.144 Release - Delete on October 1, 2026"**, so an ion-backed default works today on someone else's key and 401s in October | **None for 3D buildings**, and none is wanted: see the `cesium-no-token` findings. Terrain needs nothing, because `EllipsoidTerrainProvider` is already Cesium's default |
| Companies House REST API | Officer roles and occupations | Free key. HTTP 401 with two distinct bodies, so no-key and wrong-key are separable | The **Companies House PSC bulk snapshot**, which is keyless and Open Government Licence 3.0, and carries no officer roles |
| FEC OpenFEC | US campaign finance, a person-to-place signal | `api_key` required. `DEMO_KEY` works and carries `x-ratelimit-limit: 10`, which is still a key | None. `DEMO_KEY` is a shared credential rather than an absence of one, so this is out under today's rule |
| Flickr | Geotagged photographs with author text | Free key. **The gate is HTTP 200, not a 4xx**: no key, an empty key and a bogus key all return `{"stat":"fail","code":100}` | Wikimedia Commons geosearch and OpenStreetMap notes, both keyless, both already verified |
| Windy Webcams v3 | Owner-submitted public webcams | API key in an `x-windy-api-key` header, HTTP 403 without it | **TfL JamCams** and **New York 511**, both keyless and both already verified |
| Copernicus Data Space Sentinel Hub WMS | Sentinel imagery as a WMS layer | The instance id in the URL path is the credential, which is a key that does not look like one | **Microsoft Planetary Computer** and **NASA GIBS HLS**, both keyless |
| MapTiler quantized-mesh terrain | Cesium terrain | Key. HTTP 403 | AWS Terrain Tiles terrarium, keyless |
| Nextzen terrarium tiles | Cesium terrain | Key. **HTTP 400 with a 22-byte plain-text body**, which reads as a malformed request rather than a missing credential | The same terrarium data on the AWS bucket, keyless |
| N2YO | Satellite element sets | Key. **HTTP 200 carrying `{"error":"No API Key provided"}`**, so a client branching on status treats it as an empty result | ReTLEctor, SatNOGS DB, AMSAT |
| KeepTrack API | Satellite element sets | Key. v4 answers HTTP 401 asking for a free key; v1 answers HTTP 410 Gone, decommissioned 2026-03-25 | As above |
| ESA DISCOSweb | European orbital catalogue | Token. HTTP 401 JSON:API error envelope | As above. **There is no keyless agency catalogue in Europe** |
| BarentsWatch live AIS | Norwegian vessel positions | Credentials. HTTP 401, and the old open historic path is a 404 | **Kystdatahuset**, which serves the same Norwegian data keylessly |
| Equasis, IMO GISIS, AMSA Ship Tracking Service | Vessel registry and ownership | Accounts and login forms. AMSA's host answers HTTP 200 with an email and password form, which reads as a working endpoint | Fintraffic port-call vessel details, USCG PSIX, Wikidata |

**A free key is still a key, and so is a shared demo key.** That is the whole rule and it is
what puts `DEMO_KEY`, aisstream's free tier, KeepTrack's free tier and the Cesium ion community
tier in the same bucket as a paid RapidAPI subscription. The point of the constraint is that
`uv run tracker` plus a browser is the whole deployment, with nothing to register for and
nothing to rotate.

**Three sources are keyless and still out, and the reason is a stated directive rather than a
credential.** They are recorded here so nobody reads "keyless" as "usable": aiscatcher.org
(`robots.txt` disallows every data path by name, names `ClaudeBot` specifically, and the API
sits behind a Cloudflare Turnstile human challenge), RealEarth (`Disallow: /api/`, and product
and timestamp discovery are both under `/api/`), and DWD's GeoServer (`Disallow: /geoserver/`,
where the one `Allow` line meant to permit GetCapabilities is misspelt `geopserver` and so
matches nothing). `cloudscraper` is for CDN bot filters and never for a stated directive, so
there is no route in for any of the three. RealEarth and DWD belong next to R4 in
`docs/pending-decisions.md`, because both are the same class as Digitraffic's `Disallow: /api/`
and both are genuinely good: DWD's global 3km infrared world mosaic was fresher than
EUMETSAT's global composite at the same clock reading.

**Two more are keyless and out on licence.** Planet Labs' orbital ephemerides state
`CC BY-NC 4.0` verbatim on the page, and Esri's World Imagery and World Elevation 3D are
governed by the Esri Master License Agreement (E204, 1 August 2025), whose section 3.3(b)
prohibits using the data "for the purpose of compiling, enhancing, verifying, supplementing,
adding to, or deleting from compilation of information that is sold, rented, published,
furnished, or in any manner provided to a third party". That describes this project's purpose.
Section 3.2(a) restricts use to Esri products and 3.2(c) forbids storing the data at all, which
rules out the disk cache this project requires of every source. Both are keyless, verified
working and unusable. Do not cache a single tile of either.

## Planned, NOT YET VERIFIED

None of these has been called from this project. Each is a phase deliverable, and each must
be called and moved into the verified table before any code depends on its shape.

| Source | Purpose | Phase | Auth | Known constraints | Licence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| aisstream.io | Live ship positions over WebSocket | 2 | **OUT OF SCOPE under the keyless rule, 2026-08-20.** Free API key | **Handshake verified, shape not.** `wss://stream.aisstream.io/v0/stream` answered `HTTP/1.1 101 Switching Protocols` with **no credentials at all** on 2026-08-19: authentication is in the first application message, not the handshake. With a bogus key, an empty key and no key field the server closed the raw TCP socket after about 0.5s with **zero bytes, no close frame, no close code and no error text**, so "bad key" is indistinguishable from a dropped network. The documented `{"error":"Api Key Is Not Valid"}` does not arrive. Subscribe must be sent within 3 seconds. `BoundingBoxes` is **`[latitude, longitude]`**, the opposite of our rule. A global box is 300 messages a second, so subscribe to a bounded region. `/apikeys` answers 401, so key issuance is behind a login. **No wire model may be written against the documented field names.** Beta, no SLA, key must never reach the browser | Provider terms. No licence grant, no redistribution grant and no attribution string found. `robots.txt` carries only Cloudflare boilerplate with no directives | HANDSHAKE VERIFIED, SHAPE NOT |
| AISHub | Crowd-sourced vessel positions, worldwide | 2 | **OUT OF SCOPE under the keyless rule, 2026-08-20.** Username, granted only to contributors running a physical AIS receiver | **Once per minute, hard.** Two failure bodies, both HTTP 200, measured 2026-08-20: no `username` parameter answers **zero bytes** with `content-type: text/html`, and a bad username answers a **JSON error envelope**, `[{"ERROR":true,...,"ERROR_MESSAGE":"Invalid username or password!"}]`. Do not check the length: it was 115 bytes for `TRACKER_NO_SUCH_USER` and 105 for `NOSUCHUSER`, because the username is echoed back. Check `body[0]["ERROR"] is True` on a body that parsed. A success body is an envelope object followed by the vessel data, not a flat list. `output` defaults to XML. The over-frequent-call behaviour is still untested, and would now be indistinguishable from the no-username empty 200 | Contributor terms, no redistribution grant stated | GATE VERIFIED, SHAPE NOT |
| CelesTrak GP group query | Full-catalogue element sets for the satellite layer | 2 | None. **Superseded 2026-08-20 by ReTLEctor, which serves the identical OMM JSON contract keylessly and answers.** CelesTrak is blocking this network** | **Not called: celestrak.org was unreachable on 2026-08-20**, TCP 443 and 80 both filtered from two independent networks with `connect=0.000000`, so zero requests were served and the budget is intact. `FORMAT` defaults to CSV since 2026-05-09. Estimated 4 to 6MB per refresh for the active group. Any non-200 must stop the poller outright rather than back off. The empty or no-match response shape is undocumented and unverified | Not stated. Credit is courtesy | NOT YET VERIFIED |
| CelesTrak SATCAT | Decay date, operational status, on-orbit flag | 2 | None | `satcat/records.php`, where **`FORMAT` defaults to JSON**, unlike `gp.php`. Updates manually once or twice a day. Documentation only, no call made | Not stated | NOT YET VERIFIED |
| CelesTrak supplemental elements | Higher-accuracy element sets for named constellations | later | None | `NORAD/elements/supplemental/sup-gp.php`. **Multiple element sets can exist per object**, from multiple sources and multiple epochs, so the merge key is catalogue number plus source plus epoch rather than the number alone. Documentation only, no call made | Not stated | NOT YET VERIFIED |
| GDELT GEO 2.0 | Geolocated news coverage density | 5 | None | **Unreachable.** `https://api.gdeltproject.org/api/v2/geo/geo` answered **HTTP 404** on two attempts on 2026-08-19, with Apache's default error page, while DOC 2.0 on the same host answered 200. The URL is correct, so this is the endpoint being down. Nothing may be designed on top of it | GDELT terms, attribution required | UNREACHABLE 2026-08-19 |
| GDELT DOC 2.0 `mode=timelinevolinfo` | Coverage volume time series with sample articles | 6 | None | **Not reached:** 429 on four attempts across twelve minutes after a single successful `artlist` call. On the provider's documentation it carries the same eight article fields and no location | GDELT terms | NOT REACHED |
| Windy Webcams v3 | Owner-submitted public webcams | 5 | **OUT OF SCOPE under the keyless rule, 2026-08-20.** API key, confirmed mandatory | Answered HTTP 403 `{"message":"Missing Header 'x-windy-api-key' with API key","error":"Forbidden","statusCode":403}` on 2026-08-19, so the key gate is verified and the payload shape is not. **The gate is on a header, not a query parameter**, so the key cannot leak into a browser-visible URL but must be injected server-side on every call. **Image tokens expire after 10 minutes**, unverified from this side of the gate. Never cache an image URL beyond validity | Provider terms, non-commercial tiers exist | KEY GATE VERIFIED, SHAPE NOT |
| Flickr | Geotagged photographs with author text | 8 | **OUT OF SCOPE under the keyless rule, 2026-08-20.** Free key | **The gate is HTTP 200, not a 4xx.** No key, an empty key and a bogus key all returned 200 with `{"stat":"fail","code":100}`, so `stat` must be checked before anything else. Pass `nojsoncallback=1` or the body is wrapped in `jsonFlickrApi(...)`. Provider figures: **3,600 queries per hour per key** and a hard **4,000-result ceiling per query** with no way to page past it. `bbox` is longitude-first. Omitting `license` returns All Rights Reserved items, so the filter is mandatory here. Payload shape unverified | Per photo, and licence 0 is the default without a filter | GATE VERIFIED, SHAPE NOT |
| Companies House REST API | Officer roles and occupations, which the keyless PSC bulk does not carry | 6 | **OUT OF SCOPE under the keyless rule, 2026-08-20.** Free key. The keyless PSC bulk snapshot stays in scope | **401 verified twice with two distinct bodies:** `{"error":"Empty Authorization header"}` with no credential and `{"error":"Invalid Authorization"}` with a wrong one, so no-key-configured and wrong-key are separable and should not be collapsed. HTTP Basic with the key as username and a blank password. 600 requests per 5 minutes, **and a breach locks you out for the remainder of the five-minute window**, so the floor needs a token bucket rather than a sleep. Payload shape unverified | Open Government Licence 3.0 | GATE VERIFIED, SHAPE NOT |
| IRS bulk Form 990 XML | Real 990 trustee and officer names, the only keyless route to them | 6 | None | `https://apps.irs.gov/pub/epostcard/990/xml/{year}/{year}_TEOS_XML_{nn}.zip`. **HEAD only:** 200, `application/zip`, 71,497,607 bytes for one 2026 month, roughly 1.1GB a year. Deliberately not downloaded, so the XML shape is unverified. Carries `Form990PartVIISectionAGrp` with `PersonNm` and `TitleTxt`. A bulk local-index ingest in the same category as GeoNames, never a poller. **Its predecessor is dead**: the `irs-form-990` S3 bucket lists zero objects and any per-filing key 404s | Public domain (US Government work) | HEAD VERIFIED, SHAPE NOT |
| USCG Vessel Documentation Search bulk file | US vessel ownership, which PSIX does not carry | 5 | Unknown | **Not called.** Named because PSIX carries no owner field in any of its seven operations, so US vessel ownership has no source in this project yet | Public domain expected, unverified | NOT YET VERIFIED |
| Equasis | Vessel registry and ownership | 5 | Account | **Gate verified.** The public home page answers 200 with navigation only, every vessel record is behind the login, and the site is JavaScript-gated. **`robots.txt` answers HTTP 403**, so there is no crawl permission to read, and absence of a directive is not permission. Registration is free but it is an account we would have to hold and honour terms under, which puts it in the same bucket as AISHub: no software route in | Provider terms | GATE VERIFIED, SHAPE NOT |
| IMO GISIS | Ship particulars | 5 | IMO public-user account | **Not called.** Same account class as Equasis, and two keyless registries already answer the phase 5 question | Provider terms | NOT YET VERIFIED |
| Terrascope WMTS | Sentinel-2 basemap option | 7 | None expected. **Re-tested 2026-08-20, unchanged: leave as NOT REACHED and stop retrying it** | **Not reached, and diagnosed rather than assumed.** DNS resolves, TCP 443 is open, TLS completes with a valid certificate, and the host **resets the connection after the request is written**, on HTTP/2 and HTTP/1.1, with a Chrome User-Agent, over IPv4, and on `/robots.txt`. So this is application-layer blocking, not a network fault. Same class as adsb.one. Two claims that must not be written as verified: that the RESTful tile templates 400 while the key-value form works, and that the tile matrix set identifier is the literal `EPSG:3857`. For contrast, the literal `EPSG:3857` is a 404 on EOX | Not established: the capabilities document carries it and could not be fetched. The underlying data is Copernicus | NOT REACHED |
| US 511 programmes beyond New York | State traffic cameras outside NY | 8 | Varies by state | Not one API. WSDOT answered HTTP 401 without a key on 2026-08-19. Each state is its own adapter and its own row here | Per state, usually open data | NOT YET VERIFIED |
| Copernicus Data Space download | Sentinel product bytes, not just the catalogue record | 7 | **OUT OF SCOPE under the keyless rule, 2026-08-20.** OAuth token from the Copernicus identity service | Catalogue search is already verified and keyless. Only the byte download needs the account and carries the quota. A full SAFE archive is about 707MB, so it is not a browser asset | Copernicus free, full and open | NOT YET VERIFIED |
| Public live-stream webcams | Owner-published city, port and landmark streams | 8 | Varies | Owner-published only. Each stream is checked individually for a publish-to-web intent before it is used | Per stream | NOT YET VERIFIED |
| Cesium ion | OSM Buildings 3D Tiles, optional terrain | 7 | **OUT OF SCOPE under the keyless rule, 2026-08-20, and the layer should be deleted rather than replaced.** Client-side ion token | Community tier quota. Token is client-side by design | **Non-commercial community tier, paid past $50k organisation revenue** | NOT YET VERIFIED |
| Bluesky (`public.api.bsky.app`) | Social posts, text only | 8 | None documented | **Answered HTTP 403 from this network on 2026-08-19** for `app.bsky.feed.searchPosts` while `app.bsky.actor.getProfile` answered 200, so search is gated. Posts carry no coordinates | Per-post | NOT YET VERIFIED |

---

## Licence audit

Read this before anyone says the word "launch".

**The project is not currently licensed for commercial deployment.** Eleven sources block it
now rather than eight. Items 1 to 8 were read on 2026-08-19 and items 9 to 11 on 2026-08-20.
Item 9 is the sharpest of the three, because it is the only source that closes a measured
hole in a layer.

1. **adsb.fi is non-commercial use only.** It is the aircraft failover, so commercial use
   means either dropping the failover (and accepting that an adsb.lol HTTP 420 takes the
   military layer down, which has already happened once) or replacing it with a
   commercially licensed readsb v2 provider. The adapter makes that a base-URL change, and
   that is exactly why the provider-swap interface exists. See ADR 003.
2. **Cesium ion's community tier is non-commercial**, and flips to paid past $50,000 of
   organisation revenue. This one is closed rather than contained, as of 2026-08-20: nothing
   in the product reaches ion, there is no setting to put a token in, and the demo token
   Cesium 1.144 bundles is blanked in the browser at `frontend/src/globe/viewer.ts`. The
   buildings capability that used to ask for a token is deleted.
3. **EOX Sentinel-2 cloudless is CC BY-NC-SA 4.0 on 2018 through 2025**, corrected 2026-08-19
   from "CC BY-NC on the newer mosaics". ShareAlike is the harder clause and it covers eight of
   the ten mosaic years: only 2016 and 2017 are CC BY 4.0. EOX's own licence page names "Web
   services and commercial dashboards" as requiring a paid EOX Commercial
   Attribution-RestrictedUse 1.2 licence, and that is what this demo is. Contained, because it
   is one option in an imagery picker whose default is NASA GIBS, but the contained position
   means defaulting to GIBS rather than treating EOX as usable.
4. **adsbdb's flight-route data may not be published, copied or stored.** The provider's README
   states it "may not be copied, published, or incorporated into other databases without the
   explicit permission of David J Taylor, Edinburgh". Serving an origin-destination pair to a
   browser is publishing it and storing it in our SQLite file is incorporating it. **This blocks
   the route pair ADR 012 wants for occupancy reasoning**, and it needs written permission from
   a named individual rather than a corporate licence conversation. The aircraft half of the
   same API has **no licence at all** and is credited to PlaneBase, a commercial database, with
   no redistribution grant, so it is unlicensed rather than prohibited, which is a different
   problem and not a smaller one.
5. **Transport Canada CCARCS forbids exactly what phase 5 wants it for.** Clause 3.1(d) of the
   Government of Canada Open Data Licence: "you shall not merge or link the data made available
   through the GC Open Data Portal with any product or database for the purpose of identifying
   an individual, family or household". Joining a CCARCS owner name to a person profile is that
   join, and it is the only reason the register is in the plan. **CCARCS is usable for aircraft
   attributes and prohibited for the owner-to-profile join.** Clause 3.1(c) also requires any
   distribution to be evidenced by a written agreement, which does not fit a public web product.
6. **ITU MARS is non-commercial only.** ITU terms permit "personal, educational, or
   non-commercial purposes" and prohibit distribution or commercial use "without obtaining prior
   written permission from ITU". Serving MARS fields into a browser in a commercial product is
   distribution. The mitigation exists and is cheap: **Fintraffic port-call vessel details plus
   Wikidata P587 plus a locally cached ITU MID table give everything MARS gives and more, under
   CC BY 4.0 and CC0.** MARS is the fallback for global superyacht coverage that Fintraffic does
   not have, so hold it behind a flag until someone has written ITU permission.
7. **ProPublica bars redistribution and charging.** Verbatim: "You can't republish the raw data
   in its entirety or otherwise distribute the data (in whole or in part) on a stand-alone
   basis" and "You can't charge people money to look at the data or sell advertising
   specifically against it." Serving a foundation's assets to a browser as a card is arguably
   distributing part of the data on a stand-alone basis. This belongs here rather than in the
   unresolved pile, and it is moot for the trustee half of the plan because **ProPublica carries
   no person names at all**.
8. **InsightFace face-recognition weights are barred by their own terms**: "ALL models are
   available for non-commercial research purposes only." That rules out `buffalo_l`,
   `w600k_r50`, `w600k_mbf`, SCRFD and every mirror of them for phase 14. The permissive route
   exists (ONNX Model Zoo ArcFace, Apache 2.0, plus YuNet, MIT) at 66MB rather than the 4MB
   MobileFaceNet everyone reaches for.

**Three licence positions added on 2026-08-20, and one of them gates a layer outright.**

9. **EUMETView's licence is not established, and it is the only source that closes the cloud
   layer's 58-degree hole over Europe, Africa and the Middle East.** The service declares
   `Fees: none` and `AccessConstraints: none`, which is machine-readable and verified, and every
   human-readable page is unreadable: `/eumetsat-data-licensing` answers 200 with a JavaScript
   shell, `/copyright-notice` and `/our-satellites/data-policy` are 404, and the data-policy PDF
   is 404. No licence name, no attribution string, no redistribution position, and no
   `<Attribution>` on any satellite layer. Under this file's own rule the GIBS half of the cloud
   layer ships and the EUMETView half waits. **The consequence is a measured hole in the layer,
   not a footnote**, and the layer rail has to say so.
10. **Esri is keyless, verified working and unusable, and the block is threefold.** The Esri
    Master License Agreement (E204, 1 August 2025) section 3.2(a) restricts use to Esri products,
    so a CesiumJS globe is out; 3.2(c) says "Customer may not otherwise scrape, download, or
    store Data", which rules out the disk cache this project requires of every source; and 3.3(b)
    prohibits use "for the purpose of compiling, enhancing, verifying, supplementing, adding to,
    or deleting from compilation of information that is sold, rented, published, furnished, or in
    any manner provided to a third party", which describes this project's purpose almost word for
    word. This one is worth naming loudly because **Esri World Imagery was the fastest and
    sharpest imagery measured by a distance** (mean 0.030s per tile, real imagery at zoom 19, 24
    zoom levels) and Esri Terrain 3D is the only keyless global terrain Cesium reads natively.
    Two hunts on 2026-08-20 reached opposite conclusions about it: the imagery hunt read the
    Master Agreement text and ruled it out, the Cesium hunt recommended it as a base-layer
    fallback having read only the ArcGIS Online item record. **The Master Agreement wins.** Do not
    build it and do not cache a single tile.
11. **Planet Labs' orbital ephemerides are CC BY-NC 4.0**, stated verbatim on the page:
    "Orbital ephemerides data provided hereunder is licensed under CC BY-NC 4.0." Non-commercial
    only, so out on the same reasoning that bars adsb.fi and the InsightFace weights. It was the
    best independent operator-grade orbital source found. Do not fetch it again.

**Three licence positions improved on 2026-08-20.** **SatNOGS DB is CC BY-SA 4.0**, which is the
cleanest orbital licence available and the first orbital source in this project with a stated
licence at all, though ShareAlike binds a derived database the same way ODbL does.
**Kystdatahuset is the same NLOD already cleared for Kystverket**, so the vessel layer's
biggest coverage gain carries no new licence work. Corrected 2026-08-23: the **version** is
NLOD **1.0** on this API, not 2.0. The endpoint's own OpenAPI document names 1.0 and links
`data.norge.no/nlod/en/1.0`. Both texts were read the same day and both grant copying, use and
distribution provided the contributor is acknowledged, so the obligation is unchanged and the
one Kystverket credit still covers both endpoints. Only the version string was wrong. And **CelesTrak's absence stops being a
licence question**: what replaces it is a cache with no stated licence over data with no stated
licence, which is exactly where we already were.

**Camera restreaming is its own question, and it is not the same as proxying a JPEG.** TfL
JamCams are stills on S3 under TfL open data with a mandatory credit string, and proxying and
caching a still is ordinary use. New York 511 is live HLS on a state video host, and pulling
that through our proxy so a browser can play it is restreaming a third party's video. The
answer is probably fine under NYSDOT open data terms and it has not been read yet. Read it
before the camera layer ships publicly, not after.

**Copernicus imagery is free, full and open, with attribution that has to say it was
modified.** Any scene we cloud-filter, tile-cut or composite is modified Copernicus Sentinel
data and the credit line has to say so with the year.

Clean for commercial use as far as their own terms go, with attribution honoured:
adsb.lol (ODbL 1.0), USGS (public domain), NASA GIBS and EONET, Wikidata (CC0), Wikipedia
(**CC BY-SA 3.0 and GFDL** per the REST API's own declaration, corrected 2026-08-19 from
CC BY-SA 4.0, which is the site-wide wiki licence rather than the one binding an API consumer).
ODbL carries share-alike obligations on derived databases, so anything that redistributes an
aggregated store of adsb.lol data needs a licence read of its own, not just an attribution line.

Also clean, with their credit conditions honoured: GeoNames (CC BY 4.0), OpenStreetMap
notes (ODbL, same share-alike caveat as any OSM data).

Newly verified and clean for commercial use, with attribution honoured, all 2026-08-19:
**Fintraffic Digitraffic** on all four endpoints (CC BY 4.0, commercial use named explicitly in
the provider's terms), **Kystverket** (NLOD 2.0, which grants copying, distribution and
modification worldwide and perpetually, with two caveats: the licence may not be sub-licensed or
transferred, and it does not cover information containing personal data under the Norwegian
Personal Data Act without a legitimate basis), **CASA** (CC BY 4.0, the only aviation register
here that permits commercial redistribution outright), **Companies House** on both the API and
the PSC bulk snapshot (Open Government Licence 3.0), and the US Government works: **SEC EDGAR**,
**FEC OpenFEC**, **USCG PSIX**, the **FAA Releasable Aircraft Database** and the **IRS bulk 990
XML**, all public domain under 17 U.S.C. 105.

Model weights, verified 2026-08-19: **Apache 2.0** for the MiniLM sentence embedder and the ONNX
Model Zoo ArcFace, **MIT** for YuNet and the Qdrant CLIP exports. **Three of the six repos
declare no licence at all** (`Xenova/clip-vit-base-patch32`, `onnx-community/whisper-small`, and
both `arcface-onnx` mirrors), so "record the licence" cannot be satisfied by reading the card for
those. That is an argument for the Qdrant CLIP repos and the model-zoo ArcFace on licence grounds
alone, independent of quality.

**CelesTrak's attribution requirement does not exist**, corrected 2026-08-19. The usage policy,
the GP data formats page, the SupGP page, the SATCAT format page and the home page carry no
attribution, copyright, citation or credit requirement of any kind. The only stated obligation is
the request rate. We credit them as courtesy, like USGS.

**One licence position moved the wrong way.** `mas.to/robots.txt` carries
`Content-Signal: ai-train=no` as an express reservation of rights under Article 4 of EU Directive
2019/790. The ADR 014 and ADR 015 work runs local models over post content rather than training
on it, which lands on the unsignalled `ai-input` side, so it is defensible. It is also
machine-readable, per instance and can change without notice, so the signal has to be read on
each instance rather than assumed.

**ADS-B Exchange prohibits redistribution without written permission**, and this app serves
positions to browsers, which is redistribution. It is now a named provider (ADR 010), so this
is a live blocker on the aircraft layer rather than a note about an optional extra. Two ways
through: written permission from the provider, or the internal JETNET route, since JETNET has
owned ADS-B Exchange since 2023 and Altrata licenses JetNet. Settle it before the layer ships
publicly, not after.

Unresolved and needing a read before they ship: aisstream.io (beta, no licence grant, no
redistribution grant and no attribution string found at all), Windy (tier-dependent), GDELT,
Terrascope (the capabilities document carries the terms and cannot be fetched), airplanes.live
(terms come with the access grant), **AISHub**. adsbdb, ITU MARS and ProPublica have moved out
of this list and into the blockers above, because a read has now happened and each one says no. AISHub says contributors may use the aggregated data for free,
which is a use grant and not a redistribution grant, and this app serves positions to
browsers. Same question as ADS-B Exchange, and it needs asking before the vessel layer ships
publicly rather than after.

**Per-item licensing is its own category.** Wikimedia Commons, Mastodon and Flickr license
each record separately, so there is no source-level answer. A Commons file may be public
domain or CC BY-SA; a Flickr photo may be all rights reserved. The rule is that the item's
own licence and author travel with the record through the domain contract and are rendered
on the card, and any item whose licence cannot be determined is dropped rather than shown.
Flickr in particular needs its licence filter set before a commercial deployment, not
after.

## Attribution

Every visible layer renders its credit. These strings are served from the API rather than
hardcoded in the frontend, at `src/tracker/app.py:51`, so a new source cannot ship without
one.

**Where they render, since 2026-08-20.** Twelve credits with their licence fields was a
970x215 pixel panel across the bottom of the globe, and several licence fields are whole
sentences rather than a short name. So they live behind a control: a 44px round "i" pinned
bottom left, always on screen, one click from every view, opening the full list on its own
opaque panel (`frontend/src/ui/attribution.ts`). Specified in that form by Alexander Fanthome
on 2026-08-20. The list is the API's own, rendered whole and **matched to nothing**, so a
source the backend adds reaches the screen whether or not the frontend recognises its name.

The layer rail no longer renders credits at all. It used to match them to layers and list the
leftovers underneath, which was two lines under every row plus a line under the rail, and the
match could silently fail. The control above is the stronger guarantee. The rail keeps the
attribution list for one thing only: spelling a provider slug the way its own credit does,
`aishub` as `AISHub`.

Cesium keeps its own credit line, at the very bottom left, indented clear of the control
rather than underneath it. It credits the imagery provider it is handed, and the NASA GIBS
string it gets is the same exported constant the control's baseline uses
(`frontend/src/ui/attribution.ts`, imported by `frontend/src/globe/viewer.ts`), so the two
cannot drift into contradicting each other. A test asserts it.

What a control does not satisfy is a licence requiring the credit to be visible with no
interaction at all. Nothing in the table below states that. If a source ever does, that one
belongs on screen rather than in here.

Currently served, verbatim:

| Source | Credit string | Licence field |
| --- | --- | --- |
| adsb.lol | `Aircraft data from adsb.lol` | `ODbL 1.0` |
| adsb.fi | `Aircraft failover data from adsb.fi` | `Non-commercial use` |
| NASA GIBS | `Imagery courtesy of NASA EOSDIS GIBS` | `Public domain, attribution requested` |

Required for the planned sources, to be added with the code that uses them:

| Source | Required credit |
| --- | --- |
| ADS-B Exchange | `Aircraft data from ADS-B Exchange` |
| airplanes.live | `Aircraft data from airplanes.live` |
| AISHub | `Vessel data from AISHub` |
| CelesTrak | `Orbital elements from CelesTrak` |
| USGS | `Earthquake data from the U.S. Geological Survey` |
| NASA EONET | `Natural event data from NASA EONET` |
| OpenStreetMap (Nominatim, Overpass) | `Map data © OpenStreetMap contributors` under ODbL |
| Wikidata | `Data from Wikidata, CC0` |
| Wikipedia | `Text from Wikipedia, CC BY-SA 4.0`, with a link to the article |
| TfL | `Powered by TfL Open Data` (this exact wording is a condition of the licence) |
| Windy | `Webcams provided by Windy.com` |
| GDELT | `News coverage data from the GDELT Project` |
| Cesium ion | Cesium ion and the underlying OSM Buildings credit, rendered by Cesium's own credit display |
| EOX | `Sentinel-2 cloudless by EOX IT Services GmbH` with the mosaic year and its CC licence |
| Copernicus / Sentinel-2 | `Contains modified Copernicus Sentinel data [year]` |
| TfL | `Powered by TfL Open Data` |
| New York 511 | `Camera imagery courtesy of NYSDOT 511NY` |
| GeoNames | `City data from GeoNames, CC BY 4.0` |
| OpenStreetMap notes | `Map notes © OpenStreetMap contributors` under ODbL |
| Wikimedia Commons | Per file: the file's own licence, its author and a link to the file page |
| Mastodon | Per post: the instance domain, the author handle and a link to the original post |
| Flickr | Per photo: the photographer, the photo's own licence and a link to the photo page |

Required for the sources verified on 2026-08-19, with the licence field each one renders:

| Source | Required credit | Licence field |
| --- | --- | --- |
| Fintraffic Digitraffic | `Source: Fintraffic / digitraffic.fi, license CC 4.0 BY` (**the provider's exact wording, from their terms of service. Do not paraphrase it**) | `CC BY 4.0` |
| Kystverket | `Vessel data from Kystverket (Norwegian Coastal Administration)` with a link to the NLOD **1.0** licence at `https://data.norge.no/nlod/en/1.0`. NLOD makes acknowledgement mandatory but does not prescribe a string, so this wording is ours. **Corrected 2026-08-24: this row said 2.0 and linked 2.0, contradicting the Kystdatahuset row in this same file and the running app.** The endpoint's own OpenAPI document names 1.0, and the live credit serves `NLOD 1.0` with the 1.0 URL, so the code was right and this table was stale. The raw TCP AIS socket is separately documented as 2.0, which is Kystverket's own inconsistency rather than ours; the vessel layer credits the endpoint it actually reads | `NLOD 1.0` |
| adsbdb | `Aircraft data from adsbdb, sourced from PlaneBase` | `No licence stated. Route data prohibited from republication` |
| FAA | `Aircraft registration data from the FAA Releasable Aircraft Database` | `Public domain (US Government work)` |
| Transport Canada CCARCS | `Reproduced and distributed with the permission of the Government of Canada.` and `This product has been produced by or for Altrata and includes data provided by the Government of Canada. The incorporation of data sourced from the Government of Canada within this product shall not be construed as constituting an endorsement by the Government of Canada of our product.` (**both strings are mandatory under clauses 4.1 and 4.2 and are quoted verbatim**) | `Government of Canada Open Data Licence. Clause 3.1(d) forbids linking to identify an individual` |
| CASA | `Aircraft register data © Civil Aviation Safety Authority` with a link to the CC BY 4.0 licence and a statement of whether the material was changed (**all three are licence conditions, and the credit must not suggest CASA endorses us**) | `CC BY 4.0` |
| ITU MARS and the ITU MID table | `Vessel station data from the ITU MARS database` with a source acknowledgement | `ITU terms: non-commercial only, distribution needs prior written ITU permission` |
| USCG PSIX | `Vessel data from the U.S. Coast Guard Port State Information Exchange` | `Public domain (US Government work)` |
| SEC EDGAR | `Filing data from the U.S. Securities and Exchange Commission (EDGAR)` | `Public domain (US Government work)` |
| ProPublica Nonprofit Explorer | `Nonprofit financial data from ProPublica` (**citation is required for any publication use**) | `ProPublica Data Store terms. No redistribution on a stand-alone basis, no charging for access` |
| Companies House | `Contains public sector information licensed under the Open Government Licence v3.0` | `Open Government Licence 3.0` |
| FEC OpenFEC | `Campaign finance data from the U.S. Federal Election Commission` | `Public domain (US Government work)` |
| IRS bulk Form 990 XML | `Nonprofit filing data from the Internal Revenue Service` | `Public domain (US Government work)` |
| Nominatim | `Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright` (**the upstream string, carried on every record in its own `licence` field. Render that rather than a hand-written line**) | `ODbL 1.0` |
| Overpass | `The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.` (**self-declared in the response body at `osm3s.copyright`**) | `ODbL 1.0` |
| Wikipedia REST and geosearch | `Text from Wikipedia, CC BY-SA 3.0 and GFDL`, with a link to the article. Geosearch returns no URL, so the link is built as `https://en.wikipedia.org/?curid={pageid}` | `CC BY-SA 3.0 and GFDL` (the API's own declaration, not the site-wide 4.0) |
| Wikimedia Commons imageinfo | Per file, assembled from the record: `LicenseShortName`, `Artist`, any `Attribution` value **used verbatim** where the uploader set one, and a link to `descriptionurl` | Per file, from `extmetadata.License` |
| EOX Sentinel-2 cloudless | `Sentinel-2 cloudless by EOX IT Services GmbH` with the mosaic year, **rendered as links** to `http://www.openstreetmap.org/copyright`, `https://maps.eox.at/#data` and `https://eox.at`, per the service's own `ows:AccessConstraints` | `CC BY 4.0` on 2016 and 2017, `CC BY-NC-SA 4.0` on 2018 to 2025 |
| TfL | Three strings, all mandatory, none paraphrased: `Powered by TfL Open Data`, `Contains OS data © Crown copyright and database rights 2016`, `Geomni UK Map data © and database rights [2019]` | `TfL open data` |
| GeoNames | `City data from GeoNames, CC BY 4.0` **with a link to the source and a link to the licence**, because CC BY attribution requires both and the bare text is thin on its own | `CC BY 4.0` |
| Local ONNX model weights | Not rendered on a card: the model artefact and its version are recorded on every embedding, per ADR 015 | `Apache 2.0` (MiniLM, model-zoo ArcFace), `MIT` (YuNet, Qdrant CLIP), **`None declared`** (Xenova CLIP, onnx-community Whisper) |

Required for the keyless sources verified on 2026-08-20, with the licence field each one
renders. **A row here whose licence is not established does not ship**, because a layer cannot
render without a credit and a credit cannot be invented.

| Source | Required credit | Licence field |
| --- | --- | --- |
| Kystdatahuset (Kystverket) | `Vessel data from Kystverket (Norwegian Coastal Administration)` with a link to the licence. **The credit string is served exactly as written here**, in `sources/kystdatahuset.py` and on `/api/attributions`, verified 2026-08-23. The same string already required for the raw TCP stream: **one Kystverket credit covers both endpoints**, because it is one authority and one licence. NLOD makes acknowledgement mandatory but prescribes no wording, so this is ours. **The licence link is `https://data.norge.no/nlod/en/1.0`, corrected 2026-08-23**: the API's own OpenAPI document names version 1.0, this file had recorded 2.0, and both texts require the same acknowledgement | `NLOD 1.0` |
| Transpordiamet (Estonia) | `Vessel data from Transpordiamet (Estonian Transport Administration)`. **No licence is stated on the service at all**: `copyrightText` is an empty string, there is no terms page and `robots.txt` is a 404. So this is courtesy, not a condition, and it is served as such | `Not stated by the provider; credit is courtesy` |
| Great Lakes St. Lawrence Seaway VIS | `Vessel data from the Great Lakes St. Lawrence Seaway Vessel Information System`. No terms page on either host and no licence field in the response. Courtesy, and the credit names the system rather than one of the two corporations that jointly run it, because crediting one would be wrong half the time | `Not stated by the provider; credit is courtesy` |
| ReTLEctor | `Orbital elements from CelesTrak, served via the ReTLEctor cache` . Neither party states an attribution requirement, so this is courtesy on both halves and it names the cache because that is who we actually called | `None stated. CelesTrak data, MIT code` |
| astrion-tech CelesTrak mirror | `Orbital elements from CelesTrak` . The repository declares no licence at all and asks consumers to respect CelesTrak's terms, so the credit goes to the origin rather than the mirror | `None declared` |
| SatNOGS DB | `Orbital elements from SatNOGS DB, CC BY-SA 4.0` **with a link to the source and a link to the licence**, because CC BY attribution requires both. **ShareAlike binds any derived database**, so this needs a licence read of its own before an aggregated store of it is redistributed, the same caveat that already applies to ODbL | `CC BY-SA 4.0` |
| AMSAT | `Amateur satellite elements from AMSAT` . No licence is stated anywhere on the file, the directory index or the page, so this is courtesy | `None stated` |
| NASA SSCWeb | `Spacecraft positions from NASA SSCWeb` | `NASA open data, acknowledgement requested` |
| SpaceX Starlink ephemerides | `Starlink ephemerides from SpaceX` | `None stated` |
| Mike McCants element sets | `Classified-object elements from Mike McCants` | `None stated` |
| tle.ivanstanojevic.me, wheretheiss.at, open-notify.org | `Orbital data from {host}` , named per host because none of the three states a licence and none is an independent origin | `None stated` |
| NASA GIBS geostationary, HLS and Blue Marble layers | `Imagery courtesy of NASA EOSDIS GIBS` , the string already served. **One credit covers every GIBS layer**, so the new layers add no new string | `Public domain, attribution requested` |
| EUMETView | **NOT ESTABLISHED, and there is nothing to render.** The service carries no `<Attribution>`, no `<MetadataURL>` and an empty `<ContactInformation>`, and every human-readable licence page is a JavaScript shell or a 404. **This layer does not ship until a static EUMETSAT data-policy document is in hand.** Do not invent a credit string for it | `Not established` |
| NOAA STAR NESDIS CDN | `Full-disk imagery from NOAA STAR` . NOAA is a US federal government work so public domain by default, but no explicit statement was found on the CDN, so the position is unstated rather than confirmed | `Unstated. NOAA, expected public domain` |
| JMA Himawari tiles | **Not established.** Nothing on the host states a licence and `robots.txt` is a 404 HTML page. Do not ship the layer without reading JMA's terms | `Not established` |
| CIRA SLIDER | **Not established.** No licence statement found. Not built in any case | `Not established` |
| Microsoft Planetary Computer | `Contains modified Copernicus Sentinel data [year]` , which is mandatory for any scene we cloud-filter, tile-cut or composite, plus `Hosted by Microsoft Planetary Computer` . The collection declares `license: proprietary` with a link to the ESA Sentinel Data Terms, and ESA is named as producer and licensor | `Copernicus free, full and open. Attribution mandatory` |
| USGS LandsatLook | `Landsat data courtesy of the U.S. Geological Survey` | `USGS Landsat Data Policy, public domain` |
| AWS Open Data Terrain Tiles | **Thirteen strings, not one**, per `tilezen/joerd/docs/attribution.md`, and several are fixed wording: `SRTM data courtesy of the U.S. Geological Survey` , `DOC/NOAA/NESDIS/NCEI > National Centers for Environmental Information` , `(c) Kartverket` , `Source: INEGI, Continental relief, 2016` , plus 3DEP, GMTED2010, LINZ (CC-BY-3.0-NZ), UK LIDAR (OGL v3), Austria (CC-BY-3.0-AT), ArcticDEM, EU-DEM (Copernicus), Canada CDEM (OGL) and Geoscience Australia (CC-BY-4.0). A thirteen-line credit block for a feature this product does not need | `Open, per-dataset attribution mandatory` |
| Natural Earth II, bundled in the `cesium` package | `Basemap from Natural Earth, public domain` . **The Cesium provider returns a null credit**, so one has to be added explicitly or the layer renders uncredited, which breaks this project's own rule by omission | `Public domain` |
| CARTO raster basemaps | Two strings: `Map data (c) OpenStreetMap contributors` under ODbL, and `Basemap (c) CARTO` | `ODbL 1.0 plus CARTO terms` |
| Esri World Imagery and World Elevation 3D | **Recorded and not shipped.** Required credit if it ever were: `Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community` for imagery and `Sources: Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, GEBCO, N Robinson, NCEAS, NLS, OS, NMA, Geodatastyrelsen and the GIS User Community` for terrain, and attribution on World Imagery is a **live per-tile lookup** against `static.arcgis.com/attribution/World_Imagery` with per-contributor bounding boxes, so one credit string does not cover it. Blocked by the Esri Master License Agreement regardless | `Esri Master License Agreement. Not an open licence` |
| CesiumJS itself | **No credit and no logo required.** Apache-2.0, and the ion logo Cesium draws by default credits a service this product does not use | `Apache-2.0` |

Two rules that fall out of the 2026-08-20 additions. **One authority, one credit**: Kystverket
gets one string across the TCP stream and the HTTP endpoint, and GIBS gets one string across
every layer, because a credit names who the data came from rather than which URL we hit.
And **credit the origin, not the cache**: ReTLEctor and the astrion mirror both serve CelesTrak's
element sets, so the credit names CelesTrak and mentions the cache we actually called. Reading a
mirror does not make the mirror the source.

Four rules that sit alongside the strings. Wikipedia's CC BY-SA needs a link to the source
article, not just the word "Wikipedia". TfL's wording is fixed by their terms and must not
be paraphrased, and the TfL credit is three strings rather than one. Commons, Mastodon and
Flickr are licensed per item rather than per source, so their credit is assembled from the
record and a card cannot render without it. GeoNames is CC BY, so its credit is a condition and
not a courtesy.

Two more, added 2026-08-19. **Fintraffic's wording is fixed by their terms of service and is
reproduced exactly**, the same treatment TfL gets. And **an attribution that has to be a link is
not satisfied by text**: EOX names three specific URLs in its own access constraints, CC BY
wants a link to the source and a link to the licence, and Wikipedia's share-alike wants a link
to the article.

### GTFS-Realtime transit vehicle positions

Buses, trams, trains and ferries. One layer, 258 feeds, 52 hosts, verified 2026-08-23 by calling
every one of them. The registry is committed data at `src/tracker/sources/gtfsrt_feeds.csv` and is
refreshed by hand, never fetched at runtime. The four endpoint rows are in the Verified table
above, alongside every other source.

Licences across the 258: Etalab 2.0 on 101, ODbL 1.0 on 46, CC-BY 4.0 on 35, CC0 1.0 on 31, NLOD
2.0 on 1, and bespoke operator terms on 44. ODbL is share-alike and serving positions to a browser
is redistribution, so those 46 carry a condition the attribution list has to satisfy.
`ATTRIBUTIONS` in `sources/gtfsrt.py` is **183 distinct credits**.

**`files.mobilitydatabase.org/robots.txt` is `Disallow: /` while `mobilitydatabase.org/robots.txt`
is `Allow: /`.** Same conflict as GeoNames and Digitraffic, recorded as R4 in
`docs/pending-decisions.md` and unratified. The catalogue is therefore a manual refresh rather than
anything on a timer. The v1 catalogue at `bit.ly/catalogs-csv`, which redirects to
`storage.googleapis.com/storage/v1/b/mdb-csv/o/sources.csv`, has no robots.txt at all and is the
fallback list at the cost of 933 fewer realtime rows.

#### What was excluded, and why

From 553 keyless active vehicle-position candidates in the catalogue, all of them called:

| Excluded | Feeds | Reason |
|:--|--:|:--|
| Network failure, 404, 403, 401, 503 | 35 | did not answer |
| HTTP 200 carrying something else | 6 | HTML, a GTFS **static** zip, protobuf text format, two JSON documents |
| Feed header over an hour old | 9 | abandoned, not quiet |
| Same feed under two URLs | 4 | byte-identical bodies |
| `bct.tmix.se` (BC Transit) | 35 | its `robots.txt` is `Disallow: /`, which binds |
| New York MTA | 9 | licence is a Data Feed Agreement you accept |
| No licence recorded anywhere | 184 | this project does not show what it cannot licence |
| Licence URL is an acceptance agreement | 7 | MBTA, Port Authority of Allegheny County, Denver RTD, Edmonton, CATA, Emery Go-Round |

MBTA is worth its own line. `mass.gov` answers **HTTP 403 host-wide to a descriptive User-Agent,
including on `robots.txt` itself**, so the MassDOT Developers License Agreement its data is governed
by cannot be read at all. A licence that cannot be read is a licence that cannot be determined.

#### Coverage, measured rather than claimed

The catalogue holds a vehicle-position row for **29 countries** including keyed and deprecated ones,
**23** with a keyless active one, and **17** survive the licence rule. Two of the 29 are wrong:
`CG` (Congo) is `opendata.samtrafiken.se`, which is Dalarna in Sweden, and `OM` (Oman) is
`app.mwasalat.om`, which refuses TCP entirely and is correctly marked deprecated.

**Latin America, Africa, the Middle East, India and China publish no keyless GTFS-Realtime vehicle
positions at all.** This is not a licensing problem in those regions, it is an absence. The same
catalogue lists **static** GTFS for 27 of them, Turkey 24 feeds, India 20, Brazil 15, Mexico 13,
Chile 11, Thailand 10. Schedules exist, live positions do not.

Live vehicle positions do exist there in other formats, and neither can ship:

| Source | Endpoint | Auth | Format | Position | Last verified |
|:--|:--|:--|:--|:--|:--|
| Rio de Janeiro BRT | `dados.mobilidade.rio/gps/brt` | none | JSON, 275,020 B, not GTFS-RT | **no licence established**; also carries `placa`, a licence plate | 2026-08-23 |
| Israel, Open Bus Stride | `open-bus-stride-api.hasadna.org.il` | none | JSON SIRI, not GTFS-RT | code is MIT, **the data carries no licence or terms** | 2026-08-23 |

Neither host serves a `robots.txt` (both 404), so there is no directive on either. Both fail the
same rule: a licence that cannot be determined means the feed does not ship. The Rio feed would also
need the licence plate dropped at the wire layer, since this project holds a people layer and an
entity resolver and a plate resolves to a registered keeper.

#### The count moves with the hour, so the layer reports what it measured

Four sweeps of all 553 candidates on 2026-08-23, same code, same 16 concurrent workers:

| Sweep | Time | Feeds carrying vehicles | Vehicles |
|:--|:--|--:|--:|
| A | 10:21 UTC | 247 | 16,535 |
| B | 10:31 UTC | 248 | 17,254 |
| C | 11:56 UTC | 258 | 18,476 |
| D | 16:50 UTC | 293 | 20,349 |

**A to D is +23% on vehicles and +46 feeds, and it is entirely the clock.** United States 2,391 to
6,039, Canada 367 to 1,542, Ukraine 422 to 838. Going the other way, Japan 518 to 2 and Australia
487 to 0, both asleep by 16:50 UTC.

**93 feeds that carried nothing at 10:21 UTC were carrying vehicles at 16:50**: 67 in the United
States, 23 in Canada, 3 in France. An empty feed is not a dead feed, and 261 of the 265 empty ones
at 10:21 had a header timestamp under five minutes old. Nothing in this layer may be dismissed for
being empty; only the feed's own header timestamp says whether it is alive.

The shipping registry itself, swept live at 17:08:22 UTC after the four feeds below came out:
**258 of 258 polled, zero failures, 23.3 seconds, 9,894 vehicles kept and 2,243 dropped** (1,843
older than the staleness bound, 269 at 0,0, 130 with no position, 1 repeating an entity id inside
one message), and zero merge-key collisions. In that sweep, keying on `vehicle.id` would have
collapsed 1,630 of 8,055 id-carrying records, 20.2%.

#### Correction, 2026-08-23: four more feeds excluded after reading the terms

Matching "agree" in a licence URL was not enough. Reading all 41 bespoke operator terms pages found
four more feeds gated behind an agreement the URL does not advertise, so the registry is **258
feeds, 52 hosts**, not 262.

| Feed | What the terms say |
|:--|:--|
| SEPTA (2 feeds) | "In order to download the Trip Planning Data, you are required to agree to SEPTA License Agreement", with a form. "THIS SEPTA LICENSE AGREEMENT is entered into by and between SEPTA and you (Licensee)." |
| CTtransit | "In order to download the Trip Planning Data, you are required to agree to CT transit's License Agreement and complete the following form." |
| Everett Transit (Sound Transit terms) | "By using the Data or **completing the registration required to access the data**, you agree to be bound by all of the terms." |

"By using this data you agree to these terms" is **not** a gate and does not exclude anything. That
is browsewrap, and it is how every open licence binds, NLOD 2.0 included. The distinction is whether
a person has to sign or submit something to get the bytes.

#### What each licence actually requires, read rather than assumed

`ATTRIBUTIONS` in `sources/gtfsrt.py` is **183 distinct credits** and they are not interchangeable.

| Licence | Feeds | What it requires | Verbatim wording? |
|:--|--:|:--|:--|
| CC0 1.0 | 31 | nothing; the affirmer waives attribution | no, and no credit is owed at all |
| CC-BY 4.0 | 35 | creator, copyright notice, licence notice, disclaimer notice, **URI for the licence**; "any reasonable manner" | no, but the licence link is not optional |
| ODbL 1.0 | 46 | a notice "reasonably calculated" to show the content came from the database **and that it is available under this licence** | no; a safe-harbour text is offered, not mandated |
| Etalab 2.0 | 101 | the source, "a minima le nom du Concédant", **and the date of the last update of the information reused** | no, but the **date** is required |
| NLOD 2.0 | 1 | source "as specified by the licensor" plus a reference to the licence | no |
| Bespoke operator | 44 | varies; two mandate exact words | **yes, twice** |

**How the 183 credits are served: eight rows, and the shape is driven by the obligations
rather than by the row count.** Settled 2026-08-24 after reading the licence texts. The
framing "183 is too many for a menu" was wrong: the real problem is that three of the six
licences require three different things said, so a grouping that ignored that would have been
shorter *and* non-compliant. `/api/capabilities` therefore serves:

| Field on each credit | What it is for |
| --- | --- |
| `text` | A **complete compliant sentence on its own**, so a client rendering only this is still inside every licence. Worded per licence, because the licences differ |
| `licence` and `url` | The family and its canonical text. **Mandatory under CC-BY 4.0**, which requires a licence notice and a URI, so an empty URL there would be a breach rather than a cosmetic gap |
| `operators` | The data owners this row credits, each with **its own terms URL**. This is what lets one row satisfy 39 obligations that a comma-joined string and a single link cannot |
| `as_of` | The date of the last update, **resolved per request** from the freshest record actually held for that licence |

The eight rows: six licence families plus the two verbatim mandates, which get their own rows
and are never merged into a group. 181 operator entries sit inside the six groups and cover
180 distinct operators, because **one operator publishes under two licences**: Oise Mobilité
has feeds under both Etalab 2.0 and ODbL 1.0, and since those licences require different
things said it is correctly credited in both.

What each licence forced:

- **Etalab 2.0, 101 feeds and 67 credits, the largest block.** Requires "sa source (a minima le
  nom du Concédant) **et la date de la dernière mise à jour de l'Information réutilisée**".
  Bizkaia's CTB says the same in its own terms. **This is the one that changed the data shape**:
  a static credit list cannot carry a date, so `as_of` is a field resolved at request time from
  the transit store rather than a string baked in when the registry is read. The licence asks
  about the information *being reused*, which is what is on screen, so a build-time constant
  would have described when the registry was compiled and would be wrong the moment a bus moved.
  A licence holding no records carries no date, which is correct rather than a gap.
- **ODbL 1.0, 46 feeds.** Wants a notice reasonably calculated to convey both the source **and**
  that it is available under that licence, so naming the operators alone fails it. The licence
  is in the sentence rather than only in a neighbouring field a client might not render:
  "Contains information from ..., which is made available under the Open Database License
  (ODbL) 1.0". Section 4.3's safe-harbour text is offered rather than mandated, so this follows
  its shape without quoting it.
- **operator terms, 44 feeds and 41 credits across 38 different terms pages.** Not a licence
  family, so it has **no group URL at all**: picking one would state the wrong terms for the
  other 38 operators. Each operator carries its own. Four of those URLs are plain `http`
  (Halifax, Madison, Mississauga, Votran) and are linked as published, because linking the
  terms that really bind beats rewriting a provider's own address to a scheme it may not answer
  on.
- **CC-BY 4.0, 35 feeds.** Creator, copyright notice, licence notice, disclaimer and a URI,
  satisfiable "in any reasonable manner", explicitly including a link to a resource carrying the
  required information. The grouped row with its licence URL is that resource.
- **CC0 1.0, 31 feeds and 18 credits.** The affirmer waives attribution outright, so these are
  the only credits a grouping could drop entirely. **They are kept**, and the sentence says the
  data is dedicated to the public domain. Dropping them to save a row would be the only place in
  this project where provenance was traded for space.
- **NLOD 2.0, 1 feed.** Attribution required, no wording prescribed.

Separately from the text, three licensors constrain **rendering** rather than words, and that is
the frontend's to honour: COTA, Community Transit and Duluth Transit each forbid use of their
marks in any manner likely to cause confusion or that disparages them, and COTA requires any
link to its site to open full-screen rather than in a frame.

The two mandated forms of words, carried on `TransitFeed.attribution` and used verbatim by
`TransitFeed.credit`:

- **King County Metro**: "Transit scheduling, geographic, and real-time data provided by permission
  of King County", **prominently displayed**, "unless otherwise agreed by King County in writing".
- **City of Hamilton**: "Contains public sector Data made available under the City of Hamilton's
  Open Data Licence". Hamilton also reserves the right to require its removal.

Three consequences for any grouping of the credit list. **A credit naming only the operator does not
satisfy ODbL**, which covers 46 feeds, so the licence has to appear alongside the name. **Etalab
needs a date**, which covers 101 feeds and is the requirement nobody guesses. And **the two mandated
strings cannot be folded into a grouped line at all.** Going the other way, the 31 CC0 feeds owe
nothing, so 18 of the 183 credits are courtesy rather than obligation.

Separately, COTA, Community Transit and Duluth Transit each forbid use of their marks "in any manner
that is likely to cause confusion, or in any manner that disparages or discredits" them, and COTA
requires that a link to its site "display the site full-screen and not within a frame". Those
constrain how a credit appears rather than what it says.


#### Correction, 2026-08-23: the staleness bound is a rendering bound and 900 seconds was too loose

`MAX_REPORT_AGE_SECONDS` was set to 900 from a distribution measured to answer "is this feed
alive". That is the wrong question for a position drawn on a map a viewer can check against the
street, and the two are different bounds. Whether a feed is alive is answered by its own header
timestamp, which is why 261 of 265 feeds carrying no vehicles in one sweep were working feeds with
no buses running.

Retuned to **300 seconds**, and the measurement is why it was nearly free. A live sweep gave
acceptance ages of **median 49s, p75 68s, p90 82s, p99 762s**. Only two records of 5,196 sat
between 600 and 900 seconds, so the old bound permitted a great deal while doing almost nothing.

| bound | kept of the set | unknown movement at the measured 11.9 km/h |
|:--|--:|--:|
| 60 s | 64.3% | 0.20 km |
| 120 s | 93.8% | 0.40 km |
| 180 s | 95.6% | 0.59 km |
| **300 s** | **97.1%** | **0.99 km** |
| 600 s | 98.4% | 1.98 km |
| 900 s | 100.0% | 2.98 km |

300 seconds costs **151 vehicles of 5,196, 2.9%**, and halves the distance a bus could have moved
unobserved. Below 120 seconds the curve falls off a cliff because feed publish cadences are
themselves 30 to 60 seconds, so a freshly fetched report is already that old.

**Who pays is the right set.** Over 300 seconds by country: France 22.8%, Norway 19.6%, everyone
else under 3% and most at zero. Those two are the retention-policy feeds, Entur holding a
last-known position for hours and the French aggregator behind it. Losing a last-known position is
the point rather than the cost.

**The bound must stay above the largest host floor**, or our own rate discipline manufactures
stale drops: a feed we choose to poll every 350 seconds cannot produce a report under 300 seconds
old. The largest floor governing a feed actually in the registry is 120 seconds. `passio3.com`
carries a 350-second floor and governs no feed at all, all 23 of its feeds having been dropped for
having no licence recorded. Asserted by a test.

**A count of vehicles is a count of recent reports, not of vehicles.** `FeedEntity.id` is
trip-scoped on some producers: **1,232 of 5,196 entity ids, 23.7%, contain their own trip id**, and
on Entur it is 255 of 255. A vehicle finishing a trip therefore reappears under a new key and the
finished one sits in the store until it expires, so a longer store time to live buys more dead
trips rather than more live buses. This is not an argument against the compound key, which is
measurably right at zero collisions. It is an argument that the product should not call the number
a fleet size. Entur also publishes dead runs, repositioning movements with no passengers, plainly
labelled in the id as `BOR:DeadRun:...`.

#### Correction, 2026-08-23: the coverage reason named continents and the feed contradicted it

`COVERAGE_REASON` read "Europe and North America only. No keyless feed exists for 5 regions." A
live read carried **Japan 676 and Australia 53**, so the product was telling a viewer in Tokyo
there was no coverage in Tokyo while their screen showed buses.

It now reads **"17 countries. Latin America, Africa, the Middle East, India and China publish
schedules, not positions."**, 103 characters. It names a country count rather than continents,
because the licensed set is fixed at 17 and the reporting set is always a subset of it, so the
count cannot contradict the screen the way a continent can. Three facts will not fit in 120
characters: the licensed set, the reporting set that moves by a factor of 2.7 with the clock, and
why the absent
regions are absent. The reason carries the first and the third; the second belongs beside the
vehicle count, which is the thing that moves.


#### Correction, 2026-08-24: the diurnal swing is a factor of 2.7, not 23%

The first reading took four sweeps and put the movement at 23%. **All four fell inside one
European working day**, which is the largest block of feeds in the registry, so the measurement
missed its own low point. Three more sweeps carried it through the European night.

| sweep | time | candidate set (553 feeds) | shipping registry (258 feeds) |
|:--|:--|--:|--:|
| A | 10:21 UTC | 16,535 | 8,545 |
| B | 10:31 UTC | 17,254 | 8,610 |
| C | 11:56 UTC | 18,476 | 9,125 |
| D | 16:50 UTC | **20,349** | **9,668** |
| E | 18:50 UTC | 18,556 | 8,313 |
| F | 22:33 UTC | 14,578 | 5,452 |
| G | 00:48 UTC | **10,358** | **3,629** |

**The shipping registry runs 3,629 to 9,668, a factor of 2.7.** The candidate set swings less, 96%,
because it carries more of the Asia-Pacific feeds that were dropped for having no licence
recorded. So the licence rule, which is right on its own terms, has made the layer **more**
Europe-weighted and therefore more volatile across a day, and that is a consequence worth knowing
rather than a defect.

Peak hour differs by country, which is the whole point. Across the seven sweeps: the United States
peaks at 18:50 UTC with 6,201, Australia at 22:33 with 2,360, Japan at 22:33 with 1,185, Poland at
10:21 with 1,939, France at 16:50 with 1,608. **No single sweep sees more than a fraction of the
world awake**, so any figure quoted without its timestamp is meaningless.

The honest product sentence is therefore that the count moves by a factor of about 2.7 across a
day, not by a quarter. A viewer who sees 3,600 vehicles at midnight UTC and 9,700 at teatime has
not found a bug.
