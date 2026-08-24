/**
 * The view in the URL, so any camera position and any set of layer switches is shareable.
 *
 * In the hash, not the query string: the hash never reaches the server, so nothing here can
 * turn into a cache key or an access-log entry, and a URL from a colleague opens without a
 * round trip. Written with `replaceState`, so panning the globe does not fill the back
 * button with camera positions.
 *
 * Deliberately small. The whole store is not in here: entities move, so a URL carrying them
 * would be stale on arrival, and the layer set plus a camera is what makes a view
 * reproducible. Selection is left out for the same reason, and follow mode is left out
 * because the entity it names may be nowhere near the viewport by the time the link is
 * opened.
 *
 * Coordinates are longitude first, matching every contract in this project. There are
 * already four disagreeing bounding-box conventions in the tree and adding a fifth
 * lat-first one in the URL, where it would look right to anyone used to a mapping site, is
 * exactly the trap that costs an afternoon.
 */

import { Cartesian3 } from 'cesium';
import type { Camera } from 'cesium';

import { normaliseLongitude } from '../globe/project';

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

/** Straight down and north up, which is how the globe opens. Omitted from the hash. */
export const DEFAULT_HEADING_DEG = 0;
export const DEFAULT_PITCH_DEG = -90;

/**
 * The ceiling on the camera height a URL may ask for, in metres.
 *
 * A hundred thousand kilometres, well past a whole-earth view. This is a bound on hostile
 * input rather than a UI limit: `1e308` parses as a perfectly good number and puts the
 * camera somewhere Cesium's own maths stops being meaningful.
 */
export const MAXIMUM_ALTITUDE_M = 1e8;

/** Five decimal places is about a metre, which is finer than any camera needs. */
const COORDINATE_DECIMALS = 5;
const ANGLE_DECIMALS = 1;

export interface CameraView {
  lon: number;
  lat: number;
  /** Camera height in metres above the WGS84 ellipsoid. */
  altitudeM: number;
  headingDeg: number;
  pitchDeg: number;
}

export interface ParsedView {
  /** Null when the hash carried no camera, or carried one that does not make sense. */
  camera: CameraView | null;
  /** Layer names the URL asks to have switched off, lower-cased and de-duplicated. */
  hidden: readonly string[];
}

/** Trailing zeros dropped, so the hash reads like something a person wrote. */
function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/**
 * Wrap an angle into `[0, 360)`.
 *
 * The in-range case returns the value untouched rather than going through the arithmetic,
 * because `((45.3 % 360) + 360) % 360` is 45.29999999999995 and a URL that rewrote itself
 * by a rounding error every time it was opened would be its own bug report.
 */
