// What a line typed into the omnibar asks for. A line is split into clauses
// ("noir and cctv near austin, north up"); each clause can name a place,
// layers to show or hide, a visual style, the HUD, a map stack, a camera move,
// radio, the cockpit, the nearest aircraft or something to follow. What is
// left of a clause after those are read is taken as a place.
//
// The result is a plan of steps in the order they should run: the camera
// travels first, so layers and radio load for the new view, and following an
// entity comes last.

import { msg } from '../i18n/index.js';
import { parseCoordinateQuery } from '../search/coordinateParser.js';

/** Visual styles, by the words people use for them. */
const STYLES = [
  [/\bblack[- ]and[- ]white\b|\bnoir\b/, 'noir'],
  [/\b(thermal|flir|heat ?map|infra-?red)\b/, 'thermal'],
  [/\b(night ?vision|nvg|surveillance)\b/, 'surveillance'],
  [/\b(retro|crt)\b/, 'retro'],
  [/\banime\b/, 'anime'],
  [/\b(normal|default|plain) (style|view|look|colou?rs?)\b/, 'normal'],
];

/** Map stacks. */
const STACKS = [
  [/\b(osm|openstreetmap|street map)\b/, 'osm'],
  [/\bbing( aerial)?\b/, 'bing-aerial'],
  [/\b(photo ?real(istic)?|3d tiles)\b/, 'photoreal'],
  [/\b(esri|satellite imagery)\b/, 'esri-imagery'],
];

/**
 * Whole-map clears: "turn off all layers", "hide everything", "remove
 * everything" all clear the layers.
 */
const CLEAR_ALL =
  /^(?:(?:(?:turn|switch) off|hide|clear|remove|disable|kill) (?:everything|(?:all|every)(?: the)?(?: data)?(?: layers?)?)|clear (?:the )?(?:layers|map)|no layers)$/;

/** Camera moves, as globe actions or runner actions. */
const CAMERA = [
  // Whole-map commands come first, so "turn off all layers" is never a place.
  [CLEAR_ALL, { act: 'clear' }],
  [
    /\b(share|copy)( this| the)? (view|link|map|url)\b|^share$/,
    { act: 'share' },
  ],
  [/\breset( the)? (view|camera)\b|\bstart over\b|^home$/, { act: 'reset' }],
  [/\bnorth[- ]?up\b|\bface north\b/, { act: 'northUp' }],
  [/\b(tilt|3d view|perspective)\b/, { act: 'tilt' }],
  [
    /\b(globe view|whole (globe|earth|world)|reset (the )?globe)\b/,
    { name: 'zoom_to_globe', args: {} },
  ],
  [/\bzoom in\b/, { name: 'adjust_camera_zoom', args: { direction: 'in' } }],
  [/\bzoom out\b/, { name: 'adjust_camera_zoom', args: { direction: 'out' } }],
  [
    /\bstop (the )?(camera|orbit|moving|rotating)\b/,
    { name: 'move_camera', args: { motion: 'stop' } },
  ],
  [
    /\borbit\b/,
    {
      name: 'move_camera',
      args: { motion: 'orbit', mode: 'continuous' },
    },
  ],
];

/** Side panels by name, with the rail and rail item that open them. */
const PANEL_NAMES = [
  [
    /data ?layers?( panel)?|layers panel/,
    'left',
    'data-panel',
    msg('Data layers'),
  ],
  [
    /utilities( panel)?|tools panel/,
    'left',
    'utilities-panel',
    msg('Utilities'),
  ],
  [/authoring( panel)?|scenes? panel/, 'left', 'scene-panel', msg('Authoring')],
  [/display( panel)?|visual( panel)?/, 'left', 'pp-toggles', msg('Visual')],
  [/cctv panel|cameras? panel/, 'right', 'cctv-panel', msg('CCTV')],
  [/street ?level panel/, 'right', 'street-level-panel', msg('Street Level')],
  [
    /(space )?missions? panel/,
    'right',
    'space-missions-panel',
    msg('Space Missions'),
  ],
  [/context( panel)?/, 'right', 'global-context-panel', msg('Context')],
];
const CLOSE = /\b(collapse|close|hide|minimi[sz]e|dismiss|shut|fold)\b/;
const OPEN = /\b(open|expand|show|reveal)\b/;

/** Words that may sit around a panel's name without naming anything else. */
const PANEL_FILLER =
  /\b(open|expand|show|reveal|collapse|close|hide|minimi[sz]e|dismiss|shut|fold|please|the|me|my|a|panel|sidebar|tab)\b/g;

/** Whether the clause names this panel and nothing besides it. */
const onlyNames = (clause, pattern) =>
  !tidy(clause.replace(pattern, ' ').replace(PANEL_FILLER, ' '));

/** A clause about side panels, or null. */
function panelStep(clause) {
  // "hide everything" clears the layers, as "remove everything" does.
  if (CLEAR_ALL.test(clause)) return null;
  if (CLOSE.test(clause)) {
    if (
      /\b(all|every|both)\b.*\b(panels?|sidebars?)\b|\b(panels|sidebars)\b/.test(
        clause,
      ) ||
      // "close everything" alone; "hide everything near tokyo" clears.
      (/\beverything\b/.test(clause) && onlyNames(clause, /\beverything\b/))
    )
      return { kind: 'panel', action: 'close', side: 'all' };
    // "hide the left panel", never "hide flights near Left Bank".
    if (/\bleft\b/.test(clause) && onlyNames(clause, /\b(left|side)\b/g))
      return { kind: 'panel', action: 'close', side: 'left' };
    if (/\bright\b/.test(clause) && onlyNames(clause, /\b(right|side)\b/g))
      return { kind: 'panel', action: 'close', side: 'right' };
    for (const [pattern, side, item, name] of PANEL_NAMES)
      if (pattern.test(clause) && /panel/.test(clause))
        return { kind: 'panel', action: 'close', side, item, name };
  }
  // "open data layers" opens the panel; "show earthquake data layer" names
  // a layer, so a name with anything else beside it is not the panel.
  if (OPEN.test(clause))
    for (const [pattern, side, item, name] of PANEL_NAMES)
      if (pattern.test(clause) && onlyNames(clause, pattern))
        return { kind: 'panel', action: 'open', side, item, name };
  return null;
}

