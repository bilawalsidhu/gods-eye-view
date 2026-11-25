// What the Omnibar offers for a typed line, and which row Enter runs. The
// one pipeline from text to rows: the line is normalised once
// (normalizeLine), read once (parseOmnibar), turned into rows here, and the
// Enter rule (src/ui/omnibarEnter.js) orders them and picks the default.
// Omnibar.vue only supplies what the app knows (layers, place suggestions,
// things on the map, the selection) and runs the row that is chosen.
//
// Pure: no DOM, no stores. Tested by an input-to-outcome table in
// src/ui/omnibarRows.test.mjs.

import { msg, t, tn } from '../i18n/index.js';
import { parseCoordinateQuery } from '../search/coordinateParser.js';
import {
  mayBePrivate,
  minPlaceChars,
  onlyNumbersLookPrivate,
} from '../search/placeSuggestions.js';
import { shownLayerName } from './layerNames.js';
import { featureGuideFor } from './omnibarGuide.js';
import { enterDefault, isPlaceWord, orderForEnter } from './omnibarEnter.js';
import {
  hasActionVerb,
  isPanelText,
  isRealQuestion,
  asTypedIn,
  isWholeMapClear,
  magnitudeFloor,
  normalizeLine,
  parseOmnibar,
  placeWordLimit,
  writtenAsName,
} from './omnibarIntent.js';

export const GUIDE_LABELS = {
  styles: msg('Visual styles'),
  hud: msg('HUD'),
  north: msg('North up'),
  tilt: msg('Tilt / 3D view'),
  globe: msg('Globe view'),
  share: msg('Sharing this view'),
  clear: msg('Clearing all layers'),
  'map-source': msg('Changing the map'),
  scope: msg('The scope'),
  clean: msg('Clean UI'),
  'find-layer': msg('Searching layers'),
  'filter-layers': msg('Filtering layers'),
  'section-index': msg('Jumping between layer groups'),
  preferences: msg('Keys and language'),
  edge: msg('Panels at the screen edge'),
  context: msg('The Context panel'),
  properties: msg('Layer properties'),
  draw: msg('Drawing and measuring'),
};

// Guides for parts of the interface that are not commands: matched on the
// words after "show me how", "how do I", etc.
const GUIDE_TOPICS = [
  {
    id: 'find-layer',
    words:
      /^layers?$|\b(search|find|look ?up)\b.*\blayers?\b|\blayers?\b.*\bsearch\b|^(search|find)( a)? layer/,
  },
  {
    id: 'filter-layers',
    words: /\bfilter|\bcategor|\bonly (the )?(on|off|active)\b/,
  },
  {
    id: 'section-index',
    words:
      /\b(jump|skip|go) to (a )?(group|section|category)|\bsection index|\blayer groups?\b/,
  },
  {
    id: 'preferences',
    words:
      /\b(preferences?|prefs|settings|language|translat|api keys?|keys?|power ?up)\b/,
  },
  {
    id: 'edge',
    words:
      /\b(edge|dock|align|move|slide)\b.*\bpanels?\b|\bpanels?\b.*\b(edge|align|over the rail)\b/,
  },
  {
    id: 'properties',
    words: /\bproperties\b|\blabels?\b|\b3d (models?|aircraft)\b|\bdensity\b/,
  },
  {
    id: 'context',
    words: /\bcontext\b|\binspector\b|\bwhat'?s (in view|here)\b/,
  },
  { id: 'scope', words: /\bscope\b|\bkeyhole\b|\bfeather\b/ },
  {
    id: 'clean',
    words: /\bclean (ui|view|screen)|\bhide (the )?(ui|panels|interface)/,
  },
  {
    id: 'map-source',
    words:
      /\bmap (source|imagery|layer)|\b(base ?map|imagery)\b|\b(google 3d|bing|esri|osm|openstreetmap)\b/,
  },
];
// The words people use for the features that have their own walk
// (src/ui/omnibarGuide.js FEATURE_GUIDES), read after GUIDE_TOPICS and
// before any layer: "how do I change the map style", "how do I tilt the
// map", "how do I get back to the globe", "how to measure distance".
const FEATURE_TOPICS = [
  {
    id: 'styles',
    words:
      /\b(?:visual |map |view )?styles?\b|\blooks?\b|\bfilters?\b|\b(?:noir|thermal|night vision|nvg|flir|retro|crt|anime|black and white)\b/,
  },
  {
    id: 'map-source',
    words:
      /^(?:base ?)?maps?$|\b(?:base ?map|map (?:type|view|provider)|satellite (?:view|imagery)|google 3d|bing|esri|osm|openstreetmap|photoreal)\b/,
  },
  { id: 'hud', words: /\bhud\b|\bheads?[- ]up\b/ },
  { id: 'north', words: /\bnorth\b|\bcompass\b|\bheading\b/ },
  {
    id: 'tilt',
    words: /\btilt|\b3d (?:view|mode)\b|\bperspective\b|\bpitch\b/,
  },
  {
    id: 'globe',
    words:
      /\bglobe\b|\bwhole (?:earth|world|planet)\b|\breset\b|\bzoom (?:all the way )?out\b|\bstart over\b|\bhome view\b/,
  },
  { id: 'share', words: /\bshare|\blink\b|\burl\b/ },
  {
    id: 'clear',
    words: /\bclear\b|\b(?:all|every) (?:the )?(?:data )?layers?\b/,
  },
  {
    id: 'draw',
    words:
      /\bdraw|\bsketch|\bannotat|\bmeasur|\bdistance\b|\bruler\b|\bmarkup\b|\bpolygon\b/,
  },
];
const guideTopic = (subject) =>
  GUIDE_TOPICS.find((topic) => topic.words.test(subject))?.id ||
  FEATURE_TOPICS.find((topic) => topic.words.test(subject))?.id ||
  null;

// "how do I see …", "show me how to turn on …", "guide me to …". The first
// group is a verb that turns something off ("how do I turn off flights"),
// the second what it is about.
const HOW_TO =
  /^(?:can you |could you )?(?:(?:show|tell|teach) me how|how (?:do|can|would|should) i|how to|guide me|walk me through)(?: to)?\s+(?:(turn off|switch off|disable|hide|remove)\s+|(?:see|view|turn on|switch on|enable|show|find|use|get|watch|open|change|switch|set|pick|add)\s+)?(?:the\s+)?(.+)$/;
// "satellite settings", "options for flights": straight to the settings walk.
const SETTINGS_FOR =
  /^(?:(?:open|show|change)\s+)?(.+?)\s+(?:settings|options|preferences|prefs)$|^(?:settings|options|preferences)\s+(?:for|of)\s+(.+)$/;

// "turn on …" / "hide …" / "toggle …": a switch, not a place.
const SWITCH =
  /^(turn on|switch on|enable|show|display|add|turn off|switch off|disable|hide|remove|toggle)(?:\s+(.*))?$/;
const SWITCH_OFF = /^(turn off|switch off|disable|hide|remove)\b/;
/**
 * A word for a kind of place, alone: after a keyword it ends a name ("Fire
 * Island", "Ship Bottom", "Radio City"), and is no place to go to by itself.
 * Followed by more words it may begin one ("City Hall", "Peak District").
 */
