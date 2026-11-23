import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { cssColor } from '../../render/color.js';
import {
  drawOf,
  findCamera,
  findQuery,
  rendererOf,
} from '../../render/rendererOf.js';
import { keyRequirementText } from '../../ui/keyGuidance.js';
import { ECCC_DEFINITION } from './providers.js';
import { mergeObservations } from './merge.js';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AIR_QUALITY_OVERLAY_SOURCE_ID,
  AIR_QUALITY_OVERLAY_COHORT_LIMIT,
  AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
  createAirQualityOverlayEntry,
  mapAnalystRecord,
  newestObservation,
  readingsAreStale,
  readingsInView,
  selectAirQualityOverlayCohort,
} from './model.js';
export * from './model.js';
export { createEcccAirQualitySource } from './source.js';
export { createAirQualitySource } from './providers.js';

/** Station markers are a point reading, not an extent. */
const STATION_MARKER_RADIUS_M = 6_000;
/** Readings listed in the readout card. */
const READOUT_LIMIT = 5;

export const AIR_QUALITY_MARKER_SET_ID = 'air-quality';
let instances = 0;

/** A reading's colour at `alpha`; an unreadable colour falls back to white. */
function withAlpha(css, alpha) {
  const [r, g, b] = cssColor(css) ?? [1, 1, 1];
  return [r, g, b, alpha];
}

/** Pollutant views, as the providers' parameter ids; each on its own scale. */
export const AIR_QUALITY_POLLUTANT_VIEWS = Object.freeze([
  'PM2.5',
  'PM10',
  'O3',
  'NO2',
  'SO2',
  'CO',
]);
/** The colour of a station no index rates. */
const UNRATED_COLOR = '#8cb4ce';
/** Index acronyms: the same text in every language. */
const INDEX_VIEW_NAMES = Object.freeze({ aqi: 'US AQI', aqhi: 'AQHI' });

/**
 * Own one air-quality display, its refresh lifecycle, and its readout card.
 *
 * The layer shows one `view` at a time: the US AQI (`'aqi'`, the default), one
 * pollutant (`'PM2.5'`, `'NO2'`, ...), or Canada's AQHI (`'aqhi'`). Every
 * observation provider (`observation: true`) is asked in parallel for the
 * station views and drawn as one de-duplicated set (`merge.js`); the AQHI view
 * asks the index providers (`observation: false`: ECCC) only. A provider that
 * fails or needs a key keeps its own state and never blanks the others.
 */
