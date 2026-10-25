import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aisStreamRows } from '../providers/vessels/ais-store.js';
import { aircraftPoints, militaryPoints, vesselPoints } from './extract.js';
import { createRecorder } from './recorder.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const VESSEL_POLL_MS = 30000;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const intParam = (v) => (v == null || v === '' ? null : Math.floor(Number(v)));

/**
 * Vite plugin: records aircraft, military and vessel positions to a local
 * SQLite file (GEV_HISTORY_FILE, default data/history.sqlite) and serves
 * /api/history/{range,track,window}. Off unless GEV_RECORDER=1. Recordings
 * stay on this machine; the history API answers loopback requests only.
 */
export function recorderPlugin(env = process.env) {
  const enabled = env.GEV_RECORDER === '1';
  const file =
    env.GEV_HISTORY_FILE || path.join(root, 'data', 'history.sqlite');
  const retentionDays = Number(env.GEV_HISTORY_DAYS ?? 7);

  function install(server) {
    if (!enabled) return;
    const recorder = createRecorder({ file, retentionDays });
    const nowSec = () => Math.floor(Date.now() / 1000);

    // Mounted ahead of the providers so their responses can be observed.
    for (const [mount, extract] of [
      ['/api/flights', aircraftPoints],
      ['/api/military', militaryPoints],
    ]) {
      server.middlewares.use(mount, (req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (req.method !== 'GET' || pathname !== '/') return next();
        const chunks = [];
        const end = res.end;
        const write = res.write;
        res.write = function (chunk, ...rest) {
          if (chunk) chunks.push(Buffer.from(chunk));
          return write.call(this, chunk, ...rest);
        };
        res.end = function (chunk, ...rest) {
          if (chunk && typeof chunk !== 'function')
            chunks.push(Buffer.from(chunk));
          try {
            if (res.statusCode === 200) {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              recorder.ingestMany(extract(body, nowSec()));
            }
          } catch {
            // Recording must never break the feed.
          }
          return end.call(this, chunk, ...rest);
        };
        next();
      });
    }

    const poll = setInterval(() => {
      try {
        recorder.ingestMany(vesselPoints(aisStreamRows(50000), nowSec()));
      } catch {
        // Keep polling.
      }
    }, VESSEL_POLL_MS);
    poll.unref?.();

    server.middlewares.use('/api/history', (req, res) => {
      if (!LOOPBACK.has(req.socket?.remoteAddress))
        return sendJson(res, 403, { error: 'History is local only' });
      try {
        recorder.flush();
        const url = new URL(req.url || '/', 'http://localhost');
        const q = url.searchParams;
        const from = intParam(q.get('from')) ?? 0;
        const to = intParam(q.get('to')) ?? nowSec();
        if (url.pathname === '/status') {
          let bytes = 0;
          try {
            bytes = statSync(file).size;
          } catch {
            // The file appears with the first flush.
          }
          return sendJson(res, 200, {
            ...recorder.store.range(),
            retention_days: retentionDays,
            bytes,
          });
        }
        if (url.pathname === '/range')
          return sendJson(res, 200, recorder.store.range());
        if (url.pathname.startsWith('/track/')) {
          const id = decodeURIComponent(url.pathname.slice(7));
          return sendJson(res, 200, {
            id,
            points: recorder.store.track(id, from, to),
          });
        }
        const [west, south, east, north] = (q.get('bbox') || '')
          .split(',')
          .map(Number);
        const bbox = [west, south, east, north].every(Number.isFinite)
          ? { west, south, east, north }
          : null;
        const layers = (q.get('layers') || '').split(',').filter(Boolean);
        if (url.pathname === '/window')
          return sendJson(res, 200, {
            points: recorder.store.window({ from, to, bbox, layers }),
          });
        if (url.pathname === '/at')
          return sendJson(res, 200, {
            time: to,
            points: recorder.store.at({ time: to, bbox, layers }),
          });
        return sendJson(res, 404, { error: 'Unknown history route' });
      } catch (error) {
        return sendJson(res, 500, { error: error?.message || 'History error' });
      }
    });

    server.httpServer?.on('close', () => {
      clearInterval(poll);
      recorder.close();
    });
  }

  return {
    name: 'gev-recorder',
    configureServer: install,
    configurePreviewServer: install,
  };
}
