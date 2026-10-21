import * as Cesium from 'cesium';
import { keyRequirementText } from '../../ui/keyGuidance.js';
import { ECCC_DEFINITION } from './providers.js';
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

/** Own one air-quality display, its refresh lifecycle, and its readout card. */
export function createAirQualityLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Air quality requires a snapshot source');
  if (!overlayHost) throw new TypeError('Air quality requires an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _readings = [];
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let rowControlsListener = null;
  const definitions = source.definitions ?? [ECCC_DEFINITION];
  const providers = new Map(definitions.map((entry) => [entry.id, entry]));
  let providerId = definitions[0].id;
  const definition = () => providers.get(providerId);
  const observation = () => definition().observation === true;
  let parameter = definitions[0].parameters[0] || 'PM2.5';
  let coverage = null;
  let overlayEntries = [];
  let removeMoveEnd = null;
  let moveTimer = null;
  let loading = false;
  let requestedView = null;

  const notify = () => rowControlsListener?.();

  /** The camera's lon/lat rectangle in degrees, or null when unresolvable. */
  const viewRectangle = () => {
    const rectangle = _viewer?.camera?.computeViewRectangle?.();
    if (!rectangle) return null;
    const toDeg = Cesium.Math.toDegrees;
    return {
      west: toDeg(rectangle.west),
      south: toDeg(rectangle.south),
      east: toDeg(rectangle.east),
      north: toDeg(rectangle.north),
    };
  };

  const currentView = () => {
    const rect = viewRectangle();
    if (!rect) return null;
    const width = (rect.east - rect.west + 360) % 360 || 360;
    const lon = ((rect.west + width / 2 + 540) % 360) - 180;
    const canvas = _viewer?.scene?.canvas;
    const focus =
      canvas &&
      _viewer.camera.pickEllipsoid?.(
        new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
        _viewer.scene.globe?.ellipsoid,
      );
    const center = focus ? Cesium.Cartographic.fromCartesian(focus) : null;
    const values = [
      rect.west,
      rect.south,
      rect.east,
      rect.north,
      center ? Cesium.Math.toDegrees(center.longitude) : lon,
      center
        ? Cesium.Math.toDegrees(center.latitude)
        : (rect.south + rect.north) / 2,
    ];
    const rounded = values.map((v) => Number(v.toFixed(4)));
    return rounded[0] === rounded[2] || rounded[1] >= rounded[3]
      ? values
      : rounded;
  };

  const layer = {
    id: 'air-quality',
    name: 'Air quality',
    icon: '◍',
    source: definition().sourceLabel || definition().network,
    updateInterval: 60_000,

    init(viewer) {
      if (_viewer) throw new Error('Air quality layer is already initialized');
      _viewer = viewer;
      removeMoveEnd = viewer.camera?.moveEnd?.addEventListener(() => {
        if (_enabled) {
          this._publishOverlays();
          if (
            definition().viewDriven &&
            JSON.stringify(currentView()) !== requestedView
          ) {
            _request?.abort();
            _request = null;
            loading = true;
            coverage = null;
            _lastError = null;
            clearTimeout(moveTimer);
            moveTimer = setTimeout(() => {
              moveTimer = null;
              void this.update();
            }, 400);
          }
          notify();
        }
      });
      _dataSource = new Cesium.CustomDataSource('air-quality');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, true);
      notify();
    },

    disable() {
      // Abort in flight: a response arriving after disable must not redraw.
      _request?.abort();
      _request = null;
      clearTimeout(moveTimer);
      moveTimer = null;
      loading = false;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      notify();
    },

    getParams() {
      return { provider: providerId, parameter };
    },

    setParams(params = {}) {
      if (params.provider && !providers.has(params.provider)) return false;
      const nextProvider = params.provider || providerId;
      const supported = providers.get(nextProvider).parameters;
      const nextParameter = supported.includes(params.parameter)
        ? params.parameter
        : supported.includes(parameter) || !supported.length
          ? parameter
          : supported[0];
      if (nextProvider === providerId && nextParameter === parameter) return;
      _request?.abort();
      _request = null;
      clearTimeout(moveTimer);
      moveTimer = null;
      loading = false;
      requestedView = null;
      providerId = nextProvider;
      parameter = nextParameter;
      this.source = definition().sourceLabel || definition().network;
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      coverage = null;
      this._render();
      notify();
      if (_enabled) void this.update();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      clearTimeout(moveTimer);
      moveTimer = null;
      const view = definition().viewDriven ? currentView() : null;
      requestedView = JSON.stringify(view);
      loading = true;
      _lastError = null;
      notify();
      try {
        const readings = await source.getSnapshot({
          signal: request.signal,
          provider: providerId,
          parameter,
          ...(view ? { view } : {}),
        });
        // A superseded or aborted request must not touch the scene, and neither
        // must one that lands after the layer was switched off.
        if (request.signal.aborted || _request !== request || !_enabled)
          // A newer view owns acquisition. This is not a failed layer enable:
          // the lifecycle manager must keep the layer and its refresh loop on.
          return _enabled;
        _readings = readings;
        coverage = source.getCoverage?.() ?? null;
        this._render();
        _count = _readings.length;
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return _enabled;
        _lastError =
          (error?.code === 'no_key'
            ? keyRequirementText(definition().requiresKeyId)
            : '') ||
          error?.message ||
          msg('Air quality request failed');
        console.warn('[Data:AirQuality] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) {
          _request = null;
          loading = false;
          notify();
        }
      }
    },

    /** Rebuild entities and overlay labels from the current readings. */
    _render() {
      if (!_dataSource) return;
      _dataSource.entities.removeAll();
      overlayEntries = [];
      for (const reading of _readings) {
        const position = Cesium.Cartesian3.fromDegrees(
          reading.lon,
          reading.lat,
        );
        const color = Cesium.Color.fromCssColorString(reading.color);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `air-quality:${reading.id}`,
            position,
            ...(observation()
              ? {
                  point: {
                    pixelSize: 8,
                    color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 1,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  },
                }
              : {
                  ellipse: {
                    // Static axes, as in the earthquake layer: a per-frame axis
                    // re-tessellates the clamped ground primitive every frame.
                    semiMajorAxis: STATION_MARKER_RADIUS_M,
                    semiMinorAxis: STATION_MARKER_RADIUS_M,
                    material: new Cesium.ColorMaterialProperty(
                      color.withAlpha(0.35),
                    ),
                    outline: true,
                    outlineColor: color.withAlpha(0.9),
                    outlineWidth: 2,
                    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                  },
                }),
            properties: {
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
          }),
        );
        overlayEntries.push(
          createAirQualityOverlayEntry({
            id: reading.id,
            position,
            title: `${reading.name} ${reading.label}`,
            accent: reading.color,
            value: observation() ? 0 : reading.value,
          }),
        );
      }
      this._publishOverlays();
    },

    _publishOverlays() {
      const visibleIds = observation()
        ? new Set(
            readingsInView(_readings, viewRectangle(), _readings.length).map(
              (row) => row.id,
            ),
          )
        : null;
      if (_enabled) {
        overlayHost.setEntries(
          AIR_QUALITY_OVERLAY_SOURCE_ID,
          selectAirQualityOverlayCohort(
            observation()
              ? overlayEntries.filter((entry) => visibleIds.has(entry.id))
              : overlayEntries,
          ),
          {
            cohortLimit: AIR_QUALITY_OVERLAY_COHORT_LIMIT,
            collisionCapacity: AIR_QUALITY_OVERLAY_COLLISION_CAPACITY,
            moving: false,
          },
        );
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      clearTimeout(moveTimer);
      moveTimer = null;
      loading = false;
      _enabled = false;
      overlayHost.clearSource(AIR_QUALITY_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(AIR_QUALITY_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer?.dataSources?.remove(_dataSource, true);
        _dataSource = null;
      }
      removeMoveEnd?.();
      removeMoveEnd = null;
      _viewer = null;
      overlayEntries = [];
      _readings = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
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
      const isObservation = observation();
      const provider = {
        ...definition(),
        scale: isObservation ? parameter : definition().scale,
      };
      const visible = readingsInView(
        _readings,
        viewRectangle(),
        _readings.length,
      );
      const inView = (
        isObservation
          ? visible.sort((a, b) => a.name.localeCompare(b.name))
          : visible
      ).slice(0, READOUT_LIMIT);
      const newest = _readings.reduce(
        (max, reading) => Math.max(max, reading.observedMs || 0),
        0,
      );
      // Readings and errors stay English data (analyst records, stats); the
      // card translates them as the Layers panel row does. A provider's own
      // error text has no catalog entry and shows as it came.
      return {
        readout: true,
        summary: {
          label: t(provider.label),
          coverage: t(provider.coverage),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: `${provider.network} · ${provider.scale}`,
          status: loading
            ? t('Loading observations for this view…')
            : _lastError
              ? translateFeedError(_lastError)
              : coverage?.failureStatus === 429
                ? t(
                    'Provider request budget reached. Cached data will refresh later.',
                  )
                : coverage?.stale
                  ? t('Air quality provider unavailable')
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
          units: provider.scale,
          settings: [
            {
              id: 'provider',
              label: t('Network'),
              chips: definitions.map((entry) => ({
                id: entry.id,
                label: t(entry.title),
                active: entry.id === providerId,
                params: { provider: entry.id },
              })),
            },
            ...(isObservation
              ? [
                  {
                    id: 'pollutant',
                    label: t('Pollutant'),
                    chips: provider.parameters.map((id) => ({
                      id,
                      label: id,
                      active: parameter === id,
                      params: { parameter: id },
                    })),
                  },
                ]
              : []),
          ],
          ...(isObservation
            ? {
                lines: [
                  {
                    id: 'coverage',
                    text: t(provider.coverageNote || provider.coverage),
                  },
                  {
                    id: 'counts',
                    text: t(
                      '{catalog} catalog stations · {reporting} reporting · {visible} in view',
                      {
                        catalog: coverage?.stations?.length ?? 0,
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
                        ? t(provider.interpretation || '')
                        : _lastError || coverage?.stale
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
                  ...(coverage?.stale
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
        legend: (provider.legend || []).map((band) => ({
          color: band.color,
          label: `${t(band.label)}${band.range ? ` ${band.range}` : ''}`,
        })),
        legendCategorical: true,
        list: {
          ariaLabel: isObservation
            ? t('Observations in view')
            : t('Highest air-quality readings in view'),
          items: inView.map((reading, index) => ({
            id: reading.id,
            ordinal: index + 1,
            lead: `${reading.scale} ${reading.label}`,
            ...(isObservation
              ? {
                  badge: reading.rating
                    ? `${t(reading.rating.label)} · ${reading.rating.score}/10`
                    : t('Index unavailable'),
                  badgeColor: reading.color,
                }
              : {}),
            text: isObservation
              ? `${reading.name} · ${reading.zone} · ${reading.owner || provider.network} · ${t(provider.averagingLabel || 'Source averaging period unspecified')} · ${new Date(reading.observedMs).toISOString()} · ${reading.rating ? t(provider.indexLabel || 'Index unavailable') : t('Index unavailable')} · ${t('Provisional data')} · ${reading.network || provider.network} · ${(reading.licenses || []).map((item) => item.attribution || item.name).join(', ')}`
              : `${reading.name} · ${t(reading.risk)}`,
            accent: reading.color,
          })),
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
        error: _lastError,
        observedAt: newestObservation(_readings),
        // Only a completed refresh can be stale; before one there is no feed.
        stale:
          _lastUpdate !== null &&
          (coverage?.stale === true || readingsAreStale(_readings)),
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
