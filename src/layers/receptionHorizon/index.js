import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { resolveAntenna } from './antenna.js';
import { createHorizonModel, validAntennaPosition } from './model.js';
import {
  ANTENNA_SOURCE_LABELS,
  HORIZON_HEIGHT_EXAGGERATION,
  HORIZON_REDRAW_MS,
  LAYER_ID,
  LAYER_NAME,
  LAYER_SOURCE,
} from './policy.js';
import { createHorizonRenderer } from './rendering.js';

export { LAYER_ID as RECEPTION_HORIZON_LAYER_ID } from './policy.js';
export { createHorizonModel, horizonArcs } from './model.js';
export { createReceiverPositionSource, resolveAntenna } from './antenna.js';

const POINTER_OWNER = 'reception-horizon';
const KM_PER_NM = 1.852;

const NBSP = ' ';

/** A count for `{count}` placeholders, in the active language's digits. */
function countValue(n) {
  return { count: formatNumber(n) };
}

/** Units (km, NM, ft, FL) are symbols and stay as they are; numbers localize. */
function formatKm(km) {
  return `${formatNumber(Math.round(km))}${NBSP}km`;
}

function formatRange(km) {
  return `${formatKm(km)} (${formatNumber(Math.round(km / KM_PER_NM))}${NBSP}NM)`;
}

function formatAltitude(feet) {
  return feet >= 18_000
    ? `FL${String(Math.round(feet / 100)).padStart(3, '0')}`
    : `${formatNumber(Math.round(feet))}${NBSP}ft`;
}

function antennaLabel(antenna) {
  if (!antenna) return null;
  if (antenna.source === 'feed' && antenna.feedLabel)
    return `${antenna.feedLabel} receiver.json`;
  const key = ANTENNA_SOURCE_LABELS[antenna.source];
  return key ? t(key) : antenna.source;
}

/**
 * The row's one-line readout, in the active language. Pure, for tests.
 * @param {object} snapshot Horizon snapshot.
 * @param {object|null} antenna Resolved antenna.
 * @param {object} [state] `{ armed, pointerBlocked, verticalScale }`.
 * @returns {string}
 */
export function receptionHorizonInfo(
  snapshot,
  antenna,
  { armed = false, pointerBlocked = false, verticalScale = 1 } = {},
) {
  if (armed) return t('Click your antenna on the globe (Esc cancels).');
  if (pointerBlocked)
    return t('Another tool is using map clicks. Finish it, then SET ANTENNA.');
  if (!antenna) {
    const ask = t(
      "Needs your antenna position: LOCATE in the Radio card, a location in your decoder's receiver.json, or SET ANTENNA.",
    );
    if (!snapshot.pending) return ask;
    const waiting = tn(
      snapshot.pending,
      '{count} position waiting.',
      '{count} positions waiting.',
      countValue(snapshot.pending),
    );
    return `${ask} ${waiting}`;
  }
  const parts = [t('Antenna: {source}', { source: antennaLabel(antenna) })];
  if (!snapshot.counted) parts.push(t('waiting for aircraft from Local ADS-B'));
  else
    parts.push(
      t('{positions} from {aircraft}', {
        positions: tn(
          snapshot.counted,
          '{count} position',
          '{count} positions',
          countValue(snapshot.counted),
        ),
        aircraft: tn(
          snapshot.aircraft,
          '{count} aircraft',
          '{count} aircraft',
          countValue(snapshot.aircraft),
        ),
      }),
    );
  const far = snapshot.farthest;
  if (far)
    parts.push(
      t('farthest {range} at {bearing}°, {altitude}', {
        range: formatRange(far.rangeKm),
        bearing: formatNumber(Math.round(far.bearingDeg) % 360),
        altitude: formatAltitude(far.altitudeFt),
      }),
    );
  if (snapshot.implausible)
    parts.push(
      tn(
        snapshot.implausible,
        '{count} position beyond line of sight ignored',
        '{count} positions beyond line of sight ignored',
        countValue(snapshot.implausible),
      ),
    );
  if (verticalScale !== 1)
    parts.push(t('heights ×{scale} for display', { scale: verticalScale }));
  return parts.join(' · ');
}

