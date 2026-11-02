import { createWellDataUrlResolver } from './dataBase.mjs';
import { readResponseBytesCapped } from '../../sources/httpBody.js';
import { validateWellPack, WELL_LIMITS } from './pack.js';
import { refineCountView } from './mixedDetail.js';
import { readTiles } from './tileReads.js';
import { createPartitionedCountLoader } from './partitionedCounts.js';
import {
  intersects,
  validateCountGrids,
  countView,
  validateCountView,
} from './countGrids.js';
/** One replaceable data index; bounded records and bytes per viewport; complete count grids otherwise. */
export function createSpatialWellSource({
  fetchImpl = globalThis.fetch,
  base = '/well-index-v1/',
  allowedDataOrigins = [],
  expectedIndexSha256,
  label = 'USGS',
  onCatalog = () => {},
} = {}) {
  if (
    expectedIndexSha256 !== undefined &&
    (typeof expectedIndexSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedIndexSha256))
  )
    throw new TypeError('Invalid well index digest');
  const dataUrl = createWellDataUrlResolver(base, allowedDataOrigins);
  let generation = 0;
  let active;
  let cachedCounts;
  const partitionedLoader = createPartitionedCountLoader();
  // Immutable, hash-verified bytes only. Keep the mutable index revalidated.
  const tileCache = new Map();
  let cacheBytes = 0;
  const cacheLimit = 16 * 1024 * 1024;
  return {
    label,
    viewport: true,
    async getSnapshot({
      signal,
      bounds = [-180, -90, 180, 90],
      countBudget = 4096,
      detailPriority,
    } = {}) {
      const current = ++generation;
      active?.abort();
      active = new AbortController();
      const combined = AbortSignal.any([
        active.signal,
        AbortSignal.timeout(15000),
        ...(signal ? [signal] : []),
      ]);
      let totalBytes = 0;
      const read = async (
        path,
        hash,
        cap = WELL_LIMITS.bytes,
        expectedBytes,
      ) => {
        combined.throwIfAborted();
        const cached = tileCache.get(hash);
        if (cached) {
          if (cached.length > cap)
            throw new TypeError('Cached well artifact exceeds byte limit');
          if (expectedBytes !== undefined && cached.length !== expectedBytes)
            throw new TypeError('Count reference byte mismatch');
          tileCache.delete(hash);
          tileCache.set(hash, cached);
          totalBytes += cached.length;
          if (totalBytes > 56 * 1024 * 1024)
            throw new TypeError('Viewport byte budget');
          return JSON.parse(new TextDecoder().decode(cached));
        }
        const response = await fetchImpl(dataUrl(path), {
          signal: combined,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-cache',
        });
        if (!response.ok)
          throw new Error(`Well index unavailable (HTTP ${response.status})`);
        const bytes = await readResponseBytesCapped(response, cap, combined);
        if (expectedBytes !== undefined && bytes.length !== expectedBytes)
          throw new TypeError('Count reference byte mismatch');
        totalBytes += bytes.length;
        if (totalBytes > 56 * 1024 * 1024)
          throw new TypeError('Viewport byte budget');
        if (hash) {
          const digest = [
            ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          ]
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('');
          if (digest !== hash) throw new Error('Well tile hash mismatch');
        }
        combined.throwIfAborted();
        if (current !== generation)
          throw new DOMException('Stale viewport', 'AbortError');
        if (
          hash &&
          path !== 'index.json' &&
          !path.endsWith('.counts.json') &&
          bytes.length <= cacheLimit
        ) {
          if (tileCache.has(hash)) {
            cacheBytes -= tileCache.get(hash).length;
            tileCache.delete(hash);
          }
          while (cacheBytes + bytes.length > cacheLimit) {
            const oldest = tileCache.keys().next().value;
            cacheBytes -= tileCache.get(oldest).length;
            tileCache.delete(oldest);
          }
          tileCache.set(hash, bytes);
          cacheBytes += bytes.length;
        }
        return JSON.parse(new TextDecoder().decode(bytes));
      };
      if (
        bounds !== null &&
        (!Array.isArray(bounds) ||
          bounds.length !== 4 ||
          !bounds.every(Number.isFinite) ||
          bounds[0] < -180 ||
          bounds[0] > 180 ||
          bounds[2] < -180 ||
          bounds[2] > 180 ||
          bounds[1] < -90 ||
          bounds[3] > 90 ||
          bounds[1] >= bounds[3])
      )
        throw new TypeError('Invalid viewport');
      let index = await read('index.json', expectedIndexSha256);
      const federated = Array.isArray(index.children);
      const publishCatalog = (value) => {
        combined.throwIfAborted();
        if (current !== generation)
          throw new DOMException('Stale viewport', 'AbortError');
        const catalog = index.catalogRecords ?? null,
          unmapped = index.unmappedRecords ?? null;
        if (
          catalog !== null &&
          (!Number.isSafeInteger(catalog) ||
            catalog < index.indexedRecords ||
            !Number.isSafeInteger(unmapped) ||
            unmapped !== catalog - index.indexedRecords)
        )
          throw new TypeError('Invalid catalog accounting');
        onCatalog({
          catalogRecords: catalog,
          mappedRecords: Number.isSafeInteger(index.indexedRecords)
            ? index.indexedRecords
            : null,
          unmappedRecords: unmapped,
          distinctPhysicalWells: null,
        });
        return value;
      };
      let regionsReady = !federated;
      if (federated) {
        if (
          index.sourceKind !== 'USGWD' ||
          index.children.length > 50 ||
          index.regions?.length !== 0 ||
          index.children.reduce((n, c) => n + c.count, 0) !==
            index.indexedRecords ||
          !Number.isSafeInteger(index.catalogRecords) ||
          index.catalogRecords < index.indexedRecords ||
          index.unmappedRecords !== index.catalogRecords - index.indexedRecords
        )
          throw new TypeError('Invalid federated source accounting');
        const paths = new Set();
        for (const c of index.children) {
          if (
            !/^states\/[A-Za-z_]+\/$/.test(c.directory) ||
            c.url !== `${c.directory}${c.sha256}.index.json` ||
            !/^[a-f0-9]{64}$/.test(c.sha256) ||
            !Number.isSafeInteger(c.bytes) ||
            c.bytes < 1 ||
            c.bytes > 8 * 1024 * 1024 ||
            !Number.isSafeInteger(c.count) ||
            c.count < 1 ||
            !Array.isArray(c.bounds) ||
            c.bounds.length !== 4 ||
            !c.bounds.every(Number.isFinite) ||
            c.bounds[0] < -180 ||
            c.bounds[2] > 180 ||
            c.bounds[1] < -90 ||
            c.bounds[3] > 90 ||
            c.bounds[0] >= c.bounds[2] ||
            c.bounds[1] >= c.bounds[3] ||
            paths.has(c.url)
          )
            throw new TypeError('Invalid federated source reference');
          paths.add(c.url);
        }
        const longitudeSpan = bounds
          ? bounds[2] >= bounds[0]
            ? bounds[2] - bounds[0]
            : bounds[2] - bounds[0] + 360
          : 360;
        const children = bounds
          ? index.children.filter((c) => intersects(c.bounds, bounds))
          : [];
        if (
          bounds &&
          longitudeSpan <= 2 &&
          bounds[3] - bounds[1] <= 2 &&
          children.length <= 8 &&
          children.reduce((n, c) => n + c.bytes, 0) <= 16 * 1024 * 1024
        ) {
          const regions = [];
          let population = 0;
          for (const c of children) {
            const child = await read(c.url, c.sha256, c.bytes, c.bytes);
            if (
              child.kind !== 'gev-well-spatial-index' ||
              child.schemaVersion !== 1 ||
              child.coverageComplete !== false ||
              child.sourceKind !== 'USGWD' ||
              child.sourceState !== c.state ||
              child.indexedRecords !== c.count ||
              !Array.isArray(child.regions) ||
              child.regions.length > 40000 ||
              child.regions.reduce((n, t) => n + t.count, 0) !== c.count
            )
              throw new TypeError('Invalid federated child accounting');
            for (const t of child.regions) {
              if (!/^[a-f0-9]{64}\.json$/.test(t.url))
                throw new TypeError('Invalid federated tile path');
              regions.push({ ...t, url: c.directory + t.url });
            }
            population += c.count;
          }
          if (regions.length <= 40000) {
            index = { ...index, regions, regionPopulation: population };
            regionsReady = true;
          }
        }
      }
      if (
        index.schemaVersion !== 1 ||
        index.kind !== 'gev-well-spatial-index' ||
        !Array.isArray(index.regions) ||
        index.regions.length > 40000
      )
        throw new TypeError('Invalid spatial index');
      for (const tile of index.regions) {
        if (
          !/^(?:states\/[A-Za-z_]+\/)?[a-f0-9]{64}\.json$/.test(tile.url) ||
          tile.url.split('/').at(-1) !== `${tile.sha256}.json` ||
          !Array.isArray(tile.bounds) ||
          tile.bounds.length !== 4 ||
          !tile.bounds.every(Number.isFinite) ||
          tile.bounds[0] < -180 ||
          tile.bounds[2] > 180 ||
          tile.bounds[1] < -90 ||
          tile.bounds[3] > 90 ||
          tile.bounds[0] >= tile.bounds[2] ||
          tile.bounds[1] >= tile.bounds[3] ||
          !Number.isInteger(tile.count) ||
          tile.count < 0 ||
          tile.count > 500
        )
          throw new TypeError('Invalid spatial tile');
      }
      const matching = index.regions.filter(
        (tile) => bounds && intersects(tile.bounds, bounds),
      );
      let grids;
      let partitioned = false,
        countCapped = false;
      if (index.aggregates) {
        if (
          new Set(index.regions.map((t) => t.url)).size !==
            index.regions.length ||
          (regionsReady &&
            index.regions.reduce((n, t) => n + t.count, 0) !==
              (index.regionPopulation ?? index.indexedRecords))
        )
          throw new TypeError('Index accounting mismatch');
        const ref = index.aggregates;
        if (ref.schemaVersion === 2) {
          partitioned = true;
          cachedCounts = undefined;
          if (!bounds)
            return publishCatalog(
              validateCountView({
                schemaVersion: 1,
                kind: 'gev-well-count-view',
                cells: [],
                degrees: 32,
                total: index.indexedRecords,
                reason: 'No visible ellipsoid',
                coverageComplete: false,
              }),
            );
          const loaded = await partitionedLoader.load(
            ref,
            index.indexedRecords,
            bounds,
            countBudget,
            (part) => read(part.url, part.sha256, part.bytes, part.bytes),
          );
          grids = loaded.grids;
          countCapped = loaded.capped;
        } else {
          if (
            !/^[a-f0-9]{64}\.counts\.json$/.test(ref.url) ||
            ref.url !== `${ref.sha256}.counts.json`
          )
            throw new TypeError('Invalid count reference');
          if (!bounds)
            return publishCatalog(
              validateCountView({
                schemaVersion: 1,
                kind: 'gev-well-count-view',
                cells: [],
                degrees: 32,
                total: index.indexedRecords,
                reason: 'No visible ellipsoid',
                coverageComplete: false,
              }),
            );
          if (
            cachedCounts?.sha === ref.sha256 &&
            cachedCounts.total === index.indexedRecords
          )
            grids = cachedCounts.grids;
          else {
            grids = validateCountGrids(
              await read(ref.url, ref.sha256, 32 * 1024 * 1024),
              index.indexedRecords,
            );
            cachedCounts = {
              sha: ref.sha256,
              total: index.indexedRecords,
              grids,
            };
          }
        }
      }
      const rows = matching.reduce((n, t) => n + t.count, 0);
      const bytes = matching.reduce(
        (n, t) => n + (Number.isSafeInteger(t.bytes) ? t.bytes : 0),
        0,
      );
      const over =
        !regionsReady ||
        rows > 2000 ||
        bytes > 16 * 1024 * 1024 ||
        matching.length > 256;
      if (grids && (!bounds || over)) {
        const view = {
          ...countView(
            grids,
            bounds,
            !bounds
              ? 'No visible ellipsoid'
              : over
                ? 'Detail record/byte budget; showing complete counts'
                : 'Overview',
            countBudget,
          ),
          referenceRetrievedAt: index.fallbackAcquisition?.retrievedAt,
        };
        if (countCapped)
          view.reason +=
            '; fine summary budget reached, complete coarser counts retained';
        // A source-only caller has no screen resolution evidence. Do not eagerly
        // hydrate arbitrary detail islands at national zoom. The app supplies its
        // existing screen-aware eligibility callback for mixed views.
        if (federated || (partitioned && !detailPriority))
          return publishCatalog(view);
        const startBytes = totalBytes;
        const mixed = await refineCountView(
          view,
          index,
          async (tile) => {
            const pack = await read(tile.url, tile.sha256);
            if (totalBytes - startBytes > 16 * 1024 * 1024)
              throw new TypeError('Detail byte budget');
            return pack;
          },
          detailPriority,
        );
        combined.throwIfAborted();
        return publishCatalog(mixed);
      }
      if (over)
        throw new TypeError('Detail budget exceeded; count index required');
      // Every intersecting pack is admitted when within the record/byte budget.
      const selected = matching;
      const records = new Map();
      const acquisitions = new Map();
      const detailStartBytes = totalBytes;
      const packs = await readTiles(selected, (tile) =>
        read(tile.url, tile.sha256),
      );
      for (const [i, tile] of selected.entries()) {
        const pack = validateWellPack(packs[i]);
        if (totalBytes - detailStartBytes > 16 * 1024 * 1024)
          throw new TypeError('Detail byte budget');
        if (pack.records.length !== tile.count)
          throw new TypeError('Tile accounting mismatch');
        for (const r of pack.records) {
          if (
            r.longitude < tile.bounds[0] ||
            r.longitude > tile.bounds[2] ||
            r.latitude < tile.bounds[1] ||
            r.latitude > tile.bounds[3]
          )
            throw new TypeError('Tile spatial accounting mismatch');
          if (records.has(r.id)) {
            if (JSON.stringify(records.get(r.id)) !== JSON.stringify(r))
              throw new TypeError('Conflicting source ID');
          } else records.set(r.id, r);
        }
        for (const a of pack.acquisitions)
          acquisitions.set(JSON.stringify(a), a);
        if (acquisitions.size > 256) {
          if (grids)
            return publishCatalog(
              countView(
                grids,
                bounds,
                'Provenance budget; showing complete counts',
                countBudget,
              ),
            );
          throw new TypeError('Detail provenance budget');
        }
      }
      if (!acquisitions.size)
        acquisitions.set('fallback', index.fallbackAcquisition);
      const inBounds = (r) =>
        bounds &&
        r.latitude >= bounds[1] &&
        r.latitude <= bounds[3] &&
        (bounds[0] <= bounds[2]
          ? r.longitude >= bounds[0] && r.longitude <= bounds[2]
          : r.longitude >= bounds[0] || r.longitude <= bounds[2]);
      const pack = {
        schemaVersion: 1,
        kind: 'gev-us-groundwater-wells',
        mode: 'snapshot',
        // A catalog count requires complete index accounting, not tile counts.
        ...(grids ? { catalogTotal: index.indexedRecords } : {}),
        coverage: {
          country: 'US',
          complete: false,
          indexed: true,
          description: `Partial ${label} source records; ${records.size} admitted sites across all ${matching.length} intersecting packs. Detail budget: 2,000 records / 16 MiB. All in-view admitted records are eligible; absent dots do not mean absent wells. Consult source acquisition and measurement dates.`,
        },
        acquisitions: [...acquisitions.values()],
        records: [...records.values()].filter(inBounds),
      };
      combined.throwIfAborted();
      return publishCatalog(validateWellPack(pack));
    },
    cancel() {
      generation++;
      active?.abort();
    },
  };
}
