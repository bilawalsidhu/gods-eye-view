# Changelog

- Aim the CCTV Street View fallback at the registered camera pose and meter it
  per client. `/api/cctv/frame/:id` no longer honours `lat`/`lon` from the query
  string, no longer falls back for an unregistered camera id, rejects an
  off-globe or absent pose before the request is made, and admits at most 240
  lookups per minute per client (720 across all clients). Frames for registered
  cameras are unchanged; a refused lookup serves the existing synthetic card.

- Enable responsive trackpad pinch zoom on the globe. Browser pixel-mode
  `Ctrl+wheel` pinch gestures now reach Cesium with bounded amplification,
  while ordinary wheel, line-mode and touch-pinch inputs retain their existing
  behavior; the listener is removed with the application scene.

- Report AIS speed and course that carry the standard "not available" code as
  unknown instead of 102.3 knots and 360 degrees. Genuine readings, including a
  stopped vessel's zero and the highest encodable values, are unchanged.

- Render native `<select>` option lists in the dark UI palette. The closed
  controls were already skinned, but the browser-painted popups fell back to the
  platform light palette, leaving near-white option text on a white surface in
  the HUD layout, Scenes, CCTV camera, Radio filter and Draw colour menus.

- Credit adsbdb, which supplies the aircraft type, model name and registration
  on enriched flights and the airline and origin/destination pair behind the
  tracked contact's route strip. `DATA_SOURCES.md` now records adsbdb's
  published credits and route-data restriction, along with the request bounds
  and gitignored 24-hour local cache. A matching `DATA_CREDITS` entry surfaces
  the credit in the in-app Data attribution popover, and a test protects it
  against accidental removal.

- Size the TomTom daily tile budget to the provider's real free allowance.
  `TOMTOM_DAILY_TILE_BUDGET` defaulted to 40,000/day against an allowance
  granted monthly (200,000 tile requests/month), exhausting a month in five
  days and leaving the traffic layer dead for the rest of the period. The
  default is now 6,000/day (186,000 over a 31-day month). Corrects the stale
  "~50k/day" free-tier figure in the proxy, `.env.example` and
  `DATA_SOURCES.md`. Still an application-side ceiling, not a billing cap.

- Distinguish PARTIAL vessel snapshots from STALE data in the layer panel, with
  accepted-record counts and unchanged retention, freshness and outage safeguards.

- Keep Nepal provider media inside the Pinokio compatibility boundary: use
  source-linked fallback cards instead of automatic embeds or hidden preloads
  that launch an external browser. Ordinary browsers retain embedded playback.
  Source-only timed shots use their authored card dwell and continue normally.
  Media autoplay now requires a live Play Scene or Play Shot action; passive
  loading, saved state and seeking do not grant playback authority.

- Add Director import previews, validated scene/shot detail drafts and selected-scene
  JSON or asset-bundle sharing. Preserve attribution; verify bounded bundle bytes
  before admission and release staged work on cancellation or teardown.

- Director scene documents now support bounded data-pack manifests, per-shot
  selection and registered GeoJSON/PNG/media loaders with explicit placement,
  visible attribution and cancellation/disposal on Stop or replacement.

- Director version 4 adds named camera anchors and explicit pose-to-pose moves
  with shared playback/seek interpolation, easing and holds. Navigation and
  manual input cancel authored motion; older scene files retain existing flights.


- Director validates bounded version-3 scene files before replacing a project,
  preserves unreadable browser saves, migrates legacy bloom once and preserves
  zero-pitch/low-altitude camera and scope/detection edits. Project normalization has a separate owner.


- Separate Director timing, seek calculations, playback clocks and registered
  scene-pack presentation rules. Preserve authored content and controls; Stop
  releases pending hold timers and stale ticks cannot affect replacement playback.


- Keep parked transit vehicles aligned to their world course during camera orbits, fall back to reported bearing, and keep vehicles with no course consistently screen-up.

- Separate Realtime connection, response/tool, Radio, input/audio, cost, viewport
  and diagnostic ownership while preserving voice controls and protocol behavior.
  Revoke stale connection offers/capture callbacks and release failed or stopped audio
  meters. Discard late action continuations after Stop or restart; add recorded
  push-to-talk acceptance alongside click-start voice.

- Separate application-shell responsibilities and state ownership while preserving
  the layer, scene and voice API. Revoke pending globe-reset callbacks on disposal
  and detach old Directions services when replacing a data manager.
- Transit: keep the normal vehicle silhouettes under NVG, thermal and noir (opaque white, CRT sizing, a 2 px dark halo) instead of solid bodies; drape the selected vehicle's trail onto Google 3D tiles and terrain so retained history is actually visible, with the head clipped to the sprite and markers recovering as soon as the camera arrives; place Transit in the Movement panel between Street Traffic and Bike Share.

- Extract a portable Director shot runner and connect existing scene playback to
  it. Preserve authored content, project files, camera/layer behavior and source
  attribution; document the planned timeline, scene-file and data-pack boundaries.

- Separate map-feature acquisition from annotation/search selection. Move road and mapped-installation decoding into source adapters while preserving geometry policy, cancellation, retry outcomes and compatibility exports.

- Cancel hidden Nepal provider preloads on Stop, event disable and replacement, and respect drawing-tool pointer ownership for fallback evidence cards. Preserve @manjunath22466’s Nepal scene contribution and source attribution.

- Cancel the Nepal Upper Valley locator's pending approach and orbit on scene Stop, replacement, seek, and teardown; late camera callbacks cannot take over a newer shot.

- Keep completed flood history visible when later Nepal media-only shots arrive and reveal their source cards.
- Reconcile an already-playing Nepal video when the YouTube API attaches, so missed playback notifications cannot truncate the seven-second clip or replay an already-ended clip.

- Clamp the Nepal flood trail and surge marker to the active terrain or photoreal surface so refined 3D tiles cannot bury the path.

- Preserve Nepal shot camera and map ownership through the public layer lifecycle; passive restoration does not start standalone playback.

- Separate transit snapshot/history acquisition from the layer and expose its bounded request service independently of Vite. Preserve feed selection, playback, cache policy and compatibility exports.

