import { inputFor } from '../../input/dispatcher.js';
import {
  clickCard,
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
  isolate,
  t,
  tn,
  msg,
  translateKnown,
} from '../../i18n/index.js';
import { formatQuantity } from '../../ui/unitLabels.js';
import { cameraOf, canvasOf } from '../../render/rendererOf.js';

// "10-12 15:00 UTC" never breaks across lines: no-break spaces, and a word
// joiner after the hyphen (JetBrains Mono has no U+2011 non-breaking hyphen).
// The clock is isolated (a no-op outside RTL): a no-break space between two
// numbers joins them into one run, which in Arabic split the date around it.
const utc = (value) =>
  value
    ? `${formatUtcDayMonth(value).replace('-', '-\u2060')}\u00a0${isolate(value.slice(11, 16))}\u00a0UTC`
    : t('Unavailable');
const COVERAGE = msg(
  'NHC/CPHC: Atlantic and eastern/central North Pacific. JTWC: western North Pacific, North Indian Ocean and Southern Hemisphere.',
);
// The layer's sources, and each storm's.
const SOURCE = 'NOAA NHC / CPHC · JTWC';
const AGENCY_SOURCES = Object.freeze({ nhc: 'NOAA NHC / CPHC', jtwc: 'JTWC' });
const sourceOf = (storm) => AGENCY_SOURCES[storm?.agency] || AGENCY_SOURCES.nhc;
const isJtwc = (storm) => storm?.agency === 'jtwc';
const DANGER_AREA = msg('34-knot wind danger area');
// The server sends the same English coverage (server/providers/cyclones.js);
// data stays English and is translated here, where it is shown.
const coverageText = (coverage) =>
  !coverage || coverage === COVERAGE ? t(COVERAGE) : translateKnown(coverage);
const ADVISORIES_UNAVAILABLE = msg('Cyclone advisories unavailable');
// Reason the server gives with an unavailable snapshot, translated when shown.
const SERVER_REASONS = new Set([msg('Cyclone data unavailable')]);
const errorText = (error) =>
  error && (SERVER_REASONS.has(error) ? t(error) : translateKnown(error));
// NHC's Tropical Cyclone Status JSON reference: PTC is post-tropical, PC is a
// potential tropical cyclone, and subtropical systems are STS and STD. JTWC
// warns of typhoons (TY), super typhoons (STY), tropical cyclones (TC) and
// subtropical storms and depressions (SS, SD).
const CLASSIFICATION_NAMES = Object.freeze({
  PC: msg('Potential tropical cyclone'),
  PTC: msg('Post-tropical cyclone'),
  HU: msg('Hurricane'),
  TS: msg('Tropical storm'),
  TD: msg('Tropical depression'),
  STS: msg('Subtropical storm'),
  STD: msg('Subtropical depression'),
  TY: msg('Typhoon'),
  STY: msg('Super typhoon'),
  TC: msg('Tropical cyclone'),
  SS: msg('Subtropical storm'),
  SD: msg('Subtropical depression'),
});
const classificationName = (code) =>
  Object.hasOwn(CLASSIFICATION_NAMES, code)
    ? t(CLASSIFICATION_NAMES[code])
    : code;
// A value the advisory leaves out (null) is left out of the line too.
const intensityText = (storm) => {
  const has = (value) => value !== null && value !== undefined;
  const wind = has(storm.windKt) ? formatQuantity(storm.windKt, 'kt') : null;
  const pressure = has(storm.pressureHpa)
    ? formatQuantity(storm.pressureHpa, 'hPa')
    : null;
  if (wind && pressure)
    return t('Maximum sustained wind: {wind} · Pressure: {pressure}', {
      wind,
      pressure,
    });
  if (wind) return t('Maximum sustained wind: {wind}', { wind });
  if (pressure) return t('Pressure: {pressure}', { pressure });
  return '';
};

