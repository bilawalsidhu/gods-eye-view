export const DEFAULT_CCTV_SOURCE_FILE = 'config/cctv_sources.austin.json';
/** Austin Open Data portal endpoint for traffic camera records. */
export const DEFAULT_AUSTIN_ROWS_URL =
  'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD';
/** Default cap on Austin cameras after distance-based prioritization. */
export const DEFAULT_AUSTIN_MAX_SOURCES = 250;
/**
 * Catalog-wide safety ceiling on served cameras. Each pack already caps
 * itself (nearest-to-anchor first); this bound only matters when the packs
 * together exceed it, and it is then filled round-robin across packs (see
 * cap.js) so no region is silently dropped. The default per-pack caps
 * together can exceed it, so a default install may be thinned evenly here.
 */
export const DEFAULT_CCTV_MAX_SOURCES = 4000;
/** Hard upper bound for CCTV_MAX_SOURCES; also sizes the health map. */
export const CCTV_MAX_SOURCES_CEILING = 5000;
/** Reference point for Austin camera prioritization (Congress & 6th). */
export const AUSTIN_DOWNTOWN = { lat: 30.2672, lon: -97.7431 };
/** Caltrans CCTV: one JSON feed per district, identical schema statewide. */
/** TxDOT ITS: one keyless JSON catalog per district (25 districts statewide). */
export const TXDOT_ORIGIN = 'https://its.txdot.gov';
export const TXDOT_CCTV_STATUS_URL = (district) =>
  `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=${encodeURIComponent(district)}`;
/** Per-camera frame. Returns JSON `{snippet:<base64 jpeg>}`, not an image body;
 * media.js decodes it (fetchTxdotSnapshot) and only for this origin. */
export const TXDOT_CCTV_SNAPSHOT_URL = `${TXDOT_ORIGIN}/its/DistrictIts/GetCctvSnapshotByIcdId`;
/** Valid TxDOT district codes (the ITS map's own districtCodes list). */
export const TXDOT_DISTRICTS = new Set([
  'ABL',
  'AMA',
  'ATL',
  'AUS',
  'BMT',
  'BWD',
  'BRY',
  'CHS',
  'CRP',
  'DAL',
  'ELP',
  'FTW',
  'HOU',
  'LRD',
  'LBB',
  'LFK',
  'ODA',
  'PAR',
  'PHR',
  'SJT',
  'SAT',
  'TYL',
  'WAC',
  'WFS',
  'YKM',
]);
/** Districts fetched by default: Austin (the reference camera city) and San
 * Antonio. A statewide default was rejected: per-pack prioritization is
 * nearest-to-any-anchor, so Dallas's dense core would take most slots.
 * CCTV_TXDOT_DISTRICTS opens up the rest ("AUS,SAT,HOU,DAL,FTW" for the five
 * big metros, or any of the 25 codes). */
export const DEFAULT_TXDOT_DISTRICTS = 'AUS,SAT';
export const DEFAULT_TXDOT_MAX_SOURCES = 500;
/** Prioritization anchors: downtown cores of the metro districts a user can
 * select. Cameras rank by distance to the NEAREST anchor, so a widened
 * CCTV_TXDOT_DISTRICTS still ranks sensibly instead of against Austin alone. */
export const TXDOT_ANCHORS = [
  { lat: 30.2672, lon: -97.7431 }, // Austin
  { lat: 29.4241, lon: -98.4936 }, // San Antonio
  { lat: 29.7604, lon: -95.3698 }, // Houston
  { lat: 32.7767, lon: -96.797 }, // Dallas
  { lat: 32.7555, lon: -97.3308 }, // Fort Worth
];
/** Ground-elevation priors in metres, by district. The TxDOT payload carries
 * no elevation, and on a keyless (no-tileset) stack the client's ground snap
 * never fires, so this prior is the only height a camera gets there. Texas
 * spans sea level (Houston) to ~1,140 m (El Paso). */
