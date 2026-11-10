// The engine-neutral globe contract. The application shell talks to a globe
// engine (Cesium or Navara) only through these small capability
// objects. Positions are src/geo values in Earth-fixed metres, angles are
// radians and screen coordinates are CSS pixels from the canvas's top-left
// corner. This module and src/globe/testing/** never import cesium, three or
// @navaramap/*; see docs/CODE-BOUNDARIES.md.

/**
 * @typedef {{ x: number, y: number }} Cartesian2
 * @typedef {{ x: number, y: number, z: number }} Cartesian3
 * @typedef {{ longitude: number, latitude: number, height: number }} Cartographic
 * @typedef {number[]} Matrix4 16 numbers, column-major (m[column * 4 + row]).
 * @typedef {(...args: any[]) => void} Listener
 *
 * @typedef {object} EngineEvent
 *   The contract's own event semantics (engines expose createEngineEvent()
 *   instances, never a raw Cesium.Event):
 *   - listeners run in registration order;
 *   - adding a function that is already registered is a no-op (it stays
 *     registered once and fires once), so re-initialisation cannot double-fire;
 *   - a listener removed during dispatch is not called in that dispatch;
 *   - a listener added during dispatch runs from the next dispatch, and one
 *     removed then re-added during dispatch stays registered;
 *   - every remover handle is idempotent and only removes the registration it
 *     was returned for.
 * @property {(listener: Listener) => () => void} addEventListener
 * @property {(listener: Listener) => boolean} removeEventListener
 *
 * @typedef {object} CameraPose
 *   Angles follow Cesium's camera: heading in [0, 2π) clockwise from north,
 *   pitch in [−π/2, π/2] (negative looks down), roll in [0, 2π) with positive
 *   roll tilting `up` toward the camera's right; roll is 0 and heading follows
 *   `up` when looking (nearly, within 1e-3) straight up or down.
 * @property {Cartesian3} position World position (Cesium's positionWC).
 * @property {Cartographic} cartographic
 * @property {number} heading
 * @property {number} pitch
 * @property {number} roll
 * @property {Cartesian3} direction
 * @property {Cartesian3} up
 * @property {Cartesian3} right direction × up
 * @property {number} fovy Vertical field of view.
 * @property {number} aspectRatio The view's width over its height (Cesium:
 *   the frustum's, from the drawing buffer).
 *
 * @typedef {{ heading: number, pitch: number, roll: number }
 *   | { direction: Cartesian3, up: Cartesian3 }} Orientation
 *
 * @typedef {{ west: number, south: number, east: number, north: number }} Rectangle
 *   Radians; west > east across the antimeridian. As a destination, the
 *   camera is placed so the rectangle fills the view (Cesium's
 *   getRectangleCameraCoordinates).
 *
 * @typedef {object} FlightOptions
 * @property {Cartesian3 | Rectangle} destination
 * @property {Orientation} [orientation] As in Cesium's setView and flyTo,
 *   missing angles default to heading 0, pitch −π/2 and roll 0 (they do not
 *   keep the current ones).
 * @property {number} [duration] Seconds. 0 (or less) sets the view and calls
 *   `complete` synchronously, before flyTo returns, as Cesium does.
 * @property {'cubicInOut'|'sinusoidalInOut'|'linear'} [easing] Omitted: the
 *   engine's own flight easing (Cesium picks one from the flight's heights).
 * @property {Matrix4} [endTransform] The camera transform once the flight
 *   lands; IDENTITY releases a lookAt lock.
 * @property {() => void} [complete]
 * @property {() => void} [cancel] Called by cancelFlight or a newer flight.
 *
 * @typedef {{ heading: number, pitch: number, range: number }} HeadingPitchRange
 *   Offset from a target in its local east-north-up frame; the camera looks at
 *   the target along heading/pitch from `range` metres away.
 *
 * @typedef {object} SphereFlightOptions
 *   Defaults are Cesium's: heading 0, pitch −π/4 and, when range is missing or
 *   0, range = 100 m for a sphere of radius 0, otherwise
 *   max(r / tan(fovx/2), r / tan(fovy/2)) clamped to the camera controller's
 *   zoom distances (Cesium: minimumZoomDistance 1 m to maximumZoomDistance ∞
 *   by default).
 * @property {number} [heading]
 * @property {number} [pitch]
 * @property {number} [range]
 * @property {number} [duration]
 * @property {'cubicInOut'|'sinusoidalInOut'|'linear'} [easing] As in FlightOptions.
 * @property {() => void} [complete]
 * @property {() => void} [cancel]
 *
 * @typedef {object} GlobeCamera
 * @property {() => CameraPose} pose Fresh values on every call.
 * @property {Cartesian3} livePosition The pose's world position as one
 *   engine-owned object: the same object on every read, holding the current
 *   position (at the latest when read). For per-frame readers, which must not
 *   allocate; read-only, copy it to keep a value.
 * @property {() => number} height The camera's height above the WGS84
 *   ellipsoid (the pose's cartographic height), without building a pose.
 * @property {(view: { destination: Cartesian3 | Rectangle, orientation?: Orientation }) => void} setView
 *   Cancels a running flight. Missing angles default to heading 0, pitch −π/2, roll 0.
 * @property {(options: FlightOptions) => void} flyTo Cancels a running flight first.
 * @property {(sphere: { center: Cartesian3, radius: number }, options?: SphereFlightOptions) => void} flyToSphere
 *   Ends unlocked (identity transform).
 * @property {() => boolean} flightActive
 * @property {(target: Cartesian3, offset: HeadingPitchRange) => void} lookAt
 *   lookAtTransform(eastNorthUp(target), offset).
 * @property {(transform: Matrix4, offset?: HeadingPitchRange | Cartesian3) => void} lookAtTransform
 *   Locks the camera to `transform`; a Cartesian3 offset is the camera position
 *   in that frame, looking at its origin with the frame's +Z as "up". Without
 *   an offset the camera keeps its world pose.
 * @property {() => Matrix4} transform A copy of the current camera transform.
 * @property {() => void} release lookAtTransform(IDENTITY).
 * @property {() => void} cancelFlight
 * @property {() => void} completeFlight Cesium's completeFlight: a running
 *   flight lands at once (its destination and end transform) and calls
 *   `complete`, not `cancel`; without a flight it does nothing.
 * @property {(amount?: number) => void} zoomIn Moves `amount` metres along direction.
 * @property {(amount?: number) => void} zoomOut Moves `amount` metres against direction.
 * @property {() => ({ west: number, south: number, east: number, north: number } | undefined)} viewRectangle
 *   Cesium's computeViewRectangle: undefined when the globe is out of view;
 *   west > east across the antimeridian; ±π longitudes and a ±π/2 latitude
 *   over a pole; the whole globe when fewer than two canvas corners hit it.
 * @property {(screen: Cartesian2) => (Cartesian3 | undefined)} pickEllipsoid
 * @property {(screen: Cartesian2) => { origin: Cartesian3, direction: Cartesian3 }} pickRay
 * @property {EngineEvent} changed Listener receives the change fraction.
 * @property {EngineEvent} moveStart Fires when the camera starts moving from rest.
 * @property {EngineEvent} moveEnd Fires once the camera has been still for a
 *   while (Cesium: scene.cameraEventWaitTime, 500 ms), so a move that follows
 *   within that time continues the same movement and raises no new moveStart.
 * @property {EngineEvent} commanded Fires (no arguments) when a command, not a
 *   user gesture, is about to take the camera: setView, flyTo, flyToSphere,
 *   lookAt and cancelFlight. Cesium also raises it for those calls made on the
 *   viewer's own camera and when the viewer's tracked entity changes, so a
 *   pending correction yields to every new camera owner.
 * @property {(options: FollowOptions) => FollowHandle} follow Keeps a moving
 *   target in the centre (Cesium: trackedEntity; Navara and the fake engine:
 *   src/globe/follow.js each frame). The user may turn and zoom around it;
 *   a command that takes the camera (setView, flyTo, flyToSphere, lookAt,
 *   cancelFlight) ends it. A new follow replaces the current one.
 * @property {() => (FollowHandle | null)} following The current follow
 *   (Cesium: also one the app started on viewer.trackedEntity itself).
 * @property {EngineEvent} followChanged Listener receives the new handle or
 *   null (Cesium: viewer.trackedEntityChanged).
 * @property {number} percentageChanged
 *
 * @typedef {object} FollowOptions
 * @property {() => Cartesian3} position Where the target is (read each frame).
 * @property {Cartesian3 | (() => Cartesian3)} viewFrom The camera's offset
 *   from the target in its east-north-up frame, metres.
 * @property {Cartesian3 | null} [swingTo] Desired ENU offset after the first
 *   follow frame. Turns at most 60 degrees per frame, interpolating range,
 *   then leaves the offset to user gestures. retarget({ swingTo }) keeps the
 *   current follow; null cancels a pending swing. Stop or camera handoff
 *   cancels it as well.
 * @property {number} [minRange] Closest the camera comes (150 m).
 * @property {'enu'} [frame]
 * @property {any} [native] What is followed, as the handle's `native`. On
 *   Cesium an Entity goes on viewer.trackedEntity itself; anything else (a
 *   layer's own handle) is followed through a proxy Entity, which shows the
 *   handle's tracked-readout fields (gevTrackedId, gevLabelModel,
 *   gevDisplayPosition, gevVisualPosition, gevSelectionOrigin).
 * @property {{ id: string, model: object | (() => object), position: () => Cartesian3 }} [label]
 *   The tracked readout's card (src/data/trackedReadout.js): its id, label
 *   model ({ title, details, accent, ... }) and anchor, as plain data.
 *
 * @typedef {object} FollowHandle
 * @property {() => void} stop
 * @property {(next: Partial<FollowOptions>) => void} retarget
 * @property {() => (Cartesian3 | undefined)} target Where the followed
 *   target is now (what the follow centres).
 * @property {any} [native]
 * @property {object} [label] FollowOptions.label.
 * @property {string} [name] Cesium only: the followed Entity's name, else its
 *   id (a follow without an Entity has none). @deprecated Compatibility field.
 *
 * @typedef {'click'|'doubleClick'|'move'|'down'|'up'} InputType
 * @typedef {'ctrl'|'shift'|'alt'} InputModifier
 * @typedef {object} InputEvent
 * @property {Cartesian2} [position] click, doubleClick, down, up.
 * @property {Cartesian2} [startPosition] move.
 * @property {Cartesian2} [endPosition] move.
 * @property {PickResult} [picked] With `pick`: what is drawn under the
 *   position (move: the end position), undefined for the map or nothing.
 *   Cesium picks at once; Navara answers a click from its GPU pick of the
 *   same gesture (a frame or two later; undefined after a timeout), a move
 *   from a CPU pick of movers and lines, at most once per frame.
 * @property {PickResult[]} [drilled] With `drill`: up to that many objects
 *   under the position, nearest first.
 *
 * @typedef {object} InputOptions
 * @property {{ release: () => void }} [pointer] The live exclusive pointer claim.
 * @property {InputModifier} [modifier]
 * @property {boolean} [pick] click, doubleClick, down and move only. A move
 *   listener with pick gets at most one payload per frame (the latest).
 * @property {number} [drill] A positive integer; moves coalesce with their picks.
 * @property {{ width: number, height: number }} [pickWindow] Positive integer
 *   pick dimensions in pixels, passed to the picker. Omitted: engine default.
 *   Down picks are synchronous; click delivery keeps the engine's gesture pick.
 *
 * @typedef {object} GlobeProjector
 * @property {(position: Cartesian3, result?: Cartesian2) => (Cartesian2 | undefined)} worldToWindow
 *   Undefined behind the camera; fills and returns `result` when given.
 * @property {(result?: Matrix4) => Matrix4} viewProjection
 *   World → clip matrix consistent with worldToWindow: clip = M·[x, y, z, 1],
 *   in front when clip.w > 0, window = ((clip.x/clip.w + 1)/2 · width,
 *   (1 − clip.y/clip.w)/2 · height).
 * @property {(position: Cartesian3, options?: { ellipsoid?: { radii: Cartesian3 } }) => boolean} horizonVisible
 *   False when the WGS84 ellipsoid hides the point from the camera
 *   (Cesium's EllipsoidalOccluder.isPointVisible). An optional ellipsoid
 *   supplies positive finite radii in metres; omitted means WGS84.
 *
 * @typedef {object} GlobeSurface
 * @property {(cartographic: Cartographic, exclude?: any[]) => (number | undefined)} sampleHeight
 *   Height of the rendered scene (tiles, models) under a point.
 * @property {(cartographic: Cartographic, options?: { exclude?: any[] }) => (SurfaceHeight | undefined)} sampleHeightDetailed
 *   sampleHeight with the answer's quality (src/globe/surfaceDetail.js):
 *   from the tiles drawn now (Navara: where they miss, the finest loaded
 *   ones; Cesium samples what it has loaded). Where no tile answers, the
 *   terrain. `exclude` takes this engine's mover sets, lines and meshes as
 *   well as native engine objects.
 * @property {boolean} supported Whether sampleHeight works.
 * @property {(cartographic: Cartographic) => (number | undefined)} terrainHeight
 *   Height of the terrain/globe surface only (Cesium's globe.getHeight).
 * @property {boolean} terrainHeightSupported
 * @property {(positions: Cartographic[]) => Promise<(number | undefined)[]>} sampleTerrainMostDetailed
 *   Terrain heights (as terrainHeight) at the terrain's finest level,
 *   fetched where it is not loaded (Cesium's sampleTerrainMostDetailed), one
 *   per position, in order: undefined where no tile answers, 0 on the
 *   ellipsoid. Rejects when the terrain cannot be sampled (Cesium: one
 *   without tile availability). The terrain is the one shown at the call;
 *   maps.terrainRevision tells when it changed since.
 * @property {(position: Cartesian3, exclude?: any[]) => (Cartesian3 | undefined)} clampToHeight
 *   The position moved onto the rendered scene along the geodetic normal.
 * @property {boolean} clampToHeightSupported
 * @property {() => boolean} tilesLoaded
 * @property {(ray: { origin: Cartesian3, direction: Cartesian3, far: number, exclude?: any[] }) => ({ position: Cartesian3, distance: number, object: any } | undefined)} raycast
 *   Nearest visible scene object within finite positive `far` metres (Navara:
 *   loaded tile triangles). Direction
 *   is normalized by the adapter. Excluded roots/meshes and hidden objects do
 *   not obstruct; a miss or unsupported geometry returns undefined, not terrain.
 *
 * @typedef {object} SurfaceHeight
 * @property {number} height Metres above the ellipsoid.
 * @property {'tiles' | 'terrain'} source
 * @property {number} [tileSizeM] The size of the tile that answered
 *   (Navara): the quality signal; Cesium does not say.
 *
 * @typedef {object} GlobeRender
 * @property {(reason?: string) => void} request Renders a frame soon in
 *   request mode; `reason` is for diagnostics only.
 * @property {(enabled: boolean) => void} setContinuous
 *   Owns whatever the engine needs to render every frame or only on request
 *   (Cesium: requestRenderMode and maximumRenderTimeChange = Infinity).
 * @property {() => boolean} isContinuous
 * @property {() => number} maxTextureSize The longest texture side (px) the
 *   GPU takes (Cesium's ContextLimits.maximumTextureSize, three's
 *   capabilities.maxTextureSize): a layer sizes its images under it.
 * @property {(options: { enabled?: boolean, amount?: number }) => void} setSharpen
 *   An unsharp mask on the final image, after tone mapping and before
 *   anti-aliasing: each pixel moves away from its 3×3 box blur by `amount`
 *   (the maths of the app's Cesium sharpen stage, whose `amount` uniform the
 *   Sharpen slider sets in 0.1..2.1). Omitted fields keep their value; a
 *   non-boolean `enabled` or a negative or non-finite `amount` throws a
 *   TypeError. Off with amount 1 until set. Cesium draws it as a post stage
 *   after the styles' (src/globe/cesium/postStages.js); the app's Display
 *   controls drive it (src/ui/visualEffects.js).
 * @property {() => { enabled: boolean, amount: number }} sharpen
 *   The sharpening last set (a copy).
 * @property {readonly string[]} [visualStyles] Optional, with setStyle and
 *   style (capability `visualStyles`, see engineCapabilities): the
 *   full-frame styles the engine draws itself, by the app's style names
 *   (src/styles: retro, surveillance, thermal, anime, noir). Cesium draws
 *   each as its own post stage, Navara in one pass; the app drives them
 *   (src/ui/visualEffects.js).
 * @property {(name: string, options: { intensity?: number, uniforms?: Record<string, number> }) => void} [setStyle]
 *   Shows one style at `intensity` (0..1, 0 draws nothing; a crossfade shows
 *   two at once, drawn in the order of visualStyles) with its own uniforms
 *   (the style's parameters and `time`, seconds, for an animated one).
 *   Omitted fields keep their value; an unknown style or uniform name, an
 *   intensity outside 0..1 or a non-finite uniform throws a TypeError.
 *   Every style starts at intensity 0 with its shader's defaults.
 * @property {(name: string) => StyleState} [style] The style's state last
 *   set (a copy).
 * @property {(options: { enabled?: boolean, strength?: number }) => void} [setBloom]
 *   Optional, with bloom (capability `bloom`): a glow around the bright parts
 *   of the final frame, before the visual styles. `strength` is the app's
 *   Bloom slider normalized to 0..1 (src/bloom.js
 *   bloomStrengthFromIntensity); at or under 0.06 nothing glows, as with
 *   Cesium's bloom stage, whose easing the engine follows. Omitted fields
 *   keep their value; a non-boolean `enabled` or a strength outside 0..1
 *   throws a TypeError. Off at strength 0 until set. Cesium draws it with the
 *   scene's own bloom stage, which it gives back on destroy.
 * @property {() => { enabled: boolean, strength: number }} [bloom] The bloom
 *   last set (a copy).
 * @property {(options: { coverage?: number | null }) => void} [setCloudCover]
 *   Optional, with cloudCover (capability `cloudCover`): how much of the sky
 *   the engine's own volumetric clouds cover, 0..1, or null for the
 *   engine's own cover (its look). Where the clouds show (height, daylight)
 *   stays the engine's. The cockpit drives it from the weather under the
 *   camera (src/cockpitCloudEffects.js). A coverage outside 0..1 that is not
 *   null throws a TypeError. Null until set. Cesium has none: in Cesium
 *   mode the cockpit draws its own cloud pass.
 * @property {() => { coverage: number | null }} [cloudCover] The cover last
 *   set (a copy).
 * @property {(options: Partial<ContactSonar>) => void} [setContactSonar]
 *   Optional, with contactSonar (capability `contactSonar`): the Cyber HUD
 *   sonar's treatment of contacts (sprite and point movers): while
 *   `enabled`, each contact's colour moves toward the scanner tint and its
 *   alpha scales by its factor, from its anchor's place on screen against the
 *   sweep (src/cyberSonar.js createCyberSonarSampler maths); with the sweep
 *   off (`active` false) every contact takes the neutral factor. Positions
 *   and picks are unchanged. Omitted fields keep their value; a bad value
 *   throws a TypeError. Takes effect on the next drawn frame (a call outside
 *   a frame requests one). Off until set. Cesium adapts its native draw
 *   commands and tints models (src/globe/cesium/sonar.js); the app hands
 *   the state over every frame (src/cyberSonarEngine.js).
 * @property {() => ContactSonar} [contactSonar] The sonar last set (a copy).
 *
 * @typedef {object} ContactSonar
 * @property {boolean} enabled The Cyber contact treatment applies.
 * @property {boolean} active The sweep runs (else the neutral factor).
 * @property {number} angleDeg The sweep's heading, clockwise from screen up.
 * @property {number} range The keyhole radius in percent (100: the smaller
 *   of 40 % of the width and 52 % of the height).
 * @property {number} opacity The factor outside the sweep, percent (0..100).
 * @property {number} sector The sector's width in degrees (0..360].
 *
 * @typedef {{ intensity: number, uniforms: Record<string, number> }} StyleState
 *
 * @typedef {object} GlobeInput
 * @property {() => ({ release: () => void } | null)} acquirePointer Claim
 *   exclusive screen events, or null while another claim is held. Pass the
 *   claim as InputOptions.pointer; other subscriptions yield. Release is
 *   idempotent, and engine destruction releases it. Camera gestures remain
 *   enabled. Cesium's stock select/track clicks are suspended and restored
 *   by identity. Deferred picks cannot cross a claim or release.
 * @property {(type: InputType, listener: (event: InputEvent) => void, options?: InputOptions) => () => void} on
 *   As in Cesium, a listener with a modifier fires only while that key is
 *   held and one without fires only while no modifier is held.
 * @property {() => () => void} suspendCameraInputs Camera inputs off until
 *   the returned resume (idempotent): for an owner that holds the camera for
 *   a while (the cockpit, a gizmo or box drag, a flight a gesture would
 *   cancel). Suspensions count: inputs stay off until the last one resumes,
 *   which brings back the state from before the first (Cesium: the
 *   controller's enableInputs as it was).
 * @property {() => boolean} cameraInputsEnabled Whether the user's gestures
 *   move the camera now: on, and under no suspension.
 *
 * @typedef {object} PickResult
 * @property {any} id The picked entity or object id (a mover's or line's
 *   pickId); undefined for map tiles.
 * @property {string} [owner] The mover set or line the pick belongs to.
 * @property {number} [instance] The mover instance index.
 * @property {any} [primitive] Cesium only, for compatibility. @deprecated Compatibility field.
 * @property {any} [content] 3D tile content when map tiles were picked (what
 *   a surface-pick check reads), else undefined.
 * @property {any} [object] The engine's own pick result, for engine-specific code.
 *
 * @typedef {object} GlobeMaps
 *   Map sources are engine-neutral descriptions, as maps/registry.js sources
 *   carry them; each engine builds its own providers from them:
 *   - imagery `{ kind: 'osm'|'esri-imagery'|'ion', style?, accessToken?,
 *     credit?, descriptor? }`;
 *   - photoreal tiles `{ kind: 'photoreal', googleApiKey?, cesiumToken?,
 *     credit?, descriptor? }`;
 *   - terrain `{ kind: 'ellipsoid'|'keyless'|'world', accessToken?, id? }`.
 *   Optional prebuilt members (`provider`, `tileset`, terrain `create`, an
 *   `imagery()` factory) are engine objects their caller built and owns: only
 *   the engine kind that built them uses them (the Cesium engine for the
 *   registry's Cesium factories), any other ignores them and builds from the
 *   description. The engine neither caches nor disposes them.
 *   Each setter settles once the source is on screen and rejects when it
 *   cannot be built (the current source then stays). Base imagery and
 *   photoreal tiles share one switch order: the call made last decides what
 *   shows, and a superseded call settles without showing anything.
 * @property {EngineEvent} [errors] With the tileErrors capability, reports
 *   provider failures as { source, kind: 'tile' | 'terrain', status }, where
 *   source is the description passed to the setter and status is the HTTP
 *   status code when known (undefined otherwise). Replaced sources stop
 *   reporting; engines without provider error events omit this capability.
 * @property {(source: object) => Promise<void>} setBaseImagery
 * @property {(source: object) => Promise<void>} setTerrain
 * @property {(source: object | null) => Promise<void>} setPhotorealTiles
 *   Tiles replace the base imagery and hide the globe; null hides every
 *   tileset and shows the globe again with the last base imagery and its
 *   credit (no credit when none was set).
 * @property {(source: object) => void} releasePhotorealTiles Forgets a
 *   photoreal source shown before (it no longer counts for photorealActive)
 *   and takes engine-added tiles out of the scene; its caller disposes them.
 * @property {() => boolean} photorealActive
 * @property {() => { baseImagery: object | null, photoreal: object | null }} current
 *   The source objects on screen, as passed: the base imagery layer on the
 *   globe and the photoreal tiles shown (null for none).
 * @property {() => number} terrainRevision Changes whenever the terrain the
 *   globe draws is replaced (a setTerrain applied, a fallback to the
 *   ellipsoid): heights cached against the terrain are stale once it does.
 *
 * @typedef {object} GlobeClock
 *   The app's own time (src/time/clock.js), in milliseconds since the Unix
 *   epoch: the one time source for layers and the engine's own time-driven
 *   drawing (Navara's sun). By default it is the wall clock (Date.now); QA
 *   and tests may freeze, offset or speed it up on the app clock: now()
 *   follows at once, frameTime() from the engine's next frame, and in
 *   request-render mode nothing draws until a render is requested, so a QA
 *   helper that moves the clock calls render.request() after it.
 *   Not on this clock:
 *   - Cesium's viewer.clock: the app never animates it (shouldAnimate false,
 *     its time frozen at boot); Cesium's sun and lighting and every entity
 *     property read at viewer.clock.currentTime stay on that time;
 *   - wall-clock throttles and feed receipt stamps (they measure real
 *     elapsed time, not scene time).
 * @property {() => number} now The current app time.
 * @property {() => number} frameTime The app time latched at the start of the
 *   engine's current frame: every reader in one frame gets the same value; it
 *   does not decrease from frame to frame while the app clock runs forward.
 *   Before the first frame, the current time. A frame is one turn of the
 *   engine's update loop, also when it draws nothing; its time is latched
 *   before its preUpdate (Cesium: on the viewer clock's tick, right before
 *   scene.render; Navara: on the view's preUpdate).
 *
 * @typedef {object} MoverSetOptions
 *   A set of moving objects drawn as one batch (src/globe/movers.js checks
 *   and defaults these):
 * @property {string} id Unique among the engine's live sets.
 * @property {'sprite'|'point'|'model'} kind
 * @property {number} capacity The most instances the set holds.
 * @property {number} [retryAfterMs=1500] Delay after a model or atlas load
 *   failure before retrying. At most three attempts, including the first.
 * @property {number} [order] Draw order among sets (higher draws later, on
 *   top); 0 by default.
 * @property {'normal'|'always'|{ disableWithinM: number }} [depthTest]
 *   'always' draws over the scene; { disableWithinM } skips the depth test for
 *   instances closer to the camera than that (Cesium's
 *   disableDepthTestDistance). 'normal' by default. Sprites and points
 *   only: models are depth-tested in the scene on both engines.
 * @property {{ atlas: { url?: string, canvas?: object, cells: Object<string, number[]> },
 *   sizePx: number, scaleByDistance?: number[] }} [sprite] An image atlas
 *   whose cells are [u0, v0, u1, v1] in 0..1 (v down from the image top);
 *   each sprite is a square of sizePx CSS px times its scale, times the
 *   NearFarScalar [nearM, nearScale, farM, farScale] when given (Cesium's
 *   interpolation: over the squared camera distance, eased by ^0.2).
 * @property {{ sizePx: number, outlinePx?: number, outlineColor?: number[], scaleByDistance?: number[], translucencyByDistance?: number[] }} [point]
 *   A filled disc of sizePx CSS px diameter plus outlinePx on each side;
 *   outlineColor is rgba in 0..1 (opaque black by default).
 * @property {{ url: string, minimumPixelSize?: number,
 *   colorBlend?: { mode: 'mix'|'replace', amount: number }, unlit?: boolean }} [model]
 *   A glTF drawn per instance in metres, at least minimumPixelSize px.
 *   Without colorBlend the instance colour sets only the alpha; 'mix' mixes
 *   the lit colour toward it by amount, 'replace' replaces it; unlit draws
 *   the model's own colours without lighting.
 * @property {boolean} [pickable] Whether picks return the set's instances
 *   (false by default: picks pass through to what lies under them).
 * @property {boolean} [sharpen] Sprites/points: include the glyph in the
 *   sharpen/AA stage after tone mapping, for translucent fields such as FIRMS
 *   (by default Navara draws them in the later display stage; Cesium draws
 *   billboards and points in its own stage either way). Does not enable
 *   sharpening or change its amount.
 *
 * @typedef {object} MoverFields
 *   One instance; omitted fields keep their value (defaults: white, scale 1,
 *   rotation 0, the first atlas cell, shown, identity orientation).
 * @property {Cartesian3} [position]
 * @property {number} [rotation] Sprites: screen angle in radians,
 *   counter-clockwise from screen up (Cesium's Billboard.rotation).
 * @property {{ x: number, y: number, z: number, w: number }} [orientation]
 *   Models: the rotation of the glTF's own axes (as the file stores them,
 *   +Y up) into Earth-fixed axes; no engine adds an axis correction.
 * @property {number[]} [color] rgba in 0..1; multiplies the sprite's texels.
 * @property {number[]} [outlineColor] Points: rgba in 0..1, initially the set
 *   outlineColor. Updates the outline independently of the fill.
 * @property {number} [scale]
 * @property {string} [cell] An atlas cell key.
 * @property {boolean} [show]
 * @property {any} [pickId] Opaque caller-owned identity returned by a pick.
 *
 * @typedef {object} MoverSet
 * @property {(index: number, fields: MoverFields) => void} set Stored only;
 *   drawn after commit().
 * @property {(count: number) => void} setCount Instances [0, count) draw.
 * @property {() => number} count
 * @property {() => void} commit Uploads what changed (one buffer write) and
 *   requests a render; nothing else draws a frame.
 * @property {(index?: number) => boolean} ready Whether what the set draws
 *   has loaded: every active model or the sprite atlas. With an index, what
 *   that active instance draws; false outside [0, count). A successful retry
 *   makes it ready. A layer keeps its fallback visual until then.
 * @property {(index?: number) => boolean} failed Whether what the set draws
 *   failed on its latest attempt (with an index, that active instance;
 *   false outside [0, count)). It stays true during the retry and clears on
 *   success; after three failed attempts it stays true. The engine retries
 *   after retryAfterMs. A model index given another pickId loads again with
 *   a fresh attempt budget. Destroy cancels retries and both queries return false.
 * @property {() => void} destroy
 *
 * @typedef {object} GlobeMovers
 * @property {(options: MoverSetOptions) => MoverSet} createSet
 * @property {() => { id: string, kind: string, count: number, capacity: number, shown: boolean }[]} list
 *
 * @typedef {object} LineOptions
 *   A dynamic polyline (src/globe/lines.js checks and defaults these).
 * @property {string} id Unique among the engine's live lines.
 * @property {number} widthPx Width in CSS pixels.
 * @property {number[]} color rgba in 0..1.
 * @property {number} [depthFailAlpha] 0..1: where the scene hides the line, a
 *   copy drawn with its alpha scaled by this (Cesium's depthFailAppearance);
 *   0 (the default) draws nothing there.
 * @property {{ lengthPx: number, gapPx: number } | 'tactical'} [dash]
 *   Dashes in pixels along the screen direction (Cesium's PolylineDash), or
 *   the launches' selected-orbit pattern over the whole line.
 * @property {'none'|'geodesic'} [arc] 'geodesic' follows great circles
 *   between points (Cesium's ArcType.GEODESIC); 'none' (default) draws
 *   straight segments.
 * @property {Matrix4} [modelMatrix] Applied to the positions (an orbit ring
 *   turned by GMST).
 * @property {any} [pickId] What a pick of the line returns; a line without
 *   one is not picked (Navara uses CPU segment picks; lines do not
 *   participate in its GPU pass).
 *
 * @typedef {object} Line
 * @property {(positions: Cartesian3[] | Float64Array) => void} setPositions
 * @property {(color: number[]) => void} setColor
 * @property {(matrix: Matrix4) => void} setModelMatrix
 * @property {(visible: boolean) => void} show
 * @property {() => void} destroy
 *   Every call requests a render; nothing animates on its own.
 *
 * @typedef {object} LineSegments
 *   A batch of independent, straight, solid, depth-tested world segments.
 *   replace copies the items; commit draws them together. Omitting an item
 *   removes it. Width and colour default to the batch's options. Each item
 *   has its own pickId; picks name the batch as owner. Empty batches draw nothing.
 * @property {(items: { positions: Cartesian3[] | Float64Array, widthPx?: number, color?: number[], pickId?: any }[]) => void} replace
 *   Exactly two positions per segment, never connected to other segments.
 * @property {() => void} commit
 * @property {(visible: boolean) => void} show
 * @property {() => void} destroy
 *
 * @typedef {object} GlobeLines
 * @property {(options: LineOptions) => Line} createLine
 * @property {(options: { id: string, widthPx: number, color: number[], order?: number }) => LineSegments} createSegments
 *   Shares the live id namespace and list with createLine. No dash, arc,
 *   model matrix or depth-fail copy; each segment is two Earth-fixed endpoints.
 * @property {() => { id: string, points: number, shown: boolean, pickIds?: any[] }[]} list
 *
 * @typedef {object} GroundSetOptions
 *   A set of flat fills draped on the ground: on terrain and 3D tiles,
 *   following their relief, under every mover, line and model (Cesium:
 *   GroundPrimitive and GroundPolylinePrimitive; src/globe/ground.js checks
 *   and defaults these). Nothing is extruded.
 * @property {boolean} [reveal] Unpickable pixel corridors support a mutable reveal fraction.
 * @property {string} id Unique among the engine's live ground sets.
 * @property {'polygon'|'disc'|'cell'|'corridor'} kind One kind of item per
 *   set (GroundItem).
 * @property {number} [order] Draw order among ground sets (higher draws
 *   later, on top); 0 by default. Within a set a later item draws on top.
 * @property {boolean} [dynamic] Changing paths: build synchronously once
 *   terrain-height bounds are loaded, so a reveal does not replace worker
 *   geometry faster than it can become ready. False by default.
 * @property {boolean} [pickable] Whether picks return the set's items (those
 *   with a pickId); false by default: picks pass through to what lies under.
 * @property {'both'|'terrain'|'tiles'} [drape] What the fills drape on:
 *   terrain and 3D tiles ('both', the default), or only one of them
 *   (Cesium's classificationType).
 *
 * @typedef {object} GroundRadial
 * @property {number} fillAlpha Interior alpha multiplier, 0..1.
 * @property {number} rimAlpha Rim alpha multiplier, 0..1.
 * @property {number} rimStart Start of the smooth rim, fraction of radius.
 * @property {number} rimEnd End of the smooth rim; 0 <= rimStart < rimEnd < 1.
 *   The outer edge fades smoothly from rimEnd to 1.
 * @property {number} emission Nonnegative rim colour gain.
 *
 * @typedef {object} GroundItem
 *   One fill, by its set's kind. Positions are [longitude, latitude] in
 *   degrees (GeoJSON order); edges follow great circles; colours are rgba in
 *   0..1 (the alpha is the fill's opacity).
 *   - polygon: `rings` [outer, ...holes], each a list of positions (a
 *     closing copy of the first is allowed);
 *   - disc: `center` and `radiusM`, metres along the ground;
 *   - cell: `west`, `south`, `east`, `north` (west > east across the
 *     antimeridian), edges along meridians and parallels;
 *   - corridor: `positions` (a line), `color`, and `widthPx` (CSS pixels) or
 *     `widthM` (metres). A `widthPx` corridor may take a look that Cesium's
 *     ground polyline materials drew, worked out on the GPU each frame:
 *     `glow` ({ power, taper = 1 }: PolylineGlow's glowPower and
 *     taperPower, brighter toward the centre line and fading to its
 *     edges), `pulse` ({ periodMs, min, max }: the alpha times a factor
 *     going from min to max and back, a sine of the page's monotonic clock,
 *     performance.now()) and `dash` ({ cells, duty, speed = 0,
 *     gapAlpha = 0, emission = 0 }: `cells` dashes along the whole line,
 *     each lit for its first `duty` with an edge of 0.08 of a cell, moving
 *     toward the line's end at `speed` cells a second; between them the
 *     alpha times `gapAlpha`; a lit dash brightened by `emission` times its
 *     colour). A shown set with a pulse or a dash keeps the engine drawing
 *     a frame after every frame, as Cesium's continuous render did.
 *   A pixel corridor may take `backing: { widthPx, color }`, wider than its
 *   core. The edge uses the backing colour and alpha; the core is blended
 *   once, without a second layer underneath it.
 *   A corridor may instead take `dashPattern` ({ lengthPx, pattern = 255 }):
 *   a static 16-bit mask repeated every lengthPx CSS pixels, with clear
 *   gaps, as PolylineDash. It cannot combine with the other looks.
 *   Polygons, discs and cells take `fill` (omitted: none) and `outline`
 *   ({ color, widthPx }, a ground line on the boundary of every ring;
 *   omitted: none). Every kind takes `pickId`: what a pick of the item
 *   returns (an item without one is not picked).
 *
 * @property {GroundRadial} [radial] Disc with fill: radial alpha and emission.
 *
 * @typedef {object} GroundSet
 * @property {string} id
 * @property {(fraction: number) => void} setReveal Reveal each corridor from 0..1
 *   of its length without rebuilding geometry; requires reveal: true.
 * @property {(items: GroundItem[]) => void} replace Checks and stores every
 *   item at once (the previous items go); drawn after commit().
 * @property {() => void} commit Draws the stored items in place of the last
 *   ones (one rebuild) and requests a render; picks answer from what was
 *   committed.
 * @property {(visible: boolean) => void} show Shown when created.
 * @property {() => boolean} shown
 * @property {() => number} count Items committed.
 * @property {() => boolean} ready Whether the last commit is drawn (Cesium
 *   builds ground geometry in workers, a few frames later).
 * @property {() => void} destroy
 *
 * @typedef {object} GroundPulseOptions
 *   An unpickable radial field on the ellipsoid, raised by heightM. Up to
 *   four fronts have a CSS-pixel line and halo with a quadratic band fading
 *   inward. The caller owns timing and frame requests; updates do not
 *   rebuild geometry or start a render loop.
 * @property {string} id Unique among ground sets and pulse fields.
 * @property {Cartesian3} center Earth-fixed metres on the ellipsoid.
 * @property {number} radiusM Radius along the surface, metres.
 * @property {number} [heightM] Height above the ellipsoid, default 0.
 * @property {number[]} color Band rgba in 0..1.
 * @property {number[]} lineColor Front rgba in 0..1.
 * @property {number[]} haloColor Halo rgba in 0..1.
 * @property {number} depth Band depth as a fraction of radiusM, in (0, 1].
 * @property {number} lineWidth Front width including its halo, CSS pixels.
 * @property {number} haloWidth Halo width, half on each side, CSS pixels.
 *
 * @typedef {object} GroundPulseField
 * @property {string} id
 * @property {(state: { radii: number[], alphas: number[], level: number }) => void} draw
 *   Copies up to four front radii (fractions of radiusM) and opacities in
 *   0..1; absent slots are zero. Level in 0..1 controls visibility (zero
 *   hides); alphas already include the level. Initially hidden.
 * @property {(center: Cartesian3) => void} move
 * @property {() => void} destroy Idempotent; later draw/move calls do nothing.
 * @property {() => boolean} isDestroyed
 *
 * @typedef {object} GlobeGround
 * @property {(options: GroundSetOptions) => GroundSet} createSet
 * @property {(options: GroundPulseOptions) => GroundPulseField} createPulseField
 * @property {() => { id: string, kind: string, count: number, shown: boolean, order: number, animated: boolean }[]} list
 *   `animated`: the last commit has a pulse or a dash.
 *
 * @typedef {{ west: number, south: number, east: number, north: number }} DegreeRectangle
 *   Degrees; south below north; west > east crosses the antimeridian.
 *
 * @typedef {object} ImagerySource
 *   What an imagery layer draws, and where (src/globe/imagery.js checks and
 *   defaults these). Two kinds:
 *   - tiles: `{ kind: 'tiles', url, subdomains?, minLevel?, maxLevel?,
 *     tileSize?, rectangle?, credit?, opaque?, maxRequests?, scheme?,
 *     transform? }`, XYZ tiles; `url` holds {z}, {x} and {y}, and {s} for
 *     one of `subdomains` (['a', 'b', 'c']); levels 0..18 and 256 px tiles
 *     by default; `opaque` tiles have no alpha (Cesium uploads them as
 *     RGB); `maxRequests` caps the layer's tile requests in flight (Cesium:
 *     unbounded by default; Navara loads 6 at a time); `scheme` is
 *     'webMercator' (the default) or 'geographic' (EPSG:4326, 2×1 tiles at
 *     level 0, y down from 90°N); `transform(image)` turns each decoded tile
 *     (row 0 on the north edge) into the canvas or image that draws (the
 *     weather's infrared mask);
 *   - image: `{ kind: 'image', image | url, rectangle?, credit? }`, one
 *     image stretched over the rectangle in longitude and latitude
 *     (equirectangular, row 0 on the north edge): a canvas, an ImageBitmap
 *     or image element, `{ width, height, data }` RGBA bytes, or an image
 *     URL the engine loads.
 *   `rectangle` (DegreeRectangle) bounds what draws: the globe when omitted
 *   (Web Mercator tiles stop at ±85.05°). `credit` is HTML, shown while the
 *   layer is.
 * @property {'tiles'|'image'} kind
 *
 * @typedef {object} ImageryLayerOptions
 *   A raster layer draped on the ground: on terrain and 3D tiles, following
 *   their relief, under every ground fill, mover, line and model; colours are
 *   the image's own, blended by its alpha times the layer's (Cesium: an
 *   ImageryLayer on the imagery stack of the surface shown).
 * @property {string} id Unique among the engine's live imagery layers.
 * @property {ImagerySource} source
 * @property {number} [alpha] 0..1, 1 by default.
 * @property {boolean} [show] Shown when created unless false.
 * @property {'none'|'left'|'right'} [split] The side of the split position
 *   the layer draws on ('none', the default: both). Cesium splits on the
 *   globe only.
 * @property {number} [order] Draw order among imagery layers (higher draws
 *   later, on top); 0 by default, then creation order. Every imagery layer
 *   draws above the base imagery.
 * @property {number} [raise] Metres above the ellipsoid: the layer draws on
 *   a shell that high instead of draping, over terrain, 3D tiles and the
 *   sky's edge, hidden only by what is nearer; the shell rises with the
 *   camera (imagery.js raisedLift) so coarse far tiles never hide it. Image
 *   sources only. Cesium draws it as a primitive (no split); raised layers
 *   draw in the imagery order among themselves.
 *
 * @typedef {object} ImageryLayer
 * @property {string} id
 * @property {(source: ImagerySource, options?: { staged?: boolean, signal?: AbortSignal }) => (Promise<boolean>|undefined)} setSource
 *   Draws `source` in place of the last one, at the layer's place in the
 *   order; the same canvas again draws its new pixels, and a source that
 *   differs only in its credit keeps its pixels. `staged`: the drawn
 *   source stays until the new one is complete (an image loaded and
 *   uploaded; the tiles in view loaded — Cesium: its requests in and quiet,
 *   at alpha 0 above the drawn one; Navara: its own atlas), then replaces
 *   it; resolves true then, false when it failed (an image or a tile that
 *   would not load), was aborted by `signal`, or was replaced by another
 *   setSource first. A hidden layer takes a staged source at once.
 * @property {() => object} source The checked source drawn.
 * @property {() => boolean} staging Whether a staged source is on its way.
 * @property {(detail: { image: object, rectangle: DegreeRectangle } | null) => Promise<boolean>} setDetail
 *   A raised layer only: inside `rectangle` (not across 180°) it draws
 *   `image` in place of its own source (a sharper view of one area); the
 *   last detail draws until the new one is uploaded (Cesium: its own image
 *   covers a moved window until then); resolves true once it draws, false
 *   when replaced first. null clears it at once.
 * @property {() => object | null} detail
 * @property {() => number | null} raise
 * @property {(alpha: number) => void} setAlpha A fade: at 0 the layer draws
 *   nothing but stays on its surface (Cesium keeps its tiles mapped), so it
 *   comes back without a gap.
 * @property {() => number} alpha
 * @property {(visible: boolean) => void} show Shows or hides the layer
 *   (Cesium unmaps a hidden layer's tiles: hide with show, fade with alpha).
 * @property {() => boolean} shown
 * @property {(side: 'none'|'left'|'right') => void} setSplit
 * @property {() => 'none'|'left'|'right'} split
 * @property {() => boolean} ready Whether the source is built and drawn
 *   from the next frame (an image URL loaded); tiles arrive after it.
 * @property {() => void} destroy
 *   Every call requests a render; nothing animates on its own.
 *
 * @typedef {object} GlobeImagery
 * @property {(options: ImageryLayerOptions) => ImageryLayer} createLayer
 * @property {() => { id: string, kind: string, shown: boolean, alpha: number, split: string, order: number }[]} list
 *   In draw order, bottom first.
 * @property {(fraction: number) => void} setSplitPosition Where the split
 *   runs: a fraction of the canvas width from its left edge (0..1); layers
 *   split 'left' draw left of it, 'right' right of it. One per engine
 *   (Cesium's scene.splitPosition).
 * @property {() => number} splitPosition 0.5 until set.
 * @property {() => 'globe'|'tiles'|'none'} surface Where imagery drapes
 *   now: the globe, 3D tiles, or nothing (a Cesium stack with neither
 *   draws no imagery until one shows; the layers wait).
 *
 * @typedef {object} MeshOptions
 * @property {string} id Unique within the engine.
 * @property {ArrayLike<number>} positions Flat Earth-fixed xyz metres, copied.
 * @property {ArrayLike<number>} indices Triangle vertex indices, copied.
 * @property {ArrayLike<number>} [uv] Texture coordinates, (0,0) at bottom left.
 * @property {number[]} [color] RGBA in 0..1, white by default; multiplies image.
 * @property {object|null} [image] Canvas, image or video; caller owns its lifetime.
 * @property {boolean} [show=true]
 * @property {'normal'|'always'} [depthTest='normal']
 * @property {any} [pickId] Null disables picking. Both faces draw and pick.
 *
 * @typedef {object} GlobeMesh
 * @property {string} id
 * @property {(patch: Partial<MeshOptions>) => void} update Updates geometry or style.
 *   Repeating an image uploads changed pixels. Omitted fields retain their values.
 * @property {(visible?: boolean) => (boolean|void)} show Read or set visibility.
 * @property {() => void} destroy Idempotent; releases engine-owned resources.
 *
 * @typedef {object} GlobeMeshes
 * @property {(options: MeshOptions) => GlobeMesh} createMesh
 * @property {() => string[]} list Live mesh ids in creation order.
 *
 * @typedef {object} GlobeEngine
 * @property {'cesium'|'navara'} kind
 * @property {{ container: object, canvas: object, size: () => { width: number, height: number } }} host
 * @property {GlobeCamera} camera
 * @property {{ pick: (screen: Cartesian2, width?: number, height?: number) => (PickResult | undefined), drillPick: (screen: Cartesian2, limit?: number, width?: number, height?: number) => PickResult[], pickPosition: (screen: Cartesian2) => (Cartesian3 | undefined), pickPositionSupported: boolean, pickGlobe: (screen: Cartesian2) => (Cartesian3 | undefined) }} picker
 *   pickGlobe: where the ray through a window position meets the globe
 *   surface (terrain, not tiles or models; Cesium's globe.pick of the camera's
 *   pick ray); an engine without a terrain surface answers the ellipsoid.
 *   pickPosition reads the depth of the last drawn frame: after a camera change,
 *   request a render and wait a frame before reading it.
 * @property {GlobeProjector} projector
 * @property {{ preUpdate: EngineEvent, preRender: EngineEvent, postRender: EngineEvent }} frames Listeners receive a timestamp in ms.
 * @property {GlobeRender} render
 * @property {GlobeSurface} surface
 * @property {GlobeInput} input
 * @property {{ addStatic: (html: string, options?: { onScreen?: boolean }) => () => void }} credits
 * @property {GlobeMaps} maps
 * @property {GlobeClock} clock
 * @property {GlobeMovers} movers The layers' moving objects (sprites,
 *   points, models), drawn by the engine.
 * @property {GlobeLines} lines The layers' dynamic polylines.
 * @property {GlobeMeshes} meshes World triangles.
 * @property {GlobeGround} ground The layers' fills on the ground.
 * @property {GlobeImagery} imagery The layers' rasters on the ground.
 * @property {() => void} destroy
 * @property {() => boolean} isDestroyed True once destroy() has run.
 * @property {{ cesium?: object, navara?: object }} [extensions]
 *   What only one engine has, under its kind: Cesium's Viewer, Navara's view
 *   and SDK classes. Not part of the contract: only code written against that
 *   engine reads it, and scripts/report-engine-coupling.mjs counts each read
 *   outside src/globe.
 */

