import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { hitTestWorldOverlay } from '../overlays/worldOverlay.js';
import { governorRequestRender } from '../renderGovernor.js';
import { createDriftController } from '../sim/driftController.js';
import { loadLandSeaMask } from './landSeaMask.js';
import { maskStateAt, MASK_LAND, MASK_WATER } from './landSeaMaskCodec.js';
import { registerPickOwner, unregisterPickOwner, isOwnedByOtherLayer, resolvePickId } from './pickRegistry.js';

/**
 * Ocean Conditions — NOAA NDBC buoy observations + Open-Meteo Marine forecast.
 *
 * ~900 buoy/station points from the server-cached `/api/ocean/obs` bulk feed
 * (never per-station polling), color-banded by significant wave height.
 * Selecting a buoy (or clicking open water while nothing is selected) shows a
 * card of the station's OBSERVED values and appends Open-Meteo Marine
 * FORECAST lines when `/api/ocean/marine` resolves — observations and
 * forecasts are labeled distinctly and missing fields are omitted, never
 * rendered as placeholders. Point clicks are gated by the bundled land/sea
 * mask: land cells select nothing, water cells get their DRIFT chip before
 * the forecast probe, coastal cells keep the probe-then-chip fallback.
 *
 * Geometry values are STATIC (plain numbers redefined per poll) — a
 * CallbackProperty here would re-tessellate per frame for data that changes
 * every 10 minutes (see earthquakes.js for the measurement that set this
 * rule). No per-frame animator, so no continuous-render hold either.
 */

const OBS_URL = '/api/ocean/obs';
const MARINE_URL = '/api/ocean/marine';

export const OCEAN_OVERLAY_SOURCE_ID = 'ocean-conditions';
export const OCEAN_SELECTED_OVERLAY_SOURCE_ID = 'ocean-conditions-selected';
export const OCEAN_OVERLAY_COHORT_LIMIT = 12;
export const OCEAN_OVERLAY_COLLISION_CAPACITY = 24;
export const OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 0,
  moving: false,
});
export const OCEAN_ACTION_OVERLAY_SOURCE_ID = 'ocean-conditions-action';

const ENTITY_ID_PREFIX = 'ndbc:';
const ACCENT_CSS = '#4dd2ff';

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Wave-height color bands (significant wave height, meters):
 * <1 calm blue · 1–2.5 green · 2.5–4 yellow · 4–6 orange · >6 red;
 * stations without wave data render dim gray.
 * @param {?number} waveHeightM - Significant wave height, or null.
 * @returns {Cesium.Color}
 */
export function buoyColorForWaveHeight(waveHeightM) {
  if (!Number.isFinite(waveHeightM)) return Cesium.Color.SLATEGRAY;
  if (waveHeightM < 1) return Cesium.Color.DODGERBLUE;
  if (waveHeightM < 2.5) return Cesium.Color.MEDIUMSPRINGGREEN;
  if (waveHeightM < 4) return Cesium.Color.YELLOW;
  if (waveHeightM < 6) return Cesium.Color.ORANGE;
  return Cesium.Color.RED;
}

/** km/h → m/s, null-safe (Open-Meteo reports ocean current in km/h). */
export function kmhToMs(value) {
  return Number.isFinite(value) ? value / 3.6 : null;
}

/**
 * Index of the forecast hour closest to `nowMs`, -1 for an empty series.
 * @param {number[]} hoursMs - Epoch-ms forecast hours.
 * @param {number} nowMs - Reference time.
 * @returns {number}
 */
export function nearestForecastHourIndex(hoursMs, nowMs) {
  if (!Array.isArray(hoursMs) || hoursMs.length === 0) return -1;
  let best = 0;
  for (let i = 1; i < hoursMs.length; i += 1) {
    if (Math.abs(hoursMs[i] - nowMs) < Math.abs(hoursMs[best] - nowMs)) best = i;
  }
  return best;
}

