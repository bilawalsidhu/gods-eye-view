/**
 * Cesium viewer construction and render policy.
 *
 * Two things live here and nothing else: how the globe is built, and when it is allowed
 * to draw. Everything drawn on it belongs to a layer module.
 */

import {
  Camera,
  Cartesian3,
  Color,
  Credit,
  CreditDisplay,
  ImageryLayer,
  Ion,
  Rectangle,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer,
  WebMapTileServiceImageryProvider,
  WebMercatorTilingScheme,
} from 'cesium';
import type { Cartesian2 } from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// One copy of the basemap credit, shared with the credits menu that also renders it. Two
// hand-typed copies is how a user ends up reading two different claims about the imagery.
import { GIBS_CREDIT_TEXT } from '../ui/attribution';

/**
 * Blank Cesium's bundled ion token, at import time and before any viewer exists.
 *
 * Do not put a token back here. Cesium 1.144 ships a hard-coded demo JWT whose own
 * audience claim reads "1.144 Release - Delete on October 1, 2026", so "no token
 * configured" does not mean "no token used": an ion-backed default silently works today on
 * Cesium's key and starts answering 401 on 1 October 2026, in a failure mode nothing here
 * has ever seen. Blank is what makes an accidental ion dependency fail now, loudly, on the
 * machine that introduced it. This project uses nothing from ion, and its declared
 * constraint is no API key of any kind.
 *
 * Assigned rather than deleted because the field is typed `string`, and an empty string is
 * what Cesium checks for.
 */
Ion.defaultAccessToken = '';

/**
 * Drop the ion logo from the credit display, and only the logo.
 *
 * `CreditDisplay.cesiumCredit` is the one credit routed into
 * `.cesium-credit-logoContainer`, so replacing it removes the logo without touching the
 * text container or the expand lightbox. Those two carry provider attribution, which is a
 * licence condition on several of this project's sources, so the mechanism stays.
 *
 * Crediting ion while using nothing from ion is a false credit. CesiumJS itself is
 * Apache-2.0 and asks for no logo.
 */
CreditDisplay.cesiumCredit = new Credit('', false);

/** Something with the three fields of a `Cartesian3`, which is all the axis check needs. */
interface Axis {
  x: number;
  y: number;
  z: number;
}

/**
 * Whether a rotation axis has no direction, so rotating about it means nothing.
 *
 * A rotation about a zero-length axis is the identity, and a rotation about a non-finite one is
 * not a rotation at all. Cesium has no opinion on either: `Camera.rotate` hands the axis to
 * `Quaternion.fromAxisAngle`, which normalises it, divides by a zero magnitude, gets NaN and
 * throws `DeveloperError: normalized result is not a number`. That kills the render loop and puts
 * Cesium's red "Rendering has stopped" panel over the map until the page is reloaded.
 */
export function isDegenerateAxis(axis: Axis | undefined): boolean {
  if (axis === undefined) {
    return true;
  }
  const { x, y, z } = axis;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return true;
  }
  return x === 0 && y === 0 && z === 0;
}

