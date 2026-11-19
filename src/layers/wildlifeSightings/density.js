import { fromDegrees } from '../../geo/ellipsoid.js';
import { drawOf, findCamera } from '../../render/rendererOf.js';
import { spriteDrawOrder } from '../../data/spriteOrder.js';
import { createWildlifeIconCollection } from './iconCollection.js';
import {
  WILDLIFE_GRID_SAMPLE_SPACING_PX,
  wildlifeGridCellBounds,
} from './gridViewport.js';
import {
  createWildlifeWorkQueue,
  drainWildlifeWork,
  WILDLIFE_WORK_UNIT,
} from './performance.js';

export const WILDLIFE_DENSITY_OVERLAP = 4;
const KERNEL_SIGMA = 0.7;
export const WILDLIFE_DENSITY_MAX_ALPHA = 0.34;
const DENSITY_MIN_ALPHA = 0.012;
const DENSITY_RAMP_GAMMA = 3;
const METERS_PER_DEGREE = (2 * Math.PI * 6378137) / 360;
const FADE_STEPS = 3;
const FADE_STEP_MS = 60;
// Fade coarse splats before they read as haze across the whole Earth disc.
const ALTITUDE_FADE_START = 3_000_000;
const ALTITUDE_FADE_END = 8_000_000;
// Sparse cells read cool teal; hotspots warm toward amber. Sensor styles keep
// one neutral or phosphor tint.
const NORMAL_TINT = { low: [0.3, 0.8, 0.78], high: [1, 0.78, 0.38] };
const MONO_TINT = { low: [0.96, 0.96, 0.96], high: [0.96, 0.96, 0.96] };
const CRT_TINT = { low: [0.48, 1, 0.72], high: [0.48, 1, 0.72] };

/** View-relative alpha keeps hotspots distinct as cell counts grow on zoom-out. */
export function wildlifeDensityIntensity(rank) {
  if (!(rank > 0) || !Number.isFinite(rank)) return 0;
  return (
    DENSITY_MIN_ALPHA +
    (WILDLIFE_DENSITY_MAX_ALPHA - DENSITY_MIN_ALPHA) *
      Math.min(1, rank) ** DENSITY_RAMP_GAMMA
  );
}

/** Rank function over the snapshot's positive counts: the share of cells with
 * a count at or below the given one. */
export function wildlifeDensityRanks(cells = []) {
  const counts = [];
  for (const cell of cells)
    if (Number.isSafeInteger(cell?.cellCount) && cell.cellCount > 0)
      counts.push(cell.cellCount);
  counts.sort((a, b) => a - b);
  return (count) => {
    if (!counts.length || !(count > 0)) return 0;
    let low = 0;
    let high = counts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (counts[mid] <= count) low = mid + 1;
      else high = mid;
    }
    return low / counts.length;
  };
}

/** Truncated Gaussian in source-cell widths; overlapping splats hide the grid. */
export function wildlifeDensityKernel(distance) {
  const radius = WILDLIFE_DENSITY_OVERLAP / 2;
  if (!Number.isFinite(distance) || distance < 0 || distance >= radius)
    return 0;
  const edge = Math.exp(-(radius ** 2) / (2 * KERNEL_SIGMA ** 2));
  return (
    (Math.exp(-(distance ** 2) / (2 * KERNEL_SIGMA ** 2)) - edge) / (1 - edge)
  );
}

const DENSITY_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><defs><radialGradient id="g">${Array.from(
    { length: 33 },
    (_, i) =>
      `<stop offset="${i / 32}" stop-color="white" stop-opacity="${wildlifeDensityKernel(((i / 32) * WILDLIFE_DENSITY_OVERLAP) / 2).toFixed(5)}"/>`,
  ).join(
    '',
  )}</radialGradient></defs><circle cx="64" cy="64" r="64" fill="url(#g)"/></svg>`,
)}`;

function tintForStyle(style) {
  if (['mono', 'surveillance', 'thermal', 'noir', 'nvg'].includes(style))
    return MONO_TINT;
  return ['crt', 'retro'].includes(style) ? CRT_TINT : NORMAL_TINT;
}

