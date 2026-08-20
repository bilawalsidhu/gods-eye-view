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

Called live on 2026-08-19 with a real 200 response.

| Source | Endpoint | Auth | Cadence / rate limit | Format | Licence | Cost | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| adsb.lol | `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}` | None | No published contractual limit. We poll at 8s, floor 5s in code | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.lol | `https://api.adsb.lol/v2/mil` | None | Throttles with HTTP 420. We poll no faster than 30s and fail over to adsb.fi | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.lol | `https://api.adsb.lol/v2/type/{icao_type}` | None | Same throttling behaviour as the rest of the v2 API | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.fi | `https://opendata.adsb.fi/api/v2/mil` | None | 1 request per second, stated by the provider | JSON, readsb v2 | **Non-commercial** | Free | 2026-08-19 |
| adsb.fi | `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` | None | 1 request per second | JSON, readsb v2 | **Non-commercial** | Free | 2026-08-19 |
| CelesTrak | `https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json` | None | **Never faster than once per 2 hours per group**, stated by the provider. Any non-200 must stop the poller outright, not back off. Abusive clients are firewalled permanently | JSON, OMM mean elements (not TLE line format) | **Not stated.** No attribution, copyright or citation requirement exists on any provider page (rechecked 2026-08-20). Credit is courtesy | Free | 2026-08-19 |
| USGS | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` | None | No rate limit published. The provider's own cache is 60s (`cache-control: max-age=60`). Planned cadence 2 minutes | GeoJSON | Public domain (US Government work) | Free | 2026-08-19 |
| NASA EONET | `https://eonet.gsfc.nasa.gov/api/v3/events/geojson` | None | **`X-RateLimit-Limit: 60` is published on every response.** The bare URL is 8.5MB and 7,728 features, so narrow it with `limit`, `days` or `category` before polling | GeoJSON, served as `application/rss+xml` | NASA open data, attribution requested | Free | 2026-08-19 |
| NASA GIBS | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/` | None | Tile service, no key. Respect normal tile-client behaviour | WMTS (XML capabilities, raster tiles) | NASA open data, acknowledgement requested | Free | 2026-08-19 |
| GeoNames | `https://download.geonames.org/export/dump/cities15000.zip` | None | Bulk file, not an API. Download at most once a week | Tab-separated text in a zip | CC BY 4.0 | Free | 2026-08-19 |
| Wikidata WDQS | `https://query.wikidata.org/sparql` | None, descriptive User-Agent required | Provider states: 60-second hard query deadline, 5 parallel queries per IP, 60 seconds of processing per 60 seconds per client, 30 error queries per minute, 429 on breach. One query per user action, never per keystroke. Server-side cache | SPARQL JSON results | CC0 | Free | 2026-08-19 |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php?action=query&list=geosearch` | None, descriptive User-Agent required | **No numeric read cap is published for the action API.** MediaWiki API:Etiquette asks for serial rather than parallel requests. The 1 request per second used here is our own floor | JSON | Per-file, mostly CC BY-SA or public domain | Free | 2026-08-19 |
| OpenStreetMap notes | `https://api.openstreetmap.org/api/0.6/notes.json?bbox={w},{s},{e},{n}` | None, descriptive User-Agent required | **No provider request figure exists.** The OSMF policy says the editing API is not for read-only projects and caps download threads at 2; `robots.txt` disallows `/api/` and `/note`. 1 request per second is our own floor | JSON | ODbL 1.0 | Free | 2026-08-19 |
| ADS-B Exchange (RapidAPI) | `https://adsbexchange-com1.p.rapidapi.com/v2/...` | **Paid RapidAPI key**, or a free key as a data feeder | Per-plan request quota. Continuous polling exhausts the entry tier in about a day | JSON, readsb v2 | **Provider terms prohibit redistribution without written permission** | From $10/month, free to feeders | 2026-08-19 |
| ADS-B Exchange (globe map) | `https://globe.adsbexchange.com/data/aircraft.json`, `/re-api/` | n/a | **Do not use.** 403 by administrative rule and disallowed in `robots.txt` | n/a | n/a | n/a | 2026-08-19 |
| airplanes.live | `https://api.airplanes.live/v2/...` | Access granted by email request | Unstated until granted | JSON, readsb v2 | Provider terms, ask on request | Free | 2026-08-19 |
| adsb.one | `https://api.adsb.one/v2/...` | None documented | **Cloudflare-blocked from this network on 2026-08-19** | JSON, readsb v2 | Provider terms | Free | 2026-08-19 |
| Mastodon (`mas.to`) | `https://{instance}/api/v1/timelines/public` | None on instances that still allow it | 300 requests per 5 minutes per IP on default Mastodon config | JSON | Per-post, author's own; instance terms apply | Free | 2026-08-19 |
| GDELT DOC 2.0 | `https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=artlist&format=json&timespan={t}` | None, descriptive User-Agent required | **One request per five seconds**, stated by the provider in its own 429 body. One call bought a 429 penalty window of at least twelve minutes, so the floor is minutes not seconds. Cache per profile | JSON | GDELT terms, attribution required | Free | 2026-08-19 |
| Element 84 earth-search | `https://earth-search.aws.element84.com/v1/search` | None | No published cap, verified absent rather than quoted. One search per user action, cached server-side | STAC JSON. Assets are Cloud-Optimised GeoTIFF on S3, plus a keyless 343x343 `thumbnail` JPEG that a browser can render as-is | Copernicus free, full and open. Attribution mandatory | Free | 2026-08-19 |
| Copernicus Data Space | `https://catalogue.dataspace.copernicus.eu/odata/v1/Products` | None to search. **OAuth token to download** | Search keyless. Download quota sits on the token | OData JSON | Copernicus free, full and open | Free | 2026-08-19 |
| NASA Worldview snapshot | `https://wvs.earthdata.nasa.gov/api/v1/snapshot` | None | Renders one image per call, not a tile service. Cache per place and date | JPEG, PNG or GeoTIFF | NASA open data, acknowledgement requested | Free | 2026-08-19 |
| TfL JamCams | `https://api.tfl.gov.uk/Place/Type/JamCam` | **None.** A key raises the rate limit, it does not grant access | **500 calls per minute per data feed**, stated by TfL. Inventory is 1.1MB and is CDN-cached up to 24 hours, so refresh daily and never per view. Stills refresh on the order of minutes | JSON, stills as `image/jpeg` on S3 | TfL open data, credit string mandatory | Free | 2026-08-19 |
| New York 511 | `https://511ny.org/api/getcameras?format=json` | **None in practice, but the provider documents a key as required** and ignores the parameter rather than validating it | **10 calls per 60 seconds**, stated by the provider. 2,931 cameras in one 858KB response. Refresh the inventory on a slow cycle | JSON. Live video mostly HLS `.m3u8`, 9 records are `.mjpg` | NYSDOT open data. Restreaming needs a read | Free | 2026-08-19 |
| Fintraffic Digitraffic AIS | `https://meri.digitraffic.fi/api/ais/v1/locations` | None. `Digitraffic-User` header is requested, not required | 60 requests per minute per IP without the header, stated by the provider, 429 on excess. Provider cache is 60s, so 60s is the floor. **gzip is mandatory, HTTP 406 without it** | GeoJSON FeatureCollection with a `dataUpdatedTime` extension | CC BY 4.0, commercial use and redistribution permitted with credit | Free | 2026-08-19 |
| Fintraffic Digitraffic AIS | `https://meri.digitraffic.fi/api/ais/v1/vessels` and `/api/ais/v1/vessels/{mmsi}` | None, as above | As above | **Bare JSON array**, not a FeatureCollection. Different top-level shape from `/locations` on the same API version | CC BY 4.0 | Free | 2026-08-19 |
| Fintraffic Digitraffic AIS | `wss://meri.digitraffic.fi:443/mqtt` with `Sec-WebSocket-Protocol: mqtt` | None. CONNACK returned code 0 with no username and no password sent | **5 MQTT connections per minute per IP** without the header, stated by the provider. About 35 messages per second on `vessels-v2/#` | MQTT 3.1.1 over WSS. JSON payloads with **different field names and different units from REST** | CC BY 4.0 | Free | 2026-08-19 |
| Fintraffic Digitraffic port call | `https://meri.digitraffic.fi/api/port-call/v1/vessel-details` | None, as above | As above. gzip mandatory | Bare JSON array. Registry fields: IMO, name, callsign, nationality, port of registry, tonnage, dimensions, owner | CC BY 4.0 | Free | 2026-08-19 |
| Kystverket (Norway) AIS | `153.44.253.27` port `5631`, raw TCP, no TLS | None. The provider states access needs no registration | Broadcast stream rather than a request API, so no cap is stated. Persistent socket, not a poll | NMEA 0183 AIVDM-family sentences behind IEC 62320-1 TAG blocks | NLOD 2.0. Commercial use and redistribution permitted, attribution mandatory | Free | 2026-08-19 |
| adsbdb | `https://api.adsbdb.com/v0/aircraft/{hex_or_registration}` | None | 512 requests per minute per IP, read from the provider's own server source rather than a header. No rate-limit headers on any response | JSON in a `response` envelope | **None stated.** Aircraft data is credited to PlaneBase, a commercial database, with no redistribution grant | Free | 2026-08-19 |
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
| FEC OpenFEC | `https://api.open.fec.gov/v1/schedules/schedule_a/` | `api_key` required. `DEMO_KEY` works | **`x-ratelimit-limit: 10` observed on `DEMO_KEY`**, tighter than the 30 per hour api.data.gov documents. 1,000 per hour on a signed key. Trust the header | JSON, 81 fields per result, with a 40-field `committee` object inlined on every row | Public domain (US Government work) | Free | 2026-08-19 |
| Wikidata `wbsearchentities` | `https://www.wikidata.org/w/api.php?action=wbsearchentities` | None, descriptive User-Agent required | No numeric read cap published for the action API. Serial rather than parallel. 1 request per second is our own floor | JSON. `success` is an integer, `url` is protocol-relative | CC0 | Free | 2026-08-19 |
| Wikipedia REST summary | `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` | None, descriptive User-Agent required | **200 requests per second**, stated in the API's own OpenAPI spec | JSON, profile `Summary/1.5.0`. `coordinates` is `{lat, lon}` and is absent on a person | **CC BY-SA 3.0 and GFDL**, per the API's own declaration, not 4.0 | Free | 2026-08-19 |
| Wikipedia geosearch (action API) | `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&formatversion=2` | None, descriptive User-Agent required | No numeric read cap published. `gsradius` is capped at 10 to 10,000 metres and anything else is an error | JSON. A requested-but-absent property comes back as an explicit `null` | CC BY-SA 3.0 and GFDL | Free | 2026-08-19 |
| Wikimedia Commons imageinfo | `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url,extmetadata` | None, descriptive User-Agent required | As the geosearch row above | JSON. The licence, author and any required credit string live in `imageinfo[0].extmetadata` | Per file, carried on the record | Free | 2026-08-19 |
| Wikimedia upload (image bytes) | `https://upload.wikimedia.org/wikipedia/commons/thumb/{path}/{width}px-{file}` | None | Only the provider's standard thumbnail widths are served. Anything else is HTTP 400 with an HTML body | Image bytes | Per file, as above | Free | 2026-08-19 |
| Nominatim | `https://nominatim.openstreetmap.org/search?format=jsonv2` | None, descriptive User-Agent mandatory | **An absolute maximum of 1 request per second**, stated by the OSMF. Caching is mandatory, not advised. Systematic queries are named as unacceptable use | JSON, a bare list. `lat` and `lon` are **strings**; `boundingbox` is 4 strings as `[south, north, west, east]` | ODbL 1.0. The response carries its own credit string | Free | 2026-08-19 |
| Overpass | `https://overpass-api.de/api/interpreter`, POST | None, descriptive User-Agent with contact required | **About 10,000 requests and under 1GB of download per day**, both stated by the provider. 2 concurrent slots for this IP per `/api/status`. Requests queue 15 seconds then are discarded | JSON when `[out:json]` is asked for, but **errors are HTML or plain text** | ODbL 1.0, self-declared in the body at `osm3s.copyright` | Free | 2026-08-19 |
| EOX Sentinel-2 cloudless | `https://tiles.maps.eox.at/wmts` | None | No published cap. `ows:Fees` is absent from the capabilities | WMTS XML capabilities plus 256x256 JPEG tiles | **CC BY 4.0 on the 2016 and 2017 mosaics only. CC BY-NC-SA 4.0 on 2018 through 2025** | Free, and a paid EOX licence for commercial use | 2026-08-19 |

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
code change. The viewport endpoint is **not** path-identical: adsb.fi uses
`/v2/lat/{lat}/lon/{lon}/dist/{nm}` and answers HTTP 400 for adsb.lol's
`/v2/point/{lat}/{lon}/{nm}`. Both were confirmed on 2026-08-19. The current failover in
`src/tracker/sources/adsb.py:331` retries the same path against the secondary base URL, so
the viewport failover does not work yet. Recorded in `docs/status.md`.

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