/**
 * Supply the degenerate case Cesium's zoom is missing, at import time and before any viewer.
 *
 * **Where the crash comes from.** In `ScreenSpaceCameraController`'s `handleZoom`, above 1,000km
 * of camera height, the "rotating zoom" pulls the point under the cursor towards the middle of
 * the screen:
 *
 * ```
 * const positionNormal = normalize(centerPosition);            // pick at the screen centre
 * const pickedNormal   = normalize(object._zoomWorldPosition);  // pick under the cursor
 * const dotProduct     = dot(pickedNormal, positionNormal);
 * if (dotProduct > 0 && dotProduct < 1) {
 *   const axis = cross(pickedNormal, positionNormal);
 *   camera.rotate(axis, angle * scalar);
 * }
 * ```
 *
 * The guard is meant to exclude the parallel case, where there is nothing to rotate about. It
 * does not, and the reason is floating point rather than geometry. Once the rotating zoom has
 * converged, the two vectors are the *same* unit vector; `cross` of a vector with itself is
 * exactly zero because each term cancels term-for-term, while `dot` is `x*x + y*y + z*z`, which
 * for a normalised vector rounds either side of one. When it rounds to 0.9999999999999999 the
 * guard passes with an axis of no length, and `normalize` throws.
 *
 * Measured over 500,000 randomised camera-and-target pairs sharing a line through the earth's
 * centre: the two normals came out bit-identical 22% of the time, and 7.2% of all pairs both
 * passed the guard and produced an exactly zero axis. So it is a one-in-fourteen coin flip taken
 * every time a scroll-zoom converges, which is what makes it feel random. It fires only above
 * 1,000km, and this app now opens at 20,000km, so an ordinary scroll in from the default view
 * walks through the exposed band every session.
 *
 * **Why patch a third-party prototype.** There is no supported way out. The axis is a local
 * inside `handleZoom`; the rotating zoom has no public switch; and `enableZoom` off would cost
 * the feature rather than fix it. Nothing here changes documented behaviour: rotating about an
 * axis of no length is the identity, so skipping it is the correct answer and not a workaround.
 * `Ion.defaultAccessToken` above is the precedent for correcting a Cesium default here.
 *
 * Delete this the day Cesium guards the axis itself. `scene.renderError` recovery in
 * `createGlobe` stays either way: it covers every other way a frame can throw, not just this one.
 */
/*
 * An assignment rather than a call, matching `Ion.defaultAccessToken` above, so this stays a
 * top-level correction to a Cesium default rather than a side effect hidden in a function.
 *
 * The one disable is load-bearing: the original has to be captured before the patch, or the
 * replacement recurses into itself.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method -- captured to delegate to, never called free.
const rotateAboutAxis = Camera.prototype.rotate;
Camera.prototype.rotate = function guardedRotate(
  this: Camera,
  axis: Cartesian3,
  angle?: number,
): void {
  if (isDegenerateAxis(axis)) {
    return;
  }
  rotateAboutAxis.call(this, axis, angle);
};

const GIBS_LAYER = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';

/**
 * The braced names left in are Cesium's own placeholders and it fills them in per tile.
 *
 * Concatenated rather than assembled with `String.replace`, which treats `$&` and friends
 * in the replacement as substitution patterns and would silently rewrite the URL, and
 * rather than as a template literal, where `{Time}` reads as a mistyped `${Time}`.
 */
const GIBS_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/' +
  GIBS_LAYER +
  '/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg';

const GIBS_TILE_MATRIX_SET = 'GoogleMapsCompatible_Level9';

const GIBS_MAXIMUM_LEVEL = 8;
/** Level 9 is the deepest this matrix set publishes, and level indices are zero-based. */

/**
 * The date whose imagery to request, as `YYYY-MM-DD` in UTC.
 *
 * Yesterday, not today. GIBS builds a day's mosaic as the satellite passes land, so a
 * request for the current date returns black gaps over everywhere the spacecraft has not
 * reached yet, which reads as a broken globe rather than as missing data.
 */
export function imageryDate(now: Date = new Date()): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

/**
 * NASA GIBS true-colour imagery. No Cesium ion token and no API key of any kind.
 */
export function gibsImagery(date: string = imageryDate()): WebMapTileServiceImageryProvider {
  return new WebMapTileServiceImageryProvider({
    url: GIBS_URL,
    layer: GIBS_LAYER,
    style: 'default',
    format: 'image/jpeg',
    tileMatrixSetID: GIBS_TILE_MATRIX_SET,
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: GIBS_MAXIMUM_LEVEL,
    // Web Mercator has no imagery beyond about 85 degrees, so asking for the poles just
    // produces failed tile requests.
    rectangle: Rectangle.fromDegrees(-180, -85, 180, 85),
    dimensions: { Time: date },
    credit: new Credit(GIBS_CREDIT_TEXT),
    enablePickFeatures: false,
  });
}

/**
 * How many times a render error is recovered from before the map is left alone.
 *
 * Bounded because recovery replays the frame that threw. If the camera is genuinely wedged rather
 * than momentarily degenerate, retrying for ever would spin the loop throwing and restarting, and
 * a hung tab is worse than a stopped one. Three is enough to ride out a transient and few enough
 * to be over inside a frame or two.
 */
