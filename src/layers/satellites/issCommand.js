import { t } from '../../i18n/index.js';

const unit = (v) => {
  const n = Math.hypot(...v);
  return v.map((c) => c / n);
};

/**
 * The Sun positions Manual offers, on the model's axes (port, zenith,
 * forward), and whether the station is lit there.
 * @returns {Array<{label: string, sun: number[], sunlit: boolean}>}
 */
export function issCommandSunPoses() {
  return [
    { label: t('Overhead'), sun: [0, 1, 0], sunlit: true },
    { label: t('Ahead'), sun: unit([0, 0.05, 1]), sunlit: true },
    { label: t('Behind'), sun: unit([0, 0.05, -1]), sunlit: true },
    { label: t('Below'), sun: unit([0, -1, 0.05]), sunlit: true },
    { label: t('Port side'), sun: unit([0.8, 0.5, 0.3]), sunlit: true },
    { label: t('Starboard side'), sun: unit([-0.8, 0.5, 0.3]), sunlit: true },
    { label: t('Night (shadow)'), sun: [0, -1, 0], sunlit: false },
  ];
}

/** Where "Zoom to the ISS" stops: the whole 109 m station fills the view. */
export const ISS_COMMAND_ZOOM_RANGE_M = 260;

/**
 * The Automatic mode's status line.
 * @param {boolean|null} sunlit Null while the model has not been placed yet.
 * @returns {string}
 */
export function issCommandStatusText(sunlit) {
  if (sunlit === null) return '';
  return sunlit ? t('Now: in sunlight') : t("Now: in the Earth's shadow");
}

/** Beyond this the camera counts as far, and the zoom button is offered. */
export const ISS_COMMAND_FAR_M = 1000;

/**
 * Whether "Zoom to the ISS" is offered: only from far away, so it goes once
 * the camera is in close (by the button or by hand) and returns on zooming
 * back out.
 * @param {number} distance Meters from the camera to the station.
 * @returns {boolean}
 */
export function issCommandOffersZoom(distance) {
  return distance > ISS_COMMAND_FAR_M;
}

/**
 * One step of the zoom: how far to move in from `distance`, easing out as
 * the target range nears, never past it.
 * @param {number} distance Meters from the camera to the station.
 * @returns {number} Meters to move in; 0 once close enough.
 */
export function issCommandZoomStep(distance) {
  const left = distance - ISS_COMMAND_ZOOM_RANGE_M;
  if (!(left > ISS_COMMAND_ZOOM_RANGE_M * 0.02)) return 0;
  return left * 0.14;
}

/**
 * The follow camera's range after one step of the zoom: the step nearer,
 * never past the target range, and unchanged once there. The camera is moved
 * by scaling its follow offset from the station (the camera port's
 * `followOffset`, the eye in the follow's frame) by
 * `issCommandZoomRange(range) / range`, which can only bring it in; a move
 * along the view direction is not used, since it ran away when the camera
 * was not looking at the station.
 * @param {number} range Meters from the camera to the station.
 * @returns {number} The range to set; `range` itself when there is no step.
 */
export function issCommandZoomRange(range) {
  if (!(range > 0) || !Number.isFinite(range)) return range;
  const step = issCommandZoomStep(range);
  return step > 0 ? Math.max(ISS_COMMAND_ZOOM_RANGE_M, range - step) : range;
}

/**
 * One step of the zoom on the follow offset: the same offset, shortened to
 * `issCommandZoomRange` of its length, so the eye keeps its bearing on the
 * station and only comes in.
 * @param {{x: number, y: number, z: number}|null|undefined} offset The
 *   eye's offset from the station, metres in the follow's frame.
 * @returns {{x: number, y: number, z: number}|null} The offset to set; null
 *   when there is no step (close enough, or no offset to shorten).
 */
export function issCommandZoomOffset(offset) {
  if (!offset) return null;
  const range = Math.hypot(offset.x, offset.y, offset.z);
  const next = issCommandZoomRange(range);
  if (!(next < range)) return null;
  const k = next / range;
  return { x: offset.x * k, y: offset.y * k, z: offset.z * k };
}

/**
 * Whether the zoom may run: only while the camera follows the station's
 * follow target and has framed it, so that its follow offset is the eye's
 * offset from the station and shortening it brings the camera in. From any
 * other camera (still flying to the station, following something else, or
 * a follow not yet framed) there is no such offset to shorten.
 * @param {{followed?: object|null, followFramed?: boolean}|null|undefined}
 *   camera What the camera port reports (`cameraOf(viewer)`).
 * @param {object|null|undefined} target The layer's follow target for the
 *   station (`layerState._followTarget`).
 * @returns {boolean}
 */
export function issCommandCameraOnStation(camera, target) {
  return (
    Boolean(target) &&
    camera?.followed === target &&
    camera.followFramed === true
  );
}

/** How long one lap of the "fast orbit" takes, and its share in shadow. */
const FAST_ORBIT_MS = 40_000;

/**
 * The Sun over one accelerated orbit: it circles the truss, a third of the
 * lap in the Earth's shadow.
 * @param {number} elapsedMs
 * @returns {{sun: number[], sunlit: boolean}}
 */
export function issCommandFastOrbit(elapsedMs) {
  const angle = (elapsedMs / FAST_ORBIT_MS) * 2 * Math.PI;
  return {
    sun: unit([0.35, Math.cos(angle), Math.sin(angle)]),
    sunlit: Math.cos(angle) > -0.5,
  };
}