export const TXDOT_DISTRICT_ELEVATION_M = Object.freeze({
  ABL: 520,
  AMA: 1099,
  ATL: 105,
  AUS: 149,
  BMT: 5,
  BWD: 425,
  BRY: 111,
  CHS: 250,
  CRP: 7,
  DAL: 131,
  ELP: 1140,
  FTW: 199,
  HOU: 15,
  LRD: 132,
  LBB: 992,
  LFK: 91,
  ODA: 890,
  PAR: 185,
  PHR: 30,
  SJT: 585,
  SAT: 198,
  TYL: 165,
  WAC: 143,
  WFS: 289,
  YKM: 70,
});
export const TXDOT_DEFAULT_ELEVATION_M = 150;
export const CALTRANS_CCTV_URL = (district) =>
  `https://cwwp2.dot.ca.gov/data/d${district}/cctv/cctvStatusD${String(district).padStart(2, '0')}.json`;
/** Districts fetched by default: SF Bay (4), LA (7), San Diego (11), Sacramento (3). */
export const DEFAULT_CALTRANS_DISTRICTS = '4,7,11,3';
export const DEFAULT_CALTRANS_MAX_SOURCES = 300;
/** Prioritization anchors: downtown cores of the four default metros. */
export const CALTRANS_ANCHORS = [
  { lat: 37.7793, lon: -122.4193 }, // San Francisco
  { lat: 34.0537, lon: -118.2428 }, // Los Angeles
  { lat: 32.7157, lon: -117.1611 }, // San Diego
  { lat: 38.5816, lon: -121.4944 }, // Sacramento
];
export const FLORIDA_CCTV_URL =
  'https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0/query';
export const FLORIDA_IMAGE_HOSTS = [
  'images-dis.divas.cloud',
  'snapshots.divas.cloud',
];
export const DEFAULT_FLORIDA_MAX_SOURCES = 500;
/** Byte cap per catalog page (2,000 rows, about 650 KiB measured). */
export const FLORIDA_MAX_CATALOG_BYTES = 2 * 1024 * 1024;
/** Catalog page ceiling: 40 pages covers 4,000+ cameras even at 100 rows a page. */
export const FLORIDA_MAX_CATALOG_PAGES = 40;
export const FLORIDA_ANCHORS = [
  { lat: 25.7617, lon: -80.1918 }, // Miami
  { lat: 28.5384, lon: -81.3789 }, // Orlando
  { lat: 27.9506, lon: -82.4572 }, // Tampa
  { lat: 30.3322, lon: -81.6557 }, // Jacksonville
  { lat: 30.4383, lon: -84.2807 }, // Tallahassee
  { lat: 26.1224, lon: -80.1373 }, // Fort Lauderdale
  { lat: 26.7153, lon: -80.0534 }, // West Palm Beach
  { lat: 30.4213, lon: -87.2169 }, // Pensacola (panhandle)
];
/** TfL JamCams: one keyless list endpoint; frames live on a public S3 bucket. */
export const TFL_JAMCAM_URL = 'https://api.tfl.gov.uk/Place/Type/JamCam';
export const TFL_IMAGE_ORIGIN =
  'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/';
export const DEFAULT_TFL_MAX_SOURCES = 250;
export const LONDON_CENTER = { lat: 51.5074, lon: -0.1278 };
/** Ontario 511: keyless CARS/511 camera catalog; frame URLs are still images. */
export const ONTARIO_511_CAMERAS_URL =
  'https://511on.ca/api/v2/get/cameras?format=json&lang=en';
export const ONTARIO_511_IMAGE_ORIGIN = 'https://511on.ca/map/Cctv/';
export const DEFAULT_ONTARIO_MAX_SOURCES = 1000;
export const ONTARIO_ANCHORS = [
  { lat: 43.4516, lon: -80.4925 }, // Kitchener
  { lat: 43.6532, lon: -79.3832 }, // Toronto
  { lat: 45.4215, lon: -75.6972 }, // Ottawa
  { lat: 43.2557, lon: -79.8711 }, // Hamilton
  { lat: 42.9849, lon: -81.2453 }, // London, Ontario
  { lat: 42.3149, lon: -83.0364 }, // Windsor
];
/** Fintraffic road weather cameras (Digitraffic): one keyless GeoJSON list
 * covering all of Finland. Each STATION carries N presets (fixed camera views)
 * that share the station position; one preset is one camera here. */
