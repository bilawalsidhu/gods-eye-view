import h5wasm from 'h5wasm/node';

const primitive = (v) => {
  while (v && typeof v === 'object' && 'value' in v) v = v.value;
  if (typeof v === 'bigint') return Number(v);
  // NetCDF attributes are often 1-element arrays; unwrap them so packing
  // factors compare and multiply as scalars.
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    return v.length === 1 ? primitive(v[0]) : Array.from(v, primitive);
  }
  return v;
};
/** Unwrap an h5wasm NetCDF attribute into ordinary JavaScript values. */
export function netcdfAttributeValue(dataset, name) {
  return primitive(dataset?.attrs?.[name]);
}
/** Apply NetCDF fill, scale, offset, and unsigned-integer packing rules. */
export function unpackPacked(rawValue, attrs = {}) {
  const raw = primitive(rawValue);
  const fill = primitive(attrs._FillValue);
  if (fill !== undefined && raw === fill) return null;
  // NetCDF stores unsigned 16-bit fields in a signed container; restore the
  // unsigned value before applying scale/offset (GLM ids, area, energy, QF).
  const value =
    String(primitive(attrs._Unsigned)) === 'true' && raw < 0 ? raw + 65536 : raw;
  const scale = primitive(attrs.scale_factor) ?? 1;
  const offset = primitive(attrs.add_offset) ?? 0;
  const result = value * scale + offset;
  return Number.isFinite(result) ? result : null;
}
/** Parse the GOES product-time units declaration into an epoch offset. */
export function parseProductTimeUnits(units) {
  const m = String(units ?? '').match(
    /seconds since (\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)(?: UTC)?/i,
  );
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(ms) ? ms : null;
}
/** Decode flash records from one GLM NetCDF granule. */
export async function decodeGlmGranule(
  filePath,
  { satelliteId, h5wasmModule = h5wasm, granuleStartMs } = {},
) {
  // h5wasm must finish loading its WASM module before any File is constructed.
  if (h5wasmModule?.ready) await h5wasmModule.ready;
  const f = new h5wasmModule.File(filePath, 'r');
  try {
    const get = (n) => f.get(n);
    // `number_of_flashes` is a NetCDF dimension variable (empty); the actual
    // record count lives in the scalar `flash_count`. Fall back to the array
    // length if a future version omits the count.
    const countDs = get('flash_count');
    const n = countDs
      ? Number(primitive(countDs.value))
      : get('flash_lat').value.length;
    const timeDs = get('product_time');
    const unitsEpoch = parseProductTimeUnits(netcdfAttributeValue(timeDs, 'units'));
    if (unitsEpoch === null) throw new Error('Unparseable product_time units');
    const productTimeMs = unitsEpoch + Number(primitive(timeDs.value)) * 1000;
    const names = [
      'flash_lat',
      'flash_lon',
      'flash_id',
      'flash_energy',
      'flash_area',
      'flash_quality_flag',
      'flash_time_offset_of_first_event',
    ];
    const ds = Object.fromEntries(names.map((x) => [x, get(x)]));
    for (const x of names)
      if (ds[x].value.length !== n) throw new Error(`Invalid ${x} length`);
    const flashes = [];
    for (let i = 0; i < n; i++) {
      const lat = unpackPacked(ds.flash_lat.value[i], ds.flash_lat.attrs);
      const lon = unpackPacked(ds.flash_lon.value[i], ds.flash_lon.attrs);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const offset = unpackPacked(
        ds.flash_time_offset_of_first_event.value[i],
        ds.flash_time_offset_of_first_event.attrs,
      );
      if (offset === null) continue;
      flashes.push({
        id: `${satelliteId}:${granuleStartMs ?? productTimeMs}:${unpackPacked(ds.flash_id.value[i], ds.flash_id.attrs)}`,
        satelliteId,
        lon,
        lat,
        timeMs: productTimeMs + offset * 1000,
        energyJ: unpackPacked(ds.flash_energy.value[i], ds.flash_energy.attrs),
        areaM2: unpackPacked(ds.flash_area.value[i], ds.flash_area.attrs),
        qualityFlag: unpackPacked(
          ds.flash_quality_flag.value[i],
          ds.flash_quality_flag.attrs,
        ),
      });
    }
    return { satelliteId, productTimeMs, flashes };
  } finally {
    f.close();
  }
}
