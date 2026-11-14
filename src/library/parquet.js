/**
 * GeoParquet for the Data Library: one file, or a set partitioned across an
 * S3-style bucket (such as Source Cooperative), read straight from the
 * provider with HTTP range requests.
 *
 * Portable (server and browser); the caller supplies `fetchImpl`. The
 * browser imports this module lazily, so the Parquet reader costs nothing
 * until a GeoParquet entry is switched on.
 */
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { decompress as zstdDecompress } from 'fzstd';
import { libraryUpstreamUrl } from './manifest.js';
import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from '../sources/httpBody.js';

/** Footer bytes read first; small files' metadata fits in one request. */
const FOOTER_FETCH_BYTES = 16 * 1024;
/** Partitions read per view, and how many decoded ones stay in memory. */
export const MAX_PARTITIONS_PER_VIEW = 4;
const MAX_LISTED_KEYS = 5000;
const MAX_LIST_PAGES = 20;
const INDEX_CONCURRENCY = 8;
/** One listing page: 1,000 keys of XML is well under a megabyte. */
const MAX_LIST_PAGE_BYTES = 4 * 1024 * 1024;
/** A whole file sent in answer to a range request is read only up to this. */
const MAX_UNRANGED_BYTES = 64 * 1024 * 1024;
/** Extra passes over footers that failed, before the index is incomplete. */
const FOOTER_RETRIES = 2;
const FOOTER_RETRY_DELAY_MS = 500;

/** Decompressors hyparquet does not carry itself (it has Snappy built in). */
export const PARQUET_COMPRESSORS = Object.freeze({
  ZSTD: (input) => zstdDecompress(input),
});

function onSourceHost(entry, url) {
  const target = libraryUpstreamUrl(url);
  const declared = libraryUpstreamUrl(entry.source.url);
  if (!target || !declared || target.host !== declared.host)
    throw Object.assign(new Error('off_manifest_host'), { status: 502 });
  return target.href;
}

/** Mark a failure worth retrying: network, 429, 5xx or a short read. */
const transient = (error) => Object.assign(error, { transient: true });

/**
 * A hyparquet AsyncBuffer over HTTP range requests, redirects refused,
 * credentials and referrer withheld.
 */
export function rangeBuffer(url, byteLength, { fetchImpl, signal }) {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0)
    throw new RangeError(`invalid object size ${byteLength}`);
  return {
    byteLength,
    async slice(start, end = byteLength) {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end > byteLength ||
        end <= start
      )
        throw new RangeError(`invalid range ${start}-${end} of ${byteLength}`);
      let response;
      try {
        response = await fetchImpl(url, {
          signal,
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { Range: `bytes=${start}-${end - 1}` },
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw transient(error);
      }
      if (response.status !== 206 && response.status !== 200) {
        await response.body?.cancel?.().catch?.(() => {});
        const error = new Error(`HTTP ${response.status}`);
        throw response.status === 429 || response.status >= 500
          ? transient(error)
          : error;
      }
      // A server that ignores Range answers with the whole file; anything
      // else must be exactly the bytes asked for.
      const whole = response.status === 200;
      const expected = whole ? byteLength : end - start;
      let bytes;
      try {
        bytes = await readResponseBytesCapped(
          response,
          whole ? Math.min(byteLength, MAX_UNRANGED_BYTES) : expected,
          signal,
        );
      } catch (error) {
        // A body cut off mid-stream (a reset, the proxy's timeout) is a
        // fetch failure worth retrying; an oversized one is not.
        if (signal?.aborted || error?.code === 'RESPONSE_TOO_LARGE')
          throw error;
        throw transient(error);
      }
      if (bytes.byteLength !== expected)
        throw transient(
          new Error(
            `short read: ${bytes.byteLength} of ${expected} bytes from ${start}`,
          ),
        );
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
      return whole ? buffer.slice(start, end) : buffer;
    },
  };
}

/**
 * List the `.parquet` objects under an S3 ListObjectsV2 URL, following
 * continuation tokens.
 * @returns {Promise<Array<{ key: string, size: number }>>}
 */