export const FINTRAFFIC_STATIONS_URL =
  'https://tie.digitraffic.fi/api/weathercam/v1/stations';
/** Frames: `<origin><presetId>.jpg`. Preset ids are synthesized into this
 * origin rather than read from the payload, so no upstream field can steer the
 * frame proxy off-host. */
export const FINTRAFFIC_IMAGE_ORIGIN = 'https://weathercam.digitraffic.fi/';
/** Digitraffic asks every client to identify itself on API calls. */
export const DIGITRAFFIC_USER = 'gods-eye-view';
export const DEFAULT_FINTRAFFIC_MAX_SOURCES = 300;
/** Ground-elevation prior, in metres, for stations that report no altitude.
 * 228 of 809 stations carry a real metre value (median 94 m); the rest report
 * 0, which means "not reported" rather than sea level — Kouvola (~80 m of real
 * elevation) reports 0. The observed median stands in for those. */
export const FINTRAFFIC_GROUND_ELEVATION_M = 90;
/** Prioritization anchors: the population centres strung along Finland's main
 * road spine (vt1 Turku, vt3 Tampere, vt4 Jyväskylä–Oulu–Rovaniemi, vt5
 * Kuopio), so a cap keeps national coverage rather than just the capital. */
export const FINLAND_ANCHORS = [
  { lat: 60.1699, lon: 24.9384 }, // Helsinki
  { lat: 60.4518, lon: 22.2666 }, // Turku
  { lat: 61.4978, lon: 23.761 }, // Tampere
  { lat: 62.2426, lon: 25.7473 }, // Jyväskylä
  { lat: 62.8924, lon: 27.677 }, // Kuopio
  { lat: 65.0121, lon: 25.4651 }, // Oulu
  { lat: 66.5039, lon: 25.7294 }, // Rovaniemi
];
/** Global cap on total CCTV sources served by the proxy: the default per-pack
 * caps summed (Austin 250 + Caltrans 300 + TfL 250 + DriveBC 250). */
/** DriveBC highway cameras (British Columbia): the keyless camera list served by
 * the DriveBC.ca site (github.com/bcgov/DriveBC.ca). The DataBC HighwayCams CSV
 * lists the same cameras but still carries retired images.drivebc.ca frame URLs,
 * so frames are built from the numeric camera id on the current image host. */
export const DRIVEBC_WEBCAMS_URL = 'https://www.drivebc.ca/api/webcams/';
export const DRIVEBC_IMAGE_URL = (id) =>
  `https://www.drivebc.ca/images/${id}.jpg`;
export const DEFAULT_DRIVEBC_MAX_SOURCES = 250;
/** Prioritization anchors: downtown Vancouver and Victoria. */
export const DRIVEBC_ANCHORS = [
  { lat: 49.2827, lon: -123.1207 }, // Vancouver
  { lat: 48.4284, lon: -123.3656 }, // Victoria
];
/** Tallinn intersection cameras: curated catalog + public stills on ristmikud.tallinn.ee. */
export const DEFAULT_TALLINN_SOURCE_FILE = 'config/cctv_sources.tallinn.json';
export const DEFAULT_TALLINN_MAX_SOURCES = 255;
export const TALLINN_IMAGE_ORIGIN = 'https://ristmikud.tallinn.ee/';
export const TALLINN_CENTER = { lat: 59.437, lon: 24.753 };
/** Transpordiamet / Tarktee road-weather cameras: keyless DATEX2 feeds. */
export const TARKTEE_LOCATIONS_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraLocations';
export const TARKTEE_IMAGES_URL =
  'https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages';
export const TARKTEE_IMAGE_ORIGIN = 'https://tarktee.transpordiamet.ee/images/';
export const DEFAULT_TARKTEE_MAX_SOURCES = 179;
export const TARKTEE_ANCHORS = [
  { lat: 59.437, lon: 24.753 }, // Tallinn
  { lat: 58.378, lon: 26.729 }, // Tartu
  { lat: 58.3859, lon: 24.4971 }, // Pärnu
  { lat: 59.3797, lon: 28.1791 }, // Narva
];
/** Warendorf (Germany): the Marktplatz municipal webcam from a curated catalog file. */
export const DEFAULT_WARENDORF_SOURCE_FILE =
  'config/cctv_sources.warendorf.json';
