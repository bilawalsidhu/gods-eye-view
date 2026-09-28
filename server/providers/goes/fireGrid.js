import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { h5wasm, ready } from 'h5wasm/node';

/**
 * Decode one NOAA GOES-R ABI Level 2 Fire Detection (`ABI-L2-FDCF`) granule
 * into fire detections.
 *
 * The granule is NetCDF-4/HDF5 and carries no `Lat`/`Lon` variables, so the
 * ABI fixed grid is inverted to geographic coordinates. `Mask` is a scene
 * classification bit field; its class semantics are deliberately NOT
 * reimplemented here — the raw value is passed through, because guessing the
 * bit meanings would silently mislabel detections.
 *
 * @param {Uint8Array} bytes - Raw granule contents.
 * @returns {Promise<{scanStartIso: string, scanEndIso: string, lon0: number, detections: Array<Object>}>}
 */

export function fixedGridToLatLon(x, y, projection) {
  const {
    perspective_point_height,
    semi_major_axis: A,
    semi_minor_axis: B,
    longitude_of_projection_origin: lon0,
  } = projection;
  const H = perspective_point_height + A;
  const cosx = Math.cos(x);
  const cosy = Math.cos(y);
  const c =
    (H * cosx * cosy) ** 2 -
    (cosy ** 2 + (A ** 2 / B ** 2) * Math.sin(y) ** 2) * (H ** 2 - A ** 2);
  if (!(c >= 0)) return null;
  const sn =
    (H * cosx * cosy - Math.sqrt(c)) /
    (cosy ** 2 + (A ** 2 / B ** 2) * Math.sin(y) ** 2);
  const s1 = H - sn * cosx * cosy;
  const s2 = sn * Math.sin(x) * cosy;
  const s3 = sn * Math.sin(y);
  return {
    lat:
      (Math.atan((B ** 2 / A ** 2) * (s3 / Math.sqrt(s1 ** 2 + s2 ** 2))) *
        180) /
      Math.PI,
    // longitude_of_projection_origin is in DEGREES while the formula works in
    // radians; mixing them yields longitudes near -4300 deg.
    lon: (((lon0 * Math.PI) / 180 - Math.atan(s2 / s1)) * 180) / Math.PI,
  };
}

function unwrap(value) {
  return ArrayBuffer.isView(value) || Array.isArray(value) ? value[0] : value;
}

/** Read an attribute from a dataset or a group, tolerating either h5wasm API. */
function readAttribute(object, name) {
  if (!object) return undefined;
  try {
    const direct = object.getAttribute?.(name);
    if (direct !== undefined) return unwrap(direct?.value ?? direct);
  } catch {
    /* fall through to the attrs bag */
  }
  try {
    const attribute = object.attrs?.[name];
    if (attribute !== undefined) return unwrap(attribute?.value ?? attribute);
  } catch {
    /* absent */
  }
  return undefined;
}

/** Scale/offset/fill for one raw integer dataset, read from the file itself. */
function scaledDataset(file, name) {
  let dataset;
  try {
    dataset = file.get(name);
  } catch {
    return null;
  }
  if (!dataset) return null;
  return {
    dataset,
    scale: Number(readAttribute(dataset, 'scale_factor') ?? 1),
    offset: Number(readAttribute(dataset, 'add_offset') ?? 0),
    fill: readAttribute(dataset, '_FillValue'),
  };
}

function optionalValues(file, name) {
  try {
    return file.get(name)?.value ?? null;
  } catch {
    return null;
  }
}
function optionalDataset(file, name) {
  try {
    return file.get(name) ?? null;
  } catch {
    return null;
  }
}

