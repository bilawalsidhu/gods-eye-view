/**
 * Sky view <-> Cesium: put the camera at the observer's eye looking along
 * (az, el), and save/restore everything Sky mode touches so "Back to map"
 * returns the camera, frustum, inputs, clock and scene toggles exactly.
 *
 * Everything that changes is listed in snapshotScene(); nothing else is
 * written. Layer toggles are never touched (Sky only overrides scene display
 * flags in a scoped way and puts them back on exit).
 */
import { DEG, azElToHeadingPitch, headingPitchToAzEl } from './skyMath.js';
import { observerEyeHeight } from './observer.js';

/** Copy of the camera pose and frustum fov (world frame + current transform). */
export function snapshotCamera(Cesium, camera) {
  return {
    transform: Cesium.Matrix4.clone(camera.transform),
    position: Cesium.Cartesian3.clone(camera.position),
    direction: Cesium.Cartesian3.clone(camera.direction),
    up: Cesium.Cartesian3.clone(camera.up),
    right: Cesium.Cartesian3.clone(camera.right),
    fov: camera.frustum?.fov,
    near: camera.frustum?.near,
    far: camera.frustum?.far,
  };
}

/** Put a snapshot back exactly (same transform, pose and frustum). */
export function restoreCamera(Cesium, camera, snap) {
  if (!snap) return;
  camera.lookAtTransform(snap.transform);
  Cesium.Cartesian3.clone(snap.position, camera.position);
  Cesium.Cartesian3.clone(snap.direction, camera.direction);
  Cesium.Cartesian3.clone(snap.up, camera.up);
  Cesium.Cartesian3.clone(snap.right, camera.right);
  const frustum = camera.frustum;
  if (frustum) {
    if (Number.isFinite(snap.fov) && 'fov' in frustum) frustum.fov = snap.fov;
    if (Number.isFinite(snap.near)) frustum.near = snap.near;
    if (Number.isFinite(snap.far)) frustum.far = snap.far;
  }
}

/** The camera at the observer's eye looking along the view. */
export function applySkyCamera(Cesium, camera, observer, view) {
  const orientation = azElToHeadingPitch(view.azDeg, view.elDeg, view.rollDeg);
  if (!Cesium.Matrix4.equals(camera.transform, Cesium.Matrix4.IDENTITY))
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      observer.lonDeg,
      observer.latDeg,
      observerEyeHeight(observer),
    ),
    orientation,
  });
  if (camera.frustum && 'fov' in camera.frustum)
    camera.frustum.fov = view.fovDeg * DEG;
}

/**
 * az/el from Cesium's heading/pitch getters. Within ~2 deg of the zenith
 * Cesium's heading getter reports heading + 180 (it reads the up vector
 * there); use worldDirectionToAzEl for the true look direction.
 */
export function readCameraAzEl(camera) {
  return headingPitchToAzEl(camera.heading, camera.pitch);
}

/**
 * Independent check: az/el of a world direction at a world position via the
 * ENU frame (not via camera.heading), so tests do not just read back inputs.
 */
export function worldDirectionToAzEl(Cesium, position, direction) {
  const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const fixedToEnu = Cesium.Matrix4.inverseTransformation(
    enuToFixed,
    new Cesium.Matrix4(),
  );
  const d = Cesium.Matrix4.multiplyByPointAsVector(
    fixedToEnu,
    direction,
    new Cesium.Cartesian3(),
  );
  const horizontal = Math.hypot(d.x, d.y);
  let az = Math.atan2(d.x, d.y) / DEG;
  if (az < 0) az += 360;
  return { azDeg: az, elDeg: Math.atan2(d.z, horizontal) / DEG };
}

const isTileset = (Cesium, primitive) =>
  Boolean(Cesium.Cesium3DTileset) &&
  primitive instanceof Cesium.Cesium3DTileset;

/** Scene flags Sky mode may change, and the clock. */
export function snapshotScene(Cesium, viewer, { nowMs = Date.now() } = {}) {
  const scene = viewer.scene;
  const globe = scene.globe;
  const tilesets = [];
  const primitives = scene.primitives;
  for (let i = 0; i < (primitives?.length ?? 0); i++) {
    const primitive = primitives.get(i);
    if (isTileset(Cesium, primitive))
      tilesets.push({ primitive, show: primitive.show });
  }
  const clock = viewer.clock;
  return {
    globeShow: globe?.show,
    enableLighting: globe?.enableLighting,
    dynamicAtmosphereLighting: globe?.dynamicAtmosphereLighting,
    dynamicAtmosphereLightingFromSun: globe?.dynamicAtmosphereLightingFromSun,
    skyBoxShow: scene.skyBox?.show,
    skyAtmosphereShow: scene.skyAtmosphere?.show,
    enableInputs: scene.screenSpaceCameraController?.enableInputs,
    enableCollisionDetection:
      scene.screenSpaceCameraController?.enableCollisionDetection,
    tilesets,
    clock: clock
      ? {
          currentTime: Cesium.JulianDate.clone(clock.currentTime),
          shouldAnimate: clock.shouldAnimate,
          multiplier: clock.multiplier,
          savedAtMs: nowMs,
        }
      : null,
  };
}

