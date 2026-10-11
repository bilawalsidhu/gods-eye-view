/**
 * Shared animated selection reticle.
 *
 * One HUD reticle, a red targeting ring with rotating ticks over a translucent
 * disc and inward-closing arrows (drawn in `--accent` and a fixed lock red), follows whatever the operator clicks on the
 * map. It watches clicks centrally instead of asking every layer to report its
 * selection: any pick that resolves to a live, positioned object (an entity, a
 * point, a billboard or a standalone model) gets the reticle, and it tracks that
 * object each frame. Empty space, 3D tiles and positionless geometry clear it,
 * as do the context store's deliberate-clear events for the owning layer.
 * The reticle drops itself when its object is hidden, removed or destroyed.
 *
 * It only runs while the Display panel's HUD Target is `lock` (the root
 * element's `data-hud-target`); in `default` each layer keeps its own styling.
 *
 * It is a DOM/SVG surface (no Cesium labels) placed with CSS transforms; the
 * animation runs in CSS, so it never holds the render governor continuous.
 */
import * as Cesium from 'cesium';
import { isPointerFree as defaultIsPointerFree } from '../data/inputOwnership.js';
import { HUD_TARGET_LOCKED_EVENT } from './lockSound.js';

export const SELECTION_RETICLE_ROOT_ID = 'selection-reticle-root';
const ACTIVE_CLASS = 'is-active';
const ENTER_CLASS = 'is-entering';
/** How close a layer's selection event must be to the click to own it. */
const OWNER_WINDOW_MS = 600;
const MIN_GROUND_TILT = 0.32;
// How far a replacement marker may sit from the vanished one and still count
// as the same subject (covers dead-reckoning drift on moving aircraft).
const HANDOFF_RADIUS_M = 2000;
const HUD_TARGET_EVENT = 'gev:hud-target-changed';

/**
 * Is the HUD Target set to the animated lock?
 * @param {Document} [doc]
 * @returns {boolean}
 */
export function isLockTargetEnabled(doc = globalThis.document) {
  return doc?.documentElement?.dataset?.hudTarget === 'lock';
}

const RETICLE_SVG = `
<svg class="gev-reticle__svg" viewBox="-160 -100 320 200" aria-hidden="true" focusable="false">
  <g class="gev-reticle__ground">
    <circle class="gev-reticle__disc" r="46" />
    <path class="gev-reticle__sweep" d="M0 0 L0 -46 A46 46 0 0 1 39.8 -23 Z" />
    <circle class="gev-reticle__core" r="12" />
    <circle class="gev-reticle__dot" r="5" />
    <circle class="gev-reticle__ring" r="70" pathLength="100" />
    <circle class="gev-reticle__orbit" r="80" />
    <circle class="gev-reticle__segments" r="86" pathLength="360" />
    <g class="gev-reticle__ticks">
      <path class="gev-reticle__tick gev-reticle__tick--1" d="M0 -63 L0 -77" />
      <path class="gev-reticle__tick gev-reticle__tick--2" d="M0 -63 L0 -77" />
      <path class="gev-reticle__tick gev-reticle__tick--3" d="M0 -63 L0 -77" />
    </g>
  </g>
  <g class="gev-reticle__arrows">
    <g class="gev-reticle__arrow gev-reticle__arrow--left">
      <path class="gev-reticle__bar" d="M-150 -9 L-150 9" />
      <path class="gev-reticle__dash" d="M-140 0 L-98 0" />
      <path class="gev-reticle__head" d="M-94.5 -3 L-89 0 L-94.5 3 Z" />
    </g>
    <g class="gev-reticle__arrow gev-reticle__arrow--right">
      <path class="gev-reticle__bar" d="M150 -9 L150 9" />
      <path class="gev-reticle__dash" d="M140 0 L98 0" />
      <path class="gev-reticle__head" d="M94.5 -3 L89 0 L94.5 3 Z" />
    </g>
  </g>
</svg>`;

/**
 * Pick a live stand-in for a target whose marker vanished. Layers such as
 * flights hide the clicked billboard and hand the subject to a new tracked or
 * selected entity at the same spot; the reticle should follow that hand-off
 * rather than drop the lock.
 * @param {object} viewer Cesium viewer.
 * @param {object|undefined} lastPosition Last known Cartesian3 of the target.
 * @param {object} [options]
 * @param {object} [options.cesium] Cesium namespace.
 * @param {() => object} [options.getTime] Current clock time for entities.
 * @param {unknown} [options.excludeKey] Key of the vanished target.
 * @returns {ReturnType<typeof resolvePickTarget>}
 */
export function findHandoffTarget(
  viewer,
  lastPosition,
  { cesium = Cesium, getTime = () => undefined, excludeKey } = {},
) {
  if (!viewer || !lastPosition) return null;
  for (const entity of [viewer.trackedEntity, viewer.selectedEntity]) {
    if (!entity || entity === excludeKey) continue;
    const candidate = resolvePickTarget({ id: entity }, { cesium, getTime });
    if (!candidate?.isAlive()) continue;
    const position = candidate.getPosition();
    if (
      position &&
      cesium.Cartesian3.distance(position, lastPosition) <= HANDOFF_RADIUS_M
    )
      return candidate;
  }
  return null;
}

