import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
import { worldClock } from '../../time/worldClock.js';
import { pointInPolygon } from '../../sources/featureGeometry.js';
import { msg, t, translateKnown } from '../../i18n/index.js';
import { FEET_TO_METERS, severityRank } from './records.js';
import { coverageOf, selectAt, selectionKey } from './time.js';
import {
  DEFAULT_TURBULENCE_FILTERS,
  TURBULENCE_BANDS,
  TURBULENCE_FILTER_GROUPS,
  TURBULENCE_LAYER_ID,
  applyTurbulenceFilters,
  passesTurbulenceFilters,
} from './model.js';
import { createTurbulenceRendering, volumeHeights } from './rendering.js';
import {
  TURBULENCE_OVERLAY_SOURCE_ID,
  altitudeLabel,
  buildTurbulenceCard,
  severityLabel,
  utcTime,
} from './cards.js';
export { createTurbulenceSource } from './source.js';
export * from './cards.js';
export * from './model.js';

const ID = TURBULENCE_LAYER_ID;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
/** While live the clock does not call back, so the selection is rechecked. */
const LIVE_RECHECK_MS = 60_000;
const UNAVAILABLE = msg('Turbulence data unavailable');
// The proxy's reason for an unavailable snapshot, translated when shown.
const SERVER_REASONS = new Set([UNAVAILABLE]);
const errorText = (error) =>
  error && (SERVER_REASONS.has(error) ? t(error) : translateKnown(error));
const EMPTY = Object.freeze({
  forecasts: Object.freeze([]),
  warnings: Object.freeze([]),
  reports: Object.freeze([]),
});

/** Click ground point → degrees, through the dispatcher's click event. */
const defaultGroundLonLat = (event) => {
  const position = event.ground?.();
  return position ? toLonLatH(position) : null;
};

/** A ring as pointInPolygon's {lon, lat} points, unwrapped across ±180°. */
function ringPoints(ring) {
  let min = Infinity;
  let max = -Infinity;
  for (const [lon] of ring) {
    if (lon < min) min = lon;
    if (lon > max) max = lon;
  }
  const wraps = max - min > 180;
  return {
    wraps,
    points: ring.map(([lon, lat]) => ({
      lon: wraps && lon < 0 ? lon + 360 : lon,
      lat,
    })),
  };
}

/** Whether `lon, lat` falls inside a record's polygons (outer ring, not a hole). */
export function containsPoint(record, lon, lat) {
  for (const [outer, ...holes] of record.polygons ?? []) {
    const inside = (ring) => {
      const { wraps, points } = ringPoints(ring);
      const x = wraps && lon < 0 ? lon + 360 : lon;
      return pointInPolygon(x, lat, points);
    };
    if (inside(outer) && !holes.some(inside)) return true;
  }
  return false;
}

/** The record a viewer most needs at a spot: the most severe; warnings first. */
function mostRelevant(records) {
  let best = null;
  for (const record of records) {
    if (
      !best ||
      severityRank(record.severity) > severityRank(best.severity) ||
      (severityRank(record.severity) === severityRank(best.severity) &&
        record.kind === 'warning' &&
        best.kind !== 'warning')
    )
      best = record;
  }
  return best;
}

function centroid(record) {
  if (record.kind === 'report') return { lon: record.lon, lat: record.lat };
  const outer = record.polygons[0][0];
  let lon = 0;
  let lat = 0;
  const count = outer.length - 1;
  for (let i = 0; i < count; i++) {
    lon += outer[i][0];
    lat += outer[i][1];
  }
  return { lon: lon / count, lat: lat / count };
}

/**
 * NOAA AWC turbulence: G-AIRMET forecast areas (US) and SIGMET warnings
 * (worldwide) as translucent volumes between their floor and top, and pilot
 * reports as points at their flight level. Follows the world clock: the
 * forecast snapshot nearest the time shown, the warnings in force, and the
 * reports of the three hours before it.
 */
