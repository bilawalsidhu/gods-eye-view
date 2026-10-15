import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { tileLocalToLonLat } from '../../tileMath.js';
import {
  DECODE_SLICE_MS,
  OVERVIEW_BINS_PER_AXIS,
  SIMPLIFY_TOLERANCE_UNITS,
  panoramaxTimeMs,
} from './policy.js';

/**
 * Douglas–Peucker in tile units: the points of `line` ({x, y}) that keep
 * it within `tolerance` of the original (measured to each segment, so
 * dead ends and U-turns stay), first and last always kept.
 * Iterative, so a long track cannot overflow the stack.
 */
export function simplifyLine(line, tolerance) {
  if (line.length < 3 || !(tolerance > 0)) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const spans = [[0, line.length - 1]];
  while (spans.length) {
    const [from, to] = spans.pop();
    const a = line[from];
    const b = line[to];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const span2 = dx * dx + dy * dy;
    let far = -1;
    let farthest = tolerance;
    for (let i = from + 1; i < to; i++) {
      const p = line[i];
      // Distance to the segment, not the infinite line: a dead end or a
      // U-turn (a point beyond the chord's ends) is kept.
      const t = span2
        ? Math.max(
            0,
            Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span2),
          )
        : 0;
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (d > farthest) {
        farthest = d;
        far = i;
      }
    }
    if (far === -1) continue;
    keep[far] = 1;
    spans.push([from, far], [far, to]);
  }
  return line.filter((_, i) => keep[i]);
}

/** Epoch ms of a sequence's day ('2025-08-11'), or 0 when undated. */
function dayMs(value) {
  return panoramaxTimeMs(typeof value === 'string' ? value : '') ?? 0;
}

/**
 * Decode a Panoramax coverage tile (`/api/map/{z}/{x}/{y}.mvt`).
 *
 * - `sequences` (z7–15): one line per sequence, its parts kept apart so no
 *   segment is drawn across a gap, with its day and camera type; longest
 *   first, so a cap on lines drawn drops the shortest.
 * - `grid` (z0–6): picture-density cells, as overview points binned to at
 *   most OVERVIEW_BINS_PER_AXIS² a tile (a z0 tile holds ~70,000 cells). A
 *   cell has 360° and flat counts but no date.
 * - `pictures` (z15) is left for `decodePictures`.
 *
 * In one go; `decodeCoverageTileSliced` gives the page a turn between
 * slices.
 * @param {Uint8Array} bytes
 * @param {{x: number, y: number, z: number}} address
 * @returns {{sequences: Array<{id: string, parts: Array<Array<[number, number]>>, capturedAt: number, isPano: boolean}>, overview: Array<{id: string, lon: number, lat: number, capturedAt: null, isPano: boolean, hasPano: boolean, hasFlat: boolean, weight: number}>}}
 */
