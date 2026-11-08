// camera.follow on Cesium: the viewer's trackedEntity (Cesium's EntityView
// owns the continuous follow, the user turns and zooms around the target).
// A `native` Entity is tracked itself; otherwise an internal proxy Entity
// (ENU frame) whose position is the caller's `position()`, which shows a
// non-Entity native's tracked-readout fields. Each follow gets
// one exact tracked frame on preUpdate (applyTrackedCameraFrame) and the
// zoom limits that keep the camera outside the minimum range.
// following() also reports a trackedEntity the app set itself, and
// followChanged is viewer.trackedEntityChanged. A handle on an Entity carries
// its `name` (the Entity's name, else its id): what the camera verbs say they
// are following.

import { swingFollowOffset } from './followOffset.js';
import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';
import { createEngineEvent } from '../contract.js';
import {
  MIN_FOLLOW_RANGE_M,
  clampTrackedCameraPosition,
  normalizeFollowOptions,
} from '../follow.js';
import { toCesium3 } from './convert.js';

const MAX_FRAME_ATTEMPTS = 120;
const entityName = (entity) => (entity ? entity.name || entity.id : undefined);
// What viewer.trackedEntity readers take from a tracked Entity, read through
// a proxy from the layer's own handle. gevRestoring marks a follow that
// rebinds the session's own subject (a resumed renderer, a share restore)
// while it starts: trackedEntityChanged readers (the shell's navigation
// stamp) must see it on the proxy, or a resumed follow supersedes the
// restore it belongs to.
const READOUT_FIELDS = [
  'gevTrackedId',
  'gevLabelModel',
  'gevDisplayPosition',
  'gevVisualPosition',
  'gevSelectionOrigin',
  'gevRestoring',
];
const ZOOM_INERTIA_STATES = new WeakMap();

function acquireStableTrackedZoom(controller, owner, minRange) {
  if (!controller) return () => {};
  let state = ZOOM_INERTIA_STATES.get(controller);
  if (!state) {
    state = {
      originalInertiaZoom: controller.inertiaZoom,
      originalMinimumZoomDistance: controller.minimumZoomDistance,
      owners: new Set(),
    };
    ZOOM_INERTIA_STATES.set(controller, state);
  }
  state.owners.add(owner);
  controller.inertiaZoom = 0;
  controller.minimumZoomDistance = Math.max(
    state.originalMinimumZoomDistance ?? 0,
    minRange,
  );
  return () => {
    const current = ZOOM_INERTIA_STATES.get(controller);
    if (!current) return;
    current.owners.delete(owner);
    if (current.owners.size > 0) return;
    controller.inertiaZoom = current.originalInertiaZoom;
    controller.minimumZoomDistance = current.originalMinimumZoomDistance;
    ZOOM_INERTIA_STATES.delete(controller);
  };
}

// The position the tracked visual already drew (the flight layers' display
// cache), without advancing its CallbackProperty again.
function displayPosition(entity, time, result) {
  const displayed = entity?.gevDisplayPosition?.();
  return displayed
    ? geo.cartesian3.clone(displayed, result)
    : entity?.position?.getValue(time, result);
}

/**
 * Apply an entity's requested follow offset once, then let Cesium's ENU
 * EntityView exclusively own continuous following.
 *
 * Cesium can retain the previous world-space camera position when tracking
 * switches across a large distance. The view then only rotates toward the new
 * aircraft, and the next zoom can drive the camera through the ellipsoid.
 * Applying the exact frame for the handoff makes selection deterministic. We
 * deliberately do not rebuild it every frame: Cesium's EntityView already
 * follows the same ENU entity, and two writers create sub-pixel camera jitter
 * that becomes visible at minimum range.
 *
 * @param {Cesium.Viewer} viewer Active viewer.
 * @param {Cesium.Entity} entity Newly tracked entity.
 * @param {Cesium.Cartesian3 | Cesium.Property} viewFrom Desired camera offset
 *   in the tracked frame.
 * @param {{ minRange?: number }} [options]
 * @returns {(() => void)|undefined} Disposer for this one tracked-frame owner.
 */
