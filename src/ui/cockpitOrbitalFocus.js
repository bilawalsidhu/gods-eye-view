/**
 * Ground focus in the Cockpit's orbital view: a site's Live Signals row, or
 * a click on a mapped site's marker, keeps the camera on that site as the
 * satellite moves; clicking elsewhere, the site's row again, NADIR or the
 * site leaving the off-nadir reach eases the view back. Sites come
 * from the Mapped Installations layer's own records and pick ids. Bound to
 * the Cockpit controller like the orbital view itself
 * (src/ui/cockpitOrbitalView.js); its state lives on the orbital session, so
 * it ends with the session.
 */
import * as Cesium from 'cesium';
import { clampOrbitalLook, easeLook } from '../cockpitLook.js';
import { ORBITAL_EARTH_RADIUS_M } from '../cockpitOrbital.js';
import {
  easeFocusRemainder,
  focusEaseDtMs,
  focusInReach,
  focusLook,
  pointsInReach,
} from '../cockpitOrbitalFocus.js';
import { isPointerFree } from '../data/inputOwnership.js';

const NADIR_LOOK = Object.freeze({ yawDeg: 0, pitchDeg: 0 });

/** The Mapped Installations layer's id. */
const SITES_LAYER_ID = 'military-installations';

/** The most sites asked of the layer around the sub-satellite point. */
const SITE_QUERY_MAX = 500;

/** How long a site the layer dropped stays listed, ms (it may come back). */
const SITE_MEMORY_MS = 10_000;

/** The farthest from the sub-satellite point a listed site may lie, m. */
const SITE_QUERY_MAX_RANGE_M = 3_000_000;

/** The greatest angle off nadir the reach allows: 45° on both axes. */
const REACH_CORNER_RAD = Math.acos(Math.cos(Math.PI / 4) ** 2);

/**
 * How far over the ground the reach extends from the sub-satellite point,
 * m: the central angle at the reach's corner off nadir (or the horizon, if
 * nearer), with a little margin, capped. Sites farther out are never asked
 * of the layer.
 */
function reachGroundRangeM(altitudeM) {
  const R = ORBITAL_EARTH_RADIUS_M;
  const h = Math.max(0, Number.isFinite(altitudeM) ? altitudeM : 0);
  const sine = ((R + h) / R) * Math.sin(REACH_CORNER_RAD);
  const central =
    sine >= 1 ? Math.acos(R / (R + h)) : Math.asin(sine) - REACH_CORNER_RAD;
  return Math.min(SITE_QUERY_MAX_RANGE_M, R * central * 1.05);
}

/** Whether the user asked for reduced motion: focus turns then cut. */
function prefersReducedMotion() {
  return Boolean(
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
  );
}

function inOrbit(controller) {
  return (
    controller.active &&
    !controller.destroyed &&
    controller.subjectKind === 'satellite' &&
    Boolean(controller.orbital)
  );
}

function sitesLayer(controller) {
  return controller.services?.militaryInstallationsLayer ?? null;
}

/** Whether the Mapped Installations layer is on (unknown reads as off). */
function sitesLayerOn(controller) {
  const isLayerEnabled = controller.services?.isLayerEnabled;
  return typeof isLayerEnabled === 'function'
    ? isLayerEnabled(SITES_LAYER_ID) !== false
    : false;
}

/**
 * A mapped site by id: as the layer has it loaded now, else, while the
 * layer is on, as the focus or the Live Signals rows last saw it. The layer
 * reloads its thinned view as the camera moves, so a site in view can leave
 * its records for a moment; a site does not move, so its last position
 * stands. Null with the layer off or the site never seen.
 */
function siteById(controller, id) {
  let live = null;
  try {
    live = sitesLayer(controller)?.getById?.(id) ?? null;
  } catch {
    live = null;
  }
  if (live) return live;
  if (!sitesLayerOn(controller)) return null;
  const state = controller.orbital;
  const key = String(id);
  if (state?.focus?.key === key && state.focus.site) return state.focus.site;
  return state?.listedSites?.get(key)?.site ?? null;
}

/** Where a site is drawn, ECEF, or null. */
function sitePosition(site) {
  const p = site?.position;
  return p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z)
    ? { x: p.x, y: p.y, z: p.z }
    : null;
}

