import * as Cesium from 'cesium';
import {
  presetDotOutline,
  presetDotRgba,
  presetSizeDelta,
} from '../../data/trafficPresetStyle.js';
import { renderedRoadHeight } from '../traffic/surface.js';
import { CITS_BRACKET_KINDS, createCitsBracketPainter } from './brackets.js';
import { createCitsPanel } from './panel.js';
import {
  CITS_BANDWIDTH_MODES,
  CITS_DOT_HEIGHT_OFFSET_M,
  CITS_HAZARD_PATH_MAX_ALTITUDE_M,
  CITS_LANE_MAX_ALTITUDE_M,
  CITS_DEFAULT_SETTINGS,
  citsKindGroup,
  citsMergeSettings,
  CITS_MAX_VIEW_ALTITUDE_M,
  CITS_MIN_RADIUS_M,
  CITS_PICK_PREFIX,
  CITS_BUCKET_CSS,
  citsBoundsAround,
  citsDetailRows,
  citsDotStyle,
  citsHazardBucket,
  citsIsVehicle,
  citsLaneStyle,
  citsObjectLabel,
} from './model.js';
export * from './model.js';
export { createCitsSource } from './source.js';

export const CITS_OVERLAY_SOURCE_ID = 'cits';
/** Tiled-mode query radius cap; the relay refuses covers coarser than z9. */
const TILED_MAX_RADIUS_M = 35_000;
const CITS_OVERLAY_COHORT_LIMIT = 80;
const CITS_OVERLAY_COLLISION_CAPACITY = 40;
const POLL_MS = 1500;
/** Street Traffic's jam heat-line widths and alphas. */
const HAZARD_JAM_WIDTH = 9;
const HAZARD_SLOW_WIDTH = 4;
const HAZARD_JAM_ALPHA = 0.55;
const HAZARD_SLOW_ALPHA = 0.35;
const HAZARD_PATH_CAP = 400;
const LANE_WIDTH = 3;
const RENDER_OWNER = 'cits';

const colorCache = new Map();
function color(css, alpha = 1) {
  const key = `${css}|${alpha}`;
  let value = colorCache.get(key);
  if (!value) {
    value = Cesium.Color.fromCssColorString(css).withAlpha(alpha);
    colorCache.set(key, value);
  }
  return value;
}

/**
 * Live C-ITS (V2X) stations: traffic lights with their signal phase painted
 * onto MAPEM lanes, roadside units, warning trailers, DENM hazard corridors,
 * and every broadcasting vehicle — drawn in Street Traffic's dot style.
 * Data: OpenTrafficMap volunteer receivers, via `/api/cits`.
 */