function intersects(bounds, boxes, padding = 0) {
  if (!boxes?.length) return true;
  const latitude = (bounds.north - bounds.south) * padding;
  const longitude = (bounds.east - bounds.west) * padding;
  for (const box of boxes) {
    if (
      bounds.north + latitude < box.south ||
      bounds.south - latitude > box.north
    )
      continue;
    // Both a padded splat and the viewport can straddle the antimeridian.
    const east = box.east < box.west ? box.east + 360 : box.east;
    const left = bounds.west - longitude;
    const right = bounds.east + longitude;
    if (
      (right >= box.west && left <= east) ||
      (right + 360 >= box.west && left + 360 <= east) ||
      (right - 360 >= box.west && left - 360 <= east)
    )
      return true;
  }
  return false;
}

// Fit the entire kernel inside the globe's tangent cone, plus 5% of its radius.
// A visible centre alone lets a depth-free billboard bleed across the limb.
// The inscribed sphere is conservative for WGS84 and needs no projections.
function horizonTest(cameraPosition, radius) {
  const { x, y, z } = cameraPosition || {};
  const distance = Math.hypot(x, y, z);
  if (!Number.isFinite(distance) || distance <= radius) return null;
  const nx = x / distance;
  const ny = y / distance;
  const nz = z / distance;
  const sinAngle = radius / distance;
  const cosAngleSquared = 1 - sinAngle ** 2;
  const horizonPlane = radius * sinAngle;
  return (position, kernelRadius) => {
    const along = position.x * nx + position.y * ny + position.z * nz;
    if (along <= horizonPlane) return false;
    const clearance = sinAngle * (distance - along) - kernelRadius * 1.05;
    const acrossSquared = Math.max(
      0,
      position.x ** 2 + position.y ** 2 + position.z ** 2 - along ** 2,
    );
    return clearance > 0 && acrossSquared * cosAngleSquared < clearance ** 2;
  };
}

/**
 * A splat's drawn width, CSS pixels: the kernel spans
 * `WILDLIFE_DENSITY_OVERLAP` grid cells, and the grid is chosen so a cell
 * is about `WILDLIFE_GRID_SAMPLE_SPACING_PX` wide on screen.
 */
export const WILDLIFE_DENSITY_SPLAT_PX =
  WILDLIFE_DENSITY_OVERLAP * WILDLIFE_GRID_SAMPLE_SPACING_PX;

let glowSets = 0;

/**
 * The splats as an unpickable icons draw set under every sprite layer:
 * each splat a pixel-sized radial kernel drawn over depth. Positions are
 * ECEF metres, colours `[r, g, b, a]` in 0..1.
 */
function createGlowIcons(viewer, { image }) {
  const set = drawOf(viewer).icons({
    id: `wildlife-sightings:${++glowSets}:density`,
    pickable: false,
    drawOrder: spriteDrawOrder('cctv') - 1,
  });
  const points = createWildlifeIconCollection(set);
  let ids = 0;
  return {
    add({ position, color }) {
      return points.add({
        id: `density:${++ids}`,
        position,
        image,
        size: [WILDLIFE_DENSITY_SPLAT_PX, WILDLIFE_DENSITY_SPLAT_PX],
        color,
        disableDepthTest: Number.POSITIVE_INFINITY,
        pickable: false,
      });
    },
    setPosition(point, position) {
      point.position = position;
    },
    setColor(point, color) {
      point.color = color;
    },
    remove(point) {
      points.remove(point);
    },
    get length() {
      return points.length;
    },
    flush: () => points.flush(),
    destroy() {
      // Drops the batched writes too, so none reaches the disposed set.
      points.dispose();
    },
  };
}

/** The WGS84 polar radius, the inscribed sphere the horizon test fits in. */
const MINIMUM_RADIUS = 6_356_752.314245;