- Widen opaque sensor halos to 3 display pixels with a 30 px fleet core while retaining at least 60% opaque core coverage, adding contrast margin through thermal blur and bloom on bright roofs.

- Exclude Noir's intentionally vignetted outer field from transit core measurements and add separate Boston live oblique selection/readability coverage.

- Judge NVG transit readability by phosphor peak and halo contrast, use opaque black sensor halos, reject overlapping pixel samples, and report each selected-trail acceptance condition. Simplify transit source credits and ground-placement wording.

- Reserve numeric playback scratch before sampling, including resolved transit surface heights, and reuse the same output and segment objects on every frame.

- Keep moving and stationary transit above CCTV/Bikeshare consistently, and share camera sensitivity across the actual Traffic, Bikeshare and Transit lifecycles.

- Reject isolated transit history outliers without changing the active playback bracket; rejected live reports retain the last accepted route, mode and detection text.

- Isolate optional scene-card presentation callbacks from the shared overlay projection path, preserving ordinary-layer allocation budgets and recovering from failed animation callbacks.

- Rename scene shots inline with a double-click; Enter or focus loss saves, and Escape cancels.
- Stop scene playback and delayed media when its event layer is explicitly closed; reject stale seek and replay completions. Ship only the Nepal incident default, without a separate reconstruction recipe.

- Keep Nepal flood and locator components available through Scenes without separate entries in Data Layers.

- Start the shared Nepal flood route at the Debris-Dammed Lake river reach, removing the earlier upstream section from overview paths.

- Remove the redundant WITNESS panel shortcut; retain per-shot source media and Open Original links.

- Follow the Mailung Bazzar, Dandaguan video's source clock through 0:07 and advance after its brief fade-out, including older saved scenes. Bound delayed or blocked playback and cancel late provider callbacks on Stop or replacement.

- Keep the completed flood trail visible during the Debris-Dammed Lake to Second landslide camera handoff, without revealing the next reach early.

- Preserve loaded base imagery when successive scene shots use the same provider, avoiding a bare-globe flash at shot handoffs.

- Add the Nepal Flood Incident scene with geographic labels, synchronized event controls, linked witness sources, and Vantor comparison imagery over Esri. Nepal uses Google 3D when available and falls back to Esri with keyless terrain without rewriting saved shots. Bundled event imagery and derived data retain their separate non-commercial terms.

- Add an optional Nominatim geocoding adapter with configurable search/reverse endpoints, cancellation, bounded responses and retryable upstream errors. Extract portable response-reading and Overpass lexical helpers while retaining existing server exports.

- Expose reference feed factories independently of standalone catalog construction; preserve source choices and asset attribution.

- Add source-only layer exports and enforce source, browser, standalone and voice import directions. Move plain record/feed helpers and settings filesystem hardening to their owners while preserving compatibility and behavior.

- Separate voice session lifetime and common controls from the default Realtime protocol adapter.
- Add live public transit: vehicles from seven open GTFS-Realtime feeds played back a lag behind real time at their reported speed, a selected-vehicle trail with bounded MBTA history caching, mode-coloured detection brackets in every preset, and sprites that stay readable in night-vision and thermal views.
- Separate canonical voice action arguments from descriptive wording, preserving the existing Realtime tool inventory.

- Expose portable radio, camera-type and regional source helpers; keep HTTP transport separate from record normalization.

- The Realtime debug-log endpoint is bounded on every axis it was not: an always-on per-client rate limit, asynchronous appends through a serialized queue instead of a synchronous write on the request path, and rotation of the log file at 32 MB keeping one prior generation. The 8 MB cap applied to a single request body and never to the file those requests accumulated into, so any local page could grow it for as long as the dev server ran. A malformed record and a failed write are now told apart, 400 from 500, and neither answer carries the error text.

- Three proxy paths no longer relay upstream or JS error text to the client. The HUD summary passed OpenAI's own `error.message` through whenever upstream was not ok, carrying request ids and quota wording; the Realtime token route passed through non-success response bodies and echoed JS errors, which can expose upstream details; and a failed CCTV media fetch stored the raw errno as the camera's health message, which reaches the screen through `GET /api/cctv/health` rather than through the sanitized response beside it. Logs now name the failure and the upstream status without the text.

- Separate vessel records and feed acquisition from rendering while preserving selection, partial-feed retention, sea-surface placement and request cancellation.

- Separate military-flight records and acquisition from rendering while preserving ground-model ownership, source units and follow behavior.

- Separate civil-flight acquisition and record reconciliation from Cesium resource updates, preserving source timing, ground placement and tracking behavior.

- Separate navigation, share restoration, visual settings and panel state into focused UI owners with explicit dependencies and terminal cleanup.

- Separate layer lifecycle transactions from panel construction and render/detection reactions; retain existing transition and refresh behavior.

- Let CLI tools, development launchers and the setup doctor use an explicit project directory while retaining their existing default paths.

- Split application scene, controls, catalog, tools and HTML into reusable components; configure application request services and sources without changing global fetch. Preserve standalone markup and voice behavior. Explicit annotation navigation may resolve a distant named target.

## Voice component boundaries

- Separate voice controls, Realtime connection requests and the action runner.
- Allow compatible endpoints and server-selected models through construction options.
- Cancel pending token/SDP requests on Stop or teardown and reject expired secrets.

## Configurable geospatial services

- Compose geocoding, place context and routes through independent providers.
- Allow compatible endpoint configuration without changing voice tools or annotation behavior.
- Isolate configured source caches and reject results after cancellation.

## ALPR camera locations

- Port Manjunath's (@manjunath22466) cyan camera badges, coral selection brackets,
  gradient direction wedges and animated tactical labels into the reusable ALPR
  layer. Keep bounded source loading, stable entities, selection and SHOW NEAREST.
- Align the ALPR layer-row header with other layers, keeping the toggle beside
  the name instead of wrapping it onto its own line.

- Label the loaded camera count as nearby, show a purple-dot legend, and add
  SHOW NEAREST to frame and select a loaded camera when none are on screen,
  using the available 3D-tile or globe terrain height.

- Keep nearby camera markers and selection stable during rotation, use bounded
  ground-centered coverage instead of the horizon rectangle, and reuse in-flight queries.