/**
 * Reception Horizon layer: what the user's own antenna can hear from where it
 * stands. Per altitude band, the farthest position heard in each direction,
 * drawn as a stepped 3D shell around the antenna.
 *
 * Built only from this page session's Local ADS-B positions (only fixes that
 * passed the speed check against the aircraft's previous accepted fix), kept
 * in memory and never shared, stored or sent anywhere. Positions are taken
 * from the moment the page loads, whether or not this layer is on.
 *
 * The antenna position comes from, in order: a spot the user clicks after
 * SET ANTENNA (memory only), the decoder's `receiver.json` through
 * `/api/local-receivers/receiver`, or the Radio card's LOCATE.
 * @param {object} options
 * @param {object} options.localAdsb The Local ADS-B layer module
 *   (`subscribeHeardFixes`, optional `receiver` session).
 * @param {object} [options.positions] Receiver position source
 *   (`createReceiverPositionSource`).
 * @param {object} options.services `render` (`governorRequestRender`),
 *   `input` (pointer ownership) and `scenePick` (`isPickedWorldPosition`).
 * @param {object} [options.model] Horizon model, injectable for tests.
 * @param {Function} [options.createRenderer] Renderer factory.
 * @param {(canvas: HTMLCanvasElement) => object} [options.createInputHandler]
 * @param {Document|null} [options.document] For the Escape key.
 * @returns {object} Data-layer module.
 */