export const ENGINE_KINDS = Object.freeze(['cesium', 'navara']);
export const INPUT_TYPES = Object.freeze([
  'click',
  'doubleClick',
  'move',
  'down',
  'up',
]);
export const MODIFIERS = Object.freeze(['ctrl', 'shift', 'alt']);
/** Input types whose listeners may ask for picks. */
const PICK_INPUT_TYPES = Object.freeze([
  'click',
  'doubleClick',
  'move',
  'down',
]);

/**
 * input.on options checked and defaulted: { modifier, pick, drill } (drill
 * 0 when not asked), or a TypeError.
 */
export function normalizeInputOptions(type, options = {}) {
  const { modifier, pick = false, drill = 0, pickWindow } = options ?? {};
  if (!INPUT_TYPES.includes(type))
    throw new TypeError(`Unknown input type: ${type}`);
  if (modifier !== undefined && !MODIFIERS.includes(modifier))
    throw new TypeError(`Unknown input modifier: ${modifier}`);
  if (typeof pick !== 'boolean')
    throw new TypeError(`Input pick must be a boolean: ${pick}`);
  if (!(Number.isInteger(drill) && drill >= 0))
    throw new TypeError(`Input drill must be a whole number: ${drill}`);
  if ((pick || drill) && !PICK_INPUT_TYPES.includes(type))
    throw new TypeError(`Input ${type} cannot pick`);
  if (
    pickWindow !== undefined &&
    (!pickWindow ||
      !Number.isInteger(pickWindow.width) ||
      pickWindow.width <= 0 ||
      !Number.isInteger(pickWindow.height) ||
      pickWindow.height <= 0)
  )
    throw new TypeError(
      'Input pickWindow needs positive integer width and height',
    );
  if (pickWindow && !(pick || drill))
    throw new TypeError('Input pickWindow needs pick or drill');
  return {
    modifier,
    pick: pick || drill > 0,
    drill,
    ...(pickWindow
      ? {
          pickWindow: Object.freeze({
            width: pickWindow.width,
            height: pickWindow.height,
          }),
        }
      : {}),
  };
}

