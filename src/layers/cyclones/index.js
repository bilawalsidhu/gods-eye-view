import * as Cesium from 'cesium';
import { hitTestWorldOverlay } from '../../overlays/worldOverlay.js';
import { VESSEL_OVERLAY_SOURCE_ID } from '../../data/vesselLabels.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import {
  createCycloneRendering,
  coherentCycloneGeometry,
} from './rendering.js';

const utc = (value) =>
  value ? `${value.slice(5, 16).replace('T', ' ')} UTC` : 'Unavailable';
const COVERAGE =
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.';
const CLASSIFICATION_NAMES = Object.freeze({
  PTC: 'Potential tropical cyclone',
  HU: 'Hurricane',
  TS: 'Tropical storm',
  TD: 'Tropical depression',
  SS: 'Subtropical storm',
  SD: 'Subtropical depression',
});
const classificationName = (code) =>
  Object.hasOwn(CLASSIFICATION_NAMES, code) ? CLASSIFICATION_NAMES[code] : code;
const number = (value, unit) =>
  value === null ? 'Unavailable' : `${value} ${unit}`;

/** Advisory status and coherent forecast geometry; selected through the shared row list. */
export function createCyclonesLayer({
  feed,
  hitTestOverlay = hitTestWorldOverlay,
  cesium = Cesium,
  createRendering = createCycloneRendering,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openLink = (url) => globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Cyclones require a snapshot source');
  let viewer = null,
    rendering = null,
    snapshot = null,
    request = null,
    listener = null,
    selectedId = null,
    clickHandler = null,
    removeClickCapture = null;
  let enabled = false,
    loading = false,
    error = null,
    destroyed = false,
    runNavigation = null;
  const notify = () => listener?.();
  const selected = () =>
    snapshot?.storms.find((storm) => storm.id === selectedId) || null;
  function installSelection() {
    if (
      clickHandler ||
      !viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler = owner;
    // Snapshot before sibling bubble listeners can rebuild the overlay hit
    // rectangles. A vessel selection does that synchronously in the same click.
    const canvas = viewer.scene.canvas;
    let capturedHit = null;
    const capture = (event) => {
      capturedHit = null;
      const point = event.changedTouches?.[0] || event;
      if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY))
        return;
      const rect = canvas.getBoundingClientRect();
      const x = point.clientX - rect.left,
        y = point.clientY - rect.top;
      capturedHit = { x, y, sourceId: hitTestOverlay(x, y)?.sourceId };
    };
    const resetCapture = () => {
      capturedHit = null;
    };
    const resetEvents = [
      'pointerdown',
      'mousedown',
      'touchstart',
      'pointercancel',
      'touchcancel',
    ];
    for (const type of resetEvents)
      canvas.addEventListener?.(type, resetCapture, { capture: true });
    const events = ['pointerup', 'mouseup', 'touchend'];
    for (const type of events)
      canvas.addEventListener?.(type, capture, { capture: true });
    removeClickCapture = () => {
      for (const type of events)
        canvas.removeEventListener?.(type, capture, { capture: true });
      for (const type of resetEvents)
        canvas.removeEventListener?.(type, resetCapture, { capture: true });
      capturedHit = null;
    };
    owner.setInputAction((click) => {
      const nativeHit = capturedHit;
      capturedHit = null;
      // Ambient selection yields to draw tools and Director; it never claims
      // the pointer, camera, or tracking state.
      if (
        !enabled ||
        destroyed ||
        clickHandler !== owner ||
        !isPointerFree() ||
        !click?.position
      )
        return;
      // AIS cards paint above the globe on a pointer-events:none canvas. The
      // vessel handler resolves this same topmost hit before cyclone geometry.
      const captureMatches =
        nativeHit &&
        Math.abs(nativeHit.x - click.position.x) < 1 &&
        Math.abs(nativeHit.y - click.position.y) < 1;
      const sourceId = captureMatches
        ? nativeHit.sourceId
        : hitTestOverlay(click.position.x, click.position.y)?.sourceId;
      if (sourceId === VESSEL_OVERLAY_SOURCE_ID) return;
      const id = rendering?.pickStorm(viewer.scene.pick(click.position));
      if (id && id !== selectedId) layer.setParams({ stormId: id });
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function removeSelection() {
    const owner = clickHandler;
    clickHandler = null;
    removeClickCapture?.();
    removeClickCapture = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }
  const layer = {
    id: 'weather-cyclones',
    name: 'Cyclone advisories',
    icon: '◉',
    source: 'NOAA NHC / CPHC',
    updateInterval: 300_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium });
    },
    attachShellServices(services) {
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      notify();
    },
    enable() {
      if (!destroyed && !enabled) {
        enabled = true;
        registerPickOwner(
          'weather-cyclones',
          (id) => enabled && rendering?.ownsPickId?.(id) === true,
        );
        installSelection();
      }
    },
    disable() {
      enabled = false;
      unregisterPickOwner('weather-cyclones');
      removeSelection();
      request?.abort();
      request = null;
      loading = false;
      error = null;
      snapshot = null;
      selectedId = null;
      rendering?.clear();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await feed.getSnapshot({ signal: controller.signal });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (next.unavailable) {
          // An expired advisory must not remain presented as current hazard context.
          rendering.clear();
          snapshot = next;
          selectedId = null;
          error = next.reason || 'Cyclone advisories unavailable';
          return true;
        }
        const applied = await rendering.setSnapshot(next, {
          signal: controller.signal,
        });
        if (
          !applied ||
          !enabled ||
          controller.signal.aborted ||
          request !== controller
        )
          return false;
        snapshot = next;
        error = null;
        if (!snapshot.storms.some((storm) => storm.id === selectedId))
          selectedId = snapshot.storms[0]?.id || null;
        rendering.setSelection(selectedId);
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'Cyclone advisories unavailable';
        // Failed acquisition has no bounded last-good age guarantee at this layer.
        rendering?.clear();
        snapshot = null;
        selectedId = null;
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (!enabled) return;
      if (
        typeof params.stormId === 'string' &&
        snapshot?.storms.some((storm) => storm.id === params.stormId)
      ) {
        selectedId = params.stormId;
        rendering.setSelection(selectedId);
        notify();
      }
      const storm = selected();
      if (params.focus === true && storm && runNavigation) {
        const sphere = rendering.getFocusSphere(storm.id);
        if (sphere)
          runNavigation(() =>
            viewer.camera.flyToBoundingSphere(sphere, {
              duration: matchMedia?.('(prefers-reduced-motion: reduce)')
                ?.matches
                ? 0
                : 1.4,
            }),
          );
      }
      if (params.advisory === true && storm?.advisoryUrl)
        openLink(storm.advisoryUrl);
    },
    getRowControls() {
      const storm = selected();
      const empty =
        snapshot && !snapshot.unavailable && snapshot.storms.length === 0;
      const geometry =
        storm &&
        (coherentCycloneGeometry(storm)
          ? 'Track and cone match this advisory'
          : storm.geometryStatus === 'pending'
            ? `Track/cone awaiting advisory ${storm.advisoryNumber}`
            : 'Track/cone unavailable');
      const status =
        error ||
        (snapshot?.stale
          ? 'Cached advisory · stale source'
          : loading
            ? 'Loading advisories…'
            : storm && !coherentCycloneGeometry(storm)
              ? geometry
              : null);
      const detail = storm
        ? `${storm.name} · ${classificationName(storm.classification)} · Advisory ${storm.advisoryNumber} · ${utc(storm.issuedAt)}`
        : empty
          ? 'No active NHC/CPHC systems'
          : 'Advisories unavailable';
      return {
        summary: {
          label: 'Cyclones · NHC / CPHC',
          detail,
          status,
          units: 'kt',
        },
        list: {
          ariaLabel: 'Active NHC and CPHC cyclone advisories',
          items: (snapshot?.storms || []).map((item, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: item.basin,
            text: `${item.name} · ${classificationName(item.classification)} · ${item.windKt === null ? 'Wind unavailable' : `${item.windKt} kt`}`,
            active: item.id === selectedId,
            params: { stormId: item.id },
          })),
        },
        chips: [
          {
            id: 'focus',
            label: 'View storm',
            disabled: !storm || !runNavigation,
            params: { focus: true },
          },
          {
            id: 'advisory',
            label: 'Official advisory ↗',
            disabled: !storm?.advisoryUrl,
            params: { advisory: true },
            title: 'Open the official NHC advisory in a new tab',
          },
        ],
        legend: storm
          ? [
              { label: 'Advisory center / forecast track', color: '#7fe6ed' },
              { label: 'Center-track uncertainty cone', color: '#7fe6ed44' },
            ]
          : [],
        info: storm
          ? `${detail}\nPosition as of ${utc(storm.positionAt)}\nMaximum sustained wind: ${number(storm.windKt, 'kt')} · Pressure: ${number(storm.pressureHpa, 'hPa')}\n${geometry}${status && status !== geometry ? '\n' + status : ''}\n${snapshot.coverage}`
          : `${detail}${status ? '\n' + status : ''}\n${snapshot?.coverage || COVERAGE}`,
        infoTitle:
          'Select a storm on the map or in the list, then choose View storm to move the camera. NOAA NHC/CPHC advisory context. The cone describes forecast center-track uncertainty, not storm size or the full hazard area. Forecast point labels are source lead hours, not times computed from advisory issuance. Geometry is displayed 2–3 km above the ellipsoid for visibility; height is not weather altitude. Consult the official advisory.',
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      const storm = selected();
      return {
        count: snapshot?.storms.length || 0,
        lastUpdate: storm
          ? Date.parse(storm.issuedAt)
          : snapshot?.fetchedAt || null,
        loading,
        error,
        stale: Boolean(snapshot?.stale),
        source: 'NOAA NHC / CPHC',
        advisoryAt: storm?.issuedAt || null,
        empty: Boolean(
          snapshot && !snapshot.unavailable && !snapshot.storms.length,
        ),
      };
    },
    getDiagnostics() {
      return {
        ...rendering?.getDiagnostics(),
        enabled,
        loading,
        requestPending: !!request,
        selectionActive: clickHandler !== null,
        selectedId,
        timerActive: false,
      };
    },
    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
      runNavigation = null;
    },
  };
  return layer;
}