/**
 * Put every saved flag back. A clock that was running keeps running from
 * where it would be now (no time jump back); a stopped clock gets its exact
 * saved instant.
 */
export function restoreScene(
  Cesium,
  viewer,
  snap,
  { nowMs = Date.now() } = {},
) {
  if (!snap) return;
  const scene = viewer.scene;
  const globe = scene.globe;
  const set = (target, key, value) => {
    if (target && value !== undefined) target[key] = value;
  };
  set(globe, 'show', snap.globeShow);
  set(globe, 'enableLighting', snap.enableLighting);
  set(globe, 'dynamicAtmosphereLighting', snap.dynamicAtmosphereLighting);
  set(
    globe,
    'dynamicAtmosphereLightingFromSun',
    snap.dynamicAtmosphereLightingFromSun,
  );
  set(scene.skyBox, 'show', snap.skyBoxShow);
  set(scene.skyAtmosphere, 'show', snap.skyAtmosphereShow);
  set(scene.screenSpaceCameraController, 'enableInputs', snap.enableInputs);
  set(
    scene.screenSpaceCameraController,
    'enableCollisionDetection',
    snap.enableCollisionDetection,
  );
  for (const { primitive, show } of snap.tilesets) {
    if (!primitive.isDestroyed?.()) primitive.show = show;
  }
  const clock = viewer.clock;
  if (clock && snap.clock) {
    const elapsedS = snap.clock.shouldAnimate
      ? ((nowMs - snap.clock.savedAtMs) / 1000) * (snap.clock.multiplier || 1)
      : 0;
    clock.currentTime = Cesium.JulianDate.addSeconds(
      snap.clock.currentTime,
      elapsedS,
      new Cesium.JulianDate(),
    );
    clock.shouldAnimate = snap.clock.shouldAnimate;
    clock.multiplier = snap.clock.multiplier;
  }
  scene.requestRender?.();
}

/**
 * Scene display for Sky mode. Real horizon: globe/tiles as they were (they
 * form the silhouette). Flat horizon: hide the globe and every 3D tileset so
 * the overlay paints a clean ground. Lighting follows the Sun so Cesium's
 * atmosphere goes blue -> dusk -> dark with Sky time (spike: with globe
 * lighting off Cesium lights the atmosphere from the camera = always day).
 * The Tycho-2 skybox shows only when `skyBox` (skyMath.skyBoxVisible).
 */
export function applySkyScene(
  viewer,
  snap,
  { flatHorizon = false, skyBox = false } = {},
) {
  const scene = viewer.scene;
  const globe = scene.globe;
  if (globe) {
    globe.show = flatHorizon ? false : snap.globeShow;
    globe.enableLighting = true;
    if ('dynamicAtmosphereLighting' in globe)
      globe.dynamicAtmosphereLighting = true;
    if ('dynamicAtmosphereLightingFromSun' in globe)
      globe.dynamicAtmosphereLightingFromSun = true;
  }
  for (const { primitive, show } of snap.tilesets) {
    if (!primitive.isDestroyed?.()) primitive.show = flatHorizon ? false : show;
  }
  if (scene.skyAtmosphere && snap.skyAtmosphereShow !== undefined)
    scene.skyAtmosphere.show = snap.skyAtmosphereShow;
  if (scene.skyBox && snap.skyBoxShow !== undefined)
    scene.skyBox.show = Boolean(skyBox);
  const controller = scene.screenSpaceCameraController;
  if (controller) {
    controller.enableInputs = false;
    // Cesium's terrain collision runs even with inputs off and lifts a
    // ground-level eye onto whatever is under it (seen: +138 m in downtown
    // Houston on the smoke test); the observer height is ours to set.
    if ('enableCollisionDetection' in controller)
      controller.enableCollisionDetection = false;
  }
  scene.requestRender?.();
}

/**
 * Whether Sky mode leaves third-party map tiles on screen (imagery and
 * terrain on the globe, Google / buildings 3D tiles), i.e. whether their
 * attribution must stay visible in Clear view. Flat horizon
 * hides the globe and every tileset (applySkyScene), so only Sky's own
 * star/planet canvas is drawn. A real horizon keeps them as they were.
 * When it cannot tell (no snapshot, globe flag unknown) the answer is true.
 */
export function skyTilesShown(snap, { flatHorizon = false } = {}) {
  if (flatHorizon) return false;
  if (!snap || snap.globeShow !== false) return true;
  return (snap.tilesets ?? []).some(
    ({ primitive, show }) => show && !primitive?.isDestroyed?.(),
  );
}

/** Drive Cesium's clock from Sky time (stopped; Sky owns time while active). */
export function applySkyTime(Cesium, viewer, timeMs) {
  const clock = viewer.clock;
  if (!clock || !Number.isFinite(timeMs)) return;
  clock.shouldAnimate = false;
  clock.currentTime = Cesium.JulianDate.fromDate(new Date(timeMs));
  viewer.scene.requestRender?.();
}
