import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import {
  RIVER_OUTLOOK_COLORS,
  RIVER_OUTLOOK_DAYS,
  RIVER_OUTLOOK_LABELS,
  classifyRiverOutlook,
} from './records.js';
export * from './records.js';
export { createRiverDischargeSource } from './source.js';

const LAYER_ID = 'river-discharge';
const REQUEST_DEBOUNCE_MS = 800;
/** The levels a card and the legend name, most severe first. */
const LEGEND_LEVELS = Object.freeze(['very-high', 'high', 'normal']);
const PIXEL_SIZE = Object.freeze({
  'very-high': 13,
  high: 11,
  normal: 7,
  unknown: 6,
});
const WORLD = Object.freeze({ south: -90, west: -180, north: 90, east: 180 });

/** m³/s in the UI language, three significant figures at most. */
function discharge(value) {
  if (!Number.isFinite(value)) return '—';
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return formatNumber(Number(value.toFixed(digits)), {
    maximumFractionDigits: digits,
  });
}

/**
 * Own one river discharge outlook display: a request per view for the
 * bundled points inside it, one coloured point per river location, click
 * selection and a readout card. The source resolves
 * `{ today, fetchedAt, total, partial, stale, points }` where each point
 * carries its reanalysis percentiles and a forecast series; the outlook
 * level is computed here, against the proxy's `today`.
 */
