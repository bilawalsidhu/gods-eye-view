// Directions on the globe contract, the same on every engine:
// - the route: one engine.ground corridor set (9 px, draped on terrain and
//   3D tiles), its dash cells lit and dim as the route flow material draws
//   them at rest;
// - the maneuver dots: one point mover set over the scene, white with a
//   route-colour outline, picked as `directions:step:<index>`; a dot without
//   a ground anchor yet is hidden;
// - the A and B markers: a point mover set for the discs and a sprite set
//   for their letters, over the scene, at the rendered surface under each
//   marker (sampled again whenever the camera comes to rest);
// - clicks through engine.input with the engine's pick.
// Placement, routing, anchoring, selection and the route flight stay in the
// layer.

import * as geo from '../../../geo/index.js';
import {
  MARKER_COLORS,
  MARKER_LETTER_FONT,
  MARKER_LETTER_OFFSET_PX,
  MARKER_LETTER_OUTLINE_PX,
  MARKER_LETTER_SPRITE_PX,
  MARKER_OUTLINE_COLOR,
  MARKER_OUTLINE_PX,
  MARKER_PIXEL_SIZE,
  ORDER,
  ROUTE_DASH_CELLS,
  ROUTE_DASH_COLOR,
  ROUTE_DASH_DUTY,
  ROUTE_GAP_COLOR,
  ROUTE_WIDTH_PX,
  STEP_COLOR,
  STEP_OUTLINE_COLOR,
  STEP_OUTLINE_PX,
  STEP_PIXEL_SIZE,
  STEP_SELECTED_PIXEL_SIZE,
} from './style.js';

const ID = 'directions';
export const DIRECTIONS_SET_IDS = Object.freeze({
  route: `${ID}-route`,
  steps: `${ID}-steps`,
  markers: `${ID}-markers`,
  letters: `${ID}-marker-letters`,
});
const LETTERS = ['a', 'b'];
const FIRST_STEP_CAPACITY = 16;

/** The pickId of maneuver dot `index`. */
export const stepPickId = (index) => `${ID}:step:${index}`;

const wrapLon = (lon) => ((lon + 540) % 360) - 180;

/**
 * The route cut into its dash cells, lit and dim in turn: each of
 * ROUTE_DASH_CELLS equal lengths along the route is lit for its first
 * ROUTE_DASH_DUTY and dim for the rest. Every original vertex is kept.
 * @param {number[][]} path [lon, lat] pairs.
 * @returns {{ positions: number[][], lit: boolean }[]}
 */
export function routeDashPieces(path) {
  const vertices = path.map(([lon, lat]) =>
    geo.cartesian3.fromDegrees(lon, lat),
  );
  const arc = [0];
  for (let i = 1; i < vertices.length; i++)
    arc.push(
      arc[i - 1] + geo.cartesian3.distance(vertices[i - 1], vertices[i]),
    );
  const total = arc.at(-1);
  if (!(total > 0)) return [];
  // The point at arc length `at` on segment i - 1 .. i.
  const pointAt = (i, at) => {
    const f = Math.max(
      0,
      Math.min(1, (at - arc[i - 1]) / (arc[i] - arc[i - 1] || 1)),
    );
    const [lon, lat] = path[i - 1];
    const [nextLon, nextLat] = path[i];
    const delta = wrapLon(nextLon - lon);
    return [wrapLon(lon + f * delta), lat + f * (nextLat - lat)];
  };
  const cuts = [];
  for (let cell = 0; cell < ROUTE_DASH_CELLS; cell++) {
    cuts.push({ at: (total * (cell + ROUTE_DASH_DUTY)) / ROUTE_DASH_CELLS });
    cuts.push({ at: (total * (cell + 1)) / ROUTE_DASH_CELLS });
  }
  const pieces = [];
  let start = path[0];
  let i = 1;
  cuts.forEach(({ at }, index) => {
    const last = index === cuts.length - 1;
    const positions = [start];
    while (i < path.length - 1 && arc[i] < at) positions.push(path[i++]);
    start = last ? path.at(-1) : pointAt(i, at);
    positions.push(start);
    pieces.push({ positions, lit: index % 2 === 0 });
  });
  return pieces;
}