export function createCitsLayer({
  source,
  overlayHost = null,
  picking = null,
  render = null,
  screenSpaceEventHandlerFactory = null,
  overlayLanes = null,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (typeof source?.getState !== 'function')
    throw new TypeError('C-ITS requires a state source');
  let _viewer = null;
  let _points = null;
  let _lanePrimitive = null;
  let _laneIds = new Map();
  let _hazardPrimitives = [];
  let _hazardKey = '';
  let _enabled = false;
  let _request = null;
  let _clickHandler = null;
  let _card = null;
  let _selectedId = null;
  let _status = 'idle';
  let _lastUpdate = null;
  let _lastError = null;
  let _mapsVersion = null;
  let _intersections = [];
  let _mode = 'tiled';
  let _stylePreset =
    documentRef?.documentElement?.dataset?.gevStyle || 'normal';
  let _styleListener = null;
  let _removePreRender = null;
  const SETTINGS_KEY = 'gev.cits.settings.v1';
  let _settings = loadSettings();
  let _panel = null;
  let _groupCounts = {};
  let _overlayEntries = [];
  let _counts = {};
  let _upstream = null;
  let _bracketsOn = true;
  let _bracketLane = null;
  let _fullStreamAvailable = false;
  /** @type {Map<string, {point:Cesium.PointPrimitive, record:object, from:Cesium.Cartesian3, to:Cesium.Cartesian3, t0:number}>} */
  const _dots = new Map();
  const _heights = new Map();

  // Per-viewer convenience only; every read and write tolerates no storage.
  function loadSettings() {
    try {
      const raw = windowRef?.localStorage?.getItem(SETTINGS_KEY);
      if (raw) return citsMergeSettings(CITS_DEFAULT_SETTINGS, JSON.parse(raw));
    } catch {
      /* storage unavailable */
    }
    return citsMergeSettings(CITS_DEFAULT_SETTINGS);
  }

  function saveSettings() {
    try {
      windowRef?.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(_settings));
    } catch {
      /* storage unavailable */
    }
  }

  function applySettings(patch, { reset = false } = {}) {
    const previous = _settings;
    _settings = reset
      ? citsMergeSettings(CITS_DEFAULT_SETTINGS)
      : citsMergeSettings(_settings, patch);
    saveSettings();
    for (const dot of _dots.values()) {
      applyFade(dot.point, dot.record);
      applyDotStyle(dot.point, dot.record);
    }
    if (!_settings.lanes && _lanePrimitive) {
      removeLanes();
      _intersections = [];
    }
    if (_settings.lanes !== previous.lanes) _mapsVersion = null;
    const groupsChanged = Object.keys(_settings.groups).some(
      (id) => _settings.groups[id] !== previous.groups[id],
    );
    renderPanel();
    _bracketLane?.requestPaint();
    _viewer?.scene.requestRender();
    if (groupsChanged && _enabled && !_request) void refresh();
  }

  function renderPanel() {
    _panel?.render(_settings, {
      byGroup: _groupCounts,
      intersections: _intersections.length,
      mode: _mode,
      status: _status,
      upstream: _upstream,
    });
  }

  const ownsPick = (id) =>
    typeof id === 'string' && id.startsWith(CITS_PICK_PREFIX);

  // ─── Camera ──────────────────────────────────────────────────────────────
  function cameraAltitude() {
    return _viewer.camera.positionCartographic?.height ?? Infinity;
  }

  function viewCentre() {
    const scene = _viewer.scene;
    const centre = new Cesium.Cartesian2(
      scene.canvas.clientWidth / 2,
      scene.canvas.clientHeight / 2,
    );
    const hit = _viewer.camera.pickEllipsoid(centre, scene.globe.ellipsoid);
    const carto = hit
      ? Cesium.Cartographic.fromCartesian(hit)
      : _viewer.camera.positionCartographic;
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
    };
  }

  function nearBounds(height) {
    const { lon, lat } = viewCentre();
    const radius = Math.min(
      TILED_MAX_RADIUS_M,
      Math.max(CITS_MIN_RADIUS_M, height * 1.2),
    );
    return citsBoundsAround(lon, lat, radius);
  }

  /** The area to request: near box (tiled) or the whole view (full). */
  function requestBounds(height) {
    if (_mode !== 'full')
      return height > CITS_MAX_VIEW_ALTITUDE_M ? null : nearBounds(height);
    const rect = _viewer.camera.computeViewRectangle(
      _viewer.scene.globe.ellipsoid,
    );
    // A view across the antimeridian or off the globe: ask for everything.
    const world = { west: -180, south: -85, east: 180, north: 85 };
    if (!rect) return world;
    const box = {
      west: Cesium.Math.toDegrees(rect.west),
      south: Cesium.Math.toDegrees(rect.south),
      east: Cesium.Math.toDegrees(rect.east),
      north: Cesium.Math.toDegrees(rect.north),
    };
    return box.west >= box.east || box.south >= box.north ? world : box;
  }

  // ─── Heights (Street Traffic's rendered-surface sampling) ────────────────
  function groundHeight(lon, lat) {
    const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
    const cached = _heights.get(key);
    if (cached != null) return cached;
    const scene = _viewer.scene;
    const estimate =
      scene.globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat)) ?? 0;
    const rendered = renderedRoadHeight(scene, lon, lat, estimate);
    // Only depth-confirmed heights are final; estimates are retried later.
    if (rendered != null) {
      if (_heights.size > 20_000) _heights.clear();
      _heights.set(key, rendered);
    }
    return rendered ?? estimate;
  }

  function dotPosition(lon, lat) {
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      groundHeight(lon, lat) + CITS_DOT_HEIGHT_OFFSET_M,
    );
  }

  // ─── Dot styling (preset-aware, as Street Traffic) ───────────────────────
  function applyDotStyle(point, record) {
    const style = citsDotStyle(record);
    const rgba = style.bucket
      ? presetDotRgba(_stylePreset, style.bucket)
      : null;
    point.color = rgba
      ? new Cesium.Color(
          rgba[0] / 255,
          rgba[1] / 255,
          rgba[2] / 255,
          rgba[3] * (record.stale ? 0.35 : 1),
        )
      : color(style.css, style.alpha);
    point.pixelSize =
      (style.size +
        (style.bucket ? presetSizeDelta(_stylePreset, style.bucket) : 0)) *
      _settings.dotScale;
    const outline = style.bucket
      ? presetDotOutline(_stylePreset, style.bucket)
      : null;
    if (outline) {
      point.outlineColor = new Cesium.Color(
        outline.rgba[0] / 255,
        outline.rgba[1] / 255,
        outline.rgba[2] / 255,
        outline.rgba[3],
      );
      point.outlineWidth = outline.width;
    } else if (record.kind === 'hazard' || citsIsVehicle(record.kind)) {
      // Street Traffic's preset halo: a dark ring keeps vehicles readable
      // over lanes painted in the same palette.
      point.outlineColor = Cesium.Color.BLACK.withAlpha(0.85);
      point.outlineWidth = 2;
    } else {
      point.outlineWidth = 0;
    }
  }

  /**
   * Street Traffic's distance scale and fade, stretched to the panel's
   * visibility range: full size close by, shrinking toward the range, gone
   * past it. Vehicles keep the prominent-dot far scale (jam dots).
   */
  function applyFade(point, record) {
    const vehicle = citsIsVehicle(record?.kind) || record?.kind === 'hazard';
    const rangeM =
      (vehicle ? _settings.vehicleRangeKm : _settings.fixedRangeKm) * 1000;
    point.scaleByDistance = new Cesium.NearFarScalar(
      100,
      1.5,
      rangeM,
      vehicle ? 0.6 : 0.3,
    );
    point.translucencyByDistance = new Cesium.NearFarScalar(
      Math.min(rangeM * 0.7, Math.max(100, rangeM - 2000)),
      1.0,
      rangeM,
      0.0,
    );
  }

  function restyleAll() {
    for (const dot of _dots.values()) applyDotStyle(dot.point, dot.record);
    paintLanes();
    _viewer?.scene.requestRender();
  }

  // ─── Stations ────────────────────────────────────────────────────────────
  function renderDots(records, now) {
    const keep = new Set();
    _counts = {};
    for (const record of records) {
      const group = record.kind === 'hazard' ? 'hazard' : 'obj';
      const id = `${CITS_PICK_PREFIX}${group}:${record.id}`;
      keep.add(id);
      if (record.kind !== 'hazard')
        _counts[record.kind] = (_counts[record.kind] || 0) + 1;
      const target = dotPosition(record.lon, record.lat);
      let dot = _dots.get(id);
      if (!dot) {
        const point = _points.add({
          id,
          position: target,
          // Grounded like Street Traffic: buildings and terrain occlude.
          disableDepthTestDistance: 0,
        });
        applyFade(point, record);
        dot = { point, record, from: target, to: target, t0: now };
        _dots.set(id, dot);
      } else {
        // Glide from wherever the dot is now to the new report.
        dot.from = Cesium.Cartesian3.clone(dot.point.position);
        dot.to = target;
        dot.t0 = now;
        dot.record = record;
        if (!citsIsVehicle(record.kind)) dot.point.position = target;
      }
      applyDotStyle(dot.point, record);
    }
    for (const [id, dot] of _dots) {
      if (keep.has(id)) continue;
      _points.remove(dot.point);
      _dots.delete(id);
    }
  }

  const _scratch = new Cesium.Cartesian3();
  /**
   * Own brackets show unless switched off. While they do, bracketed kinds are
   * withheld from the global detect mode so no vehicle is boxed twice.
   */
  function bracketsShown() {
    return _enabled && _bracketsOn;
  }

  function installBrackets() {
    if (_bracketLane || typeof overlayLanes?.register !== 'function') return;
    const painter = createCitsBracketPainter({
      viewer: () => _viewer,
      dots: () => _dots.values(),
      style: () => _stylePreset,
      maxDistance: () => _settings.bracketRangeKm * 1000,
    });
    _bracketLane = overlayLanes.register('detection', painter, {
      id: 'cits-brackets',
      active: true,
      target: 'shared',
      shouldPaint: () => bracketsShown(),
    });
  }

  function removeBrackets() {
    _bracketLane?.unregister();
    _bracketLane = null;
  }

  function animate() {
    if (!_enabled || !_dots.size) return;
    // Brackets follow moving dots, so the lane repaints with the scene.
    if (bracketsShown()) _bracketLane?.requestPaint();
    const now = performance.now();
    for (const dot of _dots.values()) {
      if (dot.from === dot.to) continue;
      const t = Math.min(1, (now - dot.t0) / POLL_MS);
      // PointPrimitive's position setter clones, so a scratch is safe.
      dot.point.position = Cesium.Cartesian3.lerp(
        dot.from,
        dot.to,
        t,
        _scratch,
      );
      if (t >= 1) dot.from = dot.to;
    }
  }

  // ─── Hazard corridors (Street Traffic's heat-lines) ──────────────────────
  function removeHazardPaths() {
    for (const primitive of _hazardPrimitives)
      _viewer?.scene.groundPrimitives.remove(primitive);
    _hazardPrimitives = [];
    _hazardKey = '';
  }

  function hazardPrimitive(instances, css, alpha, glowPower) {
    return _viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        classificationType: Cesium.ClassificationType.BOTH,
        appearance: new Cesium.PolylineMaterialAppearance({
          material: Cesium.Material.fromType('PolylineGlow', {
            color: color(css, alpha),
            glowPower,
          }),
        }),
      }),
    );
  }

  function renderHazardPaths(hazards, altitude) {
    const visible = altitude <= CITS_HAZARD_PATH_MAX_ALTITUDE_M ? hazards : [];
    const key = visible.map((hazard) => hazard.id).join('|');
    if (key === _hazardKey) return;
    removeHazardPaths();
    _hazardKey = key;
    if (
      !visible.length ||
      !Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene)
    )
      return;
    const byBucket = { jam: [], slow: [] };
    let count = 0;
    for (const hazard of visible) {
      const bucket = citsHazardBucket(hazard.kind);
      for (const path of hazard.paths.slice(0, 2)) {
        if (count++ >= HAZARD_PATH_CAP) break;
        byBucket[bucket].push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(path.flat()),
              width: bucket === 'jam' ? HAZARD_JAM_WIDTH : HAZARD_SLOW_WIDTH,
            }),
          }),
        );
      }
    }
    if (byBucket.jam.length)
      _hazardPrimitives.push(
        hazardPrimitive(
          byBucket.jam,
          CITS_BUCKET_CSS.jam,
          HAZARD_JAM_ALPHA,
          0.25,
        ),
      );
    if (byBucket.slow.length)
      _hazardPrimitives.push(
        hazardPrimitive(
          byBucket.slow,
          CITS_BUCKET_CSS.slow,
          HAZARD_SLOW_ALPHA,
          0.2,
        ),
      );
  }

  // ─── Intersection lanes (per-instance colours, repainted per phase) ──────
  function removeLanes() {
    if (_lanePrimitive) _viewer?.scene.groundPrimitives.remove(_lanePrimitive);
    _lanePrimitive = null;
    _laneIds = new Map();
  }

  function buildLanes(intersections) {
    removeLanes();
    _intersections = intersections;
    if (
      !intersections.length ||
      !Cesium.GroundPolylinePrimitive.isSupported(_viewer.scene)
    )
      return;
    const instances = [];
    for (const intersection of intersections) {
      for (const lane of intersection.lanes) {
        const id = `${CITS_PICK_PREFIX}lane:${intersection.id}:${lane.id}`;
        const style = citsLaneStyle(lane, null);
        instances.push(
          new Cesium.GeometryInstance({
            id,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(
                lane.coordinates.flat(),
              ),
              width: LANE_WIDTH,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                color(style.css, style.alpha),
              ),
            },
          }),
        );
        _laneIds.set(id, { intersection: intersection.id, lane, key: null });
      }
    }
    _lanePrimitive = _viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        classificationType: Cesium.ClassificationType.BOTH,
        appearance: new Cesium.PolylineColorAppearance(),
      }),
    );
  }

  function paintLanes() {
    if (!_lanePrimitive?.ready) return;
    const phases = new Map();
    for (const [id, entry] of _laneIds) {
      if (!phases.has(entry.intersection)) {
        const spat = _dots.get(`${CITS_PICK_PREFIX}obj:${entry.intersection}`)
          ?.record?.spat;
        phases.set(
          entry.intersection,
          Array.isArray(spat)
            ? new Map(spat.map((group) => [group.group, group.state]))
            : null,
        );
      }
      const style = citsLaneStyle(entry.lane, phases.get(entry.intersection));
      const key = `${style.css}|${style.alpha}`;
      if (key === entry.key) continue;
      const attributes = _lanePrimitive.getGeometryInstanceAttributes(id);
      if (!attributes) continue;
      attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
        color(style.css, style.alpha),
        attributes.color,
      );
      entry.key = key;
    }
  }

  // ─── Labels (world-overlay host) ─────────────────────────────────────────
  function overlayEntry(id, lon, lat, title, { accent, priority }) {
    return {
      id,
      position: dotPosition(lon, lat),
      variant: 'label',
      title,
      accent,
      priority,
      collisionGroup: 'ambient-label',
      paintLane: 'ambient-label',
      interactive: false,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 12,
      verticalOnly: true,
      placement: 'above',
    };
  }

  function publishLabels(records) {
    if (!overlayHost) return;
    _overlayEntries = [];
    const camera = _viewer.camera.positionWC;
    const labelRange = _settings.labelRangeKm * 1000;
    const bracketRange = _settings.bracketRangeKm * 1000;
    {
      for (const record of records) {
        const group = record.kind === 'hazard' ? 'hazard' : 'obj';
        const dot = _dots.get(`${CITS_PICK_PREFIX}${group}:${record.id}`);
        if (!dot) continue;
        const distance = Cesium.Cartesian3.distance(camera, dot.point.position);
        if (distance > labelRange) continue;
        const title =
          record.kind === 'hazard'
            ? `⚠ ${record.name}${record.speedLimit ? ` · ${record.speedLimit} km/h` : ''}`
            : citsObjectLabel(record);
        if (!title) continue;
        // Bracketed vehicles carry their identity on the callout card; past
        // the bracket range they fall back to the plain label.
        if (
          bracketsShown() &&
          CITS_BRACKET_KINDS.has(record.kind) &&
          distance <= bracketRange
        )
          continue;
        _overlayEntries.push(
          overlayEntry(
            `${record.kind}:${record.id}`,
            record.lon,
            record.lat,
            title,
            {
              accent: citsDotStyle(record).css,
              priority: record.kind === 'hazard' ? 3000 : 2000,
            },
          ),
        );
      }
      _overlayEntries.sort((a, b) => b.priority - a.priority);
    }
    overlayHost.setEntries(
      CITS_OVERLAY_SOURCE_ID,
      _overlayEntries.slice(0, CITS_OVERLAY_COHORT_LIMIT),
      {
        cohortLimit: CITS_OVERLAY_COHORT_LIMIT,
        collisionCapacity: CITS_OVERLAY_COLLISION_CAPACITY,
        moving: true,
      },
    );
  }

  // ─── Selection card ──────────────────────────────────────────────────────
  function renderCard() {
    if (!_card) return;
    const record = _selectedId ? _dots.get(_selectedId)?.record : null;
    if (!record) {
      _card.hidden = true;
      return;
    }
    _card.replaceChildren();
    const title = documentRef.createElement('div');
    title.textContent = 'C-ITS · OpenTrafficMap';
    title.style.cssText =
      'font-weight:600;margin-bottom:6px;letter-spacing:.04em;opacity:.8';
    _card.append(title);
    for (const [key, value] of citsDetailRows(record)) {
      const row = documentRef.createElement('div');
      const k = documentRef.createElement('span');
      k.textContent = `${key}: `;
      k.style.opacity = '0.7';
      const v = documentRef.createElement('span');
      v.textContent = String(value);
      row.append(k, v);
      _card.append(row);
    }
    _card.hidden = false;
  }

  function installInteraction() {
    if (!screenSpaceEventHandlerFactory || !documentRef || _clickHandler)
      return;
    _card = documentRef.createElement('div');
    _card.className = 'cits-card';
    _card.hidden = true;
    _card.style.cssText =
      'position:absolute;right:16px;bottom:96px;z-index:30;max-width:320px;' +
      'padding:10px 12px;border-radius:8px;background:rgba(10,12,16,.88);' +
      'color:#e9ecef;font:12px/1.5 system-ui,sans-serif;' +
      'border:1px solid rgba(255,255,255,.15);pointer-events:none';
    _viewer.container.append(_card);
    picking?.registerPickOwner(layer.id, ownsPick);
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled) return;
      const picked = _viewer.scene.pick(click.position);
      const pickId = picking
        ? picking.resolvePickId(picked)
        : (picked?.id ?? null);
      // Anonymous vehicles are dots only: no card, no identity.
      if (
        typeof pickId === 'string' &&
        _dots.has(pickId) &&
        !_dots.get(pickId).record.anonymous
      ) {
        _selectedId = pickId;
      } else if (
        typeof pickId === 'string' &&
        pickId.startsWith(`${CITS_PICK_PREFIX}lane:`)
      ) {
        const intersection = _laneIds.get(pickId)?.intersection;
        _selectedId = `${CITS_PICK_PREFIX}obj:${intersection}`;
      } else {
        _selectedId = null;
      }
      renderCard();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeInteraction() {
    _clickHandler?.destroy();
    _clickHandler = null;
    picking?.unregisterPickOwner(layer.id);
    _card?.remove();
    _card = null;
    _selectedId = null;
  }

  function clearScene() {
    _points?.removeAll();
    _dots.clear();
    removeLanes();
    removeHazardPaths();
    _intersections = [];
    _overlayEntries = [];
    overlayHost?.clearSource(CITS_OVERLAY_SOURCE_ID);
    _counts = {};
    _mapsVersion = null;
  }

  async function refresh() {
    const altitude = cameraAltitude();
    const bounds = requestBounds(altitude);
    if (!bounds) {
      _status = 'zoom-in';
      clearScene();
      return true;
    }
    const request = new AbortController();
    _request = request;
    try {
      const state = await source.getState(bounds, {
        signal: request.signal,
        mode: _mode,
      });
      if (request.signal.aborted || !_enabled) return false;
      _status = state.status || 'live';
      _upstream = state.upstream || null;
      if (typeof state.fullStream === 'boolean')
        _fullStreamAvailable = state.fullStream;
      const allHazards = Array.isArray(state.hazards) ? state.hazards : [];
      const hazards = _settings.groups.hazard ? allHazards : [];
      const received = [
        ...(Array.isArray(state.objects) ? state.objects : []),
        ...allHazards
          .filter((hazard) => Array.isArray(hazard.position))
          .map((hazard) => ({
            id: hazard.id,
            kind: 'hazard',
            hazardKind: hazard.kind,
            name: hazard.label || hazard.kind || 'Hazard',
            speedLimit: hazard.speedLimit,
            lon: hazard.position[0],
            lat: hazard.position[1],
          })),
      ];
      _groupCounts = {};
      for (const record of received) {
        const id = citsKindGroup(record.kind);
        _groupCounts[id] = (_groupCounts[id] || 0) + 1;
      }
      const records = received.filter(
        (record) => _settings.groups[citsKindGroup(record.kind)] !== false,
      );
      renderDots(records, performance.now());
      renderHazardPaths(hazards, altitude);
      if (altitude > CITS_LANE_MAX_ALTITUDE_M || !_settings.lanes) {
        if (_lanePrimitive) removeLanes();
        _intersections = [];
        _mapsVersion = null;
      } else if (
        state.status === 'live' &&
        state.mapsVersion !== _mapsVersion &&
        typeof source.getIntersections === 'function'
      ) {
        const maps = await source.getIntersections(nearBounds(altitude), {
          signal: request.signal,
          mode: _mode,
        });
        if (request.signal.aborted || !_enabled) return false;
        _mapsVersion = maps.mapsVersion;
        buildLanes(Array.isArray(maps.intersections) ? maps.intersections : []);
      }
      paintLanes();
      publishLabels(records);
      renderCard();
      renderPanel();
      _lastUpdate = Date.now();
      _lastError = null;
      _viewer.scene.requestRender();
      return true;
    } catch (error) {
      if (request.signal.aborted || !_enabled) return false;
      if (_mode === 'full' && /HTTP 403/.test(error?.message || '')) {
        // The operator has not opted into the full stream.
        _fullStreamAvailable = false;
        _mode = 'tiled';
        return false;
      }
      console.warn('[Data:C-ITS] Fetch error:', error);
      _lastError = error?.message || 'C-ITS relay unavailable';
      return false;
    } finally {
      if (_request === request) _request = null;
    }
  }

  const layer = {
    id: 'cits',
    name: 'C-ITS Live (V2X)',
    icon: '🚦',
    source: 'OpenTrafficMap',
    updateInterval: POLL_MS,

    init(viewer) {
      if (_viewer) throw new Error('C-ITS layer is already initialized');
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      _points.show = false;
      viewer.scene.primitives.add(_points);
      if (windowRef?.addEventListener) {
        _styleListener = (event) => {
          const next = event?.detail?.style || 'normal';
          if (next === _stylePreset) return;
          _stylePreset = next;
          restyleAll();
        };
        windowRef.addEventListener('gev:style-change', _styleListener);
      }
    },

    enable() {
      _enabled = true;
      _status = 'loading';
      if (_points) _points.show = true;
      overlayHost?.setVisible(CITS_OVERLAY_SOURCE_ID, true);
      _removePreRender = _viewer.scene.preRender.addEventListener(animate);
      render?.holdContinuousRender?.(RENDER_OWNER);
      installInteraction();
      installBrackets();
      _panel ||= createCitsPanel({
        documentRef,
        onChange: (patch) => applySettings(patch),
        onReset: () => applySettings({}, { reset: true }),
      });
      _panel.show();
      renderPanel();
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      _removePreRender?.();
      _removePreRender = null;
      render?.releaseContinuousRender?.(RENDER_OWNER);
      removeInteraction();
      removeBrackets();
      _panel?.hide();
      clearScene();
      if (_points) _points.show = false;
      overlayHost?.setVisible(CITS_OVERLAY_SOURCE_ID, false);
      _status = 'idle';
      _viewer?.scene.requestRender();
    },

    async update() {
      if (!_enabled || !_points) return false;
      // A slow full-stream response is not cut short by the next tick.
      if (_request) return false;
      return refresh();
    },

    destroy(viewer = _viewer) {
      layer.disable();
      if (_styleListener)
        windowRef?.removeEventListener('gev:style-change', _styleListener);
      _styleListener = null;
      if (_points) {
        viewer?.scene.primitives.remove(_points);
        _points = null;
      }
      _viewer = null;
    },

    getParams() {
      return { bandwidth: _mode, brackets: _bracketsOn, settings: _settings };
    },

    setParams(params = {}) {
      if (params.settings && typeof params.settings === 'object')
        applySettings(params.settings);
      if (typeof params.brackets === 'boolean') {
        _bracketsOn = params.brackets;
        _bracketLane?.requestPaint();
        _viewer?.scene.requestRender();
      }
      const next = params.bandwidth;
      if (!CITS_BANDWIDTH_MODES.includes(next) || next === _mode) return true;
      _mode = next;
      _request?.abort();
      _request = null;
      clearScene();
      _status = 'loading';
      if (_enabled) void refresh();
      return true;
    },

    /**
     * Row chips: brackets, plus the bandwidth choice when the server operator
     * has opted into the full stream (`CITS_OTM_FULL_STREAM=1`).
     */
    getRowControls() {
      const bandwidth = _fullStreamAvailable
        ? [
            {
              id: 'bandwidth-tiled',
              label: 'Tiled',
              title:
                'Only the map tiles around the view (/ws_tiled, ~100 KB/s)',
              active: _mode === 'tiled',
              params: { bandwidth: 'tiled' },
            },
            {
              id: 'bandwidth-full',
              label: 'High bandwidth',
              title:
                'Every station OpenTrafficMap hears, at any zoom (/ws_ext, ~1 MB/s compressed)',
              active: _mode === 'full',
              params: { bandwidth: 'full' },
            },
          ]
        : [];
      return {
        chips: [
          ...bandwidth,
          {
            id: 'brackets',
            label: 'Brackets',
            title: 'Detection brackets and info cards on trams',
            active: _bracketsOn,
            params: { brackets: !_bracketsOn },
          },
        ],
      };
    },

    /** Vehicle positions for the detection overlay, as Street Traffic. */
    getDetectableObjects({ maxCount = Infinity } = {}) {
      const result = [];
      for (const [id, dot] of _dots) {
        if (result.length >= maxCount) break;
        if (!citsIsVehicle(dot.record.kind) || dot.record.anonymous) continue;
        if (bracketsShown() && CITS_BRACKET_KINDS.has(dot.record.kind))
          continue;
        result.push({ position: dot.point.position, id, type: 'V2X' });
      }
      return result;
    },

    /** Plain records for the analyst query engine. */
    getAnalystRecords(maxCount = 2000) {
      const records = [];
      for (const dot of _dots.values()) {
        if (records.length >= maxCount) break;
        const { kind, lon, lat, speedKmh } = dot.record;
        records.push(
          dot.record.anonymous
            ? { kind, lon, lat, speedKmh, anonymous: true }
            : { ...dot.record, spat: undefined },
        );
      }
      return records;
    },

    getStats() {
      const count = Object.values(_counts).reduce((a, b) => a + b, 0);
      return {
        count,
        byKind: { ..._counts },
        byGroup: { ..._groupCounts },
        settings: _settings,
        mode: _mode,
        brackets: _bracketsOn,
        fullStream: _fullStreamAvailable,
        intersections: _intersections.length,
        status: _status,
        loading: _status === 'loading' || _status === 'connecting',
        lastUpdate: _lastUpdate,
        upstream: _upstream,
        error:
          _lastError ||
          (_status === 'zoom-in' ? 'Zoom in to load C-ITS stations' : null),
      };
    },
  };
  return layer;
}
