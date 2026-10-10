/**
 * Voice manifest for every data layer the application catalog constructs.
 *
 * One plain-data entry per layer declares each voice capability separately:
 * the spoken aliases the action runner accepts, `toggle` (set_layer_visibility),
 * `context` (registers in-view entity context), `track` (track_entity), and
 * `query` — the analyst_query fields with type and unit — or `noQuery`, the
 * reason it has none. No layer has a voice timeline yet.
 *
 * Both the server tool builder (`actionSchemas.js` → the Realtime tool JSON)
 * and the browser runner (`gevActions.js`) derive their layer enums and alias
 * tables from here, so a new layer is reachable by voice as soon as it has an
 * entry. `layerManifest.test.mjs` fails when a catalog layer is neither listed
 * nor named in `VOICE_OFF_LAYERS`.
 *
 * Pure data: no Cesium, DOM or Node imports (the server imports this module).
 * @module voice/layerManifest
 */

/**
 * Field type shorthands: n = number, t = text, f = flag (boolean),
 * ms = epoch-milliseconds time (filters also accept ISO strings).
 * A second array element is the unit.
 */
const AIRCRAFT_FIELDS = {
  altitudeM: ['n', 'm'],
  speedMps: ['n', 'm/s'],
  verticalRateMps: ['n', 'm/s'],
  heading: ['n', 'deg'],
  callsign: ['t'],
  icao24: ['t'],
  originCountry: ['t'],
  operator: ['t'],
  aircraftClass: ['t'],
  military: ['f'],
  onGround: ['f'],
};