export function applyTrackedCameraFrame(
  viewer,
  entity,
  viewFrom,
  { minRange = MIN_FOLLOW_RANGE_M } = {},
) {
  if (!viewer || !entity || !viewFrom) return;
  let attempts = 0;
  const trackedTransform = geo.matrix4.create();
  const trackedPosition = geo.cartesian3.create();
  const resolvedViewFrom = geo.cartesian3.create();
  const cameraOffset = geo.cartesian3.create();
  const previousCameraPosition = geo.cartesian3.create();
  let framed = false;
  const restoreZoomInertia = acquireStableTrackedZoom(
    viewer.scene.screenSpaceCameraController,
    entity,
    minRange,
  );
  let stopped = false;
  let remove = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    remove?.();
    restoreZoomInertia();
  };

  // preUpdate is deliberate. preRender fires after Cesium has prepared
  // billboard/model draw state, so changing the tracked transform there makes
  // the camera and target visual disagree for one frame (visible as a
  // front/back oscillation). The controller then enforces the minimum range
  // during the same update pass.
  remove = viewer.scene.preUpdate.addEventListener(() => {
    if (viewer.isDestroyed() || viewer.trackedEntity !== entity) {
      stop();
      return;
    }
    attempts += framed ? 0 : 1;
    // Prefer the display cache exposed by the flight layer. Calling the
    // CallbackProperty from preUpdate can advance dead reckoning again while
    // Cesium's billboard/label still holds the prior visualizer sample. At a
    // 150 m follow range that sub-frame difference becomes visible as the
    // label swinging around the icon during an orbit, especially immediately
    // after a 2D→3D→2D handoff.
    if (!framed) {
      const position = displayPosition(
        entity,
        viewer.clock.currentTime,
        trackedPosition,
      );
      if (!position) {
        if (attempts >= MAX_FRAME_ATTEMPTS) stop();
        return;
      }
      const transform = geo.transforms.eastNorthUpToFixedFrame(
        position,
        geo.ellipsoid.WGS84,
        trackedTransform,
      );
      const offset =
        typeof viewFrom.getValue === 'function'
          ? viewFrom.getValue(viewer.clock.currentTime, resolvedViewFrom)
          : geo.cartesian3.clone(viewFrom, resolvedViewFrom);
      if (
        !offset ||
        geo.cartesian3.magnitudeSquared(offset) < geo.math.EPSILON12
      ) {
        stop();
        return;
      }
      viewer.camera.lookAtTransform(transform, offset);
      geo.cartesian3.clone(viewer.camera.position, previousCameraPosition);
      framed = true;
      return;
    }

    // Normal frames are intentionally read-only: EntityView is the sole
    // continuous camera writer. Only a programmatic zoom that bypasses the
    // controller's minimumZoomDistance needs correction.
    if (
      clampTrackedCameraPosition(
        viewer.camera,
        previousCameraPosition,
        minRange,
      )
    ) {
      geo.cartesian3.clone(viewer.camera.position, cameraOffset);
      viewer.camera.lookAtTransform(viewer.camera.transform, cameraOffset);
    }
    geo.cartesian3.clone(viewer.camera.position, previousCameraPosition);
  });
  return stop;
}

/**
 * @param {Cesium.Viewer} viewer
 * @param {{ commanded: object }} ports The engine camera's commanded event.
 */