/** Validated optional horizon ellipsoid radii; undefined selects WGS84. */
export function horizonEllipsoidRadii(options) {
  if (options?.ellipsoid === undefined) return undefined;
  const radii = options.ellipsoid?.radii;
  if (
    !radii ||
    !Number.isFinite(radii.x) ||
    radii.x <= 0 ||
    !Number.isFinite(radii.y) ||
    radii.y <= 0 ||
    !Number.isFinite(radii.z) ||
    radii.z <= 0
  )
    throw new TypeError('Horizon ellipsoid needs positive finite radii');
  return radii;
}

const ENGINE_EVENT = Symbol('gev.globe.engineEvent');

/** Whether a value is an event made by createEngineEvent. */
export const isEngineEvent = (value) =>
  value != null && value[ENGINE_EVENT] === true;

/**
 * An event with the contract's semantics (see EngineEvent). `raiseEvent` and
 * `raiseValue` (one argument, no argument list: for per-frame events) are for
 * engine implementations; a listener that throws propagates, and the event
 * stays usable.
 */
export function createEngineEvent() {
  let entries = [];
  let depth = 0;
  let removedDuringRaise = false;
  const active = (listener) =>
    entries.find((entry) => entry.listener === listener);
  const removeEntry = (entry) => {
    if (!entry.listener) return false;
    entry.listener = null;
    if (depth) removedDuringRaise = true;
    else entries.splice(entries.indexOf(entry), 1);
    return true;
  };
  const settle = () => {
    depth--;
    if (!depth && removedDuringRaise) {
      entries = entries.filter((entry) => entry.listener);
      removedDuringRaise = false;
    }
  };
  const event = {
    get numberOfListeners() {
      return entries.reduce(
        (count, entry) => count + (entry.listener ? 1 : 0),
        0,
      );
    },
    addEventListener(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Engine event listener must be a function');
      let entry = active(listener);
      if (!entry) {
        entry = { listener };
        entries.push(entry);
      }
      return () => {
        removeEntry(entry);
      };
    },
    removeEventListener(listener) {
      const entry = active(listener);
      return entry ? removeEntry(entry) : false;
    },
    raiseEvent(...args) {
      const snapshot = entries;
      const length = snapshot.length;
      depth++;
      try {
        for (let index = 0; index < length; index++) {
          const listener = snapshot[index].listener;
          if (listener) listener(...args);
        }
      } finally {
        settle();
      }
    },
    // raiseEvent(value) without an argument list, for per-frame events.
    raiseValue(value) {
      const snapshot = entries;
      const length = snapshot.length;
      depth++;
      try {
        for (let index = 0; index < length; index++) {
          const listener = snapshot[index].listener;
          if (listener) listener(value);
        }
      } finally {
        settle();
      }
    },
  };
  Object.defineProperty(event, ENGINE_EVENT, { value: true });
  return event;
}

