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
import {
  CYCLONE_OVERLAY_SOURCE_ID,
  cycloneStormIdFromEntryId,
} from './labels.js';
import {
  formatUtcDayMonth,
  t,
  tn,
  msg,
  translateKnown,
} from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';

// "10-12 15:00 UTC" never breaks across lines: no-break spaces, and a word
// joiner after the hyphen (JetBrains Mono has no U+2011 non-breaking hyphen).
const utc = (value) =>
  value
    ? `${formatUtcDayMonth(value).replace('-', '-\u2060')}\u00a0${value.slice(11, 16)}\u00a0UTC`
    : t('Unavailable');
const COVERAGE = msg(
  'Atlantic and eastern/central North Pacific; not worldwide cyclone coverage.',
);
// The server sends the same English coverage (server/providers/cyclones.js);
// data stays English and is translated here, where it is shown.
const coverageText = (coverage) =>
  !coverage || coverage === COVERAGE ? t(COVERAGE) : translateKnown(coverage);
const ADVISORIES_UNAVAILABLE = msg('Cyclone advisories unavailable');
// Reason the server gives with an unavailable snapshot, translated when shown.
const SERVER_REASONS = new Set([msg('Cyclone data unavailable')]);
const errorText = (error) =>
  error && (SERVER_REASONS.has(error) ? t(error) : translateKnown(error));
const CLASSIFICATION_NAMES = Object.freeze({
  PTC: msg('Potential tropical cyclone'),
  HU: msg('Hurricane'),
  TS: msg('Tropical storm'),
  TD: msg('Tropical depression'),
  SS: msg('Subtropical storm'),
  SD: msg('Subtropical depression'),
});
const classificationName = (code) =>
  Object.hasOwn(CLASSIFICATION_NAMES, code)
    ? t(CLASSIFICATION_NAMES[code])
    : code;
const number = (value, unit) =>
  value === null ? t('Unavailable') : formatQuantity(value, unit);

