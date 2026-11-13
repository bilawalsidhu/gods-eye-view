import { SCENE_RECIPES } from '../scenes/recipes.js';
import { msg } from '../i18n/index.js';
/**
 * Stories are GEV scenes, played on GEV's own Cesium globe: the scenes GEV
 * ships (recipes with a camera path) and the scenes the person authored and
 * saved to Stories from the AUTHORING panel.
 *
 * A shipped scene's context is what GEV knows about it: what it shows, where
 * each shot goes, and, for every layer it turns on, what the layer shows and
 * where its data comes from (as DATA_SOURCES.md records it). The Nepal scene
 * adds the event pack's own facts and sources
 * (public/events/bhote-koshi-2026/README.md) and marks its key moments by
 * the chapters that show them.
 */

/** What each layer a shipped scene turns on shows, and its data sources. */
const LAYER_FACTS = {
  flights: {
    label: msg('Flights'),
    about: msg(
      'Aircraft positions come from ADS-B: the OpenSky Network’s worldwide snapshot, with adsb.lol where OpenSky has none.',
    ),
    sources: [
      [
        'OpenSky Network',
        msg(
          'Worldwide live-flight snapshot (non-commercial research and education licence)',
        ),
        'https://opensky-network.org/',
      ],
      ['adsb.lol', msg('Live-flight fallback (ODbL 1.0)'), 'https://adsb.lol/'],
    ],
  },
  satellites: {
    label: msg('Satellites'),
    about: msg(
      'Satellite orbits are propagated from CelesTrak’s current element sets.',
    ),
    sources: [
      [
        'CelesTrak',
        msg('Satellite element sets and catalogue (U.S. government data)'),
        'https://celestrak.org/',
      ],
      [
        'UCS Satellite Database (5-1-2023)',
        msg('Satellite operators, owners and purposes'),
        'https://www.ucsusa.org/satellite_database',
      ],
    ],
  },
  earthquakes: {
    label: msg('Earthquakes'),
    about: msg('Earthquakes come from the U.S. Geological Survey’s live feed.'),
    sources: [
      [
        'USGS',
        msg('Earthquake feed (U.S. public domain)'),
        'https://earthquake.usgs.gov/',
      ],
    ],
  },
  traffic: {
    label: msg('Traffic'),
    about: msg('Road traffic; live congestion needs your own TomTom key.'),
    sources: [
      [
        'TomTom',
        msg('Live traffic flow, with your own key'),
        'https://www.tomtom.com/',
      ],
    ],
  },
};

/**
 * Per shipped scene: what it shows, and where each shot goes (by the shot's
 * camera), for shots without a title of their own.
 */
const SCENE_CONTEXT = {
  'flights-radar': {
    description: msg(
      'Live air traffic around the world: the Atlantic, Europe, Japan and San Francisco.',
    ),
    places: [
      msg('The Atlantic'),
      msg('Western Europe'),
      msg('Japan'),
      msg('San Francisco Bay Area'),
      msg('Pull back over the Atlantic'),
    ],
  },
  'orbital-watch': {
    description: msg(
      'Satellites in orbit, watched from over Florida, Africa, Tokyo and Paris.',
    ),
    places: [
      msg('Over Florida'),
      msg('Over Africa'),
      msg('Over Tokyo'),
      msg('Over Paris'),
      msg('Pull back over the Atlantic'),
    ],
  },
  'thermal-threats': {
    description: msg(
      'Recent earthquakes in the thermal look: California, Japan, New Zealand and off Portugal.',
    ),
    places: [
      msg('California'),
      msg('Japan'),
      msg('New Zealand'),
      msg('Off Portugal'),
    ],
  },
  'city-overload': {
    description: msg(
      'Flights, satellites and traffic together over New York, Los Angeles and London.',
    ),
    places: [
      msg('New York'),
      msg('New York, closer'),
      msg('New York, closer still'),
      msg('Los Angeles'),
      msg('London'),
    ],
  },
  'omniscience-pullback': {
    description: msg(
      'Every live layer at once, pulling back from Tokyo to the whole planet.',
    ),
    places: [
      msg('Tokyo'),
      msg('Tokyo, pulling back'),
      msg('Japan and East Asia'),
      msg('South China Sea'),
      msg('The whole globe'),
    ],
  },
  'bhote-koshi-nepal-scene': {
    description: msg(
      'The 26 August 2026 Bhote Koshi outburst flood in Nepal, followed down the valley to Trishuli.',
    ),
    // Where Explore frames it: the Bhote Koshi corridor, not the scene's
    // opening whole-globe shot.
    area: { lat: 28.13, lon: 85.32, alt: 160000 },
    tMinMs: Date.UTC(2026, 7, 26),
    tMaxMs: Date.UTC(2026, 7, 27),
    // Key moments: the chapters that show them, by their titles.
    moments: [
      ['#ffb45a', msg('Upper Valley Collapse')],
      ['#50c8ff', msg('Debris-Dammed Lake')],
      ['#ff7a6b', msg('Second landslide')],
    ],
    sources: [
      [
        'Vantor Open Data Program',
        msg('Historical and post-event satellite imagery (CC BY-NC 4.0)'),
        'https://vantor.com/company/open-data-program',
      ],
      [
        'GeoPera',
        msg('Reconstructed flood path (CC BY-NC 4.0)'),
        'https://github.com/geo-pera/bhotekoshi-2026-reconstruction',
      ],
    ],
    background: msg(
      'A visualization of the 26 August 2026 Bhote Koshi outburst flood, not an official hazard model. The historical (2021) and post-event views are Vantor WorldView imagery; the river’s path is GeoPera’s reconstruction. Witness clips link to their original posts, and their capture times are unverified.',
    ),
  },
};