- Add optional, source-labeled OpenStreetMap ALPR camera locations, bounded city queries,
  cached-response and coverage notices, selection cards, share links, and voice toggles.
- Separate the request adapter, camera model, presentation, and instance lifecycle.
  Source cancellation also guards late response bodies and rejects invalid query bounds.

## Release disabled infrastructure rendering

- Remove built Data Center, Dam and Submarine Cable entities when their layers
  are disabled, avoiding retained visualizer work and entity memory.
- Keep parsed datasets cached for re-enable; rebuild entities without refetching.

## Camera layer components

- Separate camera source requests, placement, frames, projection, cards and calibration.
- Own visibility listeners and pending initialization within each layer lifetime.
- Preserve existing camera catalogs, URL families, geometry and playback behavior.

## Traffic and bikeshare components

- Separate traffic loading, animation, styling and lifecycle into factory-owned components.
- Give each flow source its own bounded decode cache and cancellation checks.
- Separate bikeshare registry, station requests, rendering, selection and proximity handling.

## Installation and context components

- Separate mapped-site requests, records, placement, selection and viewport lifecycle.
- Separate proximity queries, subject tracking, navigation/history, panel and direction rendering.
- Retain source and ground-floor ownership in standalone composition; reject malformed
  installation snapshots and ignore failures from cancelled requests.

## Satellite and mission layer components

- Separate catalog loading, orbit calculations, display, tracking and interaction
  into instance-owned satellite components.
- Separate mission ingestion, paths, placement, cards, roster, replay and camera
  operations, retaining existing layer controls and satellite coordination.
- Cancel late mission source work and reject malformed launch snapshots.

## Fire layer components

- Split fire source loading, state, rendering, cards, selection and viewport work
  into reusable components with application-owned scene services.
- Cancel late refreshes, retain good data after malformed responses, and preserve
  selection identity without repeating a user-selection notification on refresh.

## Earthquake components

- Separate earthquake snapshot loading, record validation, and display ownership.
- Cancel pending earthquake refreshes on disable or destruction, retaining the
  last good snapshot after malformed or failed refreshes.

## September 8, 2026

Earthquake refreshes validate the complete feed and construct replacement entities before clearing the previous snapshot. Malformed rows and duplicate rendered IDs retain the last good entities, overlays, count and timestamp and report a malformed response; unknown magnitude is excluded from M2.5+ rendering.

Non-object or array-valued properties reject the response instead of being treated as an unknown magnitude.

Launch payloads with missing records now say PAYLOAD DATA UNAVAILABLE. Missing names use Unnamed payload; absent or invalid mass stays unknown instead of appearing as 0 KG.

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased]

- Add bounded Director feature actions with accessible controls, explicit camera/layer admission and cancellation; restore pack geometry on same-shot seek. Preserve existing scenes and content attribution.


- Give application request services, terrain/floor caches and annotation lookup state explicit owners and cancellation; share them across controls, layers and voice.

- Construct application layers from explicit sources, with standalone provider selection and catalog-owned aircraft classification; controls and voice queries use those instances.

- Let application data and controls receive the same explicit layer catalog; keep standalone defaults and registration-before-restoration ordering.

- Expose existing FIRMS CSV parsing and UTC time-window helpers through a portable package export, with shared contract fixtures.

- Separate map source factories from switching and resource ownership; retain current source IDs, attribution and fallbacks.

- Separate radio directory loading, station selection, globe presentation and playback into composed components with an explicit metadata source.

- Separate submarine cable sources and rendering components, and export bundled geography lookup modules.

### Added

