// iNaturalist's operational /v1/grid/{z}/{x}/{y}.grid.json endpoint is not
// covered by its v1 Swagger contract. Validate the entire UTFGrid shape before
// accepting any cell; callers preserve the last good sample on schema drift.
import {
  wildlifeGridCellId,
  WILDLIFE_GRID_MAX_ZOOM,
} from '../../../src/layers/wildlifeSightings/gridViewport.js';

const INAT_GRID_SIZE = 64;
export const INAT_GRID_DECODE_MEASURE = 'wildlife:server:tile-decode';
const grades = new Set(['research', 'needs_id', 'casual']);
const object = (value) =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Accept only integer XYZ coordinates within the supported zoom range. */
export function validInatGridTile({ z, x, y } = {}) {
  return (
    Number.isInteger(z) &&
    z >= 0 &&
    z <= WILDLIFE_GRID_MAX_ZOOM &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < 2 ** z &&
    y < 2 ** z
  );
}

/** Pure allow-list projection. A UTFGrid key is an observation identifier and
 * its repeated pixels form a dilated hit area, not additional occupied cells.
 * Neither those keys nor representative/private fields cross this boundary. */
export function projectInatGrid(payload, tile) {
  const start = `${INAT_GRID_DECODE_MEASURE}:start`;
  const end = `${INAT_GRID_DECODE_MEASURE}:end`;
  performance.mark(start);
  try {
    return decodeInatGrid(payload, tile);
  } finally {
    performance.mark(end);
    // Keep the latest sample inspectable without retaining every tile forever.
    // PerformanceObservers still receive each individual decode measurement.
    performance.clearMeasures(INAT_GRID_DECODE_MEASURE);
    performance.measure(INAT_GRID_DECODE_MEASURE, start, end);
    performance.clearMarks(start);
    performance.clearMarks(end);
  }
}

function decodeInatGrid(payload, tile) {
  const invalid = () => {
    throw new TypeError('Invalid iNaturalist UTFGrid');
  };
  if (
    !validInatGridTile(tile) ||
    !object(payload) ||
    !Array.isArray(payload.grid) ||
    payload.grid.length !== INAT_GRID_SIZE ||
    !payload.grid.every(
      (row) => typeof row === 'string' && row.length === INAT_GRID_SIZE,
    ) ||
    !Array.isArray(payload.keys) ||
    !payload.keys.length ||
    payload.keys.length > INAT_GRID_SIZE ** 2 + 1 ||
    payload.keys[0] !== '' ||
    !payload.keys.every(
      (key) => typeof key === 'string' && key.length <= 128,
    ) ||
    new Set(payload.keys).size !== payload.keys.length ||
    !object(payload.data)
  )
    invalid();
  const dataKeys = Object.keys(payload.data);
  if (dataKeys.length !== payload.keys.length - 1) invalid();
  for (const key of payload.keys.slice(1)) {
    if (!key || !Object.hasOwn(payload.data, key)) invalid();
    const value = payload.data[key];
    if (
      !object(value) ||
      !Number.isSafeInteger(value.cellCount) ||
      value.cellCount <= 0 ||
      !Number.isFinite(value.latitude) ||
      Math.abs(value.latitude) > 90 ||
      !Number.isFinite(value.longitude) ||
      Math.abs(value.longitude) > 180 ||
      !grades.has(value.quality_grade) ||
      !(
        value['taxon.iconic_taxon_id'] === null ||
        (Number.isSafeInteger(value['taxon.iconic_taxon_id']) &&
          value['taxon.iconic_taxon_id'] > 0)
      )
    )
      invalid();
  }
  const occupied = new Set();
  for (const line of payload.grid) {
    for (let column = 0; column < INAT_GRID_SIZE; column += 1) {
      let code = line.charCodeAt(column);
      if (code < 32 || code === 34 || code === 92) invalid();
      if (code >= 93) code -= 1;
      if (code >= 35) code -= 1;
      const index = code - 32;
      if (index < 0 || index >= payload.keys.length) invalid();
      if (index) occupied.add(payload.keys[index]);
    }
  }
  if (occupied.size !== dataKeys.length) invalid();
  const cells = new Map();
  for (const key of occupied) {
    const value = payload.data[key];
    const id = wildlifeGridCellId(value.latitude, value.longitude, tile.z);
    const cell = {
      id,
      cellCount: value.cellCount,
      lat: value.latitude,
      lon: value.longitude,
    };
    // Two different representatives claiming one logical cell are a contract
    // change; summing or choosing one silently would fabricate the count.
    if (cells.has(id)) invalid();
    cells.set(id, cell);
  }
  const rows = [...cells.values()];
  const totalResults = rows.reduce((total, cell) => total + cell.cellCount, 0);
  if (!Number.isSafeInteger(totalResults)) invalid();
  return { cells: rows, totalResults };
}
