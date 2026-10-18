import {
  GRAVITY_GRID,
  GRAVITY_LAND_MASK,
  GRAVITY_NO_DATA,
  assertGravitySourceGrid,
  gravitySolutions,
  reduceGravityBlock,
} from './grid.js';

let h5wasmPromise = null;
/** HDF5 reader, loaded only when a conversion actually runs. */
function loadH5wasm() {
  h5wasmPromise ??= import('h5wasm/node')
    .then(async (module) => {
      const h5wasm = module.default ?? module;
      await h5wasm.ready;
      return h5wasm;
    })
    .catch((error) => {
      h5wasmPromise = null;
      throw error;
    });
  return h5wasmPromise;
}

const FACTOR = 4;

/**
 * Tiles that start and end on the file's own chunk boundaries (rounded to
 * whole 4-cell groups), so every compressed chunk is inflated once and a tile
 * stays tens of megabytes rather than the whole 1 GB variable.
 */
function tiles(length, chunk) {
  // Four chunks: a multiple of both the chunk and the 4-cell group.
  const step = Math.max(1, chunk) * FACTOR;
  const ranges = [];
  for (let start = 0; start < length; start += step)
    ranges.push([start, Math.min(length, start + step)]);
  return ranges;
}

/**
 * Reduce the CSR mascon NetCDF to the one-degree cube.
 * @param {string} file Path to the downloaded NetCDF file.
 * @returns {Promise<{solutions: {id:string,start:string,end:string}[], cube: Int16Array}>}
 */
export async function convertGravityNetcdf(file, { h5wasm } = {}) {
  const reader = h5wasm ?? (await loadH5wasm());
  const handle = new reader.File(file, 'r');
  try {
    const field = handle.get('lwe_thickness');
    assertGravitySourceGrid(handle.get('lat')?.value, handle.get('lon')?.value);
    const solutions = gravitySolutions(handle.get('time_bounds')?.value);
    const [times, rows, cols] = field?.shape || [];
    if (times !== solutions.length || rows !== 720 || cols !== 1440)
      throw new Error('Unexpected gravity field shape');
    const chunks = field.metadata?.chunks || [times, rows, cols];
    const cube = new Int16Array(times * GRAVITY_GRID.nx * GRAVITY_GRID.ny).fill(
      GRAVITY_NO_DATA,
    );
    const timeStep = Math.max(1, chunks[0]);
    for (let time0 = 0; time0 < times; time0 += timeStep) {
      const time1 = Math.min(times, time0 + timeStep);
      for (const [row0, row1] of tiles(rows, chunks[1]))
        for (const [col0, col1] of tiles(cols, chunks[2])) {
          const values = field.slice([
            [time0, time1],
            [row0, row1],
            [col0, col1],
          ]);
          reduceGravityBlock(cube, values, {
            time0,
            times: time1 - time0,
            row0,
            rows: row1 - row0,
            col0,
            cols: col1 - col0,
          });
        }
    }
    return { solutions, cube };
  } finally {
    handle.close();
  }
}

/**
 * CSR's 0.25° land mask as one byte per cell, reoriented to the layer's
 * grid: row 0 north, column 0 at 180°W.
 * @param {string} file Path to the downloaded LandMask NetCDF file.
 * @returns {Promise<Uint8Array>}
 */
export async function convertLandMaskNetcdf(file, { h5wasm } = {}) {
  const reader = h5wasm ?? (await loadH5wasm());
  const handle = new reader.File(file, 'r');
  try {
    assertGravitySourceGrid(handle.get('lat')?.value, handle.get('lon')?.value);
    const values = handle.get('LO_val')?.value;
    const { nx, ny } = GRAVITY_LAND_MASK;
    if (values?.length !== nx * ny) throw new Error('Unexpected land mask');
    const mask = new Uint8Array(nx * ny);
    for (let row = 0; row < ny; row++) {
      const source = (ny - 1 - row) * nx;
      for (let col = 0; col < nx; col++)
        mask[row * nx + col] = values[source + ((col + nx / 2) % nx)] > 0.5;
    }
    return mask;
  } finally {
    handle.close();
  }
}