/** The mapped site a canvas position shows, through the layer's pick ids. */
function siteAt(controller, position) {
  let picked = null;
  try {
    picked = controller.viewer.scene?.pick?.(position) ?? null;
  } catch {
    picked = null;
  }
  if (!picked) return null;
  try {
    return sitesLayer(controller)?.findByPick?.(picked) ?? null;
  } catch {
    return null;
  }
}

/** The focus look at a site from the last frame's satellite, or null. */
function lookAt(state, site) {
  const frame = state.focusFrame;
  if (!frame) return null;
  return focusLook(frame.nadir, frame.position, sitePosition(site));
}

/**
 * Point the view at a mapped site and keep it there: from the view as it is
 * now, so switching targets turns rather than jumps. A site beyond the
 * reach is refused.
 * @returns {boolean} True when the focus is on that site.
 */
function startFocus(site) {
  const state = this.orbital;
  const look = lookAt(state, site);
  // Before the first frame there is nothing to measure against; the frame
  // that follows checks the reach.
  if (state.focusFrame && !focusInReach(look)) return false;
  state.focus = {
    key: String(site.id),
    label: String(site.name || site.id),
    // Where the site is, kept while the layer reloads around it.
    site: {
      id: site.id,
      name: site.name,
      class: site.class,
      position: sitePosition(site),
    },
    look,
    // The view minus the target's look, eased away; set on the next frame.
    remainder: null,
  };
  state.focusReleasing = false;
  if (look) state.lookTarget = clampOrbitalLook(look);
  this.refreshOrbitalSignals?.();
  return true;
}

/**
 * End the focus. The view eases back to nadir on the focus's clock (cut
 * under reduced motion), or with `handOver` stays where it is for an arrow
 * key to tilt on from.
 * @param {{handOver?: boolean}} [options]
 * @returns {boolean} True when a focus was ended.
 */
export function releaseOrbitalFocus({ handOver = false } = {}) {
  const state = this.orbital;
  if (!state?.focus) {
    // An arrow during the ease back takes the arrows' own clock again and
    // tilts on from where the view is, not from the nadir it was easing to.
    if (handOver && state?.focusReleasing) {
      state.lookTarget = clampOrbitalLook(state.lookView);
      state.focusReleasing = false;
    }
    return false;
  }
  state.focus = null;
  if (handOver) {
    state.lookTarget = clampOrbitalLook(state.lookView);
    state.focusReleasing = false;
  } else {
    state.lookTarget = { ...NADIR_LOOK };
    if (prefersReducedMotion()) {
      state.lookView = { ...NADIR_LOOK };
      state.focusReleasing = false;
    } else state.focusReleasing = true;
  }
  this.refreshOrbitalSignals?.();
  return true;
}

/**
 * A site's Live Signals row: focus that site, switch to it from another, or
 * end the focus when it is the one held.
 * @param {string} key The site's id in the Mapped Installations layer.
 * @returns {boolean} True when the focus changed.
 */
export function toggleOrbitalFocus(key) {
  if (!inOrbit(this) || key === null || key === undefined) return false;
  const state = this.orbital;
  if (state.focus?.key === String(key)) return releaseOrbitalFocus.call(this);
  const site = siteById(this, String(key));
  return site ? startFocus.call(this, site) : false;
}

/**
 * A double-click on the orbital picture. On a mapped ground point it keeps
 * or starts the focus on it (as a single click does) and is taken: Cesium's
 * own double-click would track that point, which ends the view. Any other
 * double-click, one a tool owns, and every one outside orbit go on.
 * @param {{x: number, y: number}|null|undefined} position Canvas position.
 * @returns {boolean} True when it landed on a ground point and was taken.
 */
export function onOrbitalDoubleClick(position) {
  if (!inOrbit(this) || !isPointerFree()) return false;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y))
    return false;
  const site = siteAt(this, position);
  if (!site) return false;
  // A site beyond the reach is not focused, but still never tracked.
  if (this.orbital.focus?.key !== String(site.id)) startFocus.call(this, site);
  return true;
}

