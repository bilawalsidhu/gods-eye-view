import { readFileSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aisStreamRows } from '../providers/vessels/ais-store.js';
import {
  aircraftPoints,
  localReceiverPoints,
  militaryPoints,
  vesselPoints,
} from './extract.js';
import {
  ALL_LAYERS,
  cleanSettings,
  mergedSettings,
  parseDuration,
  recorderConfig,
  saveConfigFile,
} from './config.js';
import { exportPoints, summarizeTrack } from './exporters.js';
import { createPgStore } from './pgStore.js';
import { createFeedMonitor } from './feeds.js';
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

    // How each feed is doing, and a log of the changes so a quiet stretch in a
    // recording can later be told apart from a failed feed.
    const feeds = createFeedMonitor();
    const noteFeed = (layer, status, count) => {
      const change = feeds.observe(layer, { status, count, ts: nowSec() });
      if (change) logFeed([change]);
    };
    function logFeed(changes) {
      Promise.resolve(recorder.store.addFeedEvents(changes)).catch(() => {});
    }
    const feedTick = setInterval(() => {
      const changes = feeds.tick(nowSec());
      if (changes.length) logFeed(changes);
    }, 30000);
    feedTick.unref?.();

    // Mounted ahead of the providers so their responses can be observed.
    for (const [mount, layer, extract] of [
      ['/api/flights', 'air', aircraftPoints],
      ['/api/military', 'mil', militaryPoints],
      ['/api/local-receivers/aircraft', 'local', localReceiverPoints],
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
            let count = 0;
            if (res.statusCode === 200) {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const points = extract(body, nowSec());
              count = points.length;
              recorder.ingestMany(points);
            }
            noteFeed(layer, res.statusCode, count);
          } catch {
            // Recording must never break the feed.
          }
          return end.call(this, chunk, ...rest);
        };
        next();
      });
    }

    let satPoll = null;
    {
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
          if (recorder.settings().layers?.includes('sat')) {
            const points = sats.points(Math.round(nowSec() / step) * step);
            noteFeed('sat', 200, points.length);
            recorder.ingestMany(points);
          }
        } catch {
          // Keep polling.
        }
      }, step * 1000);
      satPoll.unref?.();
    }

    const poll = setInterval(() => {
      try {
        const points = vesselPoints(aisStreamRows(50000), nowSec());
        noteFeed('vessel', 200, points.length);
        recorder.ingestMany(points);
      } catch {
        // Keep polling.
      }
    }, VESSEL_POLL_MS);
    poll.unref?.();

    /** Which settings an environment variable sets, so the panel can say so. */
    const lockedSettings = () =>
      Object.entries({
        retention: ['GEV_HISTORY_RETENTION', 'GEV_HISTORY_DAYS'],
        maxMb: ['GEV_HISTORY_MAX_MB'],
        interval: ['GEV_RECORDER_INTERVAL'],
        layers: ['GEV_RECORDER_LAYERS'],
      })
        .filter(([, names]) =>
          names.some((name) => env[name] !== undefined && env[name] !== ''),
        )
        .map(([key]) => key);

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
          const live = recorder.settings();
          let bytes = 0;
          try {
            // Space in use, so thinning shows at once (the file itself keeps its size).
            bytes = await recorder.store.usedBytes();
          } catch {
            // The file appears with the first flush.
          }
          // Free space on the disk holding the SQLite file; PostgreSQL's disk
          // is not ours to measure.
          let diskFree = null;
          if (!config.databaseUrl)
            try {
              const fsInfo = statfsSync(path.dirname(file));
              diskFree = Number(fsInfo.bavail) * Number(fsInfo.bsize);
            } catch {
              // Leave it unknown.
            }
          return sendJson(res, 200, {
            ...(await recorder.store.range()),
            layer_counts: await recorder.store.layerCounts(),
            feeds: feeds.snapshot(live.layers ?? [], nowSec()),
            disk_free_bytes: diskFree,
            recording: true,
            retention_days: live.retentionSec / 86400,
            retention_sec: live.retentionSec,
            backend: config.databaseUrl ? 'postgres' : 'sqlite',
            layers: live.layers,
            available_layers: ALL_LAYERS,
            interval_sec: live.intervalSec,
            max_bytes: live.maxBytes,
            // Settings an environment variable fixes: a change lasts until restart.
            locked: lockedSettings(),
            bytes,
          });
        }
        if (url.pathname === '/feeds')
          return sendJson(res, 200, {
            events: await recorder.store.feedEvents({
              layer: String(q.get('layer') || ''),
              from,
              to,
            }),
          });
        if (url.pathname === '/settings' && req.method === 'POST')
          return readJson(req, res, async (body) => {
            const { runtime, file: saved } = cleanSettings(body);
            recorder.configure(runtime);
            // Applied now; kept in the settings file so a restart keeps it.
            let kept = true;
            try {
              saveConfigFile(root, saved, env);
            } catch {
              kept = false;
            }
            return sendJson(res, 200, { applied: true, saved: kept });
          });
        if (url.pathname === '/thin' && req.method === 'POST')
          return readJson(req, res, async (body) => {
            const olderSec = parseDuration(body?.olderThan || '1d');
            const bucket = Math.floor(Number(body?.keepEvery ?? 60));
            if (!(olderSec > 0)) throw new TypeError('Pick an age above zero');
            if (!(bucket >= 1 && bucket <= 86400))
              throw new TypeError('Keep one point every 1 to 86400 seconds');
            const result = await recorder.store.thinOld({
              before: nowSec() - olderSec,
              bucket,
              dryRun: body?.dryRun !== false,
            });
            return sendJson(res, 200, result);
          });
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
        // Area enter/exit events and emergency squawks in one list, newest
        // first, so the panel needs one request to know what happened.
        if (url.pathname === '/notices') {
          const since = intParam(q.get('since')) ?? 0;
          const limit = Math.min(200, intParam(q.get('limit')) ?? 50);
          const [events, alerts] = await Promise.all([
            recorder.store.events({ since, limit }),
            recorder.store.alerts({ since, limit }),
          ]);
          return sendJson(res, 200, {
            notices: [
              ...events.map((e) => ({
                type: 'fence',
                ts: e.ts,
                kind: e.kind,
                fence: e.fence || '',
                id: e.id,
                layer: e.layer,
                name: e.name || '',
                lat: e.lat,
                lon: e.lon,
              })),
              ...alerts.map((a) => ({
                type: 'emergency',
                ts: a.ts,
                kind: a.code,
                severity: a.severity,
                id: a.id,
                layer: a.layer,
                name: a.name,
                lat: a.lat,
                lon: a.lon,
                squawk: a.detail,
              })),
            ]
              .sort((a, b) => b.ts - a.ts)
              .slice(0, limit),
          });
        }
        if (url.pathname === '/search')
          return sendJson(res, 200, {
            matches: await recorder.store.findContacts(q.get('q') || ''),
          });
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
        if (url.pathname === '/density') {
          const cell = Math.min(
            10,
            Math.max(0.01, Number(q.get('cell')) || 0.5),
          );
          const cells = (
            await recorder.store.density({ from, to, bbox, layers, cell })
          ).map((c) => ({
            gx: Number(c.gx),
            gy: Number(c.gy),
            n: Number(c.n),
          }));
          return sendJson(res, 200, {
            cell,
            cells,
            max: cells.reduce((m, c) => Math.max(m, c.n), 0),
          });
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
      clearInterval(feedTick);
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
