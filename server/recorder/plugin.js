import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aisStreamRows } from '../providers/vessels/ais-store.js';
import {
  aircraftPoints,
  localReceiverPoints,
  militaryPoints,
  vesselPoints,
} from './extract.js';
import { mergedSettings, recorderConfig } from './config.js';
import { exportPoints, summarizeTrack } from './exporters.js';
import { createPgStore } from './pgStore.js';
import { createRecorder } from './recorder.js';
import { DEFAULT_SAT_GROUPS, createSatelliteSource } from './satellites.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const VESSEL_POLL_MS = 30000;
const WINDOW_LIMIT = 200000; // the stores' default row limit for /window
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** A browser page on another origin must not change fences. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readJson(req, res, handle) {
  if (
    !sameOrigin(req) ||
    !/^application\/json/i.test(req.headers['content-type'] || '')
  )
    return sendJson(res, 403, { error: 'JSON from this origin only' });
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 16384) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    Promise.resolve()
      .then(() => handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
      .catch((error) =>
        sendJson(res, 400, { error: error?.message || 'Bad request' }),
      );
  });
}

const intParam = (v) => (v == null || v === '' ? null : Math.floor(Number(v)));

/**
 * Vite plugin: records aircraft, military and vessel positions to a local
 * SQLite file (GEV_HISTORY_FILE, default data/history.sqlite) and serves
 * /api/history/{range,track,window}. Off unless GEV_RECORDER=1. Recordings
 * stay on this machine; the history API answers loopback requests only.
 */
