export const ACTION_DESCRIPTIONS = {
  fly_to_location: {
    description:
      "Fly the God's Eye View camera to a known city, geocoded country/region/city/landmark, or explicit WGS84 coordinate. Countries/cities frame the whole place; landmarks/buildings use close framing.",
    $position: 1,
    parameters: {
      properties: {
        locationId: {
          description:
            'Known city preset ID. Use when the requested place matches one of these cities.',
          $position: 2,
        },
        query: {
          description:
            'Plain place search query, e.g. "London", "Eiffel Tower", or "Dubai Marina".',
          $position: 1,
        },
        viewMode: {
          description:
            'Optional framing intent. Usually omit this; GEV infers whole-place framing for countries/cities and close framing for landmarks.',
          $position: 2,
        },
        rangeM: {
          description:
            'Optional camera range from the target in meters. Omit it for automatic whole-country/whole-city or close-landmark framing; provide it only when the user explicitly requests a numeric height or distance.',
          $position: 3,
        },
        waitForArrival: {
          description:
            'Set true when a later tool depends on the destination viewport. The result then waits for the camera flight and returns arrived=true; cancellation returns ok=false.',
          $position: 1,
        },
      },
    },
  },
  select_nearest_aircraft: {
    description:
      'Atomically fly to a place, wait for arrival, enable and load Flights or Military Flights in that viewport, exclude on-ground records, and select/follow the nearest airborne aircraft. Healthy fallback feeds remain usable and are reported in the result. This does not open Contacts or Cockpit.',
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description:
            'Aircraft layer to enable and search. Use flights unless the user explicitly asks for military aircraft.',
          $position: 2,
        },
        locationId: {
          description:
            'Known city preset ID when the place matches one of these cities.',
          $position: 2,
        },
        locationQuery: {
          description: 'Free-form destination when no locationId matches.',
          $position: 2,
        },
      },
    },
  },
  adjust_camera_zoom: {
    description:
      'Move the current Cesium camera closer to or farther from what it is presently looking at. Use for relative zoom requests without changing location.',
    $position: 1,
    parameters: {
      properties: {
        amount: {
          description:
            'Use little for phrases like "a bit" or "a little", medium for ordinary zoom requests, and lot for "way out/in".',
          $position: 2,
        },
      },
    },
  },
  zoom_to_globe: {
    description:
      'Pull the camera out to an ABSOLUTE full-Earth globe view (~18,000 km altitude, the whole planet in frame), keeping the current region centered. Use for "globe view", "whole earth", "see the planet", "zoom all the way out". Never use adjust_camera_zoom for these — its relative steps cannot reach the globe.',
    $position: 1,
  },
  set_layer_visibility: {
    description: "Enable or disable one registered God's Eye View data layer.",
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description:
            'Common-name mapping for the non-obvious ids: space mission(s) → rocket-launches; fires/wildfires/active fires → local-firms (NASA FIRMS); ships/vessels/boats → ais-live-vessels; undersea/submarine cables → telegeography-submarine-cables; datacenters → local-datacenters; dams → local-dams; bikes/bike share → bikeshare; street traffic/congestion → traffic; traffic cameras → cctv; internet radio/stations → radio; ALPR/license plate readers/Flock cameras → alpr-cameras; local ADS-B/my receiver/my antenna (aircraft heard by a local RTL-SDR receiver) → local-adsb; ham/amateur radio repeaters, Relais, Umsetzer → ham-repeaters.',
          $position: 1,
        },
      },
    },
  },
  show_data_layers_menu: {
    description:
      'Open the data layers dropdown/menu and optionally scroll to a specific layer row without toggling it.',
    $position: 1,
    parameters: {
      properties: {
        layerId: {
          description: 'Optional layer row to scroll into view and highlight.',
          $position: 2,
        },
      },
    },
  },
  set_panel_open: {
    description: 'Open or close a GEV UI panel/dropdown.',
    $position: 1,
  },
  set_context_mode: {
    description:
      'Enter or exit the Global Context sub-mode used by Contacts and Space Missions. Use Contacts only when the user explicitly requests Contacts, and Space Missions only when explicitly requested. A request to open the parent Context panel alone uses set_panel_open and must not activate either sub-mode. Selecting an aircraft does not imply Context.',
    $position: 1,
    parameters: {
      properties: {
        mode: {
          description: 'Use off to exit context mode.',
          $position: 2,
        },
      },
    },
  },
  control_cockpit: {
    description:
      'Read or control Cockpit when the user explicitly requests Cockpit: establish Contacts and enter from a selected or tracked aircraft; exit; or navigate nearby Contacts with optional filters. Selecting or viewing an aircraft alone must not enter Cockpit.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'previous/next (or prev) navigates through nearby contacts in Cockpit context.',
          $position: 2,
        },
        targetLayer: {
          description:
            'Optional contact layer filter for next/previous (for example military for a military-only cycle).',
          $position: 2,
        },
        aircraftClass: {
          description:
            'Optional aircraft class filter (for example helicopter) when using next/previous navigation.',
          $position: 1,
        },
      },
    },
  },
  set_visual_style: {
    description: "Set the active God's Eye View visual filter/style.",
    $position: 1,
  },
  get_entity_context: {
    description:
      'Get current GEV scene context, including basemap/3D-tile target context, selected entity metadata if active, and entities currently visible in the camera view.',
    $position: 1,
    parameters: {
      properties: {
        scope: {
          description:
            'Use auto by default. selected returns the clicked/selected entity; in_view returns visible entities near the screen center.',
          $position: 2,
        },
        layerId: {
          description: 'Optional layer filter for visible entity context.',
          $position: 2,
        },
      },
    },
  },
  get_current_view_state: {
    description:
      'Read the current camera, style, Context, Cockpit, HUD, detection, map stack, post-processing, scene-playback, tracked-entity, and layer state before choosing another action.',
    $position: 1,
  },
  set_hud: {
    description:
      'Control the intelligence HUD overlay: visibility and/or layout variant.',
    $position: 1,
    parameters: {
      properties: {
        visible: {
          description: 'auto restores style-driven show/hide.',
          $position: 2,
        },
      },
    },
  },
  set_cyber_sonar: {
    description:
      'Adjust Cyber-only sonar controls. Requires the Cyber HUD layout; never switches layout or HUD visibility. Omitted fields stay unchanged. Returns actual settings and separate map/contact sweep activity. A saved setting does not mean the effect is active.',
    $position: 1,
    parameters: {
      properties: {
        enabled: { description: 'Explicitly turn sonar on or off.' },
        rings: { description: 'Number of decorative sonar rings, 3–12.' },
        rangePct: {
          description:
            'Visual ring range, 60–120 percent; not geographic distance.',
        },
        intensityPct: {
          description: 'Sonar Power slider, 0–100 percent. Zero is valid.',
        },
        opacityPct: {
          description:
            'Contact opacity floor between passes, 35–100 percent; labels have a derived floor. Not whole-scene dimming.',
        },
        sectorDeg: { description: 'Sonar sweep sector width, 8–60 degrees.' },
      },
    },
  },
  set_detection: {
    description:
      'Control the detection overlay: on/off, density-derived Sparse/Balanced/Dense profile, and Elastic/Weighted layer allocation.',
    $position: 1,
    parameters: {
      properties: {
        enabled: {
          description:
            'false turns detection OFF; true restores the current density-derived profile.',
          $position: 1,
        },
        densityPct: {
          description:
            'Density snaps to 0, 25, 50, 75, or 100 and derives the active profile.',
          $position: 1,
        },
        allocationStrategy: {
          description:
            'Elastic splits evenly then lends unused slots; Weighted follows demand and semantic weight.',
          $position: 2,
        },
      },
    },
  },
  set_map_stack: {
    description:
      'Switch the basemap/imagery stack (NOT the satellites data layer and NOT a visual style filter).',
    $position: 1,
    parameters: {
      properties: {
        stack: {
          description:
            'photoreal = Google 3D. Use bing-aerial only when the user explicitly says "Bing aerial" — "satellite(s)" never means a basemap; only the explicit phrase "Esri" / "Esri imagery" means esri-imagery.',
          $position: 2,
        },
      },
    },
  },
  set_post_processing: {
    description:
      'Control bloom and sharpen post-processing toggles and intensities.',
    $position: 1,
    parameters: {
      properties: {
        bloom: {
          properties: {
            intensityPct: {
              description: '0-200 (UI percent).',
              $position: 1,
            },
          },
        },
        sharpen: {
          properties: {
            intensityPct: {
              description: '0-100 (UI percent).',
              $position: 1,
            },
          },
        },
      },
    },
  },
  control_scene: {
    description:
      'Cinematic scene playback: list scenes, play one scene by name, stop, advance, or read status. Play starts a single named scene and returns immediately.',
    $position: 1,
    parameters: {
      properties: {
        sceneId: {
          description: 'Scene id or (partial) title for play.',
          $position: 1,
        },
      },
    },
  },
  control_cctv: {
    description:
      'CCTV camera operations: enable/disable the layer, select a camera by name, next/prev/nearest/focus, toggle coverage wedges / projection overlay / auto-hop, "viewshed" for color-coded per-camera coverage volumes, and "adjust" for the on-camera calibration gizmo.',
    $position: 1,
    parameters: {
      properties: {
        cameraQuery: {
          description: 'Camera name or id for select.',
          $position: 1,
        },
        enabled: {
          description:
            'Explicit on/off for coverage/viewshed/adjust/projection/autohop; omit to toggle.',
          $position: 1,
        },
      },
    },
  },
  control_radio: {
    description:
      'Control Internet Radio playback without moving the map. Use select whenever the request includes a station category, name, country, coordinates, or nearby place—even when the user says play. Use play only for an unqualified "turn on/start the radio" request so the current or nearest station begins. Enable only reveals the Radio layer/markers without audio. Also supports disable, resume, pause, stop, next/previous, volume, and status.',
    $position: 1,
    parameters: {
      properties: {
        action: {
          description:
            'Use select for any request qualified by category, station, country, coordinates, or place. Use play only for an unqualified turn on/start/listen request. Use enable only when the user explicitly asks to show or enable the Radio layer or its markers without requesting audio.',
          $position: 2,
        },
        volumePct: {
          description:
            'Required for volume; sets the persistent Radio playback volume.',
          $position: 3,
        },
        category: {
          description:
            'Station category for select/next/previous. When the user requests playback with a category, action must be select, not play.',
          $position: 2,
        },
        locationId: {
          description: 'Known nearby-city anchor for select.',
          $position: 2,
        },
        locationQuery: {
          description:
            'Place to search near, such as "Austin, Texas" or "Seattle". Selection does not fly the camera.',
          $position: 2,
        },
        country: {
          description:
            'Country code or name filter, for example US or United States.',
          $position: 2,
        },
        stationQuery: {
          description: 'Optional station name/tag substring.',
          $position: 2,
        },
      },
    },
  },
  track_entity: {
    description:
      'Find and follow a specific aircraft (callsign/ICAO hex), ship (name/MMSI), or satellite (name/NORAD id) on enabled layers. Camera follows the entity.',
    $position: 1,
    parameters: {
      properties: {
        query: {
          description:
            'Callsign, ship name, satellite name, ICAO hex, MMSI, or NORAD id.',
          $position: 1,
        },
        layerId: {
          description:
            'Optional layer hint: flights | military | ais-live-vessels | satellites.',
          $position: 1,
        },
      },
    },
  },
  stop_tracking: {
    description:
      'Stop following the tracked aircraft/satellite and clear any selected vessel.',
    $position: 1,
  },
  frame_overhead: {
    description:
      'Cinematically frame entities near the current view: pulls the camera back and angles it so nearby aircraft, ships, or satellites are visible together.',
    $position: 1,
    parameters: {
      properties: {
        radiusKm: {
          description:
            'Search radius around the view target. Defaults: 150 aircraft, 120 ships, 3000 satellites.',
          $position: 1,
        },
      },
    },
  },
  annotate_map: {
    description:
      'Draw annotations on the 3D map to visually point out what you are talking about — like sketching on a whiteboard over the world. Use this whenever you mention a specific place, building, campus, boundary, district, or a relationship between two places, so the user can SEE what you mean. Give place NAMES (preferred) or explicit lat/lng; the app resolves them to real-world positions and real building/area outlines — never guess pixel positions. Call this as you begin describing something, and you may mark several places in one call.',
    $position: 1,
    parameters: {
      properties: {
        annotations: {
          description:
            'One or more things to mark. Mark multiple related places together when describing them as a group.',
          $position: 1,
          items: {
            properties: {
              type: {
                description:
                  'pin = planted marker at a spot; highlight = pulsing ring drawing the eye to a point; area = trace the outline of a building/campus/compound/district; arrow = a connector from one place to another (use target as the origin and toTarget as the destination); route = a path through several waypoints (use the points array); label = a floating text callout.',
                $position: 2,
              },
              target: {
                description:
                  'Place name to resolve, e.g. "Palace of Fine Arts, San Francisco", "the Pentagon", "Presidio of San Francisco". Preferred over coordinates. For a specific monument/statue/feature that sits within a larger landmark, use its OWN name + city ("Tejano Monument, Austin", "Texas African American History Memorial, Austin") — do NOT phrase it as "X at the Texas State Capitol", which makes the geocoder collapse several of them onto the same centroid so they stack on one spot.',
                $position: 2,
              },
              points: {
                description:
                  'For type=route: 2+ ordered waypoints the path passes through, each a place name (or coordinates / screen point).',
                $position: 1,
                items: {
                  properties: {
                    target: {
                      description: 'Waypoint place name.',
                      $position: 2,
                    },
                  },
                },
              },
              mode: {
                description:
                  'For type=route: travel mode for a real street-following route (the app returns distance + time). Pick from the verb the user used ("walk" → walking, "drive" → driving). Defaults to walking.',
                $position: 2,
              },
              latitude: {
                description:
                  'Explicit latitude (use only if no good place name exists).',
                $position: 3,
              },
              toTarget: {
                description: 'For type=arrow: the destination place name.',
                $position: 2,
              },
              label: {
                description:
                  'Short caption shown on the map (a few words). Optional.',
                $position: 2,
              },
              color: {
                description:
                  'Accent color. primary = neutral, amber = point of interest, cyan = infrastructure, green = confirmed/safe, red = alert.',
                $position: 2,
              },
              footprint: {
                description:
                  'For type=area/highlight: trace the real building or campus outline from map data. Defaults true for area.',
                $position: 1,
              },
              intent: {
                description:
                  'For type=area: "the_thing" (default) outlines the place itself (its footprint/boundary); "around_the_thing" highlights a surrounding zone (a buffered radius around it). Infer from phrasing: "the Capitol"/"show me X" → the_thing; "around/near/by X" or "the area around X" → around_the_thing.',
                $position: 2,
              },
              entityKind: {
                description:
                  'What KIND of thing the target IS — a fact, not a style choice: building = one structure; compound = campus/grounds/mall/park; district = neighborhood or area of a city; street = a named road/corridor; point_feature = monument/statue/memorial/plaque/fountain or other small point landmark. Set it whenever you know it — it routes the resolver to the right footprint source (point_feature anchors monuments as precise points instead of adopting a nearby building outline).',
                $position: 2,
              },
              screenX: {
                description:
                  'Fallback only: when you cannot name/geocode the place but can SEE it in the latest viewport screenshot, the normalized horizontal position (0=left, 1=right) of the spot. The app converts it back to a real world point under that pixel.',
                $position: 3,
              },
              screenY: {
                description:
                  'Fallback only: normalized vertical position (0=top, 1=bottom) of the spot in the latest viewport screenshot.',
                $position: 3,
              },
              toScreenX: {
                description:
                  'For type=arrow: normalized x of the arrow destination from the screenshot (pixel fallback).',
                $position: 3,
              },
              toScreenY: {
                description:
                  'For type=arrow: normalized y of the arrow destination from the screenshot (pixel fallback).',
                $position: 3,
              },
            },
          },
        },
        flyTo: {
          description:
            'Also move the camera to frame the first annotation. Default false — leave false if the user is already looking at the spot.',
          $position: 1,
        },
        persist: {
          description:
            'Keep annotations until cleared (true, default) or let them auto-fade after ~20s (false).',
          $position: 1,
        },
      },
    },
  },
  clear_annotations: {
    description:
      'Erase ALL map annotations previously drawn with annotate_map. Call this ONLY when the user EXPLICITLY asks to clear or reset the map. Annotations accumulate and persist across navigation and topic changes by design — never clear on your own initiative.',
    $position: 1,
  },
  move_camera: {
    description:
      'Direct the camera like a drone operator: orbit the current view target, pan, tilt, or rotate — one bounded nudge (mode=once) or continuous motion until stopped (mode=continuous). Continuous motion also stops on any manual camera input or when a navigation tool runs. Say the RESULTING state when confirming ("Orbiting slowly").',
    $position: 1,
    parameters: {
      properties: {
        direction: {
          description:
            'Required except for orbit (defaults right/clockwise) and stop.',
          $position: 2,
        },
        mode: {
          description:
            'once = bounded eased nudge (default); continuous = until stop/manual input.',
          $position: 2,
        },
      },
    },
  },
  fly_route: {
    description:
      'Cinematic dolly along an EXISTING route annotation (drawn earlier with annotate_map type=route) — flies the street-following path from start to end. Omit label for the newest route. If no route is drawn, this fails with guidance: draw the route first.',
    $position: 1,
    parameters: {
      properties: {
        label: {
          description: 'Match an existing route mark by (partial) label.',
          $position: 1,
        },
      },
    },
  },
  analyst_query: {
    description:
      'Answer questions ABOUT the data currently loaded on the map — counts, lists, superlatives, and attribute filters over live layers (flights, military, ships, fires, earthquakes, satellites, datacenters, dams). Examples: "how many flights over Texas", "biggest fire near LA", "which ships are headed to Oakland", "anything above 40,000 feet", "fastest thing in view". For satellites and infrastructure, counts and ranks cover only bounded examined loaded records; omitted records can change nearest/count. Queries ONLY client-side data from ENABLED layers — if the needed layer is off, say so and offer to enable it. For a follow-up about the previous answer\'s set ("which of those is closest?"), set followUp=true and send only the new filters/sort.',
    $position: 1,
    parameters: {
      properties: {
        layers: {
          description:
            'Layers to query. fires/wildfires → local-firms; ships/vessels → ais-live-vessels.',
          $position: 2,
        },
        scope: {
          description:
            'Spatial scope. Default: view (near the camera). Use kind=region for "over Texas"-style asks; kind=anywhere for global questions.',
          $position: 2,
          properties: {
            name: {
              description:
                'For kind=region: a state/country ("Texas", "France") or a named natural region ("the Alps", "Gulf of Mexico").',
              $position: 1,
            },
            km: {
              description: 'For kind=radius.',
              $position: 1,
            },
          },
        },
        filters: {
          description:
            'Attribute predicates, ANDed. ALTITUDE IS METERS (40,000 ft = 12192). Fields: altitudeM, speedMps, military, onGround, aircraftClass, callsign, operator, routeOrigin, routeDestination, originCountry (flights); speedKts, shipType, destination (ships); frp, confidence (fires); magnitude, depthKm, place (earthquakes).',
          $position: 1,
        },
        sortBy: {
          description: 'Field to rank by, or "distance" for nearest-first.',
          $position: 1,
        },
        followUp: {
          description:
            'true = re-query the PREVIOUS result set instead of fresh data.',
          $position: 1,
        },
      },
    },
  },
  next_iss_pass: {
    description:
      "When the user asks when the ISS / the space station will next fly over: returns the next geometric ISS pass with estimated visibility for the current camera location (or an explicit lat/lon) — rise time (ISO + minutes from now), rise compass direction, peak elevation, and duration. Requires the satellites layer to have loaded its catalog at least once this session; if it hasn't, tell the user to enable the satellites layer and try again.",
    $position: 1,
    parameters: {
      properties: {
        latitude: {
          description:
            'Optional observer latitude. Omit to use the current camera position.',
          $position: 3,
        },
        longitude: {
          description:
            'Optional observer longitude. Omit to use the current camera position.',
          $position: 3,
        },
        minElevationDeg: {
          description:
            'Minimum peak elevation (deg) to count as a pass. Default 10.',
          $position: 3,
        },
      },
    },
  },
  next_satellite_pass: {
    description:
      'Predict the next pass in 24 hours for one satellite in the loaded catalog, identified by exact NORAD ID or name. Ambiguous names return candidates: ask for a choice rather than selecting one. Defaults to geometric passes; visibleOnly requires estimated illumination and a dark observer sky, which does not guarantee naked-eye visibility. Uses camera location unless coordinates are supplied.',
    $position: 1,
  },
  show_ham_repeaters: {
    description:
      'Show amateur-radio (ham) repeaters \u2014 FM and D-STAR relays, called Relais or Umsetzer in German \u2014 around a place or the current view, and switch the Repeaters layer on. This is not Internet Radio: use control_radio for listening to stations. Distances are ground distances from the search centre, not radio coverage. Results carry their source and a confidence flag; rows marked unverified come from a historic import and may be stale.',
    $position: 1,
    parameters: {
      properties: {
        radiusKm: {
          description:
            'Search radius in km around the centre. Default 100, maximum 500.',
          $position: 1,
        },
        band: {
          description:
            'Amateur band filter. 2 metres is 2m, 70 centimetres is 70cm, 23 centimetres is 23cm. Omit or use all when the user names no band.',
          $position: 1,
        },
        kind: {
          description:
            'Repeater mode: fm for analogue FM, dstar for D-STAR. Omit or use all when the user names no mode.',
          $position: 1,
        },
        locationQuery: {
          description:
            'Free-text place to search around, e.g. "Munich" or "near Lake Tahoe". Omit to search around the current view.',
          $position: 1,
        },
        limit: {
          description:
            'How many nearest repeaters to return for narration. Default 10.',
          $position: 1,
        },
      },
    },
  },
};