const isFunction = (value) => typeof value === 'function';
const isObject = (value) =>
  value != null && (typeof value === 'object' || typeof value === 'function');
const isBoolean = (value) => typeof value === 'boolean';
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

// Capability → member → predicate. Members not listed here are free extensions.
const SHAPE = {
  host: { container: isObject, canvas: isObject, size: isFunction },
  camera: {
    pose: isFunction,
    livePosition: (value) =>
      value != null &&
      isNumber(value.x) &&
      isNumber(value.y) &&
      isNumber(value.z),
    height: isFunction,
    setView: isFunction,
    flyTo: isFunction,
    flyToSphere: isFunction,
    flightActive: isFunction,
    lookAt: isFunction,
    lookAtTransform: isFunction,
    transform: isFunction,
    release: isFunction,
    cancelFlight: isFunction,
    completeFlight: isFunction,
    zoomIn: isFunction,
    zoomOut: isFunction,
    viewRectangle: isFunction,
    pickEllipsoid: isFunction,
    pickRay: isFunction,
    changed: isEngineEvent,
    moveStart: isEngineEvent,
    moveEnd: isEngineEvent,
    commanded: isEngineEvent,
    follow: isFunction,
    following: isFunction,
    followChanged: isEngineEvent,
    percentageChanged: isNumber,
  },
  picker: {
    pick: isFunction,
    drillPick: isFunction,
    pickPosition: isFunction,
    pickPositionSupported: isBoolean,
    pickGlobe: isFunction,
  },
  projector: {
    worldToWindow: isFunction,
    viewProjection: isFunction,
    horizonVisible: isFunction,
  },
  frames: {
    preUpdate: isEngineEvent,
    preRender: isEngineEvent,
    postRender: isEngineEvent,
  },
  render: {
    request: isFunction,
    setContinuous: isFunction,
    isContinuous: isFunction,
    maxTextureSize: isFunction,
    setSharpen: isFunction,
    sharpen: isFunction,
  },
  surface: {
    sampleHeight: isFunction,
    sampleHeightDetailed: isFunction,
    supported: isBoolean,
    terrainHeight: isFunction,
    terrainHeightSupported: isBoolean,
    sampleTerrainMostDetailed: isFunction,
    clampToHeight: isFunction,
    clampToHeightSupported: isBoolean,
    tilesLoaded: isFunction,
    raycast: isFunction,
  },
  input: {
    on: isFunction,
    acquirePointer: isFunction,
    suspendCameraInputs: isFunction,
    cameraInputsEnabled: isFunction,
  },
  credits: { addStatic: isFunction },
  clock: { now: isFunction, frameTime: isFunction },
  movers: { createSet: isFunction, list: isFunction },
  lines: {
    createLine: isFunction,
    createSegments: isFunction,
    list: isFunction,
  },
  meshes: { createMesh: isFunction, list: isFunction },
  ground: {
    createSet: isFunction,
    createPulseField: isFunction,
    list: isFunction,
  },
  imagery: {
    createLayer: isFunction,
    list: isFunction,
    setSplitPosition: isFunction,
    splitPosition: isFunction,
    surface: isFunction,
  },
  maps: {
    setBaseImagery: isFunction,
    setTerrain: isFunction,
    setPhotorealTiles: isFunction,
    releasePhotorealTiles: isFunction,
    photorealActive: isFunction,
    current: isFunction,
    terrainRevision: isFunction,
  },
};

