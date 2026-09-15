import {
  listObjects,
  fetchObjectBuffer,
  parseGranuleKey,
} from './common/noaa-s3.js';
import { GLM_SATELLITES } from './glm/catalog.js';
import { decodeGlmGranule } from './glm/flashes.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function glmProxy({
  fetchImpl = fetch,
  listObjectsImpl = listObjects,
  fetchObjectBufferImpl = fetchObjectBuffer,
  parseGranuleImpl = decodeGlmGranule,
  now = () => Date.now(),
} = {}) {
  const state = new Map(
    GLM_SATELLITES.map((s) => [
      s.id,
      {
        flashes: new Map(),
        seen: new Set(),
        latestGranuleEnd: null,
        status: 'unavailable',
        reason: 'not fetched',
        granuleCount: 0,
      },
    ]),
  );
  let refreshing = null;
  let last = 0;
  const refresh = async () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const current = now();
      for (const sat of GLM_SATELLITES) {
        const st = state.get(sat.id);
        try {
          const hour = new Date(current);
          hour.setUTCMinutes(0, 0, 0);
          const hours = [new Date(hour)];
          if (current - hour.getTime() < 120000)
            hours.push(new Date(hour - 3600000));
          const entries = [];
          for (const h of hours) {
            const prefix = `GLM-L2-LCFA/${h.getUTCFullYear()}/${String(Math.floor((h - Date.UTC(h.getUTCFullYear(), 0, 1)) / 86400000) + 1).padStart(3, '0')}/${String(h.getUTCHours()).padStart(2, '0')}/`;
            const listed = await listObjectsImpl({
              bucket: sat.bucket,
              prefix,
              fetchImpl,
            });
            entries.push(...listed.keys);
          }
          const selected = entries
            .map((x) => ({ ...x, parsed: parseGranuleKey(x.key) }))
            .filter(
              (x) =>
                x.parsed &&
                x.parsed.startMs >= current - 150000 &&
                x.parsed.startMs <= current + 30000 &&
                !st.seen.has(`${sat.bucket}/${x.key}`),
            );
          for (const item of selected.slice(0, 20)) {
            const key = `${sat.bucket}/${item.key}`;
            try {
              const buffer = await fetchObjectBufferImpl({
                bucket: sat.bucket,
                key: item.key,
                fetchImpl,
              });
              const path = join(
                tmpdir(),
                `gev-glm-${process.pid}-${Math.random()}.nc`,
              );
              await fs.writeFile(path, buffer);
              const decoded = await parseGranuleImpl(path, {
                satelliteId: sat.id,
                granuleStartMs: item.parsed.startMs,
              });
              await fs.unlink(path).catch(() => {});
              st.seen.add(key);
              st.granuleCount++;
              st.latestGranuleEnd = Math.max(
                st.latestGranuleEnd ?? 0,
                item.parsed.endMs,
              );
              for (const flash of decoded.flashes)
                st.flashes.set(flash.id, flash);
            } catch {
              st.seen.add(key);
            }
          }
          for (const [id, flash] of st.flashes)
            if (flash.timeMs < current - 120000) st.flashes.delete(id);
          st.status = 'ok';
          st.reason = null;
        } catch (error) {
          st.status = 'unavailable';
          st.reason = error.message;
        }
      }
      last = current;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  };
  const response = async (includeFlashes) => {
    if (now() - last >= 20000) await refresh();
    const end = now();
    const all = GLM_SATELLITES.flatMap((s) => [
      ...state.get(s.id).flashes.values(),
    ]).sort((a, b) => b.timeMs - a.timeMs);
    const capped = all.slice(0, 20000);
    const sources = GLM_SATELLITES.map((s) => {
      const x = state.get(s.id);
      return {
        satelliteId: s.id,
        latestGranuleEnd: x.latestGranuleEnd,
        status: x.status,
        granuleCount: x.granuleCount,
        reason: x.reason,
      };
    });
    const out = {
      schemaVersion: 1,
      windowStart: end - 120000,
      windowEnd: end,
      fetchedAt: last,
      sources,
      coverageComplete: sources.every((x) => x.status === 'ok'),
      totalCount: all.length,
      returnedCount: capped.length,
      truncated: all.length > capped.length,
    };
    if (includeFlashes) out.flashes = capped;
    return out;
  };
  const handler = async (req, res) => {
    const subPath = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || !['', '/', '/status'].includes(subPath)) {
      res.writeHead(404, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    try {
      const body = JSON.stringify(await response(subPath !== '/status'));
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          schemaVersion: 1,
          flashes: [],
          totalCount: 0,
          returnedCount: 0,
          truncated: false,
        }),
      );
    }
  };
  return {
    name: 'glm',
    configureServer({ middlewares }) {
      middlewares.use('/api/glm', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/glm', handler);
    },
  };
}