export const WARENDORF_IMAGE_ORIGINS = Object.freeze([
  'http://webcam.warendorf.de/',
  'https://www.kreis-warendorf.de/',
]);
/** Live Traffic NSW (Transport for NSW): keyless public camera catalog. */
export const NSW_CAMERAS_URL =
  'https://data.livetraffic.com/cameras/traffic-cam.json';
export const NSW_IMAGE_ORIGIN = 'https://webcams.transport.nsw.gov.au/';
export const DEFAULT_NSW_MAX_SOURCES = 250;
export const SYDNEY_CENTER = { lat: -33.8688, lon: 151.2093 };
/**
 * The NSW webcam host answers non-browser clients with HTTP 200 and a short
 * HTML body instead of the frame (verified 2026-09-13), so the proxy
 * identifies as a browser for that one host. See media.js.
 */
export const NSW_IMAGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/**
 * Longest NSW `view` sentence still usable as a label. NSW occasionally
 * repurposes `view` for a multi-paragraph works notice; real descriptions top
 * out around 120 characters.
 */
export const NSW_MAX_VIEW_LABEL = 140;
/** Open Calgary traffic cameras: one keyless Socrata endpoint for the whole
 * city; frames are stills on a City of Calgary host. */
export const DEFAULT_CALGARY_ROWS_URL =
  'https://data.calgary.ca/resource/k7p9-kppz.json?$limit=500';
/** The only origin Calgary camera frames may come from. The catalog publishes
 * most rows as `http://`; that host serves HTTPS and 301-redirects to it, so
 * URLs are upgraded and then pinned here before registration. */
export const CALGARY_IMAGE_ORIGIN = 'https://trafficcam.calgary.ca/';
export const DEFAULT_CALGARY_MAX_SOURCES = 220;
/** Centre Street / 7 Avenue: the prioritization anchor. */
export const CALGARY_DOWNTOWN = { lat: 51.0461, lon: -114.0626 };
/** Hard ceiling on the Calgary catalog body. The whole city is ~215 rows and
 * under 100 KB; this only exists so an upstream that streams an unbounded
 * body cannot be buffered without limit. */
export const CALGARY_MAX_CATALOG_BYTES = 4 * 1024 * 1024;

/**
 * Catalonia traffic cameras (Servei Català de Trànsit): one keyless WFS/GML
 * XML list (verified 2026-09-15, hourly catalog refresh), fetched over https
 * (verified 2026-09-27: same 200 body, no redirect). The feed carries a
 * `font` field naming the actual publisher per camera — SCT's own highway
 * cameras plus hotlinked Barcelona (IMI) and Terrassa municipal cameras are
 * kept, each confirmed to return a real frame. Frame URLs are checked
 * against a host allowlist rather than one pinned origin, since each
 * publisher serves from its own host.
 */
export const CATALONIA_CAMERAS_URL =
  'https://www.gencat.cat/transit/opendata/cameres.xml';
/** Byte ceiling for the Catalonia catalog read (~90 KB observed 2026-09-27),
 * so a runaway body cannot be buffered without limit. */
export const CATALONIA_MAX_CATALOG_BYTES = 1024 * 1024;
/** Allowed image hosts, one per kept `font` publisher in the feed, each
 * mapped to the one directory its frame links live in (every link in the
 * 2026-10 feed shares it); a link must name a single file directly inside. */
export const CATALONIA_IMAGE_HOSTS = Object.freeze(
  new Map([
    ['mct.gencat.cat', '/mct2bo/'], // SCT
    ['www.bcn.cat', '/transit/imatges/'], // IMI (Ajuntament de Barcelona)
    ['emap.terrassa.cat', '/it_terrassa/'], // Ajuntament de Terrassa
  ]),
);
/** SCT `sctidcam` values: a bare image filename, which also keys the camera
 * id (the feed's `fid` embeds an upstream server-start stamp). */