/** Advisory status and coherent forecast geometry; selected through the shared row list. */
export function createCyclonesLayer({
  feed,
  hitTestOverlay = hitTestWorldOverlay,
  overlayHost,
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
    selectionIntent = 'auto',
    navigationGeneration = 0,
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
  function select(id) {
    if (selectedId !== id) ++navigationGeneration;
    selectedId = id;
    rendering?.setSelection(id);
  }
  // Photorealistic 3D Tiles pick as tileset content without an entity id;
  // that is empty map, the same as no pick at all on the globe.
  const isSurfacePick = (picked) =>
    !picked ||
    (picked.id === undefined &&
      (picked.content !== undefined ||
        (typeof cesium.Cesium3DTileset === 'function' &&
          picked.primitive instanceof cesium.Cesium3DTileset)));
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
    const overlayHit = (x, y) => {
      const hit = hitTestOverlay(x, y);
      return { sourceId: hit?.sourceId, entryId: hit?.entryId };
    };
    const capture = (event) => {
      capturedHit = null;
      const point = event.changedTouches?.[0] || event;
      if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY))
        return;
      const rect = canvas.getBoundingClientRect();
      const x = point.clientX - rect.left,
        y = point.clientY - rect.top;
      capturedHit = { x, y, ...overlayHit(x, y) };
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
      const hit = captureMatches
        ? nativeHit
        : overlayHit(click.position.x, click.position.y);
      if (hit.sourceId === VESSEL_OVERLAY_SOURCE_ID) return;
      // Storm cards and lead-hour labels paint on the same canvas; a click on
      // one selects its storm. An id from a superseded advisory changes nothing.
      if (hit.sourceId === CYCLONE_OVERLAY_SOURCE_ID) {
        const id = cycloneStormIdFromEntryId(hit.entryId);
        if (id) layer.setParams({ stormId: id });
        return;
      }
      const picked = viewer.scene.pick(click.position);
      const id = rendering?.pickStorm(picked);
      if (id) layer.setParams({ stormId: id });
      else if (isSurfacePick(picked)) layer.setParams({ clear: true });
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
      rendering = createRendering({ viewer, cesium, overlayHost });
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
      selectionIntent = 'auto';
      ++navigationGeneration;
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
          ++navigationGeneration;
          error = next.reason || ADVISORIES_UNAVAILABLE;
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
          select(
            selectionIntent === 'cleared'
              ? null
              : snapshot.storms[0]?.id || null,
          );
        else rendering.setSelection(selectedId);
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || ADVISORIES_UNAVAILABLE;
        // Failed acquisition has no bounded last-good age guarantee at this layer.
        rendering?.clear();
        snapshot = null;
        selectedId = null;
        ++navigationGeneration;
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
      if (!enabled || destroyed) return;
      if (params.clear === true || params.stormId === null) {
        selectionIntent = 'cleared';
        select(null);
        notify();
      } else if (
        typeof params.stormId === 'string' &&
        snapshot?.storms.some((storm) => storm.id === params.stormId)
      ) {
        selectionIntent = 'user';
        select(params.stormId);
        notify();
      }
      const storm = selected();
      if (params.focus === true && storm && runNavigation) {
        const sphere = rendering.getFocusSphere(storm.id);
        if (sphere) {
          const generation = ++navigationGeneration;
          runNavigation(() => {
            if (
              !enabled ||
              destroyed ||
              generation !== navigationGeneration ||
              selectedId !== storm.id
            )
              return;
            return viewer.camera.flyToBoundingSphere(sphere, {
              duration: matchMedia?.('(prefers-reduced-motion: reduce)')
                ?.matches
                ? 0
                : 1.4,
            });
          });
        }
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
          ? t('Track and cone match this advisory')
          : storm.geometryStatus === 'pending'
            ? t('Track/cone awaiting advisory {number}', {
                number: storm.advisoryNumber,
              })
            : t('Track/cone unavailable'));
      const status =
        errorText(error) ||
        (snapshot?.stale
          ? t('Cached advisory · stale source')
          : loading
            ? t('Loading advisories…')
            : storm && !coherentCycloneGeometry(storm)
              ? geometry
              : null);
      const stormCount = snapshot?.storms.length || 0;
      const activeStorms = tn(
        stormCount,
        '{count} active storm',
        '{count} active storms',
      );
      const position = storm
        ? t('Position as of {time}', { time: utc(storm.positionAt) })
        : '';
      const intensity = storm
        ? t('Maximum sustained wind: {wind} · Pressure: {pressure}', {
            wind: number(storm.windKt, 'kt'),
            pressure: number(storm.pressureHpa, 'hPa'),
          })
        : '';
      const detail = storm
        ? t('{name} · {classification} · Advisory {number} · issued {time}', {
            name: storm.name,
            classification: classificationName(storm.classification),
            number: storm.advisoryNumber,
            time: utc(storm.issuedAt),
          })
        : empty
          ? t('No active NHC/CPHC systems')
          : stormCount
            ? activeStorms
            : loading
              ? t('Loading advisories…')
              : t('Advisories unavailable');
      const controls = {
        readout: true,
        summary: {
          label: t('Cyclones · NHC / CPHC'),
          coverage: t('Atlantic · E/C Pacific'),
          compact: stormCount
            ? storm
              ? t('{storms} · {name} selected', {
                  storms: activeStorms,
                  name: storm.name,
                })
              : activeStorms
            : detail,
          actions: storm?.advisoryUrl
            ? [
                {
                  id: 'advisory',
                  label: t('Official advisory ↗'),
                  href: storm.advisoryUrl,
                },
              ]
            : [],
          settings: [],
          lines: storm
            ? [
                {
                  id: 'position',
                  text: position,
                  muted: true,
                },
                {
                  id: 'intensity',
                  text: intensity,
                },
                { id: 'geometry', text: geometry, muted: true },
              ]
            : [],
          detail,
          status,
          units: 'kt',
        },
        list: {
          ariaLabel: t('Active NHC and CPHC cyclone advisories'),
          items: (snapshot?.storms || []).map((item, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: item.basin,
            text: `${item.name} · ${classificationName(item.classification)} · ${item.windKt === null ? t('Wind unavailable') : formatQuantity(item.windKt, 'kt')}`,
            active: item.id === selectedId,
            params: { stormId: item.id, focus: true },
          })),
        },
        chips: [],
        legendCategorical: true,
        legend: storm
          ? [
              {
                label: t('Advisory center / forecast track'),
                color: '#7fe6ed',
              },
              {
                label: t('Center-track uncertainty cone'),
                color: '#7fe6ed44',
              },
            ]
          : [],
        info: storm
          ? `${detail}\n${position}\n${intensity}\n${geometry}${status && status !== geometry ? '\n' + status : ''}\n${coverageText(snapshot.coverage)}`
          : `${detail}${status ? '\n' + status : ''}\n${coverageText(snapshot?.coverage)}`,
        infoTitle: t(
          'Select a storm on the map, or choose a storm in the list to select it and move the camera. Click empty map space to clear the selection. NOAA NHC/CPHC advisory context. The cone describes forecast center-track uncertainty, not storm size or the full hazard area. Forecast point labels are source lead hours, not times computed from advisory issuance. Geometry follows the surface; height is not weather altitude. Consult the official advisory.',
        ),
      };
      return controls;
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    /**
     * Snapshot loaded active storms as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, name, classification, basin, lat, lon, windKt, pressureHpa}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!enabled || destroyed) return [];
      const num = (v) => (Number.isFinite(v) ? v : null);
      const result = [];
      for (const storm of snapshot?.storms || []) {
        if (result.length >= maxCount) break;
        const lat = storm.position?.latitude;
        const lon = storm.position?.longitude;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        result.push({
          id: storm.name || storm.id,
          name: storm.name || null,
          classification: storm.classification || null,
          basin: storm.basin || null,
          lat,
          lon,
          windKt: num(storm.windKt),
          pressureHpa: num(storm.pressureHpa),
        });
      }
      return result;
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
        selectionIntent,
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
