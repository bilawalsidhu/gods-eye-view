import * as Cesium from 'cesium';
import {
  satelliteShortName,
  fireDetectionKey,
  accentForSeverity,
} from '../../data/firmsLabels.js';
import {
  VIEW_PADDING,
  DETECTION_COLOR_STOPS,
  CULL_LIFT_THRESHOLD_M,
  CULL_LIFT_M,
  LABEL_MIN_SEP_PX,
} from './policy.js';

export function createModel({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { fireAnchorHeight } = services.anchors;

  /**
   * Map one internal fire record (firmsAdapt.js shape) to a plain JSON-safe
   * analyst record (analyst query engine seam). Pure — no Cesium types.
   * Missing/unknown fields are null, never NaN/undefined. The id reuses the
   * layer's FIRE-##### pick-id convention (index keys pick ids and
   * context-store ids, so the two stay consistent).
   * @param {Object|null|undefined} fire - Internal fire record.
   * @returns {{id: string, lat: number|null, lon: number|null, frp: number|null,
   *   confidence: number|null, satellite: string|null, acqTime: number|null}}
   */

  function mapAnalystRecord(fire) {
    const num = (v) => (Number.isFinite(v) ? v : null);
    const text = (v) => {
      const t = String(v ?? '').trim();
      return t || null;
    };
    return {
      id: `FIRE-${String(fire?.index ?? 0).padStart(5, '0')}`,
      lat: num(fire?.lat),
      lon: num(fire?.lon),
      frp: num(fire?.frp),
      confidence: num(fire?.confidence), // normalized 0..1 (firmsAdapt.normalizeConfidence)
      satellite: text(fire?.satellite) || text(fire?.sensor),
      acqTime:
        Number.isFinite(fire?.acqMs) && fire.acqMs > 0 ? fire.acqMs : null, // epoch ms; 0 = unparseable → null
    };
  }

  /**
   * Expand a view rectangle by VIEW_PADDING per side and convert to degree
   * bounds with an explicit anti-meridian wrap flag. Returns null for
   * near-global views where clipping would be pointless.
   * @param {Cesium.Rectangle} rect - Camera view rectangle (radians).
   * @returns {?{west: number, south: number, east: number, north: number, wraps: boolean}}
   */

  function paddedDegreeBounds(rect) {
    const width = Cesium.Rectangle.computeWidth(rect);
    const height = Cesium.Rectangle.computeHeight(rect);
    if (width >= Math.PI * 1.85) return null;
    const padLon = width * VIEW_PADDING;
    const padLat = height * VIEW_PADDING;
    const south = Math.max(-Cesium.Math.PI_OVER_TWO, rect.south - padLat);
    const north = Math.min(Cesium.Math.PI_OVER_TWO, rect.north + padLat);
    let west = rect.west - padLon;
    let east = rect.east + padLon;
    let wraps;
    if (width + padLon * 2 >= Cesium.Math.TWO_PI) {
      west = -Math.PI;
      east = Math.PI;
      wraps = false;
    } else {
      west = Cesium.Math.negativePiToPi(west);
      east = Cesium.Math.negativePiToPi(east);
      wraps = west > east;
    }
    return {
      west: Cesium.Math.toDegrees(west),
      south: Cesium.Math.toDegrees(south),
      east: Cesium.Math.toDegrees(east),
      north: Cesium.Math.toDegrees(north),
      wraps,
    };
  }

  /** Point-in-bounds test in degrees, anti-meridian aware. */

  function boundsContainPoint(bounds, lat, lon) {
    if (lat < bounds.south || lat > bounds.north) return false;
    if (bounds.wraps) return lon >= bounds.west || lon <= bounds.east;
    return lon >= bounds.west && lon <= bounds.east;
  }

  /** Cell-rectangle/bounds intersection test in degrees, anti-meridian aware. */

  function cellIntersectsBounds(cell, gridDegrees, bounds) {
    if (
      cell.latCell + gridDegrees < bounds.south ||
      cell.latCell > bounds.north
    )
      return false;
    const west = cell.lonCell;
    const east = cell.lonCell + gridDegrees;
    if (bounds.wraps) return east >= bounds.west || west <= bounds.east;
    return east >= bounds.west && west <= bounds.east;
  }

  function heatScore(cell) {
    return (
      cell.intensity + cell.count * 0.8 + cell.night * 0.6 + cell.maxFrp * 0.12
    );
  }

  function heatColor(value, alpha) {
    if (value > 0.72) return Cesium.Color.RED.withAlpha(alpha);
    if (value > 0.42) return Cesium.Color.ORANGE.withAlpha(alpha);
    return Cesium.Color.YELLOW.withAlpha(alpha);
  }

  /**
   * Pick a sprite color stop from FRP + confidence, reusing the same
   * yellow → orange → red thresholds as the aggregated heat cells.
   * @param {Object} fire - Detection record.
   * @returns {{name: string, color: Cesium.Color}}
   */

  function detectionColorStop(fire) {
    const heat = Math.min(
      1,
      Math.sqrt(Math.max(0, fire.frp) / 150) * 0.85 + fire.confidence * 0.15,
    );
    if (heat > 0.72) return DETECTION_COLOR_STOPS[0];
    if (heat > 0.42) return DETECTION_COLOR_STOPS[1];
    return DETECTION_COLOR_STOPS[2];
  }

  /** FRP → core marker pixel size, clamped to 8..28px. */

  function frpPixelSize(frp) {
    return Math.max(
      8,
      Math.min(28, Math.round(8 + Math.sqrt(Math.max(0, frp)) * 2)),
    );
  }

  /** Quantize a core size to a 2px bucket so the sprite cache stays tiny. */

  function sizeBucket(coreSize) {
    return Math.max(8, Math.min(28, Math.round(coreSize / 2) * 2));
  }

  /**
   * Build (and cache) a radial-glow sprite: hot near-white center fading
   * through the stop color to a transparent edge. The glow lives in the
   * sprite itself because global bloom defaults OFF.
   * @param {{name: string, color: Cesium.Color}} stop - Color stop.
   * @param {number} corePx - Bucketed core size in pixels.
   * @returns {string} PNG data URL.
   */

  function glowSprite(stop, corePx) {
    const key = `${stop.name}:${corePx}`;
    const cached = layerState.glowSpriteCache.get(key);
    if (cached) return cached;

    const dimension = corePx * 2;
    const canvas = document.createElement('canvas');
    canvas.width = dimension;
    canvas.height = dimension;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const radius = dimension / 2;
    const rgb = [
      Math.round(stop.color.red * 255),
      Math.round(stop.color.green * 255),
      Math.round(stop.color.blue * 255),
    ].join(',');
    const gradient = context.createRadialGradient(
      radius,
      radius,
      0,
      radius,
      radius,
      radius,
    );
    gradient.addColorStop(0, 'rgba(255,255,235,0.95)');
    gradient.addColorStop(0.25, `rgba(${rgb},0.9)`);
    gradient.addColorStop(0.55, `rgba(${rgb},0.35)`);
    gradient.addColorStop(1, `rgba(${rgb},0)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, dimension, dimension);

    const dataUrl = canvas.toDataURL('image/png');
    layerState.glowSpriteCache.set(key, dataUrl);
    return dataUrl;
  }

  /**
   * Lazily-cached Cartesian3 anchor at the shared ground floor (DEM/mesh cell
   * + lift) when the floor is warm, else ellipsoid height 0 (owner field
   * finding 2026-07-21: height-0 anchors read as buried under high terrain at
   * close/oblique zoom). Warm-cache read only — floors are warmed in batch by
   * renderDetections for the close band; everything else (cell-band context
   * registrations, detectable objects) just rides whatever is already warm.
   * Fires are static and floor cells latch, so each detection re-allocates at
   * most once per floor state (cold 0 → warm DEM). Rendering stays depth-test
   * free either way (contacts are ALWAYS visible — never below the surface,
   * slightly above is fine).
   * @param {Object} fire - Detection record.
   * @returns {Cesium.Cartesian3}
   */

  function firePosition(fire) {
    const height = fireAnchorHeight(fire.lat, fire.lon);
    if (!fire.position || fire.positionHeight !== height) {
      fire.position = Cesium.Cartesian3.fromDegrees(fire.lon, fire.lat, height);
      fire.positionHeight = height;
    }
    return fire.position;
  }

  /**
   * Occlusion-test anchor for one detection. Returns the render position
   * outright for anchors comfortably above the ellipsoid (the common case) and
   * a lazily-cached lifted point otherwise — see CULL_LIFT_THRESHOLD_M. This
   * NEVER feeds rendering: the datum-correct anchor from {@link firePosition}
   * is what the sprite and the card are drawn at.
   * @param {Object} fire - Detection record.
   * @returns {Cesium.Cartesian3}
   */

  function fireCullPosition(fire) {
    const position = firePosition(fire);
    if (fire.positionHeight >= CULL_LIFT_THRESHOLD_M) return position;
    if (!fire.cullPosition) {
      fire.cullPosition = Cesium.Cartesian3.fromDegrees(
        fire.lon,
        fire.lat,
        CULL_LIFT_M,
      );
    }
    return fire.cullPosition;
  }

  /**
   * Occlusion-test anchor for an aggregated heat cell. Cell centers are built at
   * height 0 (exactly on the ellipsoid), which the occluder treats as a limb
   * boundary case, so they get the same lift as sub-ellipsoid fire anchors.
   * @param {number} lon - Cell center longitude in degrees.
   * @param {number} lat - Cell center latitude in degrees.
   * @returns {Cesium.Cartesian3}
   */

  function cellCullPosition(lon, lat) {
    return Cesium.Cartesian3.fromDegrees(lon, lat, CULL_LIFT_M);
  }

  /**
   * Horizon-cull a billboard collection against an ellipsoid occluder.
   *
   * The Cesium globe is hidden in this app (Google 3D Tiles render the planet),
   * so nothing writes far-side depth — and these sprites are additionally
   * always-on-top (`disableDepthTestDistance: INFINITY`, so a detection is never
   * swallowed by terrain it sits on). Without an explicit occluder pass, fires on
   * the opposite side of the Earth shine through the planet at tilted mid-altitude
   * views. Same pattern as the flights/CCTV layers' `EllipsoidalOccluder` passes.
   *
   * Pure and allocation-free: reads `billboard.position`, writes `billboard.show`
   * only when it actually flips (assigning `show` dirties the collection's vertex
   * buffer). Accepts any `{length, get(i)}` shape so it is unit-testable without
   * a WebGL scene.
   *
   * @param {?{length: number, get: function(number): (Object|undefined)}} billboards
   *   Billboard collection (or collection-shaped stub).
   * @param {?{isPointVisible: function(Object): boolean}} occluder Horizon occluder.
   * @param {?Array<Cesium.Cartesian3>} [cullPositions=null] Index-aligned lifted
   *   occlusion-test anchors (see {@link fireCullPosition}); falls back to the
   *   billboard's own render position wherever an entry is absent.
   * @returns {number} Count of billboards left visible (0 when nothing to test).
   */

  function applyHorizonCull(billboards, occluder, cullPositions = null) {
    if (!billboards || typeof billboards.get !== 'function') return 0;
    if (typeof occluder?.isPointVisible !== 'function') return 0;
    const total = Number(billboards.length) || 0;
    let visibleCount = 0;
    for (let i = 0; i < total; i += 1) {
      const billboard = billboards.get(i);
      if (!billboard) continue;
      const point = (cullPositions && cullPositions[i]) || billboard.position;
      const visible = occluder.isPointVisible(point) === true;
      if (billboard.show !== visible) billboard.show = visible;
      if (visible) visibleCount += 1;
    }
    return visibleCount;
  }

  /**
   * True when `screen` is at least LABEL_MIN_SEP_PX away from every accepted
   * screen position (greedy declutter accept test).
   * @param {Array<{x: number, y: number}>} accepted - Accepted label positions.
   * @param {Cesium.Cartesian2} screen - Candidate window coordinates.
   * @returns {boolean}
   */

  function screenSeparated(accepted, screen) {
    const minSq = LABEL_MIN_SEP_PX * LABEL_MIN_SEP_PX;
    for (let i = 0; i < accepted.length; i += 1) {
      const dx = screen.x - accepted[i].x;
      const dy = screen.y - accepted[i].y;
      if (dx * dx + dy * dy < minSq) return false;
    }
    return true;
  }

  /**
   * Card model for a click-selected fire — the full-detail card, drawn last
   * (on top) and never distance-faded by the overlay.
   * Exported for unit tests.
   * @param {Object} fire - Detection record.
   * @param {number} nowMs - Current epoch milliseconds.
   * @returns {Object} firmsLabels entry.
   */

  function buildSelectedFireCard(fire, nowMs) {
    const meta = [`${confidenceBucket(fire.confidence)} conf`];
    if (fire.acqMs > 0) {
      const age = formatAge(nowMs - fire.acqMs);
      if (age) meta.push(`${age} ago`);
    }
    const sat = satelliteShortName(fire.satellite);
    meta.push(
      sat ? `${fire.sensor || 'VIIRS'} ${sat}` : fire.sensor || 'sensor n/a',
    );
    return {
      id: `selected-fire:${fireDetectionKey(fire)}`,
      actionable: true,
      position: firePosition(fire),
      // Host-side horizon test uses this instead of the render anchor.
      cullPosition: fireCullPosition(fire),
      gapPx: frpPixelSize(fire.frp),
      accent: accentForSeverity(detectionColorStop(fire).name),
      title: `FIRE · ${formatFrp(fire.frp)} MW`,
      details: [
        meta.join(' · '),
        formatLatLon(fire.lat, fire.lon) + (fire.night ? ' · NIGHT' : ''),
      ],
      selected: true,
      priority: Number.MAX_SAFE_INTEGER,
    };
  }

  /**
   * Card model for an ambient fire detection, e.g. title "FIRE 47 MW", detail
   * "high · 14h · N20". Ages are computed against each detection's acquisition
   * time — with the live feed everything reads under 24 h (and a stale cache
   * reads truthfully old). Exported for unit tests.
   * @param {{fire: Object, position: Cesium.Cartesian3}} candidate - Label candidate.
   * @param {number} nowMs - Current epoch milliseconds.
   * @returns {Object} firmsLabels entry.
   */

  function buildFireCard(candidate, nowMs) {
    const fire = candidate.fire;
    const meta = [confidenceBucket(fire.confidence)];
    if (fire.acqMs > 0) {
      const age = formatAge(nowMs - fire.acqMs);
      if (age) meta.push(age);
    }
    const sat = satelliteShortName(fire.satellite) || fire.sensor;
    if (sat) meta.push(sat);
    return {
      id: `fire:${fireDetectionKey(fire)}`,
      actionable: true,
      position: candidate.position,
      cullPosition: candidate.cullPosition || candidate.position,
      gapPx: frpPixelSize(fire.frp),
      accent: accentForSeverity(detectionColorStop(fire).name),
      title: `FIRE ${formatFrp(fire.frp)} MW`,
      details: [meta.join(' · ')],
      selected: false,
      priority: Number(fire.frp) || 0,
    };
  }

  /**
   * Card model for an aggregated heat cell, e.g. title "14 FIRES", detail
   * "max 210 MW · new 3h". Accent comes from the candidate (heat-normalized
   * score is only known at renderCells time). Exported for unit tests.
   * @param {{cell: Object, position: Cesium.Cartesian3, accent: string}} candidate
   * @param {number} nowMs - Current epoch milliseconds.
   * @returns {Object} firmsLabels entry.
   */

  function buildCellCard(candidate, nowMs) {
    const cell = candidate.cell;
    const noun = cell.count === 1 ? 'FIRE' : 'FIRES';
    const parts = [`max ${formatFrp(cell.maxFrp)} MW`];
    if (cell.newestAcqMs > 0) {
      const age = formatAge(nowMs - cell.newestAcqMs);
      if (age) parts.push(`new ${age}`);
    }
    return {
      id: `cell:${cell.latCell ?? 'x'}:${cell.lonCell ?? 'x'}`,
      position: candidate.position,
      cullPosition: candidate.cullPosition || candidate.position,
      gapPx: 10,
      accent: candidate.accent || accentForSeverity('yellow'),
      title: `${cell.count} ${noun}`,
      details: [parts.join(' · ')],
      selected: false,
      priority: Number(cell.maxFrp) || 0,
    };
  }

  /**
   * Add the host-owned layout/fade/collision fields to a source-formatted FIRMS
   * card. Selected fires share the collision domain so their protected rect
   * excludes ambient cards, but bypass both the 18-card cohort and distance fade.
   * @param {Object} card Source-formatted card.
   * @param {number} fadeDistance Current LOD fade distance in metres.
   * @returns {Object}
   */

  function applyFirmsOverlayPolicy(card, fadeDistance) {
    const selected = card?.selected === true;
    const rawGap = Number(card?.gapPx) || 10;
    const gapPx = Math.max(12, rawGap + 8);
    return {
      ...card,
      variant: selected ? 'selected' : 'card',
      protected: selected,
      collisionGroup: 'ambient-card',
      cardStyle: 'tactical',
      gapPx,
      leaderOffsetPx: Math.max(2, gapPx - 6),
      verticalOnly: true,
      viewportMargin: 4,
      maxDistance: selected ? Number.POSITIVE_INFINITY : fadeDistance,
      distanceFadeStartRatio: 0.7,
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
      // Aggregate cells omit actionable because they do not identify one fire.
      interactive: card?.actionable === true,
    };
  }

  /**
   * Heat-normalized cell score → severity accent, mirroring heatColor's
   * red/orange/yellow thresholds.
   * @param {number} normalized - 0..1 normalized heat score.
   * @returns {string} "r, g, b" accent string.
   */

  function cellAccent(normalized) {
    if (normalized > 0.72) return accentForSeverity('red');
    if (normalized > 0.42) return accentForSeverity('orange');
    return accentForSeverity('yellow');
  }

  /** Coordinate line like "30.512°N 75.831°E". */

  function formatLatLon(lat, lon) {
    const latPart = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}`;
    const lonPart = `${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
    return `${latPart} ${lonPart}`;
  }

  function formatFrp(frp) {
    return frp >= 10 ? frp.toFixed(0) : frp.toFixed(1);
  }

  /** Millisecond delta → "<1h" / "Xh" / "Xd", or '' for invalid input. */

  function formatAge(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return '';
    const hours = deltaMs / 3600000;
    if (hours < 1) return '<1h';
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  }

  /** Millisecond delta → "<1m ago" / "Xm ago" / "Xh ago" (fresh-feed readout). */

  function formatAgoMinutes(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';
    const minutes = Math.floor(deltaMs / 60000);
    if (minutes < 1) return '<1m ago';
    if (minutes < 90) return `${minutes}m ago`;
    return `${Math.round(minutes / 60)}h ago`;
  }

  /** Normalized 0..1 confidence → low/nominal/high display bucket. */

  function confidenceBucket(confidence) {
    if (confidence >= 0.75) return 'high';
    if (confidence >= 0.45) return 'nominal';
    return 'low';
  }
  return {
    mapAnalystRecord,
    paddedDegreeBounds,
    boundsContainPoint,
    cellIntersectsBounds,
    heatScore,
    heatColor,
    detectionColorStop,
    frpPixelSize,
    sizeBucket,
    glowSprite,
    firePosition,
    fireCullPosition,
    cellCullPosition,
    applyHorizonCull,
    screenSeparated,
    buildSelectedFireCard,
    buildFireCard,
    buildCellCard,
    applyFirmsOverlayPolicy,
    cellAccent,
    formatLatLon,
    formatFrp,
    formatAge,
    formatAgoMinutes,
    confidenceBucket,
  };
}