/** Own noninteractive, world-sized glow splats, arrival fades and style changes. */
export function createWildlifeDensity({
  viewer,
  createGlow = createGlowIcons,
  positionForCell = (cell) => fromDegrees(cell.lon, cell.lat),
  requestRender = () => {},
  setTimer = (fn, delay) => setTimeout(fn, delay),
  clearTimer = (timer) => clearTimeout(timer),
  requestIdle,
  cancelIdle,
  eventTarget = globalThis.window,
  documentRef = globalThis.document,
} = {}) {
  let collection = null;
  /** Send the splats' batched writes, then ask for the frame that shows them. */
  const render = (reason) => {
    collection?.flush();
    requestRender(reason);
  };
  let metadata = new WeakMap();
  const entries = new Map();
  const fading = new Set();
  let fadeTimer = null;
  let destroyed = false;
  let generation = 0;
  let cockpitVision = false;
  let tint = tintForStyle(documentRef?.documentElement?.dataset?.gevStyle);
  let listening = false;
  const fadeQueue = createWildlifeWorkQueue({ requestIdle, cancelIdle });
  const styleQueue = createWildlifeWorkQueue({ requestIdle, cancelIdle });

  function color(entry) {
    const mix = (i) => tint.low[i] + (tint.high[i] - tint.low[i]) * entry.rank;
    return [
      mix(0),
      mix(1),
      mix(2),
      (wildlifeDensityIntensity(entry.rank) * entry.opacity * entry.fade) /
        FADE_STEPS,
    ];
  }

  function* styleWork() {
    let visits = 0;
    for (const entry of entries.values()) {
      if (visits++ % WILDLIFE_WORK_UNIT === 0) yield 'density-style';
      collection.setColor(entry.point, color(entry));
    }
  }

  function setStyle(style) {
    const next = tintForStyle(style);
    if (next === tint) return;
    tint = next;
    if (entries.size)
      styleQueue.start(styleWork(), () => render('density-style'));
  }

  function onStyle(event) {
    if (!cockpitVision) setStyle(event?.detail?.style);
  }

  function onVision(event) {
    cockpitVision = event?.detail?.cockpit === true;
    setStyle(event?.detail?.style);
  }

  /** The splat collection, made on first use. */
  function ensureCollection() {
    if (collection) return collection;
    collection = createGlow(viewer, { image: DENSITY_IMAGE });
    if (!listening) {
      tint = tintForStyle(documentRef?.documentElement?.dataset?.gevStyle);
      eventTarget?.addEventListener?.('gev:style-change', onStyle);
      eventTarget?.addEventListener?.('gev:vision-change', onVision);
      listening = true;
    }
    return collection;
  }

  function* fadeWork() {
    let visits = 0;
    for (const entry of fading) {
      if (visits++ % WILDLIFE_WORK_UNIT === 0) yield 'density-fade';
      entry.fade++;
      collection.setColor(entry.point, color(entry));
      if (entry.fade >= FADE_STEPS) fading.delete(entry);
    }
  }

  function scheduleFade() {
    if (fadeTimer !== null || fadeQueue.pending || !fading.size || destroyed)
      return;
    fadeTimer = setTimer(() => {
      fadeTimer = null;
      fadeQueue.start(fadeWork(), () => {
        render('density-fade');
        scheduleFade();
      });
    }, FADE_STEP_MS);
  }

  function dataForCell(cell, operations) {
    if (
      !cell ||
      !Number.isFinite(cell.lat) ||
      Math.abs(cell.lat) > 90 ||
      !Number.isFinite(cell.lon) ||
      Math.abs(cell.lon) > 180 ||
      !Number.isSafeInteger(cell.cellCount) ||
      cell.cellCount <= 0
    )
      return null;
    const old = metadata.get(cell);
    if (
      old?.id === cell.id &&
      old.lat === cell.lat &&
      old.lon === cell.lon &&
      old.count === cell.cellCount
    )
      return old;
    const bounds =
      old?.id === cell.id ? old.bounds : wildlifeGridCellBounds(cell.id);
    if (!bounds) return null;
    const samePosition = old?.lat === cell.lat && old?.lon === cell.lon;
    const data = {
      id: cell.id,
      lat: cell.lat,
      lon: cell.lon,
      count: cell.cellCount,
      bounds,
      width:
        WILDLIFE_DENSITY_OVERLAP *
        METERS_PER_DEGREE *
        Math.max(
          (bounds.east - bounds.west) * Math.cos((cell.lat * Math.PI) / 180),
          bounds.north - bounds.south,
        ),
      position: samePosition ? old.position : positionForCell(cell),
    };
    operations.densityMetadataBuilds++;
    if (!samePosition) operations.densityPositionBuilds++;
    metadata.set(cell, data);
    return data;
  }

  /** Reconcile the authoritative snapshot, including successful empty tiles. */
  function* updateWork(
    cells = [],
    { boxes, isPointVisible, onOperations = () => {} } = {},
  ) {
    const token = ++generation;
    const operations = {
      densityVisits: 0,
      densityRetirementVisits: 0,
      densityMetadataBuilds: 0,
      densityPositionBuilds: 0,
      densityWrites: 0,
      densityCreated: 0,
      densityRemoved: 0,
    };
    let sightingCount = 0;
    let changed = false;
    const pose = findCamera(viewer)?.pose();
    const height = pose?.height ?? 0;
    const opacity = Math.max(
      0,
      Math.min(
        1,
        (ALTITUDE_FADE_END - height) /
          (ALTITUDE_FADE_END - ALTITUDE_FADE_START),
      ),
    );
    const insideHorizon = horizonTest(pose?.position, MINIMUM_RADIUS);
    const rankOf = wildlifeDensityRanks(cells);
    for (const cell of cells) {
      if (operations.densityVisits++ % WILDLIFE_WORK_UNIT === 0) {
        yield 'density';
        if (destroyed || token !== generation)
          return { sightingCount: 0, changed: false, size: entries.size };
      }
      const data = dataForCell(cell, operations);
      if (
        !data ||
        !intersects(data.bounds, boxes, (WILDLIFE_DENSITY_OVERLAP - 1) / 2) ||
        isPointVisible?.(data.position) === false
      )
        continue;
      if (intersects(data.bounds, boxes))
        sightingCount = Math.min(
          Number.MAX_SAFE_INTEGER,
          sightingCount + data.count,
        );
      // These are visual decisions only; counts retain every visible cell.
      if (
        opacity === 0 ||
        insideHorizon?.(data.position, data.width / 2) === false
      )
        continue;
      const rank = rankOf(data.count);
      let entry = entries.get(data.id);
      if (!entry) {
        ensureCollection();
        entry = { data, rank, opacity, fade: 1, seen: token, point: null };
        entry.point = collection.add({
          position: data.position,
          color: color(entry),
        });
        entries.set(data.id, entry);
        fading.add(entry);
        operations.densityCreated++;
        changed = true;
      } else {
        entry.seen = token;
        if (entry.data.position !== data.position) {
          collection.setPosition(entry.point, data.position);
          operations.densityWrites++;
          changed = true;
        }
        if (entry.rank !== rank || entry.opacity !== opacity) {
          entry.rank = rank;
          entry.opacity = opacity;
          collection.setColor(entry.point, color(entry));
          operations.densityWrites++;
          changed = true;
        }
        entry.data = data;
      }
    }
    for (const [id, entry] of entries) {
      if (operations.densityRetirementVisits++ % WILDLIFE_WORK_UNIT === 0) {
        yield 'density';
        if (destroyed || token !== generation)
          return { sightingCount: 0, changed: false, size: entries.size };
      }
      if (entry.seen === token) continue;
      collection.remove(entry.point);
      fading.delete(entry);
      entries.delete(id);
      operations.densityRemoved++;
      changed = true;
    }
    if (!entries.size && collection) clear(true);
    else scheduleFade();
    if (changed) render('density');
    onOperations(operations);
    return { sightingCount, changed, size: entries.size };
  }

  /** Release the texture atlas, billboards, cached coordinates and all work. */
  function clear(keepMetadata = false) {
    generation++;
    fadeQueue.cancel();
    styleQueue.cancel();
    if (fadeTimer !== null) clearTimer(fadeTimer);
    fadeTimer = null;
    entries.clear();
    fading.clear();
    if (!keepMetadata) metadata = new WeakMap();
    if (collection) {
      collection.destroy();
      collection = null;
    }
    if (listening) {
      eventTarget?.removeEventListener?.('gev:style-change', onStyle);
      eventTarget?.removeEventListener?.('gev:vision-change', onVision);
      listening = false;
    }
    cockpitVision = false;
  }

  return {
    updateWork,
    update: (cells, options) => drainWildlifeWork(updateWork(cells, options)),
    /** Send the glow's batched writes to its set now. */
    flush: () => collection?.flush?.(),
    clear,
    destroy() {
      clear();
      destroyed = true;
    },
    get collection() {
      return collection;
    },
    get size() {
      return entries.size;
    },
  };
}
