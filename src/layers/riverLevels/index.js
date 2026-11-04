import * as Cesium from 'cesium';
import { msg, t, tn } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  PULSING_BANDS,
  RIVER_LEVEL_BANDS,
  compareSeverity,
  formatLevel,
  mapAnalystRecord,
  newestObservation,
  readingIsLate,
  riverBandById,
  stageFraction,
  stationsInView,
  STALE_AFTER_MS,
  trendDirection,
} from './model.js';
import {
  RIVER_LEVELS_CARD_SOURCE_ID,
  RIVER_LEVELS_LABEL_COHORT_LIMIT,
  RIVER_LEVELS_LABEL_COLLISION_CAPACITY,
  RIVER_LEVELS_OVERLAY_SOURCE_ID,
  buildRiverLevelCard,
  buildRiverLevelLabel,
  selectRiverLabelCohort,
  trendGlyph,
} from './cards.js';
import {
  createRiverWaterwaySource,
  riverStretches,
  riverTilePlan,
} from './rivers.js';
import {
  RIVER_ALERT_LIMIT,
  alertLevelsFor,
  browserAlertStorage,
  createRiverAlerts,
  requestAlertPermission,
  showBrowserAlert,
} from './alerts.js';
export * from './model.js';
export * from './cards.js';
export { createRiverLevelsSource, normalizeRiverStation } from './source.js';

const PICK_PREFIX = 'river-levels:';
/** Columns appear below this camera height, for the nearest gauges only. */
const COLUMN_MAX_CAMERA_HEIGHT_M = 150_000;
const COLUMN_MAX_DISTANCE_M = 400_000;
const COLUMN_LIMIT = 60;
/** A column at fraction 1 (the record high) is this tall: a slender glass. */
const COLUMN_FULL_HEIGHT_M = 1_600;
const COLUMN_RADIUS_M = 110;
const MARK_THICKNESS_M = 14;
const SURFACE_THICKNESS_M = 10;
/**
 * The gauge's own references drawn on the glass, like the marks on a gauge
 * board: white at the mean, then the colours of the bands they open.
 */
const COLUMN_MARKS = Object.freeze([
  ['mean', null],
  ['watch', 'watch'],
  ['warning', 'warning'],
  ['flood', 'flood'],
  ['recordHigh', 'major'],
]);
/** River lines, drawn on the ground in the colour of their gauge. */
const RIVER_LINE_WIDTH_PX = 4;
/** Above this height, dots keep this much screen space between them. */
const DECLUTTER_MIN_HEIGHT_M = 60_000;
const DECLUTTER_SPACING_PX = 16;
/** Gauges without references appear only in a regional view. */
const GREY_MAX_HEIGHT_M = 400_000;
/** [camera height below which, labels allowed]; none higher up. */
const LABEL_BUDGET = Object.freeze([
  [150_000, RIVER_LEVELS_LABEL_COHORT_LIMIT],
  [600_000, 12],
  [2_500_000, 6],
]);
/** Pulses mark water over the flood line; a fixed few, never per gauge. */
const PULSE_LIMIT = 24;
const PULSE_PERIOD_MS = 2_400;
const READOUT_LIMIT = 5;
const DOT_PX = 22;
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Relative luminance of a #rrggbb colour (0 dark … 1 light). */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const spriteCache = new Map();

/**
 * A gauge dot in its band colour with the trend drawn inside: one canvas per
 * band and trend (8 × 4), shared by every gauge.
 */
function dotSprite(bandId, trend) {
  const key = `dot:${bandId}:${trend || 'none'}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const band = riverBandById(bandId);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(24, 24, 18, 0, Math.PI * 2);
  ctx.fillStyle = band.color;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(8, 12, 18, 0.9)';
  ctx.stroke();
  ctx.fillStyle = luminance(band.color) > 0.5 ? '#0b0f14' : '#ffffff';
  ctx.beginPath();
  if (trend === 'rising') {
    ctx.moveTo(24, 11);
    ctx.lineTo(34, 29);
    ctx.lineTo(14, 29);
  } else if (trend === 'falling') {
    ctx.moveTo(24, 37);
    ctx.lineTo(34, 19);
    ctx.lineTo(14, 19);
  } else if (trend === 'steady') {
    ctx.rect(13, 21, 22, 6);
  }
  ctx.closePath();
  ctx.fill();
  spriteCache.set(key, canvas);
  return canvas;
}

/** The expanding ring drawn behind gauges over the flood line. */
function pulseSprite(bandId) {
  const key = `pulse:${bandId}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 27, 0, Math.PI * 2);
  ctx.lineWidth = 5;
  ctx.strokeStyle = riverBandById(bandId).color;
  ctx.stroke();
  spriteCache.set(key, canvas);
  return canvas;
}