export function createTurbulenceLayer({
  feed,
  overlayHost = null,
  inputFor = defaultInputFor,
  picking = null,
  clock = worldClock,
  createRendering = createTurbulenceRendering,
  groundLonLat = defaultGroundLonLat,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Turbulence requires a snapshot source');
  let viewer = null;
  let rendering = null;
  let snapshot = null;
  let filtered = EMPTY;
  let current = null;
  let shownKey = null;
  let filters = DEFAULT_TURBULENCE_FILTERS;
  let enabled = false;
  let destroyed = false;
  let loading = false;
  let error = null;
  let request = null;
  let listener = null;
  let uncover = null;
  let unhold = null;
  let unsubscribeClock = null;
  let recheckTimer = null;
  let clickSubscription = null;
  let coverageKey = null;
  /** @type {{record: object, anchor: {lon: number, lat: number, height: number}}|null} */
  let selected = null;
  let selectedCardId = null;

  const notify = () => listener?.();
  const timeNow = () => clock.timeFor(ID)();

  const coverage = () =>
    enabled && snapshot && !snapshot.unavailable
      ? coverageOf(filtered, clock.wallNow?.() ?? Date.now())
      : null;
  /** Tell the clock only when the span moved by more than a few minutes. */
  function coverageChanged() {
    const span = coverage();
    const key = span
      ? `${Math.round(span.start / 300_000)}:${Math.round(span.end / 300_000)}`
      : null;
    if (key === coverageKey) return;
    coverageKey = key;
    clock.coverageChanged?.();
  }

  function publishCard() {
    if (!overlayHost) return;
    if (!selected) {
      selectedCardId = null;
      overlayHost.setEntries(
        TURBULENCE_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const { record, anchor } = selected;
    const card = {
      ...buildTurbulenceCard(record),
      position: fromDegrees(anchor.lon, anchor.lat, anchor.height),
    };
    selectedCardId = card.id;
    overlayHost.setEntries(
      TURBULENCE_OVERLAY_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function clearSelection() {
    if (!selected && !selectedCardId) return;
    selected = null;
    publishCard();
  }

  /** Draw what is shown at the clock's time, if it changed. */
  function applyTime({ force = false } = {}) {
    if (!enabled || !rendering) return;
    const time = timeNow();
    if (!force && selectionKey(filtered, time) === shownKey) return;
    current = selectAt(filtered, time);
    shownKey = current.key;
    rendering.showForecast(current.forecastValidAt);
    rendering.setWarnings(current.warnings);
    rendering.setReports(current.reports);
    if (selected) {
      const shown = [
        ...current.forecasts,
        ...current.warnings,
        ...current.reports,
      ];
      if (!shown.some((r) => r.id === selected.record.id)) clearSelection();
    }
    notify();
  }

  /** Filter the snapshot and rebuild what the filters changed. */
  function applySnapshot() {
    filtered =
      snapshot && !snapshot.unavailable
        ? {
            forecasts: snapshot.forecasts.filter((r) =>
              passesTurbulenceFilters(r, filters),
            ),
            warnings: snapshot.warnings.filter((r) =>
              passesTurbulenceFilters(r, filters),
            ),
            reports: snapshot.reports.filter((r) =>
              passesTurbulenceFilters(r, filters),
            ),
          }
        : EMPTY;
    rendering?.setForecasts(filtered.forecasts);
    applyTime({ force: true });
    coverageChanged();
  }

  function onClick(event) {
    const cardHit = overlayHost?.hitTest?.(
      event.screenPosition?.x,
      event.screenPosition?.y,
      { sourceId: TURBULENCE_OVERLAY_SOURCE_ID },
    );
    if (cardHit && cardHit.entryId === selectedCardId) return;
    const reportId = rendering?.pickReport(event.drawHit);
    const report = reportId && current?.reports.find((r) => r.id === reportId);
    if (report) {
      selected = {
        record: report,
        anchor: {
          lon: report.lon,
          lat: report.lat,
          height: report.baseFt * FEET_TO_METERS,
        },
      };
      publishCard();
      return;
    }
    // Something else is under the click: its own layer answers it.
    if (!event.surface && !rendering?.isVolumeHit(event.drawHit)) {
      const picked = event.topHit;
      const pickId = picked ? picking?.resolvePickId?.(picked) : null;
      if (pickId && picking.isOwnedByOtherLayer?.(ID, pickId)) return;
      clearSelection();
      return;
    }
    // The volumes take no part in picks; a click on the map selects the
    // volume over that spot.
    const ground = groundLonLat(event);
    const volume =
      ground && current
        ? mostRelevant(
            [...current.warnings, ...current.forecasts].filter((r) =>
              containsPoint(r, ground.lon, ground.lat),
            ),
          )
        : null;
    if (!volume) {
      clearSelection();
      return;
    }
    selected = {
      record: volume,
      anchor: {
        lon: ground.lon,
        lat: ground.lat,
        height: volumeHeights(volume).top,
      },
    };
    publishCard();
  }

  function installClock() {
    unhold ??= clock.hold(ID);
    unsubscribeClock ??= clock.subscribe(() => applyTime());
    if (!recheckTimer) {
      recheckTimer = setInterval(() => applyTime(), LIVE_RECHECK_MS);
      // Never the reason a Node process (a test, a tool) stays alive.
      recheckTimer?.unref?.();
    }
  }

  function removeClock() {
    unhold?.();
    unsubscribeClock?.();
    if (recheckTimer) clearInterval(recheckTimer);
    unhold = unsubscribeClock = recheckTimer = null;
  }

  function settingChips(group, labelOf) {
    return TURBULENCE_FILTER_GROUPS[group].map((key) => ({
      id: `${group}-${key}`,
      label: labelOf(key),
      active: filters[key],
      params: { [key]: !filters[key] },
    }));
  }

  const layer = {
    id: ID,
    name: 'Turbulence',
    icon: '≋',
    source: 'NOAA AWC',
    updateInterval: 600_000,

    init(nextViewer) {
      if (viewer) throw new Error('Turbulence layer is already initialized');
      viewer = nextViewer;
      rendering = createRendering({ viewer });
      uncover = clock.register({ id: ID, coverage });
    },

    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      rendering?.setVisible(true);
      overlayHost?.setVisible?.(TURBULENCE_OVERLAY_SOURCE_ID, true);
      installClock();
      if (overlayHost && viewer && !clickSubscription)
        clickSubscription = inputFor(viewer).onClick(onClick);
      coverageChanged();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      error = null;
      snapshot = null;
      filtered = EMPTY;
      current = null;
      shownKey = null;
      removeClock();
      clickSubscription?.();
      clickSubscription = null;
      clearSelection();
      overlayHost?.clearSource?.(TURBULENCE_OVERLAY_SOURCE_ID);
      overlayHost?.setVisible?.(TURBULENCE_OVERLAY_SOURCE_ID, false);
      rendering?.clear();
      rendering?.setVisible(false);
      coverageChanged();
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
        snapshot = next;
        // Unavailable: nothing old is left presented as current hazard data.
        error = next.unavailable ? next.reason || UNAVAILABLE : null;
        if (next.unavailable) rendering?.clear();
        applySnapshot();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || UNAVAILABLE;
        snapshot = null;
        rendering?.clear();
        applySnapshot();
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
      if (destroyed) return;
      const result = applyTurbulenceFilters(filters, params);
      if (!result.changed) return;
      filters = result.filters;
      if (enabled) applySnapshot();
      notify();
    },

    getParams() {
      return { ...filters };
    },

    getRowControls() {
      const counts = {
        forecasts: current?.forecasts.length ?? 0,
        warnings: current?.warnings.length ?? 0,
        reports: current?.reports.length ?? 0,
      };
      const issued = current?.forecasts[0]?.issuedAt;
      const detail =
        current?.forecastValidAt != null
          ? t('Forecast · valid {valid} · issued {issued}', {
              valid: utcTime(current.forecastValidAt),
              issued: utcTime(issued),
            })
          : snapshot
            ? t('No frame within {gap} h of {time}', {
                gap: 1.5,
                time: utcTime(timeNow()),
              })
            : loading
              ? t('Loading')
              : t('Unavailable');
      const countsText = t(
        'Forecast areas {forecasts} · Warnings {warnings} · Pilot reports {reports}',
        counts,
      );
      const status =
        errorText(error) ||
        (snapshot?.stale
          ? t('Stale source')
          : snapshot?.partial
            ? t('Some feeds unavailable')
            : null);
      return {
        readout: true,
        summary: {
          label: `${t('Turbulence')} · NOAA AWC`, // i18n-ignore: provider name
          coverage: t('US forecasts · worldwide warnings'),
          compact: countsText,
          detail,
          status,
          lines: [
            { id: 'counts', text: countsText },
            {
              id: 'reports-window',
              text: t('Pilot reports from the 3 hours before the time shown'),
              muted: true,
            },
            {
              id: 'disclaimer',
              text: t('Informational only · not for flight planning'),
              muted: true,
            },
          ],
          settings: [
            {
              id: 'severity',
              label: t('Severity'),
              chips: settingChips('severity', severityLabel),
            },
            {
              id: 'altitude',
              label: t('Altitude'),
              chips: settingChips('altitude', (key) =>
                key === 'low' ? t('Below FL180') : t('FL180 and above'),
              ),
            },
            {
              id: 'sources',
              label: t('Sources'),
              chips: settingChips('sources', (key) =>
                key === 'forecasts'
                  ? t('Forecasts')
                  : key === 'warnings'
                    ? t('Warnings')
                    : t('Pilot reports'),
              ),
            },
          ],
          actions: [],
          units: '',
        },
        chips: [],
        legendCategorical: true,
        legend: TURBULENCE_BANDS.map((band) => ({
          label: severityLabel(band.id),
          color: band.color,
        })),
        info: `${detail}\n${countsText}${status ? `\n${status}` : ''}`,
        infoTitle: t(
          'NOAA Aviation Weather Center turbulence. Forecast areas are US G-AIRMETs, each valid at one time, three hours apart; the timeline shows the one nearest its time. Warnings are SIGMETs for severe turbulence and mountain waves, worldwide where issued. Pilot reports are what crews reported in the three hours before the time shown. Volumes span each area’s floor to its top; a volume is hidden while the camera is inside it. Click the map inside a volume, or a report, for details. Informational only, not for flight planning.',
        ),
      };
    },

    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!enabled || destroyed || !current) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const record of [
        ...current.warnings,
        ...current.forecasts,
        ...current.reports,
      ]) {
        if (result.length >= limit) break;
        const { lon, lat } = centroid(record);
        result.push({
          id: record.id,
          kind: record.kind,
          hazard: record.hazard,
          severity: record.severity,
          lowerAltitude: altitudeLabel(record.baseFt, {
            surface: record.baseIsSurface,
          }),
          upperAltitude: altitudeLabel(record.topFt),
          region: record.region ?? null,
          lat,
          lon,
        });
      }
      return result;
    },

    getStats() {
      return {
        count:
          (current?.forecasts.length ?? 0) +
          (current?.warnings.length ?? 0) +
          (current?.reports.length ?? 0),
        lastUpdate: snapshot?.fetchedAt ?? null,
        loading,
        error,
        stale: Boolean(snapshot?.stale),
        partial: Boolean(snapshot?.partial),
        source: 'NOAA AWC',
      };
    },

    getDiagnostics() {
      return {
        ...rendering?.getDiagnostics(),
        enabled,
        loading,
        requestPending: Boolean(request),
        clockHeld: Boolean(unhold),
        selectedId: selected?.record.id ?? null,
      };
    },

    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      uncover?.();
      uncover = null;
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
    },
  };
  return layer;
}