/**
 * Card lines for one buoy's OBSERVED values. Sparse by design: a station
 * that reports only waves gets only wave lines — absent fields are omitted
 * entirely, never rendered as "null"/placeholder text.
 * @param {Object} record - Normalized `/api/ocean/obs` station record.
 * @returns {string[]} `[title, ...detail lines]`.
 */
export function formatBuoyCardLines(record) {
  const name = String(record?.name || '').trim();
  const lines = [name || `Buoy ${record?.stationId ?? '?'}`];

  if (Number.isFinite(record?.waveHeightM)) {
    let wave = `🌊 ${record.waveHeightM.toFixed(1)} m`;
    if (Number.isFinite(record?.dominantPeriodS)) wave += ` @ ${record.dominantPeriodS} s`;
    if (Number.isFinite(record?.waveDirDeg)) wave += ` from ${Math.round(record.waveDirDeg)}°`;
    lines.push(wave);
  }
  if (Number.isFinite(record?.windSpeedMs)) {
    let wind = `💨 ${record.windSpeedMs.toFixed(1)} m/s`;
    if (Number.isFinite(record?.gustMs)) wind += ` G ${record.gustMs.toFixed(1)}`;
    if (Number.isFinite(record?.windDirDeg)) wind += ` from ${Math.round(record.windDirDeg)}°`;
    lines.push(wind);
  }
  const temps = [];
  if (Number.isFinite(record?.sstC)) temps.push(`SST ${record.sstC.toFixed(1)}°C`);
  if (Number.isFinite(record?.airTempC)) temps.push(`Air ${record.airTempC.toFixed(1)}°C`);
  if (temps.length) lines.push(`🌡 ${temps.join(' · ')}`);
  if (Number.isFinite(record?.pressureHpa)) lines.push(`⏱ ${record.pressureHpa.toFixed(1)} hPa`);

  return lines;
}

/**
 * FORECAST lines from a `/api/ocean/marine` payload at the hour nearest
 * `nowMs`, each prefixed `FC` so observed and forecast values are never
 * conflated on one card. Returns [] when nothing usable is present — the
 * caller renders its own "no data" state.
 * @param {?Object} payload - `/api/ocean/marine` response body.
 * @param {number} nowMs - Reference time.
 * @returns {string[]}
 */
export function formatMarineForecastLines(payload, nowMs) {
  const lines = [];
  const at = (series, index) => (Array.isArray(series) && Number.isFinite(series[index]) ? series[index] : null);

  const marine = payload?.marine;
  const marineHours = forecastHoursToMs(marine?.time);
  const marineIdx = nearestForecastHourIndex(marineHours, nowMs);
  if (marineIdx !== -1) {
    const wave = at(marine.wave_height, marineIdx);
    const sst = at(marine.sea_surface_temperature, marineIdx);
    const sea = [];
    if (wave !== null) sea.push(`${wave.toFixed(1)} m`);
    if (sst !== null) sea.push(`SST ${sst.toFixed(1)}°C`);
    if (sea.length) lines.push(`🌊 FC ${sea.join(' · ')}`);

    const currentMs = kmhToMs(at(marine.ocean_current_velocity, marineIdx));
    const currentDir = at(marine.ocean_current_direction, marineIdx);
    if (currentMs !== null) {
      lines.push(`🌀 FC ${currentMs.toFixed(1)} m/s${currentDir !== null ? ` toward ${Math.round(currentDir)}°` : ''}`);
    }
  }

  const wind = payload?.wind;
  const windHours = forecastHoursToMs(wind?.time);
  const windIdx = nearestForecastHourIndex(windHours, nowMs);
  if (windIdx !== -1) {
    const speed = at(wind.wind_speed_10m, windIdx);
    const dir = at(wind.wind_direction_10m, windIdx);
    if (speed !== null) {
      lines.push(`💨 FC ${speed.toFixed(1)} m/s${dir !== null ? ` from ${Math.round(dir)}°` : ''}`);
    }
  }

  return lines;
}

