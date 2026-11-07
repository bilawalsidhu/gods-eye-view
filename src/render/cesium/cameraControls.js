/**
 * @module render/cesium/cameraControls
 * @description The Cesium camera port's `controls`: the contract's user
 * camera settings mapped onto the scene's ScreenSpaceCameraController.
 *
 * - `suspend` and `enabled` are the scene's shared input holds
 *   (`cameraInput.js`), so a hold taken here, by the input port or by the
 *   dispatcher is counted with the rest and released on its own.
 * - `coast` is Cesium's inertia: its speed falls as exp(-25 (1 - c) t), so a
 *   coast of s seconds is c = 1 - 1 / (25 s), and a coast of 0 is c = 1,
 *   which Cesium takes as no inertia at all. `drag` is `inertiaSpin`, which
 *   moves and tilts the globe in 3D (and `inertiaTranslate`, its pan in 2D);
 *   `zoom` is `inertiaZoom`.
 * - `minDistance` and `coast.zoom` are the controller's own values: while a
 *   follow raises the zoom floor and stops zoom coasting, they read and set
 *   what the follow gives back when it ends.
 * - `collision` is one switch in Cesium, `enableCollisionDetection`: the
 *   eye stays above the terrain and above every tileset that has its own
 *   `enableCollision` on. Any setting but 'none' turns it on, and reads
 *   back as set.
 * - `pitchRange`'s upper end is Cesium's `maximumTiltAngle` (measured from
 *   straight down, so pitch + π/2); Cesium stops a user tilt short of
 *   straight down on its own, and has no other lower bound, so the lower
 *   end is kept and read back but not enforced.
 * - `zoomInputs` are the controller's `zoomEventTypes`; a binding the
 *   contract has no name for is kept as it is when they are set.
 */
import * as Cesium from 'cesium';
import { acquireCameraInput } from './cameraInput.js';
import { followZoomBase, setFollowZoomBase } from './follow.js';

const HALF_PI = Math.PI / 2;
const { WHEEL, PINCH, RIGHT_DRAG } = Cesium.CameraEventType;
const { CTRL } = Cesium.KeyboardEventModifier;

/** The contract's zoom inputs as Cesium bindings. */
const ZOOM_BINDINGS = Object.freeze({
  wheel: WHEEL,
  pinch: PINCH,
  rightDrag: RIGHT_DRAG,
  ctrlWheel: Object.freeze({ eventType: WHEEL, modifier: CTRL }),
});

/** A Cesium zoom binding's contract name, or null when it has none. */
export function zoomInputName(binding) {
  const type = binding?.eventType ?? binding;
  const modifier = binding?.modifier;
  if (modifier === undefined) {
    if (type === WHEEL) return 'wheel';
    if (type === PINCH) return 'pinch';
    if (type === RIGHT_DRAG) return 'rightDrag';
    return null;
  }
  return type === WHEEL && modifier === CTRL ? 'ctrlWheel' : null;
}

/** Cesium's event-type setting, which may be one binding, as a list. */
export const bindingList = (types) =>
  Array.isArray(types) ? types : types === undefined ? [] : [types];

/** Coast seconds as a Cesium inertia coefficient, and back. */
export const coastToInertia = (seconds) =>
  seconds > 0 ? 1 - 1 / (25 * seconds) : 1;
export const inertiaToCoast = (c) =>
  Number.isFinite(c) && c < 1 ? 1 / (25 * (1 - c)) : 0;

/**
 * Cesium's controller defaults, for a scene that has no controller of its
 * own: the settings then only read back. Also a headless scene's controller.
 */
export const controllerDefaults = () => ({
  enableTilt: true,
  enableRotate: true,
  enableZoom: true,
  inertiaSpin: 0.9,
  inertiaTranslate: 0.9,
  inertiaZoom: 0.8,
  minimumZoomDistance: 1,
  maximumZoomDistance: Number.POSITIVE_INFINITY,
  zoomFactor: 5,
  zoomEventTypes: [RIGHT_DRAG, WHEEL, PINCH],
  enableCollisionDetection: true,
  maximumTiltAngle: undefined,
});

/**
 * @param {{scene: {screenSpaceCameraController?: object}}} options
 * @returns {{controls: import('../contract/camera').CameraControls,
 *   dispose: () => void}}
 */
