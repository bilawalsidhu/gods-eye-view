/**
 * The Cockpit instruments, route and vision selector as they first render.
 * It needs only the i18n module, so the controller and the views can both
 * read it.
 */
import { msg, t } from '../i18n/index.js';

/** Ticks on each altitude and speed rim. */
const COCKPIT_RIM_TICKS = 9;

/** The vision selector's short label for each mode. */
const COCKPIT_VISION_LABELS = Object.freeze({
  optical: msg('NORMAL'),
  crt: msg('CRT'),
  nvg: msg('NVG'),
  thermal: msg('FLIR'),
  anime: msg('ANIME'),
  noir: msg('NOIR'),
});

/** The name each mode is announced and titled with. */
const COCKPIT_VISION_NAMES = Object.freeze({
  optical: msg('Normal'),
  crt: msg('CRT'),
  nvg: msg('Night vision'),
  thermal: msg('Thermal'),
  anime: msg('Anime'),
  noir: msg('Noir'),
});

/** A rim before any reading: its ticks shown but unplaced and unlabelled. */
function createRimState(value) {
  return {
    unavailable: false,
    value,
    ticks: Array.from({ length: COCKPIT_RIM_TICKS }, () => ({
      hidden: false,
      slot: null,
      depth: null,
      curve: null,
      major: false,
      label: '',
    })),
  };
}

/**
 * The instruments before any aircraft reading: readouts show their
 * placeholders. The controller keeps it, changes it in place on every HUD
 * update and publishes a copy; `CockpitView` renders it.
 * @returns {object}
 */
export function createInstrumentState() {
  return {
    // 'aircraft', 'vessel' or 'subject': which readouts the HUD shows.
    kind: 'aircraft',
    layer: null,
    callsign: t('AIRCRAFT'),
    meta: { text: t('LIVE TRACK · COURSE ALIGNED'), emergency: false },
    speed: null,
    altitude: null,
    // A vessel's course over ground, shown where an aircraft shows altitude.
    course: null,
    heading: null,
    // A vessel's `heading` readout is its true heading, or its course over
    // ground when it reports none: 'heading' | 'course' | null.
    trackSource: null,
    speedRim: createRimState('---'),
    altitudeRim: createRimState('-----'),
    compass: [],
    // A bridge tape's bow (prograde) and stern (retrograde) marks, in
    // division slots off its centre; null when off the tape or not a bridge.
    compassMarkers: { prograde: null, retrograde: null },
    // A bridge view turned off the bow: whether it is, the target yaw off
    // the bow (degrees, -180..180, starboard positive) and its worded readout.
    look: { offset: false, yawDeg: 0, readout: '' },
    clock: '--:--:--Z',
    position: '--° · --°',
    // A provider subject's HUD (kind 'subject', cockpitSubjectProviders.js):
    // its kicker, speed unit and tag, readouts, sources, banner, veil and
    // progress line, all worded by the provider.
    kicker: '',
    speedUnit: '',
    speedTag: '',
    speedTone: 'normal',
    readouts: [],
    sources: [],
    banner: null,
    veil: null,
    progress: null,
    lookEnabled: false,
  };
}

/**
 * The flight plan card and the visor's destination arrow before any route:
 * both hidden.
 * @returns {object}
 */
export function createRouteState() {
  return {
    // A vessel's card shows only the free-text AIS destination; a provider's
    // subject's (kind 'subject') carries its own title.
    kind: 'aircraft',
    title: '',
    visible: false,
    from: t('UNKNOWN'),
    to: t('UNKNOWN'),
    status: t('ROUTE DATA UNAVAILABLE'),
    direction: { visible: false, angle: null, label: t('DEST ---°') },
  };
}

/**
 * The vision selector showing `mode`.
 * @param {string} mode A normalized Cockpit vision mode.
 * @returns {{mode: string, label: string, name: string}}
 */
export function createVisionState(mode = 'optical') {
  return {
    mode,
    label: t(COCKPIT_VISION_LABELS[mode]),
    name: t(COCKPIT_VISION_NAMES[mode]),
  };
}
