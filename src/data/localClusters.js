import {
  addCellPoint,
  cellLevel,
  createCountCell,
  groundCellKey,
} from './countCells.js';
import { poseProjector } from '../geo/frustum.js';
import { distance } from '../geo/vector.js';
import { horizonFrom } from '../geo/horizon.js';

/** Count grouping for a `markers: 'clusters'` local GeoJSON layer; the count painter (src/overlays/countMarkers.js) merges counts that would overlap. */

/** A ground cell spans about this many CSS pixels at its distance. */
export const LOCAL_CLUSTER_CELL_PX = 44;

/** Cells smaller than this many metres do not group: each site shows alone. */
export const LOCAL_CLUSTER_MIN_CELL_M = 60;

/** Drawn size of a lone site's marker, in CSS pixels. */
export const LOCAL_MARKER_PX = 22;

/** Sites this far past the screen edge (fraction of its size) still count as in view. */
const VIEW_MARGIN = 0.25;

/**
 * Group the sites the eye can see into ground cells.
 * A site is `{id, lat, lon, base, partRecords?}` with `base` its ECEF ground point. Below
 * LOCAL_CLUSTER_MIN_CELL_M each site is its own cell. A cell is listed when
 * at least one of its sites is near the screen, and counts every site in it
 * that is above the horizon. `cell.winner` is its first site.
 * @param {object[]} sites
 * @param {{pose: object, width: number, height: number}} view The camera pose
 *   and the canvas size in CSS pixels.
 * @returns {{cells: object[], project: function(object): ({x:number,y:number}|null), anchors: Map, near: Set}}
 *   The listed cells, their projector, the above-horizon sites mapped to their
 *   anchor parts, and the sites whose anchors are near the screen.
 */
export function localClusterCells(sites, { pose, width, height }) {
  const project = poseProjector(pose, width, height);
  const horizon = horizonFrom(pose.position);
  // Ground metres one pixel covers per metre of distance from the eye.
  const fovy = Number.isFinite(pose.fovy) ? pose.fovy : Math.PI / 3;
  const metresPerPixelPerMetre = (2 * Math.tan(fovy / 2)) / Math.max(1, height);
  const minX = -width * VIEW_MARGIN;
  const maxX = width * (1 + VIEW_MARGIN);
  const minY = -height * VIEW_MARGIN;
  const maxY = height * (1 + VIEW_MARGIN);
  const byKey = new Map();
  const cells = [];
  const anchors = new Map();
  const near = new Set();
  const isNear = (screen) =>
    screen !== null &&
    screen.x >= minX &&
    screen.x <= maxX &&
    screen.y >= minY &&
    screen.y <= maxY;
  for (const site of sites) {
    // A feature of several parts stands on its first part near the screen,
    // else on its first part above the horizon.
    let anchor = null;
    let anchorNear = false;
    for (const part of site.partRecords ?? [site]) {
      if (!horizon.isPointVisible(part.base)) continue;
      const partNear = isNear(project(part.base));
      if (!anchor || partNear) {
        anchor = part;
        anchorNear = partNear;
      }
      if (partNear) break;
    }
    if (!anchor) continue;
    anchors.set(site, anchor);
    if (anchorNear) near.add(site);
    const range = distance(anchor.base, pose.position);
    const cellM = LOCAL_CLUSTER_CELL_PX * metresPerPixelPerMetre * range;
    let cell;
    if (!(cellM >= LOCAL_CLUSTER_MIN_CELL_M)) {
      if (!anchorNear) continue;
      cell = createCountCell(`near:${site.id}`);
    } else {
      const key = groundCellKey(anchor.lat, anchor.lon, cellLevel(cellM));
      cell = byKey.get(key);
      if (!cell) {
        cell = createCountCell(key);
        byKey.set(key, cell);
      }
    }
    addCellPoint(cell, anchor);
    cell.winner ??= site;
    if (anchorNear && !cell.listed) {
      cell.listed = true;
      cells.push(cell);
    }
  }
  return { cells, project, anchors, near };
}

const svgAttribute = (value) =>
  String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

/** A two-unit server rack in `color`, as SVG drawn in a 24-unit box. */
const rackGlyph = (color) => {
  color = svgAttribute(color);
  return `
  <g fill="none" stroke="${color}" stroke-width="1.7">
    <rect x="4" y="4" width="16" height="7" rx="1.4"/>
    <rect x="4" y="13" width="16" height="7" rx="1.4"/>
  </g>
  <g fill="${color}">
    <circle cx="7.4" cy="7.5" r="1.1"/>
    <circle cx="7.4" cy="16.5" r="1.1"/>
    <rect x="11" y="6.8" width="6" height="1.4" rx="0.7"/>
    <rect x="11" y="15.8" width="6" height="1.4" rx="0.7"/>
  </g>`;
};

const svgUrl = (svg) =>
  `data:image/svg+xml;base64,${btoa(svg.replace(/\s*\n\s*/g, ''))}`;

/**
 * The rack glyph a count marker draws above its count, as the count painter's
 * `glyph` style: a 48 px image and its painted bounds in image pixels.
 * @param {string} color CSS colour.
 * @returns {{src: string, source: number[]}}
 */
export function rackCountGlyph(color) {
  return {
    src: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">${rackGlyph(color)}</svg>`,
    ),
    // The racks' outer stroke edges, at two image pixels per unit.
    source: [6.3, 6.3, 35.4, 35.4],
  };
}

/**
 * A lone site's marker: a dark disc ringed in `color` with the rack glyph,
 * drawn at 2x for sharp edges on dense displays.
 * @param {string} color CSS colour.
 * @returns {string} An image URL.
 */
export function rackMarkerImage(color) {
  const stroke = svgAttribute(color);
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * LOCAL_MARKER_PX}" height="${2 * LOCAL_MARKER_PX}" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#0e1720" stroke="rgba(8,14,20,0.85)" stroke-width="2"/>
      <circle cx="12" cy="12" r="10" fill="none" stroke="${stroke}" stroke-width="1.8"/>
      <g transform="translate(5.4 5.4) scale(0.55)">${rackGlyph(color)}</g>
    </svg>`,
  );
}