- DISPLAY ▸ Draw: draw on the world by hand. Pick Area, Line or Pin, click the
  vertices, double-click or press Enter to finish, label and colour it; Backspace
  undoes a vertex, Esc cancels the shape and a second Esc leaves draw mode, and
  Clear wipes the board. Drawn shapes go through the same annotation engine as
  spoken ones, so they render with the whiteboard look, persist, de-dup and clear
  together. While you are drawing, the draw tool owns the pointer and no layer
  selects what you click through (#235 — thanks @cora-fresh-labs).

### Fixed

- Keep traffic-road bounds crossing the antimeridian monotonic and inside the
  longitude range accepted by the Overpass request path, preserving the small
  wrapped span instead of producing an inverted or rejected box (#392 — thanks
  @Ashfaqbs).
- Make `npm run doctor` report keyless anonymous OpenSky access for explicit
  `OPENSKY_AUTH_MODE=anon` and OAuth mode without a client pair, retain the
  existing OAuth-pair capability wording, and identify selected Basic or auto
  modes without guessing their eventual credential choice. OpenSky proxy
  authentication is unchanged.
- Bikeshare stations load again. The extracted station source addressed the
  proxy as `/api/gbfs?url=`, but the proxy reads its upstream target from the
  path, so every request answered 400 and the layer reported a fetch error for
  every city (#441 — thanks @MiguelGFerreira).
- Overpass requests now carry a User-Agent that names the application, its
  version and the project address, which is what the OpenStreetMap API usage
  policy asks for; the previous string identified neither. A mirror may refuse
  a client it cannot identify, and a refused mirror is one the fan-out has to
  skip, so this affects every Overpass-backed layer: Mapped Installations,
  traffic roads and annotation geometry. Mirror rotation, cooldown and cache
  admission are unchanged (#420 — thanks @GladiatorrX9).
- Place search has a last resort. With no Google Maps key, and when Photon does
  not answer, a named-place search now falls back to OpenStreetMap's Nominatim
  through `/api/geocode`, so search and voice fly-to still work on a keyless
  globe. The route keeps to the service's usage policy: an identifying
  User-Agent and Referer, at most one request per second, answers cached, one
  upstream call shared between identical searches in flight, a bounded queue so
  a burst is refused rather than held, and a queued search dropped once its
  caller has given up (#350 — thanks @sendmebits).

- Regional upstream reads now hold their deadline through the response body. The
  abort timer was cleared as soon as the headers arrived, so an upstream that
  answered and then stalled mid-body had no deadline at all. Redirect policy is
  now stated per call rather than inherited, and the fixed Nominatim endpoints
  refuse to be redirected.

- The location search box answers two kinds of query without a network request
  or an API key. A decimal-degree coordinate — `43.1731, -79.0384`, or either
  order when N/S/E/W say which is which — flies straight there; a bundled city
  or landmark name typed exactly (`paris`, `sf`, `Golden Gate Bridge`) flies to
  the bundled place. Anything else, including anything malformed, goes to the
  existing geocoders unchanged. Degrees/minutes/seconds and grid references are
  not parsed and fall through the same way (#388 — thanks @KuraPiee).
- A data-layer control a provider key is holding back now names that key. With
  no FIRMS key the fire layer's control read KEY REQUIRED without saying which
  key or where to put it; it now reads "Needs FIRMS_MAP_KEY — add it in Provider
  Settings", on the control and in its accessible name. A layer that needs no
  key, or already holds one, carries no such text, and an unrecognised key name
  produces none rather than a guess (#296 — thanks @Matthew-Selvam).

- Draped annotation geometry — area fills and outlines, routes and arrows —
  classifies onto terrain as well as 3D tiles. On a keyless boot, where Cesium's
  own globe carries the imagery, marks previously rendered their labels and no
  geometry at all. This affected spoken annotations as much as hand-drawn ones.

- A finished drawn area closes its ring, so its outline no longer misses the
  edge back to the first vertex.

- Areas measured and anchored across the antimeridian use unwrapped longitudes:
  a shape straddling 180° reported an area thousands of times too large and
  placed its label on the opposite side of the world.

- Traffic now retries a failed destination after city navigation without a layer
  toggle. Camera departure cancels pending work, arrival checks the final view,
  and superseded requests cannot keep a newer view loading.

### Added

- Two map-orientation controls sit beside Share in the top-center globe
  actions. Tilt Map swings between a straight-down map and a 35-degree oblique
  around the point under the centre of the view, keeping that point and the
  distance to it. North Up rotates around the same point until north is at the
  top, keeping the pitch, and its needle shows the current bearing. Both decline
  without moving the camera when nothing is under the centre of the view, and
  both follow Reset Globe out of Clean UI, recording, Scene playback and Cockpit
  (#442 — thanks @yashveeeeeeer).
- The location search box answers two kinds of query without a network request
  or an API key. A decimal-degree coordinate — `43.1731, -79.0384`, or either
  order when N/S/E/W say which is which — flies straight there; a bundled city
  or landmark name typed exactly (`paris`, `sf`, `Golden Gate Bridge`) flies to
  the bundled place. Anything else, including anything malformed, goes to the
  existing geocoders unchanged. Degrees/minutes/seconds and grid references are
  not parsed and fall through the same way (#388 — thanks @KuraPiee).

- Add Open Calgary traffic cameras as a keyless CCTV source pack (thanks
  @rileygramlich): the public City of Calgary catalog, frames pinned to the
  city's own host and upgraded to HTTPS, with the Open Government Licence –
  City of Calgary attribution. The dataset publishes no camera facing — its
  quadrant field and the quadrant suffix on each camera name are Calgary's
  address grid — so headings use the shared id-hash fallback at low confidence
  and are corrected with the calibration gizmo. `CCTV_CALGARY_MAX_SOURCES` sets
  the cap and `CCTV_CALGARY_ENABLED=0` turns the pack off.
- **Transit layer** — keyless buses, trams, subways, trains and ferries in
  Boston, Austin, Minneapolis–St Paul, Helsinki, the Netherlands, Norway and
  South East Queensland. Vehicles use delayed timestamp playback and explicit
  waiting states. Selection shows available recent history, mode-coloured cards
  and clear report ages; MBTA history can survive a browser reload while the
  proxy remains running. Heights are aligned to work with Google 3D tiles.
  Subways are projected to street level and their cards explain that choice.
  Visible animation, detection membership, history storage and proxy requests
  are bounded. Share links carry Transit as token `j`.

- Add Ontario 511 as a keyless CCTV source pack, including Kitchener-area
  highway cameras, with server-registered still URLs and attribution.
- CCTV Mesh adds Finland: Fintraffic road weather cameras, keyless, nationwide, 300 by default. Each camera view of a station is placed separately; ambient stills refresh on the source's 10-minute cadence (the active camera keeps the usual 10-second refresh).
- Add DriveBC highway cameras for British Columbia to the CCTV layer: the 250
  nearest Vancouver and Victoria by default, with Open Government Licence –
  British Columbia attribution. `CCTV_DRIVEBC_MAX_SOURCES` sets the cap and
  `CCTV_DRIVEBC_ENABLED=0` turns the pack off.
- Add TxDOT highway cameras for Texas as a keyless CCTV pack: the Austin and
  San Antonio districts by default (`CCTV_TXDOT_DISTRICTS` selects any of the
  25), only cameras reporting Device Online, snapshots decoded from TxDOT's
  JSON-wrapped JPEG for the official origin only.
- Add Estonia CCTV source packs: Tallinn intersection stills (`ristmikud.tallinn.ee`,
  curated catalog) and nationwide Transpordiamet / Tarktee road-weather cameras
  (DATEX2 locations + rotating JPEG URLs), with Tallinn city POIs and attribution.
- Add a Warendorf (Germany) source pack: the Stadt Warendorf Marktplatz webcam, with a
  curated pose.
- Add Live Traffic NSW (Transport for NSW, CC BY 4.0) as a keyless CCTV pack: 217
  Sydney and regional cameras with compass headings and view descriptions.
- CCTV monitor planes no longer clip into the terrain. The plane is lifted
  rigidly by the largest clearance deficit over a 3×3 grid of support points
  against the ground under each (the ground at the mount where nothing finer is
  known), and the client honours pack ranges instead of inflating them to 220 m.
  `src/data/local_data/cctv_ground_heights/` ships precomputed ground heights under
  every camera's mount and plane footprint (3,445 of 3,446 cameras), aligned to work
  with Google Photorealistic 3D Tiles; cameras with shipped heights are placed
  with zero runtime sampling, and the rest resolve the ground under their plane
  from the Re:Earth DEM on activation. The footprint lift is capped at 60 m
  above the mount-based lift so a tower under a far edge cannot launch the plane.

- Press backtick (`) to toggle a rendered-frame-rate readout beneath the logo.
  Typing fields retain the key; monitoring stops when hidden.

- Extract vessel feed, store, rendering, selection, trail and card components with explicit source and scene services.
- Bound contact retention for incomplete vessel observations, preserve source freshness and refresh history references in place.
- Cancel pending vessel history during selection and layer teardown.

- Split military flights into instance-owned state, ingestion, motion, rendering, tracking and query components. Share the existing aircraft calculations and give military classification an explicit source and cleanup lifecycle. Preserve known military identities even when the source has no position for them.

- Split civil flights into instance-owned state, ingestion, motion, rendering, tracking and query components. Cancel enrichment on teardown and resolve model assets through the application.

- Separate aircraft/vessel transport and normalization from layer rendering, preserving observation timestamps, altitude datums and optional history.
- Retain absent aircraft during partially admitted snapshots and bound source error messages.

- Drive share updates, Location feedback and Scene controls through immutable state snapshots and disposable subscriptions.
- Keep stale lookup/load completions from publishing accepted results and retain shot rows during playback progress updates.
- Export the existing Scene director with explicit playback and editing outcomes.

- Separate UI assembly from standalone engine wiring, with dedicated panel layout, position, notice and recording owners.
- Stop pending UI presentation and drag work during disposal; preserve accessible status text when stopping its decoration.
- Organize component styles behind the same ordered stylesheet entry and include 3D model controls in the current-state snapshot.

- Separate Scene controls and text presentation from project/playback operations; revoke replaced row listeners and suppress stale completion feedback.
- Preserve shot-label identity on selection so double-click rename can complete.

- Split Cockpit camera/controller, instruments, briefing, signals and layout into focused modules with explicit application operations.
- Give Display portal moves cancellable focus/scroll restoration and stop Cockpit work before asynchronous UI teardown.

- Separate Context controls, mode transitions and layer restoration; release tab listeners and suppress late panel/search feedback after disposal.

- Separate camera-panel controls, frame loading, calibration editing and status display; cancel stale image and calibration work on camera changes or disposal.

- Restore UI observer, resize-listener and CCTV subscription cleanup after Location extraction.

- Extract Radio controls and tuner presentation with explicit actions and complete listener/subscription cleanup.

- Extract Location controls and cancellable search presentation; preserve navigation handoff and prevent delayed POI expansion after closing the row.

- Separate Layers panel presentation and clear-control bindings from layer lifecycle operations; revoke listeners and subscriptions on replacement or teardown.

- Extract Map Source controls with listener cleanup and protection against obsolete selection feedback.

- Separate visual effects, presets and animation from Display controls, with explicit stage ownership and teardown.

- Extract Display control bindings with synchronous listener cleanup; preserve existing visual actions and native input behavior.

- Extract application shortcuts and shader-parameter controls into reusable UI
  components, preserving inputs and cleaning up listeners on rebuild/disposal.

- Extract adaptive panel rail placement and measurement into reusable UI modules,
  preserving obstacle clearance, responsive allocation, disclosure and scroll behavior.

- Extract shared surface keyboard handling for the welcome launcher and Provider
  Settings, preserving Tab/Escape behavior and releasing the listener on teardown.

### Added

### Security

- The CCTV media route no longer forwards a client `Range` header to the upstream
  camera host as it arrived. A single `bytes=` range is canonicalized and
  forwarded, with every accepted form — explicit span, open-ended and suffix —
  bounded to 64 MiB, the ceiling the relay already applies to a response that
  declares its length. A response that declares no length has no ceiling — live
  streamed media, and anything an upstream sends chunked while ignoring the
  `Range` — which is unchanged. Multi-range, malformed, inverted, non-`bytes` and
  unsafe-integer values are dropped and the request proceeds without a `Range`,
  as RFC 7233 §3.1 prescribes; a multi-range value previously invited a
  `multipart/byteranges` answer, whose parts nothing here reads. A value carrying
  CR or LF made the outbound request throw, and the route recorded the thrown
  message — which contains the caller's own string — as that camera's entry in
  the health report. A request the browser has stopped waiting for is now
  released: whether the viewer leaves while the camera is still answering or
  part-way through the picture, the upstream request is cancelled rather than
  left running, and neither case marks the camera degraded. Ordinary seeking is
  unaffected. Contributed by Maher-Reven (#253).
- CI pins `actions/checkout` and `actions/setup-node` to the commits their
  `v4.4.0` tags name, so a repointed tag cannot change what runs in CI. The
  version stays in a trailing comment, and moving to a later release is a
  deliberate edit. Contributed by SurefireStudios (#309).

- Validate configured Google Places coordinates and text queries before rate
  limiting or upstream requests; preserve the keyless capability response.
- Bound CCTV media response headers to 15 seconds and cancel error bodies.
  Cap buffered snapshot downloads at 16 MiB while streaming.

- Cancel the active location lookup when its controls are disposed.

### Fixed

- `DATA_SOURCES.md` states what the project does with camera frame content: a
  successful upstream response is relayed as the provider served it, nothing in
  the camera pipeline enhances it or recognises what is in it, resampling for
  display is the only change made to the picture, and no frame is written to disk.
  It also names what a viewer sees when an upstream has no frame — including a
  last good picture kept after a failed refresh — and the one feature that sends
  imagery anywhere: the voice assistant's viewport screenshot. Contributed by
  Lob26 (#357).
- Pinokio's Update shows what it is about to install before it installs it: the
  tracking branch, the remote it fetched from, the incoming commits and their
  diffstat. The remote is printed as host and path — a password or token in the
  URL's user field is replaced and any query string dropped, though a secret
  spelled as an ordinary path segment cannot be told from a repository name. It
  fetches once and applies exactly the revision it named, so a commit that lands
  mid-update cannot be installed unannounced. A git read it cannot complete is
  reported as such instead of as "already up to date", and if the revision to
  apply cannot be resolved at all the update stops without installing anything
  and exits unsuccessfully. Contributed by Lob26 (#356).
- On Windows, the credential-file hardening step verifies the file's permissions
  through the system PowerShell. A side-by-side PowerShell 7 install prepends its
  own module directories, which the 5.1 verifier cannot load, so the check failed
  and the credential was refused. The verify script now sets its module path from
  the running interpreter's own home, and the environment it is launched with
  carries that one value and no differently cased alias of it. The tests that
  cover it drive a stubbed process launcher, so what they check is the command
  and environment the code builds; the Windows onboarding CI job now also runs
  this file, where its one Windows-only case exercises the real hardener against
  real native tools. Contributed by michaelhan1208 (#161).
- The panel-recovery instructions in `docs/KNOWN-ISSUES.md`, `docs/CURRENT-STATE.md`
  and `scripts/dev-fresh.sh` describe what the interface does. The rails lay panels
  out themselves and write no stored position, so a CCTV panel that looks missing
  is collapsed or its layer is off; the collapsed-state key is what opens it, and
  the value to store is `'0'`, since removing the key returns the panel to its
  default, which is collapsed. A view opened from a share link is laid out from
  the link and ignores the stored value, so the console workaround is for ordinary
  loads only. A check keeps the documented keys and outcomes in step with the
  code. Contributed by vegettto (#408).

- Extract panel disclosure and hover/focus controls into a reusable module;
  cancel their listeners and pending work during replacement and teardown.

- Reuse cached military aircraft during adsb.lol rate limits and server errors,
  honor bounded retry delays, and preserve cached observation times and stale
  indicators. Show installation zoom guidance without a false LOAD FAILED.

- GBFS rejects upstream redirects, caps streamed responses at 5 MiB, and keeps
  its deadline active through body reads. Rejected downloads are cancelled.

- Split Overpass/installation search, regional briefing/weather, local voice
  handlers and standalone key setup into focused modules. Preserve routes,
  source behavior, tool schemas and credential restrictions.

- Restore data-provider routes under local build preview and return JSON 404s
  for unmatched API requests. Credential editing remains development-only.

- Extract CCTV catalog/media and Radio Browser directory providers into focused
  Node modules, preserving their routes and policies and isolating CCTV catalogs
  by provider instance and application root.

- Simplify POWER UP to one Google Maps entry. Keep the optional server key
  available through environment configuration without a second setup row or
  missing-key reminder.

- Separate terrain, traffic, FIRMS and GBFS middleware into focused provider
  modules, preserving local configuration, routes and cache/error behavior.

- Split satellite and launch-feed server providers into focused modules with
  portable request URL builders, preserving routes and cache/error behavior.

- Keep landmark names when geocoding returns only address components, preventing
  the United States Capitol annotation from moving to a Washington hotel.
  Unrelated outlines leave the valid geocoded marker in place.

- Split aircraft and vessel server providers into focused modules for source
  fetching, AIS records/tracks and shared request helpers; preserve existing
  routes, local setup, fallback behavior and rendering.

### Added

- **Directions layer** — keyless A→B directions without a geocoder or a
  microphone (thanks @spcpza). The row's chips arm a globe click for A and B
  (DRIVE / WALK / BIKE, SWAP, FLY, CLEAR); the route comes from the existing
  `/api/route` proxy (OSRM on the FOSSGIS servers), is draped on terrain and
  3D tiles with the same flowing dashes as voice routes, and drops one dot per
  maneuver. Below the chips is a compact keyboard-reachable ordered list of the
  turns — distance and instruction per step; click one to open that maneuver's
  card. FLY rides the shared route-flight cinematic through the same camera
  authority voice destinations use, highlights the step it is on as it goes,
  and lands when the route under it is replaced or cleared. A route that cannot
  be found says so, and one longer than the 200-maneuver cap says it is cut
  off; no straight line is ever drawn as a route. Share links carry the layer
  as token `n`.
- `/api/route` now returns turn-by-turn steps when asked (`steps=1`), phrased
  in plain English from OSRM's maneuver data (`src/data/routeSteps.js`). Steps
  are opt-in per request, so callers that do not read them (voice route
  annotations, `fly_route`) get exactly the response they got before; identical
  requests in flight at the same time share one upstream call; outbound calls
  are spaced to the one-per-second rate the routing service's usage policy
  states, with a bounded queue behind that gate and an honest 429 past it; the
  upstream host is pinned against redirects, and a rate limit from the routing
  service is reported as one rather than as a missing route.
- The Data attribution popover now credits OSRM / FOSSGIS routing (used by
  voice routes since launch, previously uncredited), with the OpenStreetMap
  credit and the "fix the map" link the service's usage policy asks for.

### Changed

- The interface asks Google Fonts for only the icon glyphs it draws, instead of
  the whole variable icon font, and no longer requests a second icon family that
  nothing renders. A check fails when a source names a glyph the request is
  missing, because an absent glyph does not draw a placeholder — the element
  renders the glyph's name as text. The check reads the panel templates as well
  as the scripts, and reads glyph names written as literals, so a glyph chosen
  through a variable has to be added to the request by hand. Contributed by
  mml-studio (#239).
- Separate explicit browser build settings from standalone environment loading
  and local provider middleware. Preserve provider behavior and root named exports.
- Rename standalone browser startup to `src/standalone/` and add a Node-only
  `gods-eye-view/build/vite` export with checked package ownership.

### Development

- The CCTV launcher and preview-server tests resolve their temporary fixture
  root through `fs.realpath`, so they pass on macOS, where the system temp
  directory is reached through a symlink and the paths the tests compare would
  otherwise differ. The launcher, preview-server and tool-project tests share one
  helper that resolves the root, and a case that builds a symlinked temp root
  explicitly keeps it covered on Linux, whose own temp root is not symlinked.
  Contributed by VassagoDevteam (#301).
- Remove the annotation GeoJSON conversion module and its tests. Nothing in the
  application read or wrote it, so it carried no behavior. Annotations are
  unchanged. Contributed by raiyan22 (#293).
- Check the destination preset table as data: every entry carries the keys the
  camera reads, its numbers are finite, its coordinates are on Earth, its camera
  angle is one a camera can hold, `viewBounds` latitudes are not swapped, every
  landmark lies inside its own destination's `viewBounds` (wrapped, so a view
  across the antimeridian is valid), and every `LOCATIONS` row matches the
  destination it names. This is a structural guard on the hand-written table for
  whoever adds the next destination; it passes on the current entries and makes
  no claim about how well any destination is framed. Contributed by daikaginza
  (#168).
- Drop `CCTV_AUTO_CALIBRATE` and `CCTV_DRAPE_MESH` from `.env.example`. Nothing
  reads either name; the features they once switched no longer exist, so setting
  them did nothing. Contributed by dajiaohuang (#283).

- Extract application lifecycle and viewer exports. Split standalone startup into
  scene setup, controls, layer registration, tools and loading UI. Startup failure
  and terminal shutdown release acquired resources and cancel delayed work.

- Adopt Prettier tooling contributed by RohanDaCoder (#227), with an explicit
  file scope, pinned formatter and Linux/Windows CI checks. Format the reusable
  infrastructure modules and their consumer tests. Package boundary checks keep
  those exports separate from app startup and local Node services.

### Fixed

- Reduce terrain-height timeouts when Re:Earth slows down. Batches are
  sized against measured response latency on both browser and server to reduce
  request timeouts, and a partial upstream failure now
  keeps the heights that did resolve rather than discarding them. A position
  the upstream answers with no height is reported as an absent reading instead
  of a failed refresh, so the log distinguishes a slow or broken upstream from
  one that simply has no value for a coordinate.

- Separate optional Google server credentials for Places and Street View from
  the browser key, contributed by Tom-Neverwinter (#110). Provider Settings,
  Pinokio's app-specific credential handling and setup diagnostics recognize
  both keys. The Street View tool prefers the server key across environment
  and `.env` sources. Existing single-key and keyless setups remain supported.

- Complete the first-run, view-target prewarm, cockpit-plates and floor-hold
  browser harness renderer portability fixes contributed by Tom-Neverwinter.
  macOS retains Metal; other platforms default to SwiftShader. Cockpit renderer
  assertions and evidence labels follow the actual selected mode. Floor-hold
  explicitly selects its measured 2D billboard mode and keeps its mesh and terrain assertions; software runs are not real-GPU evidence.
  First-run QA now checks the existing attribution Escape-close/focus-return
  behavior while preserving the launcher-underneath regression checks.

- Datacenter and dam factories are available through scoped package exports with
  explicit context, overlay and render callbacks. The standalone app uses the
  same implementation and bundled datasets.

- Local GeoJSON layers share concurrent loads, cancel pending fetches on destruction,
  discard late results, and remove their entity-context records on teardown.

- Unchanged local infrastructure overlays no longer sustain idle rendering.
  Ground samples wait for visible terrain to settle and cannot place a marker
  below its loaded surface; roofs and valid below-sea-level heights are retained.
  Already sampled markers also follow higher terrain as close-up tiles refine.

- Datacenter and dam marker stems use bounded, zoom-dependent active sets with
  stable selection during camera motion. Close-up stems scale to the actual
  camera distance; source totals and submarine cables remain unchanged.

- Keyboard focus rings now survive active/selected button styles across the
  interface. Visual Styles, Location cities and points of interest, search,
  Context/mission actions, Cockpit utilities, and sliders retain a distinct
  focus indicator.
- A short Space press activates a focused control only on key release. Holding
  Space for 500 ms blurs that control before push-to-talk starts, and release is
  then consumed so it cannot also activate the old control. The same hold works
  from the map or page background; text-entry controls remain protected.
- The Location disclosure is reachable with Tab and shows keyboard focus;
  its city, point-of-interest, and search controls do too. Escape from inside
  the tray returns focus to its disclosure and discards any unfinished search;
  Escape on the disclosure itself closes the tray and clears that focus.
- Data Layers ON/OFF buttons show a keyboard focus ring independently of
  their enabled and feed-status colors.
- Display buttons, layout selectors, mode buttons, and sliders show a visible
  keyboard focus ring, including the controls used in Cockpit Display. Enabled
  CCTV camera dropdowns also show keyboard focus.
- Context tabs keep a distinct keyboard ring when selected. Their existing
  Left/Right arrow navigation continues to switch Contacts and Space Missions,
  and both choices remain reachable through ordinary Tab navigation.
- Tabbing through the Space Missions roster now drives the same temporary globe
  rotation and mission-marker highlight as pointer hover, without selecting the
  mission. Keyboard and pointer previews no longer cancel each other.
- Radio power controls, Search Nearby Sites, and Clear Selected Layers retain
  keyboard focus while their async work is busy. They expose that busy state to
  assistive technology and ignore repeated activation until the work settles.
- Live Contacts results retain keyboard focus by contact identity when counts,
  distance order, or pages refresh. If a focused contact departs or rotates off
  the visible page, focus moves to the named explanatory note at the end of the
  list and survives later refreshes there, so the next Tab proceeds beyond the
  list instead of restarting at Contacts or silently selecting another contact.
- Cockpit Live Signals retains keyboard focus during live updates and contact
  reordering, allowing Tab to continue to Display and Radio. If the focused
  contact leaves the list, focus moves to the current briefing tab.
- Cockpit-only Display and Radio launchers show complete inset focus rings.
- Escape collapses the nearest expanded panel containing keyboard focus and
  returns focus to that panel's disclosure when closing from its contents.
  Escape on the disclosure itself closes without leaving the collapsed control
  focused. Cockpit Contact and Live Signals panels follow the same nesting rule.
- Cesium's bottom-left Data attribution control and lightbox Close control are
  in the Tab order and support Enter and Space. Close, Escape, and backdrop
  dismissal restore focus and synchronize the disclosure state.

- CCTV testing uses the normal launcher for keyless startup, credential loading,
  localhost binding, and explicit LAN-exposure warnings while retaining its
  smaller source-pack limits.
- CelesTrak, Launch Library, terrain-height, and aircraft-enrichment failures
  return generic error messages. Related diagnostics omit raw exception details
  and upstream error bodies; response statuses and cache fallback remain intact.
  Includes the security fixes contributed by Tom-Neverwinter in PR #171.

### Fixed

- Map Source keyboard opening retries focus until the selected tile is visible.
  Leaving the disclosure, pointer interaction, or closing the tray cancels the
  pending handoff so delayed work cannot pull focus back.

- Scope, Bloom, Sharpen, location search and generated style sliders expose
  explicit accessible names. The first-run checkbox retains its native label.
- FIRMS records a source as successful only after appending its rows, avoiding
  contradictory success/failure status if aggregation throws.
- Radio country filtering and voice country requests now resolve common English
  names and exonyms that `Intl.DisplayNames`' primary label omits, so requests
  like "play radio in Turkey" no longer fail closed (Turkey → Türkiye, plus
  Myanmar/Burma, UAE, Holland, Swaziland, East Timor, Cabo Verde, Vatican).
  Ambiguous names such as a bare "Congo" or "Korea" still fail closed.
- Mapped-site outages show their scheduled retry countdown and distinguish
  known Overpass rate limits, timeouts, and query failures. Search feedback no
  longer claims a refresh succeeded while the layer is unavailable or loading.
- Mapped installations retain valid ways and relations that provide bounds but
  no center. Invalid, inverted, and excessively wide bounds are rejected.
- Clicking a selected installation again or clicking elsewhere clears its
  selection; later refreshes no longer reclaim it after a click-away.
- Visual presets explain their effects on hover. Unavailable map sources name
  missing credentials and Provider Settings, while configured-but-failed
  Google 3D routes explain the failure without asking for another key.

- The Overpass proxy now rotates to the next mirror on any non-2xx upstream
  response, not only on 5xx. `overpass-api.de` and its `lz4` alias answer 406 to
  the proxy's User-Agent while two of the configured mirrors answer 200 to the
  identical request, so the fan-out stopped at the first refusal with healthy
  mirrors untried. The refusal was also cached to memory and disk and served as
  data — boundary-class queries hold a month-long TTL — which affected every
  Overpass-backed feature: road geometry, annotation outlines and place lookup.
- Existing cached refusals are now ignored immediately, including during
  stale-data fallback. Concurrent identical requests share the same last-good
  fallback when all mirrors refuse, without duplicating upstream requests.
- A keyless place lookup no longer remembers a network failure as "no such
  place". A blip while Photon was answering used to be memoized for the rest of
  the session, so the query kept returning not-found from memory on a network
  that had since recovered. A miss is now cached only when every source
  consulted actually returned a verdict.

### Added

- Keyless place search. The LOCATION search box and the `fly_to_location` voice
  tool now resolve place names through Photon (komoot, over OpenStreetMap) when
  no Google Maps key is configured — previously the lookup threw. Google stays
  the primary path and is unchanged when it answers; the fallback also covers a
  key whose Geocoding API is not enabled, which Google reports as HTTP 200 with
  `REQUEST_DENIED`, so an empty result is the detector rather than an error.
- The same keyless fallback now covers the remaining two place lookups: map
  annotations ("annotate the botanical garden") and the Radio layer's
  "near \<place>" selection. Radio previously threw without a key, which
  surfaced as a failed voice turn rather than as a station it could not place;
  annotations silently failed to anchor. Annotation footprints match OSM on the
  resolved feature's canonical name, so locality words in the request cannot
  pull the outline onto a neighbouring building.

- Refresh vulnerable transitive dependencies and update browser/image tooling
  to Puppeteer 25.10.0 and Sharp 0.35.4. Cesium remains on 1.138.0.
  Browser QA awaits the new asynchronous executable-path lookup.

## [0.1.1] — 2026-09-01 — Installation and live-data fixes

### Changed

- Tightened the README opening around keyless setup, source freshness, modeled
  experiences, and the accessibility of the provider stack.

### Fixed

- Pinokio now recognizes its nested successful-install marker, so a completed
  one-click install exposes Start instead of returning to Install.
- The keyless `dev-fresh.sh` startup summary now names Esri World Imagery with
  keyless terrain and identifies OpenStreetMap as the fallback.
- All three VIIRS sources now reach the Active Fires layer. Merging a source's
  detections used argument spread, which exceeds the engine's argument limit on
  the two largest sources and dropped them entirely — leaving roughly a third of
  global detections while reporting each dropped source twice, once as
  successful with its real count and once as failed.
- `./scripts/dev-fresh.sh` no longer crashes on stock macOS bash 3.2 when no
  provider keys are exported: expanding the empty external-keys provenance
  array under `set -u` was fatal there. Launches with exported keys are
  unchanged.

### Security

- GBFS proxy body-size cap now measures the response in bytes
  (`Buffer.byteLength`) instead of JavaScript string length, so the
  `GBFS_MAX_BODY_BYTES` limit holds for multi-byte payloads and cannot be
  overrun by non-ASCII upstream responses.

## [0.1.0] — 2026-08-31 — One-click install, keyless boot, Provider Settings

### Added

- **One-click install** via Pinokio. Keyless boot lands on a live Esri World
  Imagery satellite globe with keyless terrain; OSM takes over automatically if
  Esri is unreachable, and the globe continues without terrain if its source is
  unavailable.
- **Provider Settings** (the POWER UP panel): add, replace, or remove API keys
  inside the app. Credential files are made owner-only before any secret is
  written — verified on macOS and Windows — and keys configured outside the
  panel are shown read-only, never rewritten.
- **Keyless capability responses**: the optional HUD summary and place-search
  endpoints return a deliberate "not configured" success instead of errors, and
  never consume rate-limit quota.
- `.gitattributes` normalizes line endings, so Windows clones pass the full
  test suite out of the box (#81 — thanks @ethanstoner).

### Changed

- README rewritten keyless-first around the provider ladder: zero keys → free
  Cesium ion (eligible personal, non-commercial use) → billing-enabled Google
  Maps.
- Browser-built data modules no longer import `node:fs`; a repo-wide boundary
  scan test keeps it that way (#83 — thanks @ethanstoner).
- Aircraft-identity voice answers explicitly cover operator, type, and route,
  and say so plainly when enrichment is unavailable instead of guessing.

### Security

- Provider Settings answers only local, unproxied requests and disables itself
  entirely whenever the server is shared. Public datacenter and dam datasets
  omit contact-oriented fields (see the dataset READMEs).

## Pre-release development history

The dated entries and internal milestone numbers below predate the first
tagged GitHub Release. They are retained as project history and do not
represent previously published GitHub Releases.

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
