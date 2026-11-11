// Directions on the globe contract, the same on every engine:
// - the route: one engine.ground corridor set (9 px, draped on terrain and
//   3D tiles) of one corridor whose dashes flow toward the destination, as
//   the route flow material drew them (the engine animates them on the GPU
//   and draws every frame while the route shows);
// - the maneuver dots: one point mover set over the scene, white with a
//   route-colour outline, picked as `directions:step:<index>`; a dot without
//   a ground anchor yet is hidden;
// - the A and B markers: a point mover set for the discs and a sprite set
//   for their letters, over the scene, at the rendered surface under each
//   marker (sampled again whenever the camera comes to rest);
// - clicks through engine.input with the engine's pick.
// Placement, routing, anchoring, selection and the route flight stay in the
// layer.

import { createSurfacePoints } from '../../../globe/surfacePlacement.js';
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
  ROUTE_COLOR,
  ROUTE_DASH,
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

  const markerPoints = LETTERS.map(() => ({ show: false }));
  const surface = createSurfacePoints(engine, {
    groups: () => [
      {
        points: markerPoints,
        exclude: own(),
        set: {
          set(index, fields) {
            markers.set(index, fields);
            letters?.set(index, fields);
          },
          commit() {
            markers.commit();
            letters?.commit();
          },
        },
      },
    ],
    prefer: 'scene',
    estimateGround: true,
    request: () => engine.render.request(ID),
  });

  function placeMarkers() {
    if (destroyed) return;
    LETTERS.forEach((letter, index) => {
      const point = ends[letter];
      const show = visible && Boolean(point);
      const row = markerPoints[index];
      row.show = show;
      const position = point ? row.position : undefined;
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
    surface.place();
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

  placeMarkers();

  return {
    /** Places marker `letter` ('a' or 'b') at { lon, lat }, or removes it (null). */
    setMarker(letter, point) {
      if (destroyed || !LETTERS.includes(letter)) return;
      ends[letter] = point ? { lon: point.lon, lat: point.lat } : null;
      markerPoints[LETTERS.indexOf(letter)] = point
        ? {
            cartographic: geo.cartographic.fromDegrees(point.lon, point.lat),
            position: geo.cartesian3.fromDegrees(point.lon, point.lat),
          }
        : { show: false };
      placeMarkers();
    },
    /** Draws the route ([lon, lat] pairs), or removes it (null). */
    setRoute(geometry) {
      if (destroyed) return;
      route?.destroy();
      route = null;
      if (!(geometry?.length >= 2)) return;
      route = engine.ground.createSet({
        id: DIRECTIONS_SET_IDS.route,
        kind: 'corridor',
        drape: 'both',
        pickable: false,
      });
      route.replace([
        {
          positions: geometry,
          color: ROUTE_COLOR,
          widthPx: ROUTE_WIDTH_PX,
          dash: ROUTE_DASH,
        },
      ]);
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
      if (visible) surface.place({ all: true });
      writeSteps();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      surface.destroy();
      route?.destroy();
      steps?.destroy();
      markers.destroy();
      letters?.destroy();
      route = steps = null;
      stepRows = [];
    },
  };
}
