/**
 * The Fire Perimeters layer's draw sets: each fire one fill, its outer edge
 * a bright line over a dark halo, and a flame marker for far zoom.
 */
import { fromDegrees } from '../../geo/ellipsoid.js';
import { hexColor } from '../../render/color.js';
import { msg } from '../../i18n/index.js';
import { outerEdges } from './edges.js';

/** The legend's one row: the burned area, in the fill's colour. */
export const PERIMETER_LEGEND = Object.freeze({
  color: '#f2541b',
  label: msg('Burned area'),
});

/** Every piece's fill, whatever its age. */
export const PERIMETER_FILL = hexColor('#f2541b', 0.47);
/** Every fire's edge, and the dark halo under it. */
export const PERIMETER_EDGE = Object.freeze({
  widthPx: 2.5,
  style: { kind: 'solid', color: hexColor('#ff7b3a', 1) },
});
export const PERIMETER_HALO = {
  widthPx: 6.5,
  style: { kind: 'solid', color: hexColor('#160904', 0.7) },
};

/**
 * Draw order of each kind of set: halos over fills, edges over halos, so
 * every fire's edge draws over every fill (draw.d.ts `SetSpec.drawOrder`).
 */
export const PERIMETER_DRAW_ORDER = Object.freeze({
  fills: 0,
  halos: 1,
  lines: 2,
});

/**
 * Fills are kept in sets by when they were first drawn: a new piece goes
 * into the newest set, so a timeline step rebuilds that one (a renderer may
 * rebuild a whole set for one item changed). A set takes new pieces until
 * it holds a `FILL_SHARE`th of all the fill vertices drawn, and at least
 * `FILL_MIN_VERTICES`: the sets stay few, as each costs draw calls every
 * frame (scripts/qa-perimeters-perf.mjs).
 */
const FILL_SHARE = 16;
export const FILL_MIN_VERTICES = 6000;
/**
 * Edges are kept in groups of whole fires, as a fire's edge changes as a
 * whole when it grows: a new fire joins the smallest group with room for
 * its edge (a `LINE_SHARE`th of all the edge vertices, at least
 * `LINE_MIN_VERTICES`), else starts one. A change to one fire writes only
 * its group's edge sets.
 */
const LINE_SHARE = 8;
export const LINE_MIN_VERTICES = 6000;

/** Marker sizes, CSS pixels: by acres, from 100 acres up to a million. */
const MARKER_PX = Object.freeze({ min: 14, max: 34, unknown: 16 });
/**
 * Markers show from this eye distance out, metres; nearer, the perimeter
 * takes over. Labels (`PERIMETER_LABEL_RANGE_M`) show from here too.
 */
export const PERIMETER_MARKER_FROM_M = 120_000;
const FLAME_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="80" viewBox="0 0 64 80"><path d="M33 3c4 14 21 23 21 45a22 22 0 0 1-44 0c0-11 6-18 11-23 0 8 4 13 9 15-3-13 0-25 3-37z" fill="#f2541b" stroke="#160904" stroke-width="4" stroke-linejoin="round"/><path d="M32 40c4 6 11 10 11 18a11 11 0 0 1-22 0c0-7 5-11 11-18z" fill="#ffd3ad"/></svg>`;
const FLAME = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(FLAME_SVG)}`;

const PICK_PREFIX = 'fire-perimeter:';

const ringDegrees = (ring) => ring.map(([lon, lat]) => ({ lon, lat }));
const validLine = (line, min) =>
  Array.isArray(line) &&
  line.length >= min &&
  line.every(
    (point) =>
      Array.isArray(point) &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]),
  );

/** A fire's marker width for its `acres`, CSS pixels (1.25 times as tall). */
export function perimeterMarkerPx(acres) {
  if (!Number.isFinite(acres) || acres <= 0) return MARKER_PX.unknown;
  const { min, max } = MARKER_PX;
  const t = Math.min(1, Math.max(0, (Math.log10(acres) - 2) / 4));
  return Math.round(min + (max - min) * t);
}

/**
 * The draw sets of one layer, on `draw` (draw.d.ts `DrawPort`), their ids
 * starting `prefix`. `show()` says whether new sets show.
 */