const layers = [
  {
    id: 'flights',
    track: true,
    aliases: ['planes', 'aircraft', 'air traffic'],
    context: false,
    query: {
      fields: {
        ...AIRCRAFT_FIELDS,
        routeOrigin: ['t'],
        routeDestination: ['t'],
      },
      viewportLoaded: true,
    },
  },
  {
    id: 'military',
    track: true,
    aliases: ['military flights', 'military aircraft', 'military planes'],
    context: false,
    query: { fields: AIRCRAFT_FIELDS },
  },
  {
    id: 'local-adsb',
    aliases: [
      'my receiver',
      'local adsb',
      'local ads-b',
      'my antenna',
      'my sdr',
    ],
    context: true,
    query: {
      fields: {
        altitudeM: ['n', 'm'],
        speedKts: ['n', 'kn'],
        heading: ['n', 'deg'],
        callsign: ['t'],
        icao24: ['t'],
        onGround: ['f'],
      },
    },
  },
  {
    id: 'ais-live-vessels',
    track: true,
    aliases: ['ships', 'vessels', 'boats', 'ais', 'live vessels'],
    context: true,
    query: {
      fields: {
        speedKts: ['n', 'kn'],
        courseDeg: ['n', 'deg'],
        name: ['t'],
        mmsi: ['t'],
        shipType: ['t'],
        destination: ['t'],
      },
    },
  },
  {
    id: 'satellites',
    track: true,
    aliases: ['satellite', 'sats'],
    context: false,
    query: {
      fields: {
        altitudeM: ['n', 'm'],
        speedMps: ['n', 'm/s'],
        name: ['t'],
        noradId: ['t'],
        satelliteClass: ['t'],
        group: ['t'],
      },
      caveat: 'distance is ground distance, not overhead',
    },
  },
  {
    id: 'rocket-launches',
    aliases: [
      'rocket launches',
      'launches',
      'space missions',
      'space mission',
      'missions',
    ],
    context: false,
    query: {
      fields: {
        name: ['t'],
        provider: ['t'],
        status: ['t'],
        launchSite: ['t'],
        missionName: ['t'],
        launchTimeMs: ['ms'],
        hoursUntil: ['n', 'h'],
      },
      window: 'past 30 d and upcoming',
    },
  },
  {
    id: 'earthquakes',
    aliases: ['quakes', 'seismic'],
    context: false,
    query: {
      fields: {
        magnitude: ['n'],
        depthKm: ['n', 'km'],
        place: ['t'],
        timeMs: ['ms'],
      },
      timeField: 'timeMs',
      window: 'last 24 h',
    },
  },
  {
    id: 'local-firms',
    aliases: ['fires', 'wildfires', 'active fires', 'firms'],
    context: true,
    query: {
      fields: {
        frp: ['n', 'MW'],
        confidence: ['n', '0-1'],
        satellite: ['t'],
        sensor: ['t'],
        acqTime: ['ms'],
      },
      timeField: 'acqTime',
      window: 'last 24 h',
    },
  },
  {
    id: 'fire-perimeters',
    aliases: [
      'fire perimeters',
      'wildfire perimeters',
      'burn areas',
      'perimeters',
    ],
    context: false,
    query: {
      fields: {
        acres: ['n', 'acres'],
        containedPct: ['n', '%'],
        personnel: ['n'],
        costToDate: ['n', 'USD'],
        name: ['t'],
        state: ['t'],
        county: ['t'],
        cause: ['t'],
        behavior: ['t'],
        complexity: ['t'],
        discoveredTime: ['ms'],
      },
      timeField: 'discoveredTime',
    },
  },
  {
    id: 'weather-cyclones',
    aliases: ['cyclones', 'hurricanes', 'typhoons', 'tropical storms'],
    context: false,
    query: {
      fields: {
        name: ['t'],
        classification: ['t'],
        basin: ['t'],
        windKt: ['n', 'kn'],
        pressureHpa: ['n', 'hPa'],
      },
    },
  },
  {
    id: 'weather-radar',
    aliases: ['weather radar', 'radar', 'rain', 'weather'],
    context: false,
    noQuery: 'map overlay; no countable records',
  },
  {
    id: 'weather-satellite',
    aliases: ['weather satellite', 'clouds', 'cloud imagery'],
    context: false,
    noQuery: 'map overlay; no countable records',
  },
  {
    id: 'weather-lightning',
    aliases: ['lightning', 'lightning strikes'],
    context: false,
    noQuery: 'map overlay; no countable records',
  },
  {
    id: 'wind',
    aliases: ['winds', 'wind map'],
    context: false,
    noQuery: 'map overlay; no countable records',
  },
  {
    id: 'traffic',
    aliases: ['street traffic', 'road traffic', 'congestion'],
    context: false,
    noQuery: 'road-speed overlay; no countable records',
  },
  {
    id: 'transit',
    aliases: ['buses', 'trains', 'public transit', 'trams', 'subway'],
    context: false,
    query: {
      fields: {
        mode: ['t'],
        routeId: ['t'],
        speedMps: ['n', 'm/s'],
        courseDeg: ['n', 'deg'],
        status: ['t'],
        occupancy: ['t'],
      },
    },
  },
  {
    id: 'bikeshare',
    aliases: ['bike share', 'bikes', 'bike stations'],
    context: false,
    query: {
      fields: {
        bikesAvailable: ['n'],
        docksAvailable: ['n'],
        capacity: ['n'],
        name: ['t'],
        city: ['t'],
        renting: ['f'],
      },
    },
  },
  {
    id: 'cctv',
    aliases: ['traffic cameras', 'cameras', 'webcams'],
    context: false,
    noQuery: 'use control_cctv',
  },
  {
    id: 'alpr-cameras',
    aliases: [
      'flock cameras',
      'license plate readers',
      'alpr',
      'alpr cameras',
      'license plate cameras',
      'plate readers',
    ],
    context: true,
    query: {
      fields: {
        operator: ['t'],
        manufacturer: ['t'],
        cameraType: ['t'],
        directionDeg: ['n', 'deg'],
      },
    },
  },
  {
    id: 'radio',
    aliases: ['internet radio', 'radio stations'],
    context: false,
    noQuery: 'use control_radio',
  },
  {
    id: 'street-level',
    aliases: ['street level', 'street-level imagery', 'mapillary'],
    context: false,
    noQuery: 'street-level imagery; no countable records',
  },
  {
    id: 'recent-imagery',
    aliases: [
      'recent satellite imagery',
      'recent imagery',
      'latest imagery',
      'new imagery',
    ],
    context: false,
    noQuery: 'imagery tiles; no countable records',
  },
  {
    id: 'directions',
    aliases: ['driving directions', 'directions panel'],
    context: false,
    noQuery: 'use annotate_map type=route',
  },
  {
    id: 'military-installations',
    aliases: ['military bases', 'bases', 'installations'],
    context: true,
    query: { fields: { name: ['t'], class: ['t'], kind: ['t'] } },
  },
  {
    id: 'local-datacenters',
    aliases: ['datacenters', 'data centers', 'data centres'],
    context: true,
    query: {
      fields: { name: ['t'], operator: ['t'], capacity: ['t'] },
    },
  },
  {
    id: 'local-dams',
    aliases: ['dams'],
    context: true,
    query: {
      fields: {
        name: ['t'],
        operator: ['t'],
        river: ['t'],
        output: ['t'],
      },
    },
  },
  {
    id: 'local-airports',
    aliases: ['airports', 'airfields', 'norwegian airports'],
    context: true,
    query: {
      fields: {
        name: ['t'],
        operator: ['t'],
        icao: ['t'],
        iata: ['t'],
        kind: ['t'],
        status: ['t'],
      },
    },
  },
  {
    id: 'telegeography-submarine-cables',
    aliases: ['submarine cables', 'undersea cables', 'cables', 'telegeography'],
    context: false,
    noQuery: 'cable records are not loaded for queries',
  },
  {
    // Global Context owns this layer; voice reaches it through
    // set_context_mode, never a bare toggle.
    id: 'military-awareness',
    aliases: [],
    toggle: false,
    context: false,
    noQuery: 'use set_context_mode contacts',
  },
];

/**
 * Catalog layers deliberately outside voice, with the reason. The Bhote Koshi
 * pair belong to a scripted scene and are driven by `control_scene`.
 */
export const VOICE_OFF_LAYERS = Object.freeze({
  'bhote-koshi-2026': 'scene-driven event layer (control_scene)',
  'bhote-koshi-locator': 'scene-driven event layer (control_scene)',
});

const TYPE_NAMES = Object.freeze({
  n: 'number',
  t: 'text',
  f: 'flag',
  ms: 'time',
});