const NAME_TAIL =
  /^(?:islands?|isle|city|hall|bottom|beach|station|street|road|hills?|valley|falls|springs?|creek|county|town|village|harbou?r|cove|canyon|center|centre|square|bridge|ridge|peak)$/i;

/**
 * A layer that shows itself through another, which must stay on with it:
 * Space Missions draws its missions with Satellites, and switching it off
 * puts Satellites back as it was before.
 */
const SHOWN_THROUGH = new Map([['rocket-launches', ['satellites']]]);

/** "hide everything except …", "turn off all layers but …". */
const EXCEPT =
  /^(?:turn off|switch off|disable|hide|remove|clear)\s+(?:everything|all(?: the)?(?: other)?(?: layers?)?|every layer)\s+(?:except(?: for)?|but(?: for)?|other than|apart from|besides|save for)\s+(.+)$/;
// Layers people reach for first, so "turn on" offers these before the rest.
export const POPULAR_LAYERS = [
  'flights',
  'ais-live-vessels',
  'satellites',
  'cctv',
  'earthquakes',
  'weather-radar',
  'local-firms',
  'traffic',
  'military',
  'rocket-launches',
];

// Everyday words for layers whose names do not contain them.
export const ALIASES = Object.freeze({
  plane: ['flights'],
  planes: ['flights'],
  aircraft: ['flights'],
  ship: ['ais-live-vessels'],
  ships: ['ais-live-vessels'],
  boats: ['ais-live-vessels'],
  vessels: ['ais-live-vessels'],
  camera: ['cctv'],
  cameras: ['cctv'],
  webcams: ['cctv'],
  quakes: ['earthquakes'],
  fires: ['local-firms', 'fire-perimeters'],
  wildfires: ['local-firms', 'fire-perimeters'],
  rain: ['weather-radar'],
  weather: ['weather-radar', 'weather-satellite'],
  clouds: ['weather-satellite'],
  lightning: ['weather-lightning'],
  storms: ['weather-cyclones'],
  hurricanes: ['weather-cyclones'],
  cables: ['telegeography-submarine-cables'],
  launches: ['rocket-launches'],
  rockets: ['rocket-launches'],
  bikes: ['bikeshare'],
  trains: ['transit'],
  buses: ['transit'],
  'radio stations': ['radio'],
  'radio station': ['radio'],
});