/**
 * Whether a line clears the whole map ("hide everything", "clear the map",
 * "hide everything near tokyo"), so layer switches leave it to the plan.
 */
export function isWholeMapClear(text) {
  const line = tidy(String(text || '').toLowerCase());
  const near = line.match(NEAR);
  return (
    CLEAR_ALL.test(line) ||
    Boolean(near && CLEAR_ALL.test(tidy(line.slice(0, near.index))))
  );
}

/** Whether a line is about side panels, so layer switches leave it alone. */
export const isPanelText = (text) =>
  Boolean(
    panelStep(
      String(text || '')
        .toLowerCase()
        .trim(),
    ),
  );

const LAYER_OFF = /^(hide|turn off|switch off|disable|remove|no)\s+/;
const LAYER_ON = /^(show|turn on|switch on|enable|add|display)\s+(me\s+)?/;
// "go to" with the place after it, or alone at the end of the line.
// "goto" counts only with a place after it: "Goto" is a town in Japan.
const GO =
  /^(?:(?:go to|fly to|take me to|zoom to|jump to|head to)(?:\s+|$)|goto\s+)/i;
const FOLLOW = /^(follow|track)\s+(.+)$/;
/**
 * Something that can be followed: a callsign or ICAO address (a word or two
 * with letters and a digit: "ual123", "a12b2e", "UAL 123"), a nine-digit
 * MMSI, or the name of something loaded on the map. "Follow Me Bar", "Track
 * Hill" and "Track 29" are places.
 */
const FOLLOWABLE = /^(?:the\s+)?(?:(?=.*\d)(?=.*\p{L})\S+(?:\s+\S+)?|\d{9})$/u;
/** "nearest plane to heathrow" as well as "near", "in" and the rest. */
const NEAR_TO = /\s*\b(?:near|in|at|around|over|across|above|of|to)\s+(.+)$/;
const NEAR = /\s*\b(?:near|in|at|around|over|across|above|of)\s+(.+)$/;
/** The words of NEAR that place a request somewhere (not "of" or "at"). */
const AROUND = /^\s*(?:near|in|around|over|across|above)\b/;
const FILLER =
  /\b(please|the|a|an|me|on|mode|style|view|look|layer|layers|map|data|live)\b/g;
/**
 * A question's form: a question word followed by an auxiliary or another
 * question word ("what is", "how far", "where's"), or an auxiliary followed
 * by a pronoun or determiner ("is it raining", "can you show"): "Can Tho
 * City" and "Is Kinabalu Park" are places.
 */