/** A shipped scene's context, from its own entry and its layers' facts. */
function sceneContext(recipe) {
  const own = SCENE_CONTEXT[recipe.id] ?? {};
  const layers = Object.entries(recipe.layers ?? {})
    .filter(([id, on]) => on && LAYER_FACTS[id])
    .map(([id]) => LAYER_FACTS[id]);
  return {
    ...(own.area ? { area: own.area } : {}),
    ...(own.tMinMs != null ? { tMinMs: own.tMinMs, tMaxMs: own.tMaxMs } : {}),
    description:
      own.description ?? msg('A GEV scene, played on the live globe.'),
    places: own.places ?? [],
    moments: own.moments ?? [],
    // The layers' own names on the legend.
    mock: { legend: layers.map((l) => ['dot', '#6be8ff', l.label]) },
    sources: [...(own.sources ?? []), ...layers.flatMap((l) => l.sources)],
    // Each part is translated on its own, as shown.
    background: own.background ?? layers.map((l) => l.about),
  };
}

/**
 * Where a story's card and pin point, and where Explore flies on a pick. A
 * shot tied to an anchor (no lat/lon of its own) shows the whole globe.
 */
const coverOf = (camera) =>
  Number.isFinite(camera?.lat) && Number.isFinite(camera?.lon)
    ? {
        lat: camera.lat,
        lon: camera.lon,
        range: camera.alt ?? 1.6e7,
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -70,
      }
    : { lat: 20, lon: 0, range: 1.6e7, heading: 0, pitch: -90 };

/** A scene GEV ships, from its recipe. */
function shippedStory(recipe) {
  const path = recipe.cameraPath ?? [];
  const first = path[0] ?? {
    lat: 20,
    lon: 0,
    alt: 1.6e7,
    heading: 0,
    pitch: -80,
  };
  const context = sceneContext(recipe);
  let at = 0;
  const chapters = path.map((shot, i) => {
    const chapter = {
      id: `shot-${i + 1}`,
      wallMs: at,
      shot: i + 1,
      title: shot.title ?? context.places[i] ?? null,
      caption: '',
    };
    at += ((shot.duration ?? 4) + (shot.hold ?? 0)) * 1000;
    return chapter;
  });
  const durationMs = Math.max(at, (recipe.durationSec ?? 30) * 1000);
  const { places, ...rest } = context;
  return {
    id: `gev:${recipe.id}`,
    sceneId: recipe.id,
    kind: 'gev',
    live: false,
    title: recipe.title,
    creator: 'GEV',
    tags: Object.entries(recipe.layers ?? {})
      .filter(([, on]) => on)
      .map(([id]) => id),
    durationMs,
    cover: coverOf(first),
    chapters,
    events: [],
    places,
    ...rest,
  };
}

/** A saved scene's line under its title: a draft says how to publish it. */
const describe = (scene) =>
  scene.draft
    ? msg(
        'A draft, not saved as a story yet. Use SAVE TO STORIES in AUTHORING to save it.',
      )
    : msg('A scene you made in GEV, played on the live globe.');

/**
 * A scene the person saved to Stories (SceneDirector.storyScenes()). Its
 * chapters and length come from the director's shots when it opens.
 */
function savedStory(scene) {
  return {
    id: `gev:${scene.id}`,
    sceneId: scene.id,
    kind: 'gev',
    live: false,
    mine: true,
    // Not saved with SAVE TO STORIES yet.
    draft: !!scene.draft,
    title: scene.title,
    description: describe(scene),
    creator: msg('You'),
    // Topics the person picked in AUTHORING, and the card image they
    // captured there (drawn from the imagery when there is none).
    topics: [...(scene.tags ?? [])],
    tags: [...(scene.tags ?? [])],
    thumb: scene.thumb ?? '',
    durationMs: 0,
    cover: coverOf(scene.camera),
    chapters: [],
    events: [],
    sources: [],
    background: '',
  };
}

let shipped = null;
let installed = () => true;
/**
 * Whether a shipped scene is in the person's project (the controller passes
 * the director's hasScene()); one that is not does not list.
 * @param {(sceneId: string) => boolean} test
 */
export function useInstalledScenes(test) {
  installed = typeof test === 'function' ? test : () => true;
}
const saved = new Map();
let savedScenes = () => [];
/**
 * Where the person's saved scenes come from (the controller passes the
 * director's storyScenes()). The list is read again on every call, so a
 * scene saved to Stories shows the next time Explore lists.
 * @param {() => Array<{id: string, title: string, camera: object, shotCount: number, thumb?: string, tags?: string[]}>} provider
 */
export function useSavedScenes(provider) {
  savedScenes = typeof provider === 'function' ? provider : () => [];
}

/** Every story Explore lists: the person's own first, then GEV's. */
export function listStories() {
  shipped ??= SCENE_RECIPES.filter((r) => (r.cameraPath ?? []).length).map(
    shippedStory,
  );
  const shippedIds = new Set(shipped.map((s) => s.sceneId));
  // One object per saved scene, kept across calls: the controller fills its
  // chapters in place when it opens, and the screens read the same object.
  const own = (savedScenes() ?? [])
    .filter((scene) => !shippedIds.has(scene.id))
    .map((scene) => {
      const story = saved.get(scene.id) ?? savedStory(scene);
      story.title = scene.title;
      story.draft = !!scene.draft;
      story.description = describe(scene);
      story.cover = coverOf(scene.camera);
      story.topics = [...(scene.tags ?? [])];
      story.tags = [...(scene.tags ?? [])];
      story.thumb = scene.thumb ?? '';
      saved.set(scene.id, story);
      return story;
    });
  return [...own, ...shipped.filter((s) => installed(s.sceneId))];
}

export function storyById(id) {
  return listStories().find((s) => s.id === id) ?? null;
}