function wrapBearing(deg: number): number {
  if (deg >= 0 && deg < 360) {
    return deg;
  }
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function finiteNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read a hash written by {@link formatViewHash}.
 *
 * This is a trust boundary: the string is whatever was in somebody's address bar. A camera
 * that does not make sense is dropped whole and the globe keeps its opening view, because
 * half a camera is worse than none. Longitude and heading wrap rather than being rejected,
 * since both are angles where 190 has an unambiguous meaning; pitch is clamped for the same
 * reason. Latitude and altitude have no such reading and are rejected.
 */
export function parseViewHash(hash: string): ParsedView {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const hidden = [
    ...new Set(
      (params.get('off') ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== ''),
    ),
  ];

  const lon = finiteNumber(params.get('lon'));
  const lat = finiteNumber(params.get('lat'));
  const altitudeM = finiteNumber(params.get('alt'));
  if (
    lon === null ||
    lat === null ||
    altitudeM === null ||
    lat < -90 ||
    lat > 90 ||
    altitudeM <= 0 ||
    altitudeM > MAXIMUM_ALTITUDE_M
  ) {
    return { camera: null, hidden };
  }

  const heading = finiteNumber(params.get('heading')) ?? DEFAULT_HEADING_DEG;
  const pitch = finiteNumber(params.get('pitch')) ?? DEFAULT_PITCH_DEG;
  return {
    camera: {
      // Same reason as `wrapBearing`: an in-range longitude comes back bit for bit.
      lon: lon >= -180 && lon < 180 ? lon : normaliseLongitude(lon),
      lat,
      altitudeM,
      headingDeg: wrapBearing(heading),
      pitchDeg: Math.min(Math.max(pitch, -90), 90),
    },
    hidden,
  };
}

/**
 * Write a camera and the switched-off layers as a hash.
 *
 * Heading and pitch are left out at their defaults, which is most of the time, so an
 * ordinary link is three parameters long.
 */
export function formatViewHash(view: CameraView, hidden: readonly string[] = []): string {
  const parts = [
    `lon=${round(view.lon, COORDINATE_DECIMALS)}`,
    `lat=${round(view.lat, COORDINATE_DECIMALS)}`,
    `alt=${Math.round(view.altitudeM)}`,
  ];
  const heading = round(view.headingDeg, ANGLE_DECIMALS);
  if (heading !== DEFAULT_HEADING_DEG) {
    parts.push(`heading=${heading}`);
  }
  const pitch = round(view.pitchDeg, ANGLE_DECIMALS);
  if (pitch !== DEFAULT_PITCH_DEG) {
    parts.push(`pitch=${pitch}`);
  }
  if (hidden.length > 0) {
    // Encoded per name but joined raw, so the comma stays a comma on screen.
    parts.push(`off=${hidden.map((name) => encodeURIComponent(name)).join(',')}`);
  }
  return `#${parts.join('&')}`;
}

/** Where the camera is now, in degrees. Cesium works in radians; contracts do not. */
export function cameraView(camera: Camera): CameraView {
  const position = camera.positionCartographic;
  return {
    lon: position.longitude * DEG_PER_RAD,
    lat: position.latitude * DEG_PER_RAD,
    altitudeM: position.height,
    headingDeg: camera.heading * DEG_PER_RAD,
    pitchDeg: camera.pitch * DEG_PER_RAD,
  };
}

/** Point the camera at a view read out of a URL. */
export function applyCameraView(camera: Camera, view: CameraView): void {
  camera.setView({
    destination: Cartesian3.fromDegrees(view.lon, view.lat, view.altitudeM),
    orientation: {
      heading: view.headingDeg * RAD_PER_DEG,
      pitch: view.pitchDeg * RAD_PER_DEG,
      roll: 0,
    },
  });
}

export interface UrlStateOptions {
  camera: Camera;
  /**
   * Layers currently switched off.
   *
   * A function rather than a value because the rail owns that state: its checkboxes are
   * what says so on screen, and a second copy here could disagree with them.
   */
  hidden: () => readonly string[];
  /**
   * True while something other than the user is driving the camera, which is follow mode.
   *
   * A followed aircraft moves the camera continuously, and recording that would both
   * overwrite the view the user chose and hammer `replaceState`, which browsers throttle.
   */
  suspended?: () => boolean;
  /** Injected so this can be tested without a document. */
  write?: (hash: string) => void;
}

export interface UrlState {
  /** Write the current camera and layer switches into the URL now. */
  record: () => void;
  /** Stop following the camera. */
  stop: () => void;
}

function replaceHash(hash: string): void {
  window.history.replaceState(null, '', hash);
}

/**
 * Keep the URL in step with the camera, and give the caller a way to record a change the
 * camera did not make.
 *
 * `moveEnd` rather than a timer: it fires when the user stops, once, including at the end
 * of an inertial spin, so there is nothing to debounce.
 */
export function trackViewInUrl(options: UrlStateOptions): UrlState {
  const write = options.write ?? replaceHash;
  const record = (): void => {
    if (options.suspended?.() === true) {
      return;
    }
    write(formatViewHash(cameraView(options.camera), options.hidden()));
  };
  const remove = options.camera.moveEnd.addEventListener(record);
  return { record, stop: remove };
}
