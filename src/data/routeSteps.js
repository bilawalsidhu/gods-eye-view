/**
 * @module routeSteps
 * @description Turn-by-turn steps from an OSRM route, in plain English.
 *
 * OSRM (the FOSSGIS servers behind `/api/route`) returns each step as a
 * maneuver `type` + `modifier` (+ roundabout `exit`) and the road name; it
 * does not phrase instructions. This module does, with the same vocabulary
 * OSRM's own text-instructions package uses so a reader of either feels at
 * home. Pure: used by the Vite proxy and node:test.
 *
 * OSRM maneuver types handled: depart, arrive, turn, new name, continue,
 * end of road, fork, merge, on ramp, off ramp, roundabout, rotary,
 * roundabout turn, exit roundabout, exit rotary, notification, use lane.
 *
 * The English sentences ARE the wire format: the server proxy serves them
 * unchanged. `localizedInstructionFor` recomposes the same step through the
 * `ground.route.*` pack for display, so the presentation edge — not the
 * protocol — localizes.
 */
import { t } from '../i18n/index.js';

/** Cap on steps returned for one route — a 2,500 km drive rarely needs more. */
export const ROUTE_STEPS_MAX = 200;

const DIRECTION_WORDS = Object.freeze({
  left: 'left',
  right: 'right',
  'slight left': 'slightly left',
  'slight right': 'slightly right',
  'sharp left': 'sharply left',
  'sharp right': 'sharply right',
  straight: 'straight',
  uturn: 'around',
});

function cleanText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text;
}

/**
 * Road label for a step: "Name (Ref)", "Name", "Ref", or "".
 * @param {{name?: string, ref?: string}} step
 * @returns {string}
 */
export function roadLabel(step) {
  const name = cleanText(step?.name);
  const ref = cleanText(step?.ref);
  if (name && ref && !name.includes(ref)) return `${name} (${ref})`;
  return name || ref;
}

function ontoRoad(step) {
  const road = roadLabel(step);
  return road ? ` onto ${road}` : '';
}

function direction(modifier) {
  const key = cleanText(modifier).toLowerCase();
  return DIRECTION_WORDS[key] || key;
}

/** Modifier → ground.route.dir.* key (meaning-named, never the English word). */
const DIR_KEYS = Object.freeze({
  left: 'ground.route.dir.left',
  right: 'ground.route.dir.right',
  'slight left': 'ground.route.dir.slightLeft',
  'slight right': 'ground.route.dir.slightRight',
  'sharp left': 'ground.route.dir.sharpLeft',
  'sharp right': 'ground.route.dir.sharpRight',
  straight: 'ground.route.dir.straight',
  uturn: 'ground.route.dir.uturn',
});

function localizedDirection(modifier) {
  const key = cleanText(modifier).toLowerCase();
  return DIR_KEYS[key] ? t(DIR_KEYS[key]) : key;
}

function localizedOntoRoad(step) {
  const road = roadLabel(step);
  return road ? t('ground.route.onto', { road }) : '';
}

function localizedOrdinal(n) {
  if (!Number.isInteger(n) || n < 1) return null;
  return t('ground.route.ordinal', {
    n,
    suffix:
      n % 100 >= 11 && n % 100 <= 13
        ? 'th'
        : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th',
  });
}

/**
 * One localized sentence for an OSRM step, composed through the
 * `ground.route.*` pack at display time. Mirrors `instructionFor` case for
 * case so both phrasings never drift apart; the English pack values are
 * byte-identical to `instructionFor`'s output. A step that carries no
 * maneuver fields (an older cached payload, a hand-built fixture) falls back
 * to its precomposed English `instruction` — there is nothing to recompose
 * from.
 * @param {{type?: string, modifier?: string, exit?: number, name?: string, ref?: string, instruction?: string}} step
 * @returns {string}
 */