export function createReceptionHorizonLayer({
  localAdsb,
  positions = null,
  services,
  model = createHorizonModel(),
  createRenderer = createHorizonRenderer,
  createInputHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
  document: doc = typeof document === 'undefined' ? null : document,
}) {
  if (typeof localAdsb?.subscribeHeardFixes !== 'function')
    throw new TypeError('Reception Horizon requires the Local ADS-B layer');
  const { governorRequestRender } = services.render;
  const input = services.input;

  let viewer = null;
  let renderer = null;
  let enabled = false;
  let manual = null;
  let antenna = null;
  let verticalScale = 1;
  let armed = false;
  let pointerBlocked = false;
  let lease = null;
  let clickHandler = null;
  let redrawTimer = null;
  let rowListener = null;
  let unsubscribeFixes = null;
  let unsubscribePositions = null;
  let unsubscribeReceiver = null;

  function notifyRow() {
    rowListener?.();
  }

  function redraw() {
    clearTimeout(redrawTimer);
    redrawTimer = null;
    if (!enabled || !renderer) return;
    if (renderer.draw(model.snapshot(), { verticalScale }))
      governorRequestRender('reception-horizon');
    notifyRow();
  }

  /** Coalesce bursts of positions into one redraw per interval. */
  function scheduleRedraw() {
    if (!enabled || redrawTimer) return;
    redrawTimer = setTimeout(redraw, HORIZON_REDRAW_MS);
  }

  function refreshAntenna() {
    const next = resolveAntenna({
      manual,
      receivers: positions?.getState?.()?.receivers || [],
      browserLocation:
        localAdsb.receiver?.getState?.()?.receiverLocation || null,
    });
    const moved = model.setAntenna(next);
    const relabelled =
      next?.source !== antenna?.source ||
      next?.feedLabel !== antenna?.feedLabel;
    antenna = next;
    if (moved) redraw();
    else if (relabelled) notifyRow();
  }

  function onFix(fix) {
    model.ingest(fix);
    scheduleRedraw();
  }

  // ── Antenna placement ───────────────────────────────────────────────────

  function pickGround(screenPosition) {
    const scene = viewer?.scene;
    let cartesian = null;
    if (
      scene?.pickPositionSupported &&
      typeof scene.pickPosition === 'function'
    ) {
      try {
        cartesian = scene.pickPosition(screenPosition);
      } catch {
        cartesian = null;
      }
    }
    if (
      !services.scenePick.isPickedWorldPosition(cartesian) &&
      typeof viewer?.camera?.pickEllipsoid === 'function'
    ) {
      try {
        cartesian = viewer.camera.pickEllipsoid(
          screenPosition,
          Cesium.Ellipsoid.WGS84,
        );
      } catch {
        cartesian = null;
      }
    }
    if (!services.scenePick.isPickedWorldPosition(cartesian)) return null;
    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
    };
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && armed) disarm();
  }

  function installClickHandler() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    clickHandler = createInputHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (!enabled || !armed || !input.isLeaseCurrent(lease)) return;
      const point = pickGround(click.position);
      if (!point) return;
      placeAntenna(point);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    doc?.addEventListener?.('keydown', onKeyDown);
  }

  function removeClickHandler() {
    clickHandler?.destroy?.();
    clickHandler = null;
    doc?.removeEventListener?.('keydown', onKeyDown);
  }

  function disarm() {
    const wasArmed = armed;
    armed = false;
    if (lease) input.releasePointer(lease);
    lease = null;
    if (wasArmed) notifyRow();
  }

  /**
   * Arm a globe click that places the antenna. Placement is a tool: it takes
   * the pointer so no layer also selects what is under the click, and it
   * refuses (saying why) when another tool holds it.
   * @returns {boolean} Whether a click is now armed.
   */
  function arm() {
    if (!enabled) return false;
    if (armed) {
      disarm();
      return false;
    }
    const claimed = input.claimPointer(POINTER_OWNER);
    if (!claimed) {
      pointerBlocked = true;
      notifyRow();
      return false;
    }
    pointerBlocked = false;
    lease = claimed;
    armed = true;
    notifyRow();
    return true;
  }

  function placeAntenna(point) {
    manual = point;
    // Release after this click has finished dispatching, so no ambient
    // selection handler on the same canvas treats it as its own.
    const placed = lease;
    lease = null;
    armed = false;
    setTimeout(() => input.releasePointer(placed), 0);
    refreshAntenna();
    notifyRow();
  }

  function useAutomaticAntenna() {
    if (!manual) return false;
    manual = null;
    refreshAntenna();
    notifyRow();
    return true;
  }

  function reset() {
    model.reset();
    redraw();
  }

  function toggleHeightScale() {
    verticalScale = verticalScale === 1 ? HORIZON_HEIGHT_EXAGGERATION : 1;
    redraw();
    return verticalScale;
  }

  return {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '📶',
    source: LAYER_SOURCE,
    updateInterval: 0,
    statsRefreshInterval: HORIZON_REDRAW_MS,

    init(nextViewer) {
      viewer = nextViewer;
      if (viewer?.scene?.primitives)
        renderer = createRenderer({ primitives: viewer.scene.primitives });
      // The horizon covers the whole page session, not only the time it is
      // shown: positions are buffered from the start.
      unsubscribeFixes = localAdsb.subscribeHeardFixes(onFix);
      return true;
    },

    async enable() {
      enabled = true;
      positions?.start?.();
      unsubscribePositions = positions?.subscribe?.(refreshAntenna) || null;
      unsubscribeReceiver =
        localAdsb.receiver?.subscribe?.(refreshAntenna) || null;
      installClickHandler();
      refreshAntenna();
      renderer?.setVisible(true);
      redraw();
      return true;
    },

    async disable() {
      enabled = false;
      disarm();
      pointerBlocked = false;
      removeClickHandler();
      positions?.stop?.();
      unsubscribePositions?.();
      unsubscribePositions = null;
      unsubscribeReceiver?.();
      unsubscribeReceiver = null;
      clearTimeout(redrawTimer);
      redrawTimer = null;
      renderer?.setVisible(false);
      governorRequestRender('reception-horizon');
      return true;
    },

    async update() {
      return true;
    },

    destroy() {
      enabled = false;
      disarm();
      removeClickHandler();
      clearTimeout(redrawTimer);
      redrawTimer = null;
      unsubscribeFixes?.();
      unsubscribeFixes = null;
      unsubscribePositions?.();
      unsubscribePositions = null;
      unsubscribeReceiver?.();
      unsubscribeReceiver = null;
      positions?.destroy?.();
      renderer?.destroy();
      renderer = null;
      viewer = null;
      rowListener = null;
    },

    getStats() {
      const snapshot = model.snapshot();
      const far = snapshot.farthest;
      const waiting = !antenna || !snapshot.counted;
      return {
        count: snapshot.counted,
        ...(far ? { countLabel: formatKm(far.rangeKm) } : {}),
        lastUpdate: snapshot.lastFixAt,
        // English data: the Layers panel translates source and statusMessage.
        source: LAYER_SOURCE,
        ...(waiting
          ? {
              status: 'idle',
              statusMessage: antenna
                ? msg('Waiting for aircraft heard by Local ADS-B')
                : msg('Needs your antenna position'),
            }
          : {}),
      };
    },

    getRowControls() {
      const snapshot = model.snapshot();
      const chips = [
        {
          id: 'antenna-set',
          label: armed ? t('CLICK MAP') : t('SET ANTENNA'),
          active: armed,
          state: armed ? 'active' : 'idle',
          title: armed
            ? t(
                'Click your antenna on the globe (click again or Esc to cancel)',
              )
            : t('Then click the globe where your antenna is'),
          onClick: arm,
        },
      ];
      if (manual)
        chips.push({
          id: 'antenna-auto',
          label: t('AUTO'),
          state: 'idle',
          title: t(
            "Use the decoder's receiver.json or the Radio card LOCATE again",
          ),
          onClick: useAutomaticAntenna,
        });
      const stretched = verticalScale !== 1;
      chips.push({
        id: 'height',
        label: t('HEIGHT ×{scale}', { scale: HORIZON_HEIGHT_EXAGGERATION }),
        active: stretched,
        state: stretched ? 'active' : 'idle',
        title: stretched
          ? t('Draw heights at true scale again')
          : t(
              "Stretch heights ×{scale} so the shell's steps read in 3D (ranges are unchanged)",
              { scale: HORIZON_HEIGHT_EXAGGERATION },
            ),
        onClick: toggleHeightScale,
      });
      chips.push({
        id: 'reset',
        label: t('RESET'),
        state: 'idle',
        disabled: snapshot.buffered === 0,
        title: t('Forget every position heard so far'),
        onClick: reset,
      });
      return {
        chips,
        legend: snapshot.bands.map((band) => ({
          label: band.maxRangeKm
            ? `${band.shortLabel} ${formatKm(band.maxRangeKm)}`
            : band.shortLabel,
          color: band.color,
          blurb: band.directions
            ? t('{band}: heard in {percent}% of directions, out to {range}.', {
                band: t(band.label),
                percent: formatNumber(Math.round(band.coverage * 100)),
                range: formatRange(band.maxRangeKm),
              })
            : t('{band}: nothing heard yet.', { band: t(band.label) }),
        })),
        info: receptionHorizonInfo(snapshot, antenna, {
          armed,
          pointerBlocked,
          verticalScale,
        }),
      };
    },

    setRowControlsListener(listener) {
      rowListener = typeof listener === 'function' ? listener : null;
    },

    /** Arm the next globe click to place the antenna (the SET ANTENNA chip). */
    armAntennaPlacement: arm,
    /** Place the antenna at a position directly, as a click would. */
    setAntennaPosition(position) {
      const point = validAntennaPosition(position);
      if (!enabled || !point) return false;
      disarm();
      placeAntenna(point);
      return true;
    },
    useAutomaticAntenna,
    resetHorizon: reset,
    /** Toggle the display-only height stretch; returns the new scale. */
    toggleHeightScale,
    /** Current horizon and antenna, for QA and readouts. */
    getHorizon() {
      return { antenna, armed, verticalScale, horizon: model.snapshot() };
    },
  };
}