export const MAX_RENDER_RECOVERIES = 3;

/** Whether a camera pose is safe to restore, which means every component is a real number. */
export function isUsablePose(pose: {
  position: Cartesian3;
  direction: Cartesian3;
  up: Cartesian3;
}): boolean {
  return [pose.position, pose.direction, pose.up].every(
    (vector) => Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z),
  );
}

/**
 * Whether the watchdog should restart a stopped render loop.
 *
 * Its own function because this is where a recovery goes wrong, and none of the four ways is
 * obvious from the call site. Restart a destroyed viewer and it throws; restart a hidden tab and
 * the recovery fights this file's own power saving, turning the GPU back on every frame the tab is
 * in the background; restart without a budget and a genuinely wedged camera spins the loop for ever.
 */
export function shouldRestartLoop(state: {
  destroyed: boolean;
  loopRunning: boolean;
  hidden: boolean;
  recoveries: number;
}): boolean {
  if (state.destroyed || state.loopRunning || state.hidden) {
    return false;
  }
  return state.recoveries < MAX_RENDER_RECOVERIES;
}

export interface GlobeHandle {
  viewer: Viewer;
  /** Ask for one frame. Called whenever data changes, because render mode is on demand. */
  requestRender: () => void;
  destroy: () => void;
}

/**
 * Build the globe.
 *
 * `requestRenderMode` is on, so an idle scene costs nothing and every change has to ask
 * for a frame. The widgets that imply a time dimension (animation, timeline) are off:
 * phase 1 shows live positions only, and a timeline the user can scrub would be lying.
 */