/** Required capability members checked by assertGlobeEngine. */
export function engineContractMembers() {
  return Object.entries(SHAPE)
    .flatMap(([namespace, members]) =>
      Object.keys(members).map((member) => `${namespace}.${member}`),
    )
    .sort();
}

const isNameList = (value) =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((name) => typeof name === 'string' && name.length > 0);

// Optional capabilities: flag → member path → predicate. An engine has each
// group whole or not at all (assertGlobeEngine); engineCapabilities says
// which it has.
const OPTIONAL_SHAPE = {
  tileErrors: { 'maps.errors': isEngineEvent },
  visualStyles: {
    'render.visualStyles': isNameList,
    'render.setStyle': isFunction,
    'render.style': isFunction,
  },
  bloom: {
    'render.setBloom': isFunction,
    'render.bloom': isFunction,
  },
  cloudCover: {
    'render.setCloudCover': isFunction,
    'render.cloudCover': isFunction,
  },
  contactSonar: {
    'render.setContactSonar': isFunction,
    'render.contactSonar': isFunction,
  },
};

const memberAt = (engine, path) =>
  path.split('.').reduce((value, key) => value?.[key], engine);

/**
 * Which optional capabilities an engine has: { visualStyles, ... } as
 * booleans. A caller that refuses a feature on an engine without one
 * (voice, say) asks here. Cesium and Navara draw the styles, bloom and
 * contact sonar; only Navara has cloudCover.
 */
