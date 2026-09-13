const GEV_REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'fly_to_location',
    description:
      "Fly the God's Eye View camera to a known city, geocoded country/region/city/landmark, or explicit WGS84 coordinate. Countries/cities frame the whole place; landmarks/buildings use close framing.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
          description:
            'Known city preset ID. Use when the requested place matches one of these cities.',
        },
        query: {
          type: 'string',
          description:
            'Plain place search query, e.g. "London", "Eiffel Tower", or "Dubai Marina".',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        viewMode: {
          type: 'string',
          enum: ['close', 'overview'],
          description:
            'Optional framing intent. Usually omit this; GEV infers whole-place framing for countries/cities and close framing for landmarks.',
        },
        rangeM: {
          type: 'number',
          minimum: 100,
          maximum: 20000000,
          description:
            'Optional camera range from the target in meters. Omit it for automatic whole-country/whole-city or close-landmark framing; provide it only when the user explicitly requests a numeric height or distance.',
        },
        waitForArrival: {
          type: 'boolean',
          description:
            'Set true when a later tool depends on the destination viewport. The result then waits for the camera flight and returns arrived=true; cancellation returns ok=false.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'select_nearest_aircraft',
    description:
      'Atomically fly to a place, wait for arrival, enable and load Flights or Military Flights in that viewport, exclude on-ground records, and select/follow the nearest airborne aircraft. Healthy fallback feeds remain usable and are reported in the result. This does not open Contacts or Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: ['flights', 'military'],
          description:
            'Aircraft layer to enable and search. Use flights unless the user explicitly asks for military aircraft.',
        },
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
          description:
            'Known city preset ID when the place matches one of these cities.',
        },
        locationQuery: {
          type: 'string',
          maxLength: 160,
          description: 'Free-form destination when no locationId matches.',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
      },
      required: ['layerId'],
    },
  },
  {
    type: 'function',
    name: 'adjust_camera_zoom',
    description:
      'Move the current Cesium camera closer to or farther from what it is presently looking at. Use for relative zoom requests without changing location.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        direction: {
          type: 'string',
          enum: ['in', 'out'],
        },
        amount: {
          type: 'string',
          enum: ['little', 'medium', 'lot'],
          description:
            'Use little for phrases like "a bit" or "a little", medium for ordinary zoom requests, and lot for "way out/in".',
        },
      },
      required: ['direction', 'amount'],
    },
  },
  {
    type: 'function',
    name: 'zoom_to_globe',
    description:
      'Pull the camera out to an ABSOLUTE full-Earth globe view (~18,000 km altitude, the whole planet in frame), keeping the current region centered. Use for "globe view", "whole earth", "see the planet", "zoom all the way out". Never use adjust_camera_zoom for these — its relative steps cannot reach the globe.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_layer_visibility',
    description: "Enable or disable one registered God's Eye View data layer.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          description:
            'Common-name mapping for the non-obvious ids: space mission(s) → rocket-launches; fires/wildfires/active fires → local-firms (NASA FIRMS); ships/vessels/boats → ais-live-vessels; undersea/submarine cables → telegeography-submarine-cables; datacenters → local-datacenters; dams → local-dams; bikes/bike share → bikeshare; street traffic/congestion → traffic; traffic cameras → cctv; internet radio/stations → radio.',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'rocket-launches',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
        },
        enabled: { type: 'boolean' },
      },
      required: ['layerId', 'enabled'],
    },
  },
  {
    type: 'function',
    name: 'show_data_layers_menu',
    description:
      'Open the data layers dropdown/menu and optionally scroll to a specific layer row without toggling it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layerId: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'earthquakes',
            'satellites',
            'traffic',
            'cctv',
            'radio',
            'bikeshare',
            'ais-live-vessels',
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer row to scroll into view and highlight.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'set_panel_open',
    description: 'Open or close a GEV UI panel/dropdown.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        panelId: {
          type: 'string',
          enum: [
            'data-panel',
            'location-bar',
            'control-panel',
            'cctv-panel',
            'radio-panel',
            'scene-panel',
            'pp-toggles',
            'global-context-panel',
          ],
        },
        open: { type: 'boolean' },
      },
      required: ['panelId', 'open'],
    },
  },
  {
    type: 'function',
    name: 'set_context_mode',
    description:
      'Enter or exit the Global Context sub-mode used by Contacts and Space Missions. Use Contacts only when the user explicitly requests Contacts, and Space Missions only when explicitly requested. A request to open the parent Context panel alone uses set_panel_open and must not activate either sub-mode. Selecting an aircraft does not imply Context.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['off', 'contacts', 'flights', 'space-missions', 'missions'],
          description: 'Use off to exit context mode.',
        },
      },
      required: ['mode'],
    },
  },
  {
    type: 'function',
    name: 'control_cockpit',
    description:
      'Read or control Cockpit when the user explicitly requests Cockpit: establish Contacts and enter from a selected or tracked aircraft; exit; or navigate nearby Contacts with optional filters. Selecting or viewing an aircraft alone must not enter Cockpit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['enter', 'exit', 'previous', 'next', 'prev', 'status'],
          description:
            'previous/next (or prev) navigates through nearby contacts in Cockpit context.',
        },
        targetLayer: {
          type: 'string',
          enum: [
            'flights',
            'military',
            'ais-live-vessels',
            'military-installations',
          ],
          description:
            'Optional contact layer filter for next/previous (for example military for a military-only cycle).',
        },
        aircraftClass: {
          type: 'string',
          description:
            'Optional aircraft class filter (for example helicopter) when using next/previous navigation.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'set_visual_style',
    description: "Set the active God's Eye View visual filter/style.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        style: {
          type: 'string',
          enum: [
            'normal',
            'retro',
            'surveillance',
            'thermal',
            'anime',
            'noir',
            'snow',
          ],
        },
      },
      required: ['style'],
    },
  },
  {
    type: 'function',
    name: 'get_entity_context',
    description:
      'Get current GEV scene context, including basemap/3D-tile target context, selected entity metadata if active, and entities currently visible in the camera view.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['auto', 'selected', 'in_view'],
          description:
            'Use auto by default. selected returns the clicked/selected entity; in_view returns visible entities near the screen center.',
        },
        layerId: {
          type: 'string',
          enum: [
            'local-datacenters',
            'local-dams',
            'telegeography-submarine-cables',
            'local-firms',
          ],
          description: 'Optional layer filter for visible entity context.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 12,
        },
      },
    },
  },
  {
    type: 'function',
    name: 'get_current_view_state',
    description:
      'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, and layer state before choosing another action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'set_hud',
    description:
      'Control the intelligence HUD overlay: visibility and/or layout variant.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        visible: {
          type: 'string',
          enum: ['on', 'off', 'auto'],
          description: 'auto restores style-driven show/hide.',
        },
        layout: { type: 'string', enum: ['tactical', 'operator', 'minimal'] },
      },
    },
  },
  {
    type: 'function',
    name: 'set_detection',
    description:
      'Control the detection overlay: on/off, density-derived Sparse/Balanced/Dense profile, and Elastic/Weighted layer allocation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          description:
            'false turns detection OFF; true restores the current density-derived profile.',
        },
        mode: { type: 'string', enum: ['sparse', 'balanced', 'dense'] },
        densityPct: {
          type: 'number',
          description:
            'Density snaps to 0, 25, 50, 75, or 100 and derives the active profile.',
        },
        allocationStrategy: {
          type: 'string',
          enum: ['elastic', 'weighted'],
          description:
            'Elastic splits evenly then lends unused slots; Weighted follows demand and semantic weight.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'set_map_stack',
    description:
      'Switch the basemap/imagery stack (NOT the satellites data layer and NOT a visual style filter).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        stack: {
          type: 'string',
          enum: [
            'photoreal',
            'bing-aerial',
            'bing-labels',
            'esri-imagery',
            'osm',
          ],
          description:
            'photoreal = Google 3D. Use bing-aerial only when the user explicitly says "Bing aerial" — "satellite(s)" never means a basemap; only the explicit phrase "Esri" / "Esri imagery" means esri-imagery.',
        },
      },
      required: ['stack'],
    },
  },
  {
    type: 'function',
    name: 'set_post_processing',
    description:
      'Control bloom and sharpen post-processing toggles and intensities.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bloom: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: {
              type: 'number',
              description: '0-200 (UI percent).',
            },
          },
        },
        sharpen: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            intensityPct: {
              type: 'number',
              description: '0-100 (UI percent).',
            },
          },
        },
      },
    },
  },
  {
    type: 'function',
    name: 'control_scene',
    description:
      'Cinematic scene playback: list scenes, play one scene by name, stop, advance, or read status. Play starts a single named scene and returns immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'play', 'stop', 'next', 'status'],
        },
        sceneId: {
          type: 'string',
          description: 'Scene id or (partial) title for play.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_cctv',
    description:
      'CCTV camera operations: enable/disable the layer, select a camera by name, next/prev/nearest/focus, toggle coverage wedges / projection overlay / auto-hop, "viewshed" for color-coded per-camera coverage volumes, and "adjust" for the on-camera calibration gizmo.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'select',
            'next',
            'prev',
            'nearest',
            'focus',
            'coverage',
            'viewshed',
            'adjust',
            'projection',
            'autohop',
          ],
        },
        cameraQuery: {
          type: 'string',
          description: 'Camera name or id for select.',
        },
        enabled: {
          type: 'boolean',
          description:
            'Explicit on/off for coverage/viewshed/adjust/projection/autohop; omit to toggle.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'control_radio',
    description:
      'Control Internet Radio playback without moving the map. Use select whenever the request includes a station category, name, country, coordinates, or nearby place—even when the user says play. Use play only for an unqualified "turn on/start the radio" request so the current or nearest station begins. Enable only reveals the Radio layer/markers without audio. Also supports disable, resume, pause, stop, next/previous, volume, and status.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'play',
            'resume',
            'pause',
            'stop',
            'next',
            'previous',
            'volume',
            'select',
            'status',
          ],
          description:
            'Use select for any request qualified by category, station, country, coordinates, or place. Use play only for an unqualified turn on/start/listen request. Use enable only when the user explicitly asks to show or enable the Radio layer or its markers without requesting audio.',
        },
        volumePct: {
          type: 'number',
          minimum: 0,
          maximum: 100,
          description:
            'Required for volume; sets the persistent Radio playback volume.',
        },
        category: {
          type: 'string',
          enum: [
            'all',
            'news',
            'talk',
            'weather',
            'public-safety',
            'aviation-marine',
            'traffic-transit',
            'music',
          ],
          description:
            'Station category for select/next/previous. When the user requests playback with a category, action must be select, not play.',
        },
        locationId: {
          type: 'string',
          enum: [
            'austin',
            'sf',
            'nyc',
            'tokyo',
            'london',
            'paris',
            'dubai',
            'dc',
          ],
          description: 'Known nearby-city anchor for select.',
        },
        locationQuery: {
          type: 'string',
          maxLength: 120,
          description:
            'Place to search near, such as "Austin, Texas" or "Seattle". Selection does not fly the camera.',
        },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        country: {
          type: 'string',
          maxLength: 80,
          description:
            'Country code or name filter, for example US or United States.',
        },
        stationQuery: {
          type: 'string',
          maxLength: 120,
          description: 'Optional station name/tag substring.',
        },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'track_entity',
    description:
      'Find and follow a specific aircraft (callsign/ICAO hex), ship (name/MMSI), or satellite (name/NORAD id) on enabled layers. Camera follows the entity.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: {
          type: 'string',
          description:
            'Callsign, ship name, satellite name, ICAO hex, MMSI, or NORAD id.',
        },
        layerId: {
          type: 'string',
          description:
            'Optional layer hint: flights | military | ais-live-vessels | satellites.',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'stop_tracking',
    description:
      'Stop following the tracked aircraft/satellite and clear any selected vessel.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'frame_overhead',
    description:
      'Cinematically frame entities near the current view: pulls the camera back and angles it so nearby aircraft, ships, or satellites are visible together.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['flights', 'military', 'satellites', 'vessels'],
        },
        radiusKm: {
          type: 'number',
          description:
            'Search radius around the view target. Defaults: 150 aircraft, 120 ships, 3000 satellites.',
        },
      },
      required: ['target'],
    },
  },
  {
    type: 'function',
    name: 'annotate_map',
    description:
      'Draw annotations on the 3D map to visually point out what you are talking about — like sketching on a whiteboard over the world. Use this whenever you mention a specific place, building, campus, boundary, district, or a relationship between two places, so the user can SEE what you mean. Give place NAMES (preferred) or explicit lat/lng; the app resolves them to real-world positions and real building/area outlines — never guess pixel positions. Call this as you begin describing something, and you may mark several places in one call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        annotations: {
          type: 'array',
          description:
            'One or more things to mark. Mark multiple related places together when describing them as a group.',
          minItems: 1,
          maxItems: 24,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                enum: ['pin', 'highlight', 'area', 'arrow', 'route', 'label'],
                description:
                  'pin = planted marker at a spot; highlight = pulsing ring drawing the eye to a point; area = trace the outline of a building/campus/compound/district; arrow = a connector from one place to another (use target as the origin and toTarget as the destination); route = a path through several waypoints (use the points array); label = a floating text callout.',
              },
              target: {
                type: 'string',
                maxLength: 200,
                description:
                  'Place name to resolve, e.g. "Palace of Fine Arts, San Francisco", "the Pentagon", "Presidio of San Francisco". Preferred over coordinates. For a specific monument/statue/feature that sits within a larger landmark, use its OWN name + city ("Tejano Monument, Austin", "Texas African American History Memorial, Austin") — do NOT phrase it as "X at the Texas State Capitol", which makes the geocoder collapse several of them onto the same centroid so they stack on one spot.',
              },
              points: {
                type: 'array',
                description:
                  'For type=route: 2+ ordered waypoints the path passes through, each a place name (or coordinates / screen point).',
                minItems: 2,
                maxItems: 12,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    target: {
                      type: 'string',
                      maxLength: 200,
                      description: 'Waypoint place name.',
                    },
                    latitude: { type: 'number', minimum: -90, maximum: 90 },
                    longitude: { type: 'number', minimum: -180, maximum: 180 },
                    screenX: { type: 'number', minimum: 0, maximum: 1 },
                    screenY: { type: 'number', minimum: 0, maximum: 1 },
                  },
                },
              },
              mode: {
                type: 'string',
                enum: ['walking', 'driving', 'cycling'],
                description:
                  'For type=route: travel mode for a real street-following route (the app returns distance + time). Pick from the verb the user used ("walk" → walking, "drive" → driving). Defaults to walking.',
              },
              latitude: {
                type: 'number',
                minimum: -90,
                maximum: 90,
                description:
                  'Explicit latitude (use only if no good place name exists).',
              },
              longitude: { type: 'number', minimum: -180, maximum: 180 },
              toTarget: {
                type: 'string',
                maxLength: 200,
                description: 'For type=arrow: the destination place name.',
              },
              toLatitude: { type: 'number', minimum: -90, maximum: 90 },
              toLongitude: { type: 'number', minimum: -180, maximum: 180 },
              label: {
                type: 'string',
                maxLength: 120,
                description:
                  'Short caption shown on the map (a few words). Optional.',
              },
              color: {
                type: 'string',
                enum: ['primary', 'amber', 'cyan', 'green', 'red'],
                description:
                  'Accent color. primary = neutral, amber = point of interest, cyan = infrastructure, green = confirmed/safe, red = alert.',
              },
              footprint: {
                type: 'boolean',
                description:
                  'For type=area/highlight: trace the real building or campus outline from map data. Defaults true for area.',
              },
              intent: {
                type: 'string',
                enum: ['the_thing', 'around_the_thing'],
                description:
                  'For type=area: "the_thing" (default) outlines the place itself (its footprint/boundary); "around_the_thing" highlights a surrounding zone (a buffered radius around it). Infer from phrasing: "the Capitol"/"show me X" → the_thing; "around/near/by X" or "the area around X" → around_the_thing.',
              },
              entityKind: {
                type: 'string',
                enum: [
                  'building',
                  'compound',
                  'district',
                  'street',
                  'point_feature',
                ],
                description:
                  'What KIND of thing the target IS — a fact, not a style choice: building = one structure; compound = campus/grounds/mall/park; district = neighborhood or area of a city; street = a named road/corridor; point_feature = monument/statue/memorial/plaque/fountain or other small point landmark. Set it whenever you know it — it routes the resolver to the right footprint source (point_feature anchors monuments as precise points instead of adopting a nearby building outline).',
              },
              screenX: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                  'Fallback only: when you cannot name/geocode the place but can SEE it in the latest viewport screenshot, the normalized horizontal position (0=left, 1=right) of the spot. The app converts it back to a real world point under that pixel.',
              },
              screenY: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                  'Fallback only: normalized vertical position (0=top, 1=bottom) of the spot in the latest viewport screenshot.',
              },
              toScreenX: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                  'For type=arrow: normalized x of the arrow destination from the screenshot (pixel fallback).',
              },
              toScreenY: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description:
                  'For type=arrow: normalized y of the arrow destination from the screenshot (pixel fallback).',
              },
            },
            required: ['type'],
          },
        },
        flyTo: {
          type: 'boolean',
          description:
            'Also move the camera to frame the first annotation. Default false — leave false if the user is already looking at the spot.',
        },
        persist: {
          type: 'boolean',
          description:
            'Keep annotations until cleared (true, default) or let them auto-fade after ~20s (false).',
        },
      },
      required: ['annotations'],
    },
  },
  {
    type: 'function',
    name: 'clear_annotations',
    description:
      'Erase ALL map annotations previously drawn with annotate_map. Call this ONLY when the user EXPLICITLY asks to clear or reset the map. Annotations accumulate and persist across navigation and topic changes by design — never clear on your own initiative.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'move_camera',
    description:
      'Direct the camera like a drone operator: orbit the current view target, pan, tilt, or rotate — one bounded nudge (mode=once) or continuous motion until stopped (mode=continuous). Continuous motion also stops on any manual camera input or when a navigation tool runs. Say the RESULTING state when confirming ("Orbiting slowly").',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        motion: {
          type: 'string',
          enum: ['orbit', 'pan', 'tilt', 'rotate', 'stop'],
        },
        direction: {
          type: 'string',
          enum: ['left', 'right', 'up', 'down'],
          description:
            'Required except for orbit (defaults right/clockwise) and stop.',
        },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
        mode: {
          type: 'string',
          enum: ['once', 'continuous'],
          description:
            'once = bounded eased nudge (default); continuous = until stop/manual input.',
        },
      },
      required: ['motion'],
    },
  },
  {
    type: 'function',
    name: 'fly_route',
    description:
      'Cinematic dolly along an EXISTING route annotation (drawn earlier with annotate_map type=route) — flies the street-following path from start to end. Omit label for the newest route. If no route is drawn, this fails with guidance: draw the route first.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: {
          type: 'string',
          description: 'Match an existing route mark by (partial) label.',
        },
        speed: { type: 'string', enum: ['slow', 'normal', 'fast'] },
      },
    },
  },
  {
    type: 'function',
    name: 'analyst_query',
    description:
      'Answer questions ABOUT the data currently loaded on the map — counts, lists, superlatives, and attribute filters over live layers (flights, military, ships, fires, earthquakes). Examples: "how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet", "fastest thing in view". Queries ONLY client-side data from ENABLED layers — if the needed layer is off, say so and offer to enable it. For a follow-up about the previous answer\'s set ("which of those is closest?"), set followUp=true and send only the new filters/sort.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        layers: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'flights',
              'military',
              'ais-live-vessels',
              'local-firms',
              'earthquakes',
            ],
          },
          description:
            'Layers to query. fires/wildfires → local-firms; ships/vessels → ais-live-vessels.',
        },
        scope: {
          type: 'object',
          additionalProperties: false,
          description:
            'Spatial scope. Default: view (near the camera). Use kind=region for "over Texas"-style asks; kind=anywhere for global questions.',
          properties: {
            kind: {
              type: 'string',
              enum: ['view', 'region', 'radius', 'anywhere'],
            },
            name: {
              type: 'string',
              description:
                'For kind=region: a state/country ("Texas", "France") or a named natural region ("the Alps", "Gulf of Mexico").',
            },
            km: { type: 'number', description: 'For kind=radius.' },
            center: {
              type: 'object',
              additionalProperties: false,
              properties: { lat: { type: 'number' }, lon: { type: 'number' } },
            },
          },
        },
        filters: {
          type: 'array',
          description:
            'Attribute predicates, ANDed. ALTITUDE IS METERS (40,000 ft = 12192). Fields: altitudeM, speedMps, military, onGround, aircraftClass, callsign, operator, routeOrigin, routeDestination, originCountry (flights); speedKts, shipType, destination (ships); frp, confidence (fires); magnitude, depthKm, place (earthquakes).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              field: { type: 'string' },
              op: {
                type: 'string',
                enum: ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'],
              },
              value: {},
            },
            required: ['field', 'op', 'value'],
          },
        },
        sortBy: {
          type: 'string',
          description: 'Field to rank by, or "distance" for nearest-first.',
        },
        sortDir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'number' },
        followUp: {
          type: 'boolean',
          description:
            'true = re-query the PREVIOUS result set instead of fresh data.',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'next_iss_pass',
    description:
      "When the user asks when the ISS / the space station will next fly over: returns the next visible ISS pass for the current camera location (or an explicit lat/lon) — rise time (ISO + minutes from now), rise compass direction, peak elevation, and duration. Requires the satellites layer to have loaded its catalog at least once this session; if it hasn't, tell the user to enable the satellites layer and try again.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        latitude: {
          type: 'number',
          minimum: -90,
          maximum: 90,
          description:
            'Optional observer latitude. Omit to use the current camera position.',
        },
        longitude: {
          type: 'number',
          minimum: -180,
          maximum: 180,
          description:
            'Optional observer longitude. Omit to use the current camera position.',
        },
        minElevationDeg: {
          type: 'number',
          minimum: 5,
          maximum: 60,
          description:
            'Minimum peak elevation (deg) to count as a pass. Default 10.',
        },
      },
    },
  },
];

export { GEV_REALTIME_TOOLS };
