/**
 * Sky view: a "Sky" button next to the map
 * navigation control. Pick a point on the globe, use the browser location,
 * or type "lat, lon" / a place; the camera drops to eye height there and
 * looks UP. Drag/pinch/wheel/keys look around (zoom = field of view), the
 * horizon is the real terrain (or a flat painted ground), the sky follows the
 * Sun at Sky time, and "Back to map" restores the previous camera, inputs,
 * clock and scene flags exactly.
 *
 * scope: observer, camera, horizon, sky brightness, `sv` URL.
 * satellites above the horizon (module worker, states, labels, the
 * "Overhead now" panel, element-age rules) drawn into the same overlay.
 * brightness ESTIMATE (SATCAT RCS), the naked-eye filter (est. mag
 * slider), "Next passes" (48 h, stations + visual) with the pass arc and the
 * "Next ISS pass" hook (handle.nextIssPass / goToPass, for presets).
 * stars, constellations, Sun/Moon/planets, layer switches and search
 * live in skyContent.js and draw into the same overlay after the pass.
 * "Point at the sky" on phones (orientation.js): the view follows the
 * phone (true north via the WMM declination), Align on the Sun/Moon/selected
 * object, calibration hint; a drag always takes over.
 * the Sky time source (skyClock.js: live/fixed/play) is the ONLY time for the overlay, the worker
 * ticks, the ephemeris and viewer.clock; the time control, presets and
 * validity banners live in skyTimeControl.js.
 * Clear view (clearView.js): the eye button, a double-tap on the sky or H
 * hides every control so only the sky is left; Escape brings them back.
 */
import * as Cesium from 'cesium';
import { observerSolarElevation } from '../data/satellitePass.js';
import { geocodeKeyless } from '../keylessGeocoder.js';
import { t } from '../i18n/index.js';
import {
  computeHorizonProfile,
  occlusion as profileOcclusion,
} from './horizonProfile.js';
import {
  accuracyText,
  createGeolocator,
  createObserver,
  parseLatLon,
  sampleGroundHeight,
} from './observer.js';
import { drawOverlay, overlayModel } from './overlay.js';
import {
  cardinalBoxes,
  createSkyContent,
  overlayPixelRatio,
  PERF_SAMPLES,
} from './skyContent.js';
import {
  applySkyCamera,
  applySkyScene,
  applySkyTime,
  restoreCamera,
  restoreScene,
  skyTilesShown,
  snapshotCamera,
  snapshotScene,
} from './skyCamera.js';
import { createSatSky, fetchCelestrakText } from './satSky.js';
import {
  drawSatellites,
  geoBeltPoints,
  hitTest,
  lookAtView,
  satelliteModel,
} from './satOverlay.js';
import {
  ageBanner,
  buildSatPanel,
  cardData,
  listIndexFromTarget,
  overheadList,
  passesView,
  passKey,
  renderSatPanel,
} from './satPanel.js';
import { ISS_NORAD, SKY_CLASSES, STATE } from './satCore.js';
import {
  clampMagLimit,
  isNakedEyeCandidate,
  MAG_LIMIT_DEFAULT,
} from './brightness.js';
import { upcomingPasses } from './passes.js';
import { createSkyClock, createSkyTimeSource } from './skyClock.js';
import { createIssPassFinder } from './skyPresets.js';
import { createTimeControl, toLocalInputValue } from './skyTimeControl.js';
import { validityBanners } from './skyValidity.js';
import {
  clampEl,
  dragView,
  inertiaStep,
  keyView,
  limMag,
  makeView,
  pinchView,
  skyBoxVisible,
  twilightPhase,
  wheelZoomFactor,
  zoomView,
} from './skyMath.js';
import { resolveTarget, satelliteSearchProvider } from './skySearch.js';
import { declinationDeg, declinationText } from './declination.js';
import { createPhoneOrientation, pointingOffered } from './orientation.js';
import {
  ALIGN_MAX_EL_DEG,
  ALIGN_MAX_MISS_EL_DEG,
  orientationMessage,
} from './orientationMath.js';
import { DEFAULT_SKY_FLAGS, readSkyUrl, writeSkyUrl } from './skyUrl.js';
import { createSkyVoice } from './skyVoice.js';
import {
  CLEAR_MESSAGE_STATES,
  createClearView,
  clearKeyAction,
  isDoubleTap,
  sessionStore,
} from './clearView.js';

const mounted = new WeakMap();
const PHASE_TEXT = {
  day: 'Day',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
  unknown: '',
};
/** Satellite redraw cap while objects move (frames per second). */
const SAT_FPS = 15;
/** Time-driven redraw cap while the Sky clock plays (frames per second). */
const PLAY_FPS = 30;
/** Satellite tick period while the clock runs faster than real time. */
const FAST_TICK_MS = 250;
const LOOK_AT_MS = 600;
/** A press that moves less than this and ends sooner than CLICK_MS is a click. */
const CLICK_PX = 5;
const CLICK_MS = 400;
/**
 * After a pass tap, later panel refreshes (the card's "Next pass" line once
 * the worker answers, a rescan after a time jump) keep the tapped control in
 * place for this long, or until the user scrolls/touches the panel.
 */
const PASS_ANCHOR_MS = 5000;
/** A pick this far from the ellipsoid is a streaming-tile glitch, not ground. */
const PLAUSIBLE_GROUND_M = [-500, 9000];

const fmt = (value, digits) => Number(value).toFixed(digits);

/**
 * Sky label boxes ({x0, y0, x1, y1}: cardinals + skyContent labels) as the
 * {x, y, w, h} boxes the satellite label pass checks against.
 */
export function takenBoxes(cardinals = [], skyLabels = []) {
  const out = [];
  for (const b of cardinals)
    out.push({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  for (const { box: b } of skyLabels || [])
    if (b) out.push({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
  return out;
}

/** Observer + view caption for the status line. */
export function describeObserver(observer, { sunAltDeg = null } = {}) {
  if (!observer) return '';
  const lat = `${fmt(Math.abs(observer.latDeg), 4)}° ${observer.latDeg >= 0 ? 'N' : 'S'}`;
  const lon = `${fmt(Math.abs(observer.lonDeg), 4)}° ${observer.lonDeg >= 0 ? 'E' : 'W'}`;
  const ground = observer.heightKnown
    ? `ground ${Math.round(observer.groundHeightM)} m`
    : 'ground height unknown (0 m used)';
  const parts = [`${lat} ${lon}`, ground];
  const accuracy = accuracyText(observer.accuracyM);
  if (accuracy) parts.push(accuracy);
  if (Number.isFinite(sunAltDeg)) {
    const phase = PHASE_TEXT[twilightPhase(sunAltDeg)];
    parts.push(`Sun ${fmt(sunAltDeg, 1)}° (${phase})`);
  }
  return parts.join(' · ');
}

/** `datetime-local` value in the browser's zone (moved to skyTimeControl). */
export { toLocalInputValue };

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildDom(doc) {
  const button = el(
    doc,
    'button',
    {
      type: 'button',
      className: 'gev-sky-btn',
      'data-sky': 'open',
      'aria-label': 'Sky view: look up from a point',
      'aria-expanded': 'false',
      title: t('Sky view: look up from a point'),
    },
    'Sky',
  );

  const panel = el(doc, 'div', {
    className: 'gev-sky-panel',
    role: 'dialog',
    'aria-label': 'Sky view',
    'data-sky': 'panel',
  });
  panel.hidden = true;
  const title = el(
    doc,
    'div',
    { className: 'gev-sky-title' },
    'Sky view: where do you stand?',
  );
  const pick = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'pick' },
    'Pick on map',
  );
  const here = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'here' },
    'Screen centre',
  );
  const gps = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'gps' },
    'Use my location',
  );
  const form = el(doc, 'form', {
    className: 'gev-sky-form',
    'data-sky': 'form',
  });
  const input = el(doc, 'input', {
    type: 'text',
    'data-sky': 'query',
    placeholder: t('lat, lon or a place'),
    'aria-label': t('Latitude, longitude or place name'),
    autocomplete: 'off',
  });
  const go = el(doc, 'button', { type: 'submit', 'data-sky': 'go' }, 'Go');
  form.append(input, go);
  const close = el(
    doc,
    'button',
    {
      type: 'button',
      className: 'gev-sky-close',
      'data-sky': 'close',
      'aria-label': 'Close',
    },
    '×',
  );
  const row = el(doc, 'div', { className: 'gev-sky-row' });
  row.append(pick, here, gps);
  const status = el(doc, 'div', {
    className: 'gev-sky-status',
    'data-sky': 'status',
    role: 'status',
    'aria-live': 'polite',
  });
  panel.append(close, title, row, form, status);

  const bar = el(doc, 'div', {
    className: 'gev-sky-bar',
    role: 'toolbar',
    'aria-label': 'Sky view controls',
    'data-sky': 'bar',
  });
  bar.hidden = true;
  const back = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'back' },
    'Back to map',
  );
  const move = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'move' },
    'Move',
  );
  const flat = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'flat', 'aria-pressed': 'false' },
    'Flat horizon',
  );
  const grid = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'grid', 'aria-pressed': 'false' },
    'Grid',
  );
  const eyeLabel = el(doc, 'label', { className: 'gev-sky-eye' }, 'Eye m ');
  const eye = el(doc, 'input', {
    type: 'number',
    'data-sky': 'eye',
    min: '0',
    max: '9999',
    step: '0.1',
    value: '1.7',
    'aria-label': 'Eye height above the ground, metres',
  });
  eyeLabel.append(eye);
  const info = el(doc, 'div', {
    className: 'gev-sky-info',
    'data-sky': 'info',
    role: 'status',
    'aria-live': 'polite',
  });
  const point = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'point',
      'aria-pressed': 'false',
      title: t(
        'Follow the phone: hold it up and the view shows the sky behind it',
      ),
    },
    'Point at the sky',
  );
  point.hidden = true;
  // the time control (skyTimeControl.js) is inserted after `grid`
  bar.append(back, move, flat, grid, eyeLabel, point, info);

  // phone pointing: status, calibration hint, Align on a known object
  const orient = el(doc, 'div', {
    className: 'gev-sky-orient',
    'data-sky': 'orient',
  });
  orient.hidden = true;
  const orientStatus = el(doc, 'div', {
    className: 'gev-sky-orient-status',
    'data-sky': 'orient-status',
    role: 'status',
    'aria-live': 'polite',
  });
  const figure8 = el(
    doc,
    'div',
    {
      className: 'gev-sky-figure8',
      'data-sky': 'figure8',
      'aria-hidden': 'true',
    },
    '∞',
  );
  figure8.hidden = true;
  const alignRow = el(doc, 'div', {
    className: 'gev-sky-align',
    'data-sky': 'align',
    role: 'group',
    'aria-label': 'Align the compass on a sky object in the centre',
  });
  alignRow.hidden = true;
  const alignLabel = el(doc, 'span', {}, 'Align centre on:');
  const alignSun = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'align-sun' },
    'Sun',
  );
  const alignMoon = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'align-moon' },
    'Moon',
  );
  const alignTarget = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'align-target' },
    'Selected',
  );
  const alignReset = el(
    doc,
    'button',
    { type: 'button', 'data-sky': 'align-reset' },
    'Reset offset',
  );
  alignRow.append(alignLabel, alignSun, alignMoon, alignTarget, alignReset);
  orient.append(figure8, orientStatus, alignRow);
  bar.append(orient);

  const canvas = el(doc, 'canvas', {
    className: 'gev-sky-canvas',
    'data-sky': 'canvas',
    tabindex: '0',
    'aria-label':
      'Sky. Drag to look around, wheel or pinch to zoom, arrows and +/- keys, N north, Z zenith',
  });
  canvas.hidden = true;
  const crosshair = el(doc, 'div', {
    className: 'gev-sky-crosshair',
    'data-sky': 'crosshair',
    'aria-hidden': 'true',
  });
  crosshair.hidden = true;
  return {
    button,
    panel,
    input,
    form,
    status,
    bar,
    info,
    canvas,
    eye,
    crosshair,
    orient: {
      root: orient,
      status: orientStatus,
      figure8,
      align: alignRow,
    },
    buttons: {
      pick,
      here,
      gps,
      close,
      back,
      move,
      flat,
      grid,
      go,
      point,
      alignSun,
      alignMoon,
      alignTarget,
      alignReset,
    },
  };
}