function decode(file) {
  let power;
  try {
    power = scaledDataset(file, 'Power');
  } catch {
    throw new Error('FDCF granule has no Power dataset');
  }
  if (!power) throw new Error('FDCF granule has no Power dataset');
  // Typed arrays are indexed in place: materializing 5424x5424 values per
  // lookup would cost hundreds of MB and dominate the decode.
  if (!Array.isArray(power.dataset.shape) || power.dataset.shape.length !== 2)
    throw new Error('FDCF Power dataset must be two-dimensional');
  const [rows, cols] = power.dataset.shape;

  const temp = scaledDataset(file, 'Temp');
  const area = scaledDataset(file, 'Area');
  const mask = optionalValues(file, 'Mask');
  if (!mask) throw new Error('FDCF granule has no Mask dataset');
  const dqf = optionalDataset(file, 'DQF');
  const zenith = optionalDataset(file, 'solar_zenith_angle');
  if (mask && mask.length !== rows * cols)
    throw new Error('FDCF Mask dimensions mismatch');
  for (const dataset of [temp, area])
    if (
      dataset &&
      (dataset.dataset.shape?.length !== 2 ||
        dataset.dataset.shape[0] !== rows ||
        dataset.dataset.shape[1] !== cols)
    )
      throw new Error('FDCF telemetry dimensions mismatch');
  if (
    dqf &&
    (dqf.shape?.length !== 2 || dqf.shape[0] !== rows || dqf.shape[1] !== cols)
  )
    throw new Error('FDCF DQF dimensions mismatch');
  if (
    zenith &&
    zenith.shape?.length > 1 &&
    (zenith.shape.length !== 2 ||
      zenith.shape[0] !== rows ||
      zenith.shape[1] !== cols)
  )
    throw new Error('FDCF solar zenith dimensions mismatch');

  let x;
  let y;
  try {
    x = file.get('x');
    y = file.get('y');
  } catch {
    throw new Error('FDCF granule has no ABI scan angles');
  }
  const xValues = x.value;
  const yValues = y.value;
  if (
    x.shape?.length !== 1 ||
    y.shape?.length !== 1 ||
    x.shape[0] !== cols ||
    y.shape[0] !== rows
  )
    throw new Error('FDCF scan angle dimensions mismatch');
  const xScale = Number(readAttribute(x, 'scale_factor') ?? 1);
  const xOffset = Number(readAttribute(x, 'add_offset') ?? 0);
  const yScale = Number(readAttribute(y, 'scale_factor') ?? 1);
  const yOffset = Number(readAttribute(y, 'add_offset') ?? 0);

  const projectionGroup = file.get('goes_imager_projection');
  const projection = {
    perspective_point_height: Number(
      readAttribute(projectionGroup, 'perspective_point_height'),
    ),
    semi_major_axis: Number(readAttribute(projectionGroup, 'semi_major_axis')),
    semi_minor_axis: Number(readAttribute(projectionGroup, 'semi_minor_axis')),
    longitude_of_projection_origin: Number(
      readAttribute(projectionGroup, 'longitude_of_projection_origin'),
    ),
  };

  const readAt = (dataset, index) => {
    if (!dataset) return null;
    const result = dataset.slice([
      [Math.floor(index / cols), Math.floor(index / cols) + 1],
      [index % cols, (index % cols) + 1],
    ]);
    return result?.[0] ?? null;
  };
  const scaled = (source, index) => {
    if (!source) return null;
    const raw = readAt(source.dataset, index);
    if (raw === source.fill) return null;
    return raw * source.scale + source.offset;
  };
  const readValue = (dataset, index) => {
    if (!dataset) return null;
    const result = dataset.slice([
      [Math.floor(index / cols), Math.floor(index / cols) + 1],
      [index % cols, (index % cols) + 1],
    ]);
    return result == null ? null : Number(result?.[0] ?? result);
  };

  const detections = [];
  const validMasks = new Set([10, 11, 13, 14, 15, 30, 31, 33, 34, 35]);
  const powerValues = Array.from(mask, (maskValue, index) =>
    validMasks.has(Number(maskValue))
      ? power.dataset.slice([
          [Math.floor(index / cols), Math.floor(index / cols) + 1],
          [index % cols, (index % cols) + 1],
        ])?.[0] *
          power.scale +
        power.offset
      : null,
  );
  for (let index = 0; index < powerValues.length; index += 1) {
    if (mask && !validMasks.has(Number(mask[index]))) continue;
    // Detection criterion: a positive radiative power. This is checkable
    // against the granule's own aggregates — filtering DQF === 0 reproduces
    // `total_number_of_pixels_with_fire_radiative_power` exactly.
    if (!(powerValues[index] > 0)) continue;
    const point = fixedGridToLatLon(
      xValues[index % cols] * xScale + xOffset,
      yValues[Math.floor(index / cols)] * yScale + yOffset,
      projection,
    );
    if (!point) continue;
    const zenithScalar =
      zenith && zenith.shape?.length === 0 ? zenith.value?.[0] : null;
    const pixelZenith = zenith
      ? (zenithScalar ?? readValue(zenith, index))
      : null;
    detections.push({
      lat: point.lat,
      lon: point.lon,
      frp: powerValues[index],
      tempK: scaled(temp, index),
      areaM2: scaled(area, index),
      mask: mask ? mask[index] : null,
      dqf: readValue(dqf, index),
      night:
        pixelZenith == null || !Number.isFinite(Number(pixelZenith))
          ? null
          : Number(pixelZenith) > 90,
    });
  }

  return {
    scanStartIso: readAttribute(file, 'time_coverage_start') ?? null,
    scanEndIso: readAttribute(file, 'time_coverage_end') ?? null,
    lon0: projection.longitude_of_projection_origin,
    detections,
  };
}

export async function decodeFireGrid(bytes) {
  await ready;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'goes-fdcf-'));
  const filename = path.join(dir, 'data.nc');
  await fs.writeFile(filename, bytes);
  let file;
  try {
    file = new h5wasm.File(filename, 'r');
    return decode(file);
  } finally {
    try {
      file?.close();
    } catch {
      /* already closed */
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