export function localizedInstructionFor(step) {
  const type = cleanText(step?.type).toLowerCase();
  if (!type) return cleanText(step?.instruction);
  const modifier = cleanText(step?.modifier).toLowerCase();
  const dir = localizedDirection(modifier);
  const onto = localizedOntoRoad(step);
  const road = roadLabel(step);
  switch (type) {
    case 'depart':
      return road
        ? t('ground.route.departRoad', { road })
        : t('ground.route.depart');
    case 'arrive':
      if (modifier === 'left' || modifier === 'right')
        return t('ground.route.arriveSide', {
          side: t(
            modifier === 'left'
              ? 'ground.route.sideLeft'
              : 'ground.route.sideRight',
          ),
        });
      return t('ground.route.arrive');
    case 'turn':
      if (modifier === 'uturn') return t('ground.route.uturn', { onto });
      if (modifier === 'straight')
        return t('ground.route.continueStraight', { onto });
      return dir
        ? t('ground.route.turnDir', { dir, onto })
        : t('ground.route.turnBare', { onto });
    case 'new name':
      return t('ground.route.continue', { onto });
    case 'continue':
      if (modifier === 'uturn') return t('ground.route.uturn', { onto });
      return dir && dir !== t('ground.route.dir.straight')
        ? t('ground.route.continueDir', { dir, onto })
        : t('ground.route.continueStraight', { onto });
    case 'end of road':
      return dir
        ? t('ground.route.endOfRoadDir', { dir, onto })
        : t('ground.route.endOfRoad', { onto });
    case 'fork':
      return dir
        ? t('ground.route.forkDir', { dir, onto })
        : t('ground.route.fork', { onto });
    case 'merge':
      return dir
        ? t('ground.route.mergeDir', { dir, onto })
        : t('ground.route.merge', { onto });
    case 'on ramp':
      return dir
        ? t('ground.route.onRampDir', {
            side: t(
              modifier === 'right'
                ? 'ground.route.sideRight'
                : 'ground.route.sideLeft',
            ),
            onto,
          })
        : t('ground.route.onRamp', { onto });
    case 'off ramp':
      return dir
        ? t('ground.route.offRampDir', {
            side: t(
              modifier === 'right'
                ? 'ground.route.sideRight'
                : 'ground.route.sideLeft',
            ),
            onto,
          })
        : t('ground.route.offRamp', { onto });
    case 'roundabout':
    case 'rotary': {
      const exit = localizedOrdinal(step?.exit);
      return exit
        ? t('ground.route.roundaboutExit', { exit, onto })
        : t('ground.route.roundaboutEnter', { onto });
    }
    case 'roundabout turn':
      return dir
        ? t('ground.route.roundaboutTurn', { dir, onto })
        : t('ground.route.roundaboutEnter', { onto });
    case 'exit roundabout':
    case 'exit rotary':
      return t('ground.route.exitRoundabout', { onto });
    case 'use lane':
      return dir
        ? t('ground.route.useLaneDir', { dir, onto })
        : t('ground.route.continue', { onto });
    case 'notification':
    default:
      return t('ground.route.continue', { onto });
  }
}