- **The dateless tile template GIBS publishes in its own capabilities returns HTTP 404.** The
  layer advertises three templates: one with `{Time}`, one with no date segment and one with a
  literal `default` in the date position. Only the dated form works
  (`.../default/2026-08-15/GoogleMapsCompatible_Level9/6/21/31.jpeg` gave 200 and 15,827 bytes;
  the dateless sibling gave 404 with an HTML body). The date segment is mandatory in practice
  whatever the capabilities says.
- **The `Time` dimension `Default` is tomorrow's date.** It read `2026-08-20` on 2026-08-19. A
  timeline that clamps its upper bound to the advertised default offers a day with no imagery.
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
RapidAPI key. Entry pricing is around $10 a month for roughly 10,000 requests, which
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
- **Failure is HTTP 200 with a structured JSON error envelope, not an empty body. This file
  and `AGENTS.md` both had this wrong until 2026-08-19.** Called with
  `username=TRACKER_NO_SUCH_USER` on 2026-08-19 it answered **HTTP 200 with 115 bytes**,
  verbatim: `[{"ERROR":true,"USERNAME":"TRACKER_NO_SUCH_USER","FORMAT":"HUMAN","ERROR_MESSAGE":"Invalid username or password!"}]`
  (`tests/fixtures/aishub_ws_invalid_username_live.json`, the complete body). The correct check
  is `body[0]["ERROR"] is True`, with `ERROR_MESSAGE` carrying the reason. An adapter written
  to the old claim would read this as a successful empty vessel list, which is the exact
  failure the note existed to prevent. The earlier run used `username=TEST`, which may be
  special-cased upstream; either way the general claim was false as written.