export async function listPartitions(entry, { fetchImpl, signal }) {
  const { listUrl } = entry.source.partitions;
  const objects = [];
  let token = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const url = new URL(onSourceHost(entry, listUrl));
    if (token) url.searchParams.set('continuation-token', token);
    const response = await fetchImpl(url.href, {
      signal,
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await readResponseTextCapped(
      response,
      MAX_LIST_PAGE_BYTES,
      signal,
    );
    for (const match of xml.matchAll(
      /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    )) {
      const size = Number(match[2]);
      if (!match[1].endsWith('.parquet') || !Number.isSafeInteger(size))
        continue;
      if (size <= 0) continue;
      objects.push({ key: match[1], size });
      if (objects.length >= MAX_LISTED_KEYS) return objects;
    }
    token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(
      xml,
    )?.[1];
    if (!token) break;
  }
  return objects;
}

/** The primary geometry column and its bbox from GeoParquet metadata. */
export function geoParquetInfo(metadata) {
  const raw = metadata?.key_value_metadata?.find(
    ({ key }) => key === 'geo',
  )?.value;
  if (!raw) return { column: null, bbox: null };
  try {
    const geo = JSON.parse(raw);
    const column = geo.primary_column || Object.keys(geo.columns || {})[0];
    const bbox = geo.columns?.[column]?.bbox;
    return {
      column: column || null,
      bbox:
        Array.isArray(bbox) && bbox.length >= 4 && bbox.every(Number.isFinite)
          ? bbox.length === 6
            ? [bbox[0], bbox[1], bbox[3], bbox[4]]
            : bbox.slice(0, 4)
          : null,
    };
  } catch {
    return { column: null, bbox: null };
  }
}

const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Where each partition is: list the bucket, then read each file's footer
 * (one small range request) for its GeoParquet bbox. A partition whose
 * metadata is unreadable or has no bbox is left out; a footer that fails to
 * load (network, 429, 5xx, short read) is retried
 * (FOOTER_RETRIES more passes) and, if it still fails, the index is
 * `complete: false` so callers never keep it as if it were whole.
 * @returns {Promise<{ partitions: Array<{ url: string, bbox: number[], size: number }>, complete: boolean, failed: number }>}
 */
export async function buildPartitionIndex(
  entry,
  { fetchImpl, signal, retryDelayMs = FOOTER_RETRY_DELAY_MS },
) {
  const { keyBase } = entry.source.partitions;
  const objects = await listPartitions(entry, { fetchImpl, signal });
  const partitions = [];
  let pending = objects;
  for (let pass = 0; pass <= FOOTER_RETRIES && pending.length; pass++) {
    if (pass) await pause(retryDelayMs * pass, signal);
    const failed = [];
    let next = 0;
    const queue = pending;
    async function worker() {
      while (next < queue.length) {
        const object = queue[next++];
        signal?.throwIfAborted?.();
        const url = onSourceHost(entry, new URL(object.key, keyBase).href);
        try {
          const metadata = await parquetMetadataAsync(
            rangeBuffer(url, object.size, { fetchImpl, signal }),
            { initialFetchSize: FOOTER_FETCH_BYTES },
          );
          const { bbox } = geoParquetInfo(metadata);
          if (bbox) partitions.push({ url, bbox, size: object.size });
        } catch (error) {
          if (signal?.aborted) throw error;
          // A footer that arrived but does not parse will not parse next
          // time either: that file is left out. Only fetch failures retry.
          if (error?.transient) failed.push(object);
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(INDEX_CONCURRENCY, queue.length) }, worker),
    );
    pending = failed;
  }
  return {
    partitions: partitions.sort((a, b) => a.url.localeCompare(b.url)),
    complete: pending.length === 0,
    failed: pending.length,
  };
}

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
  Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

const boxArea = (box) => Math.max(1e-12, (box[2] - box[0]) * (box[3] - box[1]));

/**
 * The partitions a box touches, most specific first, at most `limit`.
 * Ranked by the share of each partition's own bbox the box covers: a few
 * stray geocodes can stretch an area's bbox across the country, and such a
 * partition must not outrank the area actually under the camera.
 */
export function partitionsForBox(index, box, limit = MAX_PARTITIONS_PER_VIEW) {
  return index
    .map((partition) => {
      const overlap = overlapArea(partition.bbox, box);
      return { partition, overlap, score: overlap / boxArea(partition.bbox) };
    })
    .filter(({ overlap }) => overlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ partition }) => partition);
}

/** The columns an entry needs: its geometry plus what it labels and colours. */
export function neededColumns(entry, geometryColumn) {
  const { display } = entry;
  return [
    ...new Set(
      [
        geometryColumn,
        display.label,
        ...(display.fields || []),
        display.rank?.field,
        display.colorBy?.field,
      ]
        .filter(Boolean)
        .map((field) => field.split('.')[0]),
    ),
  ];
}

/**
 * Read one GeoParquet file into GeoJSON features (geometry decoded from WKB
 * by hyparquet), reading only the columns the entry uses.
 * @returns {Promise<object[]>}
 */
export async function readGeoParquetFeatures(
  entry,
  url,
  { fetchImpl, signal, maxBytes = entry.source.maxBytes },
) {
  const response = await fetchImpl(onSourceHost(entry, url), {
    signal,
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await readResponseBytesCapped(response, maxBytes, signal);
  const file = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const metadata = await parquetMetadataAsync({
    byteLength: file.byteLength,
    slice: async (start, end) => file.slice(start, end),
  });
  const { column } = geoParquetInfo(metadata);
  if (!column) throw new Error('not a GeoParquet file');
  const rows = await parquetReadObjects({
    file,
    metadata,
    columns: neededColumns(entry, column),
    compressors: PARQUET_COMPRESSORS,
  });
  return rows.map((row) => {
    const { [column]: geometry, ...properties } = row;
    return { type: 'Feature', geometry, properties };
  });
}

/** Whether a point or a geometry's first position lies in a box. */
export function featureInBox(feature, box) {
  let position = feature?.geometry?.coordinates;
  while (Array.isArray(position?.[0])) position = position[0];
  if (!Array.isArray(position)) return false;
  const [lon, lat] = position;
  return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
}