export function createCesiumControls({ scene }) {
  const ownController = scene.screenSpaceCameraController;
  const controller = ownController ?? controllerDefaults();

  // The shared holds, taken on first use: until then the controller's
  // `enableInputs` is left as it is.
  let cameraInput = null;
  let disposed = false;
  const input = () => {
    if (!cameraInput && !disposed) cameraInput = acquireCameraInput(scene);
    return cameraInput;
  };

  let collision = controller.enableCollisionDetection ? 'both' : 'none';
  // The pitch range as last set, read back while the controller still has
  // the tilt limit it was given.
  let pitchSet = null;

  const controls = {
    // Read without taking over `enableInputs`: once any user holds input,
    // the controller's own property counts every hold.
    get enabled() {
      if (ownController && !cameraInput)
        return ownController.enableInputs !== false;
      const held = input();
      if (held && !held.enabled) return false;
      return !ownController || ownController.enableInputs !== false;
    },
    suspend(reason) {
      return input()?.suspend(reason) ?? (() => {});
    },
    get enableTilt() {
      return Boolean(controller.enableTilt);
    },
    set enableTilt(value) {
      controller.enableTilt = Boolean(value);
    },
    get enableRotate() {
      return Boolean(controller.enableRotate);
    },
    set enableRotate(value) {
      controller.enableRotate = Boolean(value);
    },
    get enableZoom() {
      return Boolean(controller.enableZoom);
    },
    set enableZoom(value) {
      controller.enableZoom = Boolean(value);
    },
    get minDistance() {
      return followZoomBase(controller, 'minimumZoomDistance');
    },
    set minDistance(value) {
      setFollowZoomBase(controller, 'minimumZoomDistance', value);
    },
    get maxDistance() {
      return controller.maximumZoomDistance;
    },
    set maxDistance(value) {
      controller.maximumZoomDistance = value;
    },
    get coast() {
      return Object.freeze({
        drag: inertiaToCoast(controller.inertiaSpin),
        zoom: inertiaToCoast(followZoomBase(controller, 'inertiaZoom')),
      });
    },
    set coast(value) {
      for (const key of ['drag', 'zoom'])
        if (!(Number.isFinite(value?.[key]) && value[key] >= 0))
          throw new TypeError(`coast.${key} must be seconds, 0 or more`);
      const drag = coastToInertia(value.drag);
      controller.inertiaSpin = drag;
      controller.inertiaTranslate = drag;
      setFollowZoomBase(controller, 'inertiaZoom', coastToInertia(value.zoom));
    },
    get collision() {
      return controller.enableCollisionDetection
        ? collision === 'none'
          ? 'both'
          : collision
        : 'none';
    },
    set collision(value) {
      if (!['none', 'terrain', 'tiles', 'both'].includes(value))
        throw new TypeError(`no collision setting '${value}'`);
      collision = value;
      controller.enableCollisionDetection = value !== 'none';
    },
    get zoomFactor() {
      return controller.zoomFactor;
    },
    set zoomFactor(value) {
      controller.zoomFactor = value;
    },
    get pitchRange() {
      const tilt = controller.maximumTiltAngle;
      if (pitchSet && pitchSet.tilt === tilt) return [...pitchSet.range];
      const max =
        tilt === undefined ? HALF_PI : Math.min(HALF_PI, tilt - HALF_PI);
      const min = Math.min(pitchSet?.range[0] ?? -HALF_PI, max);
      return [Math.max(-HALF_PI, min), Math.max(-HALF_PI, max)];
    },
    set pitchRange(value) {
      const [min, max] = Array.isArray(value) ? value : [];
      if (!(Number.isFinite(min) && Number.isFinite(max) && min <= max))
        throw new RangeError('pitchRange must be [min, max] radians');
      const range = [
        Math.min(HALF_PI, Math.max(-HALF_PI, min)),
        Math.min(HALF_PI, Math.max(-HALF_PI, max)),
      ];
      const tilt = range[1] >= HALF_PI ? undefined : range[1] + HALF_PI;
      controller.maximumTiltAngle = tilt;
      pitchSet = { range, tilt };
    },
    get zoomInputs() {
      const names = [];
      for (const binding of bindingList(controller.zoomEventTypes)) {
        const name = zoomInputName(binding);
        if (name && !names.includes(name)) names.push(name);
      }
      return names;
    },
    set zoomInputs(value) {
      if (!Array.isArray(value))
        throw new TypeError('zoomInputs must be an array');
      for (const name of value)
        if (!Object.hasOwn(ZOOM_BINDINGS, name))
          throw new TypeError(`no zoom input '${name}'`);
      const kept = bindingList(controller.zoomEventTypes).filter(
        (binding) => zoomInputName(binding) === null,
      );
      controller.zoomEventTypes = [
        ...kept,
        ...[...new Set(value)].map((name) => {
          const binding = ZOOM_BINDINGS[name];
          return typeof binding === 'object' ? { ...binding } : binding;
        }),
      ];
    },
  };

  return {
    controls,
    dispose() {
      disposed = true;
      cameraInput?.release();
      cameraInput = null;
    },
  };
}