const WH_FORM =
  /^(?:what|where|when|who|why|how|which)(?:'s\b|\s+(?:is|are|was|were|do|does|did|can|could|should|would|will|many|much|far|long|to)\b)/i;
const AUX_FORM =
  /^(?:is|are|was|were|do|does|did|can|could|should|would|will)\s+(?:it|there|you|i|we|they|he|she|the|a|an|this|that|my|your|our|any)\b/i;

/**
 * Whether a line is a real question, which Ask GEV may answer on Enter (a
 * billed call):
 *   - one ending with "?" that has a question form or two non-Latin words
 *     with a word of two letters or more, or five Han, Kana or Hangul characters;
 *   - without "?", only a question word's form ("what is here", "how far is
 *     paris") with a word about something after it, and not written as a
 *     name ("Where Is My Mind").
 * An auxiliary's form without "?" is never one: "Can You Imagine", "Do it
 * Best Hardware" and "Is This It" are names. A line with a comma and no "?"
 * is a place ("Why, Arizona"). Read the line after normalizeLine, in its own
 * letter case.
 * @param {string} text
 */
/** Greetings shaped like questions ("what's up", "how's it going"). */
const SMALL_TALK =
  /^(?:what'?s\s+(?:up|new|good|happening|going on|cooking)|how'?s\s+(?:it going|everything|life|things|your day)|how are (?:you|things)|what are you (?:up to|doing))\b/i;

export function isRealQuestion(text) {
  // Full-width and Arabic question marks read as "?".
  const line = String(text || '')
    .trim()
    .replace(/[？؟]/g, '?');
  if (SMALL_TALK.test(line)) return false;
  const words = line.replace(/\?+$/, '').split(/\s+/).filter(Boolean);
  if (line.endsWith('?'))
    // A name with "?" ("New York?", "Truth or Consequences?", "東京都？") is
    // offered to GEV, not sent: a question's form, or five Han, Kana or
    // Hangul characters written without spaces, or two words in other
    // non-Latin scripts.
    return (
      ((WH_FORM.test(line) ||
        AUX_FORM.test(line) ||
        // Question words in other scripts are not read: two words do.
        (words.length >= 2 && !/\p{Script=Latin}/u.test(line))) &&
        words.some((word) => (word.match(/\p{L}/gu) || []).length >= 2)) ||
      (
        line.match(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
        ) || []
      ).length >= 5
    );
  if (line.includes(',')) return false;
  // The form alone is too little ("how to", "who is it"): a word about
  // something must follow ("what is here").
  return (
    WH_FORM.test(line) &&
    words.some(
      (word) => !FORM_WORDS.has(word.toLowerCase().replace(/'s$/, '')),
    ) &&
    !writtenAsName(words)
  );
}
/** Three words or more, each with a capital first letter: a title or a name. */
export const writtenAsName = (words) =>
  words.length >= 3 &&
  words.every((word) => !/\p{L}/u.test(word) || /^\p{Lu}/u.test(word));
/**
 * An auxiliary's question without "?" ("can you show me", "is it raining
 * in tokyo"): Ask GEV is offered first but never runs on Enter. Written with
 * a capital after its first two words it is a name ("Can You Imagine", "Do
 * it Best Hardware"), and the form alone ("Is there", "Can I") says nothing.
 */
function isUnmarkedQuestion(text) {
  const line = String(text || '').trim();
  const words = line.split(/\s+/).filter(Boolean);
  return (
    AUX_FORM.test(line) &&
    !line.includes(',') &&
    words.some((word) => !FORM_WORDS.has(word.toLowerCase())) &&
    !words.slice(2).some((word) => /^\p{Lu}/u.test(word))
  );
}
/** The words a question's form is made of, which say nothing on their own. */
const FORM_WORDS = new Set(
  'what where when who why how which is are was were do does did can could should would will many much far long to it there you i we they he she the a an this that my your our any'.split(
    ' ',
  ),
);

/**
 * A typed line as the Omnibar reads it, the one normalisation every reader
 * shares: compatibility forms folded (full-width letters and "？"), curly
 * apostrophes and quotes made straight, spaces collapsed, a "please" before
 * or after the request dropped, and a closing full stop or "!" dropped (not
 * an initial's: "Washington D.C."). Letter case is kept.
 * @param {string} text
 */
export function normalizeLine(text, { isRequest = isPlainRequest } = {}) {
  let line = String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/؟/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
  const end = /(?<!(?:^|[\s.])\p{L})[.!。]+$/u;
  line = line.replace(end, '');
  // A verb typed twice ("hide hide everything") is one.
  line = line.replace(
    /^((?:turn|switch) (?:on|off)|show|hide|remove|enable|disable|clear|go to|fly to)\s+\1\b/i,
    '$1',
  );
  // "please" is dropped only around a request: "Please Touch Museum",
  // "Kindly Lane" and "Pretty Please" are names.
  const polite = line
    .replace(/^(?:please|pls|plz|kindly)\b[,!]?\s+(?=\S)/i, '')
    .replace(/(?:\s*,\s*|\s+)(?:please|pls|plz)$/i, '')
    .replace(end, '')
    .trim();
  const read = polite !== line && polite && isRequest(polite) ? polite : line;
  // "remove flights from the map", "clear everything except ships from the
  // map": the map is where every layer is taken from. Not the verb's own
  // "off" ("turn off the screen" is no layer switch), not after "show"
  // ("show me the view from the map" is a question), and after "clear"
  // only for the whole map ("clear all flights" would read as a place).
  const bare = read.replace(
    /^((?:turn|switch) off|hide|remove|disable|clear)\s+(\S.*?)\s+(?:from|off) (?:the )?(?:map|globe|screen|view)$/i,
    '$1 $2',
  );
  if (bare === read || !/^clear\b/i.test(bare)) return bare;
  // "clear" takes the whole map: "clear flights" would read as a place.
  const lower = bare.toLowerCase();
  return CLEAR_ALL.test(lower) ||
    /^clear (?:everything|all(?: the)?(?: other)?(?: layers?)?|every layer) (?:except|but|other than|apart from|besides|save for)\b/.test(
      lower,
    )
    ? bare
    : read;
}

/** A request by its own words: a verb starting it, or a real question. */
const isPlainRequest = (text) => hasActionVerb(text) || isRealQuestion(text);

/**
 * Whether a clause starts with an action verb, in any letter case: the one
 * test the parser and the Enter rule share.
 */
export function hasActionVerb(text) {
  return ACTION_VERB.test(tidy(String(text || '').toLowerCase()));
}

/**
 * The verbs that make a clause a request, the one list for the parser and
 * for what Enter may run (src/ui/omnibarEnter.js). A verb counts where the
 * clause starts ("show flights", "turn radio on"; "radio off" ends one), so
 * a place named after it never does ("radio near Clear Lake", "radio in
 * Show Low"). Words that also start names count only alone or before what
 * they act on: "clear the map", "zoom in", "tilt", "orbit", "stop the
 * radio", not "Clear Lake", "Zoom Hill", "Tilt Cove" or "Stop, Arkansas".
 * A keyword in a clause without a verb may be part of a name, and a verb
 * ends at a space or the line's end ("Hide-A-Way Lake" names a lake).
 */
export const ACTION_VERB =
  /^(?:please\s+|now\s+|also\s+)?(?:show|hide|turn|switch|toggle|enable|disable|add|remove|display(?=\s+\S)|play|start|close|open|enter|listen|tune|mute|unmute|follow|track|draw|measure|share|copy|reset|kill(?=\s+(?:the\s+)?(?:radio|music|sound)\b)|silence|pause|face(?=\s+(?:north|south|east|west)\b)|go to|fly to|take me to|head to|jump to|goto|(?:find |select )?nearest|zoom(?=$|\s+(?:in|out|to)\b)|tilt(?=$|\s+(?:the\s+)?(?:camera|view|map|up|down)\b)|orbit(?=$|\s+(?:the\s+)?(?:camera|view|map|it|here|around)\b)|stop(?=$|\s+(?:the\s+)?(?:radio|camera|orbit|orbiting|moving|rotating|music|following)\b)|clear(?=$|\s+(?:the\s+)?(?:map|layers?|everything|all|it)\b))(?=\s|$)|^\S+\s+(?:on|off)$/;
/**
 * The cockpit only with a verb, and only as the end of its clause ("enter
 * the cockpit", "open cockpit view"): "Cockpit Country" is a place.
 */
const COCKPIT =
  /\b(?:enter|open|go into|get in(?:to)?|switch to|show)\s+(?:the\s+)?cockpit(?:\s+(?:view|mode))?$/;
/**
 * The radio only with a verb that applies to it: "play radio in Kill Devil
 * Hills" turns it on, "Radio City Music Hall" is a place.
 */
const RADIO_ON =
  /\b(?:(?:turn|switch) on|play|listen to|tune in(?: to)?|open|start|put on|enable|unmute)\s+(?:the\s+)?radio(?:\s+stations?)?\b|\b(?:turn|switch)\s+(?:the\s+)?radio\s+on\b|\bradio\s+on\b/;
const RADIO_OFF =
  /\b(?:(?:turn|switch) off|stop|mute|disable|silence|pause|kill)\s+(?:the\s+)?radio\b|\b(?:turn|switch)\s+(?:the\s+)?radio\s+off\b|\bradio\s+off\b/;
/** Lines this long are not split into a layer and a place word by word. */
const MAX_PAIR_WORDS = 6;
/**
 * A place's name has six words at most; an address with a number in it
 * ("1600 Pennsylvania Ave NW Washington DC 20500") ten.
 */
export const placeWordLimit = (text) => (/\d/.test(text) ? 10 : 6);
/** Lines longer than this that ask for nothing outright are sentences. */
const MAX_SENTENCE_WORDS = 8;
/** A clause that is only a switch verb, once what it switched is read. */
const SWITCH_ONLY =
  /^(?:(?:turn|switch) (?:on|off)|show|hide|enable|disable|remove|add|display|no)?$/;
/** Words beside a layer that say more about it, never a place. */
const NOT_A_PLACE =
  /^(?:stations?|feeds?|data|layers?|live|now|here|map|overlay|tracker|tracking|updates?|info|status|positions?|activity|today|tonight)$/;
/** A camera move turned off: orbiting stops; clearing stays a clear. */
const cameraOff = (move) =>
  move.act === 'clear'
    ? move
    : move.name === 'move_camera' && move.args.motion === 'orbit'
      ? { name: 'move_camera', args: { motion: 'stop' } }
      : null;
/**
 * The end of a "go to" clause that is a request, not part of the name: "in
 * noir", "with flights", "at night vision", "show flights".
 */
const GO_TAIL =
  /^(.+?)\s+(?:(?:in|with|at)\s+|(show|hide|turn on|turn off|switch on|switch off|enable|disable)\s+)(.+)$/;

/** Clause separators; "black and white" is joined first so it survives. */
const SEPARATORS =
  /(\s*(?:,|;(?!\s*[-+]?\d)|\+(?!\d)|&|\band then\b|\bthen\b|\band\b|\balso\b)\s*)/;

/**
 * Places whose own name holds "and" (or "&"), kept whole after "near" or
 * "in" instead of read as two places: "flights near Trinidad and Tobago".
 */
const COMPOUND_PLACES = new Set([
  'trinidad and tobago',
  'antigua and barbuda',
  'bosnia and herzegovina',
  'saint kitts and nevis',
  'st kitts and nevis',
  'st. kitts and nevis',
  'saint vincent and the grenadines',
  'st vincent and the grenadines',
  'st. vincent and the grenadines',
  'sao tome and principe',
  'são tomé and príncipe',
  'turks and caicos',
  'turks and caicos islands',
  'wallis and futuna',
  'saint pierre and miquelon',
  'heard island and mcdonald islands',
  'svalbard and jan mayen',
  'south georgia and the south sandwich islands',
  'newfoundland and labrador',
  'jammu and kashmir',
  'andaman and nicobar islands',
  'dadra and nagar haveli',
  'brighton and hove',
]);
/**
 * The joining words of a compound place ("and", or "and the" when "the" was
 * read off the second part: "Saint Vincent and the Grenadines"), or null.
 */
const compoundJoin = (first, second) =>
  COMPOUND_PLACES.has(`${first} and ${second}`.toLowerCase())
    ? ' and '
    : COMPOUND_PLACES.has(`${first} and the ${second}`.toLowerCase())
      ? ' and the '
      : null;

/**
 * Lower case one character at a time, so the line keeps its length and
 * "İstanbul" reads "istanbul" (not "i̇stanbul" with a combining dot).
 */
function lowerEach(text) {
  return Array.from(text, (char) =>
    char === 'İ' ? 'i' : char.toLowerCase().normalize('NFC'),
  ).join('');
}

/**
 * A place as it was typed: "İstanbul", "iPhone store", "McAllen" are kept,
 * where the line read them in lower case. A place the line put together
 * ("Trinidad and Tobago" from "Trinidad & Tobago") stays as read.
 */
export function asTypedIn(raw, place) {
  const lowered = lowerEach(raw).replace(/\s+/g, ' ');
  const spaced = raw.replace(/\s+/g, ' ');
  if (lowered.length !== spaced.length) return place;
  const at = lowered.indexOf(place);
  if (at < 0) return place;
  const before = lowered[at - 1];
  const after = lowered[at + place.length];
  if (/[\p{L}\p{N}]/u.test(before || '') || /[\p{L}\p{N}]/u.test(after || ''))
    return place;
  return spaced.slice(at, at + place.length);
}

function tidy(text) {
  return text.replace(/\s+/g, ' ').trim();
}
/** A place without the joining words a removed phrase left at its edges. */
const placeName = (text) => {
  const name = tidy(text)
    .replace(/^((in|at|near|over|on|of|to|with|and|the)\s+)+/, '')
    .replace(/(\s+(in|at|near|over|on|of|to|with|and|the))+$/, '')
    .trim();
  // A joining word left on its own ("flights in") names no place.
  return JOINING.test(name) ? '' : name;
};
const JOINING = /^(in|at|near|over|on|of|to|with|and|the)$/;

/**
 * Take the first pattern that matches out of the clause.
 * @returns {{value: *, rest: string}|null}
 */
function takeFirst(clause, table) {
  for (const [pattern, value] of table) {
    const match = clause.match(pattern);
    // A whole word only, in any script: "bing" is no part of "Bingöl".
    const before = match && clause[match.index - 1];
    const after = match && clause[match.index + match[0].length];
    if (match && (/\p{L}/u.test(before || '') || /\p{L}/u.test(after || '')))
      continue;
    if (match)
      return {
        value,
        rest: tidy(clause.replace(match[0], ' ')),
        text: match[0],
      };
  }
  return null;
}

/**
 * Read one line into a plan.
 * @param {string} text What was typed.
 * @param {(term: string) => Array<{id: string, shown: string, enabled: boolean, score: number}>} matchLayers
 * @returns {{steps: Array<object>, question: boolean}}
 */
export function parseOmnibar(
  text,
  matchLayers,
  { isEntity = () => false } = {},
) {
  const raw = String(text || '').trim();
  const line = tidy(lowerEach(raw)).replace(
    /\b(black[- ]and[- ]white|b ?& ?w)\b/g,
    'noir',
  );
  // `asks`: a real question, which Ask GEV may answer by default. Small talk
  // ("hi", "help") also goes to GEV, but only when picked.
  // A comma line without "?" is a place ("Why, Arizona"), not a question.
  // Only a real question is read as one; any other line ("why", "help",
  // "what cheer", "List") may still be a place, with Ask GEV offered after.
  const asks = isRealQuestion(raw);
  // A line ending in "?" is for GEV even when too short to ask by default.
  const question = asks || /[?？؟]$/.test(line) || isUnmarkedQuestion(raw);
  if (!line || question) return { steps: [], question, asks, asked: new Set() };

  const steps = [];
  // The steps whose own clause asked for them with a verb, and the clause
  // each step came from.
  const asked = new Set();
  const clauseOf = new Map();
  // The clauses with a name left beside their keywords.
  const placeClauses = new Set();
  let place = null;

  const clauses = line.split(SEPARATORS);
  // Keyword steps read from a clause without a verb, and whether the place
  // is what was left beside them: together they make the line ambiguous.
  const bareSteps = new Set();
  let placeBare = false;
  // Further places joined with "and" ("near New York and Paris"): the plan
  // goes to the first, and the rest are offered on their own.
  const extraPlaces = [];
  let previousHadPlace = false;
  let previousBarePlace = false;
  // Whether the clause before was a further place ("near Paris and
  // Trinidad"), which a compound name may go on ("and Tobago").
  let previousExtraPlace = false;
  let previousGo = false;
  // Whether a request was peeled off a "go to" clause, and how the place
  // was named: after "go to", after "near"/"in", or bare.
  let goPeeled = false;
  let placeFrom = null;
  /** A whole clause that is one style, map, camera move or layer, or null. */
  const requestIn = (text) => {
    const words = tidy(text.replace(/\b(mode|style|view|look)\b/g, ' '));
    for (const table of [STYLES, STACKS, CAMERA]) {
      const found = takeFirst(words, table);
      if (found && !found.rest) {
        if (table === STYLES) return { kind: 'style', style: found.value };
        if (table === STACKS) return { kind: 'stack', stack: found.value };
        return { kind: 'camera', ...found.value };
      }
    }
    return layerRequest(words);
  };
  /** A layer named in full, switched on unless the verb says off. */
  const layerRequest = (text, verb = '') => {
    const [layer] = matchLayers(tidy(text.replace(FILLER, ' ')));
    if (!named(layer)) return null;
    return {
      kind: 'layer',
      layer,
      enabled: !/^(hide|turn off|switch off|disable)$/.test(verb),
    };
  };
  let previousLayerEnabled = null;
  // Whether a clause was read whole as a switch that has no step ("osm
  // off"): the line is then no place either.
  let consumed = false;
  for (let i = 0; i < clauses.length; i += 2) {
    let clause = tidy(clauses[i]);
    const separator = clauses[i - 1]?.trim();
    const afterPlace = previousHadPlace;
    const afterPlaceComma = previousHadPlace && separator === ',';
    // "trinidad and tobago": a bare place joined to a bare place by "and".
    const afterBarePlaceAnd = previousBarePlace && separator === 'and';
    const afterExtraPlace = previousExtraPlace;
    previousExtraPlace = false;
    const continuedLayer = previousLayerEnabled;
    const afterGo = previousGo;
    previousGo = false;
    previousHadPlace = false;
    previousBarePlace = false;
    previousLayerEnabled = null;
    if (!clause) continue;
    // "noir off", "flights on", "orbit off": a switch after what it switches
    // reads as one before it ("turn off noir"), so "off" is never a place.
    const switchAfter = clause.match(/^(.+?)\s+(on|off)$/);
    if (
      switchAfter &&
      !/\b(?:radio|hud)\b/.test(switchAfter[1]) &&
      requestIn(switchAfter[1])
    )
      clause = `turn ${switchAfter[2]} ${switchAfter[1]}`;
    // Steps of a clause that has a verb are asked for; so are those joined
    // to a "go to" clause by "and" or "then" ("go to Paris and noir").
    const clauseVerb =
      ACTION_VERB.test(clause) ||
      (afterGo && /^(and|then|and then)$/.test(separator || ''));
    // `wanted`: whether this step's own clause asked for it; a layer is
    // asked for only by a switch right before its word (see below).
    const add = (step, wanted = clauseVerb) => {
      const key = JSON.stringify(step);
      let kept = steps.find((existing) => JSON.stringify(existing) === key);
      if (!kept) steps.push((kept = step));
      if (!clauseOf.has(kept)) clauseOf.set(kept, i);
      if (wanted && step.kind !== 'place') asked.add(kept);
      return kept;
    };
    const addBare = (step, wanted = clauseVerb) => {
      const kept = add(step, wanted);
      if (!wanted) bareSteps.add(kept);
    };
    // `leftover`: a name left beside the clause's keywords ("Show Low
    // noir"), not one named after near or in ("turn on radio in tokyo").
    const addPlace = (value, { bare = false, leftover = false } = {}) => {
      if (!value) return;
      if (leftover) placeClauses.add(i);
      // "near Trinidad and Tobago", "in Bosnia & Herzegovina": one place.
      const joinsName =
        place &&
        afterPlace &&
        (separator === 'and' || separator === '&') &&
        compoundJoin(place.split(', ').at(-1), value);
      if (joinsName) {
        // The name is whole: a further "and" names another place ("near
        // Trinidad and Tobago and Barbados").
        place += `${joinsName}${value}`;
        previousHadPlace = true;
        previousBarePlace = false;
        return;
      }
      // "near Paris and Trinidad and Tobago": the further place is whole too.
      const joinsExtra =
        afterExtraPlace &&
        (separator === 'and' || separator === '&') &&
        compoundJoin(extraPlaces.at(-1), value);
      if (joinsExtra) {
        extraPlaces[extraPlaces.length - 1] += `${joinsExtra}${value}`;
        return;
      }
      if (place && bare && afterBarePlaceAnd) place += ` and ${value}`;
      else if (place && !afterPlaceComma) {
        if (separator === 'and') {
          extraPlaces.push(value);
          previousExtraPlace = true;
        }
        return;
      } else if (!place) {
        place = value;
        placeBare = bare;
      } else place += `, ${value}`;
      previousHadPlace = true;
      previousBarePlace = bare;
    };
    // "go to Thermal, California", "fly to Tilt Cove": the rest of a "go to"
    // clause is the place, read before any keyword in it, and so is a part
    // after a comma that has no verb of its own.
    // A request that ends the clause is peeled off it ("go to tokyo in
    // noir", "go to London with flights", "go to tokyo show flights", "go
    // to tokyo, north up"); the line is then ambiguous, so the place row
    // still comes first. Names that merely hold a keyword stay whole.
    const go = clause.match(GO);
    const tailStep =
      afterGo && separator === ',' && !clauseVerb ? requestIn(clause) : null;
    if (tailStep) {
      add(tailStep);
      goPeeled = true;
      previousGo = true;
      continue;
    }
    if (go || (afterGo && separator === ',' && !clauseVerb)) {
      let value = go ? clause.slice(go[0].length) : clause;
      const peel = go && value.match(GO_TAIL);
      const peeled =
        peel && (peel[2] ? layerRequest(peel[3], peel[2]) : requestIn(peel[3]));
      if (peeled) {
        value = peel[1];
        add(peeled);
        goPeeled = true;
      }
      value = placeName(value);
      if (go) addPlace(value, { bare: true });
      else if (value) place += `, ${value}`;
      if (go && value) placeFrom = 'go';
      previousHadPlace = true;
      previousBarePlace = true;
      previousGo = true;
      continue;
    }
    // "hide everything near tokyo": a whole-map clear with a place after it.
    const clearNear = clause.match(NEAR);
    if (clearNear && CLEAR_ALL.test(tidy(clause.slice(0, clearNear.index)))) {
      add({ kind: 'camera', act: 'clear' });
      addPlace(placeName(clearNear[1]));
      placeFrom ??= 'near';
      continue;
    }
    const panel = panelStep(clause);
    if (panel) {
      add(panel);
      continue;
    }
    const follow = clause.match(FOLLOW);
    if (follow) {
      // "track flights near austin" shows a layer there; "follow AAL123"
      // follows a craft, and "track it over texas" still goes to Texas.
      const where = follow[2].match(NEAR);
      const target = where ? tidy(follow[2].slice(0, where.index)) : follow[2];
      const [layer] = matchLayers(target.replace(FILLER, ' ').trim());
      if (named(layer)) {
        add({ kind: 'layer', layer, enabled: true });
        previousLayerEnabled = true;
        if (where) addPlace(placeName(where[1]));
        continue;
      }
      if (FOLLOWABLE.test(target) || isEntity(target.replace(/^the\s+/, ''))) {
        if (where) addPlace(placeName(where[1]));
        add({ kind: 'follow', query: target.replace(/^the\s+/, '') });
        continue;
      }
      // Not something to follow: read on, as a place.
    }
    // "nearest plane", alone or with a place: "Nearest Plane Crash Site" is
    // a name.
    if (
      /\b(nearest|closest) (plane|aircraft|flight|jet)s?(?:$|\s+(?:to|near|in|at|around|over)\b)/.test(
        clause,
      )
    ) {
      const where = clause.match(NEAR_TO);
      if (where) addPlace(placeName(where[1]));
      add({ kind: 'nearest' });
      continue;
    }

    // "turn off noir" goes back to the normal style, "turn off orbit"
    // stops the camera; a map or a camera move has nothing to turn off.
    const switchOff = LAYER_OFF.test(clause);
    let took = false;
    const style = takeFirst(clause, STYLES);
    if (style) {
      addBare({ kind: 'style', style: switchOff ? 'normal' : style.value });
      clause = style.rest;
      took = true;
    }
    const stack = takeFirst(clause, STACKS);
    if (stack) {
      if (!switchOff) addBare({ kind: 'stack', stack: stack.value });
      clause = stack.rest;
      took = true;
    }
    const camera = takeFirst(clause, CAMERA);
    if (camera) {
      const move = switchOff ? cameraOff(camera.value) : camera.value;
      if (move) addBare({ kind: 'camera', ...move });
      clause = camera.rest;
      took = true;
    }
    const hud = clause.match(
      /\b(hide|show|turn off|turn on)?\s*hud\s*(on|off)?\b/,
    );
    if (hud) {
      const off = /hide|off/.test(hud[0]) || switchOff;
      addBare({ kind: 'hud', visible: off ? 'off' : 'on' });
      clause = tidy(clause.replace(hud[0], ' '));
      took = true;
    }
    // The switch verb is all that is left beside what it switched.
    if (took && SWITCH_ONLY.test(clause)) {
      consumed = true;
      continue;
    }
    const cockpit = clause.match(COCKPIT);
    if (cockpit) {
      add({ kind: 'cockpit' });
      clause = tidy(clause.replace(cockpit[0], ' '));
    }
    const radioOff = clause.match(RADIO_OFF);
    const radio = radioOff || clause.match(RADIO_ON);
    if (radio) {
      // "turn off the radio", "stop the radio", "mute radio": radio off. The
      // verbs are never a place.
      const disable = Boolean(radioOff);
      const rest = tidy(clause.replace(radio[0], ' '));
      const where = rest.match(NEAR);
      // "play radio in tokyo", or the place left beside it: "play radio tokyo".
      const beside = tidy(rest.replace(FILLER, ' '));
      if (where) addPlace(placeName(where[1]));
      else if (beside && !disable) addPlace(placeName(beside));
      add({ kind: 'radio', action: disable ? 'disable' : 'enable' });
      continue;
    }

    // Layers: "hide flights", "cctv near austin", "earthquakes".
    const off = clause.match(LAYER_OFF);
    const on = LAYER_ON.test(clause);
    let body = clause.replace(LAYER_OFF, '').replace(LAYER_ON, '');
    body = tidy(body.replace(GO, ''));
    const where = body.match(NEAR);
    const what = (where ? tidy(body.slice(0, where.index)) : body).replace(
      /(\s+(in|at|on|with|of|near|to))+$/,
      '',
    );
    const subject = tidy(
      what.replace(/^(?:all|every)\s+/, '').replace(FILLER, ' '),
    );
    const layers = subject ? matchLayers(subject) : [];
    const enabled = off ? false : on ? true : (continuedLayer ?? true);
    // A whole layer name: "rock" begins "rockets" but names no layer.
    if (named(layers[0])) {
      // Without a switch right before it a layer word may be a place's name
      // ("Hurricane, Utah", "Kill Devil Hills" is no "kill").
      addBare({ kind: 'layer', layer: layers[0], enabled }, Boolean(off || on));
      previousLayerEnabled = enabled;
      if (where) {
        addPlace(placeName(where[1]));
        // "of" and "at" may join the words of a name ("Planes of Fame Air
        // Museum", "Boats at Sea"); near, in, around, over, across and above
        // place a request ("flights near Tokyo", "flights over Texas").
        placeFrom ??= AROUND.test(where[0]) ? 'near' : 'of';
      }
      continue;
    }
    // A layer and a place side by side, without "in": "tokyo traffic",
    // "earthquakes japan". The place is whichever side is not the layer.
    if (
      !where &&
      subject.includes(' ') &&
      subject.split(' ').length <= MAX_PAIR_WORDS
    ) {
      const words = subject.split(' ');
      let pair = null;
      // Only a whole layer name or synonym counts here.
      for (let cut = 1; cut < words.length && !pair; cut++) {
        const head = words.slice(0, cut).join(' ');
        const tail = words.slice(cut).join(' ');
        const [tailLayer] = matchLayers(tail);
        const [headLayer] = matchLayers(head);
        if (named(tailLayer))
          pair = { layer: tailLayer, place: head, layerFirst: false };
        else if (named(headLayer))
          pair = { layer: headLayer, place: tail, layerFirst: true };
      }
      // "show radio stations", "flights here": a word about the layer, not
      // a place.
      if (pair && (off || on) && NOT_A_PLACE.test(pair.place)) {
        addBare(
          { kind: 'layer', layer: pair.layer, enabled },
          Boolean(off || on) && pair.layerFirst,
        );
        previousLayerEnabled = enabled;
        continue;
      }
      if (pair) {
        // Asked for only when the switch comes right before the layer word
        // ("show traffic tokyo"); "show low radio" names Show Low.
        addBare(
          { kind: 'layer', layer: pair.layer, enabled },
          Boolean(off || on) && pair.layerFirst,
        );
        previousLayerEnabled = enabled;
        addPlace(placeName(pair.place), { bare: true, leftover: true });
        continue;
      }
    }
    if (where && subject === '') addPlace(placeName(where[1]));
    else if (tidy(body.replace(FILLER, ' '))) {
      const before = place;
      addPlace(placeName(body), { bare: !off && !on, leftover: true });
      // Left over after a switch that switched nothing ("Show Low noir").
      if (!before && place && (off || on)) placeFrom ??= 'verb';
    }
  }

  // A verb with a name left beside its keywords asks for nothing but a layer
  // switched right after it: "Show Low noir", "Start Point noir" and "Track
  // Hill noir" name places, they do not ask for noir.
  for (const [step, index] of clauseOf) {
    if (step.kind === 'layer' || !asked.has(step)) continue;
    if (!ACTION_VERB.test(tidy(clauses[index] || ''))) continue;
    // "show noir" alone asks for noir; only a name left beside the switch
    // ("Show Low noir") makes it a place.
    if (!placeClauses.has(index)) continue;
    const layerAsked = [...clauseOf].some(
      ([other, at]) =>
        at === index && other.kind === 'layer' && asked.has(other),
    );
    if (!layerAsked) {
      asked.delete(step);
      bareSteps.add(step);
    }
  }
  // A standalone place retains the user's spelling and punctuation. A comma
  // before a real command still separates actions in a combined plan.
  if (!steps.length && !consumed) place = raw.replace(GO, '');
  // A place is a name of six words at most: anything longer is a sentence
  // (pasted text, a remark), which names no place. With nothing asked for
  // beside it, the line is for GEV only and Enter runs nothing.
  // A long name dropped beside keywords nobody asked for ("San Jose, Santa
  // Clara County, California, USA flights") makes the line a sentence too.
  let droppedPlace = false;
  if (place && place.split(/\s+/).length > placeWordLimit(place)) {
    place = null;
    droppedPlace = true;
  }
  const sentence =
    (!place && !steps.length) ||
    (droppedPlace && steps.every((step) => !asked.has(step))) ||
    (line.split(' ').length > MAX_SENTENCE_WORDS &&
      !(place && /\d/.test(place) && !steps.length) &&
      placeFrom !== 'go' &&
      steps.every((step) => !asked.has(step)));
  if (sentence)
    return {
      steps: [],
      question: false,
      asks: false,
      sentence: true,
      asked: new Set(),
      clauseOf: new Map(),
      extraPlaces: [],
    };
  // One keyword without a verb beside what is left of the line ("Thermal,
  // California", "Tilt Cove", "tokyo traffic") may be a place's own name:
  // the whole line is offered as a place ahead of the plan.
  const joined = /\b(and|then|also)\b|[;+&]/.test(line);
  const ambiguous =
    (Boolean(place) && goPeeled) ||
    (Boolean(place) &&
      placeBare &&
      steps.length === 1 &&
      bareSteps.has(steps[0]) &&
      !joined) ||
    // A switch that switched nothing and a keyword nobody asked for, beside
    // what is left: "Show Low noir", "Show Low radio" name Show Low.
    (Boolean(place) &&
      placeFrom === 'verb' &&
      steps.length > 0 &&
      steps.every((step) => !asked.has(step)) &&
      !joined) ||
    // Keywords nobody asked for beside the rest of a name, joined or not:
    // "Storm Lake and Spencer", "Thermal and Indio" may be one place, so the
    // whole line is offered first.
    (Boolean(place) &&
      placeFrom !== 'near' &&
      steps.length > 0 &&
      steps.every((step) => !asked.has(step)));
  // Several keywords and nothing asked for ("Fire and Rain", "Noir and
  // Thermal"): no plan runs on Enter; the line may still be a name.
  const unasked = steps.length > 0 && steps.every((step) => !asked.has(step));
  if (place && !placeFrom) placeFrom = placeBare ? 'bare' : 'near';
  if (place) {
    // A grid reference is read only as typed ("14R PU 2090 4906"; in lower
    // case it may be words), so the plan keeps it so.
    const typed = asTypedIn(raw, place);
    if (!parseCoordinateQuery(place) && parseCoordinateQuery(typed))
      place = typed;
    const step = { kind: 'place', place };
    // How the place was typed, for its label only ("İstanbul", "iPhone
    // store"); kept off the step's fields, which plans compare.
    Object.defineProperty(step, 'shown', { value: asTypedIn(raw, place) });
    steps.unshift(step);
  }
  steps.verb = LAYER_OFF.test(line) || LAYER_ON.test(line) || GO.test(line);
  // Following happens once the camera has settled on the new view.
  steps.sort((a, b) => (a.kind === 'follow') - (b.kind === 'follow'));
  return {
    steps,
    question,
    asks,
    ambiguous,
    unasked,
    extraPlaces,
    placeFrom,
    peeled: goPeeled,
    asked,
    clauseOf,
  };
}

/** A layer match that names the whole layer, not the start of its name. */
function named(layer) {
  return layer?.score >= 2 && layer.exact !== false;
}

/** "above M5", "m4.5+", "magnitude 6": a magnitude floor in a line. */
const MAGNITUDE =
  /\b(?:above|over|at least|greater than|>=?)?\s*m(?:ag(?:nitude)?)?\s*(\d+(?:\.\d+)?)\s*\+?(?=\s|$)/i;
/** Layers whose items have a magnitude. */
const MAGNITUDE_LAYERS = /^(earthquakes?|quakes?)$|earthquake/;

/**
 * A count request's text without its magnitude floor, and the floor. Only an
 * earthquake layer reads one: "flights over m25" keeps its words.
 * @returns {{text: string, minMagnitude: ?number}}
 */
export function magnitudeFloor(text, matchLayers) {
  const raw = String(text || '').trim();
  const match = raw.match(MAGNITUDE);
  if (!match) return { text: raw, minMagnitude: null };
  const plain = tidy(raw.replace(match[0], ' '));
  const layer = parseOmnibar(plain, matchLayers).steps.find(
    (step) => step.kind === 'layer',
  )?.layer;
  return layer && MAGNITUDE_LAYERS.test(String(layer.id))
    ? { text: plain, minMagnitude: Number(match[1]) }
    : { text: raw, minMagnitude: null };
}
