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
import { readResponseBytesCapped } from '../sources/httpBody.js';

/** Footer bytes read first; small files' metadata fits in one request. */
const FOOTER_FETCH_BYTES = 16 * 1024;
/** Partitions read per view, and how many decoded ones stay in memory. */
export const MAX_PARTITIONS_PER_VIEW = 4;
const MAX_LISTED_KEYS = 5000;
const MAX_LIST_PAGES = 20;
const INDEX_CONCURRENCY = 8;

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

/**
 * A hyparquet AsyncBuffer over HTTP range requests, redirects refused,
 * credentials and referrer withheld.
 */
export function rangeBuffer(url, byteLength, { fetchImpl, signal }) {
  return {
    byteLength,
    async slice(start, end = byteLength) {
      const response = await fetchImpl(url, {
        signal,
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Range: `bytes=${start}-${end - 1}` },
      });
      if (response.status !== 206 && response.status !== 200) {
        await response.body?.cancel?.().catch?.(() => {});
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      // A server that ignores Range answers with the whole file.
      return response.status === 200 && buffer.byteLength === byteLength
        ? buffer.slice(start, end)
        : buffer;
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
    const xml = await response.text();
    for (const match of xml.matchAll(
      /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g,
    )) {
      if (!match[1].endsWith('.parquet')) continue;
      objects.push({ key: match[1], size: Number(match[2]) });
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

/**
 * Where each partition is: list the bucket, then read each file's footer
 * (one small range request) for its GeoParquet bbox. Built once and cached
 * by the caller; a partition without a bbox is left out.
 * @returns {Promise<Array<{ url: string, bbox: number[], size: number }>>}
 */
export async function buildPartitionIndex(entry, { fetchImpl, signal }) {
  const { keyBase } = entry.source.partitions;
  const objects = await listPartitions(entry, { fetchImpl, signal });
  const index = [];
  let next = 0;
  async function worker() {
    while (next < objects.length) {
      const { key, size } = objects[next++];
      signal?.throwIfAborted?.();
      const url = onSourceHost(entry, new URL(key, keyBase).href);
      try {
        const metadata = await parquetMetadataAsync(
          rangeBuffer(url, size, { fetchImpl, signal }),
          { initialFetchSize: FOOTER_FETCH_BYTES },
        );
        const { bbox } = geoParquetInfo(metadata);
        if (bbox) index.push({ url, bbox, size });
      } catch (error) {
        if (signal?.aborted) throw error;
        // One unreadable partition does not sink the index.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(INDEX_CONCURRENCY, objects.length) }, worker),
  );
  return index.sort((a, b) => a.url.localeCompare(b.url));
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
