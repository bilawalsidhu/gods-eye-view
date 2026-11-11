import * as geo from '../../geo/index.js';
import {
  plausibleSurfaceHeight,
  sampledSurfaceHeight,
  terrainSurfaceHeight,
} from './view.js';

/** Fly the globe camera once to frame a photo after it opens. */
export function createCameraFraming({ state }) {
  /**
   * The application's camera authority: `reassert(begin())` succeeds only if
   * nothing newer took the camera. Without it, framing flies directly.
   */
  let navigation = null;
  /** Our framing flight while it is current; the engine calls `cancel` when another flight starts. */
  let flight = null;

  function attachNavigation(next) {
    navigation = next || null;
  }

  /** Ask for the camera as a photo starts opening: a ticket for `frame`, null when refused (cockpit). */
  function begin() {
    if (!navigation?.begin || !navigation.reassert) return { generation: null };
    const generation = navigation.begin('photo');
    return generation === false ? null : { generation };
  }

  /**
   * Ground under a photo. `sampleHeight` can return kilometres below the
   * ellipsoid before tiles load, so only a plausible height counts.
   */
  function groundHeightAt(lon, lat, fallback) {
    const engine = state.map?.engine;
    const carto = geo.cartographic.fromDegrees(lon, lat);
    let height = sampledSurfaceHeight(engine, carto);
    if (height === null) height = terrainSurfaceHeight(engine, carto);
    if (!plausibleSurfaceHeight(height)) height = fallback;
    return plausibleSurfaceHeight(height) ? height : 0;
  }

  /**
   * Frame the open photo from a short distance behind it, unless another
   * action took the camera since `ticket` (from `begin`) was issued.
   */
  function frame(ticket) {
    const { position, bearing, altitude } = state.street;
    const engine = state.map?.engine;
    if (!ticket || !position || !engine) return;
    // Detached (shell teardown) since the ticket was issued: nothing to frame for.
    if (ticket.generation !== null && !navigation?.reassert(ticket.generation))
      return;
    const ground = groundHeightAt(position.lon, position.lat, altitude);
    // Owned before the call: starting it cancels the previous flight (ours
    // included) synchronously, and a zero-length one completes at once.
    const current = {};
    flight = current;
    const release = () => {
      if (flight === current) flight = null;
    };
    engine.camera.flyToSphere(
      {
        center: geo.cartesian3.fromDegrees(
          position.lon,
          position.lat,
          ground + 2,
        ),
        radius: 4,
      },
      {
        heading: geo.math.toRadians(bearing || 0),
        pitch: geo.math.toRadians(-32),
        range: 140,
        duration: 1.6,
        complete: release,
        cancel: release,
      },
    );
  }

  /** Stop our framing flight if it is still in the air; another feature's flight is left alone. */
  function cancel() {
    if (!flight) return;
    // Give up ownership first: cancelFlight delivers `cancel` synchronously.
    flight = null;
    state.map?.engine?.camera.cancelFlight();
  }

  return { attachNavigation, begin, frame, cancel };
}