export const CATALONIA_SCT_CAMERA_FILE_RE = /^[a-z0-9]+\.(gif|jpe?g)$/i;
/** Per-`font` partner credit, shown beside the provider in the CCTV panel
 * (same pattern as DriveBC's partner-supplied cameras). SCT is the feed's
 * own publisher and carries no separate credit. */
export const CATALONIA_FONT_CREDIT = Object.freeze({
  IMI: 'Ajuntament de Barcelona',
  Terrassa: 'Ajuntament de Terrassa',
});
/** Ground-elevation priors in metres, by `font`: the feed carries no
 * elevation, and this pack spans sea level (Barcelona) to Terrassa's plateau
 * (~270 m). The client's ground snap corrects these on 3D-tile stacks. */
export const CATALONIA_FONT_ELEVATION_M = Object.freeze({
  SCT: 80,
  IMI: 20,
  Terrassa: 270,
});
export const DEFAULT_CATALONIA_MAX_SOURCES = 150;
/** Prioritization anchors: Barcelona and Terrassa. */
export const CATALONIA_ANCHORS = [
  { lat: 41.3874, lon: 2.1686 }, // Barcelona
  { lat: 41.5636, lon: 2.0111 }, // Terrassa
];

/** Statens vegvesen (Norway) road cameras: the keyless OGC API Features view
 * of the official DATEX 3.1 CCTV site table, one GeoJSON request for the whole
 * country (~900 cameras). The raw DATEX node needs an account; this view does
 * not. Frames are stills on the agency's camera host. */
export const DEFAULT_VEGVESEN_CCTV_URL =
  'https://ogckart-sn1.atlas.vegvesen.no/ogc/features/v1/collections/datex_3_1:CctvSimple/items?f=application/geo%2Bjson&limit=5000';
/** The only origin Vegvesen camera frames may come from. */
export const VEGVESEN_IMAGE_ORIGIN =
  'https://kamera.atlas.vegvesen.no/api/images/';
/** Live HLS for the ~140 cameras that publish video; only this exact
 * per-camera manifest path is registered. */
export const VEGVESEN_VIDEO_URL = (cameraId) =>
  `https://kamera.vegvesen.no/public/${cameraId}/manifest.m3u8`;
/** Above the ~850 working cameras so the pack keeps them all on its own. The
 * catalog-wide DEFAULT_CCTV_MAX_SOURCES cap still applies across packs and is
 * filled round-robin, so a full default install may thin this pack. */
export const DEFAULT_VEGVESEN_MAX_SOURCES = 900;
/** Hard ceiling on the catalog body. The whole country is ~800 KB. */
export const VEGVESEN_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
/** Prioritization anchors: the largest cities from south to north, so a cap
 * keeps national coverage rather than just the capital region. */
export const NORWAY_ANCHORS = [
  { lat: 59.9139, lon: 10.7522 }, // Oslo
  { lat: 60.3913, lon: 5.3221 }, // Bergen
  { lat: 58.97, lon: 5.7331 }, // Stavanger
  { lat: 63.4305, lon: 10.3951 }, // Trondheim
  { lat: 58.1467, lon: 7.9956 }, // Kristiansand
  { lat: 67.2804, lon: 14.4049 }, // Bodø
  { lat: 69.6492, lon: 18.9553 }, // Tromsø
];

/** NYC DOT Traffic Management Center cameras: one keyless JSON list for the
 * five boroughs (~980 cameras). Frames are stills synthesized from each
 * camera UUID on the city's webcam host — never taken from the payload. */
export const NYC_CAMERAS_URL = 'https://webcams.nyctmc.org/api/cameras';
/** The only origin NYC camera frames may come from. The catalog's `imageUrl`
 * is ignored; the registered path is always this origin plus a validated
 * UUID plus `/image`. */
export const NYC_IMAGE_ORIGIN = 'https://webcams.nyctmc.org/api/cameras/';
export const NYC_IMAGE_URL = (id) => `${NYC_IMAGE_ORIGIN}${id}/image`;
export const NYC_CAMERA_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_NYC_MAX_SOURCES = 250;
/** Hard ceiling on the NYC catalog body. The live list is ~980 rows / ~250 KB;
 * this only exists so an upstream that streams an unbounded body cannot be
 * buffered without limit. */