export function recorderPlugin(env = process.env) {
  const settings = mergedSettings(root, env);
  const enabled = settings.GEV_RECORDER === '1';
  const file =
    settings.GEV_HISTORY_FILE || path.join(root, 'data', 'history.sqlite');
  const config = enabled ? recorderConfig(settings) : null;

  function install(server) {
    if (!enabled) return;
    server.config?.logger?.info(
      `[gev-recorder] recording to ${config.databaseUrl ? 'PostgreSQL' : file}. ` +
        'Some feeds restrict storing their data: read docs/RECORDING-DATA-TERMS.md',
    );
    const recorder = createRecorder({
      file,
      retentionSec: config.retentionSec,
      layers: config.layers,
      maxBytes: config.maxBytes,
      intervalSec: config.intervalSec,
      store: config.databaseUrl ? createPgStore(config.databaseUrl) : undefined,
    });
    const nowSec = () => Math.floor(Date.now() / 1000);

    // Mounted ahead of the providers so their responses can be observed.
    for (const [mount, extract] of [
      ['/api/flights', aircraftPoints],
      ['/api/military', militaryPoints],
      ['/api/local-receivers/aircraft', localReceiverPoints],
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

    let satPoll = null;
    if (config.layers.includes('sat')) {
      const satGroups = config.satGroups.length
        ? config.satGroups
        : DEFAULT_SAT_GROUPS;
      const sats = createSatelliteSource({ groups: satGroups });
      // Start from the proxy's disk cache so recording does not wait for the browser.
      for (const group of satGroups)
        try {
          const cached = JSON.parse(
            readFileSync(
              // Same folder the CelesTrak proxy writes to.
              path.join(process.cwd(), '.gev-cache', `celestrak-${group}.json`),
              'utf8',
            ),
          );
          sats.learn(group, cached.body);
        } catch {
          // No cache yet: the first browser request fills it.
        }
      server.middlewares.use('/api/celestrak', (req, res, next) => {
        const group = String(req.url || '')
          .replace(/^\//, '')
          .split('?')[0];
        if (req.method !== 'GET' || !satGroups.includes(group)) return next();
        const chunks = [];
        const end = res.end;
        res.end = function (chunk, ...rest) {
          if (chunk && typeof chunk !== 'function')
            chunks.push(Buffer.from(chunk));
          try {
            if (res.statusCode === 200)
              sats.learn(group, Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Recording must never break the feed.
          }
          return end.call(this, chunk, ...rest);
        };
        const write = res.write;
        res.write = function (chunk, ...rest) {
          if (chunk) chunks.push(Buffer.from(chunk));
          return write.call(this, chunk, ...rest);
        };
        next();
      });
      const step = Math.max(config.intervalSec, 30);
      satPoll = setInterval(() => {
        try {
          // Whole steps, so timer jitter never makes a sample look too soon.
          recorder.ingestMany(sats.points(Math.round(nowSec() / step) * step));
        } catch {
          // Keep polling.
        }
      }, step * 1000);
      satPoll.unref?.();
    }

    const poll = setInterval(() => {
      try {
        recorder.ingestMany(vesselPoints(aisStreamRows(50000), nowSec()));
      } catch {
        // Keep polling.
      }
    }, VESSEL_POLL_MS);
    poll.unref?.();

    server.middlewares.use('/api/history', async (req, res) => {
      // A reverse proxy on this machine makes every request look like loopback,
      // so a request that was forwarded is treated as remote.
      const forwarded =
        req.headers['x-forwarded-for'] ||
        req.headers['x-real-ip'] ||
        req.headers.forwarded;
      if (forwarded || !LOOPBACK.has(req.socket?.remoteAddress))
        return sendJson(res, 403, { error: 'History is local only' });
      try {
        await recorder.flush();
        const url = new URL(req.url || '/', 'http://localhost');
        const q = url.searchParams;
        const from = intParam(q.get('from')) ?? 0;
        const to = intParam(q.get('to')) ?? nowSec();
        if (url.pathname === '/status') {
          let bytes = 0;
          try {
            bytes = config.databaseUrl
              ? await recorder.store.usedBytes()
              : statSync(file).size;
          } catch {
            // The file appears with the first flush.
          }
          return sendJson(res, 200, {
            ...(await recorder.store.range()),
            recording: true,
            retention_days: config.retentionSec / 86400,
            retention_sec: config.retentionSec,
            backend: config.databaseUrl ? 'postgres' : 'sqlite',
            layers: config.layers,
            interval_sec: config.intervalSec,
            max_bytes: config.maxBytes,
            bytes,
          });
        }
        if (url.pathname === '/fences') {
          if (req.method === 'POST')
            return readJson(req, res, async (body) => {
              const id = await recorder.addFence(body);
              return sendJson(res, 201, { id });
            });
          return sendJson(res, 200, {
            fences: await recorder.store.listFences(),
          });
        }
        if (url.pathname.startsWith('/fences/') && req.method === 'DELETE') {
          if (!sameOrigin(req))
            return sendJson(res, 403, {
              error: 'Cross-origin request refused',
            });
          const removed = await recorder.removeFence(
            Number(url.pathname.slice(8)),
          );
          return sendJson(res, removed ? 200 : 404, { removed });
        }
        if (url.pathname === '/pins') {
          if (req.method === 'POST')
            return readJson(req, res, async (body) => {
              const id = String(body?.id ?? '')
                .trim()
                .slice(0, 64);
              if (!id) throw new TypeError('id is required');
              await recorder.store.addPin(id, nowSec());
              return sendJson(res, 201, { id });
            });
          return sendJson(res, 200, { pins: await recorder.store.listPins() });
        }
        if (url.pathname.startsWith('/pins/') && req.method === 'DELETE') {
          if (!sameOrigin(req))
            return sendJson(res, 403, {
              error: 'Cross-origin request refused',
            });
          const removed = await recorder.store.removePin(
            decodeURIComponent(url.pathname.slice(6)),
          );
          return sendJson(res, removed ? 200 : 404, { removed });
        }
        if (url.pathname === '/events')
          return sendJson(res, 200, {
            events: await recorder.store.events({
              since: intParam(q.get('since')) ?? 0,
              fenceId: intParam(q.get('fence')),
              limit: Math.min(1000, intParam(q.get('limit')) ?? 200),
            }),
          });
        if (url.pathname === '/range')
          return sendJson(res, 200, await recorder.store.range());
        if (url.pathname.startsWith('/track/')) {
          let id;
          try {
            id = decodeURIComponent(url.pathname.slice(7));
          } catch {
            return sendJson(res, 400, { error: 'Bad contact id' });
          }
          const points = await recorder.store.track(id, from, to);
          return sendJson(res, 200, {
            id,
            points,
            ...summarizeTrack(points),
          });
        }
        const [west, south, east, north] = (q.get('bbox') || '')
          .split(',')
          .map(Number);
        const bbox = [west, south, east, north].every(Number.isFinite)
          ? { west, south, east, north }
          : null;
        const layers = (q.get('layers') || '').split(',').filter(Boolean);
        if (url.pathname === '/export') {
          const id = q.get('id');
          const points = id
            ? await recorder.store.track(id, from, to)
            : await recorder.store.window({ from, to, bbox, layers });
          const out = exportPoints(points, q.get('format') || 'json');
          res.statusCode = 200;
          res.setHeader('Content-Type', out.type);
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="gev-history.${out.ext}"`,
          );
          return res.end(out.body);
        }
        if (url.pathname === '/window') {
          const points = await recorder.store.window({
            from,
            to,
            bbox,
            layers,
          });
          // The store stops at its row limit; say so rather than look complete.
          return sendJson(res, 200, {
            points,
            truncated: points.length >= WINDOW_LIMIT,
          });
        }
        if (url.pathname === '/at')
          return sendJson(res, 200, {
            time: to,
            points: await recorder.store.at({ time: to, bbox, layers }),
          });
        return sendJson(res, 404, { error: 'Unknown history route' });
      } catch (error) {
        return sendJson(res, 500, { error: error?.message || 'History error' });
      }
    });

    server.httpServer?.on('close', () => {
      clearInterval(poll);
      if (satPoll) clearInterval(satPoll);
      recorder.close();
    });
  }

  return {
    name: 'gev-recorder',
    configureServer: install,
    configurePreviewServer: install,
  };
}