export function createRiverDischargeLayer({ source, services } = {}) {
  if (typeof source?.getOutlook !== 'function')
    throw new TypeError('River discharge outlook requires an outlook source');
  const { governorRequestRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;
  const {
    clearSelectedEntityContextForLayer,
    getSelectedEntityContext,
    registerEntityContext,
    removeEntityContextsForLayer,
    selectEntityContext,
  } = services.context;

  const state = {
    viewer: null,
    dataSource: null,
    enabled: false,
    /** Displayed points by id: { point, outlook }. */
    records: new Map(),
    selectedId: null,
    request: null,
    loading: false,
    debounceTimer: null,
    moveEndRemove: null,
    clickHandler: null,
    lastUpdate: null,
    observedAt: null,
    today: null,
    /** Reanalysis years the percentiles come from: { from, to }. */
    climatology: null,
    error: null,
    status: 'idle',
    stale: false,
    partial: false,
  };

  /** The visible rectangle, or the whole world when the view is not on the globe. */
  function viewBox() {
    const viewer = state.viewer;
    const rectangle = viewer?.camera?.computeViewRectangle?.(
      viewer.scene.globe.ellipsoid,
    );
    if (!rectangle) return WORLD;
    const toDeg = Cesium.Math.toDegrees;
    const box = {
      south: Math.max(-90, toDeg(rectangle.south)),
      west: Math.max(-180, toDeg(rectangle.west)),
      north: Math.min(90, toDeg(rectangle.north)),
      east: Math.min(180, toDeg(rectangle.east)),
    };
    if (
      !Object.values(box).every(Number.isFinite) ||
      !(box.north > box.south) ||
      box.west === box.east
    )
      return WORLD;
    return box;
  }

  function setAppearance(entity, record, selected) {
    const level = record.outlook.level;
    entity.point.pixelSize = PIXEL_SIZE[level] + (selected ? 4 : 0);
    entity.point.color = Cesium.Color.fromCssColorString(
      RIVER_OUTLOOK_COLORS[level],
    );
    entity.point.outlineColor = selected
      ? Cesium.Color.WHITE
      : Cesium.Color.BLACK.withAlpha(0.8);
    entity.point.outlineWidth = selected ? 3 : 1;
  }

  function registerContext(entity, record) {
    const { point, outlook } = record;
    registerEntityContext(entity, {
      id: point.id,
      layerId: LAYER_ID,
      dataSource: state.dataSource,
      layerName: 'River discharge outlook',
      source: source.attribution?.description || source.label,
      label: point.name,
      latitude: point.lat,
      longitude: point.lon,
      properties: {
        river: point.name,
        outlookLevel: outlook.level,
        forecastPeakM3s: outlook.peak,
        forecastPeakDay: outlook.peakDay,
        todayM3s: outlook.today,
        p50M3s: point.p50,
        p90M3s: point.p90,
        p99M3s: point.p99,
        modelled: true,
      },
    });
  }

  function renderRecords(records) {
    const next = new Map(records.map((record) => [record.point.id, record]));
    const entities = state.dataSource.entities;
    entities.suspendEvents();
    for (const entity of [...entities.values])
      if (!next.has(entity.id)) entities.remove(entity);
    for (const record of records) {
      let entity = entities.getById(record.point.id);
      if (!entity) {
        entity = entities.add({
          id: record.point.id,
          position: Cesium.Cartesian3.fromDegrees(
            record.point.lon,
            record.point.lat,
          ),
          point: {
            pixelSize: PIXEL_SIZE.normal,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      }
      entity.gevRiverRecord = record;
      setAppearance(entity, record, record.point.id === state.selectedId);
      registerContext(entity, record);
    }
    entities.resumeEvents();
    removeEntityContextsForLayer(LAYER_ID, { retainIds: new Set(next.keys()) });
    state.records = next;
    if (state.selectedId && !next.has(state.selectedId)) {
      state.selectedId = null;
      clearSelectedEntityContextForLayer(LAYER_ID);
    } else if (state.selectedId) {
      // A refreshed forecast rewrites the open card.
      selectRecord(state.selectedId);
    }
    // Open-Meteo's licence asks for the linked credit beside displayed data.
    if (next.size)
      services.credits?.showOnScreenCredit?.(
        state.viewer,
        LAYER_ID,
        services.credits.riverDischargeCreditHtml?.(
          Number(String(state.today || '').slice(0, 4)) || undefined,
        ),
      );
    else services.credits?.hideOnScreenCredit?.(state.viewer, LAYER_ID);
    governorRequestRender('river-discharge-render');
  }

  function clearRendered() {
    state.dataSource?.entities.removeAll();
    state.records = new Map();
    if (state.selectedId) clearSelectedEntityContextForLayer(LAYER_ID);
    state.selectedId = null;
    removeEntityContextsForLayer(LAYER_ID);
    services.credits?.hideOnScreenCredit?.(state.viewer, LAYER_ID);
    governorRequestRender('river-discharge-render');
  }

  function cardDetails({ point, outlook }) {
    const unit = t('m³/s');
    const lines = [
      t('RIVER DISCHARGE OUTLOOK · MODELLED'),
      t(RIVER_OUTLOOK_LABELS[outlook.level]),
    ];
    if (outlook.peak !== null)
      lines.push(
        t('{days}-day forecast peak {value} {unit} on {day}', {
          days: formatNumber(RIVER_OUTLOOK_DAYS),
          value: discharge(outlook.peak),
          unit,
          day: outlook.peakDay,
        }),
      );
    if (outlook.today !== null)
      lines.push(
        t('Today {value} {unit}', { value: discharge(outlook.today), unit }),
      );
    const ensemble = outlook.ensemble;
    if (ensemble && ensemble.p25 !== null && ensemble.p75 !== null)
      lines.push(
        t(
          'Ensemble on peak day: middle half {low}–{high}, highest member {max} {unit}',
          {
            low: discharge(ensemble.p25),
            high: discharge(ensemble.p75),
            max: discharge(ensemble.max),
            unit,
          },
        ),
      );
    lines.push(
      t(
        '{from}–{to} daily flow: median {p50} · 90th {p90} · 99th {p99} {unit}',
        {
          from: state.climatology?.from ?? '—',
          to: state.climatology?.to ?? '—',
          p50: discharge(point.p50),
          p90: discharge(point.p90),
          p99: discharge(point.p99),
          unit,
        },
      ),
      t('Model outlook, not an observed flood or an official warning'),
      // i18n-ignore: attribution text is shown as the licensors require
      'Open-Meteo.com · GloFAS (Copernicus EMS)',
    );
    return lines;
  }

  function selectRecord(id) {
    const entity = state.dataSource?.entities.getById(id);
    const record = state.records.get(id);
    if (!entity || !record) return false;
    if (state.selectedId && state.selectedId !== id) releaseSelection();
    state.selectedId = id;
    setAppearance(entity, record, true);
    const anchor = Cesium.Cartesian3.fromDegrees(
      record.point.lon,
      record.point.lat,
      0,
    );
    entity.gevTrackedId = id;
    entity.gevDisplayPosition = () => anchor;
    entity.gevLabelModel = {
      // The river name stays as Natural Earth spells it.
      title: record.point.name,
      details: cardDetails(record),
      accent: RIVER_OUTLOOK_COLORS[record.outlook.level],
      cardStyle: 'tactical',
      selected: true,
      leaderStyle: 'elbow',
      anchorRadiusPx: 8,
      anchorRadiusScale: null,
    };
    selectEntityContext(entity);
    governorRequestRender('river-discharge-selection');
    return true;
  }

  function releaseSelection() {
    const id = state.selectedId;
    if (!id) return;
    const entity = state.dataSource?.entities.getById(id);
    const record = state.records.get(id);
    if (entity && record) setAppearance(entity, record, false);
    state.selectedId = null;
    clearSelectedEntityContextForLayer(LAYER_ID);
    governorRequestRender('river-discharge-selection');
  }

  function syncContextSelection() {
    if (state.selectedId && getSelectedEntityContext()?.id !== state.selectedId)
      releaseSelection();
  }

  function scheduleLoad() {
    if (!state.enabled) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      loadOutlook();
    }, REQUEST_DEBOUNCE_MS);
  }

  async function loadOutlook() {
    if (!state.enabled || !state.viewer) return false;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
    state.request?.abort();
    const request = new AbortController();
    state.request = request;
    state.loading = true;
    governorRequestRender('river-discharge-status');
    try {
      const snapshot = await source.getOutlook(viewBox(), {
        signal: request.signal,
      });
      if (request.signal.aborted || state.request !== request || !state.enabled)
        return false;
      state.today = snapshot.today;
      state.climatology = snapshot.climatology;
      renderRecords(
        snapshot.points.map((point) => ({
          point,
          outlook: classifyRiverOutlook(point, point.series, snapshot.today),
        })),
      );
      state.lastUpdate = Date.now();
      state.observedAt = snapshot.fetchedAt;
      state.error = null;
      state.stale = snapshot.stale === true;
      state.partial = snapshot.partial === true;
      state.status = state.records.size ? 'ready' : 'empty';
      return true;
    } catch (error) {
      if (
        error?.name === 'AbortError' ||
        request.signal.aborted ||
        state.request !== request ||
        !state.enabled
      )
        return false;
      state.error =
        error?.message || msg('River discharge outlook unavailable');
      // Points from an earlier read stay up and are reported as such.
      state.stale = state.records.size > 0;
      state.status = state.stale ? 'stale' : 'unavailable';
      console.warn('[Data:RiverDischarge] Refresh failed:', state.error);
      return false;
    } finally {
      if (state.request === request) {
        state.request = null;
        state.loading = false;
      }
      governorRequestRender('river-discharge-status');
    }
  }

  const levelCount = (level) =>
    [...state.records.values()].filter((r) => r.outlook.level === level).length;

  const layer = {
    id: LAYER_ID,
    name: 'River discharge outlook',
    icon: '🌊',
    // English in layer state; the layer row translates it.
    source: source.label || msg('Open-Meteo · GloFAS model'),
    // GloFAS publishes once a day and the proxy holds each point for three
    // hours; camera moves drive the reads in between.
    updateInterval: 1_800_000,
    statsRefreshInterval: 1000,

    init(viewer) {
      if (state.viewer)
        throw new Error('River discharge outlook is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource(LAYER_ID);
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      state.moveEndRemove =
        viewer.camera.moveEnd.addEventListener(scheduleLoad);
      for (const event of [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
      ])
        globalThis.window?.addEventListener?.(event, syncContextSelection);
      state.clickHandler = new Cesium.ScreenSpaceEventHandler(
        viewer.scene.canvas,
      );
      state.clickHandler.setInputAction((click) => {
        if (!isPointerFree() || !state.enabled) return;
        const picked = viewer.scene.pick(click.position);
        const id = typeof picked?.id?.id === 'string' ? picked.id.id : null;
        if (id && state.records.has(id) && id !== state.selectedId)
          selectRecord(id);
        else if (state.selectedId) releaseSelection();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(LAYER_ID, (id) => state.records.has(id));
      if (state.dataSource) state.dataSource.show = true;
    },

    disable() {
      state.enabled = false;
      state.request?.abort();
      state.request = null;
      state.loading = false;
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
      unregisterPickOwner(LAYER_ID);
      releaseSelection();
      clearRendered();
      if (state.dataSource) state.dataSource.show = false;
      state.status = 'idle';
      state.error = null;
      state.stale = false;
      state.partial = false;
    },

    update() {
      return loadOutlook();
    },

    /** Select a displayed point by id (QA and voice); false when absent. */
    select(id) {
      return state.enabled ? selectRecord(id) : false;
    },

    destroy(viewer = state.viewer) {
      this.disable();
      state.moveEndRemove?.();
      state.moveEndRemove = null;
      for (const event of [
        'gev:entity-selected',
        'gev:entity-selection-cleared',
      ])
        globalThis.window?.removeEventListener?.(event, syncContextSelection);
      state.clickHandler?.destroy();
      state.clickHandler = null;
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.viewer = null;
      state.lastUpdate = null;
      state.observedAt = null;
    },

    getRowControls() {
      return {
        chips: [],
        info: t(
          'Modelled GloFAS outlook at {count} river points · not observed flooding or an official warning',
          { count: formatNumber(state.records.size) },
        ),
        infoTitle: t(
          'Each point is a GloFAS river cell on a major river. Its colour compares the highest daily discharge forecast over the next 7 days with that cell’s own reanalysis flow over ten years. Model output can miss or overstate floods; follow your national hydrological service for warnings.',
        ),
        legend: LEGEND_LEVELS.map((level, index) => ({
          label: t(RIVER_OUTLOOK_LABELS[level]),
          color: RIVER_OUTLOOK_COLORS[level],
          count: levelCount(level),
          ...(index === 0
            ? {
                blurb: t(
                  'Percentiles of the point’s own daily flow over ten years of GloFAS reanalysis. Above the 99th is a flow reached on about 4 days a year.',
                ),
              }
            : {}),
        })),
      };
    },

    getStats() {
      const count = state.records.size;
      return {
        count,
        countLabel:
          state.enabled && count
            ? tn(count, '{count} river point', '{count} river points')
            : '',
        levels: Object.fromEntries(
          [...LEGEND_LEVELS, 'unknown'].map((level) => [
            level,
            levelCount(level),
          ]),
        ),
        lastUpdate: state.lastUpdate,
        // When the proxy read the oldest forecast shown, not when it arrived.
        observedAt: state.observedAt,
        today: state.today,
        stale: state.stale,
        partial: state.partial,
        error: state.error,
        status: state.status,
        loading: state.loading,
        modelled: true,
        loadingLabel: state.loading
          ? t('loading river discharge outlook')
          : [
              state.stale ? t('Showing an earlier forecast') : '',
              state.status === 'empty'
                ? t('No river outlook points in this view')
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
      };
    },
  };
  return layer;
}
