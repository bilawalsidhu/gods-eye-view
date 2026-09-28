import h5wasm from 'h5wasm/node';

/**
 * Test-only builder for a real `ABI-L2-FDCF`-shaped HDF5 granule.
 *
 * The decode path is exercised against actual HDF5 rather than a stubbed
 * reader, so scale factors, fill values and scan-angle indexing are covered.
 * Shared by the fire-grid and proxy tests; not part of any runtime boundary.
 */

export const FIXTURE_PROJECTION = {
  perspective_point_height: 35786023,
  semi_major_axis: 6378137,
  semi_minor_axis: 6356752.31414,
  longitude_of_projection_origin: -75,
};

export const FIXTURE_TEMP_SCALE = 0.054936669766902924;
export const FIXTURE_TEMP_OFFSET = 400;
export const FIXTURE_AREA_SCALE = 60.97999954223633;
export const FIXTURE_AREA_OFFSET = 4000;
export const FIXTURE_SCAN_START = '2026-09-14T00:00:21.5Z';
export const FIXTURE_SCAN_END = '2026-09-14T00:09:52.4Z';

/** Two fires (index 0 and 3), two fills, so both paths are covered. */
export async function writeGoesFireGranule(filePath) {
  await h5wasm.ready;
  const { File } = h5wasm;
  const file = new File(filePath, 'w');
  file.create_dataset({
    name: 'Power',
    data: Float32Array.from([10.5, -9, -9, 3.25]),
    shape: [2, 2],
    dtype: '<f',
  });
  const temp = file.create_dataset({
    name: 'Temp',
    data: Uint16Array.from([65535, 700, 65535, 800]),
    shape: [2, 2],
    dtype: '<H',
  });
  temp.create_attribute('scale_factor', FIXTURE_TEMP_SCALE);
  temp.create_attribute('add_offset', FIXTURE_TEMP_OFFSET);
  temp.create_attribute('_FillValue', 65535);
  const area = file.create_dataset({
    name: 'Area',
    data: Uint16Array.from([65535, 1200, 65535, 1500]),
    shape: [2, 2],
    dtype: '<H',
  });
  area.create_attribute('scale_factor', FIXTURE_AREA_SCALE);
  area.create_attribute('add_offset', FIXTURE_AREA_OFFSET);
  area.create_attribute('_FillValue', 65535);
  file.create_dataset({
    name: 'Mask',
    data: Int16Array.from([30, -99, -99, 33]),
    shape: [2, 2],
    dtype: '<h',
  });
  file.create_dataset({
    name: 'DQF',
    data: Uint8Array.from([0, 255, 255, 2]),
    shape: [2, 2],
    dtype: '<B',
  });
  file.create_dataset({
    name: 'solar_zenith_angle',
    data: Float32Array.from([100, 0, 0, 20]),
    shape: [2, 2],
    dtype: '<f',
  });
  // Raw scan angles near the sub-satellite point. The offset (~0.1518 rad) is
  // what the raw integer maps through, so ±1000 would land at ±0.21 rad — off
  // the Earth entirely. These stay inside the disk.
  const x = file.create_dataset({
    name: 'x',
    data: Int16Array.from([2600, 2822]),
    shape: [2],
    dtype: '<h',
  });
  x.create_attribute('scale_factor', 5.6000000768108293e-5);
  x.create_attribute('add_offset', -0.15184399485588074);
  const y = file.create_dataset({
    name: 'y',
    data: Int16Array.from([2822, 2600]),
    shape: [2],
    dtype: '<h',
  });
  y.create_attribute('scale_factor', -5.6000000768108293e-5);
  y.create_attribute('add_offset', 0.15184399485588074);
  const projection = file.create_group('goes_imager_projection');
  for (const [name, value] of Object.entries(FIXTURE_PROJECTION))
    projection.create_attribute(name, value);
  file.create_attribute('time_coverage_start', FIXTURE_SCAN_START);
  file.create_attribute('time_coverage_end', FIXTURE_SCAN_END);
  file.close();
}
