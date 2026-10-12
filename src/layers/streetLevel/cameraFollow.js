import * as Cesium from 'cesium';
import { FOLLOW_EYE_HEIGHT_M } from './policy.js';

/** Plausible ellipsoidal land heights: Dead Sea to Everest, with geoid slack. */
const SURFACE_MIN_M = -500;
const SURFACE_MAX_M = 9000;

/** Drive the globe camera from the street-level pose: continuously (follow) or once (framing). */
export function createCameraFollow({ state, parts }) {
  const { render } = state.services;

  function requestRender() {
    render?.governorRequestRender?.('street-level-follow');
  }

  /**
   * The application's camera authority (`attachNavigation`): `run(noun, move)`
   * releases tracking and other owners before `move`, or refuses (cockpit);
   * `begin(noun)` takes a deferred ticket (a generation, or false) that
   * `reassert(generation)` honours only if nothing newer took the camera;
   * `subscribeHandoff` reports a newer owner. Without it, moves run directly.
   */
  let navigation = null;
  let unsubscribeHandoff = null;
  /** Set while our own claim stamps a handoff, so it does not end FOLLOW. */
  let claiming = false;

  /** Take the camera for `move`; false when the application refuses. */
  function claim(move) {
    if (!navigation?.run) {
      move();
      return true;
    }
    claiming = true;
    try {
      return (
        navigation.run('photo', () => {
          move();
          return true;
        }) === true
      );
    } finally {
      claiming = false;
    }
  }

  /**
   * Ask for the camera as a photo starts opening. The ticket goes to
   * `lookAtPosition`; null when the application refuses (cockpit).
   */
  function beginFraming() {
    if (!navigation?.begin || !navigation.reassert) return { generation: null };
    claiming = true;
    try {
      const generation = navigation.begin('photo');
      return generation === false ? null : { generation };
    } finally {
      claiming = false;
    }
  }

  /** Another feature took the camera: stop following it. */
  function onHandoff() {
    if (claiming || !state.street.follow) return;
    state.street.follow = false;
    state.notify?.();
  }

  function attachNavigation(next) {
    unsubscribeHandoff?.();
    navigation = next || null;
    unsubscribeHandoff = navigation?.subscribeHandoff?.(onHandoff) || null;
  }

  /**
   * Ground under a photo. `sampleHeight` can return kilometres below the
   * ellipsoid before tiles load, so a sample counts only when plausible and
   * within the mesh window around bare earth (once that is known).
   */
  function groundHeightAt(lon, lat, fallback) {
    const scene = state.viewer?.scene;
    const carto = Cesium.Cartographic.fromDegrees(lon, lat);
    const caster = parts?.groundCaster;
    const dem = caster?.groundAt(lon, lat) ?? null;
    if (dem === null) caster?.prepare([[lon, lat]]);
    // The application's mesh window around bare earth, once that is known.
    const withinPrior = state.services.ground?.meshFloorSampleWithinPrior;
    const plausible = (height) =>
      Number.isFinite(height) &&
      height >= SURFACE_MIN_M &&
      height <= SURFACE_MAX_M &&
      (dem === null || !withinPrior || withinPrior(height, dem));
    let height = null;
    try {
      if (scene?.sampleHeightSupported) height = scene.sampleHeight(carto);
    } catch {
      /* not sampleable yet */
    }
    if (!plausible(height)) height = dem;
    if (!plausible(height)) height = scene?.globe?.getHeight?.(carto);
    if (!plausible(height)) height = fallback;
    return plausible(height) ? height : 0;
  }

  /** Put the Cesium camera where the street-level camera is. */
  function followCamera() {
    const { position, bearing, tilt, follow, altitude } = state.street;
    if (!follow || !position || !state.viewer) return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    state.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        position.lon,
        position.lat,
        ground + FOLLOW_EYE_HEIGHT_M,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(bearing || 0),
        pitch: Cesium.Math.toRadians(Number.isFinite(tilt) ? tilt : 0),
        roll: 0,
      },
    });
    requestRender();
  }

  /** Our framing flight while it is current; Cesium calls `cancel` when another flight starts. */
  let framing = null;

  /**
   * Frame the current image from a short distance behind it, unless another
   * action took the camera since `ticket` (from `beginFraming`) was issued.
   */
  function lookAtPosition(ticket) {
    const { position, bearing, altitude } = state.street;
    if (!ticket || !position || !state.viewer) return;
    if (
      ticket.generation !== null &&
      !navigation?.reassert?.(ticket.generation)
    )
      return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    const fly = () => {
      // Owned before the call: starting it cancels the previous flight (ours
      // included) synchronously, and a zero-length one completes at once.
      const flight = {};
      framing = flight;
      const release = () => {
        if (framing === flight) framing = null;
      };
      state.viewer.camera.flyToBoundingSphere(
        new Cesium.BoundingSphere(
          Cesium.Cartesian3.fromDegrees(position.lon, position.lat, ground + 2),
          4,
        ),
        {
          offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(bearing || 0),
            Cesium.Math.toRadians(-32),
            140,
          ),
          duration: 1.6,
          complete: release,
          cancel: release,
        },
      );
    };
    // A reasserted ticket has already released the other owners.
    if (ticket.generation === null) claim(fly);
    else fly();
  }

  /** Stop our framing flight if it is still in the air; another feature's flight is left alone. */
  function cancelFraming() {
    if (!framing) return;
    // Give up ownership first: cancelFlight delivers `cancel` synchronously.
    framing = null;
    state.viewer?.camera?.cancelFlight?.();
  }

  function setFollow(enabled) {
    const wanted = enabled === true && state.street.followAvailable;
    if (wanted && !state.street.follow) {
      // Following owns the camera until another feature takes it.
      const granted = claim(() => {
        state.street.follow = true;
        // The framing tween would keep overwriting the follow view until it lands.
        cancelFraming();
        followCamera();
      });
      if (!granted) state.street.follow = false;
    } else if (!wanted) {
      state.street.follow = false;
    }
    state.notify?.();
  }

  function destroy() {
    attachNavigation(null);
  }

  return {
    followCamera,
    beginFraming,
    lookAtPosition,
    cancelFraming,
    setFollow,
    attachNavigation,
    destroy,
  };
}