/** Station id from a pick id (`river-levels:<station id>[:part]`). */
function stationIdFromPick(pickId) {
  if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
    return null;
  return pickId
    .slice(PICK_PREFIX.length)
    .replace(/:(tube|water|surface|base|mark-[a-zA-Z]+)$/, '');
}

/**
 * Own one river-level display: gauge dots, labels, the 3D columns of the
 * nearest gauges, pulses over the flood line, the selected gauge's card and
 * the Weather-panel readout.
 */
export function createRiverLevelsLayer({
  source,
  overlayHost,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  // OpenFreeMap river lines; false turns them off, null builds the default.
  waterways = null,
  // Where gauge alerts persist; null keeps them for this page only.
  alertStorage = browserAlertStorage(),
  // The browser's Notification API; null keeps alerts in the page.
  notificationApi = globalThis.Notification ?? null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('River levels requires a snapshot source');
  if (!overlayHost)
    throw new TypeError('River levels requires an overlay host');

  let _viewer = null;
  let _request = null;
  let _seriesRequest = null;
  let _dots = null;
  let _pulses = null;
  let _columns = null;
  let _columnSignature = '';
  let _waterways = waterways;
  let _rivers = null;
  let _riverRequest = null;
  let _riverTileKey = '';
  let _riverLines = [];
  let _riverSignature = '';
  let _stations = [];
  /** @type {Map<string, object>} */
  const _byId = new Map();
  /** @type {Map<string, Cesium.Cartesian3>} */
  const _positions = new Map();
  let _providers = {};
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _series = null;
  let _seriesFor = null;
  let _removePreRender = null;
  let _removeMoveEnd = null;
  let _lastCullCamera = null;
  /** Station ids whose dots give way to a more severe neighbour on screen. */
  const _thinned = new Set();
  const _alerts = createRiverAlerts({ storage: alertStorage });
  // The shell's page toast, attached once the UI is up.
  let _showToast = null;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();
  const canSelect = () => Boolean(screenSpaceEventHandlerFactory && picking);

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

  // ── Selection card ────────────────────────────────────────────────────

  function publishCard() {
    const station = _selectedId ? _byId.get(_selectedId) : null;
    if (!station) {
      _selectedId = null;
      _selectedCardId = null;
      overlayHost.setEntries(
        RIVER_LEVELS_CARD_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = {
      ...buildRiverLevelCard(
        station,
        _seriesFor === station.id ? _series : null,
        Date.now(),
        _alerts.get(station.id)?.level ?? null,
      ),
      position: _positions.get(station.id),
    };
    _selectedCardId = card.id;
    overlayHost.setEntries(
      RIVER_LEVELS_CARD_SOURCE_ID,
      [card],
      CARD_HOST_OPTIONS,
    );
  }

  function select(stationId) {
    _selectedId = stationId;
    if (_seriesFor !== stationId) {
      _series = null;
      _seriesFor = null;
    }
    publishCard();
    // The Weather panel offers the selected gauge's alert levels.
    notify();
    if (typeof source.getStationSeries !== 'function') return;
    _seriesRequest?.abort();
    const request = new AbortController();
    _seriesRequest = request;
    source
      .getStationSeries(stationId, { signal: request.signal })
      .then((series) => {
        if (request.signal.aborted || _selectedId !== stationId) return;
        _series = series;
        _seriesFor = stationId;
        publishCard();
      })
      .catch(() => {
        if (request.signal.aborted || _selectedId !== stationId) return;
        // The card says the history is missing rather than loading forever.
        _series = { points: [], partial: true };
        _seriesFor = stationId;
        publishCard();
      });
  }

  function clearSelection() {
    _seriesRequest?.abort();
    _seriesRequest = null;
    _selectedId = null;
    _selectedCardId = null;
    _series = null;
    _seriesFor = null;
    overlayHost.clearSource(RIVER_LEVELS_CARD_SOURCE_ID);
    notify();
  }

  // ── Gauge alerts ──────────────────────────────────────────────────────

  const alertLabel = (level) => t(riverBandById(level).label);
  const toast = (text) => _showToast?.(text);

  /** Set or drop the alert of a gauge, from the viewer's click. */
  function setAlert(stationId, level) {
    const station = _byId.get(stationId);
    if (!station) return;
    const result = _alerts.set(station, level);
    if (!result) {
      toast(t('Up to {count} gauge alerts', { count: RIVER_ALERT_LIMIT }));
    } else if (!level) {
      toast(t('Alert off · {name}', { name: station.name }));
    } else {
      // Still inside the click, where browsers allow the question.
      requestAlertPermission(notificationApi);
      toast(
        result.reached
          ? t('{name} is already at {level}', {
              name: station.name,
              level: alertLabel(level),
            })
          : t('Alert set · {name} · {level}', {
              name: station.name,
              level: alertLabel(level),
            }),
      );
    }
    if (_selectedId === stationId) publishCard();
    notify();
  }

  function clearAlerts() {
    _alerts.clear();
    toast(t('All gauge alerts off'));
    if (_selectedId) publishCard();
    notify();
  }

  /**
   * Tell the viewer about the gauges that reached their level this refresh:
   * a system notification when allowed, the page toast, and a line that stays
   * in the Weather panel while the level holds.
   */
  function announceAlerts() {
    for (const { station } of _alerts.check(_stations)) {
      const title = t('River alert · {name}', { name: station.name });
      const body = [
        t(riverBandById(station.band).label),
        formatLevel(station.level),
        station.river,
      ]
        .filter(Boolean)
        .join(' · ');
      toast(`${title} · ${body}`);
      showBrowserAlert(
        { title, body, tag: `river-level-alert:${station.id}` },
        notificationApi,
      );
    }
  }

  /** The Weather-panel part of the readout that sets and lists alerts. */
  function alertControls() {
    const selected = _selectedId ? _byId.get(_selectedId) : null;
    const levels = selected ? alertLevelsFor(selected) : [];
    const watch = selected ? _alerts.get(selected.id) : null;
    const watched = _alerts.list();
    const settings = levels.length
      ? [
          {
            id: 'alert',
            // The label column is narrow; the gauge is named in a line above.
            label: t('Alert'),
            chips: [
              {
                id: 'off',
                label: t('Off'),
                active: !watch,
                onClick: () => setAlert(selected.id, null),
              },
              ...levels.map((level) => ({
                id: level,
                label: alertLabel(level),
                color: riverBandById(level).color,
                active: watch?.level === level,
                title: t('Checked every 10 minutes while the app is open'),
                onClick: () => setAlert(selected.id, level),
              })),
            ],
          },
        ]
      : [];
    const lines = [];
    if (levels.length)
      lines.push({
        id: 'alert-gauge',
        text: t('Alert me · {name}', { name: selected.name }),
      });
    else if (selected)
      lines.push({
        id: 'alert-hint',
        text: t('{name} publishes no levels to alert on', {
          name: selected.name,
        }),
        muted: true,
      });
    else if (!selected && !watched.length)
      lines.push({
        id: 'alert-hint',
        text: t('Click a gauge to set a level alert'),
        muted: true,
      });
    const reached = watched.filter((item) => item.reached);
    if (reached.length)
      lines.push({
        id: 'alerts-reached',
        text: t('Reached: {list}', {
          list: reached
            .map((item) => `${item.name} (${alertLabel(item.level)})`)
            .join(', '),
        }),
      });
    if (watched.length)
      lines.push({
        id: 'alerts',
        muted: true,
        text: t('Alerts on: {list}', {
          list: watched
            .map((item) => `${item.name} (${alertLabel(item.level)})`)
            .join(', '),
        }),
      });
    const actions = watched.length
      ? [
          {
            id: 'clear-alerts',
            label: t('Turn off all alerts'),
            onClick: clearAlerts,
          },
        ]
      : [];
    return { settings, lines, actions };
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    picking.registerPickOwner?.(layer.id, (pickId) =>
      String(pickId).startsWith(PICK_PREFIX),
    );
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        {
          sourceId: RIVER_LEVELS_CARD_SOURCE_ID,
        },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) return;
      const picked = _viewer.scene.pick(click.position);
      const pickId = picked ? picking.resolvePickId(picked) : null;
      const stationId = stationIdFromPick(pickId);
      if (stationId && _byId.has(stationId)) {
        select(stationId);
        return;
      }
      if (pickId && picking.isOwnedByOtherLayer(layer.id, pickId)) return;
      if (_selectedId) clearSelection();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    picking?.unregisterPickOwner?.(layer.id);
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  // ── Scene ─────────────────────────────────────────────────────────────

  /** Hide dots on the far side of the globe; runs only when the camera moved. */
  function cullHorizon(force = false) {
    if (!_dots || !_viewer) return;
    const camera = _viewer.camera.positionWC;
    if (
      !force &&
      _lastCullCamera &&
      Cesium.Cartesian3.equalsEpsilon(camera, _lastCullCamera, 0, 1)
    )
      return;
    _lastCullCamera = Cesium.Cartesian3.clone(camera, _lastCullCamera);
    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      camera,
    );
    for (let i = 0; i < _dots.length; i++) {
      const dot = _dots.get(i);
      dot.show =
        !_thinned.has(_stations[i]?.id) &&
        occluder.isPointVisible(dot.position);
    }
    for (let i = 0; i < (_pulses?.length ?? 0); i++) {
      const pulse = _pulses.get(i);
      pulse.show = occluder.isPointVisible(pulse.position);
    }
  }

  function animatePulses() {
    if (!_pulses?.length) return;
    const phase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    for (let i = 0; i < _pulses.length; i++) {
      const pulse = _pulses.get(i);
      pulse.scale = 0.7 + 1.5 * phase;
      pulse.color = Cesium.Color.WHITE.withAlpha(0.85 * (1 - phase));
    }
  }

  function onPreRender() {
    cullHorizon();
    animatePulses();
  }

  function renderDots() {
    _dots.removeAll();
    _pulses.removeAll();
    _positions.clear();
    const scale = new Cesium.NearFarScalar(1.5e5, 1, 4e6, 0.55);
    for (const station of _stations) {
      const position = Cesium.Cartesian3.fromDegrees(station.lon, station.lat);
      _positions.set(station.id, position);
      _dots.add({
        id: `${PICK_PREFIX}${station.id}`,
        position,
        image: dotSprite(station.band, trendDirection(station.trend)),
        width: DOT_PX,
        height: DOT_PX,
        scaleByDistance: scale,
        color: Cesium.Color.WHITE.withAlpha(readingIsLate(station) ? 0.45 : 1),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      });
    }
    const flooding = _stations
      .filter((s) => PULSING_BANDS.has(s.band) && !readingIsLate(s))
      .sort(compareSeverity)
      .slice(0, PULSE_LIMIT);
    for (const station of flooding) {
      _pulses.add({
        position: _positions.get(station.id),
        image: pulseSprite(station.band),
        width: DOT_PX * 2,
        height: DOT_PX * 2,
        scaleByDistance: scale,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    cullHorizon(true);
  }

  /**
   * From afar, keep one dot per patch of screen — the most severe, so a flood
   * or a record low is never the one hidden — and drop the grey gauges that
   * have no references. Close up, every gauge shows. Runs on camera stops.
   */
  function declutterDots() {
    if (!_dots || !_viewer) return;
    _thinned.clear();
    const height = _viewer.camera.positionCartographic?.height ?? Infinity;
    if (height >= DECLUTTER_MIN_HEIGHT_M) {
      const scene = _viewer.scene;
      const grid = new Map();
      const spacing = DECLUTTER_SPACING_PX;
      const order = _stations
        .slice()
        .sort(
          (a, b) =>
            (b.id === _selectedId) - (a.id === _selectedId) ||
            compareSeverity(a, b),
        );
      const at = new Cesium.Cartesian2();
      for (const station of order) {
        if (station.band === 'unknown' && height >= GREY_MAX_HEIGHT_M) {
          _thinned.add(station.id);
          continue;
        }
        const position = _positions.get(station.id);
        if (
          !position ||
          !Cesium.SceneTransforms.worldToWindowCoordinates(scene, position, at)
        )
          continue;
        const gx = Math.floor(at.x / spacing);
        const gy = Math.floor(at.y / spacing);
        let crowded = false;
        for (let dx = -1; dx <= 1 && !crowded; dx++)
          for (let dy = -1; dy <= 1 && !crowded; dy++)
            crowded = (grid.get(`${gx + dx},${gy + dy}`) || []).some(
              ([x, y]) => Math.hypot(x - at.x, y - at.y) < spacing,
            );
        if (crowded) {
          _thinned.add(station.id);
          continue;
        }
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push([at.x, at.y]);
      }
    }
    cullHorizon(true);
  }

  /** Fewer labels the higher the camera, so a country view stays legible. */
  function labelBudget() {
    const height = _viewer?.camera.positionCartographic?.height ?? Infinity;
    for (const [maxHeight, count] of LABEL_BUDGET)
      if (height < maxHeight) return count;
    return 0;
  }

  function renderLabels() {
    if (!_enabled) return;
    const budget = labelBudget();
    const entries = [];
    for (const station of budget ? _stations : []) {
      if (station.band === 'unknown' || _thinned.has(station.id)) continue;
      entries.push({
        ...buildRiverLevelLabel(station),
        position: _positions.get(station.id),
      });
    }
    overlayHost.setEntries(
      RIVER_LEVELS_OVERLAY_SOURCE_ID,
      selectRiverLabelCohort(entries, budget),
      {
        cohortLimit: Math.max(1, budget),
        collisionCapacity: RIVER_LEVELS_LABEL_COLLISION_CAPACITY,
        moving: false,
      },
    );
  }

  /**
   * The nearest gauges with references get a water column: a glass tube to
   * the record high, the water at its stage height in the band colour, and
   * the gauge's own reference marks on the glass. Rebuilt only when the chosen set or a
   * reading changes, never per frame.
   */
  function refreshColumns() {
    if (!_columns || !_viewer) return;
    let chosen = [];
    const height = _viewer.camera.positionCartographic?.height ?? Infinity;
    if (_enabled && height < COLUMN_MAX_CAMERA_HEIGHT_M) {
      const camera = _viewer.camera.positionWC;
      const limit = COLUMN_MAX_DISTANCE_M ** 2;
      chosen = _stations
        .map((station) => ({
          station,
          fraction: stageFraction(station.level, station.refs),
          distance: Cesium.Cartesian3.distanceSquared(
            camera,
            _positions.get(station.id),
          ),
        }))
        .filter((c) => c.fraction !== null && c.distance < limit)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, COLUMN_LIMIT);
    }
    const signature = chosen
      .map((c) => `${c.station.id}@${c.station.observedMs}`)
      .join('|');
    if (signature === _columnSignature) return;
    _columnSignature = signature;
    const entities = _columns.entities;
    entities.suspendEvents();
    entities.removeAll();
    const relative = Cesium.HeightReference.RELATIVE_TO_GROUND;
    for (const { station, fraction } of chosen) {
      const band = riverBandById(station.band);
      const late = readingIsLate(station);
      const colour = Cesium.Color.fromCssColorString(band.color);
      const water = Math.max(
        SURFACE_THICKNESS_M * 2,
        fraction * COLUMN_FULL_HEIGHT_M,
      );
      // With RELATIVE_TO_GROUND, Cesium lifts a cylinder by half its length
      // itself (Entity.computeModelMatrixForHeightReference), so a position's
      // height is where the cylinder's bottom sits above the ground.
      const at = (bottom) =>
        Cesium.Cartesian3.fromDegrees(station.lon, station.lat, bottom);
      const disc = (part, bottom, length, radius, material, extra = {}) =>
        entities.add({
          id: `${PICK_PREFIX}${station.id}:${part}`,
          position: at(bottom),
          cylinder: {
            length,
            topRadius: radius,
            bottomRadius: radius,
            material,
            heightReference: relative,
            ...extra,
          },
        });
      // A dark footing ties the glass to the ground it stands on.
      disc(
        'base',
        0,
        6,
        COLUMN_RADIUS_M * 1.8,
        Cesium.Color.BLACK.withAlpha(0.35),
      );
      // The glass: barely tinted, with its rims drawn so it reads as a tube.
      disc(
        'tube',
        0,
        COLUMN_FULL_HEIGHT_M,
        COLUMN_RADIUS_M,
        Cesium.Color.WHITE.withAlpha(0.08),
        {
          outline: true,
          outlineColor: Cesium.Color.WHITE.withAlpha(0.55),
          numberOfVerticalLines: 4,
        },
      );
      disc(
        'water',
        0,
        water,
        COLUMN_RADIUS_M * 0.9,
        colour.withAlpha(late ? 0.35 : 0.8),
      );
      // A brighter skin marks where the water stands.
      disc(
        'surface',
        water - SURFACE_THICKNESS_M,
        SURFACE_THICKNESS_M,
        COLUMN_RADIUS_M * 0.9,
        Cesium.Color.lerp(
          colour,
          Cesium.Color.WHITE,
          0.55,
          new Cesium.Color(),
        ).withAlpha(late ? 0.4 : 0.95),
      );
      for (const [key, markBand] of COLUMN_MARKS) {
        const value = station.refs?.[key];
        if (!Number.isFinite(value)) continue;
        const markFraction = stageFraction(value, station.refs);
        if (markFraction === null) continue;
        disc(
          `mark-${key}`,
          markFraction * COLUMN_FULL_HEIGHT_M - MARK_THICKNESS_M / 2,
          MARK_THICKNESS_M,
          COLUMN_RADIUS_M * 1.35,
          (markBand
            ? Cesium.Color.fromCssColorString(riverBandById(markBand).color)
            : Cesium.Color.WHITE
          ).withAlpha(0.85),
        );
      }
    }
    entities.resumeEvents();
  }

  /** The camera's view in degrees, or null over the antimeridian or sky. */
  function viewDegrees() {
    const rect = _viewer.camera.computeViewRectangle(
      _viewer.scene.globe.ellipsoid,
    );
    if (!rect) return null;
    const deg = Cesium.Math.toDegrees;
    const view = {
      west: deg(rect.west),
      south: deg(rect.south),
      east: deg(rect.east),
      north: deg(rect.north),
    };
    return view.east > view.west ? view : null;
  }

  function clearRivers() {
    _riverRequest?.abort();
    _riverRequest = null;
    _riverTileKey = '';
    _riverLines = [];
    removeRivers();
  }

  function removeRivers() {
    const scene = _viewer?.scene;
    if (_rivers && scene && !scene.isDestroyed?.())
      scene.groundPrimitives.remove(_rivers);
    _rivers = null;
    _riverSignature = '';
  }

  /**
   * Load the river tiles around the referenced gauges in view (detailed
   * when close, generalized from afar), then colour them. Runs on camera
   * stops and new readings, never per frame.
   */
  function refreshRivers() {
    if (!_viewer || _waterways === false) return;
    const height = _viewer.camera.positionCartographic?.height ?? Infinity;
    const view = _enabled ? viewDegrees() : null;
    const plan = view ? riverTilePlan(_stations, view, height) : null;
    const zoom = plan?.zoom;
    const tiles = plan?.tiles ?? [];
    const key = tiles.map(({ z, x, y }) => `${z}/${x}/${y}`).join(',');
    if (key === _riverTileKey) {
      drawRivers();
      return;
    }
    _riverTileKey = key;
    _riverRequest?.abort();
    _riverRequest = null;
    if (!tiles.length) {
      _riverLines = [];
      drawRivers();
      return;
    }
    _waterways ??= createRiverWaterwaySource();
    const request = new AbortController();
    _riverRequest = request;
    _waterways
      .fetchBounds(view, { zoom, tiles, signal: request.signal })
      .then((result) => {
        if (_riverRequest !== request) return;
        _riverLines = result.tiles.flat();
        drawRivers();
      })
      .catch((error) => {
        if (request.signal.aborted || _riverRequest !== request) return;
        // The lines are an aid; the gauges stand without them. The next
        // camera stop asks again.
        _riverTileKey = '';
        console.warn(
          '[Data:RiverLevels] River lines unavailable:',
          error?.message,
        );
      })
      .finally(() => {
        if (_riverRequest === request) _riverRequest = null;
      });
  }

  /** One ground primitive for every coloured stretch; rebuilt on change only. */
  function drawRivers() {
    if (!_viewer) return;
    const stretches = _enabled
      ? riverStretches(_riverLines, _stations).filter(({ coords }) =>
          coords.some(
            ([lon, lat]) => lon !== coords[0][0] || lat !== coords[0][1],
          ),
        )
      : [];
    const late = (id) => {
      const station = _byId.get(id);
      return station ? readingIsLate(station) : false;
    };
    const signature =
      _riverTileKey +
      '#' +
      stretches
        .map(
          (s) =>
            `${s.stationId}:${s.band}:${late(s.stationId) ? 1 : 0}:${s.coords.length}`,
        )
        .join('|');
    if (signature === _riverSignature) return;
    removeRivers();
    _riverSignature = signature;
    if (
      !stretches.length ||
      !Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene)
    )
      return;
    const instances = stretches.map(
      (stretch) =>
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: Cesium.Cartesian3.fromDegreesArray(
              stretch.coords.flat(),
            ),
            width: RIVER_LINE_WIDTH_PX,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString(
                riverBandById(stretch.band).color,
              ).withAlpha(late(stretch.stationId) ? 0.45 : 0.9),
            ),
          },
        }),
    );
    _rivers = _viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        allowPicking: false,
        asynchronous: true,
      }),
    );
  }

  function onMoveEnd() {
    declutterDots();
    renderLabels();
    refreshColumns();
    refreshRivers();
    // The readout lists the worst gauges in view, so a pan changes it.
    notify();
  }

  function render() {
    if (!_dots) return;
    renderDots();
    declutterDots();
    renderLabels();
    _columnSignature = '';
    refreshColumns();
    refreshRivers();
    if (_selectedId) publishCard();
  }

  function detachSceneListeners() {
    _removePreRender?.();
    _removePreRender = null;
    _removeMoveEnd?.();
    _removeMoveEnd = null;
  }

  function attachSceneListeners() {
    if (!_viewer || _removePreRender) return;
    _removePreRender = _viewer.scene.preRender.addEventListener(onPreRender);
    _removeMoveEnd = _viewer.camera.moveEnd.addEventListener(onMoveEnd);
  }

  const layer = {
    id: 'river-levels',
    name: 'River levels',
    icon: '≈',
    source: 'PEGELONLINE · WRA',
    updateInterval: 600_000,

    init(viewer) {
      if (_viewer) throw new Error('River levels layer is already initialized');
      _viewer = viewer;
      _dots = new Cesium.BillboardCollection({ scene: viewer.scene });
      _pulses = new Cesium.BillboardCollection({ scene: viewer.scene });
      _dots.show = _pulses.show = false;
      viewer.scene.primitives.add(_pulses);
      viewer.scene.primitives.add(_dots);
      _columns = new Cesium.CustomDataSource('river-levels-columns');
      _columns.show = false;
      viewer.dataSources.add(_columns);
      _stations = [];
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(RIVER_LEVELS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(RIVER_LEVELS_CARD_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dots) _dots.show = _pulses.show = _columns.show = true;
      overlayHost.setVisible(RIVER_LEVELS_OVERLAY_SOURCE_ID, true);
      overlayHost.setVisible(RIVER_LEVELS_CARD_SOURCE_ID, true);
      attachSceneListeners();
      installClickHandler();
      if (_stations.length) render();
      notify();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dots) _dots.show = _pulses.show = _columns.show = false;
      clearRivers();
      detachSceneListeners();
      removeClickHandler();
      clearSelection();
      overlayHost.clearSource(RIVER_LEVELS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RIVER_LEVELS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(RIVER_LEVELS_CARD_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!_enabled || !_dots) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot =
          typeof source.getSnapshotDetail === 'function'
            ? await source.getSnapshotDetail({ signal: request.signal })
            : {
                stations: await source.getSnapshot({ signal: request.signal }),
              };
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _stations = snapshot.stations;
        _providers = snapshot.providers || {};
        _byId.clear();
        for (const station of _stations) _byId.set(station.id, station);
        render();
        announceAlerts();
        _lastUpdate = Date.now();
        _lastError = null;
        notify();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request) return false;
        _lastError = error?.message || msg('River levels request failed');
        console.warn('[Data:RiverLevels] Refresh failed:', _lastError);
        notify();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      clearRivers();
      detachSceneListeners();
      removeClickHandler();
      clearSelection();
      overlayHost.clearSource(RIVER_LEVELS_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(RIVER_LEVELS_OVERLAY_SOURCE_ID, false);
      overlayHost.setVisible(RIVER_LEVELS_CARD_SOURCE_ID, false);
      const scene = viewer?.scene;
      if (scene && !scene.isDestroyed?.()) {
        if (_dots) scene.primitives.remove(_dots);
        if (_pulses) scene.primitives.remove(_pulses);
      }
      if (_columns) viewer?.dataSources?.remove(_columns, true);
      _dots = _pulses = _columns = null;
      _viewer = null;
      _stations = [];
      _byId.clear();
      _positions.clear();
      _columnSignature = '';
      _lastCullCamera = null;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /** Weather-panel readout: the band legend and the worst gauges in view. */
    getRowControls() {
      const inView = stationsInView(_stations, viewRectangle(), READOUT_LIMIT);
      const newest = newestObservation(_stations);
      const missing = Object.entries(_providers)
        .filter(([, p]) => p && p.available === false)
        .map(([id]) => id);
      const alerts = alertControls();
      return {
        readout: true,
        summary: {
          ...alerts,
          label: t('River levels'),
          coverage: t('Germany and Taiwan · official gauges'),
          validTime: newest ? new Date(newest).toISOString() : undefined,
          detail: 'PEGELONLINE (WSV) · WRA',
          status: _lastError
            ? translateFeedError(_lastError)
            : _stations.length === 0
              ? _lastUpdate === null
                ? t('No readings available')
                : t('No current readings')
              : missing.length
                ? t('{count} gauges · {network} unavailable', {
                    count: _stations.length,
                    network: missing.join(', '),
                  })
                : tn(
                    _stations.length,
                    '{count} gauge reporting',
                    '{count} gauges reporting',
                  ),
          units: 'm',
        },
        legend: RIVER_LEVEL_BANDS.map((band) => ({
          color: band.color,
          label: t(band.label),
        })),
        legendCategorical: true,
        list: {
          ariaLabel: t('Most severe river gauges in view'),
          items: inView.map((station, index) => {
            const glyph = trendGlyph(station.trend);
            return {
              id: station.id,
              ordinal: index + 1,
              lead: `${formatLevel(station.level)}${glyph ? ` ${glyph}` : ''}`,
              text: `${station.name} · ${t(riverBandById(station.band).label)}`,
              accent: riverBandById(station.band).color,
            };
          }),
        },
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    /** The shell's page toast, through which gauge alerts speak. */
    attachShellServices(services) {
      _showToast =
        typeof services?.showToast === 'function' ? services.showToast : null;
    },

    getAnalystRecords(maxCount = 500) {
      if (!_enabled || !_stations.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return _stations
        .slice()
        .sort(compareSeverity)
        .slice(0, limit)
        .map(mapAnalystRecord);
    },

    getStats() {
      const observedAt = newestObservation(_stations);
      return {
        count: _stations.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        observedAt,
        stale:
          _lastUpdate !== null &&
          (observedAt === null || Date.now() - observedAt > STALE_AFTER_MS),
      };
    },
  };
  return layer;
}