function isClass(value, Type) {
  return typeof Type === 'function' && value instanceof Type;
}

/**
 * A pick is "alive" while the object is still shown and still owned by a
 * collection that has not been hidden or destroyed. Cesium clears a point's
 * or billboard's collection back-reference when it is removed.
 * @param {object} primitive Point, billboard or model.
 * @returns {boolean}
 */
function isPrimitiveAlive(primitive) {
  if (!primitive || primitive.show === false) return false;
  if (primitive.isDestroyed?.()) return false;
  for (const key of ['_pointPrimitiveCollection', '_billboardCollection']) {
    if (!(key in primitive)) continue;
    const collection = primitive[key];
    if (!collection || collection.isDestroyed?.()) return false;
    if (collection.show === false) return false;
  }
  return true;
}

function isEntityAlive(entity) {
  if (!entity || entity.isShowing === false || entity.show === false)
    return false;
  const owner = entity.entityCollection?.owner;
  if (owner && owner.show === false) return false;
  return true;
}

/**
 * Turn a `scene.pick` result into a live reticle target.
 * @param {object|undefined} picked Pick result.
 * @param {object} [options]
 * @param {object} [options.cesium] Cesium namespace (injectable for tests).
 * @param {() => object} [options.getTime] Current clock time for entities.
 * @returns {{key: unknown, getPosition: () => object|undefined,
 *   isAlive: () => boolean}|null} Null for empty space, tiles and positionless
 *   geometry.
 */
export function resolvePickTarget(
  picked,
  { cesium = Cesium, getTime = () => undefined } = {},
) {
  if (!picked) return null;
  if (
    isClass(picked, cesium.Cesium3DTileFeature) ||
    isClass(picked.primitive, cesium.Cesium3DTileset)
  )
    return null;
  const entity = isClass(picked.id, cesium.Entity) ? picked.id : null;
  if (entity?.position && typeof entity.position.getValue === 'function') {
    return {
      key: entity,
      getPosition: () => entity.position?.getValue?.(getTime()),
      isAlive: () => isEntityAlive(entity),
    };
  }
  const primitive = picked.primitive;
  if (
    primitive?.position &&
    isClass(primitive.position, cesium.Cartesian3) &&
    !isClass(primitive, cesium.Cesium3DTileset)
  ) {
    return {
      key: primitive,
      getPosition: () => primitive.position,
      isAlive: () => isPrimitiveAlive(primitive),
    };
  }
  if (isClass(primitive, cesium.Model) && primitive.modelMatrix) {
    const scratch = new cesium.Cartesian3();
    return {
      key: primitive,
      getPosition: () =>
        cesium.Matrix4.getTranslation(primitive.modelMatrix, scratch),
      isAlive: () => isPrimitiveAlive(primitive),
    };
  }
  return null;
}

/**
 * How flat the reticle lies: 1 when looking straight down, squashed toward
 * the horizon so it reads as painted on the ground.
 * @param {number} pitch Camera pitch in radians (negative looks down).
 * @returns {number}
 */
export function groundTilt(pitch) {
  if (!Number.isFinite(pitch)) return 1;
  return Math.min(1, Math.max(MIN_GROUND_TILT, Math.abs(Math.sin(pitch))));
}

/**
 * Install the reticle on a viewer.
 * @param {object} viewer Cesium viewer.
 * @param {object} [options]
 * @param {object} [options.cesium] Cesium namespace.
 * @param {() => boolean} [options.isPointerFree] Input-ownership gate, so
 *   draw tools and drags do not move the reticle.
 * @param {() => boolean} [options.isEnabled] HUD Target gate; defaults to
 *   the root element's `data-hud-target="lock"`.
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @returns {() => void} Uninstall.
 */