export const NYC_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/** Ground-elevation prior in metres. Matches the New York CITY_POIS prior;
 * the client's one-shot ground snap corrects it wherever 3D tiles load. */
export const NYC_GROUND_ELEVATION_M = 10;
/** Prioritization anchors: one per borough so a cap keeps citywide coverage
 * rather than Midtown alone. */
export const NYC_ANCHORS = [
  { lat: 40.758, lon: -73.9855 }, // Manhattan (Times Square)
  { lat: 40.7128, lon: -74.006 }, // Lower Manhattan
  { lat: 40.6782, lon: -73.9442 }, // Brooklyn
  { lat: 40.7282, lon: -73.7949 }, // Queens
  { lat: 40.8448, lon: -73.8648 }, // Bronx
  { lat: 40.5795, lon: -74.1502 }, // Staten Island
];

/** DelDOT CCTV: one keyless statewide JSON catalog; live video via RTMP-over-HTTP (rtmpt:80). */
export const DELDOT_CCTV_URL = 'https://tmc.deldot.gov/json/videocamera.json';
export const DEFAULT_DELDOT_MAX_SOURCES = 300;
export const DELDOT_ANCHORS = [
  { lat: 39.7459, lon: -75.5466 }, // Wilmington (New Castle)
  { lat: 39.1582, lon: -75.5244 }, // Dover (Kent)
  { lat: 38.6906, lon: -75.3877 }, // Georgetown (Sussex)
];

/** King County, WA road cameras: keyless public ArcGIS FeatureServer layer
 * ("King County and WSDOT Traffic Cameras", King County DOT Road Services).
 * GeoJSON with WGS84 point geometry. `outFields` is an explicit list on
 * purpose: the layer also carries asset-administration columns (including
 * staff names in `ModifiedBy`) that must never be fetched. Uniquely among the
 * packs, the county publishes each camera's hardware `Manufacturer`/`Model`
 * (Cohu 3950/3965, Bosch AUTODOME, Axis Q6135-LE, …), carried through as the
 * source's `model`. */
export const KING_COUNTY_CAMERAS_URL =
  'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/TRAFFICCAMERA_POINT_2029/FeatureServer/0/query?where=1%3D1&outFields=AssetID,Location,ImageURL,Live,Model,Manufacturer,Owner,CurrentStatus&f=geojson';
/** Frames come only from the county's own image handler host. */
export const KING_COUNTY_IMAGE_ORIGIN = 'https://info.kingcounty.gov/';
/** The whole catalog is ~125 rows (~59 live county cameras); no thinning by
 * default. */
export const DEFAULT_KING_COUNTY_MAX_SOURCES = 125;
/** Prioritization anchor: Renton, roughly central to the county road network. */
export const KING_COUNTY_ANCHORS = [{ lat: 47.4829, lon: -122.2171 }];
/** Hard ceiling on the King County catalog body. The whole layer is ~125 rows
 * and well under 100 KB; this only exists so an upstream that streams an
 * unbounded body cannot be buffered without limit. */
export const KING_COUNTY_MAX_CATALOG_BYTES = 1024 * 1024;
/**
 * City of Toronto RESCU traffic cameras: the municipal network the province's
 * 511 pack does not cover — downtown arterials plus the Gardiner, DVP, Allen
 * and Lake Shore. One keyless list for the whole city (~336 cameras), from the
 * City's open data portal. It is fetched on every catalog refresh, but the
 * upstream file is not updated often and may lag the live camera network.
 *
 * The list is served as JSONP (`jsonTMCEarthCamerasCallback({...})`); the
 * portal publishes the same data as .xml and .csv beside it.
 */
export const TORONTO_RESCU_LIST_URL =
  'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/Data/tmcearthcameras.json';
/**
 * The only origin Toronto camera frames may come from. The list carries no URL
 * field: frame URLs are BUILT from this origin and a strictly-digits camera
 * number (`loc####.jpg`, the convention the dataset documents), so no upstream
 * field can steer the frame proxy off-host.
 */