/**
 * Mount once per viewer; returns the existing handle on a second call.
 * Never throws for a missing browser environment (returns null).
 */
export function mountSkyView({
  viewer,
  document: doc = globalThis.document,
  parent,
  lifetime,
  runNavigation = (_noun, navigate) => navigate(),
  showToast = () => {},
  geolocation = globalThis.navigator?.geolocation,
  isSecureContext = globalThis.isSecureContext,
  location = globalThis.location,
  history = globalThis.history,
  geocode = (query) => geocodeKeyless(query),
  timers = globalThis,
  now = () => Date.now(),
  CesiumApi = Cesium,
  autoEnterDelayMs = 2500,
  createSatWorker,
  fetchCelestrak,
  fetchRcs,
  nakedEyeDefault = true,
  reducedMotion = () =>
    Boolean(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
    ),
  requestFrame = (fn) => globalThis.requestAnimationFrame?.(fn) ?? null,
  cancelFrame = (id) => globalThis.cancelAnimationFrame?.(id),
  /** Test/harness overrides for createSkyContent (data loaders, frames). */
  skyContentOptions = {},
  /** the window whose sensors are read, and whether to offer pointing. */
  orientationWindow = globalThis,
  offerPointing = () => pointingOffered(globalThis),
  /** Test/harness overrides for createPhoneOrientation (timers, frames). */
  orientationOptions = {},
  /** WMM declination (degrees east) for the observer, now. */
  declinationAt = (latDeg, lonDeg) =>
    declinationDeg(latDeg, lonDeg, Date.now()),
  /** Next ISS pass for the preset (the passes engine). */
  nextIssPass = null,
  /** Clear view: where the session's choice is kept (sessionStorage). */
  clearStorage,
  /** Window that receives __gevSky. Defaults to the document's window. */
  voiceWindow,
} = {}) {
  if (!viewer?.camera || !viewer?.scene || !doc?.createElement) return null;
  const existing = mounted.get(viewer);
  if (existing && !existing.destroyed) return existing;
  const host = parent || doc.body;
  if (!host) return null;
  const hookWindow =
    voiceWindow !== undefined ? voiceWindow : (doc.defaultView ?? null);
  let skyVoice = null;

  const dom = buildDom(doc);
  const satDom = buildSatPanel(doc);
  host.append(dom.button, dom.panel, dom.bar, satDom.root);
  const canvasHost = viewer.container || host;
  canvasHost.append(dom.canvas, dom.crosshair);
  const clearView = createClearView({
    doc,
    timers,
    storage: clearStorage ?? sessionStore(),
    coarse: () => offerPointing(),
    // the focused control is about to be hidden: H/Escape go to the sky
    onEnter: () => dom.canvas.focus?.({ preventScroll: true }),
  });
  host.append(clearView.button, clearView.note);
  const removers = [];
  const listen = (target, type, handler, options) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler, options);
    removers.push(() => target.removeEventListener(type, handler, options));
  };

  const clock = createSkyClock({ now });
  const time = createSkyTimeSource({ clock });
  let active = false;
  let observer = null;
  let view = makeView();
  let flags = { ...DEFAULT_SKY_FLAGS };
  let cameraSnap = null;
  let sceneSnap = null;
  let profile = null;
  let profileToken = 0;
  let picker = null;
  let tickTimer = null;
  let urlTimer = null;
  let autoTimer = null;
  let inertiaFrame = null;
  let destroyed = false;
  const pointers = new Map();
  let pinch = null;
  let lastSunAlt = null;
  // satellites
  const classesOn = new Set(SKY_CLASSES);
  let geoBelt = false;
  let beltPoints = null;
  let selectedIndex = null;
  let satModel = null;
  let satFrame = null;
  let satFrameAt = 0;
  let lookFrame = null;
  let press = null;
  /** Last finished tap on the sky (double-tap = Clear view). */
  let lastTap = null;
  // brightness + passes
  let nakedEyeOn = Boolean(nakedEyeDefault);
  let magLimit = MAG_LIMIT_DEFAULT;
  let selectedPass = null;
  /** {node, top, until} while a tapped pass control is held in place. */
  let passAnchor = null;
  const satSky = createSatSky({
    ...(createSatWorker ? { createWorker: createSatWorker } : {}),
    ...(fetchCelestrak ? { fetchText: fetchCelestrak } : {}),
    ...(fetchRcs ? { fetchRcs } : {}),
    timers,
    getTime: () => time.getTime(),
    onChange: (what) => {
      if (!active) return;
      updateSatPanel();
      if (what === 'tick') renderValidity(time.getTime());
      if (
        (what === 'tick' || what === 'arc') &&
        satFrame == null &&
        playFrame == null
      )
        redraw();
      if (what === 'tick') startSatAnimation();
    },
  });
  /** Satellite objects of the last paint. */
  let satObjects = null;
  const satellitePosition = (id) => {
    const drawn = satObjects?.find((o) => o.index === id);
    if (drawn) return { azDeg: drawn.azDeg, elDeg: drawn.elDeg };
    const row = satSky.lookup(id)?.row;
    return row ? { azDeg: row.azDeg, elDeg: row.elDeg } : null;
  };
  const content = createSkyContent({
    doc,
    getView: () => view,
    applyView: (next) => applyView(next),
    requestRedraw: () => redraw(),
    // `next` holds only the switches that changed (never the whole copy)
    onFlagsChange: (next) => {
      flags = { ...flags, ...next };
      setPressed(dom.buttons.flat, flags.flatHorizon);
      setPressed(dom.buttons.grid, flags.grid);
      redraw();
      scheduleUrl();
    },
    now,
    // search finds satellites by name in the satellite engine; the marker uses
    // the az/el the satellite overlay draws (extrapolated between ticks)
    satellites: satelliteSearchProvider(satSky, {
      positionOf: (id) => satellitePosition(id),
    }),
    ...skyContentOptions,
  });
  if (content.root) host.append(content.root);

  const timeControl = createTimeControl({
    doc,
    clock,
    source: time,
    getObserver: () => observer,
    nextIssPass:
      nextIssPass ||
      createIssPassFinder({ fetchText: fetchCelestrak || fetchCelestrakText }),
  });
  if (typeof dom.buttons.grid.after === 'function')
    dom.buttons.grid.after(timeControl.root);
  else dom.bar.append(timeControl.root);
  // names kept for callers of handle.elements
  dom.time = timeControl.dom.time;
  dom.buttons.live = timeControl.dom.live;

  /** Naked-eye filter as an object predicate, or null. */
  const nakedEyeFilter = () =>
    nakedEyeOn
      ? (o) =>
          isNakedEyeCandidate({
            visible: o.state === STATE.VISIBLE,
            klass: o.klass,
            estMag: o.estMag,
            limit: magLimit,
          })
      : null;

  const setStatus = (text) => {
    dom.status.textContent = text || '';
  };
  const setPressed = (button, on) =>
    button.setAttribute('aria-pressed', on ? 'true' : 'false');

  const geolocator = createGeolocator({
    geolocation,
    isSecureContext,
    onChange: async (state, message) => {
      setStatus(message);
      if (state.status !== 'ready') return;
      const { latDeg, lonDeg, accuracyM } = state.coords;
      await enterAt({ latDeg, lonDeg, source: 'gps', accuracyM });
    },
  });

  // ── phone pointing ──────────────────────────────────────────────────
  /** A one-off result line (Align, drag took over), shown for a few seconds. */
  const NOTE_MS = 8000;
  let orientNote = '';
  let noteTimer = null;
  function setNote(text) {
    orientNote = text || '';
    timers.clearTimeout?.(noteTimer);
    noteTimer = orientNote
      ? timers.setTimeout?.(() => {
          noteTimer = null;
          orientNote = '';
          syncOrientationUi();
        }, NOTE_MS)
      : null;
  }
  const orientation = createPhoneOrientation({
    win: orientationWindow,
    isSecureContext,
    onView: (next) => {
      if (!active) return;
      applyView({
        ...view,
        azDeg: next.azDeg,
        elDeg: next.elDeg,
        rollDeg: next.rollDeg,
      });
    },
    onState: () => syncOrientationUi(),
    ...orientationOptions,
  });
  dom.buttons.point.hidden = !offerPointing();

  /**
   * Align corrects the compass from where the drawn object is, so it is only
   * offered while the Sky shows the present (time travel: a past/future
   * sky would put a wrong offset on the real compass).
   */
  const alignTimeOk = () => time.mode === 'live';

  /** Where an Align target is now: { label, azDeg, elDeg } or null. */
  function alignTargets() {
    if (!alignTimeOk()) return { sun: null, moon: null, selected: null };
    const eph = content.ephemeris;
    const sun = eph?.sun
      ? { label: t('the Sun'), azDeg: eph.sun.azDeg, elDeg: eph.sun.elDeg }
      : null;
    const moon = eph?.moon
      ? { label: t('the Moon'), azDeg: eph.moon.azDeg, elDeg: eph.moon.elDeg }
      : null;
    let selected = null;
    if (selectedIndex != null) {
      const at = satellitePosition(selectedIndex);
      const name = satSky.meta?.[selectedIndex]?.name;
      if (at) selected = { label: name || t('the selected satellite'), ...at };
    } else if (content.marker) {
      const at = resolveTarget(content.marker.target, {
        field: content.field,
        positioned: content.positioned,
        ephemeris: eph,
        satellite: (id) => satellitePosition(id),
      });
      if (at) selected = { label: content.marker.label, ...at };
    }
    const up = (t) => (t && t.elDeg > 0 ? t : null);
    return { sun: up(sun), moon: up(moon), selected: up(selected) };
  }

  function syncOrientationUi() {
    const state = orientation.state;
    const running = orientation.running;
    const o = dom.orient;
    setPressed(dom.buttons.point, running);
    dom.buttons.point.textContent = running
      ? t('Stop pointing')
      : t('Point at the sky');
    dom.crosshair.hidden = !(active && running);
    // short (landscape) phones: a compact toolbar while pointing (CSS)
    if (active && running) doc.body?.classList?.add('gev-sky-pointing');
    else doc.body?.classList?.remove('gev-sky-pointing');
    o.figure8.hidden = !(
      state === 'calibrating' && orientation.reason === 'accuracy'
    );
    // only with a heading reference: an iOS phone still waiting for its
    // first compass reading has no frame an offset could correct
    const canAlign =
      active &&
      (state === 'on' || state === 'calibrating') &&
      orientation.alignReady;
    o.align.hidden = !canAlign;
    if (canAlign) {
      const targets = alignTargets();
      dom.buttons.alignSun.disabled = !targets.sun;
      dom.buttons.alignMoon.disabled = !targets.moon;
      dom.buttons.alignTarget.disabled = !targets.selected;
      dom.buttons.alignTarget.textContent = targets.selected
        ? t('Selected ({label})', { label: targets.selected.label })
        : t('Selected');
      dom.buttons.alignReset.hidden = !orientation.info.offsetDeg;
    }
    const parts = [];
    if (orientNote) parts.push(orientNote);
    const message = orientationMessage(state, orientation.reason);
    if (message) parts.push(message);
    if (canAlign && !alignTimeOk()) parts.push('Align needs Live time');
    if (running && orientation.source !== 'relative') {
      const { declinationDeg: decl, offsetDeg, accuracyDeg } = orientation.info;
      parts.push(declinationText(decl));
      if (offsetDeg)
        parts.push(
          `align offset ${offsetDeg > 0 ? '+' : ''}${offsetDeg.toFixed(1)}°`,
        );
      if (Number.isFinite(accuracyDeg) && accuracyDeg >= 0)
        parts.push(`compass ±${Math.round(accuracyDeg)}°`);
      if (observer && observer.source !== 'gps')
        parts.push("tip: 'Use my location' so the sky matches where you stand");
    }
    // runs every second while pointing: touch the live region (and the
    // layout) only when something changed; the toolbar's ResizeObserver
    // re-syncs the panel positions when the extra row appears or wraps
    const text = parts.join(' · ');
    if (o.status.textContent !== text) o.status.textContent = text;
    const hidden = !(active && parts.length);
    if (o.root.hidden !== hidden) o.root.hidden = hidden;
    // Clear view keeps what needs the user (permission, denied, insecure,
    // calibrating, the figure 8, a pointing note) as one line over the sky
    if (
      state === 'on' ||
      (state === 'calibrating' && orientation.reason !== 'relative')
    )
      clearView.fireAuto();
    else if (state !== 'asking') clearView.disarmAuto();
    clearView.setMessage({
      note: orientNote,
      message:
        active && CLEAR_MESSAGE_STATES.includes(state)
          ? orientationMessage(state, orientation.reason)
          : '',
      figure8: active && !o.figure8.hidden,
    });
  }

  /** Point at the sky / Stop pointing: start() runs inside the tap (iOS). */
  function togglePointing() {
    setNote('');
    if (orientation.running) {
      stopPointing();
      return;
    }
    if (observer)
      orientation.setDeclination(
        declinationAt(observer.latDeg, observer.lonDeg),
      );
    cancelInertia();
    cancelLook();
    // touch phones go to Clear view once the phone leads (clearView.js)
    if (offerPointing()) clearView.armAuto();
    orientation.start();
    syncOrientationUi();
  }
  /** Back to drag control: roll goes back to level (phone mode only). */
  function stopPointing(note = '') {
    const was = orientation.running;
    orientation.stop();
    setNote(note);
    if (was && active) applyView({ ...view, rollDeg: 0 });
    syncOrientationUi();
  }

  function alignOn(which) {
    const target = alignTargets()[which];
    if (!target || !orientation.running) return;
    if (!orientation.alignReady) {
      setNote(
        'Align waits for the first compass reading: hold the phone upright for a moment.',
      );
    } else if (target.elDeg > ALIGN_MAX_EL_DEG) {
      setNote(
        `${target.label} is too high to align on (the compass direction is unclear near the zenith). Pick a lower object.`,
      );
    } else if (Math.abs(view.elDeg - target.elDeg) > ALIGN_MAX_MISS_EL_DEG) {
      setNote(
        `Put ${target.label} in the centre circle first (it is ${target.elDeg.toFixed(0)}° up, the centre is at ${view.elDeg.toFixed(0)}°).`,
      );
    } else {
      const delta = orientation.alignTo(target.azDeg, view.azDeg);
      setNote(
        delta == null
          ? ''
          : `Aligned on ${target.label}: heading moved ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}°.`,
      );
    }
    syncOrientationUi();
  }

  // ── rendering ────────────────────────────────────────────────────────────
  // Reading clientWidth/clientHeight forces a synchronous layout whenever
  // anything else (HUD text, URL chip) dirtied the page since the last frame;
  // on the throttled mid-phone profile that was the largest single cost of a
  // redraw. The size is cached and dropped on resize (window event and a
  // ResizeObserver on the globe canvas) and on every entry into the sky.
  let sizeCache = null;
  const canvasSize = () => {
    if (sizeCache) return sizeCache;
    const c = viewer.scene.canvas;
    const size = {
      width: c?.clientWidth || c?.width || 1,
      height: c?.clientHeight || c?.height || 1,
    };
    // a hidden or not-yet-laid-out canvas reports 0: measure again next time
    if (c?.clientWidth > 0 && c?.clientHeight > 0) sizeCache = size;
    return size;
  };
  const dropSize = () => {
    sizeCache = null;
  };

  // Whole overlay redraw timings:
  // the overlay redraw budget metric ("overlay redraw p95").
  const redrawPerf = [];
  const perfNow = () => globalThis.performance?.now?.() ?? Date.now();

  function redraw() {
    if (!active) return;
    const t0 = perfNow();
    paint();
    redrawPerf.push(perfNow() - t0);
    if (redrawPerf.length > PERF_SAMPLES) redrawPerf.shift();
  }

  function paint() {
    const { width, height } = canvasSize();
    const ratio = overlayPixelRatio(globalThis.devicePixelRatio);
    if (dom.canvas.width !== Math.round(width * ratio))
      dom.canvas.width = Math.round(width * ratio);
    if (dom.canvas.height !== Math.round(height * ratio))
      dom.canvas.height = Math.round(height * ratio);
    const ctx = dom.canvas.getContext?.('2d');
    if (!ctx) return;
    ctx.setTransform?.(ratio, 0, 0, ratio, 0, 0);
    const model = overlayModel({
      view,
      width,
      height,
      grid: flags.grid,
      flatHorizon: flags.flatHorizon,
      sunAltDeg: lastSunAlt,
    });
    drawOverlay(ctx, model, {
      width,
      height,
      text: content.textSprites,
      ratio,
    });
    satObjects = satSky.running ? satSky.objectsAt(time.getTime()) : null;
    const reserved = cardinalBoxes(model.cardinals);
    const skyStats = content.draw(ctx, {
      view,
      width,
      height,
      sunAltDeg: lastSunAlt,
      occlusion: (azDeg, elDeg) => profileOcclusion(profile, azDeg, elDeg),
      reserved,
      ratio,
    });
    if (satSky.running) {
      satModel = satelliteModel({
        objects: satObjects,
        view,
        width,
        height,
        occlusion: (az, elDeg) => profileOcclusion(profile, az, elDeg),
        classesOn,
        selectedIndex,
        geoBelt: geoBelt ? beltPoints : null,
        // only the selected object's edge arrow uses the insets, and they
        // read layout (getBoundingClientRect): skip them otherwise, so a
        // plain redraw never forces a synchronous layout
        insets: selectedIndex != null ? arrowInsets(width, height) : {},
        // one collision space: satellite labels keep off the cardinals and
        // the star/planet/constellation labels placed just before
        reserved: takenBoxes(reserved, skyStats?.labels),
        include: nakedEyeFilter(),
        passArc: selectedPass ? satSky.arcFor(selectedPass) : null,
      });
      drawSatellites(ctx, satModel, { text: content.textSprites, ratio });
    } else satModel = null;
  }

  // ── satellites ───────────────────────────────────────────────────────────
  /**
   * Narrow layouts (skyView.css, max-width 900px) size the satellite panel
   * from the toolbar's real bottom edge, because the toolbar wraps to a
   * different height at every width: --gev-sky-bar-bottom on the panel.
   * The Layers/search tools hang below the toolbar at every width (the
   * time rows made the toolbar taller), so they get the same variable.
   */
  function syncSkyLayout() {
    if (dom.bar.hidden) return;
    const bar = dom.bar.getBoundingClientRect?.();
    if (!bar || !(bar.height > 0)) return;
    const bottom = `${Math.ceil(bar.bottom)}px`;
    satDom.root.style?.setProperty?.('--gev-sky-bar-bottom', bottom);
    content.root?.style?.setProperty?.('--gev-sky-bar-bottom', bottom);
  }

  /** Scroll the panel so the newly selected object's card is in view. */
  function revealCard() {
    const { body, card } = satDom;
    if (card.hidden || body.hidden || typeof body.scrollTop !== 'number')
      return;
    const b = body.getBoundingClientRect?.();
    const c = card.getBoundingClientRect?.();
    if (!b || !c) return;
    if (c.bottom > b.bottom)
      body.scrollTop += Math.min(c.bottom - b.bottom, c.top - b.top);
    else if (c.top < b.top) body.scrollTop -= b.top - c.top;
  }

  /**
   * Run `render` without moving `anchor` (the control just tapped: a "Next
   * passes" row or Next ISS pass) on screen, then scroll "Go to peak time"
   * into view when that keeps the anchor in view. Selecting a pass shows the
   * object card ABOVE the passes block; Chromium's own scroll anchoring picks
   * the first visible node, which on tall panels sits above the card, so the
   * tapped row and its action slid out of the panel. Unlike revealCard this
   * never scrolls towards the card: on short panels the card is reached by
   * scrolling up. No-op without layout (getBoundingClientRect/scrollTop).
   * The final position is then held through later refreshes (holdPassAnchor).
   */
  function keepPassAnchored(anchor, render) {
    const { body } = satDom;
    passAnchor = null;
    const usable =
      anchor?.getBoundingClientRect &&
      !body.hidden &&
      typeof body.scrollTop === 'number';
    const before = usable ? anchor.getBoundingClientRect() : null;
    const result = render();
    if (!before || anchor.isConnected === false) return result;
    const shift = anchor.getBoundingClientRect().top - before.top;
    if (Math.abs(shift) >= 0.5) body.scrollTop += shift;
    revealPassGo(anchor);
    passAnchor = {
      node: anchor,
      top: anchor.getBoundingClientRect().top,
      until: now() + PASS_ANCHOR_MS,
    };
    return result;
  }

  /**
   * Scroll "Go to peak time" up into view as far as `anchor` stays in view:
   * first the body (the anchor may rise to the top edge), then, for a row
   * inside the nested passes list, slide the row down in that list while the
   * body scrolls on, so the row stays put and the action rises. A row tapped
   * while clipped at the top edge is first scrolled fully into view. When the
   * row, the rest of the list and the action are taller than the panel, the
   * action's sticky bottom edge (skyView.css) keeps it in view; the row is
   * then lifted just clear of it.
   */
  function revealPassGo(anchor) {
    const { body, passGo, passesList } = satDom;
    const b = body.getBoundingClientRect?.();
    if (!b) return;
    const l = passesList.getBoundingClientRect?.();
    const inList = Boolean(l) && passesList.contains?.(anchor);
    let a = anchor.getBoundingClientRect();
    if (inList && a.top < l.top && typeof passesList.scrollTop === 'number')
      passesList.scrollTop -= l.top - a.top;
    a = anchor.getBoundingClientRect();
    if (a.top < b.top) body.scrollTop -= b.top - a.top;
    if (passGo.disabled || !passGo.getBoundingClientRect) return;
    a = anchor.getBoundingClientRect();
    const g = passGo.getBoundingClientRect();
    let need = g.bottom - b.bottom;
    if (need > 0.5) {
      const s0 = body.scrollTop;
      body.scrollTop += Math.min(need, Math.max(0, a.top - b.top));
      need -= body.scrollTop - s0; // what the browser applied (max clamps)
    }
    if (need > 0.5 && inList && typeof passesList.scrollTop === 'number') {
      const lb = passesList.getBoundingClientRect().bottom;
      const s1 = body.scrollTop;
      body.scrollTop += Math.min(
        need,
        passesList.scrollTop,
        Math.max(0, lb - anchor.getBoundingClientRect().bottom),
      );
      passesList.scrollTop -= body.scrollTop - s1;
    }
    // a tapped row that pokes out below the nested list (the list box is
    // shorter than its rows, e.g. 109 px on a 390 px screen) is clipped there
    // and, with the action sticking to the body bottom, cannot be reached by
    // scrolling the body alone: slide the row up inside the list and let the
    // body follow so the row stays put (the body scrolls back by what the list
    // scrolled; the sticky action then rides the body bottom, below the row)
    if (
      anchor !== passGo &&
      inList &&
      typeof passesList.scrollTop === 'number'
    ) {
      const clip =
        anchor.getBoundingClientRect().bottom -
        passesList.getBoundingClientRect().bottom;
      if (clip > 0.5) {
        const s2 = passesList.scrollTop;
        passesList.scrollTop += clip;
        body.scrollTop -= passesList.scrollTop - s2;
      }
    }
    // in a browser the enabled action sticks to the body bottom (skyView.css),
    // so it is in view but may cover the tapped row: lift the row clear of it
    if (anchor === passGo) return;
    a = anchor.getBoundingClientRect();
    const over = passGo.getBoundingClientRect();
    const cover = a.bottom - over.top;
    if (cover > 0.5 && over.bottom > a.top)
      body.scrollTop += Math.min(cover + 4, Math.max(0, a.top - b.top));
  }

  /** Re-pin a just-tapped pass control after a panel refresh moved it. */
  function holdPassAnchor() {
    if (!passAnchor) return;
    const { node, top, until } = passAnchor;
    if (now() > until || satDom.body.hidden || node.isConnected === false) {
      passAnchor = null;
      return;
    }
    const shift = node.getBoundingClientRect().top - top;
    if (Math.abs(shift) >= 0.5) satDom.body.scrollTop += shift;
  }
  function releasePassAnchor() {
    passAnchor = null;
  }

  /** Keep the edge arrow clear of the satellite panel and the toolbar. */
  function arrowInsets(width, height) {
    const pad = 28;
    const insets = {};
    const panel = satDom.root.hidden
      ? null
      : satDom.root.getBoundingClientRect?.();
    if (panel && panel.width > 0 && panel.left < width / 2)
      insets.left = panel.right + pad;
    const bar = dom.bar.hidden ? null : dom.bar.getBoundingClientRect?.();
    if (bar && bar.height > 0 && bar.top < height / 2)
      insets.top = bar.bottom + pad;
    return insets;
  }

  function updateSatPanel() {
    if (!active) return;
    const t = time.getTime();
    const objects = satSky.objectsAt(t);
    const occlusion = (az, elDeg) => profileOcclusion(profile, az, elDeg);
    const stats = satSky.stats;
    const loads = satSky.loads;
    let statusText = '';
    if (satSky.status === 'unavailable')
      statusText =
        'Satellites need Web Workers, which this browser does not offer.';
    else if (satSky.status === 'loading') statusText = 'Loading satellites...';
    if (loads.get('active') === 'error')
      statusText =
        `${statusText} All-active list unavailable; showing the core groups.`.trim();
    const found = selectedIndex == null ? null : satSky.lookup(selectedIndex);
    renderSatPanel(satDom, {
      doc,
      list: overheadList(objects, {
        classesOn,
        occlusion,
        include: nakedEyeFilter(),
      }),
      banner: ageBanner(stats.age, t),
      card: found
        ? cardData(found, t, {
            nextPass: found.meta
              ? satSky.nextPass(found.meta.noradId, t)
              : null,
            rcsStatus: satSky.rcs.status,
          })
        : null,
      status: satSky.status,
      statusText,
      selectedIndex,
      passes: passesView(satSky.passes, t, {
        visibleOnly: nakedEyeOn,
        upcoming: upcomingPasses,
      }),
      selectedPassKey: passKey(selectedPass),
      nowMs: t,
      nakedEye: { on: nakedEyeOn, limit: magLimit },
    });
    holdPassAnchor();
  }

  /** The pass a "Next passes" row stands for (by key), or null. */
  function passByKey(key) {
    return satSky.passes.list.find((p) => passKey(p) === key) ?? null;
  }

  /** Select a pass: its object, its arc, and look at its peak. */
  function selectPass(pass, { look = true, anchor = null } = {}) {
    selectedPass = pass || null;
    if (!anchor) releasePassAnchor();
    if (!pass) {
      updateSatPanel();
      redraw();
      return;
    }
    selectedIndex = Number.isInteger(pass.index) ? pass.index : null;
    satSky.arcFor(pass);
    // a tapped control stays put (the card appears above it); the hook and
    // callers pass no anchor and keep the plain behaviour
    if (anchor) keepPassAnchored(anchor, updateSatPanel);
    else updateSatPanel();
    redraw();
    if (look && Number.isFinite(pass.peakAzDeg))
      lookAtDirection({ azDeg: pass.peakAzDeg, elDeg: pass.peakElevDeg });
  }

  /**
   * Set the Sky time to a pass peak ("Go to peak", "Next ISS pass"). The jump
   * goes through the time control like a preset: the one onTimeChange path
   * syncs the picker/Live/URL, a playing clock keeps playing from the peak,
   * and a playing clock keeps playing from the peak.
   */
  function goToPass(pass, { anchor = null } = {}) {
    if (!active || !pass || !Number.isFinite(pass.peakMs)) return false;
    // the jump re-renders the card and list too: anchor across both steps
    const jump = () => {
      selectPass(pass, { look: false });
      return timeControl.jumpTo(pass.peakMs);
    };
    const moved = anchor ? keepPassAnchored(anchor, jump) : jump();
    lookAtDirection({ azDeg: pass.peakAzDeg, elDeg: pass.peakElevDeg });
    return Boolean(moved);
  }

  /**
   * Next ISS pass not over at Sky time (VISIBLE ones by default), from the
   * "Next passes" scan. Named apart from the `nextIssPass` mount option
   *: a body declaration of that name would shadow the
   * option and hand this synchronous function to the time control.
   */
  function nextScannedIssPass({ visibleOnly = true } = {}) {
    return satSky.nextPass(ISS_NORAD, time.getTime(), { visibleOnly });
  }

  /** Redraw at <= SAT_FPS while satellites move (extrapolated between ticks). */
  function startSatAnimation() {
    if (satFrame != null || !active || !satSky.running) return;
    const step = () => {
      satFrame = null;
      if (!active || !satSky.running) return;
      const t = now();
      if (t - satFrameAt >= 1000 / SAT_FPS) {
        satFrameAt = t;
        redraw();
      }
      if (time.mode === 'live') satFrame = requestFrame(step);
    };
    satFrame = requestFrame(step);
  }
  function stopSatAnimation() {
    if (satFrame != null) cancelFrame(satFrame);
    satFrame = null;
  }

  function cancelLook() {
    if (lookFrame != null) cancelFrame(lookFrame);
    lookFrame = null;
  }
  /** Animated look-at a satellite (instant with reduced motion). */
  function lookAtSatellite(index) {
    const row = satSky.lookup(index)?.row;
    if (!row || !(row.elDeg > 0)) return false;
    return lookAtDirection(row);
  }
  /** Animated look-at a sky direction (instant with reduced motion). */
  function lookAtDirection({ azDeg, elDeg }) {
    if (!active || !Number.isFinite(azDeg) || !Number.isFinite(elDeg))
      return false;
    cancelLook();
    cancelInertia();
    const target = { azDeg, elDeg: clampEl(elDeg) };
    if (reducedMotion()) {
      applyView({ ...view, ...target });
      return true;
    }
    const from = view;
    const started = now();
    const step = () => {
      lookFrame = null;
      if (!active) return;
      const f = Math.min(1, (now() - started) / LOOK_AT_MS);
      applyView(lookAtView(from, target, f));
      if (f < 1) lookFrame = requestFrame(step);
    };
    lookFrame = requestFrame(step);
    if (lookFrame == null) applyView({ ...view, ...target });
    return true;
  }
  function selectSatellite(index, { look = false } = {}) {
    releasePassAnchor();
    const previous = selectedIndex;
    selectedIndex = Number.isInteger(index) ? index : null;
    if (selectedPass && selectedPass.index !== selectedIndex)
      selectedPass = null;
    updateSatPanel();
    if (selectedIndex != null && selectedIndex !== previous) revealCard();
    redraw();
    if (look && selectedIndex != null) lookAtSatellite(selectedIndex);
  }

  /**
   * The one place Sky time is applied: viewer.clock (Cesium sun lighting and
   * atmosphere), Sun altitude / magnitude limit, stars + ephemeris, picker,
   * banners, then a redraw. Satellites read the same time source.
   */
  /**
   * body.gev-sky-tiles: map tiles are on screen, so Clear view keeps the
   * app's attribution line (skyView.css). Written only on change (applyTime
   * runs every frame while Sky time plays).
   */
  let tilesShown = null;
  function setTilesShown(next) {
    if (next === tilesShown) return;
    tilesShown = next;
    if (next) doc.body?.classList?.add('gev-sky-tiles');
    else doc.body?.classList?.remove('gev-sky-tiles');
  }

  function applyTime() {
    if (!active || !observer) return;
    const t = time.getTime();
    applySkyTime(CesiumApi, viewer, t);
    lastSunAlt = observerSolarElevation(observer.latDeg, observer.lonDeg, t);
    content.update(t, observer);
    applySkyScene(viewer, sceneSnap, {
      flatHorizon: flags.flatHorizon,
      skyBox: skyBoxVisible(lastSunAlt),
    });
    setTilesShown(skyTilesShown(sceneSnap, { flatHorizon: flags.flatHorizon }));
    timeControl.tick(t);
    renderValidity(t);
    const lim = limMag(lastSunAlt);
    const info = `${describeObserver(observer, { sunAltDeg: lastSunAlt })} · faintest drawn mag ${fmt(lim, 1)}`;
    // write only on change: a DOM write per frame while playing would dirty
    // the page style before every canvas text/font use
    if (dom.info.textContent !== info) dom.info.textContent = info;
    if (orientation.running) syncOrientationUi();
    redraw();
  }

  function renderValidity(t) {
    timeControl.renderBanners(
      validityBanners({
        timeMs: t,
        satAge: satSky.running ? satSky.stats.age : null,
      }),
    );
  }

  // ── Sky time ─────────────────────────────────────────────────────────────
  let playFrame = null;
  let playFrameAt = -Infinity;
  /** Frame loop while the time plays (built-in play). */
  function syncPlayLoop() {
    const playing = active && time.moving && time.mode !== 'live';
    if (!playing) {
      if (playFrame != null) cancelFrame(playFrame);
      playFrame = null;
      return;
    }
    if (playFrame != null) return;
    const step = () => {
      playFrame = null;
      if (!active || !time.moving || time.mode === 'live') return;
      const wall = now();
      if (wall - playFrameAt >= 1000 / PLAY_FPS - 1) {
        playFrameAt = wall;
        applyTime();
      }
      playFrame = requestFrame(step);
    };
    playFrame = requestFrame(step);
  }

  /** Every time change (mode, jump, speed) goes through here. */
  function onTimeChange() {
    timeControl.sync();
    if (!active) return;
    satSky.setTickMs(
      time.moving && Math.abs(time.rate) > 1 ? FAST_TICK_MS : 1000,
    );
    applyTime();
    satSky.timeChanged();
    syncPlayLoop();
    scheduleUrl();
  }

  function applyView(next) {
    view = makeView(next);
    if (!active || !observer) return;
    applySkyCamera(CesiumApi, viewer.camera, observer, view);
    viewer.scene.requestRender?.();
    redraw();
    scheduleUrl();
  }

  function scheduleUrl() {
    if (!location?.href || !history?.replaceState) return;
    timers.clearTimeout?.(urlTimer);
    urlTimer = timers.setTimeout?.(() => {
      urlTimer = null;
      writeUrlNow();
    }, 400);
  }
  function writeUrlNow() {
    if (!location?.href || !history?.replaceState) return;
    const state =
      active && observer
        ? {
            latDeg: observer.latDeg,
            lonDeg: observer.lonDeg,
            view,
            // live has no fixed time
            timeMs: clock.mode === 'live' ? null : clock.getTime(),
            flags,
          }
        : null;
    const href = writeSkyUrl(location.href, state);
    if (href !== location.href) history.replaceState(history.state, '', href);
  }

  // ── entering and leaving ─────────────────────────────────────────────────
  async function enterAt({
    latDeg,
    lonDeg,
    source,
    accuracyM = null,
    heightM,
    heightKnown,
  }) {
    let ground = { heightM: heightM ?? 0, known: Boolean(heightKnown) };
    if (!ground.known) {
      setStatus('Reading the ground height...');
      const sampled = await sampleGroundHeight({
        Cesium: CesiumApi,
        viewer,
        latDeg,
        lonDeg,
      });
      ground = { heightM: sampled.heightM, known: sampled.known };
    }
    if (destroyed) return false;
    const next = createObserver({
      latDeg,
      lonDeg,
      groundHeightM: ground.heightM,
      heightKnown: ground.known,
      eyeHeightM: Number(dom.eye.value),
      source,
      accuracyM,
    });
    if (!next) {
      setStatus('That point is not a valid latitude/longitude.');
      return false;
    }
    return enter(next);
  }

  function enter(next) {
    let entered = false;
    runNavigation('sky view', () => {
      if (!active) {
        cameraSnap = snapshotCamera(CesiumApi, viewer.camera);
        sceneSnap = snapshotScene(CesiumApi, viewer, { nowMs: now() });
      }
      observer = next;
      active = true;
      entered = true;
      dropSize();
      dom.canvas.hidden = false;
      dom.bar.hidden = false;
      dom.panel.hidden = true;
      dom.button.setAttribute('aria-expanded', 'false');
      doc.body?.classList?.add('gev-sky-active');
      content.start(observer, time.getTime());
      timeControl.sync();
      applyTime();
      applyView(view);
      startTicking();
      refreshProfile();
      satDom.root.hidden = false;
      syncSkyLayout();
      beltPoints = geoBeltPoints(observer.latDeg, observer.lonDeg);
      satSky.start(observer);
      updateSatPanel();
      if (orientation.running)
        orientation.setDeclination(
          declinationAt(observer.latDeg, observer.lonDeg),
        );
      syncOrientationUi();
      satSky.setTickMs(
        time.moving && Math.abs(time.rate) > 1 ? FAST_TICK_MS : 1000,
      );
      syncPlayLoop();
      dom.canvas.focus?.();
      clearView.setActive(true);
    });
    if (!entered) setStatus('Sky view is not available in this mode.');
    return entered;
  }

  /**
   * Leave the sky. `keepCamera` is for when another navigation (a search,
   * a fly-to) already took the camera: put the scene back but do not fight it.
   */
  function exit({ keepCamera = false } = {}) {
    if (!active) return;
    if (orientation.running) orientation.stop();
    setNote('');
    view = makeView({ ...view, rollDeg: 0 });
    active = false;
    syncOrientationUi();
    stopTicking();
    cancelInertia();
    content.stop();
    cancelLook();
    stopSatAnimation();
    syncPlayLoop();
    satSky.stop();
    satModel = null;
    satObjects = null;
    selectedIndex = null;
    selectedPass = null;
    press = null;
    satDom.root.hidden = true;
    if (!keepCamera) restoreCamera(CesiumApi, viewer.camera, cameraSnap);
    restoreScene(CesiumApi, viewer, sceneSnap, { nowMs: now() });
    cameraSnap = null;
    sceneSnap = null;
    profile = null;
    profileToken += 1;
    pointers.clear();
    pinch = null;
    dom.canvas.hidden = true;
    dom.bar.hidden = true;
    lastTap = null;
    clearView.setActive(false);
    setTilesShown(null);
    doc.body?.classList?.remove('gev-sky-active');
    timers.clearTimeout?.(urlTimer);
    urlTimer = null;
    writeUrlNow();
    viewer.scene.requestRender?.();
  }

  async function refreshProfile() {
    const token = ++profileToken;
    profile = null;
    const result = await computeHorizonProfile({
      Cesium: CesiumApi,
      terrainProvider:
        viewer.terrainProvider ?? viewer.scene.globe?.terrainProvider,
      observer,
    });
    if (token === profileToken && active) {
      profile = result;
      redraw();
    }
  }

  function startTicking() {
    stopTicking();
    tickTimer = timers.setInterval?.(() => {
      if (cameraTakenElsewhere()) {
        exit({ keepCamera: true });
        return;
      }
      // live: once a second; playing: the frame loop does it, this is the
      // fallback when frames do not run (background tab, no rAF)
      if (time.moving) applyTime();
    }, 1000);
  }
  /** True when something else (search, fly-to, voice) moved the camera away. */
  function cameraTakenElsewhere() {
    if (!observer) return false;
    const eye = CesiumApi.Cartesian3.fromDegrees(
      observer.lonDeg,
      observer.latDeg,
      observer.groundHeightM + observer.eyeHeightM,
    );
    const at = viewer.camera.positionWC ?? viewer.camera.position;
    return CesiumApi.Cartesian3.distance(eye, at) > 100;
  }
  function stopTicking() {
    if (tickTimer != null) timers.clearInterval?.(tickTimer);
    tickTimer = null;
  }

  // ── picking on the map ───────────────────────────────────────────────────
  function pickAt(position) {
    const scene = viewer.scene;
    let cartesian;
    let known = false;
    if (
      scene.pickPositionSupported &&
      typeof scene.pickPosition === 'function'
    ) {
      try {
        cartesian = scene.pickPosition(position);
        known = Boolean(cartesian);
      } catch {
        cartesian = undefined;
      }
    }
    let carto = cartesian
      ? CesiumApi.Cartographic.fromCartesian(cartesian)
      : undefined;
    if (
      carto &&
      !(
        carto.height > PLAUSIBLE_GROUND_M[0] &&
        carto.height < PLAUSIBLE_GROUND_M[1]
      )
    ) {
      carto = undefined;
      known = false;
    }
    if (!carto) {
      const ellipsoidPoint = viewer.camera.pickEllipsoid?.(position);
      carto = ellipsoidPoint
        ? CesiumApi.Cartographic.fromCartesian(ellipsoidPoint)
        : undefined;
      known = false;
    }
    if (!carto) return null;
    return {
      latDeg: CesiumApi.Math.toDegrees(carto.latitude),
      lonDeg: CesiumApi.Math.toDegrees(carto.longitude),
      heightM: known ? carto.height : 0,
      heightKnown: known,
    };
  }

  function stopPicking() {
    picker?.destroy?.();
    picker = null;
    doc.body?.classList?.remove('gev-sky-picking');
  }

  function startPicking() {
    stopPicking();
    if (!CesiumApi.ScreenSpaceEventHandler || !viewer.scene.canvas) {
      setStatus('Map picking is not available here.');
      return;
    }
    picker = new CesiumApi.ScreenSpaceEventHandler(viewer.scene.canvas);
    doc.body?.classList?.add('gev-sky-picking');
    setStatus('Click a point on the globe to stand there (Esc cancels).');
    picker.setInputAction((event) => {
      const hit = pickAt(event.position);
      stopPicking();
      if (!hit) {
        setStatus('No ground under that point. Try again on the globe.');
        return;
      }
      enterAt({ ...hit, source: 'map' });
    }, CesiumApi.ScreenSpaceEventType.LEFT_CLICK);
  }

  function screenCentre() {
    const { width, height } = canvasSize();
    const hit = pickAt(new CesiumApi.Cartesian2(width / 2, height / 2));
    if (!hit) {
      setStatus(
        'No ground at the screen centre. Pick a point on the map instead.',
      );
      return;
    }
    enterAt({ ...hit, source: 'map' });
  }

  /** Voice open: the map centre, with a fixed reason when it cannot. */
  let opening = null;
  function openHere() {
    if (active) return Promise.resolve({ ok: true, alreadyOpen: true });
    if (opening) return opening;
    opening = (async () => {
      const { width, height } = canvasSize();
      const hit = pickAt(new CesiumApi.Cartesian2(width / 2, height / 2));
      if (!hit)
        return {
          ok: false,
          error:
            'No ground at the screen centre. Move the map onto land first.',
        };
      const entered = await enterAt({ ...hit, source: 'map' });
      if (!entered)
        return {
          ok: false,
          error: 'Sky view is not available in this mode.',
        };
      return { ok: true };
    })().finally(() => {
      opening = null;
    });
    return opening;
  }

  async function submitQuery() {
    const text = String(dom.input.value || '').trim();
    if (!text) return;
    const parsed = parseLatLon(text);
    if (parsed) {
      await enterAt({ ...parsed, source: 'manual' });
      return;
    }
    setStatus(`Searching for "${text}"...`);
    let place = null;
    try {
      place = await geocode(text);
    } catch {
      place = null;
    }
    if (destroyed) return;
    if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) {
      setStatus(`No place found for "${text}". Try "lat, lon".`);
      return;
    }
    await enterAt({ latDeg: place.lat, lonDeg: place.lng, source: 'manual' });
  }

  // ── looking around ───────────────────────────────────────────────────────
  function cancelInertia() {
    if (inertiaFrame != null) globalThis.cancelAnimationFrame?.(inertiaFrame);
    inertiaFrame = null;
  }
  function startInertia(velocity) {
    cancelInertia();
    if (!globalThis.requestAnimationFrame) return;
    let v = velocity;
    let last = now();
    const step = () => {
      const t = now();
      const s = inertiaStep(v, t - last);
      last = t;
      v = s.velocity;
      applyView({
        ...view,
        azDeg: view.azDeg + s.dAz,
        elDeg: view.elDeg + s.dEl,
      });
      inertiaFrame =
        Math.abs(v.az) + Math.abs(v.el) > 1e-4
          ? globalThis.requestAnimationFrame(step)
          : null;
    };
    inertiaFrame = globalThis.requestAnimationFrame(step);
  }

  const distance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  function canvasPoint(event) {
    const rect = dom.canvas.getBoundingClientRect?.();
    return {
      x: event.clientX - (rect?.left || 0),
      y: event.clientY - (rect?.top || 0),
    };
  }
  function onPointerDown(event) {
    if (!active) return;
    cancelInertia();
    cancelLook();
    press =
      pointers.size === 0
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, t: now() }
        : null;
    dom.canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      t: now(),
      vAz: 0,
      vEl: 0,
    });
    if (pointers.size === 2) {
      pinch = { distance: distance(), view };
      lastTap = null;
    }
  }
  function onPointerMove(event) {
    const p = pointers.get(event.pointerId);
    if (!active || !p) return;
    if (pointers.size >= 2) {
      p.x = event.clientX;
      p.y = event.clientY;
      if (pinch)
        applyView(pinchView(view, pinch.view, pinch.distance, distance()));
      return;
    }
    if (orientation.running) {
      // a real drag (not a tap on a satellite) hands control back
      if (
        !press ||
        Math.hypot(event.clientX - press.x, event.clientY - press.y) < CLICK_PX
      )
        return;
      stopPointing(
        'Drag took over. Tap Point at the sky to follow the phone again.',
      );
      p.x = event.clientX;
      p.y = event.clientY;
      p.t = now();
    }
    const { width, height } = canvasSize();
    const dx = event.clientX - p.x;
    const dy = event.clientY - p.y;
    const before = view;
    applyView(dragView(view, dx, dy, width, height));
    const t = now();
    const dt = Math.max(1, t - p.t);
    let dAz = view.azDeg - before.azDeg;
    if (dAz > 180) dAz -= 360;
    if (dAz < -180) dAz += 360;
    p.vAz = dAz / dt;
    p.vEl = (view.elDeg - before.elDeg) / dt;
    p.x = event.clientX;
    p.y = event.clientY;
    p.t = t;
  }
  function onPointerUp(event) {
    const p = pointers.get(event.pointerId);
    pointers.delete(event.pointerId);
    if (
      active &&
      press &&
      press.id === event.pointerId &&
      event.type !== 'pointercancel' &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) < CLICK_PX &&
      now() - press.t < CLICK_MS
    ) {
      press = null;
      const tap = { t: now(), x: event.clientX, y: event.clientY };
      if (isDoubleTap(lastTap, tap)) {
        // second tap: Clear view on/off, and the first tap's selection
        // change is undone so a double-tap changes nothing in the sky
        const before = lastTap.selection;
        lastTap = null;
        if (before.index !== selectedIndex || before.pass !== selectedPass) {
          selectedIndex = before.index;
          selectedPass = before.pass;
          updateSatPanel();
          redraw();
        }
        clearView.toggle();
        return;
      }
      lastTap = {
        ...tap,
        selection: { index: selectedIndex, pass: selectedPass },
      };
      const { x, y } = canvasPoint(event);
      const hit = hitTest(satModel, x, y);
      if (hit != null || selectedIndex != null) selectSatellite(hit);
      return;
    }
    press = null;
    lastTap = null; // a drag or pinch in between: not a double-tap
    if (pointers.size < 2) pinch = null;
    if (!active || !p || pointers.size) return;
    if (
      !orientation.running &&
      now() - p.t < 80 &&
      Math.abs(p.vAz) + Math.abs(p.vEl) > 0.005
    )
      startInertia({ az: p.vAz, el: p.vEl });
  }
  function onWheel(event) {
    if (!active) return;
    event.preventDefault?.();
    applyView(zoomView(view, wheelZoomFactor(event.deltaY)));
  }
  function onKey(event) {
    if (!active) return;
    if (event.key === 'Escape') {
      exit();
      return;
    }
    if (timeControl.onKey(event)) {
      event.preventDefault?.();
      return;
    }
    const next = keyView(view, event.key);
    if (next) {
      event.preventDefault?.();
      const turns = next.azDeg !== view.azDeg || next.elDeg !== view.elDeg;
      if (turns && orientation.running) {
        stopPointing(
          'Keys took over. Tap Point at the sky to follow the phone again.',
        );
        applyView(keyView(view, event.key));
        return;
      }
      applyView(next);
    }
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  const togglePanel = (open = dom.panel.hidden) => {
    dom.panel.hidden = !open;
    dom.button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) stopPicking();
  };
  listen(dom.button, 'click', () => {
    if (active) exit();
    else togglePanel();
  });
  listen(dom.buttons.close, 'click', () => togglePanel(false));
  listen(dom.buttons.pick, 'click', () => startPicking());
  listen(dom.buttons.here, 'click', () => screenCentre());
  listen(dom.buttons.gps, 'click', () => geolocator.request());
  listen(dom.form, 'submit', (event) => {
    event.preventDefault?.();
    submitQuery();
  });
  listen(dom.buttons.back, 'click', () => exit());
  listen(clearView.button, 'click', () => clearView.toggle());
  // Clear view keys (H toggles, Escape restores) win over the app's own
  // shortcuts (H = HUD) while the sky is shown: capture phase, stopped here.
  // A held-down H repeats keydown: each repeat is stopped too (else it flips
  // the HUD under the clear sky) but does not toggle Clear view again.
  listen(
    doc,
    'keydown',
    (event) => {
      if (!active) return;
      clearView.wake();
      const action = clearKeyAction(event, { clear: clearView.on });
      if (!action) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      if (action === 'restore') clearView.set(false);
      else if (action === 'toggle') clearView.toggle();
    },
    true,
  );
  // any touch or click brings the faded handle back
  listen(doc, 'pointerdown', () => clearView.wake(), true);
  listen(dom.buttons.point, 'click', () => togglePointing());
  listen(dom.buttons.alignSun, 'click', () => alignOn('sun'));
  listen(dom.buttons.alignMoon, 'click', () => alignOn('moon'));
  listen(dom.buttons.alignTarget, 'click', () => alignOn('selected'));
  listen(dom.buttons.alignReset, 'click', () => {
    orientation.resetOffset();
    setNote('Align offset cleared.');
    syncOrientationUi();
  });
  listen(dom.buttons.move, 'click', () => {
    exit();
    togglePanel(true);
    startPicking();
  });
  listen(dom.buttons.flat, 'click', () => {
    flags = { ...flags, flatHorizon: !flags.flatHorizon };
    setPressed(dom.buttons.flat, flags.flatHorizon);
    content.setFlags({ flatHorizon: flags.flatHorizon });
    applyTime();
    scheduleUrl();
  });
  listen(dom.buttons.grid, 'click', () => {
    flags = { ...flags, grid: !flags.grid };
    setPressed(dom.buttons.grid, flags.grid);
    content.setFlags({ grid: flags.grid });
    redraw();
    scheduleUrl();
  });
  listen(dom.eye, 'change', () => {
    if (!observer) return;
    observer =
      createObserver({ ...observer, eyeHeightM: Number(dom.eye.value) }) ||
      observer;
    dom.eye.value = String(observer.eyeHeightM);
    applyView(view);
    refreshProfile();
  });
  // satellite panel
  listen(satDom.fold, 'click', () => {
    const open = satDom.body.hidden;
    satDom.body.hidden = !open;
    satDom.fold.setAttribute('aria-expanded', open ? 'true' : 'false');
    satDom.fold.textContent = open ? '–' : '+';
  });
  for (const [klass, chip] of Object.entries(satDom.chips)) {
    listen(chip, 'click', () => {
      if (classesOn.has(klass)) classesOn.delete(klass);
      else classesOn.add(klass);
      setPressed(chip, classesOn.has(klass));
      updateSatPanel();
      redraw();
    });
  }
  listen(satDom.active, 'click', () => {
    const on = !satSky.sets.active;
    setPressed(satDom.active, on);
    satSky.setSets({ active: on });
  });
  listen(satDom.starlink, 'click', () => {
    const on = !satSky.sets.starlink;
    setPressed(satDom.starlink, on);
    satSky.setSets({ starlink: on });
  });
  listen(satDom.belt, 'click', () => {
    geoBelt = !geoBelt;
    setPressed(satDom.belt, geoBelt);
    redraw();
  });
  listen(satDom.list, 'click', (event) => {
    const index = listIndexFromTarget(
      satDom.list,
      event.target,
      satSky.meta.length,
    );
    if (index != null) selectSatellite(index, { look: true });
  });
  listen(satDom.look, 'click', () => {
    if (selectedIndex != null) lookAtSatellite(selectedIndex);
  });
  listen(satDom.clear, 'click', () => {
    selectedPass = null;
    selectSatellite(null);
  });
  listen(satDom.nakedEye, 'click', () => {
    nakedEyeOn = !nakedEyeOn;
    updateSatPanel();
    redraw();
  });
  listen(satDom.magLimit, 'input', () => {
    magLimit = clampMagLimit(satDom.magLimit.value);
    updateSatPanel();
    redraw();
  });
  listen(satDom.passesList, 'click', (event) => {
    const button = event.target?.closest?.('button[data-pass]') ?? event.target;
    const pass = passByKey(button?.getAttribute?.('data-pass'));
    if (pass) selectPass(pass, { anchor: button });
  });
  // the user taking over the panel ends the hold on a tapped pass control
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown'])
    listen(satDom.body, type, releasePassAnchor, { passive: true });
  listen(satDom.passGo, 'click', () => {
    if (selectedPass) goToPass(selectedPass, { anchor: satDom.passGo });
  });
  listen(satDom.nextIss, 'click', () => {
    const pass = nextScannedIssPass();
    if (pass) goToPass(pass, { anchor: satDom.nextIss });
    else showToast(t('No visible ISS pass found in the next 48 hours yet.'));
  });
  time.subscribe(() => onTimeChange());

  listen(dom.canvas, 'pointerdown', onPointerDown);
  listen(dom.canvas, 'pointermove', onPointerMove);
  listen(dom.canvas, 'pointerup', onPointerUp);
  listen(dom.canvas, 'pointercancel', onPointerUp);
  listen(dom.canvas, 'wheel', onWheel, { passive: false });
  listen(dom.canvas, 'keydown', onKey);
  listen(doc, 'keydown', (event) => {
    if (event.key === 'Escape' && picker) {
      stopPicking();
      setStatus('');
    }
  });
  listen(globalThis.window, 'resize', () => {
    dropSize();
    syncSkyLayout();
    redraw();
  });
  if (typeof globalThis.ResizeObserver === 'function') {
    // The toolbar also changes height when its info line rewraps.
    const barObserver = new globalThis.ResizeObserver(() => syncSkyLayout());
    barObserver.observe(dom.bar);
    removers.push(() => barObserver.disconnect());
    if (viewer.scene.canvas) {
      const resizeObserver = new globalThis.ResizeObserver(() => {
        dropSize();
        if (active) redraw();
      });
      resizeObserver.observe(viewer.scene.canvas);
      removers.push(() => resizeObserver.disconnect());
    }
  }

  // Hidden while the camera follows an entity (CSS hides it in cockpit,
  // playback, recording and clean-view modes, like the nav control).
  const syncFollowing = () => {
    const following = Boolean(viewer.trackedEntity);
    dom.button.hidden = following && !active;
    if (following) togglePanel(false);
  };
  const removeTracked =
    viewer.trackedEntityChanged?.addEventListener?.(syncFollowing);
  if (typeof removeTracked === 'function') removers.push(removeTracked);
  syncFollowing();

  // A shared `sv` link opens straight into the sky once startup settles.
  const fromUrl = location?.href ? readSkyUrl(location.href) : null;
  if (fromUrl) {
    view = fromUrl.view;
    flags = { ...flags, ...fromUrl.flags };
    setPressed(dom.buttons.flat, flags.flatHorizon);
    setPressed(dom.buttons.grid, flags.grid);
    content.setFlags(flags);
    // readSkyUrl already applied the precedence: `ht` wins over the sv time
    if (Number.isFinite(fromUrl.timeMs)) clock.setFixed(fromUrl.timeMs);
    autoTimer = timers.setTimeout?.(() => {
      autoTimer = null;
      enterAt({
        latDeg: fromUrl.latDeg,
        lonDeg: fromUrl.lonDeg,
        source: 'url',
      });
    }, autoEnterDelayMs);
  }

  timeControl.sync();

  const handle = {
    get destroyed() {
      return destroyed;
    },
    get active() {
      return active;
    },
    get observer() {
      return observer;
    },
    get view() {
      return view;
    },
    get flags() {
      return { ...flags };
    },
    get profile() {
      return profile;
    },
    /** Built-in Sky clock (live/fixed/play). */
    get clock() {
      return clock;
    },
    /** The time source everything reads. */
    get time() {
      return time;
    },
    get timeControl() {
      return timeControl;
    },
    /** Jump to a preset ('sunset' | 'dusk' | 'midnight' | 'moonrise' | 'iss'). */
    applyPreset: (id) => timeControl.applyPreset(id),
    get geolocator() {
      return geolocator;
    },
    /** Phone pointing controller. */
    get orientation() {
      return orientation;
    },
    togglePointing: () => togglePointing(),
    /** Clear view controller (clearView.js): on, set(), toggle(). */
    get clearView() {
      return clearView;
    },
    alignOn: (which) => alignOn(which),
    /** Stars, constellations, bodies, layers and search. */
    get content() {
      return content;
    },
    /** Satellites controller (stats, objects, sets) and the last drawn model. */
    get satellites() {
      return satSky;
    },
    get satelliteModel() {
      return satModel;
    },
    get selectedSatellite() {
      return selectedIndex;
    },
    selectSatellite: (index, options) => selectSatellite(index, options),
    /** naked-eye filter state and setters. */
    get nakedEye() {
      return { on: nakedEyeOn, limit: magLimit };
    },
    setNakedEye({ on = nakedEyeOn, limit = magLimit } = {}) {
      nakedEyeOn = Boolean(on);
      magLimit = clampMagLimit(limit);
      satDom.magLimit.value = String(magLimit);
      updateSatPanel();
      redraw();
    },
    get selectedPass() {
      return selectedPass;
    },
    selectPass: (pass, options) => selectPass(pass, options),
    /** Hook for "Next ISS pass" time preset. */
    nextIssPass: (options) => nextScannedIssPass(options),
    goToPass: (pass) => goToPass(pass),
    lookAtSatellite: (index) => lookAtSatellite(index),
    satelliteElements: satDom,
    elements: dom,
    enterAt,
    exit: () => exit(),
    openHere: () => openHere(),
    setTime: (ms) => timeControl.jumpTo(ms),
    goLive() {
      clock.setLive();
      return true;
    },
    setView: (next) => applyView({ ...view, ...next }),
    redraw,
    /** Overlay redraw timings (ms): count, p50, p95, max. */
    redrawPerf() {
      const sorted = [...redrawPerf].sort((a, b) => a - b);
      const at = (q) =>
        sorted.length
          ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
          : NaN;
      return {
        count: sorted.length,
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? NaN,
      };
    },
    resetRedrawPerf() {
      redrawPerf.length = 0;
    },
    /** 'clear' | 'terrain' | 'below' for a sky direction. */
    occlusion: (azDeg, elDeg) => profileOcclusion(profile, azDeg, elDeg),
    destroy() {
      if (destroyed) return;
      if (hookWindow?.__gevSky?.voice === skyVoice) delete hookWindow.__gevSky;
      exit();
      stopPicking();
      content.destroy();
      orientation.destroy();
      timers.clearTimeout?.(noteTimer);
      clearView.destroy();
      timeControl.destroy();
      time.destroy();
      destroyed = true;
      timers.clearTimeout?.(autoTimer);
      timers.clearTimeout?.(urlTimer);
      for (const remove of removers.splice(0)) remove();
      dom.button.remove?.();
      dom.panel.remove?.();
      dom.bar.remove?.();
      satDom.root.remove?.();
      dom.canvas.remove?.();
      dom.crosshair.remove?.();
      mounted.delete(viewer);
    },
  };
  mounted.set(viewer, handle);
  skyVoice = createSkyVoice({
    getHandle: () => (handle.destroyed ? null : handle),
  });
  handle.voice = skyVoice;
  if (hookWindow) hookWindow.__gevSky = { voice: skyVoice };
  lifetime?.removers?.add?.(() => handle.destroy());
  return handle;
}

/** The mounted Sky view for a viewer (QA harnesses and later cards). */
export function skyViewFor(viewer) {
  const handle = viewer ? mounted.get(viewer) : null;
  return handle && !handle.destroyed ? handle : null;
}

/**
 * The one call the application shell makes (beside its nav control mount):
 * wires the shell's viewer, lifetime, navigation policy and toast.
 */
export function mountSkyViewForShell(shell) {
  return mountSkyView({
    viewer: shell.viewer,
    lifetime: shell._lifetime,
    runNavigation: (noun, navigate) =>
      shell._navigation?.runOrientation
        ? shell._navigation.runOrientation(noun, navigate)
        : navigate(),
    showToast: (message) => shell._showToast?.(message),
  });
}
