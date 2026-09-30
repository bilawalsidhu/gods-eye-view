# U.S. State DOT / 511 CCTV Source Matrix

**Phase:** Camera expansion Phase 4 (bespoke adapter implementation)
**Research date:** 2026-09-29  
**Scope:** Publicly presented state DOT / 511 roadway cameras that could be added through the existing CCTV catalog/provider pipeline. This is not authorization to scrape a website or to proxy a camera URL.

## Status definitions

- **ALREADY-COVERED** — present in the current catalog. Do not duplicate it.
- **READY-KEYLESS** — official machine-readable source and camera media were identified with an apparently public access route; source-specific reuse and live response still need confirmation before implementation.
- **READY-KEYED** — official developer API documentation describes a camera resource and an access key/account path. Live credentials and a representative response are still needed before calling the integration verified.
- **NEEDS-TERMS-REVIEW** — an official camera service exists, but the public material found does not establish third-party machine access, redistribution/display rights, or stable media access. Obtain written permission or the applicable agreement before use.
- **NO-USABLE-OFFICIAL-SOURCE-FOUND** — this audit did not find a documented, usable official catalog/feed for this purpose. It does not mean the state has no cameras or that a private partner feed cannot exist.
- **DEFERRED-MEDIA-ORIGIN** — a documented API exists, but current official examples do not establish the production camera-media origin; do not register staging or guessed media URLs.

## State-by-state screening