function normalizeEntry(entry) {
  const fields = entry.query
    ? Object.fromEntries(
        Object.entries(entry.query.fields).map(([name, [type, unit]]) => [
          name,
          Object.freeze({
            type: TYPE_NAMES[type],
            ...(unit ? { unit } : {}),
          }),
        ]),
      )
    : null;
  return Object.freeze({
    id: entry.id,
    aliases: Object.freeze([...entry.aliases]),
    toggle: entry.toggle !== false,
    context: entry.context === true,
    track: entry.track === true,
    noQuery: entry.noQuery || null,
    query: fields
      ? Object.freeze({
          fields: Object.freeze(fields),
          timeField: entry.query.timeField || null,
          window: entry.query.window || null,
          caveat: entry.query.caveat || null,
          viewportLoaded: entry.query.viewportLoaded === true,
        })
      : null,
  });
}

/** Every voice-reachable layer, in the order the tool enums list them. */
export const VOICE_LAYER_MANIFEST = Object.freeze(layers.map(normalizeEntry));

const byId = new Map(VOICE_LAYER_MANIFEST.map((entry) => [entry.id, entry]));

/**
 * The manifest entry for one layer id.
 * @param {string} id Layer id.
 * @returns {object|null} Entry, or null for an unknown or voice-off layer.
 */
export function voiceLayer(id) {
  return byId.get(id) || null;
}

/** Layer ids `set_layer_visibility` and `show_data_layers_menu` accept. */
export const VOICE_TOGGLE_LAYER_IDS = Object.freeze(
  VOICE_LAYER_MANIFEST.filter((entry) => entry.toggle).map((entry) => entry.id),
);

/** Layers that register in-view entity context (`get_entity_context.layerId`). */
export const VOICE_CONTEXT_LAYER_IDS = Object.freeze(
  VOICE_LAYER_MANIFEST.filter((entry) => entry.context).map(
    (entry) => entry.id,
  ),
);

/** Layers `analyst_query` can count, filter and rank. */
export const VOICE_QUERY_LAYER_IDS = Object.freeze(
  VOICE_LAYER_MANIFEST.filter((entry) => entry.query).map((entry) => entry.id),
);

/**
 * Spoken name → layer id, for the browser runner. Ids map to themselves and
 * each alias to its layer; the first layer to claim an alias keeps it.
 * @returns {Map<string, string>} Lower-case phrase → layer id.
 */
export function voiceLayerAliasMap() {
  const map = new Map();
  for (const entry of VOICE_LAYER_MANIFEST) {
    map.set(entry.id, entry.id);
    map.set(entry.id.replace(/-/g, ' '), entry.id);
  }
  for (const entry of VOICE_LAYER_MANIFEST) {
    for (const alias of entry.aliases) {
      const key = alias.toLowerCase();
      if (!map.has(key)) map.set(key, entry.id);
    }
  }
  return map;
}

/** Plain-word ids the model already maps from speech without a hint. */
const SELF_EVIDENT_IDS = new Set([
  'flights',
  'military',
  'satellites',
  'earthquakes',
  'traffic',
  'radio',
  'wind',
  'directions',
]);

/**
 * Compact model-facing alias hint: "alias/alias→id; …" for toggleable layers
 * whose id is not already the spoken word. At most two aliases per layer keep
 * the tool JSON small; the runner accepts the full alias list.
 * @returns {string} One line for the layerId description.
 */
export function voiceLayerAliasHint() {
  return VOICE_LAYER_MANIFEST.filter(
    (entry) =>
      entry.toggle && entry.aliases.length && !SELF_EVIDENT_IDS.has(entry.id),
  )
    .map((entry) => `${entry.aliases.slice(0, 2).join('/')}→${entry.id}`)
    .join('; ');
}

/** Field names that already carry their unit (altitudeM, speedKts, …). */
const UNIT_SUFFIX = /(M|Mps|Kts|Kt|Km|Deg|Hpa)$/;

/**
 * Compact field list for the analyst_query description:
 * "flights: altitudeM,speedMps,…,confidence(0-1)". Units appear only where
 * the field name does not already say them.
 * @returns {string} One clause per queryable layer.
 */
export function voiceQueryFieldHint() {
  const printed = [];
  return VOICE_LAYER_MANIFEST.filter((entry) => entry.query)
    .map((entry) => {
      const names = Object.keys(entry.query.fields);
      // A layer whose fields are a subset of an earlier one's points at it.
      const parent = printed.find((prior) =>
        names.every((name) => prior.names.includes(name)),
      );
      printed.push({ id: entry.id, names });
      if (parent) {
        const minus = parent.names.filter((name) => !names.includes(name));
        return `${entry.id}: as ${parent.id}${minus.length ? ` minus ${minus.join(',')}` : ''}`;
      }
      const fields = Object.entries(entry.query.fields)
        .map(([name, spec]) =>
          spec.unit && !UNIT_SUFFIX.test(name) ? `${name}(${spec.unit})` : name,
        )
        .join(',');
      return `${entry.id}: ${fields}`;
    })
    .join('; ');
}