- **The over-frequent-call half of the claim is still untested.** Their own note says "The web
  service will return nothing if executed more frequently", and confirming it needs two calls
  inside a minute, which is the abuse the cadence rule exists to stop. Treat it as unverified,
  not as wrong. Either way an empty 200 is an error in the adapter, counted, and never an empty
  vessel list treated as "no ships anywhere".
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

### adsbdb

Aircraft registry lookup for phase 3, verified 2026-08-19. `/v0` is the current version prefix,
and `GET /v0/online` reports `api_version: 0.6.5`, so the URL major version and the software
version are different numbers.

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

### FAA Releasable Aircraft Database

Verified 2026-08-19. The URL has not moved. **73,031,563 bytes, 69.6MB**, 16% larger than the
FAA page's stated 60MB, downloading in 3 seconds, expanding to 532,556,660 bytes across eight
files whose real extension is `.txt` rather than `.csv`. `MASTER.txt` is **316,030 data rows**,
matching the plan's estimate, and `ACFTREF.txt` is 93,982.

**The cadence in this file was wrong: it is daily, not weekly.** The FAA's own page states "The
data in the download is refreshed daily at 11:30 pm central time." No request cap is published,
and there is no reason to fetch more than once a day.

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
  and every robot, and `cities15000.zip` sits behind it. Verified 2026-08-19. The file answered
  HTTP 200 at 3,306,600 bytes with `ETag` and `Last-Modified` served, is published under CC BY
  4.0 and is documented by GeoNames for exactly this use.