export function engineCapabilities(engine) {
  const whole = (members) =>
    isObject(engine) &&
    Object.entries(members).every(([path, valid]) =>
      valid(memberAt(engine, path)),
    );
  return Object.fromEntries(
    Object.entries(OPTIONAL_SHAPE).map(([flag, members]) => [
      flag,
      whole(members),
    ]),
  );
}

/**
 * Whether a value is a globe engine rather than, say, a Cesium viewer (a
 * cheap structural test; assertGlobeEngine checks every member).
 */
export const isGlobeEngine = (value) =>
  isObject(value) &&
  ENGINE_KINDS.includes(value.kind) &&
  isObject(value.camera) &&
  isObject(value.projector) &&
  isObject(value.frames) &&
  isFunction(value.destroy);

/** Throws a TypeError naming every missing or mistyped member; returns the engine. */
export function assertGlobeEngine(engine) {
  if (!isObject(engine)) throw new TypeError('GlobeEngine must be an object');
  const problems = [];
  if (!ENGINE_KINDS.includes(engine.kind)) problems.push('kind');
  for (const [capability, members] of Object.entries(SHAPE)) {
    const value = engine[capability];
    if (!isObject(value)) {
      problems.push(capability);
      continue;
    }
    for (const [member, valid] of Object.entries(members))
      if (!valid(value[member])) problems.push(`${capability}.${member}`);
  }
  // An optional capability is whole or absent.
  for (const members of Object.values(OPTIONAL_SHAPE)) {
    const paths = Object.keys(members);
    if (paths.every((path) => memberAt(engine, path) === undefined)) continue;
    for (const [path, valid] of Object.entries(members))
      if (!valid(memberAt(engine, path))) problems.push(path);
  }
  if (!isFunction(engine.destroy)) problems.push('destroy');
  if (!isFunction(engine.isDestroyed)) problems.push('isDestroyed');
  if (problems.length)
    throw new TypeError(
      `GlobeEngine is missing or mistypes: ${problems.join(', ')}`,
    );
  return engine;
}