/** The letters' atlas: one cell per marker, the glyph above its centre. */
function letterAtlas() {
  const document = globalThis.document;
  const canvas = document?.createElement?.('canvas');
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return null;
  const size = MARKER_LETTER_SPRITE_PX;
  canvas.width = size * LETTERS.length;
  canvas.height = size;
  ctx.font = MARKER_LETTER_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = MARKER_LETTER_OUTLINE_PX * 2;
  ctx.strokeStyle = 'black';
  ctx.fillStyle = 'white';
  const cells = {};
  LETTERS.forEach((letter, index) => {
    const x = size * index + size / 2;
    const y = size / 2 - MARKER_LETTER_OFFSET_PX;
    ctx.strokeText(letter.toUpperCase(), x, y);
    ctx.fillText(letter.toUpperCase(), x, y);
    cells[letter] = [
      index / LETTERS.length,
      0,
      (index + 1) / LETTERS.length,
      1,
    ];
  });
  return { canvas, cells };
}

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 */
export function createDirectionsDisplay(engine) {
  if (!engine?.ground || !engine?.movers || !engine?.input)
    throw new TypeError('The Directions display needs a globe engine');
  const markers = engine.movers.createSet({
    id: DIRECTIONS_SET_IDS.markers,
    kind: 'point',
    order: ORDER.markers,
    capacity: LETTERS.length,
    depthTest: 'always',
    pickable: false,
    point: {
      sizePx: MARKER_PIXEL_SIZE,
      outlinePx: MARKER_OUTLINE_PX,
      outlineColor: MARKER_OUTLINE_COLOR,
    },
  });
  const atlas = letterAtlas();
  const letters = atlas
    ? engine.movers.createSet({
        id: DIRECTIONS_SET_IDS.letters,
        kind: 'sprite',
        order: ORDER.letters,
        capacity: LETTERS.length,
        depthTest: 'always',
        pickable: false,
        sprite: { sizePx: MARKER_LETTER_SPRITE_PX, atlas },
      })
    : null;
  let steps = null;
  let stepCapacity = 0;
  let route = null;
  let visible = true;
  let destroyed = false;
  /** Marker letter → { lon, lat } or null. */
  const ends = { a: null, b: null };
  /** Dot rows: { index, position | null }. */
  let stepRows = [];
  let selected = null;

  const own = () => [markers, letters, steps].filter(Boolean);

  // The rendered surface under a marker (tiles, else terrain), without the
  // display's own markers.
  function groundPosition({ lon, lat }) {
    const carto = geo.cartographic.fromDegrees(lon, lat);
    let height;
    try {
      height = engine.surface.sampleHeightDetailed(carto, {
        exclude: own(),
      })?.height;
    } catch {
      height = undefined;
    }
    return geo.cartesian3.fromDegrees(
      lon,
      lat,
      Number.isFinite(height) ? height : 0,
    );
  }

  function placeMarkers() {
    if (destroyed) return;
    LETTERS.forEach((letter, index) => {
      const point = ends[letter];
      const show = visible && Boolean(point);
      const position = point ? groundPosition(point) : undefined;
      markers.set(index, {
        ...(position ? { position } : {}),
        color: MARKER_COLORS[letter],
        show,
      });
      letters?.set(index, {
        ...(position ? { position } : {}),
        cell: letter,
        show,
      });
    });
    markers.setCount(LETTERS.length);
    markers.commit();
    if (letters) {
      letters.setCount(LETTERS.length);
      letters.commit();
    }
  }

  function writeSteps() {
    if (stepRows.length > stepCapacity) {
      steps?.destroy();
      stepCapacity = Math.max(FIRST_STEP_CAPACITY, stepRows.length);
      steps = engine.movers.createSet({
        id: DIRECTIONS_SET_IDS.steps,
        kind: 'point',
        order: ORDER.steps,
        capacity: stepCapacity,
        // The shared ground floor is a coarse cell, and on the photoreal
        // stack the rendered mesh can stand above it: the dots draw over
        // the scene, as every other anchored sprite in the app does.
        depthTest: 'always',
        pickable: true,
        point: {
          sizePx: STEP_PIXEL_SIZE,
          outlinePx: STEP_OUTLINE_PX,
          outlineColor: STEP_OUTLINE_COLOR,
        },
      });
    }
    if (!steps) return;
    stepRows.forEach((row, i) =>
      steps.set(i, {
        ...(row.position ? { position: row.position } : {}),
        color: STEP_COLOR,
        scale:
          row.index === selected
            ? STEP_SELECTED_PIXEL_SIZE / STEP_PIXEL_SIZE
            : 1,
        show: visible && Boolean(row.position),
        pickId: stepPickId(row.index),
      }),
    );
    steps.setCount(stepRows.length);
    steps.commit();
  }

  const removeMoveEnd = engine.camera.moveEnd.addEventListener(() => {
    if (ends.a || ends.b) placeMarkers();
  });
  placeMarkers();

  return {
    /** Places marker `letter` ('a' or 'b') at { lon, lat }, or removes it (null). */
    setMarker(letter, point) {
      if (destroyed || !LETTERS.includes(letter)) return;
      ends[letter] = point ? { lon: point.lon, lat: point.lat } : null;
      placeMarkers();
    },
    /** Draws the route ([lon, lat] pairs), or removes it (null). */
    setRoute(geometry) {
      if (destroyed) return;
      route?.destroy();
      route = null;
      const pieces = geometry ? routeDashPieces(geometry) : [];
      if (!pieces.length) return;
      route = engine.ground.createSet({
        id: DIRECTIONS_SET_IDS.route,
        kind: 'corridor',
        drape: 'both',
        pickable: false,
      });
      route.replace(
        pieces.map(({ positions, lit }) => ({
          positions,
          color: lit ? ROUTE_DASH_COLOR : ROUTE_GAP_COLOR,
          widthPx: ROUTE_WIDTH_PX,
        })),
      );
      route.commit();
      route.show(visible);
    },
    /**
     * The maneuver dots, in order: { index, position } with position a
     * src/geo Cartesian3, or null while the dot has no anchor (hidden).
     */
    setSteps(rows) {
      if (destroyed) return;
      stepRows = rows.map(({ index, position }) => ({
        index,
        position: position ? geo.cartesian3.clone(position) : null,
      }));
      if (!stepRows.some((row) => row.index === selected)) selected = null;
      writeSteps();
    },
    /** Draws dot `index` at its selected size (null: none). */
    selectStep(index) {
      if (destroyed) return;
      selected = Number.isInteger(index) ? index : null;
      writeSteps();
    },
    /** Where dot `index` is drawn, or null while it is hidden or absent. */
    stepPosition(index) {
      const row = stepRows.find((entry) => entry.index === index);
      return row?.position && visible
        ? geo.cartesian3.clone(row.position)
        : null;
    },
    /** Shows or hides everything the display draws. */
    show(next) {
      if (destroyed) return;
      visible = Boolean(next);
      route?.show(visible);
      placeMarkers();
      writeSteps();
    },
    /** Listens for clicks with the engine's pick; returns the remover. */
    onClick(listener) {
      return engine.input.on('click', listener, { pick: true });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      removeMoveEnd();
      route?.destroy();
      steps?.destroy();
      markers.destroy();
      letters?.destroy();
      route = steps = null;
      stepRows = [];
    },
  };
}