export function createAirQualityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  let _viewer = null;
  let _markers = null;
  let _points = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _enabled = false;
  let rowControlsListener = null;
  const definitions = source.definitions ?? [ECCC_DEFINITION];
  const observationProviders = definitions.filter(
    (entry) => entry.observation === true,
  );
  const indexProviders = definitions.filter(
    (entry) => entry.observation !== true,
  );
  /** Views this source can answer, the default first. */
  const views = Object.freeze([
    ...(observationProviders.length ? ['aqi'] : []),
    ...(indexProviders.length ? ['aqhi'] : []),
    ...AIR_QUALITY_POLLUTANT_VIEWS.filter((id) =>
      observationProviders.some((entry) => entry.parameters.includes(id)),
    ),
  ]);
  let view = views[0];
  let showStations = true;
  let selectedStation = null;
  /** The providers the current view asks. */
  const asked = () =>
    view === 'aqhi'
      ? indexProviders
      : view === 'aqi'
        ? observationProviders
        : observationProviders.filter((entry) =>
            entry.parameters.includes(view),
          );
  /**
   * The pollutant a provider is asked for. Until the US AQI is computed, the
   * AQI view asks for the stations' PM2.5 and draws them unrated.
   */
  const parameterFor = (entry) =>
    view === 'aqhi'
      ? undefined
      : view === 'aqi'
        ? entry.parameters.includes('PM2.5')
          ? 'PM2.5'
          : entry.parameters[0]
        : view;
  const freshState = () => ({
    status: 'idle',
    readings: [],
    coverage: null,
    error: null,
    retryAt: null,
    request: null,
    requestedView: null,
  });
  /** Per-provider acquisition state, keyed by provider id. */
  let states = new Map(asked().map((entry) => [entry.id, freshState()]));
  const stateOf = (entry) => {
    if (!states.has(entry.id)) states.set(entry.id, freshState());
    return states.get(entry.id);
  };
  /** Which provider a drawn reading came from (ids may be reused by hosts). */
  let owners = new WeakMap();
  const ownerOf = (reading) =>
    owners.get(reading) ?? asked()[0] ?? definitions[0];
  let overlayEntries = [];
  let removeMoveEnd = null;
  let moveTimer = null;
  let retryTimer = null;

  const isObservationView = () => view !== 'aqhi';
  const scale = () =>
    view === 'aqhi'
      ? asked()[0]?.scale || INDEX_VIEW_NAMES.aqhi
      : INDEX_VIEW_NAMES[view] || view;
  const sourceLabel = () =>
    asked()
      .map((entry) => entry.sourceLabel || entry.network)
      .join(' · ');
  const isLoading = () =>
    asked().some((entry) => stateOf(entry).status === 'loading');
  /** A layer error only when no asked provider answered. */
  const lastError = () => {
    const list = asked().map(stateOf);
    if (list.some((state) => ['ok', 'loading'].includes(state.status)))
      return null;
    return list.find((state) => state.error)?.error ?? null;
  };
  const nextRetryAt = () => {
    const at = Math.min(
      ...asked().map((entry) => stateOf(entry).retryAt ?? Infinity),
    );
    return Number.isFinite(at) ? at : null;
  };
  /** The asked providers' coverage, folded into one card-facing record. */
  const combinedCoverage = () => {
    const list = asked()
      .map((entry) => stateOf(entry).coverage)
      .filter(Boolean);
    if (!list.length) return null;
    const sum = (key) =>
      list.reduce(
        (total, item) => total + (Number.isFinite(item[key]) ? item[key] : 0),
        0,
      );
    const checked = list.some((item) => Number.isFinite(item.checked));
    return {
      stale: list.every((item) => item.stale === true),
      anyStale: list.some((item) => item.stale === true),
      partial: list.some((item) => item.partial === true),
      failureStatus: list.some((item) => item.failureStatus === 429)
        ? 429
        : (list.find((item) => item.failureStatus)?.failureStatus ?? null),
      catalog: list.reduce(
        (total, item) => total + (item.stations?.length ?? 0),
        0,
      ),
      ...(checked
        ? {
            checked: sum('checked'),
            eligible: sum('eligible'),
            countriesReporting: sum('countriesReporting'),
          }
        : {}),
    };
  };

  const notify = () => rowControlsListener?.();
  const armRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
    const at = _enabled ? nextRetryAt() : null;
    if (at === null) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = null;
        void refresh(
          asked().filter((entry) => stateOf(entry).retryAt !== null),
        );
      },
      at - Date.now() + 100,
    );
  };
  const setRetry = (entry, at) => {
    stateOf(entry).retryAt =
      entry.viewDriven && _enabled && Number.isFinite(at)
        ? Math.min(Date.now() + 24 * 3600_000, Math.max(Date.now() + 1000, at))
        : null;
  };
  /** Abort every request and timer; loading states return to idle. */
  const halt = () => {
    for (const state of states.values()) {
      state.request?.abort();
      state.request = null;
      state.retryAt = null;
      if (state.status === 'loading') state.status = 'idle';
    }
    clearTimeout(retryTimer);
    retryTimer = null;
    clearTimeout(moveTimer);
    moveTimer = null;
  };

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () =>
    _viewer ? (findCamera(_viewer)?.viewRectangle() ?? null) : null;

  const currentView = () => {
    const rect = viewRectangle();
    if (!rect) return null;
    const width = (rect.east - rect.west + 360) % 360 || 360;
    const lon = ((rect.west + width / 2 + 540) % 360) - 180;
    const canvas = rendererOf(_viewer)?.canvas;
    const focus =
      canvas &&
      findQuery(_viewer)?.pickEllipsoid(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
    const center = focus ? toLonLatH(focus) : null;
    const values = [
      rect.west,
      rect.south,
      rect.east,
      rect.north,
      center ? center.lon : lon,
      center ? center.lat : (rect.south + rect.north) / 2,
    ];
    const rounded = values.map((v) => Number(v.toFixed(4)));
    return rounded[0] === rounded[2] || rounded[1] >= rounded[3]
      ? values
      : rounded;
  };

  /** One reading as the current view presents it. */
  const present = (reading) => {
    if (view !== 'aqi') return reading;
    // The US AQI is not computed yet: no pollutant category stands in for it.
    const unrated = { ...reading, rating: null, color: UNRATED_COLOR };
    delete unrated.assessment;
    return unrated;
  };

  /** Merge every asked provider's readings into the drawn set. */
  const apply = () => {
    owners = new WeakMap();
    const lists = asked().map((entry) => ({
      provider: entry.id,
      direct: entry.direct === true,
      readings: stateOf(entry).readings.map((raw) => {
        const reading = present(raw);
        owners.set(reading, entry);
        return reading;
      }),
    }));
    _readings = mergeObservations(lists);
    _count = _readings.length;
    layer._render();
  };

  /** Ask one provider; its answer lands in its own state only. */
  const run = async (entry, state, request, rect) => {
    const parameter = parameterFor(entry);
    try {
      const readings = await source.getSnapshot({
        signal: request.signal,
        provider: entry.id,
        ...(parameter ? { parameter } : {}),
        ...(rect ? { view: rect } : {}),
      });
      // A superseded or aborted request must not touch the scene, and neither
      // must one that lands after the layer was switched off.
      if (request.signal.aborted || state.request !== request || !_enabled)
        // A newer request owns acquisition. This is not a failed layer
        // enable: the lifecycle manager must keep the layer and its refresh
        // loop on.
        return _enabled;
      state.request = null;
      state.status = 'ok';
      state.error = null;
      state.readings = Array.isArray(readings) ? readings : [];
      state.coverage = source.getCoverage?.(entry.id) ?? null;
      setRetry(entry, state.coverage?.retryAt);
      _lastUpdate = Date.now();
      apply();
      return true;
    } catch (error) {
      if (request.signal.aborted || state.request !== request) return _enabled;
      state.request = null;
      // Earlier readings stay drawn: a failed refresh is degraded, not empty.
      state.status = error?.code === 'no_key' ? 'no-key' : 'failed';
      state.error =
        (error?.code === 'no_key'
          ? keyRequirementText(entry.requiresKeyId)
          : '') ||
        error?.message ||
        msg('Air quality request failed');
      setRetry(entry, error?.retryAt);
      console.warn(
        `[Data:AirQuality] Refresh failed (${entry.id}):`,
        state.error,
      );
      return state.retryAt !== null;
    } finally {
      armRetry();
      notify();
    }
  };

  /** Ask the given providers in parallel; resolve once all have settled. */
  const refresh = async (entries) => {
    if (!_enabled || !_markers) return false;
    if (moveTimer) {
      // A pending camera refresh is folded into this one.
      clearTimeout(moveTimer);
      moveTimer = null;
      entries = [
        ...new Set([...entries, ...asked().filter((e) => e.viewDriven)]),
      ];
    }
    const rect = currentView();
    const requestedView = JSON.stringify(rect);
    const jobs = entries.map((entry) => {
      const state = stateOf(entry);
      state.request?.abort();
      state.request = null;
      state.retryAt = null;
      state.status = 'loading';
      state.error = null;
      if (entry.viewDriven) {
        state.requestedView = requestedView;
        // A camera that is still restoring its share-link position has no
        // useful viewport yet. Never turn that transient state into a global
        // API sweep.
        if (!rect) return Promise.resolve(true);
      }
      const request = new AbortController();
      state.request = request;
      return run(entry, state, request, entry.viewDriven ? rect : null);
    });
    armRetry();
    notify();
    const results = await Promise.all(jobs);
    return !results.length || results.some(Boolean);
  };

  const syncVisibility = () => {
    const shown = _enabled && showStations;
    if (_markers) _markers.show = shown;
    if (_points) _points.show = shown;
    overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, shown);
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    source: sourceLabel(),
    updateInterval: 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _markers = drawOf(viewer).shapes({
        id: `${AIR_QUALITY_MARKER_SET_ID}:${++instances}`,
        show: false,
      });
      _points = drawOf(viewer).points({
        id: `${AIR_QUALITY_MARKER_SET_ID}:points:${instances}`,
        show: false,
      });
      _viewer = viewer;
      removeMoveEnd = findCamera(viewer)?.on('moveEnd', () => {
        if (!_enabled) return;
        this._publishOverlays();
        const key = JSON.stringify(currentView());
        // Only providers that fetch per view follow the camera; one still
        // waiting for a key is asked again on the next scheduled refresh.
        const moved = asked().filter(
          (entry) =>
            entry.viewDriven &&
            stateOf(entry).status !== 'no-key' &&
            stateOf(entry).requestedView !== key,
        );
        if (moved.length) {
          for (const entry of moved) {
            const state = stateOf(entry);
            state.request?.abort();
            state.request = null;
            state.status = 'loading';
            state.coverage = null;
            state.error = null;
            state.retryAt = null;
          }
          armRetry();
          clearTimeout(moveTimer);
          moveTimer = setTimeout(() => {
            moveTimer = null;
            void refresh(
              asked().filter(
                (entry) =>
                  entry.viewDriven && stateOf(entry).status !== 'no-key',
              ),
            );
          }, 400);
        }
        notify();
      });
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      syncVisibility();
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      halt();
      _enabled = false;
      if (_markers) _markers.show = false;
      if (_points) _points.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    /** Only `view` is saved and shared; the others are session state. */
    getParams() {
      return { view, stations: showStations, station: selectedStation };
    },

    setParams(params = {}) {
      const nextView = params.view ?? view;
      if (!views.includes(nextView)) return false;
      let changed = false;
      if (
        typeof params.stations === 'boolean' &&
        params.stations !== showStations
      ) {
        showStations = params.stations;
        changed = true;
      }
      if (params.station !== undefined) {
        const station =
          typeof params.station === 'string' && params.station
            ? params.station
            : null;
        if (station !== selectedStation) {
          selectedStation = station;
          changed = true;
        }
      }
      if (nextView === view) {
        if (changed) {
          syncVisibility();
          this._publishOverlays();
          notify();
        }
        return;
      }
      halt();
      view = nextView;
      states = new Map(asked().map((entry) => [entry.id, freshState()]));
      this.source = sourceLabel();
      _lastUpdate = null;
      apply();
      syncVisibility();
      notify();
      if (_enabled) void this.update();
    },

    async update() {
      if (!_enabled || !_markers) return false;
      return refresh(asked());
    },

    /** Each asked provider's state, for the card: ok, loading, failed, no-key. */
    getProviderStates() {
      return asked().map((entry) => {
        const state = stateOf(entry);
        return {
          id: entry.id,
          title: entry.title,
          network: entry.network,
          requiresKeyId: entry.requiresKeyId || null,
          status: state.status,
          error: state.error,
          count: state.readings.length,
        };
      });
    },

    /** Redraw the station markers and overlay labels from the current readings. */
    _render() {
      if (!_markers) return;
      const markers = [];
      const points = [];
      overlayEntries = [];
      for (const reading of _readings) {
        const owner = ownerOf(reading);
        const position = fromDegrees(reading.lon, reading.lat);
        // A filled disc on the ground with static axes, as in the earthquake
        // layer: a per-frame axis re-tessellates clamped ground geometry
        // every frame. No outline: clamped to the ground, the default
        // renderer never drew one.
        const meta = { ...reading };
        if (owner.observation === true) {
          points.push({
            id: `air-quality:${reading.id}`,
            pos: { lon: reading.lon, lat: reading.lat, height: 0 },
            pixelSize: 8,
            color: reading.color,
            outlineColor: '#000000',
            outlineWidth: 1,
            height: 'clampGround',
            meta,
          });
        } else
          markers.push({
            id: `air-quality:${reading.id}`,
            geometry: {
              kind: 'ellipse',
              center: { lon: reading.lon, lat: reading.lat },
              semiMajor: STATION_MARKER_RADIUS_M,
              semiMinor: STATION_MARKER_RADIUS_M,
            },
            fill: withAlpha(reading.color, 0.35),
            height: 'clampGround',
            clampTo: 'both',
            meta: {
              provider: reading.provider,
              scale: reading.scale,
              value: reading.value,
              band: reading.band,
              name: reading.name,
              zone: reading.zone,
              risk: reading.risk,
              observedMs: reading.observedMs,
              note: reading.note,
              lat: reading.lat,
              lon: reading.lon,
            },
          });
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${reading.label}${reading.assessment?.label || reading.rating ? ` · ${bandLabel(reading.assessment?.label || reading.rating.label, owner.bandContext)}` : ''}`,
            accent: reading.color,
            value: owner.observation === true ? 0 : reading.value,
          }),
        );
      }
      _markers.set(markers);
      _points.set(points);
      this._publishOverlays();
    },

    _publishOverlays() {
      if (!_enabled) return;
      if (!showStations) {
        overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
        return;
      }
      const visibleIds = isObservationView()
        ? new Set(
            readingsInView(_readings, viewRectangle(), _readings.length).map(
              (row) => row.id,
            ),
          )
        : null;
      overlayHost.setEntries(
        AIR_QUALITY_OVERLAY_SOURCE_ID,
        selectAirQualityOverlayCohort(
          visibleIds
            ? overlayEntries.filter((entry) => visibleIds.has(entry.id))
            : overlayEntries,
        ),
        {
          cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
          collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
          moving: false,
        },
      );
    },

    destroy() {
      halt();
      _enabled = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      _markers?.dispose();
      _markers = null;
      _points?.dispose();
      _points = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      _viewer = null;
      overlayEntries = [];
      states = new Map(asked().map((entry) => [entry.id, freshState()]));
      owners = new WeakMap();
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      rowControlsListener = null;
    },

    /**
     * Readout descriptor for the Weather panel: the band legend, and the worst
     * readings currently in view.
     *
     * `readout: true` renders the toggle and source line only; the card owns
     * the rest. Coverage is stated plainly because this layer is not global.
     */
    getRowControls() {
      const isObservation = isObservationView();
      const entries = asked();
      const single = entries.length === 1 ? entries[0] : null;
      const units = scale();
      const network = entries.map((entry) => entry.network).join(' · ');
      const loading = isLoading();
      const error = lastError();
      const coverage = combinedCoverage();
      const retryAt = nextRetryAt();
      const rectangle = viewRectangle();
      const query = findQuery(_viewer);
      const visible = readingsInView(
        _readings,
        rectangle,
        _readings.length,
      ).filter(
        (reading) =>
          !query?.isOccluded?.(fromDegrees(reading.lon, reading.lat)),
      );
      const inView = (
        isObservation
          ? visible.sort(
              (a, b) =>
                (b.assessment?.severity ?? b.rating?.score ?? -1) -
                  (a.assessment?.severity ?? a.rating?.score ?? -1) ||
                a.name.localeCompare(b.name),
            )
          : visible
      ).slice(0, READOUT_LIMIT);
      const worst = inView.find((row) => row.assessment?.label || row.rating);
      const category = worst?.assessment?.label || worst?.rating?.label;
      const categoryText = category
        ? bandLabel(category, ownerOf(worst).bandContext)
        : '';
      const assessment = worst?.assessment;
      const assessmentLines =
        !loading && !error && !coverage?.stale && worst
          ? [
              {
                id: 'health-summary',
                text: t(
                  'Highest {pollutant} category in view: {category} · {station}',
                  {
                    pollutant: units,
                    category: categoryText,
                    station: worst.name,
                  },
                ),
              },
              ...(assessment?.general
                ? [
                    {
                      id: 'general-guidance',
                      text: t('Most people: {advice}', {
                        advice: t(assessment.general),
                      }),
                    },
                    {
                      id: 'sensitive-guidance',
                      text: t('Heart or breathing conditions: {advice}', {
                        advice: t(assessment.sensitive),
                      }),
                    },
                    {
                      id: 'assessment-scope',
                      text: t(
                        'At the observation time, for this pollutant only. Other pollutants and unmonitored areas may differ.',
                      ),
                    },
                  ]
                : []),
            ]
          : [];
      const visibleOwners = [...new Set(visible.map(ownerOf))];
      const interpretation =
        view === 'aqi'
          ? t('Index unavailable')
          : [
              ...new Set(
                visibleOwners.map((entry) =>
                  entry.getLegend && !entry.getLegend(view).length
                    ? msg(
                        'This pollutant has no category on the EEA hourly scale.',
                      )
                    : entry.interpretation || '',
                ),
              ),
            ]
              .filter(Boolean)
              .map((text) => t(text))
              .join(' ');
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      const chip = (id) => ({
        id,
        label: INDEX_VIEW_NAMES[id] || id,
        active: view === id,
        params: { view: id },
      });
      const indexChips = views.filter((id) => INDEX_VIEW_NAMES[id]).map(chip);
      const pollutantChips = views
        .filter((id) => !INDEX_VIEW_NAMES[id])
        .map(chip);
      const legend =
        view === 'aqi'
          ? [{ color: UNRATED_COLOR, label: t('Not rated') }]
          : entries.flatMap((entry) =>
              (entry.getLegend
                ? [
                    ...entry.getLegend(view),
                    { color: UNRATED_COLOR, label: msg('Not rated') },
                  ]
                : (entry.legend ?? [])
              ).map((band) => ({
                color: band.color,
                label: `${bandLabel(band.label, entry.bandContext)}${band.range ? ` ${band.range}` : ''}`,
              })),
            );
      // Readings and errors stay English data (analyst records, stats); the
      // card translates them as the Layers panel row does. A provider's own
      // error text has no catalog entry and shows as it came.
      return {
        readout: true,
        summary: {
          label: single ? t(single.label) : t('Air quality'),
          coverage: entries.map((entry) => t(entry.coverage)).join(' · '),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: `${network} · ${units}`,
          status: loading
            ? t('Loading observations for this view…')
            : error
              ? translateFeedError(error)
              : coverage?.failureStatus === 429
                ? t(
                    'Provider request budget reached. Cached data will refresh later.',
                  )
                : coverage?.stale
                  ? t('Air quality provider unavailable')
                  : category
                    ? `${units} · ${categoryText}`
                    : coverage?.partial
                      ? t('Partial coverage · discovery continues')
                      : _count === 0
                        ? _lastUpdate === null
                          ? t('No readings available')
                          : t('No current readings')
                        : tn(
                            _count,
                            '{count} station reporting',
                            '{count} stations reporting',
                          ),
          units,
          overview: assessmentLines,
          settings: [
            ...(indexChips.length
              ? [{ id: 'index', label: t('Index'), chips: indexChips }]
              : []),
            ...(pollutantChips.length
              ? [
                  {
                    id: 'pollutant',
                    label: t('Pollutant'),
                    chips: pollutantChips,
                  },
                ]
              : []),
          ],
          ...(isObservation
            ? {
                lines: [
                  {
                    id: 'coverage',
                    text: entries
                      .map((entry) => t(entry.coverageNote || entry.coverage))
                      .join(' '),
                  },
                  {
                    id: 'counts',
                    text: t(
                      '{catalog} catalog stations · {reporting} reporting · {visible} in view',
                      {
                        catalog: coverage?.catalog ?? 0,
                        reporting: _count,
                        visible: visible.length,
                      },
                    ),
                  },
                  {
                    id: 'interpretation',
                    text: loading
                      ? t('Loading observations for this view…')
                      : visible.length
                        ? interpretation
                        : error || coverage?.stale
                          ? t('Observations unavailable; retrying on refresh.')
                          : coverage?.partial
                            ? t(
                                'Discovery is incomplete; empty areas do not yet mean no data.',
                              )
                            : t(
                                'No current observations for this pollutant in the map view.',
                              ),
                  },
                  ...(Number.isFinite(coverage?.checked)
                    ? [
                        {
                          id: 'progress',
                          text: t(
                            '{checked} stations with observations · {eligible} recent catalog stations · {countries} countries reporting',
                            {
                              checked: coverage.checked,
                              eligible: coverage.eligible,
                              countries: coverage.countriesReporting || 0,
                            },
                          ),
                        },
                      ]
                    : []),
                  ...(retryAt
                    ? [
                        {
                          id: 'retry',
                          text: t(
                            'Next automatic update at {time}. Cached observations remain visible.',
                            {
                              time: new Date(retryAt).toLocaleTimeString(),
                            },
                          ),
                        },
                      ]
                    : []),
                  ...(coverage?.partial
                    ? [
                        {
                          id: 'partial',
                          text: t(
                            'Coverage is loading progressively within the provider request budget.',
                          ),
                        },
                      ]
                    : []),
                  ...(coverage?.anyStale
                    ? [
                        {
                          id: 'cached',
                          text: t(
                            'Cached observations; provider refresh failed.',
                          ),
                        },
                      ]
                    : []),
                ],
              }
            : {}),
        },
        legend: legend.filter(
          (band, index) =>
            legend.findIndex(
              (other) =>
                other.color === band.color && other.label === band.label,
            ) === index,
        ),
        legendCategorical: true,
        list: {
          ariaLabel: isObservation
            ? t('Observations in view')
            : t('Highest air-quality readings in view'),
          items: inView.map((reading, index) => {
            const owner = ownerOf(reading);
            return {
              id: reading.id,
              ordinal: index + 1,
              lead: `${reading.scale} ${reading.label}`,
              ...(isObservation
                ? {
                    badge: reading.rating
                      ? `${bandLabel(reading.rating.label, owner.bandContext)} · ${reading.rating.score}/10`
                      : reading.assessment?.label
                        ? bandLabel(reading.assessment.label, owner.bandContext)
                        : reading.assessment
                          ? t('Not rated')
                          : t('Index unavailable'),
                    badgeColor: reading.color,
                  }
                : {}),
              text: isObservation
                ? `${reading.name} · ${reading.zone} · ${reading.owner || owner.network} · ${t(reading.averagingMinutes === 60 ? msg('Hourly average') : msg('Source averaging period unspecified'))} · ${new Date(reading.observedMs).toISOString()} · ${reading.assessment?.label ? `${t('Calculated comparison')} · ${t(reading.assessment.method)} · ${reading.assessment.range}` : reading.assessment?.reason ? t(reading.assessment.reason) : reading.rating ? t(owner.indexLabel || 'Index unavailable') : t('Index unavailable')} · ${Date.now() - reading.observedMs > 2 * 3600_000 ? `${t('Older observation')} · ` : ''}${t('Provisional data')} · ${reading.network || owner.network} · ${(reading.licenses || []).map((item) => item.attribution || item.name).join(', ')}`
                : `${reading.name} · ${t(reading.risk)}`,
              accent: reading.color,
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Snapshot readings as JSON-safe records for the analyst query engine.
     * @param {number} [maxCount=500]
     * @returns {Array<object>}
     */
    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_readings.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _readings
        .slice(0, limit)
        .map((reading, index) => mapAnalystRecord(reading, index));
    },

    getStats() {
      // `lastUpdate` is when a response was received; `observedAt` is when the
      // network actually measured. Freshness is judged on the latter, so a feed
      // that keeps answering with hours-old observations reports STALE rather
      // than being narrated as live by the HUD and voice provenance envelope.
      return {
        count: _count,
        source: this.source,
        lastUpdate: _lastUpdate,
        error: lastError(),
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale:
          _lastUpdate !== null &&
          (combinedCoverage()?.stale === true || readingsAreStale(_readings)),
      };
    },
  };
  return layer;
}

// Provider category labels are translated at presentation time.
msg('Good');
msg('Moderate');
msg('Unhealthy');
msg('Very Unhealthy');
msg('Hazardous');

/** Translate each scale in its own grammatical context, only when rendered. */
function bandLabel(label, context) {
  if (context === 'air quality risk') {
    switch (label) {
      case 'Low':
        return t('Low', { context: 'air quality risk' });
      case 'Moderate':
        return t('Moderate', { context: 'air quality risk' });
      case 'High':
        return t('High', { context: 'air quality risk' });
      case 'Very High':
        return t('Very High', { context: 'air quality risk' });
    }
  } else if (context === 'EEA hourly quality') {
    switch (label) {
      case 'Good':
        return t('Good', { context: 'EEA hourly quality' });
      case 'Fair':
        return t('Fair', { context: 'EEA hourly quality' });
      case 'Moderate':
        return t('Moderate', { context: 'EEA hourly quality' });
      case 'Poor':
        return t('Poor', { context: 'EEA hourly quality' });
      case 'Very poor':
        return t('Very poor', { context: 'EEA hourly quality' });
      case 'Extremely poor':
        return t('Extremely poor', { context: 'EEA hourly quality' });
    }
  } else if (context === 'SAAQIS category') {
    switch (label) {
      case 'Good':
        return t('Good', { context: 'SAAQIS category' });
      case 'Moderate':
        return t('Moderate', { context: 'SAAQIS category' });
      case 'Unhealthy':
        return t('Unhealthy', { context: 'SAAQIS category' });
      case 'Very Unhealthy':
        return t('Very Unhealthy', { context: 'SAAQIS category' });
      case 'Hazardous':
        return t('Hazardous', { context: 'SAAQIS category' });
    }
  }
  return t(label);
}