/** The sharpening an engine starts with (GlobeRender.sharpen). */
export const SHARPEN_INITIAL = Object.freeze({ enabled: false, amount: 1 });

/**
 * GlobeRender.setSharpen's argument merged onto `current`: a new state, or a
 * TypeError for a non-boolean `enabled` or a negative or non-finite `amount`.
 */
export function mergeSharpen(current, { enabled, amount } = {}) {
  if (enabled !== undefined && !isBoolean(enabled))
    throw new TypeError(`Sharpen enabled must be a boolean: ${enabled}`);
  if (amount !== undefined && !(isNumber(amount) && amount >= 0))
    throw new TypeError(
      `Sharpen amount must be a finite number >= 0: ${amount}`,
    );
  return {
    enabled: enabled ?? current.enabled,
    amount: amount ?? current.amount,
  };
}

/** A style's state before it is first set (GlobeRender.style), less its uniforms. */
export const STYLE_INITIAL = Object.freeze({ intensity: 0 });

/**
 * GlobeRender.setStyle's argument merged onto `current` ({ intensity,
 * uniforms }): a new state, or a TypeError for an intensity outside 0..1, a
 * uniform not in `names` or a non-finite uniform value.
 */
export function mergeStyle(current, { intensity, uniforms } = {}, names = []) {
  if (
    intensity !== undefined &&
    !(isNumber(intensity) && intensity >= 0 && intensity <= 1)
  )
    throw new TypeError(
      `Style intensity must be a number in 0..1: ${intensity}`,
    );
  if (
    uniforms !== undefined &&
    (uniforms === null || typeof uniforms !== 'object')
  )
    throw new TypeError('Style uniforms must be an object');
  const next = { ...current.uniforms };
  for (const [name, value] of Object.entries(uniforms ?? {})) {
    if (!names.includes(name))
      throw new TypeError(`Unknown style uniform: ${name}`);
    if (!isNumber(value))
      throw new TypeError(
        `Style uniform ${name} must be a finite number: ${value}`,
      );
    next[name] = value;
  }
  return { intensity: intensity ?? current.intensity, uniforms: next };
}