/** Advisory status and coherent forecast geometry; selected through the shared row list. */
export function createCyclonesLayer({
  feed,
  overlayHost,
  context = null,
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
    selectionOwner = null,
    selectedContextStormId = null;
  let enabled = false,
    loading = false,
    error = null,
    destroyed = false,
    runNavigation = null;
  const notify = () => listener?.();
  const selected = () =>
    snapshot?.storms.find((storm) => storm.id === selectedId) || null;
  function clearSelectedContext({ evicted = false } = {}) {
    if (selectedContextStormId) {
      if (!evicted)
        context.clearSelectedEntityContextForLayer('weather-cyclones');
      context.removeEntityContextsForLayer('weather-cyclones');
    }
    selectedContextStormId = null;
  }

  // Callers publish only while selectedId names a storm in the snapshot.
  function publishSelectedContext({ announce = false } = {}) {
    const storm = selected();
    if (!context) return;
    const entity = {};
    const contextId = `cyclone:${storm.id}`;
    context.registerEntityContext(entity, {
      id: contextId,
      layerId: 'weather-cyclones',
      layerName: 'Cyclone advisories',
      source: sourceOf(storm),
      label: storm.name,
      latitude: storm.position.latitude,
      longitude: storm.position.longitude,
      // At most 12 properties reach the voice summary; keep the list short.
      properties: {
        classification: storm.classification,
        classificationName: Object.hasOwn(
          CLASSIFICATION_NAMES,
          storm.classification,
        )
          ? CLASSIFICATION_NAMES[storm.classification]
          : undefined,
        basin: storm.basin,
        agency: storm.agency,
        advisoryNumber: storm.advisoryNumber,
        issuedAt: storm.issuedAt,
        positionAt: storm.positionAt,
        windKt: storm.windKt,
        pressureHpa: storm.pressureHpa,
        // Flat scalars: the voice context summary drops nested objects.
        movementDirectionDegrees: storm.movement?.directionDegrees,
        movementSpeedKt: storm.movement?.speedKt,
        advisoryUrl: storm.advisoryUrl,
        // Only while the proxy serves its cache because a source is unreachable.
        staleCacheFetchedAt:
          snapshot.stale && Number.isFinite(snapshot.fetchedAt)
            ? new Date(snapshot.fetchedAt).toISOString()
            : undefined,
      },
    });
    selectedContextStormId = storm.id;
    if (announce) context.selectEntityContext(entity);
    context.removeEntityContextsForLayer('weather-cyclones', {
      retainIds: new Set([contextId]),
    });
  }

  function select(id) {
    if (selectedId !== id) ++navigationGeneration;
    selectedId = id;
    rendering?.setSelection(id);
  }
  function installSelection() {
    if (selectionOwner || !canvasOf(viewer)) return;
    const owner = {};
    selectionOwner = owner;
    const unsubscribe = inputFor(viewer).onClick((event) => {
      // Ambient selection yields to draw tools and Director (the dispatcher
      // skips a held pointer); it never claims the pointer, camera, or
      // tracking state.
      const position = event.screenPosition;
      if (!enabled || destroyed || selectionOwner !== owner || !position)
        return;
      // The card or label painted on top, as it was when the click landed.
      const card = clickCard(event);
      // Storm cards and lead-hour labels paint on the same canvas; a click on
      // one selects its storm. An id from a superseded advisory changes nothing.
      if (card?.sourceId === CYCLONE_OVERLAY_SOURCE_ID) {
        const id = cycloneStormIdFromEntryId(card.entryId);
        if (id) layer.setParams({ stormId: id });
        return;
      }
      // Another layer's card on top takes the click: the storm under it does
      // not act, and the click is not empty map either.
      if (card) return;
      // A storm's own drawing names it; empty map (the globe, or 3D tiles)
      // clears the selection.
      const id = rendering?.pickStorm(event.drawHit);
      if (id) layer.setParams({ stormId: id });
      else if (!event.topHit) layer.setParams({ clear: true });
    });
    owner.unsubscribe = unsubscribe;
  }
  function removeSelection() {
    const owner = selectionOwner;
    selectionOwner = null;
    owner?.unsubscribe?.();
  }
  const layer = {
    id: 'weather-cyclones',
    name: 'Cyclone advisories',
    icon: '◉',
    source: SOURCE,
    updateInterval: 300_000,
    init(nextViewer, { panel = null } = {}) {
      // The panels' handle: invalidated when the row or readout changed.
      listener = panel ? () => panel.invalidate() : null;
      viewer = nextViewer;
      rendering = createRendering({ viewer, overlayHost });
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
      clearSelectedContext();
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
          clearSelectedContext({ evicted: true });
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
        if (selectedContextStormId) {
          if (selectedId === selectedContextStormId) publishSelectedContext();
          else clearSelectedContext({ evicted: true });
        }
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || ADVISORIES_UNAVAILABLE;
        // Failed acquisition has no bounded last-good age guarantee at this layer.
        rendering?.clear();
        snapshot = null;
        selectedId = null;
        ++navigationGeneration;
        clearSelectedContext({ evicted: true });
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
        clearSelectedContext();
        notify();
      } else if (
        typeof params.stormId === 'string' &&
        snapshot?.storms.some((storm) => storm.id === params.stormId)
      ) {
        selectionIntent = 'user';
        select(params.stormId);
        publishSelectedContext({ announce: true });
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
            cameraOf(viewer).flyToBounds(
              { center: sphere.center, radius: sphere.radius },
              {
                durationS: matchMedia?.('(prefers-reduced-motion: reduce)')
                  ?.matches
                  ? 0
                  : 1.4,
              },
            );
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
        (isJtwc(storm)
          ? coherentCycloneGeometry(storm)
            ? t('Track and 34-knot wind danger area match this warning')
            : storm.geometryStatus === 'pending'
              ? t('Track/danger area awaiting warning {number}', {
                  number: storm.advisoryNumber,
                })
              : t('Track/danger area unavailable')
          : coherentCycloneGeometry(storm)
            ? t('Track and cone match this advisory')
            : storm.geometryStatus === 'pending'
              ? t('Track/cone awaiting advisory {number}', {
                  number: storm.advisoryNumber,
                })
              : t('Track/cone unavailable'));
      // JTWC is not the regional warning centre for any basin.
      const note =
        storm && isJtwc(storm)
          ? t(
              'JTWC warning: the regional centre’s warning is official. JTWC winds are 1-minute averages.',
            )
          : '';
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
      const intensity = storm ? intensityText(storm) : '';
      const detail = storm
        ? isJtwc(storm)
          ? t('{name} · {classification} · Warning {number} · issued {time}', {
              name: storm.name,
              classification: classificationName(storm.classification),
              number: storm.advisoryNumber,
              time: utc(storm.issuedAt),
            })
          : t('{name} · {classification} · Advisory {number} · issued {time}', {
              name: storm.name,
              classification: classificationName(storm.classification),
              number: storm.advisoryNumber,
              time: utc(storm.issuedAt),
            })
        : empty
          ? t('No active tropical cyclone warnings')
          : stormCount
            ? activeStorms
            : loading
              ? t('Loading advisories…')
              : t('Advisories unavailable');
      const controls = {
        readout: true,
        summary: {
          label: t('Cyclones · NHC / CPHC · JTWC'),
          coverage: t('All tropical basins'),
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
                  label: isJtwc(storm)
                    ? t('JTWC warning ↗')
                    : t('Official advisory ↗'),
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
                { id: 'note', text: note, muted: true },
              ].filter((line) => line.text)
            : [],
          detail,
          status,
          units: 'kt',
        },
        list: {
          ariaLabel: t('Active cyclone advisories and warnings'),
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
              isJtwc(storm)
                ? { label: t(DANGER_AREA), color: '#ffb15c44' }
                : {
                    label: t('Center-track uncertainty cone'),
                    color: '#7fe6ed44',
                  },
            ]
          : [],
        info: storm
          ? `${detail}\n${position}\n${intensity ? intensity + '\n' : ''}${geometry}${status && status !== geometry ? '\n' + status : ''}${note ? '\n' + note : ''}\n${coverageText(snapshot.coverage)}`
          : `${detail}${status ? '\n' + status : ''}\n${coverageText(snapshot?.coverage)}`,
        infoTitle: t(
          'Select a storm on the map, or choose a storm in the list to select it and move the camera. Click empty map space to clear the selection. NOAA NHC/CPHC advisories and JTWC warnings. The NHC cone describes forecast center-track uncertainty, not storm size or the full hazard area. The JTWC 34-knot wind danger area is where 34-knot winds may reach, widened by forecast track error; it is not a cone. Forecast point labels are source lead hours, not times computed from advisory issuance. Geometry follows the surface; height is not weather altitude. Consult the official advisory or the regional warning centre.',
        ),
      };
      return controls;
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
        source: storm ? sourceOf(storm) : SOURCE,
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
        selectionActive: selectionOwner !== null,
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