export function createPerimeterDrawing({ draw, prefix, show }) {
  let count = 0;
  /**
   * Fill sets, oldest first: `{set, vertices, pieces}`, the vertices they
   * hold, and their pieces by key, in draw order.
   */
  let chunks = [];
  /**
   * Edge groups, oldest first: `{fires, vertices, halos, lines}`, the
   * fires' ids, the edge vertices they hold, and their two sets.
   */
  let groups = [];
  const groupOf = new Map();
  /** Each fire's edge as drawn: `{lines, halos, vertices}`, by fire id. */
  const edges = new Map();
  /**
   * Each drawn piece by key: `{fireId, base, fills, polygons, outline,
   * vertices, chunk}`, with its valid rings and lines in degrees.
   */
  const drawn = new Map();
  let markers = null;
  let markersKey = null;

  function makeSet(kind) {
    const spec = {
      id: `${prefix}:${count++}:${kind}`,
      clampTo: 'both',
      show: show(),
    };
    if (kind === 'markers')
      return draw.icons({ id: spec.id, show: spec.show, horizonCull: true });
    spec.drawOrder = PERIMETER_DRAW_ORDER[kind];
    return kind === 'fills' ? draw.shapes(spec) : draw.lines(spec);
  }

  /** A piece's valid parts and fills, its fills named by `nextId()`. */
  function pieceParts(piece, base, nextId) {
    const polygons = (
      Array.isArray(piece.polygons) ? piece.polygons : []
    ).filter(
      (rings) =>
        Array.isArray(rings) && rings.every((ring) => validLine(ring, 3)),
    );
    const outline = (Array.isArray(piece.outline) ? piece.outline : []).filter(
      (line) => validLine(line, 2),
    );
    const meta = { fireId: piece.fireId };
    const fills = polygons.map((rings) => ({
      id: nextId(),
      meta,
      geometry: { kind: 'polygon', rings: rings.map(ringDegrees) },
      fill: PERIMETER_FILL,
      height: 'clampGround',
    }));
    let vertices = 0;
    for (const rings of polygons)
      for (const ring of rings) vertices += ring.length;
    return {
      fireId: piece.fireId,
      base,
      fills,
      polygons,
      outline,
      vertices,
      chunk: null,
    };
  }

  /**
   * A fire's edge: its pieces' lines (`list`, in snapshot order) cut to its
   * outer edge (edges.js), with a halo under each.
   * `idOf(part, kind)` names each, `kind` `'line:'` or `'halo:'`.
   */
  function fireEdge(list, idOf) {
    const runs = outerEdges(list);
    const lines = [];
    const halos = [];
    let vertices = 0;
    for (const [index, part] of list.entries()) {
      const meta = { fireId: part.fireId };
      for (const run of runs[index]) {
        const positions = run.map(([lon, lat]) => fromDegrees(lon, lat));
        vertices += positions.length;
        for (const [into, look, kind] of [
          [halos, PERIMETER_HALO, 'halo:'],
          [lines, PERIMETER_EDGE, 'line:'],
        ])
          into.push({
            id: idOf(part, kind),
            meta,
            positions,
            widthPx: look.widthPx,
            mode: 'draped',
            style: look.style,
          });
      }
    }
    return { lines, halos, vertices };
  }

  /** Write a group's two edge sets from its fires' edges. */
  function writeGroup(group) {
    for (const kind of ['halos', 'lines']) {
      const items = [];
      for (const fire of group.fires) items.push(...edges.get(fire)[kind]);
      if (!items.length && !group[kind]) continue;
      group[kind] ??= makeSet(kind);
      group[kind].set(items);
    }
  }

  function eachSet(fn) {
    for (const chunk of chunks) if (chunk.set) fn(chunk.set);
    for (const group of groups)
      for (const kind of ['halos', 'lines']) if (group[kind]) fn(group[kind]);
    if (markers) fn(markers);
  }

  /** Let go of every perimeter set (the markers stay). */
  function dropPerimeters() {
    for (const chunk of chunks) chunk.set?.dispose();
    for (const group of groups)
      for (const kind of ['halos', 'lines']) group[kind]?.dispose();
    chunks = [];
    groups = [];
    groupOf.clear();
    edges.clear();
    drawn.clear();
  }

  /**
   * Every piece drawn again into one set of each kind (the same sets each
   * time, so the last picture draws until the new one is ready), its items
   * named `fire-perimeter:<fire>:<n>`, `…:<fire>:line:<n>` and
   * `…:<fire>:halo:<n>`. After `drawChanges`, call `dropPerimeters()`
   * first.
   */
  function drawAll(pieces) {
    const counts = new Map();
    const nextId = (fireId, kind) => {
      const key = `${kind}${fireId}`;
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      return `${PICK_PREFIX}${fireId}:${kind}${n}`;
    };
    const byFire = new Map();
    const fills = [];
    for (const [index, piece] of pieces.entries()) {
      const part = pieceParts(piece, null, () => nextId(piece.fireId, ''));
      fills.push(...part.fills);
      if (!byFire.has(piece.fireId)) byFire.set(piece.fireId, []);
      byFire.get(piece.fireId).push(part);
    }
    if (!chunks.length)
      chunks.push({ set: makeSet('fills'), vertices: 0, pieces: new Map() });
    chunks[0].set.set(fills);
    if (!groups.length)
      groups.push({ fires: new Set(), vertices: 0, halos: null, lines: null });
    const [group] = groups;
    group.fires.clear();
    edges.clear();
    for (const [fireId, list] of byFire) {
      edges.set(
        fireId,
        fireEdge(list, (part, kind) => nextId(part.fireId, kind)),
      );
      group.fires.add(fireId);
    }
    writeGroup(group);
  }

  /**
   * Only what changed since the last draw, by piece key (`keys`, one a
   * piece). A fill gone is removed, a new one goes where the snapshot's
   * order puts it: after every drawn piece, into the newest fill set (see
   * `FILL_SHARE`); ahead of a drawn piece, into that piece's set, then
   * written whole in the snapshot's order (a later piece draws over an
   * earlier). A fire with a piece added or gone has its
   * edge drawn again, in its group's sets only (see `LINE_SHARE`). Items
   * are named `fire-perimeter:<fire>:<piece>:<n>` (fills), `…:line:<n>` and
   * `…:halo:<n>`, `<piece>` URI-encoded. Returns the pieces added and
   * removed.
   */
  function drawChanges(pieces, keys) {
    const listed = new Set(keys);
    // Fires whose edge is drawn again.
    const dirty = new Set();
    /** Per fill set: the fills removed, those to draw, and whether whole. */
    const edits = new Map();
    const editOf = (chunk) => {
      let edit = edits.get(chunk);
      if (!edit) {
        edit = { removed: [], drawn: [], whole: false };
        edits.set(chunk, edit);
      }
      return edit;
    };
    let removed = 0;
    for (const [key, part] of drawn) {
      if (listed.has(key)) continue;
      drawn.delete(key);
      removed += 1;
      dirty.add(part.fireId);
      const { chunk } = part;
      if (!chunk) continue;
      chunk.pieces.delete(key);
      chunk.vertices -= part.vertices;
      editOf(chunk).removed.push(...part.fills);
    }
    // For each piece, the fill set of the nearest piece after it that is
    // drawn already: a new piece goes in there, ahead of it.
    const after = new Array(pieces.length);
    let next = null;
    for (let index = pieces.length - 1; index >= 0; index--) {
      after[index] = next;
      next = drawn.get(keys[index])?.chunk ?? next;
    }
    const fresh = [];
    let total = 0;
    for (const chunk of chunks) total += chunk.vertices;
    for (const [index, piece] of pieces.entries()) {
      const key = keys[index];
      if (drawn.has(key)) continue;
      const base = `${PICK_PREFIX}${piece.fireId}:${encodeURIComponent(piece.id)}:`;
      let n = 0;
      const made = pieceParts(piece, base, () => `${base}${n++}`);
      fresh.push({ index, key, part: made });
      total += made.vertices;
      dirty.add(piece.fireId);
    }
    const room = Math.max(FILL_MIN_VERTICES, total / FILL_SHARE);
    for (const { index, key, part } of fresh) {
      drawn.set(key, part);
      if (!part.fills.length) continue;
      let chunk = after[index];
      if (chunk) editOf(chunk).whole = true;
      else {
        chunk = chunks.at(-1);
        if (!chunk || chunk.vertices >= room) {
          chunk = { set: null, vertices: 0, pieces: new Map() };
          chunks.push(chunk);
        }
      }
      part.chunk = chunk;
      chunk.pieces.set(key, part);
      chunk.vertices += part.vertices;
      editOf(chunk).drawn.push(...part.fills);
    }
    // A set a piece went into ahead of drawn ones takes the snapshot's order.
    const reordered = new Map();
    for (const [chunk, { whole }] of edits)
      if (whole) reordered.set(chunk, new Map());
    if (reordered.size) {
      for (const key of keys) {
        const part = drawn.get(key);
        reordered.get(part.chunk)?.set(key, part);
      }
      for (const [chunk, ordered] of reordered) chunk.pieces = ordered;
    }
    // A fill set left with nothing goes.
    chunks = chunks.filter((chunk) => {
      if (chunk.pieces.size) return true;
      chunk.set?.dispose();
      edits.delete(chunk);
      return false;
    });
    for (const chunk of chunks) chunk.set ??= makeSet('fills');
    for (const [chunk, edit] of edits) {
      const items = () =>
        [...chunk.pieces.values()].flatMap(({ fills }) => fills);
      if (edit.whole || (edit.removed.length && edit.drawn.length))
        // Removes and upserts may each rebuild the set: one set does both.
        chunk.set.set(items());
      else if (edit.removed.length)
        chunk.set.remove(edit.removed.map(({ id }) => id));
      else chunk.set.upsert(edit.drawn);
    }
    if (dirty.size) drawEdges(dirty, keys);
    return { added: fresh.length, removed };
  }

  /** Draw the edges of the `dirty` fires again, in their groups' sets. */
  function drawEdges(dirty, keys) {
    const byFire = new Map();
    for (const key of keys) {
      const part = drawn.get(key);
      if (!dirty.has(part.fireId)) continue;
      if (!byFire.has(part.fireId)) byFire.set(part.fireId, []);
      byFire.get(part.fireId).push(part);
    }
    const touched = new Set();
    const placing = [];
    for (const fireId of dirty) {
      const group = groupOf.get(fireId);
      const was = edges.get(fireId);
      const list = byFire.get(fireId);
      if (!list) {
        if (group) {
          group.vertices -= was.vertices;
          group.fires.delete(fireId);
          groupOf.delete(fireId);
          touched.add(group);
        }
        edges.delete(fireId);
        continue;
      }
      const counts = new Map();
      const edge = fireEdge(list, (part, kind) => {
        const key = `${part.base}${kind}`;
        const n = counts.get(key) ?? 0;
        counts.set(key, n + 1);
        return `${key}${n}`;
      });
      edges.set(fireId, edge);
      if (group) {
        group.vertices += edge.vertices - was.vertices;
        touched.add(group);
      } else placing.push(fireId);
    }
    let total = 0;
    for (const { vertices } of edges.values()) total += vertices;
    const room = Math.max(LINE_MIN_VERTICES, total / LINE_SHARE);
    for (const fireId of placing) {
      const need = edges.get(fireId).vertices;
      let group = null;
      for (const other of groups)
        if (
          other.vertices + need <= room &&
          (!group || other.vertices < group.vertices)
        )
          group = other;
      if (!group) {
        group = { fires: new Set(), vertices: 0, halos: null, lines: null };
        groups.push(group);
      }
      group.fires.add(fireId);
      group.vertices += need;
      groupOf.set(fireId, group);
      touched.add(group);
    }
    // A group left with no fire goes with its sets.
    for (const group of touched)
      if (group.fires.size) writeGroup(group);
      else for (const kind of ['halos', 'lines']) group[kind]?.dispose();
    groups = groups.filter((group) => group.fires.size);
  }

  /**
   * A flame marker at each fire's card anchor (`fires`, by id), sized by
   * its acres, shown from `PERIMETER_MARKER_FROM_M` out; written only when
   * a fire, its acres or its anchor changed.
   */
  function drawMarkers(fires) {
    const items = [];
    const key = [];
    for (const fire of fires.values()) {
      const px = perimeterMarkerPx(fire.acres);
      const { lon, lat } = fire.anchor;
      key.push(`${fire.id}\n${px}\n${lon}\n${lat}`);
      items.push({
        id: `${PICK_PREFIX}${fire.id}:marker`,
        meta: { fireId: fire.id },
        pos: fromDegrees(lon, lat),
        height: 'clampGround',
        image: FLAME,
        size: [px, Math.round(px * 1.25)],
        anchor: 'bottom',
        displayRange: [PERIMETER_MARKER_FROM_M, Infinity],
        disableDepthTest: Infinity,
      });
    }
    const joined = key.join('\n\n');
    if (joined === markersKey) return;
    markersKey = joined;
    markers ??= makeSet('markers');
    markers.set(items);
  }

  return {
    drawAll,
    drawChanges,
    drawMarkers,
    eachSet,
    /** Let go of every set, the markers too. */
    dispose() {
      dropPerimeters();
      markers?.dispose();
      markers = null;
      markersKey = null;
    },
    dropPerimeters,
  };
}