export function createCesiumFollow(viewer, { commanded }) {
  const followChanged = createEngineEvent();
  // The follow this engine started.
  let own = null;
  // Handles for entities the app tracked itself, one per entity.
  const wrapped = new WeakMap();
  let switching = false;
  let stopExternalSwing = null;

  const wrap = (entity) => {
    let handle = wrapped.get(entity);
    if (!handle) {
      handle = {
        native: entity,
        get name() {
          return entityName(entity);
        },
        target: () =>
          displayPosition(entity, viewer.clock.currentTime, undefined),
        stop() {
          if (viewer.trackedEntity === entity) viewer.trackedEntity = undefined;
        },
        retarget(next) {
          if (viewer.trackedEntity !== entity) return;
          const options = normalizeFollowOptions({
            native: entity,
            position: handle.target,
            viewFrom: () =>
              entity.viewFrom?.getValue?.(viewer.clock.currentTime) ??
              entity.viewFrom,
            ...next,
          });
          if (!Object.keys(next).every((key) => key === 'swingTo'))
            return follow(options);
          watchTracking();
          stopExternalSwing?.();
          if (!options.swingTo) return;
          const stop = swingFollowOffset(
            viewer,
            entity,
            options.swingTo,
            handle.target,
          );
          const offCommand = commanded.addEventListener(() =>
            stopExternalSwing?.(),
          );
          stopExternalSwing = () => {
            stop();
            offCommand();
            stopExternalSwing = null;
          };
        },
      };
      wrapped.set(entity, handle);
    }
    return handle;
  };

  const following = () => {
    const entity = viewer.trackedEntity;
    if (!entity) return null;
    if (own && own.entity === entity) return own.handle;
    return wrap(entity);
  };

  // followChanged rides on trackedEntityChanged, subscribed once something
  // listens or follows (creating the engine subscribes nothing).
  let removeTracked = null;
  const onTracked = () => {
    if (switching) return;
    stopExternalSwing?.();
    if (own && viewer.trackedEntity !== own.entity) release(own);
    followChanged.raiseEvent(following());
  };
  const watchTracking = () => {
    if (removeTracked || !viewer.trackedEntityChanged) return;
    removeTracked = viewer.trackedEntityChanged.addEventListener(onTracked);
  };
  const addListener = followChanged.addEventListener;
  followChanged.addEventListener = (listener) => {
    watchTracking();
    return addListener(listener);
  };

  // Undo what one follow put on the viewer (not trackedEntity itself).
  function teardown(state) {
    state.stopSwing?.();
    state.stopSwing = null;
    state.stopFrame?.();
    state.stopFrame = null;
    state.removeCommanded?.();
    state.removeCommanded = null;
    if (state.proxy) viewer.entities.remove(state.proxy);
    state.proxy = null;
  }
  function release(state) {
    if (own !== state) return;
    own = null;
    teardown(state);
  }

  function start(state, options) {
    state.options = options;
    const { native } = options;
    let entity = native instanceof Cesium.Entity ? native : null;
    if (!entity) {
      const scratch = new Cesium.Cartesian3();
      entity = state.proxy = viewer.entities.add({
        position: new Cesium.CallbackProperty(() => {
          let position;
          try {
            position = state.options.position();
          } catch {
            return undefined;
          }
          return position
            ? Cesium.Cartesian3.clone(toCesium3(position), scratch)
            : undefined;
        }, false),
        viewFrom: toCesium3(state.options.viewFrom()),
        trackingReferenceFrame: Cesium.TrackingReferenceFrame.ENU,
        // Cesium's EntityView moves the camera only once the tracked
        // entity has a bounding sphere: a 1 px transparent point gives it
        // one (an entity without graphics is framed once, then left).
        point: { pixelSize: 1, color: Cesium.Color.TRANSPARENT },
      });
      // Picks skip it (picker.js).
      entity.gevFollowProxy = true;
      if (native)
        for (const field of READOUT_FIELDS)
          Object.defineProperty(entity, field, {
            get: () => native[field],
            set: (value) => {
              native[field] = value;
            },
          });
    }
    state.entity = entity;
    state.handle.native = native;
    state.handle.label = options.label;
    viewer.camera.cancelFlight();
    viewer.trackedEntity = entity;
    const viewFrom =
      entity === native && native.viewFrom
        ? native.viewFrom
        : toCesium3(state.options.viewFrom());
    state.stopFrame =
      applyTrackedCameraFrame(viewer, entity, viewFrom, {
        minRange: options.minRange,
      }) ?? null;
    if (options.swingTo)
      state.stopSwing = swingFollowOffset(viewer, entity, options.swingTo, () =>
        displayPosition(entity, viewer.clock.currentTime),
      );
    // A command that takes the camera ends the follow; so does another
    // tracked entity (Cesium raises commanded for that too).
    state.removeCommanded = commanded.addEventListener(() => {
      if (switching || own !== state) return;
      if (viewer.trackedEntity === state.entity)
        viewer.trackedEntity = undefined;
      release(state);
    });
    viewer.scene.requestRender();
  }

  function follow(input) {
    const options = normalizeFollowOptions(input);
    stopExternalSwing?.();
    watchTracking();
    if (own) {
      const previous = own;
      own = null;
      teardown(previous);
    }
    const state = { entity: null, proxy: null, options, handle: null };
    state.handle = {
      native: options.native,
      get name() {
        return entityName(state.handle.native);
      },
      target() {
        try {
          return state.options.position();
        } catch {
          return undefined;
        }
      },
      stop() {
        if (own !== state) return;
        if (viewer.trackedEntity === state.entity)
          viewer.trackedEntity = undefined;
        release(state);
      },
      retarget(next) {
        if (own !== state) return;
        const updated = normalizeFollowOptions({ ...state.options, ...next });
        if (Object.keys(next).every((key) => key === 'swingTo')) {
          state.options = updated;
          state.stopSwing?.();
          state.stopSwing = updated.swingTo
            ? swingFollowOffset(viewer, state.entity, updated.swingTo, () =>
                displayPosition(state.entity, viewer.clock.currentTime),
              )
            : null;
          return;
        }
        switching = true;
        try {
          teardown(state);
          start(state, updated);
        } finally {
          switching = false;
        }
        followChanged.raiseEvent(state.handle);
      },
    };
    own = state;
    // Assigning trackedEntity raises followChanged with this handle.
    start(state, options);
    return state.handle;
  }

  return {
    camera: { follow, following, followChanged },
    destroy() {
      stopExternalSwing?.();
      if (own) {
        const state = own;
        if (viewer.trackedEntity === state.entity)
          viewer.trackedEntity = undefined;
        release(state);
      }
      removeTracked?.();
      removeTracked = null;
    },
  };
}