/**
 * Ambient wave-height label for one station (only wave-reporting stations
 * earn ambient labels; the rest stay clickable points).
 * @param {object} input
 * @param {string} input.id Stable station id.
 * @param {Cesium.Cartesian3} input.position Sea-level anchor.
 * @param {number} input.waveHeightM Significant wave height.
 * @param {string} input.accent Wave-band color, CSS string.
 * @returns {object}
 */
export function createOceanOverlayEntry({ id, position, waveHeightM, accent }) {
  const wave = Number(waveHeightM);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `${wave.toFixed(1)} m`,
    accent,
    priority: Math.round(wave * 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the biggest seas, with stable identity as the tie-break. */
export function selectOceanOverlayCohort(entries, limit = OCEAN_OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(0, Math.min(OCEAN_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)));
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries.slice().sort((a, b) => (
    b.priority - a.priority || String(a.id).localeCompare(String(b.id))
  )).slice(0, cap);
}

/**
 * Protected selected-station card entry from source-owned copy.
 * @param {string} key Stable entity id (`ndbc:<station>` or point key).
 * @param {Object} input `{position, lines}` — lines[0] is the title.
 * @returns {Object|null}
 */
export function createOceanSelectedOverlayEntry(key, { position, lines } = {}) {
  if (!key || !position || !Array.isArray(lines) || lines.length === 0) return null;
  const [title, ...details] = lines;
  return {
    id: String(key),
    position,
    variant: 'selected',
    selected: true,
    protected: true,
    paintLane: 'selected',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    title,
    details,
    accent: ACCENT_CSS,
    interactive: false,
    anchorRadiusPx: 9,
    minAnchorGapPx: 11,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * Map one station's raw plain values to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined.
 * @param {Object|null|undefined} raw - Normalized obs record.
 * @param {number} [index=0] - Position in the snapshot (fallback id only).
 * @returns {Object}
 */
export function mapAnalystRecord(raw, index = 0) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => { const t = String(v ?? '').trim(); return t || null; };
  const stationId = text(raw?.stationId);
  return {
    id: stationId || `BUOY-${String(index).padStart(4, '0')}`,
    stationId: stationId || null,
    name: text(raw?.name),
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    timeMs: num(raw?.timeMs),
    waveHeightM: num(raw?.waveHeightM),
    wavePeriodS: num(raw?.dominantPeriodS),
    windSpeedMs: num(raw?.windSpeedMs),
    gustMs: num(raw?.gustMs),
    sstC: num(raw?.sstC),
    pressureHpa: num(raw?.pressureHpa),
  };
}

/** Open-Meteo hourly ISO strings (UTC, no zone suffix) → epoch ms, or null. */
function forecastHoursToMs(times) {
  if (!Array.isArray(times) || times.length === 0) return null;
  if (!times.every((t) => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t))) return null;
  const hoursMs = times.map((t) => Date.parse(`${t}:00Z`));
  return hoursMs.every(Number.isFinite) ? hoursMs : null;
}

export function createOceanConditionsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  driftControllerFactory = (options) => createDriftController(options),
  maskLoader = loadLandSeaMask,
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedEntity = null;
  let _highlightEntity = null;
  let _selectionToken = 0;
  let _driftController = null;
  let _mask = null;

  function ensureDriftController() {
    if (!_driftController) {
      _driftController = driftControllerFactory({ viewer: _viewer });
    }
    return _driftController;
  }

  function clearSelection() {
    _selectionToken += 1;
    if (_highlightEntity && _viewer) {
      _viewer.entities.remove(_highlightEntity);
    }
    _selectedEntity = null;
    _highlightEntity = null;
    overlayHost.clearSource(OCEAN_SELECTED_OVERLAY_SOURCE_ID);
    overlayHost.clearSource(OCEAN_ACTION_OVERLAY_SOURCE_ID);
    governorRequestRender('ocean-deselect');
  }

  /**
   * The DRIFT chip: a separate interactive overlay entry beside the selected
   * card (the selected source is cohortLimit:1, so the action gets its own
   * source). `activate` is both the mouse path (hit-tested in the click
   * handler) and the accessible-button path the overlay host mirrors.
   */
  function publishDriftChip(key, position, lat, lon) {
    overlayHost.setEntries(OCEAN_ACTION_OVERLAY_SOURCE_ID, [{
      id: `${key}:drift`,
      position,
      variant: 'label',
      title: '▶ DRIFT',
      accent: '#ffb14d',
      priority: Number.MAX_SAFE_INTEGER - 1,
      collisionGroup: 'ambient-card',
      paintLane: 'selected',
      protected: true,
      interactive: true,
      activate: () => {
        const controller = ensureDriftController();
        controller.start({ lat, lon, label: key }).then((result) => {
          if (!result?.ok) {
            overlayHost.setEntries(OCEAN_ACTION_OVERLAY_SOURCE_ID, [{
              id: `${key}:drift-unavailable`,
              position,
              variant: 'label',
              title: '⚠ DRIFT UNAVAILABLE',
              accent: '#ff6b5e',
              priority: Number.MAX_SAFE_INTEGER - 1,
              collisionGroup: 'ambient-card',
              paintLane: 'selected',
              protected: true,
              interactive: false,
              verticalOnly: true,
              placement: 'below',
              edgeFade: 'keyhole',
              horizonCull: true,
              terrainOcclusion: false,
              gapPx: 30,
            }], OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS);
            governorRequestRender('ocean-drift-unavailable');
          }
        });
        return true;
      },
      accessibilityLabel: 'Start drift simulation at this point',
      verticalOnly: true,
      placement: 'below',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 30,
    }], OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS);
  }

  function publishSelectionCard(key, position, lines) {
    const entry = createOceanSelectedOverlayEntry(key, { position, lines });
    if (entry) {
      overlayHost.setEntries(
        OCEAN_SELECTED_OVERLAY_SOURCE_ID,
        [entry],
        OCEAN_SELECTED_OVERLAY_SOURCE_OPTIONS,
      );
    }
    governorRequestRender('ocean-selection');
  }

  /**
   * Fetch the point forecast and, if this selection is still current,
   * republish the card with FC lines appended. A failed or empty forecast
   * leaves the observation card as-is.
   */
  async function appendForecast(key, position, baseLines, latitude, longitude) {
    const token = _selectionToken;
    try {
      const params = new URLSearchParams({
        latitude: latitude.toFixed(4),
        longitude: longitude.toFixed(4),
      });
      const response = await fetch(`${MARINE_URL}?${params}`);
      if (!response.ok || token !== _selectionToken) return;
      const payload = await response.json();
      if (token !== _selectionToken) return;
      const forecastLines = formatMarineForecastLines(payload, Date.now());
      if (forecastLines.length) {
        publishSelectionCard(key, position, [...baseLines, ...forecastLines]);
      }
    } catch {
      // Forecast is an enhancement — the observed card already stands.
    }
  }

  async function selectStation(entityId) {
    if (!_dataSource) return;
    const entity = _dataSource.entities.getById(entityId);
    if (!entity) return;
    clearSelection();
    _selectedEntity = entity;
    const token = _selectionToken;

    const now = Cesium.JulianDate.now();
    const position = entity.position?.getValue?.(now) ?? null;
    const record = entity.properties?.record?.getValue?.(now) ?? null;
    if (!position || !record) return;

    if (_viewer?.entities) {
      _highlightEntity = _viewer.entities.add({
        position,
        point: {
          pixelSize: 14,
          color: Cesium.Color.fromCssColorString(ACCENT_CSS),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
    const lines = formatBuoyCardLines(record);
    publishSelectionCard(entityId, position, lines);
    // A buoy is in the water by definition — the drift action is always valid.
    publishDriftChip(entityId, position, record.lat, record.lon);
    if (token !== _selectionToken) return;
    await appendForecast(entityId, position, lines, record.lat, record.lon);
  }

  /** Open-water click: a coordinate card that fills in with forecast lines. */
  async function selectOceanPoint(latitude, longitude, position) {
    // Land/sea mask gate. A land cell produces nothing at all — the click
    // handler's empty-space branch already cleared any active selection, so
    // this returns BEFORE clearSelection to leave every overlay source
    // untouched. Coastal cells and an unloaded mask keep the probe fallback.
    const maskState = _mask ? maskStateAt(_mask, latitude, longitude) : null;
    if (maskState === MASK_LAND) return;
    const maskSaysWater = maskState === MASK_WATER;
    clearSelection();
    const token = _selectionToken;
    const key = `ocean-point:${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    const title = `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'} ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
    const baseLines = [title];
    publishSelectionCard(key, position, [...baseLines, '⏳ fetching marine forecast…']);
    // A mask-confirmed water cell is the drift authority — the chip goes up
    // before (and independent of) the forecast probe.
    if (maskSaysWater) publishDriftChip(key, position, latitude, longitude);
    if (token !== _selectionToken) return;

    try {
      const params = new URLSearchParams({
        latitude: latitude.toFixed(4),
        longitude: longitude.toFixed(4),
      });
      const response = await fetch(`${MARINE_URL}?${params}`);
      if (token !== _selectionToken) return;
      const payload = response.ok ? await response.json() : null;
      if (token !== _selectionToken) return;
      const forecastLines = payload ? formatMarineForecastLines(payload, Date.now()) : [];
      if (forecastLines.length) {
        publishSelectionCard(key, position, [...baseLines, ...forecastLines]);
        // Marine data resolved → this point is water: offer the drift action
        // (mask-confirmed water already has it).
        if (!maskSaysWater) publishDriftChip(key, position, latitude, longitude);
      } else {
        // Probe fallback: no marine forecast means no drift. Mask-confirmed
        // water keeps its chip — only the card gains the NO MARINE DATA line;
        // the action source is never cleared here.
        publishSelectionCard(key, position, [...baseLines, 'NO MARINE DATA']);
      }
    } catch {
      if (token === _selectionToken) {
        publishSelectionCard(key, position, [...baseLines, 'NO MARINE DATA']);
      }
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') clearSelection();
  }

  function installClickHandler(viewer) {
    if (_clickHandler || !viewer?.scene?.canvas || typeof Cesium.ScreenSpaceEventHandler !== 'function') return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      // Painted DRIFT chip first — it sits above the scene (cctv.js idiom).
      const chipHit = hitTestWorldOverlay(click.position.x, click.position.y, {
        sourceId: OCEAN_ACTION_OVERLAY_SOURCE_ID,
      });
      if (chipHit?.entry?.activate) {
        chipHit.entry.activate();
        return;
      }
      const picked = viewer.scene.pick(click.position);
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && pickedId.startsWith(ENTITY_ID_PREFIX)) {
          selectStation(pickedId);
          return;
        }
        // A pick that belongs to another layer (or the base globe tileset)
        // is not ours to interpret — leave it alone.
        if (pickedId && isOwnedByOtherLayer('ocean-conditions', pickedId)) return;
        if (pickedId) return;
      }
      // Empty space: first click clears an active selection; with nothing
      // selected, drop an ocean-point forecast card at the clicked sea spot.
      if (_selectedEntity || _highlightEntity) {
        clearSelection();
        return;
      }
      const cartesian = viewer.camera?.pickEllipsoid?.(click.position, viewer.scene.globe?.ellipsoid);
      if (!cartesian) return;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      selectOceanPoint(Cesium.Math.toDegrees(carto.latitude), Cesium.Math.toDegrees(carto.longitude), cartesian);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKeyDown);
  }

  function destroyClickHandler() {
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
    if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeyDown);
  }

  const layer = {
    id: 'ocean-conditions',
    name: 'Ocean Conditions',
    icon: '🌊',
    source: 'NOAA NDBC · Open-Meteo Marine',
    updateInterval: 600000,

    init(viewer) {
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('ocean-conditions');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(OCEAN_OVERLAY_SOURCE_ID, false);
      console.log('[Data:OceanConditions] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(OCEAN_OVERLAY_SOURCE_ID, true);
      registerPickOwner('ocean-conditions', (pickedId) => (
        typeof pickedId === 'string' && pickedId.startsWith(ENTITY_ID_PREFIX)
      ));
      installClickHandler(viewer);
      // Kick the (memoized, retryable) mask load; click gating rides the
      // probe fallback until it lands, and a rejection is non-fatal.
      maskLoader().then((mask) => { _mask = mask; }).catch(() => {});
      governorRequestRender('ocean-visibility');
    },

    disable(viewer) {
      _enabled = false;
      clearSelection();
      _driftController?.dispose();
      unregisterPickOwner('ocean-conditions');
      destroyClickHandler();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(OCEAN_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OCEAN_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      try {
        const response = await fetch(OBS_URL);
        if (!response.ok) {
          _lastError = `Ocean obs HTTP ${response.status}`;
          console.warn(`[Data:OceanConditions] API returned ${response.status}`);
          return false;
        }
        const payload = await response.json();
        if (!payload || !Array.isArray(payload.stations)) {
          _lastError = 'Malformed ocean obs response';
          return false;
        }

        _dataSource.entities.removeAll();
        const overlayEntries = [];
        let count = 0;
        for (const station of payload.stations) {
          if (!Number.isFinite(station?.lat) || !Number.isFinite(station?.lon)) continue;
          count += 1;
          const position = Cesium.Cartesian3.fromDegrees(station.lon, station.lat);
          const color = buoyColorForWaveHeight(station.waveHeightM);
          const hasWaves = Number.isFinite(station.waveHeightM);
          _dataSource.entities.add({
            id: `${ENTITY_ID_PREFIX}${station.stationId}`,
            position,
            point: {
              // Static values, redefined per poll — never CallbackProperty.
              pixelSize: hasWaves ? 7 : 5,
              color: color.withAlpha(hasWaves ? 0.95 : 0.6),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
              outlineWidth: 1,
              disableDepthTestDistance: 2500,
            },
            properties: {
              record: station, // analyst + selection seam (plain JSON record)
            },
          });
          if (hasWaves) {
            overlayEntries.push(createOceanOverlayEntry({
              id: String(station.stationId),
              position,
              waveHeightM: station.waveHeightM,
              accent: color.toCssColorString(),
            }));
          }
        }

        if (_enabled) {
          overlayHost.setEntries(
            OCEAN_OVERLAY_SOURCE_ID,
            selectOceanOverlayCohort(overlayEntries),
            {
              cohortLimit: OCEAN_OVERLAY_COHORT_LIMIT,
              collisionCapacity: OCEAN_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        governorRequestRender('ocean-obs-update');
        console.log(`[Data:OceanConditions] Updated: ${_count} stations`);
        return true;
      } catch (e) {
        console.warn('[Data:OceanConditions] Fetch error:', e);
        _lastError = 'Ocean obs network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      clearSelection();
      _driftController?.dispose();
      _driftController = null;
      unregisterPickOwner('ocean-conditions');
      destroyClickHandler();
      overlayHost.clearSource(OCEAN_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(OCEAN_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _mask = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the layer's stations as plain JSON-safe records for the
     * analyst query engine. On-demand only — zero per-frame cost. Returns []
     * while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return.
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount) ? Math.max(1, Math.floor(maxCount)) : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const record = entity.properties?.record?.getValue?.(now) ?? null;
        result.push(mapAnalystRecord(record, result.length));
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },

    /** Test seams — drive the production selection paths without a DOM. */
    _selectForTest(entityId) {
      return selectStation(entityId);
    },
    _selectOceanPointForTest(latitude, longitude, position) {
      return selectOceanPoint(latitude, longitude, position);
    },
    _clearSelectionForTest() {
      clearSelection();
    },
  };
  return layer;
}

const oceanConditionsLayer = createOceanConditionsLayer();

export default oceanConditionsLayer;