/**
 * A click on the orbital picture. One on a mapped ground point in reach
 * focuses it; any other click ends a focus. A click a tool owns (drawing)
 * is left alone, as is every click outside orbit.
 * @param {{x: number, y: number}|null|undefined} position Canvas position.
 * @returns {boolean} True when the click focused a point.
 */
export function onOrbitalClick(position) {
  if (!inOrbit(this) || !isPointerFree()) return false;
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y))
    return false;
  const site = siteAt(this, position);
  const state = this.orbital;
  if (site) {
    if (state.focus?.key === String(site.id)) return true;
    if (startFocus.call(this, site)) return true;
    // A mapped site beyond the reach is a click elsewhere: the focus ends.
  }
  releaseOrbitalFocus.call(this);
  return false;
}

/**
 * Take the scene's single click through the orbital focus first, then hand
 * it on to Cesium's own (it picks into `selectedEntity`), as before.
 * @returns {() => void} Puts Cesium's handler back, unless another owner
 *   (the draw tool borrows it) has replaced ours since.
 */
export function routeSceneClick() {
  const handler = this.viewer.screenSpaceEventHandler;
  if (typeof handler?.setInputAction !== 'function') return () => {};
  const type = Cesium.ScreenSpaceEventType.LEFT_CLICK;
  const stock = handler.getInputAction?.(type) ?? null;
  const routed = (event) => {
    this.onOrbitalClick(event?.position);
    stock?.(event);
  };
  handler.setInputAction(routed, type);
  return () => {
    if (handler.isDestroyed?.() || handler.getInputAction?.(type) !== routed)
      return;
    if (stock) handler.setInputAction(stock, type);
    else handler.removeInputAction(type);
  };
}

/**
 * The orbital view's look for one frame, while a focus holds or is ending.
 * A held focus aims at its target: the live look plus whatever is left of
 * the turn onto it. The focus ends, easing back, when its layer is turned
 * off or its site is beyond the reach (a site the layer stops loading is
 * held from its last record). Also rebuilds
 * the orbital Live Signals rows on their own clock.
 * @param {object} state The orbital session.
 * @param {{direction: object, up: object, right: object}} nadir This
 *   frame's nadir frame.
 * @param {{x: number, y: number, z: number}} position The satellite, ECEF.
 * @param {number} nowMs
 * @returns {boolean} True when it placed `state.lookView` itself.
 */
export function updateOrbitalFocus(state, nadir, position, nowMs) {
  state.focusFrame = {
    nadir,
    position: { x: position.x, y: position.y, z: position.z },
  };
  // After a satellite switch the first frame on the new satellite (the hop
  // landed, or none) is the one the rows can be measured from: rebuild now.
  if (state.awaitingFrame && !state.hop) {
    state.awaitingFrame = false;
    state.signalsMs = -Infinity;
  }
  const dtMs = nowMs - (state.lookLastMs || nowMs);
  let aimed = false;
  const focus = state.focus;
  if (focus) {
    const site = siteById(this, focus.key);
    const look = site
      ? focusLook(nadir, state.focusFrame.position, sitePosition(site))
      : null;
    if (!focusInReach(look)) {
      releaseOrbitalFocus.call(this);
    } else {
      focus.look = look;
      const reduced = prefersReducedMotion();
      focus.remainder = focus.remainder
        ? easeFocusRemainder(focus.remainder, dtMs, { immediate: reduced })
        : reduced
          ? { ...NADIR_LOOK }
          : {
              yawDeg: state.lookView.yawDeg - look.yawDeg,
              pitchDeg: state.lookView.pitchDeg - look.pitchDeg,
            };
      state.lookTarget = clampOrbitalLook(look);
      state.lookView = {
        yawDeg: look.yawDeg + focus.remainder.yawDeg,
        pitchDeg: look.pitchDeg + focus.remainder.pitchDeg,
      };
      aimed = true;
    }
  }
  this.updateOrbitalSignals?.(nowMs);
  return aimed;
}

/**
 * Ease the orbital look toward its target for one frame: the look's own
 * easing, on the focus's slower clock while a focus is easing back.
 * @param {object} state The orbital session.
 * @param {number} dtMs
 * @param {{immediate?: boolean}} [options]
 * @returns {{yawDeg: number, pitchDeg: number}}
 */
