/**
 * Read one member out of a remote ZIP using HTTP Range requests.
 *
 * The Dutch national GTFS is 232 MB; a single member such as `stops.txt` is a few tens of KB compressed.
 * Downloading the archive to learn which routes are metro would move five
 * thousand times more bytes than the answer needs, every refresh. A ZIP's
 * directory lives at the END of the file, so three ranged reads — the end
 * record, the central directory, the member — get it for about 60 KB.
 *
 * Uses fetch and DecompressionStream only: no archive dependency, and the same
 * code runs under node:test as in the dev server.
 */

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SEARCH_BYTES = 65557; // max comment length + the 22-byte record
const CENTRAL_SIGNATURE = 0x02014b50;

/** One ranged read; throws when the server ignores Range (206 is required). */
async function readRange(url, start, end, fetchImpl, signal) {
  const resp = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal });
  if (resp.status !== 206) throw new Error(`range request refused: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

/** Inflate a raw DEFLATE member (ZIP method 8). */
async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Locate `name` in the archive's central directory.
 * @returns {?{offset:number, compressedSize:number, method:number}}
 */
function findMember(central, name) {
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  let p = 0;
  while (p + 46 <= central.byteLength && view.getUint32(p, true) === CENTRAL_SIGNATURE) {
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const entry = new TextDecoder().decode(central.subarray(p + 46, p + 46 + nameLen));
    if (entry === name || entry.endsWith(`/${name}`)) return { offset, compressedSize, method };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/**
 * Read one text member out of a remote ZIP over HTTP Range.
 *
 * Never throws: any failure resolves to null, which every caller reads as "no
 * table", leaving whatever default it already had in place.
 * @param {string} zipUrl - Absolute URL of the archive.
 * @param {string} member - File name inside it, e.g. `stops.txt`.
 * @param {{fetchImpl?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<?string>}
 */
export async function fetchZipMemberText(zipUrl, member, { fetchImpl = fetch, signal } = {}) {
  try {
    const head = await fetchImpl(zipUrl, { method: 'HEAD', signal });
    const size = Number(head.headers.get('content-length'));
    if (!Number.isInteger(size) || size <= 22) return null;

    const tailStart = Math.max(0, size - EOCD_SEARCH_BYTES);
    const tail = await readRange(zipUrl, tailStart, size - 1, fetchImpl, signal);
    const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i -= 1) {
      if (tailView.getUint32(i, true) === EOCD_SIGNATURE) { eocd = i; break; }
    }
    if (eocd === -1) return null;
    const centralSize = tailView.getUint32(eocd + 12, true);
    const centralOffset = tailView.getUint32(eocd + 16, true);

    const central = await readRange(zipUrl, centralOffset, centralOffset + centralSize - 1, fetchImpl, signal);
    const entry = findMember(central, member);
    if (!entry) return null;

    // The local header repeats the name and extra fields with its OWN lengths,
    // which are allowed to differ from the central directory's — reading the
    // central copy's lengths here is the classic way to land mid-file.
    const local = await readRange(zipUrl, entry.offset, entry.offset + 29, fetchImpl, signal);
    const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
    const dataAt = entry.offset + 30 + localView.getUint16(26, true) + localView.getUint16(28, true);
    const raw = await readRange(zipUrl, dataAt, dataAt + entry.compressedSize - 1, fetchImpl, signal);
    const bytes = entry.method === 8 ? await inflateRaw(raw) : raw;
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}