- **`https://meri.digitraffic.fi/robots.txt` is 31 bytes and contains `Disallow: /api/`**,
  verified 2026-08-19, which covers every Fintraffic endpoint in the verified table above.
  Digitraffic publishes that API, its OpenAPI document, its licence and a per-client
  identification header inviting programmatic use.

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

## Planned, NOT YET VERIFIED

None of these has been called from this project. Each is a phase deliverable, and each must
be called and moved into the verified table before any code depends on its shape.

| Source | Purpose | Phase | Auth | Known constraints | Licence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| aisstream.io | Live ship positions over WebSocket | 2 | Free API key | **Handshake verified, shape not.** `wss://stream.aisstream.io/v0/stream` answered `HTTP/1.1 101 Switching Protocols` with **no credentials at all** on 2026-08-19: authentication is in the first application message, not the handshake. With a bogus key, an empty key and no key field the server closed the raw TCP socket after about 0.5s with **zero bytes, no close frame, no close code and no error text**, so "bad key" is indistinguishable from a dropped network. The documented `{"error":"Api Key Is Not Valid"}` does not arrive. Subscribe must be sent within 3 seconds. `BoundingBoxes` is **`[latitude, longitude]`**, the opposite of our rule. A global box is 300 messages a second, so subscribe to a bounded region. `/apikeys` answers 401, so key issuance is behind a login. **No wire model may be written against the documented field names.** Beta, no SLA, key must never reach the browser | Provider terms. No licence grant, no redistribution grant and no attribution string found. `robots.txt` carries only Cloudflare boilerplate with no directives | HANDSHAKE VERIFIED, SHAPE NOT |
| AISHub | Crowd-sourced vessel positions, worldwide | 2 | Username, granted only to contributors running a physical AIS receiver | **Once per minute, hard.** An invalid username answers **HTTP 200 with a 115-byte JSON error envelope**, `[{"ERROR":true,...,"ERROR_MESSAGE":"Invalid username or password!"}]`, not an empty body. Corrected 2026-08-19: the previous claim in this file and in `AGENTS.md` was wrong. A success body is an envelope object followed by the vessel data, not a flat list. `output` defaults to XML. The over-frequent-call behaviour is still untested | Contributor terms, no redistribution grant stated | GATE VERIFIED, SHAPE NOT |
| CelesTrak GP group query | Full-catalogue element sets for the satellite layer | 2 | None | **Not called: celestrak.org was unreachable on 2026-08-20**, TCP 443 and 80 both filtered from two independent networks with `connect=0.000000`, so zero requests were served and the budget is intact. `FORMAT` defaults to CSV since 2026-05-09. Estimated 4 to 6MB per refresh for the active group. Any non-200 must stop the poller outright rather than back off. The empty or no-match response shape is undocumented and unverified | Not stated. Credit is courtesy | NOT YET VERIFIED |
| CelesTrak SATCAT | Decay date, operational status, on-orbit flag | 2 | None | `satcat/records.php`, where **`FORMAT` defaults to JSON**, unlike `gp.php`. Updates manually once or twice a day. Documentation only, no call made | Not stated | NOT YET VERIFIED |
| CelesTrak supplemental elements | Higher-accuracy element sets for named constellations | later | None | `NORAD/elements/supplemental/sup-gp.php`. **Multiple element sets can exist per object**, from multiple sources and multiple epochs, so the merge key is catalogue number plus source plus epoch rather than the number alone. Documentation only, no call made | Not stated | NOT YET VERIFIED |
| GDELT GEO 2.0 | Geolocated news coverage density | 5 | None | **Unreachable.** `https://api.gdeltproject.org/api/v2/geo/geo` answered **HTTP 404** on two attempts on 2026-08-19, with Apache's default error page, while DOC 2.0 on the same host answered 200. The URL is correct, so this is the endpoint being down. Nothing may be designed on top of it | GDELT terms, attribution required | UNREACHABLE 2026-08-19 |
| GDELT DOC 2.0 `mode=timelinevolinfo` | Coverage volume time series with sample articles | 6 | None | **Not reached:** 429 on four attempts across twelve minutes after a single successful `artlist` call. On the provider's documentation it carries the same eight article fields and no location | GDELT terms | NOT REACHED |
| Windy Webcams v3 | Owner-submitted public webcams | 5 | API key, confirmed mandatory | Answered HTTP 403 `{"message":"Missing Header 'x-windy-api-key' with API key","error":"Forbidden","statusCode":403}` on 2026-08-19, so the key gate is verified and the payload shape is not. **The gate is on a header, not a query parameter**, so the key cannot leak into a browser-visible URL but must be injected server-side on every call. **Image tokens expire after 10 minutes**, unverified from this side of the gate. Never cache an image URL beyond validity | Provider terms, non-commercial tiers exist | KEY GATE VERIFIED, SHAPE NOT |
| Flickr | Geotagged photographs with author text | 8 | Free key | **The gate is HTTP 200, not a 4xx.** No key, an empty key and a bogus key all returned 200 with `{"stat":"fail","code":100}`, so `stat` must be checked before anything else. Pass `nojsoncallback=1` or the body is wrapped in `jsonFlickrApi(...)`. Provider figures: **3,600 queries per hour per key** and a hard **4,000-result ceiling per query** with no way to page past it. `bbox` is longitude-first. Omitting `license` returns All Rights Reserved items, so the filter is mandatory here. Payload shape unverified | Per photo, and licence 0 is the default without a filter | GATE VERIFIED, SHAPE NOT |
| Companies House REST API | Officer roles and occupations, which the keyless PSC bulk does not carry | 6 | Free key | **401 verified twice with two distinct bodies:** `{"error":"Empty Authorization header"}` with no credential and `{"error":"Invalid Authorization"}` with a wrong one, so no-key-configured and wrong-key are separable and should not be collapsed. HTTP Basic with the key as username and a blank password. 600 requests per 5 minutes, **and a breach locks you out for the remainder of the five-minute window**, so the floor needs a token bucket rather than a sleep. Payload shape unverified | Open Government Licence 3.0 | GATE VERIFIED, SHAPE NOT |
| IRS bulk Form 990 XML | Real 990 trustee and officer names, the only keyless route to them | 6 | None | `https://apps.irs.gov/pub/epostcard/990/xml/{year}/{year}_TEOS_XML_{nn}.zip`. **HEAD only:** 200, `application/zip`, 71,497,607 bytes for one 2026 month, roughly 1.1GB a year. Deliberately not downloaded, so the XML shape is unverified. Carries `Form990PartVIISectionAGrp` with `PersonNm` and `TitleTxt`. A bulk local-index ingest in the same category as GeoNames, never a poller. **Its predecessor is dead**: the `irs-form-990` S3 bucket lists zero objects and any per-filing key 404s | Public domain (US Government work) | HEAD VERIFIED, SHAPE NOT |
| USCG Vessel Documentation Search bulk file | US vessel ownership, which PSIX does not carry | 5 | Unknown | **Not called.** Named because PSIX carries no owner field in any of its seven operations, so US vessel ownership has no source in this project yet | Public domain expected, unverified | NOT YET VERIFIED |
| Equasis | Vessel registry and ownership | 5 | Account | **Gate verified.** The public home page answers 200 with navigation only, every vessel record is behind the login, and the site is JavaScript-gated. **`robots.txt` answers HTTP 403**, so there is no crawl permission to read, and absence of a directive is not permission. Registration is free but it is an account we would have to hold and honour terms under, which puts it in the same bucket as AISHub: no software route in | Provider terms | GATE VERIFIED, SHAPE NOT |
| IMO GISIS | Ship particulars | 5 | IMO public-user account | **Not called.** Same account class as Equasis, and two keyless registries already answer the phase 5 question | Provider terms | NOT YET VERIFIED |
| Terrascope WMTS | Sentinel-2 basemap option | 7 | None expected | **Not reached, and diagnosed rather than assumed.** DNS resolves, TCP 443 is open, TLS completes with a valid certificate, and the host **resets the connection after the request is written**, on HTTP/2 and HTTP/1.1, with a Chrome User-Agent, over IPv4, and on `/robots.txt`. So this is application-layer blocking, not a network fault. Same class as adsb.one. Two claims that must not be written as verified: that the RESTful tile templates 400 while the key-value form works, and that the tile matrix set identifier is the literal `EPSG:3857`. For contrast, the literal `EPSG:3857` is a 404 on EOX | Not established: the capabilities document carries it and could not be fetched. The underlying data is Copernicus | NOT REACHED |
| US 511 programmes beyond New York | State traffic cameras outside NY | 8 | Varies by state | Not one API. WSDOT answered HTTP 401 without a key on 2026-08-19. Each state is its own adapter and its own row here | Per state, usually open data | NOT YET VERIFIED |
| Copernicus Data Space download | Sentinel product bytes, not just the catalogue record | 7 | OAuth token from the Copernicus identity service | Catalogue search is already verified and keyless. Only the byte download needs the account and carries the quota. A full SAFE archive is about 707MB, so it is not a browser asset | Copernicus free, full and open | NOT YET VERIFIED |
| Public live-stream webcams | Owner-published city, port and landmark streams | 8 | Varies | Owner-published only. Each stream is checked individually for a publish-to-web intent before it is used | Per stream | NOT YET VERIFIED |
| Cesium ion | OSM Buildings 3D Tiles, optional terrain | 7 | Client-side ion token | Community tier quota. Token is client-side by design | **Non-commercial community tier, paid past $50k organisation revenue** | NOT YET VERIFIED |
| Bluesky (`public.api.bsky.app`) | Social posts, text only | 8 | None documented | **Answered HTTP 403 from this network on 2026-08-19** for `app.bsky.feed.searchPosts` while `app.bsky.actor.getProfile` answered 200, so search is gated. Posts carry no coordinates | Per-post | NOT YET VERIFIED |

---

## Licence audit

Read this before anyone says the word "launch".

**The project is not currently licensed for commercial deployment.** Eight sources block it
now rather than three, and the four added on 2026-08-19 are the sharpest, because each one is
the only source for the thing its phase needs.

1. **adsb.fi is non-commercial use only.** It is the aircraft failover, so commercial use
   means either dropping the failover (and accepting that an adsb.lol HTTP 420 takes the
   military layer down, which has already happened once) or replacing it with a
   commercially licensed readsb v2 provider. The adapter makes that a base-URL change, and
   that is exactly why the provider-swap interface exists. See ADR 003.
2. **Cesium ion's community tier is non-commercial**, and flips to paid past $50,000 of
   organisation revenue. This one is contained: the buildings layer is optional, the app
   works with no ion token, and `/api/capabilities` reports the layer as unavailable with a
   reason (`src/tracker/api/routes_meta.py:93`).
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
| Kystverket | `Vessel data from Kystverket (Norwegian Coastal Administration)` with a link to the NLOD 2.0 licence at `https://data.norge.no/nlod/en/2.0/`. NLOD makes acknowledgement mandatory but does not prescribe a string, so this wording is ours | `NLOD 2.0` |
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