export function easeOrbitalLook(state, dtMs, { immediate = false } = {}) {
  const view = easeLook(
    state.lookView,
    state.lookTarget,
    state.focusReleasing ? focusEaseDtMs(dtMs) : dtMs,
    { immediate },
  );
  if (
    state.focusReleasing &&
    view.yawDeg === state.lookTarget.yawDeg &&
    view.pitchDeg === state.lookTarget.pitchDeg
  )
    state.focusReleasing = false;
  return view;
}

/**
 * The focused target for the HUD: its name and the live look at it, whose
 * single off-nadir angle the readout shows. Null without a focus, or before
 * its first frame.
 * @returns {{key: string, label: string, offNadirDeg: number,
 *   yawDeg: number, pitchDeg: number}|null}
 */
export function orbitalFocusReadout() {
  const focus = this.orbital?.focus;
  if (!focus?.look) return null;
  return {
    key: focus.key,
    label: focus.label,
    offNadirDeg: focus.look.offNadirDeg,
    yawDeg: focus.look.yawDeg,
    pitchDeg: focus.look.pitchDeg,
  };
}

/**
 * The mapped sites the orbital view can be turned to, for the Live Signals
 * rows: the Mapped Installations layer's loaded sites around the
 * sub-satellite point (`getNearby`), with those seen in the last
 * SITE_MEMORY_MS and the focused one, facing the satellite and within the
 * off-nadir reach, nearest to nadir first. Empty before the first frame or
 * with the layer off.
 * @param {{latitude: number, longitude: number, altitudeM: number}} info
 *   The ridden satellite.
 * @returns {{entries: Array<{site: object, offNadirDeg: number,
 *   focused: boolean}>}}
 */
export function orbitalSitesInReach(info) {
  const state = this.orbital;
  const frame = state?.focusFrame;
  const layer = sitesLayer(this);
  // The layer keeps its records when it is turned off: nothing is listed
  // then, and no row is left to focus from.
  if (state && !sitesLayerOn(this)) state.listedSites = new Map();
  if (!frame || typeof layer?.getNearby !== 'function' || !sitesLayerOn(this))
    return { entries: [] };
  if (!Number.isFinite(info?.latitude) || !Number.isFinite(info?.longitude))
    return { entries: [] };
  const rangeM = reachGroundRangeM(info.altitudeM);
  let sites = [];
  try {
    sites = layer.getNearby(
      Cesium.Cartesian3.fromDegrees(info.longitude, info.latitude, 0),
      rangeM,
      SITE_QUERY_MAX,
    );
  } catch {
    sites = [];
  }
  const byId = new Map();
  const candidates = [];
  for (const site of sites || []) {
    const position = sitePosition(site);
    if (!position || site.id === null || site.id === undefined) continue;
    const key = String(site.id);
    byId.set(key, site);
    candidates.push({ key, position });
  }
  // In orbit the layer reloads its thinned view every second or so, and a
  // site in view can drop out of its records and come back. Sites do not
  // move: one seen within SITE_MEMORY_MS stays a candidate, so the rows hold
  // still and a row's site can be focused from what the rows show.
  const nowMs = performance.now();
  const remembered = new Map();
  for (const [key, entry] of state.listedSites ?? []) {
    if (nowMs - entry.seenMs > SITE_MEMORY_MS || byId.has(key)) continue;
    remembered.set(key, entry);
    byId.set(key, entry.site);
    candidates.push({ key, position: entry.site.position });
  }
  // The focused site stays a candidate while the layer reloads around it.
  const held = state.focus;
  if (held?.site?.position && !byId.has(held.key)) {
    byId.set(held.key, held.site);
    candidates.push({ key: held.key, position: held.site.position });
  }
  for (const [key, site] of byId)
    if (!remembered.has(key))
      remembered.set(key, {
        site: { ...site, position: sitePosition(site) },
        seenMs: nowMs,
      });
  state.listedSites = remembered;
  const focusKey = state.focus?.key ?? null;
  return {
    entries: pointsInReach(candidates, {
      nadir: frame.nadir,
      satellite: frame.position,
    }).map(({ key, offNadirDeg }) => ({
      site: byId.get(key),
      offNadirDeg,
      focused: key === focusKey,
    })),
  };
}