export function decodeCoverageTile(bytes, address) {
  const steps = coverageSteps(bytes, address);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Give the page a turn: input and rendering run before the next slice. */
function nextTask() {
  if (typeof globalThis.scheduler?.yield === 'function')
    return globalThis.scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * `decodeCoverageTile` in slices of about `sliceMs`, the page getting a
 * turn between them: a 2 MB z10 tile over Paris is ~200 ms of decoding on
 * a fast laptop, more on a phone, and would freeze the globe while the
 * camera approaches. Stops at the next slice once `signal` aborts.
 * @param {Uint8Array} bytes
 * @param {{x: number, y: number, z: number}} address
 * @param {{signal?: AbortSignal, sliceMs?: number, pause?: () => Promise<void>, now?: () => number}} [options]
 */
export async function decodeCoverageTileSliced(
  bytes,
  address,
  {
    signal,
    sliceMs = DECODE_SLICE_MS,
    pause = nextTask,
    now = () => performance.now(),
  } = {},
) {
  const steps = coverageSteps(bytes, address);
  let started = now();
  let step = steps.next();
  while (!step.done) {
    if (now() - started >= sliceMs) {
      await pause();
      signal?.throwIfAborted();
      started = now();
    }
    step = steps.next();
  }
  return step.value;
}

/** The decode, a step a feature (see `decodeCoverageTile`). */
function* coverageSteps(bytes, address) {
  const result = { sequences: [], overview: [] };
  if (!bytes || !bytes.length) return result;
  const tile = new VectorTile(new PbfReader(bytes));
  const { x, y, z } = address;

  const sequences = tile.layers.sequences;
  if (sequences) {
    const measured = [];
    for (let i = 0; i < sequences.length; i++) {
      const feature = sequences.feature(i);
      const props = feature.properties || {};
      const parts = [];
      let length = 0;
      const tolerance = (SIMPLIFY_TOLERANCE_UNITS * sequences.extent) / 4096;
      for (const line of feature.loadGeometry()) {
        if (line.length < 2) continue;
        for (let k = 1; k < line.length; k++)
          length += Math.hypot(
            line[k].x - line[k - 1].x,
            line[k].y - line[k - 1].y,
          );
        // Simplified before anything else: GPS tracks carry a point every
        // few metres, and each becomes ~8 ground-line vertices on the GPU.
        parts.push(
          simplifyLine(line, tolerance).map((point) =>
            tileLocalToLonLat(point.x, point.y, sequences.extent, x, y, z),
          ),
        );
      }
      if (!parts.length || props.id == null) continue;
      const sequence = {
        id: String(props.id),
        parts,
        capturedAt: dayMs(props.date),
        // A sequence with no camera type is neither (the filters keep it).
        isPano:
          props.type === 'equirectangular'
            ? true
            : props.type === 'flat'
              ? false
              : null,
      };
      measured.push({ sequence, length });
      yield;
    }
    // A turn before the sort: over a city it is thousands of lines.
    yield;
    measured.sort((a, b) => b.length - a.length);
    result.sequences = measured.map(({ sequence }) => sequence);
  }

  const grid = tile.layers.grid;
  if (grid) {
    const bins = new Map();
    const size = grid.extent / OVERVIEW_BINS_PER_AXIS;
    for (let i = 0; i < grid.length; i++) {
      const feature = grid.feature(i);
      const props = feature.properties || {};
      const point = feature.loadGeometry()?.[0]?.[0];
      if (i % 64 === 63) yield;
      if (!point) continue;
      const pano = Number(props.nb_360_pictures) || 0;
      const flat = Number(props.nb_flat_pictures) || 0;
      const weight = Number(props.nb_pictures) || pano + flat;
      if (weight <= 0) continue;
      const key = `${Math.floor(point.x / size)}:${Math.floor(point.y / size)}`;
      const bin = bins.get(key);
      if (!bin) {
        bins.set(key, { point, weight, pano, flat, top: weight });
        continue;
      }
      // The bin sits on its busiest cell and counts them all.
      bin.weight += weight;
      bin.pano += pano;
      bin.flat += flat;
      if (weight > bin.top) {
        bin.top = weight;
        bin.point = point;
      }
    }
    for (const [key, bin] of bins) {
      const [lon, lat] = tileLocalToLonLat(
        bin.point.x,
        bin.point.y,
        grid.extent,
        x,
        y,
        z,
      );
      result.overview.push({
        id: `${z}/${x}/${y}/${key}`,
        lon,
        lat,
        capturedAt: null,
        isPano: bin.pano > bin.flat,
        hasPano: bin.pano > 0,
        hasFlat: bin.flat > 0,
        weight: bin.weight,
      });
    }
  }
  return result;
}

/** A picture's sequence ids: the tile stores them as a JSON array in a string. */
function sequenceIdsOf(props) {
  const raw = props.sequences;
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) return ids.map(String);
    } catch {
      /* fall through to the first sequence */
    }
  }
  return props.first_sequence != null ? [String(props.first_sequence)] : [];
}

/**
 * The pictures of a z15 tile that belong to `sequenceId`, as cones draw
 * them (unsorted).
 * @param {Uint8Array} bytes
 * @param {{x: number, y: number, z: number}} address
 * @param {string} sequenceId
 * @returns {Array<{id: string, lon: number, lat: number, compassAngle: number, capturedAt: number, isPano: boolean}>}
 */
export function decodePictures(bytes, address, sequenceId) {
  if (!bytes || !bytes.length) return [];
  const tile = new VectorTile(new PbfReader(bytes));
  const layer = tile.layers.pictures;
  if (!layer) return [];
  const { x, y, z } = address;
  const wanted = String(sequenceId);
  const out = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const props = feature.properties || {};
    // A cheap test first: most pictures in a tile are other sequences'.
    if (
      typeof props.sequences === 'string' &&
      !props.sequences.includes(wanted)
    )
      continue;
    if (!sequenceIdsOf(props).includes(wanted) || props.id == null) continue;
    const point = feature.loadGeometry()?.[0]?.[0];
    if (!point) continue;
    const [lon, lat] = tileLocalToLonLat(
      point.x,
      point.y,
      layer.extent,
      x,
      y,
      z,
    );
    const heading = Number(props.heading);
    out.push({
      id: String(props.id),
      lon,
      lat,
      compassAngle: Number.isFinite(heading) ? heading : 0,
      capturedAt: panoramaxTimeMs(String(props.ts ?? '')) ?? 0,
      isPano: props.type === 'equirectangular',
    });
  }
  return out;
}
