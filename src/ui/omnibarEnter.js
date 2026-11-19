// What Enter does in the Omnibar before a row is chosen with the keyboard:
// the one rule, in one place. The rows come from src/ui/omnibarRows.js; the
// text this rule reads is the line after readLine (omnibarRows.js).
//
// Enter performs an action (a plan, a layer switch, a command, Ask GEV) only
// when the line asks for it outright:
//   (a) the action's own clause starts with a verb from ACTION_VERB (one
//       list, in omnibarIntent.js): "show flights", "play radio in Tokyo",
//       "go to Austin and show flights". A verb inside a place's name asks
//       for nothing ("radio near Clear Lake");
//   (b) or the line is a command's exact label, alone or after ">" ("North
//       up", "> Clear all layers"); a command row runs on nothing else;
//   (c) or, for Ask GEV, it is a real question (isRealQuestion).
// A whole layer name with a place after near, in, around, over, across or
// above ("flights near Tokyo"; not "of" or "at": "Planes of Fame") asks
// outright too. Keywords without a verb ask for nothing, however many
// clauses they fill ("Fire and Rain", "noir and cctv near austin"). Otherwise
// the place row is the default, and any plan or command is offered after
// it. A guide found by forgiving a typo, or on a line written as a title
// ("How To Train Your Dragon"), is offered, never run. Some actions need
// more:
//   - sound (the Radio layer and radio steps), clearing the map, closing
//     panels and the cockpit need (a) or (b);
//   - the microphone, sharing the view, resetting it and the globe view
//     need (b);
//   - a layer row runs only when the line names that layer before any
//     other (the row's `best`): "show flights" with Flights already on
//     offers Flights, never Military Flights.
// Only the first row can be the default, and the pointer never makes one:
// a hovered row is chosen by a click, and the arrow keys choose any row.

import { hasActionVerb, isRealQuestion } from './omnibarIntent.js';

/**
 * Words that are both the name of a bundled place (wikidata_cities or
 * wikidata_places) and, alone, a command, style or layer word. Typed alone
 * they search the place first and offer the switch second. Found by sweeping
 * every bundled name through the Omnibar (see docs/CURRENT-STATE.md); a test
 * checks each is still a bundled name.
 */
export const PLACE_WORDS = new Set([
  'bike',
  'hurricane',
  'normal',
  'rain',
  'ski',
  'street',
  'thermal',
]);

/** Whether the whole line is one of PLACE_WORDS, in any case. */
export function isPlaceWord(text) {
  return PLACE_WORDS.has(
    String(text || '')
      .trim()
      .toLowerCase(),
  );
}

/** Layers whose switching on starts sound. */
export const SOUND_LAYERS = new Set(['radio']);
/** Camera moves that only their exact label asks for (b). */
const NAMED_ONLY = new Set(['share', 'reset', 'zoom_to_globe']);

/**
 * Whether a plan's steps ask for themselves. Verbs are read per clause: the
 * parser marks each step whose own clause had one (`parsed.asked`), so a verb
 * inside a place's name ("radio near Clear Lake") asks for nothing.
 * @param {Array<object>} steps
 * @param {{named: boolean, parsed: object}} line
 */
function planAsked(steps, { named, parsed }) {
  if (named) return true;
  const asked = parsed?.asked || new Set();
  const requests = steps.filter((step) => step.kind !== 'place');
  for (const step of requests) {
    if (step.kind === 'camera' && NAMED_ONLY.has(step.act || step.name))
      return false;
    const needsVerb =
      (step.kind === 'camera' && step.act === 'clear') ||
      (step.kind === 'panel' && step.action === 'close') ||
      step.kind === 'cockpit' ||
      step.kind === 'radio' ||
      (step.kind === 'layer' && SOUND_LAYERS.has(step.layer.id));
    if (needsVerb && !asked.has(step)) return false;
  }
  if (!requests.length) return false;
  // Every request asked for by a verb in its own clause. Keywords alone ask
  // for nothing, however many clauses they fill ("Fire and Rain", "Noir
  // and Thermal", "New York City noir").
  if (requests.every((step) => asked.has(step))) return true;
  // "flights near Tokyo": a whole layer name, and a place after near/in.
  const [only] = requests;
  // Only that one request: a bare keyword beside it ("flights near Austin
  // and noir") is not asked for.
  return (
    requests.length === 1 &&
    only.kind === 'layer' &&
    only.layer.exact !== false &&
    parsed?.placeFrom === 'near'
  );
}

/**
 * Whether Enter may run this row without it being chosen.
 * @param {object} item A row.
 * @param {string} text The typed line.
 * @param {object} parsed The line as parseOmnibar read it.
 * @param {{named: boolean}} context `named`: the line is a command's exact
 *   label.
 */
export function mayRunOnEnter(item, text, parsed, context) {
  const verb = hasActionVerb(text);
  switch (item?.kind) {
    case 'guide':
      // A walk found by a typo, or a line written as a title ("How To Train
      // Your Dragon"), is offered, never run.
      return !item.loose && !item.titled;
    case 'place':
      // A row only for picking ("Search … anyway") never runs on Enter.
      return !item.explicit;
    case 'count-show':
    case 'entity':
    case 'view-ask':
    case 'sel-fly':
    case 'sel-follow':
    case 'sel-cockpit':
    case 'sel-ask':
    case 'sel-close':
      return true;
    case 'ask':
      return isRealQuestion(text);
    case 'layer':
      return (
        Boolean(item.best) &&
        (!SOUND_LAYERS.has(item.id) || !item.enabled || verb || context.named)
      );
    case 'mic':
      return Boolean(item.named);
    case 'open-draw':
      return verb;
    case 'plan':
      // A plan the whole line asked for in so many words ("hide everything
      // except flights") runs.
      if (item.asked) return true;
      // A command row runs on its exact label only; a verb that merely
      // lists it ("hide", "turn off") offers it.
      if (item.command) return Boolean(item.named);
      return planAsked(item.steps || [], { named: context.named, parsed });
    default:
      return false;
  }
}

/**
 * The rows in the order shown: when the first may not run on Enter, the
 * first place row moves ahead of it, so Enter searches the place.
 */
export function orderForEnter(items, text, parsed, context) {
  const first = items[0];
  // A question without "?" still offers a place first when there is one.
  const askFirst = first?.kind === 'ask' && !String(text).includes('?');
  if (!first || (!askFirst && mayRunOnEnter(first, text, parsed, context)))
    return items;
  const place = items.findIndex((item) => item.kind === 'place');
  if (place <= 0) return items;
  return [items[place], ...items.slice(0, place), ...items.slice(place + 1)];
}

/** The row Enter runs before one is chosen with the keyboard, or -1. */
export function enterDefault(items, text, parsed, context) {
  const line = String(text || '').trim();
  if (!line || /^>\s*$/.test(line)) return -1;
  return items.length && mayRunOnEnter(items[0], line, parsed, context)
    ? 0
    : -1;
}