| State | Status | Official source / finding | Access and media evidence | Adapter family / next gate |
|---|---|---|---|---|
| Alabama | NEEDS-TERMS-REVIEW | [ALGO Traffic](https://algotraffic.com/) provides the official camera/traffic interface. | ALDOT terms describe camera images as real-time and restrict unauthorized capture/transmission; seek ALDOT permission. No public catalog API contract found. | Permission-gated source; do not scrape the web app. |
| Alaska | READY-KEYED | [511 Alaska API docs](https://511.alaska.gov/developers/doc) document `/api/v2/get/cameras`. | Provider key required; catalog and enabled camera view URLs are accepted only from `511.alaska.gov`. Access remains disabled until a key is saved in Provider Settings. The live API and media rights still need user-side validation. | Phase 3 shared 511/CARS adapter implemented; live response unverified without an issued key. |
| Arizona | READY-KEYED | [AZ511 developer docs](https://az511.gov/developers/doc) document camera data. | Provider key required; catalog and enabled camera view URLs are accepted only from `az511.com`. Access remains disabled until a key is saved in Provider Settings. The live API and media rights still need user-side validation. | Phase 3 shared 511/CARS adapter implemented; live response unverified without an issued key. |
| Arkansas | NEEDS-TERMS-REVIEW | [IDrive Arkansas](https://idrivearkansas.com/) publishes public camera views. | Site terms restrict linking/copying images and reverse engineering; written authorization required before programmatic use. | Permission-gated; no scraping. |
| California | ALREADY-COVERED | Caltrans statewide/district camera catalog and frames are already loaded through the existing provider. | Public Caltrans camera source; current catalog and attribution behavior documented in `DATA_SOURCES.md`. | Existing Caltrans pack; preserve current media allowlist. |
| Colorado | NEEDS-TERMS-REVIEW | [COtrip](https://www.cotrip.org/) is the official camera portal; CDOT documents traveler-information data services. | Public materials refer to XML/API access, but a current camera-specific access agreement and redistribution terms were not established in this audit. | XML/API candidate after current access agreement and source test. |
| Connecticut | NEEDS-TERMS-REVIEW | [CTroads](https://ctroads.org/) / CTDOT camera portal is official. | No current official machine-readable camera catalog and reuse terms were verified. | Inspect official portal/network documentation; do not reuse browser-internal endpoints without approval. |
| Delaware | ALREADY-COVERED | DelDOT statewide cameras are already loaded through the existing provider. | Existing pack normalizes official camera records and registers approved image hosts. | Existing DelDOT pack. |
| Florida | NEEDS-TERMS-REVIEW | [FL511](https://fl511.com/) is the official traveler-information portal. | Public camera UI exists. Current public third-party API availability and feed/media agreement were not confirmed; historic feed references are insufficient evidence. | Contact FDOT / current vendor for feed access and use terms. |
| Georgia | READY-KEYED | [511GA developer docs](https://511ga.org/developers/doc) document the camera API. | Developer key required; camera records/coordinates documented. Camera media may use authenticated/session-backed delivery; obtain key and verify playback plus reuse rights. | 511/CARS JSON for catalog; separately assess signed/session media path. |
| Hawaii | NO-USABLE-OFFICIAL-SOURCE-FOUND | Official traveler pages found, but no state DOT public roadway-camera catalog/feed suitable for integration was identified. | Honolulu-area traffic cameras are not a statewide HDOT catalog. | No implementation candidate in this pass. |
| Idaho | NEEDS-TERMS-REVIEW | [Idaho 511](https://511.idaho.gov/) is the official traveler portal. | Camera pages exist; no current official developer feed/API contract and reusable media terms verified. | Request official feed/terms. |
| Illinois | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official statewide machine-readable camera catalog with documented reuse terms verified. | Official traveler information exists, but no eligible camera feed established in this audit. | Revisit with IDOT / regional 511 contacts. |
| Indiana | NO-USABLE-OFFICIAL-SOURCE-FOUND | [TrafficWise](https://trafficwise.in.gov/) is official, but no documented state camera API/catalog with reuse terms was verified. | Portal presence alone is not permission to extract media. | No current implementation candidate. |
| Iowa | READY-KEYLESS | [Iowa DOT Traffic Cameras FeatureServer](https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0) is an official public camera dataset; Iowa DOT's 511 page confirms the ArcGIS camera service needs no credentials. | Item metadata licenses the dataset CC BY 4.0, says it updates daily and includes coordinates, static image URL, and motion video URL. Live representative query succeeded: 1,259 total features, including 742 `Type=Iowa DOT`; geometry is queryable in EPSG:4326. Image host observed `atmsqf.iowadot.gov`; video host observed `video2.iowadot.gov` (other numbered `video*.iowadot.gov` hosts may rotate). Verify each media URL against pinned provider host/path rules. | ArcGIS FeatureServer; Phase 2 keyless representative. Do not fetch frames until selected. 511 XML feed is separate and requires access request; use the public GIS dataset instead. |
| Kansas | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable statewide camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Kentucky | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable statewide camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Louisiana | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable statewide camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Maine | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable statewide camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Maryland | NEEDS-TERMS-REVIEW | [CHART](https://chart.maryland.gov/) is the official state traffic portal. | Public-facing cameras exist, but current external catalog/API and permission to display camera imagery were not verified. | Obtain MDOT permission/feed specification. |
| Massachusetts | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official public machine-readable camera catalog and reuse terms verified. | Camera portal/provider access not established. | No current implementation candidate. |
| Michigan | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Minnesota | NO-USABLE-OFFICIAL-SOURCE-FOUND | [MnDOT 511](https://511mn.org/) shows statewide cameras; a maintained official developer feed with camera reuse terms was not verified. | An exposed JSON endpoint referenced by third parties is not treated as an approved source without DOT documentation. | Ask MnDOT for official API/feed terms. |
| Mississippi | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traffic map found, but no eligible interface established. | No current implementation candidate. |
| Missouri | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog with reuse terms verified. | Public MoDOT traveler portal is not sufficient by itself. | No current implementation candidate. |
| Montana | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Nebraska | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Nevada | NEEDS-TERMS-REVIEW | [Nevada 511](https://www.nvroads.com/) is the official traveler portal. | Camera service exists; current official developer docs, catalog access, and camera-media rights were not confirmed. | Contact NDOT / portal vendor. |
| New Hampshire | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| New Jersey | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| New Mexico | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| New York | READY-KEYED | [511NY API documentation](https://511ny.org/developers/help) documents camera endpoints/resources. | Developer application/key and approval are required; API fields include location and image/video URL fields. Need issued access and live response; follow the granted API agreement. | Phase 2 511/CARS adapter; shared in Phase 3 with Alaska and Arizona. |
| North Carolina | DEFERRED-MEDIA-ORIGIN | [DriveNC camera API docs](https://www.drivenc.gov/help/endpoint/cameras) list the official camera catalog and require a developer key. | The official sample response uses `NC.stage.traveliq.co` for camera-view URLs. No current production media hostname/path was confirmed; the staging URL is intentionally rejected. | Revisit when DriveNC documents or returns a production HTTPS still-image origin. |
| North Dakota | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Ohio | IMPLEMENTED-KEYED | [OHGO camera docs](https://publicapi.ohgo.com/docs/v1/cameras) and [terms](https://publicapi.ohgo.com/docs/terms-of-use) document a camera API. | Free registered API key; docs specify coordinates, view image URLs, and snapshots updated every five seconds. OHGO says data is public domain. Requires user key and live media verification. | Existing CCTV catalog, Provider Settings test, Ohio bounds, bounded all-page request, strict OHGO media host/path pinning. |
| Oklahoma | NO-USABLE-OFFICIAL-SOURCE-FOUND | ODOT public map/data portals found, but not a documented public roadway-camera catalog/API with reuse terms. | Some camera operations are not publicly accessible; no eligible source verified. | No current implementation candidate. |
| Oregon | IMPLEMENTED-KEYED | [ODOT TripCheck API](https://tripcheck.com/Pages/API) documents CCTV Inventory and a developer portal. | Official subscription key via ODOT portal; inventory refresh is documented at 24 hours and includes still image URLs. Requires user key and live response verification. | Existing CCTV catalog, Provider Settings test, daily inventory cache, Oregon bounds, strict TripCheck HTTPS media host pinning. Partner-hosted frames are skipped. |
| Pennsylvania | NEEDS-TERMS-REVIEW | [511PA developer access](https://www.511pa.com/developers) has an application process for camera data/video. | Access requires approval and a video sharing agreement/license; attribution and stream constraints apply. Do not integrate until the applicable agreement is reviewed and accepted. | Agreement-gated; assess signed/session media separately. |
| Rhode Island | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| South Carolina | NEEDS-TERMS-REVIEW | [511SC](https://511sc.org/) is the official camera/traveler portal. | Camera UI exists, but official API documentation and third-party image reuse terms were not found. | Request official source and reuse terms; do not scrape. |
| South Dakota | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Tennessee | NEEDS-TERMS-REVIEW | [TDOT SmartWay](https://smartway.tn.gov/traffic) publishes public traffic cameras. | Public page documents camera service, not a public catalog/API or external media license. | Request TDOT feed/terms; no undocumented extraction. |
| Texas | ALREADY-COVERED | TxDOT statewide district cameras and Austin city cameras are already loaded. | Existing TxDOT pack queries selected districts and registers validated snapshot proxy URLs. | Existing TxDOT / Austin packs. |
| Utah | NEEDS-TERMS-REVIEW | [UDOT Traffic](https://udottraffic.utah.gov/) is the official traffic-camera portal. | Public map exists; current official API documentation and programmatic camera reuse terms were not verified. | Request UDOT developer source/terms. |
| Vermont | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Virginia | NEEDS-TERMS-REVIEW | [VDOT 511 video access](https://www.vdot.virginia.gov/news-events/media/) confirms an API/feed for 511 traffic video. | VDOT states a user agreement is required; free internal/public distribution is possible, resale is paid. Obtain the applicable agreement before integration. | Agreement-gated API/media source. |
| Washington | IMPLEMENTED-KEYED | [WSDOT Traveler Information API](https://www.wsdot.wa.gov/traffic/api/) documents Highway Cameras REST operations. | Access code required; camera schema includes camera ID, coordinates, active flag, image URL, location and owner fields. Requires user code and live response verification. | Existing CCTV catalog, Provider Settings test, active WSDOT-owned cameras only, Washington bounds, pinned HTTPS WSDOT image host. |
| West Virginia | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |
| Wisconsin | NEEDS-TERMS-REVIEW | [511 Wisconsin](https://511wi.gov/) publishes camera views; WisTransPortal exposes a Wisconsin 511 CCTV inventory feed. | A public technical inventory endpoint is documented by a university transportation portal, but a current WisDOT permission/reuse statement for camera images was not verified. | Obtain WisDOT confirmation; do not treat accessible XML/JSON as license. |
| Wyoming | NO-USABLE-OFFICIAL-SOURCE-FOUND | No current official machine-readable camera catalog and reuse terms verified. | Public traveler portal alone is insufficient evidence. | No current implementation candidate. |

### Screened totals

| Classification | Count | Notes |
|---|---:|---|
| ALREADY-COVERED | 3 | California, Delaware, Texas (Austin is an existing city source within Texas). |
| READY-KEYLESS | 1 | Iowa (public ArcGIS source; camera data license and representative catalog response verified). |
| READY-KEYED | 4 | Alaska, Arizona, Georgia, New York. These are documented providers whose live access requires operator credentials. |
| IMPLEMENTED-KEYED | 3 | Ohio, Oregon, Washington. Adapters are implemented; live catalog/media verification requires operator credentials. |
| DEFERRED-MEDIA-ORIGIN | 1 | North Carolina. Official examples use a staging camera-media hostname. |
| NEEDS-TERMS-REVIEW | 14 | Alabama, Arkansas, Colorado, Connecticut, Florida, Idaho, Maryland, Nevada, Pennsylvania, South Carolina, Tennessee, Utah, Virginia, Wisconsin. |
| NO-USABLE-OFFICIAL-SOURCE-FOUND | 24 | Hawaii, Illinois, Indiana, Kansas, Kentucky, Louisiana, Maine, Massachusetts, Michigan, Minnesota, Mississippi, Missouri, Montana, Nebraska, New Hampshire, New Jersey, New Mexico, North Dakota, Oklahoma, Rhode Island, South Dakota, Vermont, West Virginia, Wyoming. |

## Candidate source families and implementation batches

### Existing code should remain the integration boundary

All accepted sources should normalize into the existing CCTV catalog record, pass through the current provider isolation and caps, and register media only through the server-side provider allowlist/proxy. Do not add a nationwide layer, a second catalog, browser-side secret, arbitrary-URL media proxy, or browser fetch of provider credentials.

### Adapter families identified

1. **Existing pack adapters:** Caltrans, TxDOT, DelDOT, and Austin. Preserve and extend only when there is a concrete source gap.
2. **511/CARS-style JSON:** New York, Alaska, and Arizona are routed through one provider-configured parser while keeping separate API endpoints, credentials, geographic bounds, IDs, attribution, and exact media-host allowlists. Sampled response shapes support the common camera fields; actual keyed responses and camera playback remain to be verified by users with issued keys. Georgia remains deferred because its camera-media path may be session-backed.
3. **State REST APIs:** Ohio OHGO and Washington WSDOT now use provider-specific parsers and independent credentials. DriveNC (North Carolina) remains deferred because its official sample points to a staging camera-media hostname.
4. **ODOT TripCheck:** Oregon's keyed CCTV Inventory API is accessed as JSON, cached at its documented 24-hour cadence, and restricted to official TripCheck media URLs. Iowa's public CC BY 4.0 ArcGIS CCTV FeatureServer is the keyless Phase 2 source; its separate XML feed remains approval-gated.
5. **Agreement-gated / opaque portals:** Alabama, Arkansas, Colorado, Connecticut, Florida, Idaho, Maryland, Nevada, Pennsylvania, South Carolina, Tennessee, Utah, Virginia, and Wisconsin. No production adapter should be built until the agency/vendor gives a current API specification and terms that allow this app's use.

### Implementation batches

1. **Phase 2:** New York's approval-gated 511 REST API and Iowa's keyless ArcGIS FeatureServer were added through the current CCTV source catalog.
2. **Phase 3:** Alaska and Arizona use the shared 511/CARS adapter. Their provider keys are managed independently in POWER UP → Provider Settings. Georgia remains deferred until its camera media path is validated.
3. **Phase 4:** Ohio, Oregon, and Washington are implemented as isolated keyed providers through Provider Settings. North Carolina remains deferred pending an official production media origin. Georgia remains deferred pending validation of session-backed media.
4. **Permission-dependent sources:** contact DOT/vendor for Virginia, Pennsylvania, Florida, Alabama, Arkansas and remaining flagged states. Record approval, limits, attribution, cache/refresh guidance and media hostnames before provider work.
5. **Re-screen no-source states:** revisit through state DOT/vendor contacts or newly published developer portals. Do not substitute third-party aggregators for official sources without separate provenance and terms review.

## Security, operational, and verification notes

- Any API key/access code must be configured through the existing Provider Settings credential path and remain server-side. Do not ask users to edit `.env`; do not expose keys in provider responses, browser storage, logs, errors, screenshots, tests or docs.
- Each new provider must fail independently. Missing/bad credentials or one provider's outage must not disable existing CCTV sources.
- Catalog metadata may be cached conservatively (current system cache is 15 minutes); respect stricter source cache/rate guidance. Do not poll individual cameras at catalog frequency.
- The existing media proxy's approved-origin/media validation remains mandatory. Do not add image/video URLs directly from untrusted provider records to an unrestricted proxy.
- Before a source is marked verified, capture the official docs, a successful representative catalog response, field mapping (ID, lat/lon, label, still/video URLs, active/status, attribution), refresh/rate guidance, media-origin evidence, and applicable reuse terms. Record only aggregate counts and sanitized examples; never include credentials.
- Public availability of a camera website or endpoint does not establish permission to republish the feed. Where terms are silent or contract-based, keep the provider disabled until written confirmation is obtained.

## Source references

- [FHWA national state traffic-information directory](https://highways.dot.gov/traffic-info)
- [OHGO API introduction and public-domain statement](https://publicapi.ohgo.com/)
- [OHGO camera schema](https://publicapi.ohgo.com/docs/v1/cameras) and [terms/rate limits](https://publicapi.ohgo.com/docs/terms-of-use)
- [DriveNC API docs, camera resource, developer key, and throttle](https://www.drivenc.gov/developers/doc)
- [ODOT TripCheck API, CCTV inventory, refresh interval, and developer portal](https://tripcheck.com/Pages/API); [ODOT public data integration description](https://www.oregon.gov/ODOT/Maintenance/Pages/Traveler-Information.aspx)
- [Iowa DOT 511 feeds and ArcGIS CCTV service](https://iowadot.gov/travel-tools/iowa-511/511-data-feeds); [2026 feed/media URL change notice](https://iowadot.gov/news/2026-05-28/media-advisory-iowa-dot-updates-traffic-camera-video-system-data-feed-usersdevelopers)
- [Iowa DOT camera FeatureServer](https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0), [CC BY 4.0 item metadata](https://www.arcgis.com/home/item.html?id=c4063f200a7b4da5826e2ac86c677cf5), and [Iowa DOT GIS terms](https://iowadot.gov/policies-statements/terms-use)
- [WSDOT traveler API](https://www.wsdot.wa.gov/traffic/api/), [Highway Cameras methods](https://www.wsdot.wa.gov/traffic/api/Documentation/group___highway_cameras.html), and [camera fields](https://wsdot.wa.gov/traffic/api/Documentation/class_camera.html)
- [511NY developer documentation](https://511ny.org/developers/help); [Alaska 511 developer documentation](https://511.alaska.gov/developers/doc); [AZ511 developer documentation](https://az511.gov/developers/doc); [511GA developer documentation](https://511ga.org/developers/doc)
- [VDOT third-party video access and user-agreement requirement](https://www.vdot.virginia.gov/news-events/media/)
- [ALGO official portal](https://algotraffic.com/) and [ALDOT terms](https://algotraffic.com/terms)
- [IDrive Arkansas site/terms](https://idrivearkansas.com/terms)
- [PennDOT 511 developer portal](https://www.511pa.com/developers)
- [WisTransPortal CCTV inventory service](https://transportal.cee.wisc.edu/its/inventory/?resource=CCTV&format=INFO)

## Phase 4 disposition

Phase 4 adds OHGO (Ohio), TripCheck (Oregon), and WSDOT (Washington) as independent, keyed catalog packs with state-coordinate checks, per-provider caps, secure Provider Settings credentials and connection tests, and strict server-side media URL validation. Oregon's inventory refresh follows its published 24-hour cadence. WSDOT partner-owned feeds are excluded. These providers still require operator-supplied API credentials and live end-user confirmation of successful catalog and image playback. North Carolina is deferred because the official DriveNC API sample camera URLs point to a staging host and a production media origin could not be verified. Georgia remains deferred pending validation of its session-backed camera media. A developer key alone does not grant rights beyond each provider's applicable terms.