export function createGlobe(container: HTMLElement): GlobeHandle {
  const viewer = new Viewer(container, {
    // The first three options are the ion touchpoints. Left at their defaults, Cesium
    // fetches world imagery from ion asset 2, offers a base layer picker whose first
    // eleven entries are ion assets, and builds an ion geocoder. Terrain is not a fourth:
    // the globe defaults to `EllipsoidTerrainProvider` and only reaches ion if `terrain`
    // or `terrainProvider` is passed, so neither is passed. The globe is smooth, and for a
    // scene of aircraft at altitude, ships at sea level and satellites in orbit nothing
    // touches the ground, so relief would buy a horizon silhouette and nothing else.
    baseLayer: new ImageryLayer(gibsImagery()),
    baseLayerPicker: false,
    geocoder: false,
    animation: false,
    timeline: false,
    homeButton: false,
    fullscreenButton: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    vrButton: false,
    // The card is our own docked panel; Cesium's floating info box and selection ring
    // are the pattern we are deliberately not using.
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: true,
    // Nothing in the scene is time-dynamic, so the clock alone must never trigger a
    // frame. Dead reckoning asks for its own renders.
    maximumRenderTimeChange: Infinity,
    // Cesium's own answer to a throw inside a frame is a red "Rendering has stopped" panel over
    // the map, which is the worst thing this app can show: it is unrecoverable without a reload
    // and it is the first thing a viewer would read as the whole product being broken. Off here,
    // and the `renderError` handler below does the recovering instead.
    showRenderLoopErrors: false,
  });

  // Dark and low-chroma so the map reads as context. Saturated colour belongs to
  // entities and alerts.
  viewer.scene.globe.baseColor = Color.fromCssColorString('#0a1017');
  viewer.scene.globe.showGroundAtmosphere = false;
  viewer.scene.backgroundColor = Color.fromCssColorString('#05080c');
  viewer.scene.highDynamicRange = false;

  viewer.camera.setView({
    /*
     * The whole Earth, on the Greenwich meridian. Specified by Alexander Fanthome on
     * 2026-08-20: the app opened 2,400km over London, which frames a few thousand kilometres
     * of Europe and no globe at all, and his complaint was that he could not see one.
     *
     * **Why 20,000km.** The disc fits when its angular radius is inside half the vertical
     * field of view. Cesium applies its 60-degree default fov to the wider dimension, so a
     * 1400 by 800 viewport gets a vertical fov of 2*atan(tan(30) * 800/1400), about 36.6
     * degrees, and half of that is 18.3. `sin(18.3) = R / (R + h)` with R at 6,371km puts the
     * floor at roughly 13,900km, so this is that plus a third for margin: the limb stays clear
     * of the edge on a shorter window, and the rail does not overlap the globe. Measured
     * rather than derived alone.
     *
     * **Two independent reasons it is the right view, both from measurements this week.** The
     * cloud layer has no usable geostationary imagery over London, which sits 80.8 degrees off
     * nadir from GOES-East where the reprojection quilts into visible stair-stepping; pulled
     * back to a globe it reads correctly. And the mover marks now scale with camera range, so
     * a wide view no longer buries the continents under a shell of satellites.
     *
     * The meridian rather than a data centroid on purpose. The aircraft feed is centred on
     * London and the vessel feeds are Northern European today, but transit and further AIS
     * sources are being added, so a camera aimed at where the data happens to be this week
     * would be wrong by next week. Longitude zero shows Europe, Africa and the Atlantic, and
     * the user can spin it.
     */
    destination: Cartesian3.fromDegrees(0, 25, 20_000_000),
  });

  const requestRender = (): void => {
    viewer.scene.requestRender();
  };

  /*
   * Recover from a throw inside a frame rather than leaving a dead globe.
   *
   * The known cause is guarded above, at `Camera.prototype.rotate`, and that is the right place
   * for it: preventing a fault beats recovering from one. This is the backstop for every other way
   * a frame can throw, and there will be others. A stutter nobody notices is an acceptable
   * outcome; a red panel over the Earth is not.
   *
   * The last pose that rendered successfully is kept, so recovery puts the camera back where the
   * user was rather than throwing them to the opening view. A frame that throws has usually
   * already corrupted the camera, which is why resuming without restoring it would just throw
   * again on the next frame.
   */
  const lastGoodPose = {
    position: Cartesian3.clone(viewer.camera.position, new Cartesian3()),
    direction: Cartesian3.clone(viewer.camera.direction, new Cartesian3()),
    up: Cartesian3.clone(viewer.camera.up, new Cartesian3()),
  };
  viewer.scene.postRender.addEventListener(() => {
    // A frame that rendered is a frame whose camera was sane. Three clones on a frame that has
    // just drawn thousands of primitives is not a cost worth optimising.
    if (!isUsablePose(viewer.camera)) {
      return;
    }
    Cartesian3.clone(viewer.camera.position, lastGoodPose.position);
    Cartesian3.clone(viewer.camera.direction, lastGoodPose.direction);
    Cartesian3.clone(viewer.camera.up, lastGoodPose.up);
  });

  let recoveries = 0;
  const restore = (reason: string, error: unknown): void => {
    recoveries += 1;
    // Logged rather than swallowed. A silent recovery is how a real fault goes unnoticed for a
    // week, and `no-console` allows `error` for exactly this.
    console.error(
      `Recovered the globe after ${reason} (${recoveries} of ${MAX_RENDER_RECOVERIES}):`,
      error,
    );
    if (isUsablePose(lastGoodPose)) {
      // Written straight onto the camera rather than through `setView`, which reads the camera it
      // is about to replace and throws when that camera is the non-finite one we are here to fix.
      // The first version of this used `setView` and the exception it raised escaped the animation
      // frame, so the watchdog re-armed itself never and recovered exactly once, badly. These are
      // the same four vectors Cesium's own `Camera.rotate` assigns, `right` recomputed from the
      // other two to keep the basis consistent.
      Cartesian3.clone(lastGoodPose.position, viewer.camera.position);
      Cartesian3.clone(lastGoodPose.direction, viewer.camera.direction);
      Cartesian3.clone(lastGoodPose.up, viewer.camera.up);
      Cartesian3.cross(viewer.camera.direction, viewer.camera.up, viewer.camera.right);
    }
    // Ordered after the camera restore, or the very next frame throws on the same pose.
    viewer.useDefaultRenderLoop = true;
    requestRender();
  };

  /*
   * Watch for the render loop having stopped, and start it again.
   *
   * This is the hook that actually catches the fault, and finding that out took a measurement.
   * `scene.renderError` is the obvious candidate and it is the wrong one: `Scene.render` wraps its
   * own work and raises that event, but the camera controller runs in `Scene.initializeFrame`,
   * which the widget calls *before* `scene.render` and which sits outside that try. The stack from
   * the live crash says so in its last frame. So a throw from the zoom is seen only by
   * `CesiumWidget`'s own catch, which sets `useDefaultRenderLoop` to false and, with
   * `showRenderLoopErrors` off, stops silently. Verified by poisoning the camera in a built bundle:
   * no error panel, no `renderError`, loop stopped, globe dead.
   *
   * A silently dead globe is worse than the red panel, so turning the panel off is only half a fix
   * and this is the other half. Checking a boolean once a frame is free next to a Cesium frame.
   */
  let watchdogFrame = 0;
  const watchdog = (): void => {
    // Re-armed first, before anything that could throw. A recovery attempt that raised inside this
    // callback would otherwise take the watchdog with it and leave the globe dead after one try,
    // which is exactly what the first version of this did.
    watchdogFrame = requestAnimationFrame(watchdog);
    const restart = shouldRestartLoop({
      destroyed: viewer.isDestroyed(),
      loopRunning: viewer.useDefaultRenderLoop,
      // A hidden tab stops its own loop on purpose, just below. Restarting that would be fighting
      // this file's own power saving rather than recovering from anything.
      hidden: document.visibilityState === 'hidden',
      recoveries,
    });
    if (restart) {
      restore('a render error stopped the loop', undefined);
    }
  };
  watchdogFrame = requestAnimationFrame(watchdog);

  // Kept as well, for throws that happen inside `Scene.render` proper rather than in
  // `initializeFrame`. Cesium raises this one without stopping the loop, so it is a different
  // failure with the same remedy, and it costs one listener.
  viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
    if (recoveries < MAX_RENDER_RECOVERIES) {
      restore('a render error', error);
    }
  });

  // A hidden tab must not burn a GPU. Cesium keeps its own requestAnimationFrame loop
  // running otherwise, and browsers throttle rather than stop it.
  const onVisibilityChange = (): void => {
    const visible = document.visibilityState !== 'hidden';
    viewer.useDefaultRenderLoop = visible;
    if (visible) {
      requestRender();
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  onVisibilityChange();

  return {
    viewer,
    requestRender,
    destroy: () => {
      cancelAnimationFrame(watchdogFrame);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      viewer.destroy();
    },
  };
}

/**
 * Drive dead reckoning and ask for a frame whenever something moved.
 *
 * Its own animation frame loop rather than Cesium's `preRender`, because with
 * `requestRenderMode` on a paused scene does not raise render events and so cannot drive
 * its own interpolation. `advance` returns whether anything actually moved, so a globe
 * with nothing on it, or nothing with a track and a speed, still costs nothing.
 *
 * Returns a function that stops the loop.
 */
export function startMotionLoop(
  handle: GlobeHandle,
  advance: (nowMs: number) => boolean,
): () => void {
  let frame = 0;
  const tick = (): void => {
    if (document.visibilityState !== 'hidden' && advance(Date.now())) {
      handle.requestRender();
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
  };
}

/**
 * Report what the user clicked on the globe.
 *
 * A picked point primitive comes back with whatever `id` was set when it was created, so
 * the aircraft layer's identity travels with the primitive. A click on nothing reports
 * null, which deselects.
 */
export function installPicking(handle: GlobeHandle, onPick: (id: string | null) => void): void {
  const handler = new ScreenSpaceEventHandler(handle.viewer.scene.canvas);
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    const picked: unknown = handle.viewer.scene.pick(movement.position);
    const id: unknown = (picked as { id?: unknown } | undefined)?.id;
    onPick(typeof id === 'string' ? id : null);
  }, ScreenSpaceEventType.LEFT_CLICK);
}