export const escapeRegExp = (text) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A match that starts a word: "air" finds "Air quality", "hi" not "Prohibited". */
const wordStart = (needle) =>
  new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}`);

// Words in layer names that say what kind, not which: alone they name no
// layer ("Local" is not Local ADS-B, "Global" no global layer).
const GENERIC_LAYER_WORDS = new Set([
  'local',
  'global',
  'live',
  'world',
  'real',
  'time',
  'new',
  'open',
  'all',
  'data',
  'map',
  'maps',
  'view',
  'level',
  'area',
  'areas',
  'zone',
  'zones',
  'of',
  'and',
  'the',
]);

/** Edit distance, for typos like "satelite". */
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = kept;
    }
  }
  return row[b.length];
}

/**
 * The layers' names, read once, and the matchers over them. A match carries
 * the live layer's fields (its `enabled` as the app reports it), its shown
 * name, a score and whether it names the whole layer (`exact`).
 * @param {Array<{id: string, name: string, enabled?: boolean, showInTogglePanel?: boolean}>} layers
 */
export function createLayerIndex(layers = []) {
  const index = layers
    .filter((layer) => layer.showInTogglePanel !== false)
    .map((layer) => {
      const shown = shownLayerName(layer.name, layer.id);
      const names = [shown, String(layer.name), String(layer.id)].map((n) =>
        n.toLowerCase(),
      );
      // Whole words come from the names people see, never from ids ("local",
      // "global" name no layer).
      const titles = names.slice(0, 2);
      const words = titles
        .flatMap((n) => n.split(/[^\p{L}\p{N}]+/u))
        .filter((word) => word && !GENERIC_LAYER_WORDS.has(word));
      return { layer, shown, names, titles, words: new Set(words) };
    });

  /** Data layers matching a word or phrase, best first. */
  function matchLayers(term) {
    const needle = String(term || '')
      .trim()
      .toLowerCase();
    if (!needle) return [];
    // Synonyms match as they are typed: "cam" already means cameras.
    const aliased = [
      ...new Set(
        Object.entries(ALIASES)
          .filter(
            ([word]) =>
              word === needle ||
              (needle.length >= 3 && word.startsWith(needle)),
          )
          .flatMap(([, ids]) => ids),
      ),
    ];
    const startsWord = wordStart(needle);
    return index
      .map(({ layer, shown, names, titles, words }) => {
        // Synonyms rank in the order they are listed.
        const score = aliased.includes(layer.id)
          ? 4 - aliased.indexOf(layer.id) / 10
          : names.some((n) => n.startsWith(needle))
            ? 2
            : names.some((n) => startsWord.test(n))
              ? 1
              : 0;
        // A whole name, a whole word of one or a whole synonym (a plural "s"
        // from four letters: "fire" names fires, "new" does not name News),
        // not the start of one: "rock" begins "rockets" but names no layer.
        const exact =
          Boolean(
            ALIASES[needle]?.includes(layer.id) ||
            (needle.length >= 4 && ALIASES[`${needle}s`]?.includes(layer.id)),
          ) ||
          titles.includes(needle) ||
          words.has(needle) ||
          (needle.length >= 4 && words.has(`${needle}s`));
        return { ...layer, shown, score, exact };
      })
      .filter((layer) => layer.score > 0)
      .sort((a, b) => b.score - a.score || b.exact - a.exact);
  }

  /** Layers for a phrase, forgiving a typo or two when nothing matches exactly. */
  function matchLayersLoosely(term) {
    const exact = matchLayers(term);
    if (exact.length) return exact;
    const words = String(term || '')
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length >= 4);
    if (!words.length) return [];
    const near = (word, candidate) =>
      editDistance(word, candidate) <= (word.length >= 7 ? 2 : 1);
    return index
      .filter(({ layer, words: names }) => {
        const candidates = [
          ...names,
          ...Object.entries(ALIASES)
            .filter(([, ids]) => ids.includes(layer.id))
            .map(([word]) => word),
        ].filter((candidate) => candidate.length >= 3);
        return words.some((word) =>
          candidates.some((candidate) => near(word, candidate)),
        );
      })
      .map(({ layer, shown }) => ({ ...layer, shown, score: 2 }));
  }

  /** Every listed layer, with its shown name. */
  const all = () => index.map(({ layer, shown }) => ({ ...layer, shown }));

  return { matchLayers, matchLayersLoosely, all };
}

/** Words in "how do I …" that name no feature on their own. */
const GUIDE_STOP_WORDS = new Set([
  'this',
  'that',
  'it',
  'these',
  'those',
  'here',
  'app',
  'the',
  'a',
  'an',
  'my',
  'thing',
  'things',
  'one',
  'stuff',
  'feature',
  'features',
  'tool',
  'button',
]);

/** A layer match that names the whole layer, not the start of its name. */
const named = (layer) => layer?.score >= 2 && layer.exact !== false;

/**
 * "new york" → "New York", "trinidad and tobago" → "Trinidad and Tobago", for
 * labels only; the search gets the text as typed.
 */
const SMALL_WORDS = new Set([
  'and',
  'of',
  'the',
  'on',
  'upon',
  'de',
  'del',
  'la',
  'le',
  'du',
  'da',
  'des',
]);
/**
 * A place's name for a row: as typed when it has a capital ("iPhone store",
 * "McAllen", "İstanbul"), else each word capitalised but the small joining
 * ones ("santa fe de bogotá" reads "Santa Fe de Bogotá").
 */
export const titleCase = (text) =>
  /\p{Lu}/u.test(text)
    ? text
    : text.replace(/\S+/g, (word, at) =>
        at > 0 && SMALL_WORDS.has(word)
          ? word
          : word[0].toUpperCase() + word.slice(1),
      );

const STYLE_LABELS = {
  noir: msg('Style: Noir'),
  thermal: msg('Style: Thermal'),
  surveillance: msg('Style: Night vision'),
  retro: msg('Style: Retro'),
  anime: msg('Style: Anime'),
  normal: msg('Style: Normal'),
};
const STACK_LABELS = {
  osm: msg('Map: OpenStreetMap'),
  'bing-aerial': msg('Map: Bing aerial'),
  photoreal: msg('Map: Photoreal 3D'),
  'esri-imagery': msg('Map: Esri imagery'),
};
const CAMERA_LABELS = {
  clear: msg('Clear all layers'),
  share: msg('Share this view'),
  reset: msg('Reset view'),
  northUp: msg('North up'),
  tilt: msg('Tilt / 3D view'),
  zoom_to_globe: msg('Globe view'),
  move_camera: msg('Orbit'),
};

// Every command the omnibar can run directly. Type ">" to list them all, or
// type a command's name or one of its words to find it among the results.
const cmd = (id, label, words, icon, step) =>
  Object.freeze({ id, label, words, icon, step });
export const COMMANDS = Object.freeze([
  cmd(
    'clear',
    msg('Clear all layers'),
    'turn off hide remove every everything layers',
    'layers_clear',
    { kind: 'camera', act: 'clear' },
  ),
  cmd(
    'layers',
    msg('Open data layers'),
    'layers panel menu list show',
    'layers',
    { kind: 'camera', name: 'show_data_layers_menu', args: {} },
  ),
  cmd(
    'close-panels',
    msg('Close all panels'),
    'collapse close hide minimise minimize fold all panels sidebars',
    'close_fullscreen',
    { kind: 'panel', action: 'close', side: 'all' },
  ),
  cmd(
    'close-left',
    msg('Close left panel'),
    'collapse close hide left panel sidebar',
    'chevron_left',
    { kind: 'panel', action: 'close', side: 'left' },
  ),
  cmd(
    'close-right',
    msg('Close right panel'),
    'collapse close hide right panel sidebar',
    'chevron_right',
    { kind: 'panel', action: 'close', side: 'right' },
  ),
  cmd(
    'open-utilities',
    msg('Open Utilities'),
    'utilities tools panel open',
    'handyman',
    {
      kind: 'panel',
      action: 'open',
      side: 'left',
      item: 'utilities-panel',
      name: 'Utilities',
    },
  ),
  cmd(
    'open-authoring',
    msg('Open Authoring'),
    'authoring scenes panel open',
    'movie',
    {
      kind: 'panel',
      action: 'open',
      side: 'left',
      item: 'scene-panel',
      name: 'Authoring',
    },
  ),
  cmd(
    'open-display',
    msg('Open Visual'),
    'visual display settings presets looks styles panel open',
    'palette',
    {
      kind: 'panel',
      action: 'open',
      side: 'left',
      item: 'pp-toggles',
      name: 'Visual',
    },
  ),
  cmd('open-context', msg('Open Context'), 'context panel open', 'radar', {
    kind: 'panel',
    action: 'open',
    side: 'right',
    item: 'global-context-panel',
    name: 'Context',
  }),
  cmd('reset', msg('Reset view'), 'home start over reset camera', 'public', {
    kind: 'camera',
    act: 'reset',
  }),
  cmd(
    'globe',
    msg('Globe view'),
    'whole earth world zoom out globe',
    'public',
    { kind: 'camera', name: 'zoom_to_globe', args: {} },
  ),
  cmd('north', msg('North up'), 'face north compass heading', 'navigation', {
    kind: 'camera',
    act: 'northUp',
  }),
  cmd('tilt', msg('Tilt / 3D view'), 'perspective 3d tilt', 'view_in_ar', {
    kind: 'camera',
    act: 'tilt',
  }),
  cmd('zoom-in', msg('Zoom in'), 'closer zoom in', 'open_in_full', {
    kind: 'camera',
    name: 'adjust_camera_zoom',
    args: { direction: 'in' },
  }),
  cmd('zoom-out', msg('Zoom out'), 'further zoom out', 'close_fullscreen', {
    kind: 'camera',
    name: 'adjust_camera_zoom',
    args: { direction: 'out' },
  }),
  cmd('orbit', msg('Orbit'), 'rotate spin orbit circle', 'adjust', {
    kind: 'camera',
    name: 'move_camera',
    args: { motion: 'orbit', mode: 'continuous' },
  }),
  cmd('stop', msg('Stop camera'), 'stop orbit halt still', 'close', {
    kind: 'camera',
    name: 'move_camera',
    args: { motion: 'stop' },
  }),
  cmd('share', msg('Share this view'), 'share copy link url', 'east', {
    kind: 'camera',
    act: 'share',
  }),
  cmd('hud-on', msg('HUD on'), 'show hud overlay', 'visibility', {
    kind: 'hud',
    visible: 'on',
  }),
  cmd('hud-off', msg('HUD off'), 'hide hud overlay clean', 'visibility_off', {
    kind: 'hud',
    visible: 'off',
  }),
  cmd(
    'style-normal',
    msg('Style: Normal'),
    'normal default plain style',
    'tune',
    { kind: 'style', style: 'normal' },
  ),
  cmd('style-noir', msg('Style: Noir'), 'noir black white style', 'dark_mode', {
    kind: 'style',
    style: 'noir',
  }),
  cmd(
    'style-thermal',
    msg('Style: Thermal'),
    'thermal flir heat infrared style',
    'flare',
    { kind: 'style', style: 'thermal' },
  ),
  cmd(
    'style-nvg',
    msg('Style: Night vision'),
    'night vision nvg surveillance green style',
    'light_mode',
    { kind: 'style', style: 'surveillance' },
  ),
  cmd('style-retro', msg('Style: Retro'), 'retro crt style', 'tune', {
    kind: 'style',
    style: 'retro',
  }),
  cmd('style-anime', msg('Style: Anime'), 'anime cartoon style', 'draw', {
    kind: 'style',
    style: 'anime',
  }),
  cmd(
    'map-photoreal',
    msg('Map: Photoreal 3D'),
    'photoreal 3d tiles google map',
    'view_in_ar',
    { kind: 'stack', stack: 'photoreal' },
  ),
  cmd(
    'map-esri',
    msg('Map: Esri imagery'),
    'esri satellite imagery map',
    'satellite_alt',
    { kind: 'stack', stack: 'esri-imagery' },
  ),
  cmd('map-bing', msg('Map: Bing aerial'), 'bing aerial map', 'satellite_alt', {
    kind: 'stack',
    stack: 'bing-aerial',
  }),
  cmd(
    'map-osm',
    msg('Map: OpenStreetMap'),
    'osm openstreetmap street map',
    'location_on',
    { kind: 'stack', stack: 'osm' },
  ),
  cmd('cockpit', msg('Enter cockpit'), 'cockpit pilot fly plane', 'flight', {
    kind: 'cockpit',
  }),
  cmd(
    'nearest',
    msg('Nearest aircraft'),
    'nearest closest plane aircraft flight',
    'flight',
    { kind: 'nearest' },
  ),
  cmd('radio', msg('Enable Radio'), 'radio music news listen', 'radio', {
    kind: 'radio',
  }),
  cmd('voice', msg('Talk to GEV'), 'voice mic microphone talk speak', 'radar', {
    kind: 'mic',
  }),
]);

const withoutPrefix = (label) => label.replace(/^[^:]+:\s*/, '');

/**
 * The command the text names exactly, by its label ("North up", "Style:
 * Noir" or "Noir"), after the line's normalisation ("North up.", "please
 * north up"). One of its search words alone ("music", "link", "heat") only
 * finds it.
 */
export function exactCommand(text) {
  return labelledCommand(readLine(text));
}

/** The command whose label is exactly this text, as typed, or null. */
function labelledCommand(text) {
  const needle = String(text || '')
    .replace(/^>\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!needle) return null;
  return (
    COMMANDS.find((command) => {
      const labels = [command.label, t(command.label)].map((label) =>
        label.toLowerCase(),
      );
      return (
        labels.includes(needle) || labels.map(withoutPrefix).includes(needle)
      );
    }) || null
  );
}

/**
 * The line as the Omnibar reads it: normalizeLine, with "please" dropped
 * only around a request (a verb, a real question or a command's label).
 * Place rows and the place service get the text as typed.
 */
export function readLine(text) {
  return normalizeLine(text, {
    isRequest: (rest) =>
      hasActionVerb(rest) ||
      isRealQuestion(rest) ||
      Boolean(labelledCommand(rest)),
  });
}

/** Commands matching words typed in order from their starts, best first. */
export function matchCommands(text) {
  const words = String(text || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [...COMMANDS];
  return COMMANDS.map((command) => {
    const hay = `${command.label} ${command.words}`.toLowerCase();
    const hits = words.filter((word) => wordStart(word).test(hay)).length;
    const label = command.label.toLowerCase();
    const score =
      hits === words.length ? (label.startsWith(words.join(' ')) ? 3 : 2) : 0;
    return { command, score };
  })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ command }) => command);
}

/** One step of a plan, in a few words. */
export function stepLabel(step) {
  switch (step.kind) {
    case 'place':
      return titleCase(step.shown ?? step.place);
    case 'layer':
      return step.enabled
        ? t('{layer} on', { layer: step.layer.shown })
        : t('{layer} off', { layer: step.layer.shown });
    case 'style':
      return t(STYLE_LABELS[step.style]);
    case 'stack':
      return t(STACK_LABELS[step.stack]);
    case 'camera':
      if (step.name === 'adjust_camera_zoom')
        return step.args.direction === 'in' ? t('Zoom in') : t('Zoom out');
      if (step.name === 'move_camera' && step.args.motion === 'stop')
        return t('Stop camera');
      return t(CAMERA_LABELS[step.act || step.name]);
    case 'hud':
      return step.visible === 'off' ? t('HUD off') : t('HUD on');
    case 'panel':
      if (step.action === 'open')
        return t('Open {panel}', { panel: t(step.name) });
      if (step.side === 'all') return t('Close all panels');
      if (step.item) return t('Close {panel}', { panel: t(step.name) });
      return step.side === 'left'
        ? t('Close left panel')
        : t('Close right panel');
    case 'radio':
      return step.action === 'disable' ? t('Radio off') : t('Radio');
    case 'cockpit':
      return t('Cockpit');
    case 'nearest':
      return t('Nearest aircraft');
    case 'follow':
      return t('Follow {target}', { target: step.query.toUpperCase() });
    default:
      return '';
  }
}

/** A callsign (UAL2110, BAW15K, N123AB) or a hex transponder code (a12b2e). */
export const CALLSIGN =
  /^(?:[a-z]{2,3}\d{1,4}[a-z]{0,2}|n\d{1,5}[a-z]{0,2}|[0-9a-f]{6})$/i;

// "villages near Manor", "towns around here": answered from the bundled packs.
export const VILLAGES =
  /^(?:(?:show|list|find)\s+)?(?:me\s+)?(?:the\s+)?(?:villages?|towns?|small towns|hamlets?|settlements?|places)\s+(?:near|around|close to|in|by)\s+(.+)$/i;

// "draw" (or the start of it) offers Draw's shapes and options, and so does
// a draw verb with something to draw ("draw a line"); "Draw Bridge" and
// "draw well" are names.
const DRAW_WORDS = ['draw', 'sketch', 'annotate', 'drawing', 'markup'];
const DRAW_SOMETHING =
  /^(?:draw|sketch|annotate|markup)\s+(?:a|an|the|some|on|here|it|shapes?|lines?|areas?|pins?|polygons?|circles?|routes?|paths?|boxes?|zones?)(?:\s|$)/;
export function drawAsked(text) {
  const low = readLine(text).toLowerCase();
  if (low.length < 3) return false;
  return (
    DRAW_WORDS.some((word) => word.startsWith(low) || low === word) ||
    DRAW_SOMETHING.test(low)
  );
}

/**
 * Decimal degrees ("30.27, -97.74"), degrees-minutes-seconds ("30°16'N
 * 97°44'W") or an MGRS grid ("14R PU 2090 4906"), or null.
 */
export function coordinateTarget(text) {
  const point = parseCoordinateQuery(text);
  if (!point) return null;
  const grid = /^\d{1,2}[C-HJ-NP-X][A-HJ-NP-Z]{2}(\d{2}){1,5}$/i.test(
    text.replace(/\s+/g, ''),
  );
  return { ...point, kind: grid ? 'MGRS' : t('Coordinates') };
}

/**
 * The coordinates a line names as its place ("go to 30.27, -97.74", "flights
 * near 48.85 2.35"), as typed, or null.
 */
function placeCoordinates(text, parsed) {
  const place = parsed.steps.find((step) => step.kind === 'place')?.place;
  if (!place || !coordinateTarget(place)) return null;
  const at = text.toLowerCase().indexOf(place.toLowerCase());
  return at < 0 ? null : text.slice(at, at + place.length);
}

/** The line without the coordinates it names, for the privacy rules. */
function withoutCoordinates(text, parsed) {
  const coordinates = placeCoordinates(text, parsed);
  return coordinates ? text.replace(coordinates, ' ').trim() : text;
}

function coordinateRow(target, text) {
  const where = `${Math.abs(target.lat).toFixed(4)}°${target.lat >= 0 ? 'N' : 'S'} ${Math.abs(target.lon).toFixed(4)}°${target.lon >= 0 ? 'E' : 'W'}`;
  return {
    key: `coords:${where}`,
    kind: 'place',
    icon: 'my_location',
    place: text,
    coords: { latitude: target.lat, longitude: target.lon },
    label: t('Go to {where}', { where }),
    hint: target.kind,
  };
}

const askRow = (text) => ({
  key: 'ask',
  kind: 'ask',
  icon: null,
  query: text,
  label: t('Ask GEV: “{query}”', { query: text }),
  hint: t('Opens chat'),
});
/** `shown`: the place as typed, for the label ("İstanbul", "iPhone store"). */
const placeRow = (place, shown = place) => ({
  key: `place:${place}`,
  kind: 'place',
  icon: 'location_on',
  place,
  label: t('Go to {place}', { place: titleCase(shown) }),
  hint: t('Place or coordinates'),
});
/**
 * The line searched as a place only when picked: offered for a long name
 * read as a sentence, and for text that may be private ("Tverskaya 13
 * 125009 Moscow" looks like a number to keep). Never the Enter default, and
 * nothing is looked up while typing.
 */
const explicitPlaceRow = (text, { private: secret = false } = {}) => ({
  ...placeRow(text),
  key: `place-explicit:${text}`,
  explicit: true,
  ...(secret && {
    label: t('Search “{query}” as a place anyway', { query: text }),
  }),
});
/**
 * A layer's switch. `best`: the line names this layer before any other, so
 * Enter may run it (see mayRunOnEnter).
 */
const layerRow = (layer, enabled = !layer.enabled, { best = false } = {}) => ({
  key: `layer:${layer.id}:${enabled}`,
  kind: 'layer',
  id: layer.id,
  enabled,
  best,
  icon: 'layers',
  label: layer.shown,
  hint:
    Boolean(layer.enabled) === enabled
      ? t('Layer')
      : enabled
        ? t('Turn on')
        : t('Turn off'),
});
const commandRow = (command, line = '') => ({
  key: `cmd:${command.id}`,
  command: command.id,
  // The line named this command exactly (see mayRunOnEnter).
  named: exactCommand(line) === command,
  kind: command.step.kind === 'mic' ? 'mic' : 'plan',
  icon: command.icon,
  steps: [command.step],
  label: t(command.label),
  hint: t('Command'),
});
/**
 * A guided walk. `loose`: found by forgiving a typo; `titled`: the line is
 * written as a title. Either way it is offered, never run on Enter.
 */
const guideRow = (key, guide, label, icon = 'east', flags = {}) => ({
  key: `guide:${key}`,
  kind: 'guide',
  icon,
  guide,
  label,
  hint: t('Guide'),
  ...flags,
});

/**
 * The Omnibar's reader for one set of layers: what a line asks for, the rows
 * it offers, and what may go to the place service.
 * @param {{layers?: Array<object>, isEntity?: (text: string) => boolean}} options
 */
export function createOmnibar({ layers = [], isEntity = () => false } = {}) {
  const { matchLayers, matchLayersLoosely, all } = createLayerIndex(layers);
  const cache = new Map();

  /**
   * A line, normalised once and read once: `line` is what the user meant
   * ("Show flights." → "Show flights"), `plain` the line without a
   * magnitude floor, `parsed` how parseOmnibar read it.
   */
  function read(text) {
    const line = readLine(text);
    if (!cache.has(line)) {
      if (cache.size >= 16) cache.delete(cache.keys().next().value);
      const { text: plain, minMagnitude } = magnitudeFloor(line, matchLayers);
      cache.set(line, {
        line,
        plain,
        minMagnitude,
        parsed: parseOmnibar(plain, matchLayers, { isEntity }),
      });
    }
    return cache.get(line);
  }

  /**
   * "hide everything except flights", "turn off all but ships": a plan that
   * switches off every layer that is on but the ones named. Null when the
   * line is not that, or names no layer to keep.
   */
  function exceptRows(line, ask) {
    const match = EXCEPT.exec(line.toLowerCase());
    if (!match) return null;
    // Every layer to keep must be one: with a name not read ("flights and
    // the fog") nothing is switched off, and only GEV is offered.
    const kept = match[1]
      .split(/\s*(?:,|\band\b|&)\s*/)
      .filter(Boolean)
      .map((term) => matchLayers(term.replace(/^(?:the|my)\s+/, ''))[0]);
    if (!kept.length) return null;
    if (!kept.every(named)) return [ask];
    const keptIds = new Set(kept.map((layer) => layer.id));
    // Keeping either of a pair keeps both while the first is on: switching
    // one off would take the other with it ("except space missions",
    // "except satellites").
    for (const [layer, through] of SHOWN_THROUGH) {
      const on = all().find((entry) => entry.id === layer)?.enabled;
      if (on && (keptIds.has(layer) || through.some((id) => keptIds.has(id))))
        for (const id of [layer, ...through]) keptIds.add(id);
    }
    const steps = all()
      .filter((layer) => layer.enabled && !keptIds.has(layer.id))
      .map((layer) => ({ kind: 'layer', layer, enabled: false }));
    if (!steps.length)
      return [
        {
          key: 'none',
          kind: 'none',
          icon: 'layers',
          label: t('No other layers are on'),
          hint: '',
        },
        ask,
      ];
    return [
      {
        key: `plan:${JSON.stringify(steps)}`,
        kind: 'plan',
        icon: 'bolt',
        steps,
        // Asked for in so many words: Enter runs it.
        asked: true,
        label: steps.map(stepLabel).join(' · '),
        hint: t('Do all'),
      },
      ask,
    ];
  }

  /**
   * "turn on …", "hide …", "toggle …", alone or with a few letters: the
   * layers and features that switch that way, never places. Null when the
   * line is not such a switch, or names nothing to switch and may be a place
   * ("Show Low, AZ").
   */
  function switchRows(line, ask) {
    const excepted = exceptRows(line, ask);
    if (excepted) return excepted;
    const switching = line.toLowerCase().match(SWITCH);
    if (
      !switching ||
      isPanelText(line) ||
      isWholeMapClear(line) ||
      // More than one request ("hide flights, show ships") is the parser's.
      /\b(near|in|at|over|around|and|then)\b|[,;+&]/.test(switching[2] || '')
    )
      return null;
    const verb = switching[1];
    const rest = (switching[2] || '')
      .replace(/^((me|the|all|my)\s+)+/, '')
      .trim();
    // "turn off noir", "show osm", "turn on orbit": a style, map or camera
    // move is read by the parser, not listed as a layer switch.
    if (
      rest &&
      read(line).parsed.steps.some((step) =>
        ['style', 'stack', 'camera'].includes(step.kind),
      )
    )
      return null;
    const wantOff = SWITCH_OFF.test(verb);
    const toggle = verb === 'toggle';
    const want = (layer) => (toggle ? !layer.enabled : !wantOff);
    const pool = rest
      ? matchLayers(rest)
      : all().sort((a, b) => {
          const rank = (id) => {
            const at = POPULAR_LAYERS.indexOf(id);
            return at === -1 ? POPULAR_LAYERS.length : at;
          };
          return rank(a.id) - rank(b.id);
        });
    // The layer the words name leads, whatever its state: "show flights"
    // with Flights already on offers Flights (nothing to do), never the next
    // layer that has the word in its name.
    const [first] = pool;
    const best = rest && named(first) ? first : null;
    const layerRows = [
      ...(best ? [layerRow(best, want(best), { best: true })] : []),
      ...pool
        .filter((layer) => layer !== best)
        .filter((layer) => toggle || (wantOff ? layer.enabled : !layer.enabled))
        .map((layer) => layerRow(layer, want(layer))),
    ].slice(0, rest ? 5 : 6);
    const featureIds = wantOff
      ? ['clear', 'hud-off', 'stop']
      : toggle
        ? ['hud-on', 'hud-off', 'radio']
        : ['hud-on', 'radio', 'orbit'];
    const features = COMMANDS.filter((command) =>
      featureIds.includes(command.id),
    )
      .filter((command) => !rest || matchCommands(rest).includes(command))
      .map((command) => commandRow(command, line));
    const found = [...layerRows, ...features];
    if (found.length) return [...found, ask];
    // "Show Low, AZ" names no layer or feature: it may be a place, and so
    // may "Remove Island" or "Toggle Inn", written as names.
    if (rest && !wantOff && !toggle) return null;
    if (rest && /\p{Lu}/u.test(line.slice(verb.length))) return null;
    return [
      {
        key: 'none',
        kind: 'none',
        icon: 'layers',
        label: wantOff ? t('No layers are on') : t('No matching layers'),
        hint: '',
      },
      ask,
    ];
  }

  /**
   * Things loaded on the map whose name or id matches, added to a list. A
   * callsign, tail number or transponder code leads it; otherwise a place
   * row keeps the top ("Hamburg" goes to Hamburg, not to the ship HAMBURG),
   * with exact names right after it, and they lead only when there is no
   * place row.
   */
  function withEntities(list, line, entities) {
    if (!entities || line.length < 2 || line.startsWith('>')) return list;
    const callsign = CALLSIGN.test(line.replace(/\s+/g, ''));
    const rows = entities(line.replace(/\s+/g, callsign ? '' : ' '), {
      limit: callsign ? 5 : 3,
    }).map((found) => ({
      key: `entity:${found.key}`,
      kind: 'entity',
      icon: found.icon,
      identity: found.identity,
      exact: found.title.toLowerCase() === line.toLowerCase(),
      label: found.title,
      hint: found.layerName,
    }));
    if (!rows.length) return list;
    const place = list.findIndex((item) => item.kind === 'place');
    const exact = rows.filter((row) => row.exact);
    const leads = callsign ? rows : place === -1 ? exact : [];
    const rest = [
      ...(callsign || place === -1 ? [] : exact),
      ...rows.filter((row) => !leads.includes(row) && !exact.includes(row)),
    ];
    const ask = list.findIndex((item) => item.kind === 'ask');
    const at = place !== -1 ? place + 1 : ask !== -1 ? ask : list.length;
    return [...leads, ...list.slice(0, at), ...rest, ...list.slice(at)];
  }

  /** The rows for a line that is neither private, coordinates nor a count. */
  function lineRows(text, line, { places = [], entities } = {}) {
    const ask = askRow(text);
    const low = line.toLowerCase();
    // Real places for this text once the suggester answers; the line itself
    // only stands in while it has nothing.
    const realPlaces = places.map((found) => ({
      key: `place:${found.name}|${found.detail}`,
      kind: 'place',
      icon: 'location_on',
      place: found.name,
      coords: { latitude: found.latitude, longitude: found.longitude },
      source: 'photon',
      label: t('Go to {place}', { place: found.name }),
      hint: found.detail || t('Place'),
    }));
    const placeRows = (place) =>
      realPlaces.length
        ? realPlaces
        : place.trim().length >= minPlaceChars(place)
          ? [placeRow(place, asTypedIn(text, place))]
          : [];

    const titled = writtenAsName(text.split(/\s+/));
    const settingsFor = low.match(SETTINGS_FOR);
    if (settingsFor) {
      const term = (settingsFor[1] || settingsFor[2]).trim();
      const [layer] = matchLayersLoosely(term);
      if (layer)
        return [
          guideRow(
            `settings:${layer.id}`,
            { settings: layer },
            t('Show me {thing} settings', { thing: layer.shown }),
            'tune',
            { loose: !matchLayers(term).length, titled },
          ),
          ask,
        ];
    }

    // "show me how to see satellites": a guided walk through the real
    // controls, doing it directly, and asking GEV.
    const howTo = low.match(HOW_TO);
    if (howTo) {
      const wantOff = Boolean(howTo[1]);
      const subject = howTo[2].replace(/^((the|a|an|my|some)\s+)+/, '').trim();
      const [layer] = matchLayersLoosely(subject);
      // Words that say what the walk is about: "how do I use this" names
      // nothing ("this" is no part of "Share this view").
      const content = subject
        .split(/\s+/)
        .filter((word) => word && !GUIDE_STOP_WORDS.has(word));
      const [command] = content.length
        ? matchCommands(content.join(' ')).filter((found) =>
            featureGuideFor(found.id),
          )
        : [];
      // A walk is run on Enter only when every word is a whole word of the
      // command ("how do I share"); a word it merely begins is offered.
      const commandWords = command
        ? new Set(
            `${command.label} ${command.words}`.toLowerCase().split(/\W+/),
          )
        : new Set();
      const commandLoose = !content.every((word) => commandWords.has(word));
      const guides = [];
      const topic = guideTopic(subject);
      if (topic)
        guides.push(
          guideRow(
            `feature:${topic}`,
            { feature: topic },
            t('Show me how: {thing}', { thing: t(GUIDE_LABELS[topic]) }),
            'east',
            { titled },
          ),
          // Doing it directly, when the line names the walk's own command
          // ("how do I turn on the HUD": HUD on).
          ...(command && featureGuideFor(command.id) === topic
            ? [commandRow(command, line)]
            : []),
        );
      // A feature's own walk wins over a layer the words only resemble
      // ("tilt the camera" is no CCTV walk, "change the map" no layer's).
      const layerNamed = named(matchLayers(subject)[0]);
      if (layer && !(topic && (/layers?$/.test(subject) || !layerNamed))) {
        const layerGuides = [
          guideRow(
            `layer:${layer.id}`,
            { layer },
            t('Show me how: {thing}', { thing: layer.shown }),
            'east',
            { loose: !matchLayers(subject).length, titled },
          ),
          layerRow(layer, !wantOff),
        ];
        // A layer named in full leads a topic its words also hold: "how do
        // I see recent imagery" is the Recent Imagery walk, not the map's.
        // The Context panel's own walk stays first for "open global context".
        if (
          layerNamed &&
          matchLayers(subject)[0].id === layer.id &&
          topic !== 'context'
        )
          guides.unshift(...layerGuides);
        else guides.push(...layerGuides);
      } else if (command && !topic)
        guides.push(
          guideRow(
            `feature:${command.id}`,
            { feature: featureGuideFor(command.id) },
            t('Show me how: {thing}', {
              thing: t(
                GUIDE_LABELS[featureGuideFor(command.id)] || command.label,
              ),
            }),
            'east',
            { titled, loose: commandLoose },
          ),
          commandRow(command, line),
        );
      return [...guides, ask];
    }

    const switched = switchRows(line, ask);
    if (switched) return switched;

    // ">" lists commands, filtered by whatever follows it.
    if (line.startsWith('>')) {
      const term = line.slice(1).trim();
      const verb = /^(show|hide|enable|disable)\s+(.+)$/i.exec(term);
      if (verb) {
        const needle = verb[2].toLowerCase();
        const exact = matchLayers(needle).find((layer) =>
          [layer.id, layer.name, layer.shown].some(
            (name) => String(name).toLowerCase() === needle,
          ),
        );
        if (exact)
          return [
            layerRow(exact, /^(show|enable)$/i.test(verb[1]), { best: true }),
          ];
      }
      // A bare ">" lists them all with none picked.
      return matchCommands(term)
        .slice(0, 8)
        .map((command) => commandRow(command, line));
    }

    // A command leads only when the line is its exact label; one the line
    // merely begins or holds a word of ("voi", "globe") follows the first
    // row, so Enter never starts voice or a cockpit by accident.
    const found = line.length >= 3 ? matchCommands(line).slice(0, 2) : [];
    const exact = exactCommand(line);
    const leading = exact ? [exact] : [];
    const trailing = found.filter((command) => command !== exact).slice(0, 2);
    const withCommands = (rows) => [
      ...leading.map((command) => commandRow(command, line)),
      ...rows.slice(0, 1),
      ...trailing.map((command) => commandRow(command, line)),
      ...rows.slice(1),
    ];
    const { parsed } = read(line);
    const { steps, question, ambiguous, peeled, sentence, unasked } = parsed;
    const extraPlaces = parsed.extraPlaces || [];
    // The whole line as a place is searched as typed ("Paris, Texas.",
    // "Yahoo!"); only commands read the normalised line.
    const asTyped = (place) => (place === line ? text : place);
    if (question)
      return [
        ask,
        ...found.map((command) => commandRow(command, line)),
        ...matchLayers(line)
          .slice(0, 3)
          .map((layer) => layerRow(layer)),
      ];
    // A pasted sentence is no place and asks for nothing: only GEV is
    // offered, and Enter runs nothing.
    if (sentence)
      return [
        ask,
        ...(text.length >= minPlaceChars(text) ? [explicitPlaceRow(text)] : []),
      ];
    if (!steps.length)
      return withEntities(
        withCommands([...placeRows(text), ask]),
        line,
        entities,
      );
    const [first] = steps;
    const placeStep = steps.find((step) => step.kind === 'place');
    if (steps.length === 1 && first.kind === 'place') {
      if (leading.length || trailing.length)
        return withEntities(
          withCommands([...placeRows(asTyped(first.place)).slice(0, 2), ask]),
          line,
          entities,
        );
      return withEntities(
        [
          ...placeRows(asTyped(first.place)),
          ...matchLayers(line)
            .slice(0, 2)
            .map((layer) => layerRow(layer)),
          ask,
        ],
        line,
        entities,
      );
    }
    if (steps.length === 1 && first.kind === 'layer')
      return [
        layerRow(first.layer, first.enabled, { best: true }),
        // "earth" might be a place; "hide flights" is not.
        ...(steps.verb ? [] : placeRows(text).slice(0, 2)),
        ask,
      ];

    const plan = {
      key: `plan:${JSON.stringify(steps)}`,
      kind: 'plan',
      icon: 'bolt',
      steps,
      label: steps.map(stepLabel).filter(Boolean).join(' · '),
      hint: steps.length > 1 ? t('Do all') : t('Do it'),
    };
    const alternatives = [
      ...(placeStep ? placeRows(placeStep.place).slice(0, 2) : []),
      // "near New York and Paris": the plan goes to the first; the others
      // are offered rather than dropped.
      ...extraPlaces.map((extra) => placeRow(extra, asTypedIn(text, extra))),
      ...steps
        .filter((step) => step.kind === 'layer')
        .map((step) => layerRow(step.layer, step.enabled)),
    ];
    // "Thermal, California", "Tilt Cove", "tokyo traffic": one keyword
    // without a verb may be part of the place's name, so the whole line as a
    // place comes first and the plan second. After "go to …" with a request
    // peeled off, the place is the one read ("go to London with flights").
    // A keyword ahead of the rest of a name ("Fire Island", "Ship Bottom")
    // begins that name when what is left is only a word for a kind of
    // place: a fragment, not a place, so no plan goes there. "earthquakes
    // japan", "traffic city hall", "tokyo traffic" and "Thermal, California"
    // (a comma parts them) keep their plans.
    const lower = text.toLowerCase();
    const fragment =
      ambiguous &&
      !peeled &&
      placeStep &&
      !/[,;]/.test(text) &&
      lower.endsWith(placeStep.place.toLowerCase()) &&
      !lower.startsWith(placeStep.place.toLowerCase()) &&
      NAME_TAIL.test(placeStep.place);
    if (ambiguous)
      return withEntities(
        [
          peeled ? placeRow(placeStep.place, placeStep.shown) : placeRow(text),
          ...(fragment ? [] : [plan]),
          ...alternatives.filter((row) => row.kind !== 'place'),
          ask,
        ],
        line,
        entities,
      );
    // Keywords alone and nothing asked for ("Fire and Rain", "Noir and
    // Thermal"): the plan is offered, never run; the line may be a name.
    if (unasked && !placeStep && steps.length >= 2 && !exact)
      return withEntities(
        [placeRow(text), plan, ...alternatives, ask],
        line,
        entities,
      );
    return [plan, ...alternatives, ask];
  }

  /**
   * A bundled place's name that is also a command or layer word ("Thermal",
   * "Normal", "Hurricane"): the place comes first, the switch after it.
   */
  function withPlaceWord(list, line) {
    if (!isPlaceWord(line) || list[0]?.kind === 'place') return list;
    const place = placeRow(line);
    return [place, ...list.filter((item) => item.key !== place.key)];
  }

  /** Rows for the selected item, offered when the field is empty. */
  function selectionRows(selection) {
    const name = selection.title;
    return [
      {
        key: 'sel:fly',
        kind: 'sel-fly',
        icon: 'my_location',
        label: t('Fly to {name}', { name }),
        hint: selection.layerName,
      },
      ...(selection.canFollow
        ? [
            {
              key: 'sel:follow',
              kind: 'sel-follow',
              icon: 'navigation',
              label: t('Follow {name}', { name }),
              hint: t('Camera'),
            },
          ]
        : []),
      ...(selection.canCockpit
        ? [
            {
              key: 'sel:cockpit',
              kind: 'sel-cockpit',
              icon: 'airline_seat_recline_normal',
              label: t('Cockpit behind {name}', { name }),
              hint: t('Cockpit'),
            },
          ]
        : []),
      {
        key: 'sel:ask',
        kind: 'sel-ask',
        icon: null,
        label: t('Ask GEV about {name}', { name }),
        hint: t('Opens chat'),
      },
      {
        key: 'sel:close',
        kind: 'sel-close',
        icon: 'close',
        label: t('Close {name}', { name }),
        hint: t('Context'),
      },
    ];
  }

  /**
   * With nothing typed or selected: "What's here?" and the most used layers
   * that are off.
   */
  function viewRows(viewPlace) {
    const off = all()
      .filter((layer) => !layer.enabled && POPULAR_LAYERS.includes(layer.id))
      .sort(
        (a, b) => POPULAR_LAYERS.indexOf(a.id) - POPULAR_LAYERS.indexOf(b.id),
      )
      .slice(0, 2)
      .map((layer) => ({
        key: `view-on:${layer.id}`,
        kind: 'layer',
        id: layer.id,
        enabled: true,
        icon: 'layers',
        label: t('Turn on {layer} here', { layer: layer.shown }),
        hint: t('Layer'),
      }));
    const where = viewPlace
      ? [viewPlace.name, viewPlace.state || viewPlace.country]
          .filter(Boolean)
          .join(', ')
      : t('this view');
    return [
      {
        key: 'view-ask',
        kind: 'view-ask',
        icon: null,
        label: t("What's here?"),
        hint: where,
      },
      ...off,
    ];
  }

  /**
   * The rows for what is typed, in the order shown, and the one Enter runs
   * before any is chosen (-1 for none).
   * @param {string} typed
   * @param {{
   *   places?: Array<object>,
   *   entities?: (text: string, options: {limit: number}) => Array<object>,
   *   selection?: ?{title: string, layerName: string, canFollow: boolean, canCockpit: boolean},
   *   viewPlace?: ?{name: string, state?: string, country?: string},
   *   counted?: ?{count: number, what: string, placeName: string, place: object, layer: object},
   * }} context
   * @returns {{rows: Array<object>, defaultIndex: number}}
   */
  function rows(typed, context = {}) {
    const text = String(typed || '').trim();
    if (!text) {
      const list = context.selection
        ? selectionRows(context.selection)
        : viewRows(context.viewPlace);
      return { rows: list, defaultIndex: -1 };
    }
    const line = readLine(text);
    const { parsed } = read(line);
    const enterContext = { named: Boolean(exactCommand(line)) };
    const finish = (list) => {
      const ordered = orderForEnter(
        withPlaceWord(list, line),
        line,
        parsed,
        enterContext,
      );
      return {
        rows: ordered,
        defaultIndex: enterDefault(ordered, line, parsed, enterContext),
      };
    };
    const coordinates = placeCoordinates(text, parsed);
    const onlyPlace = parsed.steps.length === 1 && coordinates;
    const target =
      coordinateTarget(line) ??
      (onlyPlace ? coordinateTarget(coordinates) : null);
    // Coordinates are a spot, not a secret; nothing about them leaves the
    // app unless GEV is asked.
    if (target)
      return finish([
        coordinateRow(target, onlyPlace ? coordinates : line),
        ...(mayBePrivate(text) ? [] : [askRow(text)]),
      ]);
    // Coordinates named as a line's place ("flights near 30.27, -97.74") are
    // no secret either: the rest of the line is what the rules read.
    const privateText = withoutCoordinates(text, parsed);
    // Text that may be private (an email address, a card, phone, SSN or
    // account number, a password or key) is never offered to the place
    // service, the place search or GEV: only things already loaded on the
    // map may match it.
    if (mayBePrivate(privateText))
      return finish([
        ...withEntities([], line, context.entities),
        // An address may look like a number to keep; a bare number never
        // names a place, and an email, password, key or code is never
        // offered as one.
        ...(onlyNumbersLookPrivate(text)
          ? [explicitPlaceRow(text, { private: true })]
          : []),
      ]);
    const counted = context.counted;
    if (counted) {
      const show = {
        key: 'count-show',
        kind: 'count-show',
        icon:
          counted.layer.icon && /^[a-z_]+$/.test(counted.layer.icon)
            ? counted.layer.icon
            : 'travel_explore',
        label: tn(
          counted.count,
          'Show {what} in {place} ({count} item)',
          'Show {what} in {place} ({count} items)',
          { what: counted.what, place: counted.placeName },
        ),
        hint: t('Go there'),
        coords: {
          latitude: counted.place.latitude,
          longitude: counted.place.longitude,
        },
        place: counted.placeName,
        source: counted.place.source,
      };
      return finish([
        show,
        ...lineRows(text, line, context).filter((item) => item.kind !== 'plan'),
      ]);
    }
    const list = lineRows(text, line, context);
    if (!drawAsked(line)) return finish(list);
    return finish(
      [
        {
          key: 'tool:draw',
          kind: 'open-draw',
          icon: 'draw',
          label: t('Open draw options'),
          hint: t('Utilities'),
        },
        ...list.filter((item) => item.kind !== 'place').slice(0, 3),
        ...list.filter((item) => item.kind === 'place').slice(0, 1),
      ].sort((a, b) => (a.kind === 'ask') - (b.kind === 'ask')),
    );
  }

  /**
   * What may go to the place service (Photon) for a line, or null: the part
   * that names a place, or the whole line when it may be one name
   * ("Satellite Beach", "Home, Washington"). Never private text, a question,
   * a pasted sentence, a command, coordinates, a callsign, a switch or
   * "villages near …".
   */
  function placeQuery(typed) {
    const text = String(typed || '').trim();
    if (!text || mayBePrivate(text)) return null;
    const line = readLine(text);
    if (line.length < minPlaceChars(line) || line.startsWith('>')) return null;
    if (/^[0-9a-f]{6}$/i.test(line) || CALLSIGN.test(line.replace(/\s+/g, '')))
      return null;
    if (line.includes('?')) return null;
    if (VILLAGES.test(line) || exactCommand(line) || coordinateTarget(line))
      return null;
    if (switchRows(line, askRow(text))) return null;
    const { parsed } = read(line);
    if (parsed.question || parsed.sentence) return null;
    // Coordinates are flown to as they are, never looked up as a name.
    if (placeCoordinates(text, parsed)) return null;
    const place = parsed.steps.find((step) => step.kind === 'place');
    // "go to ,": punctuation names no place.
    if (place && !/[\p{L}\p{N}]/u.test(place.place)) return null;
    // A line of commands with no place in it ("night vision", "zoom in").
    if (parsed.steps.length && !place) return null;
    const words = (value) => value.split(/\s+/).length;
    // The words the place has, not the command around it ("take me to New
    // York City NY"); a line that may be one name counts all of its words.
    const named = place && !parsed.ambiguous ? place.place : line;
    if (words(named) > placeWordLimit(named)) return null;
    // "flights near Trinidad and Tobago": the whole name is looked up; the
    // rows still offer each part ("Tokyo and Osaka").
    const joined = (value) =>
      [value, ...(parsed.extraPlaces || [])].join(' and ');
    // After "go to … , noir" the place read is the one to look up.
    if (parsed.peeled && place) return joined(place.place);
    return parsed.ambiguous || !place
      ? text
      : place.place === line
        ? text
        : joined(place.place);
  }

  /**
   * A count request ("flights over Texas", "quakes above M5 in Japan"): the
   * layer to count and its magnitude floor, or null.
   */
  function countRequest(typed) {
    const text = String(typed || '').trim();
    if (text.length < 5 || text.startsWith('>') || mayBePrivate(text))
      return null;
    const { parsed, minMagnitude } = read(text);
    const layer = parsed.steps.find((step) => step.kind === 'layer');
    const place = parsed.steps.find((step) => step.kind === 'place');
    if (!layer || !place || layer.enabled === false) return null;
    // Only a layer counted in or near a place ("flights over Texas"): a
    // line that may be one name ("Ship Bottom", "Satellite Beach") or asks
    // for something else ("radio settings") is no count.
    if (parsed.ambiguous || parsed.placeFrom !== 'near') return null;
    return { layer: layer.layer, minMagnitude };
  }

  return {
    rows,
    placeQuery,
    countRequest,
    matchLayers,
    /** The line as read: for tests and diagnostics. */
    read,
  };
}