export function installSelectionReticle(
  viewer,
  {
    cesium = Cesium,
    isPointerFree = defaultIsPointerFree,
    doc = globalThis.document,
    win = globalThis.window,
    isEnabled = () => isLockTargetEnabled(doc),
  } = {},
) {
  const scene = viewer?.scene;
  if (!scene || !doc || typeof cesium.ScreenSpaceEventHandler !== 'function')
    return () => {};

  const root = doc.createElement('div');
  root.id = SELECTION_RETICLE_ROOT_ID;
  root.setAttribute('aria-hidden', 'true');
  const reticle = doc.createElement('div');
  reticle.className = 'gev-reticle';
  reticle.innerHTML = RETICLE_SVG;
  root.appendChild(reticle);
  const container = viewer.container;
  const parent = container?.parentElement || doc.body;
  if (container?.nextSibling) parent.insertBefore(root, container.nextSibling);
  else parent.appendChild(root);

  const scratchWindow = new cesium.Cartesian2();
  let target = null;
  let selectedAt = 0;
  let shown = false;
  let lastSelectionEvent = null;
  let lastPosition = null;
  const getTime = () => viewer.clock?.currentTime;

  function hide() {
    if (!shown) return;
    shown = false;
    reticle.classList.remove(ACTIVE_CLASS);
  }

  function clear() {
    target = null;
    hide();
  }

  function setTarget(next) {
    const same = target && next && target.key === next.key;
    target = next;
    const startPosition = next?.getPosition();
    lastPosition = startPosition
      ? cesium.Cartesian3.clone(startPosition)
      : null;
    selectedAt = Date.now();
    if (!next) return hide();
    if (!same) {
      // Restart the lock-on animation for a new subject.
      reticle.classList.remove(ENTER_CLASS);
      void reticle.offsetWidth;
      reticle.classList.add(ENTER_CLASS);
    }
    place();
    if (!same && target && typeof win?.CustomEvent === 'function')
      // A fresh lock; the HUD lock sound listens for this.
      win.dispatchEvent(new win.CustomEvent(HUD_TARGET_LOCKED_EVENT));
    scene.requestRender?.();
  }

  function isVisibleFromCamera(position) {
    const cameraPosition = scene.camera?.positionWC;
    if (!cameraPosition || typeof cesium.EllipsoidalOccluder !== 'function')
      return true;
    const ellipsoid = scene.globe?.ellipsoid || cesium.Ellipsoid?.WGS84;
    if (!ellipsoid) return true;
    return new cesium.EllipsoidalOccluder(
      ellipsoid,
      cameraPosition,
    ).isPointVisible(position);
  }

  function place() {
    if (!target) return;
    if (!isEnabled()) return clear();
    if (!target.isAlive()) {
      const handoff = findHandoffTarget(viewer, lastPosition, {
        cesium,
        getTime,
        excludeKey: target.key,
      });
      if (!handoff) return clear();
      // Same subject under a new marker: keep the lock without replaying it.
      handoff.layerId = target.layerId;
      target = handoff;
    }
    const position = target.getPosition();
    if (position)
      lastPosition = cesium.Cartesian3.clone(
        position,
        lastPosition || undefined,
      );
    const point =
      position &&
      isVisibleFromCamera(position) &&
      scene.cartesianToCanvasCoordinates(position, scratchWindow);
    const canvas = scene.canvas;
    const width = canvas?.clientWidth || 0;
    const height = canvas?.clientHeight || 0;
    if (
      !point ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < -80 ||
      point.y < -80 ||
      (width && point.x > width + 80) ||
      (height && point.y > height + 80)
    )
      return hide();
    reticle.style.transform = `translate3d(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px, 0)`;
    reticle.style.setProperty(
      '--reticle-tilt',
      groundTilt(scene.camera?.pitch).toFixed(3),
    );
    if (!shown) {
      shown = true;
      reticle.classList.add(ACTIVE_CLASS);
    }
  }

  const handler = new cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((click) => {
    if (!click?.position || !isPointerFree()) return;
    if (!isEnabled()) return clear();
    let picked;
    try {
      picked = scene.pick(click.position);
    } catch {
      picked = undefined;
    }
    setTarget(
      resolvePickTarget(picked, {
        cesium,
        getTime,
      }),
    );
    // A layer handler registered before ours may already have announced
    // what it selected for this click.
    if (
      target &&
      lastSelectionEvent &&
      selectedAt - lastSelectionEvent.at <= OWNER_WINDOW_MS
    )
      target.layerId = lastSelectionEvent.layerId;
  }, cesium.ScreenSpaceEventType.LEFT_CLICK);

  const removePostRender = scene.postRender.addEventListener(place);

  // Layers that publish selection tell us which layer owns the target, so a
  // later deliberate clear from that layer (closing its card) drops the
  // reticle even when the click itself did not.
  function onSelected(event) {
    const layerId = event?.detail?.layerId;
    if (!layerId) return;
    lastSelectionEvent = { layerId, at: Date.now() };
    if (target && lastSelectionEvent.at - selectedAt <= OWNER_WINDOW_MS)
      target.layerId = layerId;
  }
  function onCleared(event) {
    const detail = event?.detail || {};
    if (!target?.layerId || detail.layerId !== target.layerId) return;
    if (detail.reason === 'evicted') return;
    // A click that just picked a new subject in this layer arrives with a
    // clear for the previous one; the click already decided, so keep it.
    if (Date.now() - selectedAt <= OWNER_WINDOW_MS) return;
    clear();
  }
  function onTargetModeChanged() {
    if (!isEnabled()) clear();
  }
  const listeners = [
    [HUD_TARGET_EVENT, onTargetModeChanged],
    ['gev:entity-selected', onSelected],
    ['gev:awareness-subject-selected', onSelected],
    ['gev:entity-selection-cleared', onCleared],
    ['gev:awareness-subject-cleared', onCleared],
  ];
  for (const [name, fn] of listeners) win?.addEventListener?.(name, fn);

  return () => {
    for (const [name, fn] of listeners) win?.removeEventListener?.(name, fn);
    removePostRender?.();
    if (!handler.isDestroyed?.()) handler.destroy?.();
    root.remove();
    target = null;
  };
}