/** The bloom an engine starts with (GlobeRender.bloom). */
export const BLOOM_INITIAL = Object.freeze({ enabled: false, strength: 0 });

/**
 * GlobeRender.setBloom's argument merged onto `current`: a new state, or a
 * TypeError for a non-boolean `enabled` or a strength outside 0..1.
 */
export function mergeBloom(current, { enabled, strength } = {}) {
  if (enabled !== undefined && !isBoolean(enabled))
    throw new TypeError(`Bloom enabled must be a boolean: ${enabled}`);
  if (
    strength !== undefined &&
    !(isNumber(strength) && strength >= 0 && strength <= 1)
  )
    throw new TypeError(`Bloom strength must be a number in 0..1: ${strength}`);
  return {
    enabled: enabled ?? current.enabled,
    strength: strength ?? current.strength,
  };
}

/** The cloud cover an engine starts with (GlobeRender.cloudCover): its own. */
export const CLOUD_COVER_INITIAL = Object.freeze({ coverage: null });

/**
 * GlobeRender.setCloudCover's argument merged onto `current`: a new state,
 * or a TypeError for a coverage that is neither null nor in 0..1.
 */
export function mergeCloudCover(current, { coverage } = {}) {
  if (
    coverage !== undefined &&
    coverage !== null &&
    !(isNumber(coverage) && coverage >= 0 && coverage <= 1)
  )
    throw new TypeError(
      `Cloud coverage must be null or a number in 0..1: ${coverage}`,
    );
  return { coverage: coverage === undefined ? current.coverage : coverage };
}

/** The contact sonar an engine starts with (GlobeRender.contactSonar): off. */
export const CONTACT_SONAR_INITIAL = Object.freeze({
  enabled: false,
  active: false,
  angleDeg: 0,
  range: 100,
  opacity: 84,
  sector: 24,
});

/**
 * GlobeRender.setContactSonar's argument merged onto `current`: a new
 * state, or a TypeError for a non-boolean flag, a non-finite angle, a range
 * that is not positive, an opacity outside 0..100 or a sector outside
 * (0, 360].
 */
export function mergeContactSonar(current, options = {}) {
  const next = { ...current };
  for (const key of ['enabled', 'active']) {
    if (options[key] === undefined) continue;
    if (!isBoolean(options[key]))
      throw new TypeError(`Sonar ${key} must be a boolean: ${options[key]}`);
    next[key] = options[key];
  }
  const numbers = {
    angleDeg: () => true,
    range: (value) => value > 0,
    opacity: (value) => value >= 0 && value <= 100,
    sector: (value) => value > 0 && value <= 360,
  };
  for (const [key, valid] of Object.entries(numbers)) {
    const value = options[key];
    if (value === undefined) continue;
    if (!isNumber(value) || !valid(value))
      throw new TypeError(`Sonar ${key} is out of range: ${value}`);
    next[key] = value;
  }
  return next;
}
