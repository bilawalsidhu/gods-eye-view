import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

/**
 * Lazily created ecCodes WASM instance. The `@meri-imperiumi/eccodes-wasm`
 * module is only imported on first use so unit tests can inject a fake
 * decoder without loading the WASM (which requires Node >= 24).
 * @type {?Promise<object>}
 */
let eccodesPromise = null;

/** @returns {Promise<object>} The shared ecCodes WASM instance. */
function loadEccodes() {
  eccodesPromise ??= (async () => {
    const module = await import('@meri-imperiumi/eccodes-wasm');
    return module.createEccodes();
  })();
  return eccodesPromise;
}

/**
 * Decode one GRIB2 wind message into its grid metadata and values.
 *
 * The WASM decoder reads from its own mounted filesystem, so the message is
 * written to a temp file under `mountDir` and removed in `finally`.
 *
 * @param {Buffer} buffer - One GRIB2 message (already byte-range extracted).
 * @param {{ eccodesModule?: object, mountDir?: string }} [options]
 * @returns {Promise<{ni: number, nj: number, lo1: number, la1: number,
 *   di: number, dj: number, values: ArrayLike<number>, shortName: string,
 *   level: number, units: string}>}
 */
export async function decodeWindGribMessage(
  buffer,
  { eccodesModule, mountDir = os.tmpdir() } = {},
) {
  const eccodes = eccodesModule ?? (await loadEccodes());
  const name = `wind-${randomUUID()}.grib2`;
  const file = path.join(mountDir, name);
  await fs.writeFile(file, buffer);
  let handle = null;
  try {
    eccodes.mountFilesystem(mountDir);
    handle = eccodes.openGrib(file);
    return {
      ni: handle.getLong('Ni'),
      nj: handle.getLong('Nj'),
      lo1: handle.getDouble('longitudeOfFirstGridPointInDegrees'),
      la1: handle.getDouble('latitudeOfFirstGridPointInDegrees'),
      di: handle.getDouble('iDirectionIncrementInDegrees'),
      dj: handle.getDouble('jDirectionIncrementInDegrees'),
      values: handle.getDoubleArray('values'),
      shortName: handle.getString('shortName'),
      level: handle.getLong('level'),
      units: handle.getString('units'),
    };
  } finally {
    if (handle) handle.delete();
    await fs.unlink(file).catch(() => {});
  }
}