export const TORONTO_RESCU_IMAGE_ORIGIN =
  'https://opendata.toronto.ca/transportation/tmc/rescucameraimages/CameraImages/';
/** The whole city fits under this; the cap exists to stay tunable, not to trim. */
export const DEFAULT_TORONTO_MAX_SOURCES = 336;
/** Yonge / Queen: the prioritization anchor. */
export const TORONTO_DOWNTOWN = { lat: 43.6532, lon: -79.3832 };
/** The city climbs from 76 m at the lake to 209 m at Steeles, so no single
 * number fits: this is the mean across the 336 camera sites. The ground-height
 * sidecar has no Toronto entries yet, so this prior seeds placement; a camera
 * that gains a sidecar entry uses it instead, and the client's ground snap
 * corrects the prior wherever 3D tiles are loaded. */
export const TORONTO_GROUND_ELEVATION_M = 116;
/** Hard ceiling on the RESCU list body. The whole city is ~336 rows and under
 * 60 KB; this only exists so an upstream that streams an unbounded body cannot
 * be buffered without limit. */
export const TORONTO_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/** WSDOT Travel Center cameras (Washington State): keyless Esri JSON on the
 * official open-data host — ~1,700 point features in EPSG:3857 (Web Mercator),
 * ETag/Last-Modified served. WSDOT's metadata marks the feed "low volume" use;
 * the catalog is fetched once per CCTV_SOURCE_CACHE_MS refresh. */
export const WSDOT_CAMERAS_URL =
  'https://data.wsdot.wa.gov/travelcenter/Cameras.json';
/** Only frames on WSDOT's own image host are registered; the catalog also
 * lists ~70 partner cameras (Oregon DOT, City of Seattle, lodges, airports)
 * whose own terms apply. */
export const WSDOT_IMAGE_ORIGIN = 'https://images.wsdot.wa.gov/';
export const DEFAULT_WSDOT_MAX_SOURCES = 250;
/** Hard ceiling on the WSDOT catalog body. The live layer is ~400 KB; this
 * only exists so an upstream that streams an unbounded body cannot be
 * buffered without limit. */
export const WSDOT_MAX_CATALOG_BYTES = 4 * 1024 * 1024;
/** Prioritization anchors: downtown Seattle and Spokane. */
export const WSDOT_ANCHORS = [
  { lat: 47.6062, lon: -122.3321 }, // Seattle
  { lat: 47.6588, lon: -117.426 }, // Spokane
];

/** Camera CATALOGS change rarely; 15 min keeps multi-megabyte upstream list refetches (Austin rows.json + 4 Caltrans districts + TfL + Ontario 511) infrequent. Frames are fetched per-request and are unaffected. */
export const CCTV_SOURCE_CACHE_MS = 15 * 60 * 1000;
/** Per-provider catalog-fetch timeout. Bounds the worst-case refresh so one
 * stalled upstream can't leave getCctvSources (and thus every CCTV route)
 * pending forever — a hung fetch aborts, the loader returns [], and
 * serve-stale/other packs take over. */
export const CCTV_SOURCE_FETCH_TIMEOUT_MS = 15 * 1000;
/** Individual CCTV image fetches must settle before the active 10-second
 * client refresh cadence. A bounded miss can fall through to Street View or
 * the synthetic frame instead of leaving the browser preview pending. */
export const CCTV_FRAME_FETCH_TIMEOUT_MS = 8 * 1000;

/** Maximum buffered snapshot size. */
export const CCTV_FRAME_MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Deadline for upstream response headers; live bodies keep streaming afterward. */
export const CCTV_MEDIA_FETCH_TIMEOUT_MS = 15 * 1000;
/** Silence a live body may carry before the relay gives up on it. Twice the
 * header deadline, because a camera that is merely slow between frames is far
 * more common than one that has died mid-stream, and a viewer would rather
 * wait than be dropped. */
export const CCTV_MEDIA_IDLE_TIMEOUT_MS = 30 * 1000;
/** Declared size ceiling for fixed media responses. */
export const CCTV_MEDIA_MAX_BODY_BYTES = 64 * 1024 * 1024;