function ordinal(n) {
  if (!Number.isInteger(n) || n < 1) return null;
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? 'th'
      : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

/**
 * One English sentence for an OSRM step.
 * @param {{type?: string, modifier?: string, exit?: number, name?: string, ref?: string}} step
 * @returns {string}
 */
export function instructionFor(step) {
  const type = cleanText(step?.type).toLowerCase();
  const modifier = cleanText(step?.modifier).toLowerCase();
  const dir = direction(modifier);
  const onto = ontoRoad(step);
  const road = roadLabel(step);
  switch (type) {
    case 'depart':
      return road ? `Head out on ${road}` : 'Head out';
    case 'arrive':
      if (modifier === 'left' || modifier === 'right')
        return `Arrive at your destination, on the ${modifier}`;
      return 'Arrive at your destination';
    case 'turn':
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      if (modifier === 'straight') return `Continue straight${onto}`;
      return dir ? `Turn ${dir}${onto}` : `Turn${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      return dir && dir !== 'straight'
        ? `Continue ${dir}${onto}`
        : `Continue straight${onto}`;
    case 'end of road':
      return dir
        ? `At the end of the road, turn ${dir}${onto}`
        : `At the end of the road, continue${onto}`;
    case 'fork':
      return dir
        ? `Keep ${dir} at the fork${onto}`
        : `Continue at the fork${onto}`;
    case 'merge':
      return dir ? `Merge ${dir}${onto}` : `Merge${onto}`;
    case 'on ramp':
      return dir
        ? `Take the ramp on the ${dir}${onto}`
        : `Take the ramp${onto}`;
    case 'off ramp':
      return dir
        ? `Take the exit on the ${dir}${onto}`
        : `Take the exit${onto}`;
    case 'roundabout':
    case 'rotary': {
      const exit = ordinal(step?.exit);
      return exit
        ? `At the roundabout, take the ${exit} exit${onto}`
        : `Enter the roundabout${onto}`;
    }
    case 'roundabout turn':
      return dir
        ? `At the roundabout, turn ${dir}${onto}`
        : `At the roundabout, continue${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    case 'use lane':
      return dir ? `Use the ${dir} lane${onto}` : `Continue${onto}`;
    case 'notification':
    default:
      return `Continue${onto}`;
  }
}

/**
 * Flatten an OSRM route's legs into the compact step list the proxy serves.
 * "exit roundabout" / "exit rotary" steps are folded into the roundabout
 * step before them (their distance is the road after the roundabout), so a
 * reader gets one instruction per decision.
 * A route with more maneuvers than `ROUTE_STEPS_MAX` is cut off there and
 * reported as cut off, because the last step of a route is its arrival: a
 * silently truncated list reads as a complete set of directions that simply
 * stops in the middle of a motorway.
 * @param {{legs?: Array<{steps?: object[]}>}} route OSRM route object.
 * @returns {{steps: Array<{index:number, type:string, modifier:string|null, exit:number|null,
 *   name:string, ref:string|null, distanceM:number, durationS:number, lon:number, lat:number,
 *   instruction:string}>, truncated: boolean}}
 */
export function normalizeOsrmSteps(route) {
  const out = [];
  for (const leg of route?.legs || []) {
    for (const raw of leg?.steps || []) {
      const location = raw?.maneuver?.location;
      const lon = Number(location?.[0]);
      const lat = Number(location?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const type = cleanText(raw.maneuver?.type).toLowerCase() || 'continue';
      const step = {
        index: out.length,
        type,
        modifier: cleanText(raw.maneuver?.modifier).toLowerCase() || null,
        exit: Number.isInteger(raw.maneuver?.exit) ? raw.maneuver.exit : null,
        name: cleanText(raw.name),
        ref: cleanText(raw.ref) || null,
        distanceM: Math.max(0, Math.round(Number(raw.distance) || 0)),
        durationS: Math.max(0, Math.round(Number(raw.duration) || 0)),
        lon: Number(lon.toFixed(6)),
        lat: Number(lat.toFixed(6)),
        instruction: '',
      };
      const previous = out[out.length - 1];
      if (
        (type === 'exit roundabout' || type === 'exit rotary') &&
        previous &&
        (previous.type === 'roundabout' ||
          previous.type === 'rotary' ||
          previous.type === 'roundabout turn')
      ) {
        previous.distanceM += step.distanceM;
        previous.durationS += step.durationS;
        if (!roadLabel(previous) && roadLabel(step)) {
          previous.name = step.name;
          previous.ref = step.ref;
          previous.instruction = instructionFor(previous);
        }
        continue;
      }
      step.instruction = instructionFor(step);
      out.push(step);
      if (out.length >= ROUTE_STEPS_MAX) return { steps: out, truncated: true };
    }
  }
  return { steps: out, truncated: false };
}

/**
 * "850 m", "1.2 km", "21 km".
 * @param {number} meters
 * @returns {string}
 */
export function formatRouteDistance(meters) {
  if (!Number.isFinite(meters) || meters < 0) return '';
  if (meters < 100) return `${Math.round(meters)} m`;
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/**
 * "40 s", "12 min", "1 h 5 min".
 * @param {number} seconds
 * @returns {string}
 */
export function formatRouteDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
