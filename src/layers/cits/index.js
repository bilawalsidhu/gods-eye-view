import {
  presetDotOutline,
  presetDotRgba,
  presetSizeDelta,
} from '../../data/trafficPresetStyle.js';
import { t } from '../../i18n/index.js';
import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { clone, distance as distance3, lerpInto } from '../../geo/vector.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findFrame,
  findQuery,
  frameOf,
} from '../../render/rendererOf.js';
import { loadedSurfaceHeight, renderedRoadHeight } from '../traffic/surface.js';
import { CITS_BRACKET_KINDS, createCitsBracketPainter } from './brackets.js';
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
  CITS_KIND_GROUPS,
  CITS_RANGE_SETTINGS,
  CITS_SELECTED_OVERLAY_SOURCE_ID,
  CITS_UNKNOWN_CSS,
  buildCitsSelectedCard,
  citsBoundsAround,
  citsFormatRange,
  citsNextRangeStep,
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
/** The selected card is a one-entry source of its own, as in perimeters. */
const SELECTED_CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: true,
});
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
/** A palette colour at `alpha`, as a renderer colour (`[r, g, b, a]`). */
function color(css, alpha = 1) {
  const key = `${css}|${alpha}`;
  let value = colorCache.get(key);
  if (!value) {
    const [r, g, b] = cssColor(css) || [1, 1, 1];
    value = Object.freeze([r, g, b, alpha]);
    colorCache.set(key, value);
  }
  return value;
}
const DOT_HALO = Object.freeze([0, 0, 0, 0.85]);
/** An 8-bit `[r, g, b, a]` preset colour (alpha 0..1) as a renderer colour. */
const rgbaColor = (rgba, alpha = rgba[3]) => [
  rgba[0] / 255,
  rgba[1] / 255,
  rgba[2] / 255,
  alpha,
];
let instances = 0;

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
  pointer = null,
  render = null,
  inputFor = defaultInputFor,
  overlayLanes = null,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (typeof source?.getState !== 'function')
    throw new TypeError('C-ITS requires a state source');
  let _viewer = null;
  /** Draw sets: station dots, intersection lanes, hazard corridors. */
  let _dotSet = null;
  let _laneSet = null;
  let _hazardSet = null;
  let _hazardOverSet = null;
  /** @type {Map<string, {intersection:string, lane:object, item:object, key:string|null}>} */
  let _laneIds = new Map();
  let _hazardKey = '';
  let _enabled = false;
  let _request = null;
  let _clickSubscription = null;
  let _selectedId = null;
  let _selectedCardKey = '';
  let _controlsListener = null;
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
  let _groupCounts = {};
  let _overlayEntries = [];
  let _lastRecords = null;
  let _counts = {};
  let _upstream = null;
  let _bracketsOn = true;
  let _bracketLane = null;
  let _fullStreamAvailable = false;
  /**
   * Each dot's point item (`item.pos` is where it is drawn now) and its
   * glide from `from` to `to`, started at `t0`.
   * @type {Map<string, {item:object, record:object, from:object, to:object, t0:number, moving:boolean}>}
   */
  const _dots = new Map();
  const requestRender = () => findFrame(_viewer)?.requestRender(RENDER_OWNER);
  const drawSets = () =>
    [_dotSet, _laneSet, _hazardSet, _hazardOverSet].filter(Boolean);
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
      applyFade(dot.item, dot.record);
      applyDotStyle(dot.item, dot.record);
    }
    flushAllDots();
    if (!_settings.lanes && _laneIds.size) {
      removeLanes();
      _intersections = [];
    }
    if (_settings.lanes !== previous.lanes) _mapsVersion = null;
    const groupsChanged = Object.keys(_settings.groups).some(
      (id) => _settings.groups[id] !== previous.groups[id],
    );
    notifyControls();
    _bracketLane?.requestPaint();
    requestRender();
    if (groupsChanged && _enabled && !_request) void refresh();
  }

  /** Repaint the row controls without waiting for the next stats tick. */
  function notifyControls() {
    _controlsListener?.();
  }

  /**
   * Our picks, as the pick registry asks. Anonymous dots are not claimed:
   * a click on one is empty map to every listener, so nothing (the Context
   * card included) can select, name or follow a private vehicle.
   */
  const ownsPick = (id) =>
    typeof id === 'string' &&
    id.startsWith(CITS_PICK_PREFIX) &&
    !id.startsWith(`${CITS_PICK_PREFIX}anon:`);

  // ─── Camera ──────────────────────────────────────────────────────────────
  function cameraAltitude() {
    const height = findCamera(_viewer)?.pose()?.height;
    return Number.isFinite(height) ? height : Infinity;
  }

  /** The ground under the middle of the view, else the point under the eye. */
  function viewCentre() {
    const canvas = canvasOf(_viewer);
    const hit =
      canvas?.clientWidth > 0
        ? findQuery(_viewer)?.pickEllipsoid(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          )
        : null;
    const ground = hit ? toLonLatH(hit) : null;
    if (ground) return { lon: ground.lon, lat: ground.lat };
    const pose = findCamera(_viewer)?.pose();
    return { lon: pose?.lon ?? 0, lat: pose?.lat ?? 0 };
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
    const rect = findCamera(_viewer)?.viewRectangle();
    // A view across the antimeridian or off the globe: ask for everything.
    const world = { west: -180, south: -85, east: 180, north: 85 };
    if (!rect) return world;
    const box = {
      west: rect.west,
      south: rect.south,
      east: rect.east,
      north: rect.north,
    };
    return box.west >= box.east || box.south >= box.north ? world : box;
  }

  // ─── Heights (Street Traffic's rendered-surface sampling) ────────────────
  function groundHeight(lon, lat) {
    const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
    const cached = _heights.get(key);
    if (cached != null) return cached;
    const loaded = loadedSurfaceHeight(_viewer, { lon, lat });
    const estimate = Number.isFinite(loaded) ? loaded : 0;
    const rendered = renderedRoadHeight(_viewer, lon, lat, estimate);
    // Only depth-confirmed heights are final; estimates are retried later.
    if (rendered != null) {
      if (_heights.size > 20_000) _heights.clear();
      _heights.set(key, rendered);
    }
    return rendered ?? estimate;
  }

  function dotPosition(lon, lat) {
    return fromDegrees(
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
      ? rgbaColor(rgba, rgba[3] * (record.stale ? 0.35 : 1))
      : color(style.css, style.alpha);
    point.pixelSize =
      (style.size +
        (style.bucket ? presetSizeDelta(_stylePreset, style.bucket) : 0)) *
      _settings.dotScale;
    const outline = style.bucket
      ? presetDotOutline(_stylePreset, style.bucket)
      : null;
    if (outline) {
      point.outlineColor = rgbaColor(outline.rgba);
      point.outlineWidth = outline.width;
    } else if (record.kind === 'hazard' || citsIsVehicle(record.kind)) {
      // Street Traffic's preset halo: a dark ring keeps vehicles readable
      // over lanes painted in the same palette.
      point.outlineColor = DOT_HALO;
      point.outlineWidth = 2;
    } else {
      delete point.outlineColor;
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
    point.scaleByDistance = {
      near: 100,
      nearValue: 1.5,
      far: rangeM,
      farValue: vehicle ? 0.6 : 0.3,
    };
    point.fadeByDistance = {
      near: Math.min(rangeM * 0.7, Math.max(100, rangeM - 2000)),
      nearValue: 1.0,
      far: rangeM,
      farValue: 0.0,
    };
  }

  /** Send every dot's item to the draw set, restyled in place. */
  function flushAllDots() {
    if (!_dotSet || !_dots.size) return;
    _dotSet.upsert([..._dots.values()].map((dot) => dot.item));
  }

  function restyleAll() {
    for (const dot of _dots.values()) applyDotStyle(dot.item, dot.record);
    flushAllDots();
    paintLanes();
    requestRender();
  }

  // ─── Stations ────────────────────────────────────────────────────────────
  function renderDots(records, now) {
    const keep = new Set();
    _counts = {};
    // Anonymous ids are new in every response, so their dots are pooled by
    // slot instead of id and jump to each report rather than glide.
    let anonymousSlot = 0;
    for (const record of records) {
      const group = record.kind === 'hazard' ? 'hazard' : 'obj';
      const id = record.anonymous
        ? `${CITS_PICK_PREFIX}anon:${anonymousSlot++}`
        : `${CITS_PICK_PREFIX}${group}:${record.id}`;
      keep.add(id);
      if (record.kind !== 'hazard')
        _counts[record.kind] = (_counts[record.kind] || 0) + 1;
      const target = dotPosition(record.lon, record.lat);
      let dot = _dots.get(id);
      if (!dot) {
        const item = {
          id,
          pos: clone(target),
          // Grounded like Street Traffic: buildings and terrain occlude.
          disableDepthTest: 0,
          pixelSize: 1,
          color: DOT_HALO,
        };
        applyFade(item, record);
        dot = {
          item,
          record,
          from: target,
          to: target,
          t0: now,
          moving: false,
        };
        _dots.set(id, dot);
      } else if (record.anonymous || !citsIsVehicle(record.kind)) {
        // A pooled slot may now hold another kind with another range.
        if (dot.record.kind !== record.kind) applyFade(dot.item, record);
        dot.from = target;
        dot.to = target;
        dot.moving = false;
        dot.record = record;
        dot.item.pos = clone(target);
      } else {
        // Glide from wherever the dot is now to the new report.
        dot.from = clone(dot.item.pos);
        dot.to = target;
        dot.t0 = now;
        dot.moving = true;
        dot.record = record;
      }
      applyDotStyle(dot.item, record);
    }
    const gone = [];
    for (const [id] of _dots) {
      if (keep.has(id)) continue;
      gone.push(id);
      _dots.delete(id);
    }
    if (gone.length) _dotSet?.remove(gone);
    flushAllDots();
  }

  /** The gliding dots' items, gathered once a frame for one upsert. */
  const _frameItems = [];
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
      dots: () => _dots.values(),
      style: () => _stylePreset,
      maxDistance: () => _settings.bracketRangeKm * 1000,
      selectedRecord: () => selectedRecord(),
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
    _frameItems.length = 0;
    for (const dot of _dots.values()) {
      if (!dot.moving) continue;
      const t = Math.min(1, (now - dot.t0) / POLL_MS);
      // A fresh position each frame: the set may keep the one it was sent.
      dot.item.pos = lerpInto(dot.from, dot.to, t, { x: 0, y: 0, z: 0 });
      if (t >= 1) dot.moving = false;
      _frameItems.push(dot.item);
    }
    if (_frameItems.length) _dotSet?.upsert(_frameItems);
  }

  // ─── Hazard corridors (Street Traffic's heat-lines) ──────────────────────
  function removeHazardPaths() {
    _hazardSet?.clear();
    _hazardOverSet?.clear();
    _hazardKey = '';
  }

  /** ECEF positions along a `[[lon, lat], …]` path, on the ellipsoid. */
  const pathPositions = (coordinates) =>
    coordinates.map(([lon, lat]) => fromDegrees(lon, lat, 0));

  function renderHazardPaths(hazards, altitude) {
    const visible = altitude <= CITS_HAZARD_PATH_MAX_ALTITUDE_M ? hazards : [];
    const key = visible.map((hazard) => hazard.id).join('|');
    if (key === _hazardKey) return;
    removeHazardPaths();
    _hazardKey = key;
    if (!visible.length || !_hazardSet) return;
    const byBucket = { jam: [], slow: [] };
    let count = 0;
    for (const hazard of visible) {
      const bucket = citsHazardBucket(hazard.kind);
      for (const path of hazard.paths.slice(0, 2)) {
        if (count >= HAZARD_PATH_CAP) break;
        const jam = bucket === 'jam';
        byBucket[bucket].push({
          id: `hazard:${count++}`,
          positions: pathPositions(path),
          widthPx: jam ? HAZARD_JAM_WIDTH : HAZARD_SLOW_WIDTH,
          mode: 'draped',
          clampTo: 'both',
          style: {
            kind: 'glow',
            color: color(
              CITS_BUCKET_CSS[bucket],
              jam ? HAZARD_JAM_ALPHA : HAZARD_SLOW_ALPHA,
            ),
            power: jam ? 0.25 : 0.2,
          },
        });
      }
    }
    // Slow corridors draw over jam ones, in a set made after theirs.
    if (byBucket.jam.length) _hazardSet.set(byBucket.jam);
    if (byBucket.slow.length) _hazardOverSet.set(byBucket.slow);
  }

  // ─── Intersection lanes (per-lane colours, repainted per phase) ──────────
  function removeLanes() {
    _laneSet?.clear();
    _laneIds = new Map();
  }

  function buildLanes(intersections) {
    removeLanes();
    _intersections = intersections;
    if (!intersections.length || !_laneSet) return;
    const items = [];
    for (const intersection of intersections) {
      for (const lane of intersection.lanes) {
        const id = `${CITS_PICK_PREFIX}lane:${intersection.id}:${lane.id}`;
        const style = citsLaneStyle(lane, null);
        const item = {
          id,
          positions: pathPositions(lane.coordinates),
          widthPx: LANE_WIDTH,
          mode: 'draped',
          clampTo: 'both',
          style: { kind: 'solid', color: color(style.css, style.alpha) },
        };
        items.push(item);
        _laneIds.set(id, {
          intersection: intersection.id,
          lane,
          item,
          key: `${style.css}|${style.alpha}`,
        });
      }
    }
    _laneSet.set(items);
  }

  function paintLanes() {
    if (!_laneSet || !_laneIds.size) return;
    const phases = new Map();
    const changed = [];
    for (const entry of _laneIds.values()) {
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
      entry.item.style = {
        kind: 'solid',
        color: color(style.css, style.alpha),
      };
      entry.key = key;
      changed.push(entry.item);
    }
    if (changed.length) _laneSet.upsert(changed);
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
    const camera = findCamera(_viewer)?.pose()?.position;
    if (!camera) return;
    const labelRange = _settings.labelRangeKm * 1000;
    const bracketRange = _settings.bracketRangeKm * 1000;
    {
      for (const record of records) {
        const group = record.kind === 'hazard' ? 'hazard' : 'obj';
        const dotId = `${CITS_PICK_PREFIX}${group}:${record.id}`;
        const dot = _dots.get(dotId);
        // The selected station carries its name on the selected card.
        if (!dot || dotId === _selectedId) continue;
        const distance = distance3(camera, dot.item.pos);
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

  // ─── Selection card (world-overlay host) ─────────────────────────────────
  function selectedRecord() {
    const record = _selectedId ? _dots.get(_selectedId)?.record : null;
    return record && !record.anonymous ? record : null;
  }

  /** Publish (or drop) the one selected card; identical copy is not resent. */
  function publishSelectedCard() {
    if (!overlayHost) return;
    const record = selectedRecord();
    if (!record) {
      _selectedId = null;
      if (!_selectedCardKey) return;
      _selectedCardKey = '';
      overlayHost.setEntries(
        CITS_SELECTED_OVERLAY_SOURCE_ID,
        [],
        SELECTED_CARD_HOST_OPTIONS,
      );
      return;
    }
    const card = buildCitsSelectedCard(record, Date.now());
    const key = JSON.stringify([
      card.id,
      card.title,
      card.details,
      card.accent,
    ]);
    if (key === _selectedCardKey) return;
    _selectedCardKey = key;
    const dotId = _selectedId;
    overlayHost.setEntries(
      CITS_SELECTED_OVERLAY_SOURCE_ID,
      [
        {
          ...card,
          // A getter: the host re-projects it each frame while the dot glides.
          position: () => _dots.get(dotId)?.item.pos,
        },
      ],
      SELECTED_CARD_HOST_OPTIONS,
    );
  }

  function select(id) {
    if (id === _selectedId) return;
    _selectedId = id;
    publishSelectedCard();
    // The selected station's ambient label steps aside for the card.
    if (_lastRecords) publishLabels(_lastRecords);
  }

  /** Resolve a pick to one of our selectable station ids, or null. */
  function selectableId(pickId) {
    if (typeof pickId !== 'string') return null;
    if (pickId.startsWith(`${CITS_PICK_PREFIX}lane:`)) {
      const intersection = _laneIds.get(pickId)?.intersection;
      return intersection ? `${CITS_PICK_PREFIX}obj:${intersection}` : null;
    }
    // Anonymous vehicles are dots only: no card, no identity.
    const dot = _dots.get(pickId);
    return dot && !dot.record.anonymous ? pickId : null;
  }

  /** The pick id of a click's draw hit when it is an item of our sets. */
  function ownDrawHitId(hit) {
    if (!hit || hit.surface || typeof hit.id !== 'string') return null;
    const sets = [_dotSet, _laneSet].map((set) => set?.id);
    return sets.includes(hit.set) ? hit.id : null;
  }

  function installInteraction() {
    if (_clickSubscription || !_viewer) return;
    picking?.registerPickOwner(layer.id, ownsPick);
    _clickSubscription = inputFor(_viewer).onClick((event) => {
      if (!_enabled) return;
      if (pointer && !pointer.isPointerFree()) return;
      // A card or label painted on top takes the click, the selected card
      // itself included: it keeps the selection.
      if (picking?.clickCard?.(event)) return;
      const at = event.screenPosition || event.position;
      const cardHit = overlayHost?.hitTest?.(at?.x, at?.y, {
        sourceId: CITS_SELECTED_OVERLAY_SOURCE_ID,
      });
      if (cardHit) return;
      const id = selectableId(ownDrawHitId(event.drawHit));
      if (id) {
        select(id);
        return;
      }
      // A sibling layer's pick (an aircraft, a camera) is not empty space:
      // leave the selection alone and let that layer handle it.
      const pickId = event.id ?? null;
      if (pickId && picking?.isOwnedByOtherLayer(layer.id, pickId)) return;
      select(null);
    });
  }

  function removeInteraction() {
    _clickSubscription?.();
    _clickSubscription = null;
    picking?.unregisterPickOwner(layer.id);
    _selectedId = null;
    _selectedCardKey = '';
    overlayHost?.clearSource(CITS_SELECTED_OVERLAY_SOURCE_ID);
  }

  function clearScene() {
    _dotSet?.clear();
    _dots.clear();
    removeLanes();
    removeHazardPaths();
    _intersections = [];
    _overlayEntries = [];
    _lastRecords = null;
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
      publishSelectedCard();
      notifyControls();
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
            name: hazard.label || hazard.kind || t('Hazard'),
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
        if (_laneIds.size) removeLanes();
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
      _lastRecords = records;
      publishLabels(records);
      publishSelectedCard();
      notifyControls();
      _lastUpdate = Date.now();
      _lastError = null;
      requestRender();
      return true;
    } catch (error) {
      if (request.signal.aborted || !_enabled) return false;
      if (_mode === 'full' && /HTTP 403/.test(error?.message || '')) {
        // The operator has not opted into the full stream.
        _fullStreamAvailable = false;
        _mode = 'tiled';
        return false;
      }
      console.warn('[Data:CITS] Fetch error:', error);
      // Only the source's own short messages reach the row.
      const message = String(error?.message || '');
      _lastError = /^(C-ITS relay HTTP \d{3}|Malformed C-ITS payload)$/.test(
        message,
      )
        ? message
        : t('C-ITS relay unavailable');
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
      const draw = drawOf(viewer);
      const instance = ++instances;
      _dotSet = draw.points({
        id: `cits:${instance}:dots`,
        blend: 'translucent',
        show: false,
      });
      // Lanes and corridors drape on terrain and tiles, as their ground
      // polylines classified both.
      _laneSet = draw.lines({ id: `cits:${instance}:lanes`, clampTo: 'both' });
      _hazardSet = draw.lines({
        id: `cits:${instance}:hazards`,
        clampTo: 'both',
        pickable: false,
      });
      _hazardOverSet = draw.lines({
        id: `cits:${instance}:hazards-over`,
        clampTo: 'both',
        pickable: false,
      });
      overlayHost?.setVisible(CITS_OVERLAY_SOURCE_ID, false);
      overlayHost?.setVisible(CITS_SELECTED_OVERLAY_SOURCE_ID, false);
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
      for (const set of drawSets()) set.show = true;
      overlayHost?.setVisible(CITS_OVERLAY_SOURCE_ID, true);
      overlayHost?.setVisible(CITS_SELECTED_OVERLAY_SOURCE_ID, true);
      _removePreRender = frameOf(_viewer).on('preRender', animate);
      render?.holdContinuousRender?.(RENDER_OWNER);
      installInteraction();
      installBrackets();
      notifyControls();
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
      clearScene();
      for (const set of drawSets()) set.show = false;
      overlayHost?.setVisible(CITS_OVERLAY_SOURCE_ID, false);
      overlayHost?.setVisible(CITS_SELECTED_OVERLAY_SOURCE_ID, false);
      _status = 'idle';
      requestRender();
    },

    async update() {
      if (!_enabled || !_dotSet) return false;
      // A slow full-stream response is not cut short by the next tick.
      if (_request) return false;
      return refresh();
    },

    destroy() {
      layer.disable();
      if (_styleListener)
        windowRef?.removeEventListener('gev:style-change', _styleListener);
      _styleListener = null;
      _controlsListener = null;
      for (const set of drawSets()) set.dispose();
      _dotSet = _laneSet = _hazardSet = _hazardOverSet = null;
      _viewer = null;
    },

    getParams() {
      return { bandwidth: _mode, brackets: _bracketsOn, settings: _settings };
    },

    setParams(params = {}) {
      if (params.resetSettings === true) applySettings({}, { reset: true });
      if (params.settings && typeof params.settings === 'object')
        applySettings(params.settings);
      if (typeof params.brackets === 'boolean') {
        _bracketsOn = params.brackets;
        if (_lastRecords) publishLabels(_lastRecords);
        notifyControls();
        _bracketLane?.requestPaint();
        requestRender();
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
     * Row controls: bandwidth (only when the server operator has opted into
     * the full stream, `CITS_OTM_FULL_STREAM=1`), brackets, stepped
     * visibility ranges and dot size, and a kind list with live counts.
     */
    getRowControls() {
      const bandwidth = _fullStreamAvailable
        ? [
            {
              id: 'bandwidth-tiled',
              label: t('TILED'),
              title: t(
                'Only the map tiles around the view (/ws_tiled, ~100 KB/s)',
              ),
              active: _mode === 'tiled',
              params: { bandwidth: 'tiled' },
            },
            {
              id: 'bandwidth-full',
              label: t('HIGH BANDWIDTH'),
              title: t(
                'Every station OpenTrafficMap hears, at any zoom (/ws_ext, ~1 MB/s compressed)',
              ),
              active: _mode === 'full',
              params: { bandwidth: 'full' },
            },
          ]
        : [];
      const ranges = CITS_RANGE_SETTINGS.map((spec) => {
        const value = _settings[spec.id];
        return {
          id: `range-${spec.id}`,
          label: `${t(spec.label)} · ${citsFormatRange(spec, value)}`,
          title: t('{setting} — click for the next step', {
            setting: t(spec.title),
          }),
          params: { settings: { [spec.id]: citsNextRangeStep(spec, value) } },
        };
      });
      const count = (value = 0) =>
        value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
      return {
        chips: [
          ...bandwidth,
          {
            id: 'brackets',
            label: t('BRACKETS'),
            title: t('Detection brackets and info cards on trams'),
            active: _bracketsOn,
            params: { brackets: !_bracketsOn },
          },
          ...ranges,
          {
            id: 'reset',
            label: t('RESET'),
            title: t('Restore the default ranges, dot size and kinds'),
            params: { resetSettings: true },
          },
        ],
        legend: [
          {
            label: t('Moving or green'),
            color: CITS_BUCKET_CSS.free,
            blurb: t(
              'Colour shows reported speed for vehicles and the live signal phase for traffic lights and their lanes.',
            ),
          },
          { label: t('Slow, amber or roadworks'), color: CITS_BUCKET_CSS.slow },
          { label: t('Stopped, red or hazard'), color: CITS_BUCKET_CSS.jam },
          { label: t('No speed or phase'), color: CITS_UNKNOWN_CSS },
        ],
        list: {
          ariaLabel: t('C-ITS station kinds shown'),
          items: [
            ...CITS_KIND_GROUPS.map((group) => {
              const on = _settings.groups[group.id] !== false;
              return {
                id: `kind-${group.id}`,
                lead: count(_groupCounts[group.id]),
                text: t(group.label),
                active: on,
                params: { settings: { groups: { [group.id]: !on } } },
              };
            }),
            {
              id: 'kind-lanes',
              lead: count(_intersections.length),
              text: t('Signal lanes'),
              active: _settings.lanes,
              params: { settings: { lanes: !_settings.lanes } },
            },
          ],
        },
        info: t('Private vehicles are anonymous dots: no card, no track.'),
        infoTitle: t(
          'Live C-ITS broadcasts heard by OpenTrafficMap volunteer receivers. Coverage is wherever a receiver listens, not every road. Click a tram, bus, traffic light or hazard for its card; click empty map space to clear it.',
        ),
      };
    },

    setRowControlsListener(fn) {
      _controlsListener = typeof fn === 'function' ? fn : null;
    },

    /**
     * What is drawn, for checks of the running app: the dot set's id and
     * each dot's id and drawn position (ECEF).
     */
    getDiagnostics() {
      return {
        dotSet: _dotSet?.id ?? null,
        dots: [..._dots].map(([id, dot]) => ({ id, position: dot.item.pos })),
        lanes: _laneIds.size,
      };
    },

    /**
     * A public station by its pick id (a lane names its intersection), for
     * the Context card: its name and where it is. Null for an anonymous dot.
     */
    findByQuery(query) {
      const record = _dots.get(selectableId(query))?.record;
      if (!record || record.anonymous) return null;
      return {
        name: buildCitsSelectedCard(record, Date.now()).title,
        latitude: record.lat,
        longitude: record.lon,
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
        result.push({ position: dot.item.pos, id, type: 'V2X' });
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
        ...(_status === 'connecting'
          ? { loadingLabel: t('Connecting to OpenTrafficMap…') }
          : undefined),
        // Guidance, not a fault: the prompt goes in `statusMessage`.
        ...(_status === 'zoom-in'
          ? { statusMessage: t('Zoom in to load C-ITS stations') }
          : undefined),
        lastUpdate: _lastUpdate,
        upstream: _upstream,
        error: _lastError,
      };
    },
  };
  return layer;
}
