import { randomUUID } from 'node:crypto';
import { onObservations } from '../common/observations.js';
import { setWatched } from '../common/watchRegistry.js';
import { getStore } from '../store/index.js';
import {
  sendJson,
  sendError,
  readJson,
  parseUrl,
  parseTime,
  route,
  badRequest,
  requestOwner,
} from '../common/json.js';
import {
  createRuleEngine,
  validateWatchlist,
  validateFence,
  validateRule,
  fenceCenter,
} from '../../../src/sources/alertRules.js';
import { validateChannel, maskChannel, createDeliverer } from './channels.js';
import { createTleCache, nextPass } from './satellites.js';

/**
 * Vite plugin: watchlists, geofences, alert rules and live alert delivery.
 *
 *   GET    /api/watch/state                      everything for this owner
 *   PUT    /api/watch/{watchlists|fences|rules|channels}/:id
 *   DELETE /api/watch/{watchlists|fences|rules|channels}/:id
 *   GET    /api/watch/alerts?since=-24h&limit=
 *   POST   /api/watch/alerts/:id/ack
 *   GET    /api/watch/stream                     Server-Sent Events
 *   POST   /api/watch/simulate {observations}    local profile only
 *   POST   /api/watch/channels/:id/test
 *   GET    /api/watch/passes?norad=25544&lat=&lon=&hours=24
 *
 * Environment: GEV_ALERTS_ENABLED=0 turns the service off;
 * GEV_WEBHOOK_HOSTS allows extra webhook hosts (Slack/Discord are built in).
 */

const KINDS = Object.freeze({
  watchlists: 'watchlist',
  fences: 'fence',
  rules: 'rule',
  channels: 'channel',
});
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PER_KIND = 200;
const OVERHEAD_EVERY_MS = 5 * 60_000;

export function createAlertService({
  getStore: storeOf = getStore,
  deliverer = createDeliverer(),
  getTle = createTleCache(),
  now = Date.now,
  env = process.env,
} = {}) {
  /** owner -> { config, engine, sse:Set, overheadFired:Map } */
  const owners = new Map();
  const counters = { evaluated: 0, fired: 0, persistFailed: 0 };
  let lastOverheadAt = 0;

  const ownerState = (owner) => {
    let s = owners.get(owner);
    if (!s) {
      s = {
        config: { watchlists: [], fences: [], rules: [], channels: [] },
        engine: createRuleEngine({}),
        sse: new Set(),
        overheadFired: new Map(),
      };
      owners.set(owner, s);
    }
    return s;
  };

  function refreshWatchRegistry() {
    const keys = new Set();
    for (const s of owners.values()) for (const k of s.engine.watchedIdKeys()) keys.add(k);
    setWatched(keys);
  }

  async function seedLastSeen(s) {
    const store = await storeOf();
    for (const key of s.engine.watchedIdKeys()) {
      const [domain, id] = key.split(':');
      if (domain === 'space') continue;
      const a = await store.asset(domain, id);
      if (a) s.engine.seen({ domain, id, t: a.lastSeen, lat: a.lastLat, lon: a.lastLon, label: a.label });
    }
  }

  async function reload(owner) {
    const store = await storeOf();
    const s = ownerState(owner);
    const config = {};
    for (const [plural, kind] of Object.entries(KINDS)) config[plural] = await store.listRecords(kind, owner);
    s.config = config;
    s.engine = createRuleEngine(config);
    await seedLastSeen(s);
    refreshWatchRegistry();
    return s;
  }

  async function loadAll() {
    const store = await storeOf();
    const seen = new Set();
    for (const kind of Object.values(KINDS))
      for (const r of await store.listRecords(kind)) seen.add(r.owner);
    for (const owner of seen) await reload(owner);
  }

  function push(s, name, data) {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of s.sse) {
      try {
        res.write(frame);
      } catch {
        s.sse.delete(res);
      }
    }
  }

  async function emit(owner, ev) {
    const s = ownerState(owner);
    const alert = {
      id: randomUUID(),
      owner,
      ruleId: ev.ruleId,
      t: ev.t,
      domain: ev.domain,
      asset: ev.id,
      kind: ev.kind,
      severity: ev.severity,
      title: ev.title,
      detail: { ...ev.detail, label: ev.label ?? null, rule: ev.ruleName ?? null },
      lat: ev.lat,
      lon: ev.lon,
    };
    counters.fired++;
    try {
      await (await storeOf()).insertAlert(alert);
    } catch (error) {
      counters.persistFailed++;
      console.error('[alerts] persist failed:', error?.message);
    }
    const { owner: _o, ...pub } = alert;
    push(s, 'alert', { ...pub, acked: false });
    const rule = s.config.rules.find((r) => r.id === ev.ruleId);
    for (const cid of rule?.channels || []) {
      const channel = s.config.channels.find((c) => c.id === cid);
      if (channel) deliverer.deliver(channel, alert, env).catch(() => {});
    }
    return alert;
  }

  function evaluateBatch(batch, onlyOwner) {
    const fired = [];
    for (const [owner, s] of owners) {
      if (onlyOwner && owner !== onlyOwner) continue;
      if (!s.config.rules.length) continue;
      for (const obs of batch) {
        counters.evaluated++;
        for (const ev of s.engine.evaluate(obs)) fired.push(emit(owner, ev));
      }
    }
    return Promise.all(fired);
  }

  async function planOverhead() {
    const t = now();
    for (const [owner, s] of owners) {
      for (const rule of s.config.rules) {
        if (rule.kind !== 'overhead' || rule.enabled === false) continue;
        const fence = s.config.fences.find((f) => f.id === rule.params.fenceId);
        const wl = s.config.watchlists.find((w) => w.id === rule.scope.watchlistId);
        if (!fence || !wl) continue;
        const [lon, lat] = fenceCenter(fence);
        const sats = wl.entries.filter((e) => e.domain === 'space' && e.id).slice(0, 50);
        for (const sat of sats) {
          const tle = await getTle(sat.id);
          const pass = nextPass(tle, { lat, lon, fromMs: t, minElevDeg: rule.params.minElevDeg, horizonHours: 6 });
          if (!pass) continue;
          const lead = pass.riseMs - t;
          if (lead < 0 || lead > rule.params.leadMinutes * 60_000) continue;
          const key = `${rule.id}|${sat.id}|${Math.round(pass.riseMs / 60_000)}`;
          if (s.overheadFired.has(key)) continue;
          s.overheadFired.set(key, t);
          if (s.overheadFired.size > 5000) s.overheadFired.delete(s.overheadFired.keys().next().value);
          const name = tle.name || `NORAD ${sat.id}`;
          const at = new Date(pass.riseMs).toISOString().slice(11, 16);
          await emit(owner, {
            ruleId: rule.id,
            ruleName: rule.name,
            kind: 'overhead',
            severity: rule.severity,
            domain: 'space',
            id: sat.id,
            label: name,
            t,
            lat,
            lon,
            title: `${name} rises over ${fence.name} at ${at} UTC, peak ${Math.round(pass.maxElevDeg)}°${pass.visible ? ', visible' : ''}`,
            detail: { pass, fence: fence.name },
          });
        }
      }
    }
  }

  async function tick() {
    const t = now();
    for (const [owner, s] of owners) {
      for (const ev of s.engine.tick(t)) await emit(owner, ev);
      s.engine.evict(t - 7 * 86_400_000);
    }
    if (t - lastOverheadAt >= OVERHEAD_EVERY_MS) {
      lastOverheadAt = t;
      await planOverhead().catch((e) => console.error('[alerts] overhead:', e?.message));
    }
  }

  function heartbeat() {
    for (const s of owners.values()) for (const res of s.sse) {
      try {
        res.write(': ping\n\n');
      } catch {
        s.sse.delete(res);
      }
    }
  }

  // ------------------------------------------------------------ handlers
  async function putItem(owner, plural, id, body) {
    const store = await storeOf();
    const kind = KINDS[plural];
    const s = ownerState(owner);
    const existing = s.config[plural];
    if (!existing.some((x) => x.id === id) && existing.length >= MAX_PER_KIND)
      badRequest(`at most ${MAX_PER_KIND} ${plural}`);
    let value;
    if (plural === 'watchlists') value = validateWatchlist(body);
    else if (plural === 'fences') value = validateFence(body);
    else if (plural === 'channels') value = validateChannel(body, env);
    else value = validateRule(body, s.config);
    await store.putRecord(kind, owner, id, value, now());
    await reload(owner);
    return plural === 'channels' ? maskChannel({ id, ...value }) : { id, ...value };
  }

  async function deleteItem(owner, plural, id) {
    const s = ownerState(owner);
    const refs = s.config.rules.filter(
      (r) =>
        (plural === 'watchlists' && r.scope?.watchlistId === id) ||
        (plural === 'fences' && r.params?.fenceId === id) ||
        (plural === 'channels' && (r.channels || []).includes(id)),
    );
    if (refs.length) return { conflict: refs.map((r) => r.name) };
    const removed = await (await storeOf()).deleteRecord(KINDS[plural], owner, id);
    await reload(owner);
    return { removed };
  }

  function publicState(owner) {
    const c = ownerState(owner).config;
    return {
      watchlists: c.watchlists,
      fences: c.fences,
      rules: c.rules,
      channels: c.channels.map(maskChannel),
    };
  }

  const handler = route('alerts', async (req, res, next) => {
    const { path, params } = parseUrl(req);
    const owner = requestOwner(req);
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'GET' && path === '/state') {
      if (!owners.has(owner)) await reload(owner);
      return sendJson(res, 200, publicState(owner));
    }

    if (parts.length === 2 && KINDS[parts[0]]) {
      const [plural, id] = parts;
      if (!ID_RE.test(id)) badRequest('id must be lowercase letters, digits and dashes');
      if (!owners.has(owner)) await reload(owner);
      if (req.method === 'PUT') return sendJson(res, 200, await putItem(owner, plural, id, await readJson(req)));
      if (req.method === 'DELETE') {
        const out = await deleteItem(owner, plural, id);
        if (out.conflict) return sendJson(res, 409, { error: 'in_use', rules: out.conflict });
        return sendJson(res, out.removed ? 200 : 404, out.removed ? { ok: true } : { error: 'not_found' });
      }
    }

    if (req.method === 'POST' && parts[0] === 'channels' && parts[2] === 'test' && ID_RE.test(parts[1] || '')) {
      const channel = ownerState(owner).config.channels.find((c) => c.id === parts[1]);
      if (!channel) return sendError(res, 404, 'not_found');
      const r = await deliverer.deliver(
        channel,
        { id: 'test', t: now(), kind: 'test', severity: 'info', title: 'Test alert from God\'s Eye View', lat: null, lon: null },
        env,
      );
      return sendJson(res, r.ok ? 200 : 502, r);
    }

    if (req.method === 'GET' && path === '/alerts') {
      const alerts = await (await storeOf()).listAlerts({
        owner,
        since: parseTime(params.get('since'), now()) ?? now() - 86_400_000,
        until: parseTime(params.get('until'), now()) ?? undefined,
        limit: params.get('limit'),
      });
      return sendJson(res, 200, { alerts: alerts.map(({ owner: _o, ...a }) => a) });
    }

    if (req.method === 'POST' && parts[0] === 'alerts' && parts[2] === 'ack') {
      const id = parts[1] || '';
      if (!/^[0-9a-f-]{36}$/.test(id)) badRequest('bad alert id');
      const n = await (await storeOf()).ackAlert(owner, id);
      return sendJson(res, n ? 200 : 404, n ? { ok: true } : { error: 'not_found' });
    }

    if (req.method === 'GET' && path === '/stream') {
      const s = owners.has(owner) ? ownerState(owner) : await reload(owner);
      if (s.sse.size >= 8) return sendError(res, 429, 'too_many_streams');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ t: now() })}\n\n`);
      s.sse.add(res);
      req.on('close', () => s.sse.delete(res));
      return;
    }

    if (req.method === 'POST' && path === '/simulate') {
      if (req.gevUser) return sendError(res, 403, 'local_only');
      const body = await readJson(req);
      const list = Array.isArray(body?.observations) ? body.observations.slice(0, 1000) : badRequest('observations must be an array');
      const obs = list
        .filter((o) => ['air', 'sea'].includes(o?.domain) && typeof o.id === 'string' && Number.isFinite(o.lat) && Number.isFinite(o.lon))
        .map((o) => ({ ...o, id: o.id.toLowerCase(), t: Number.isFinite(o.t) ? o.t : now() }));
      if (!owners.has(owner)) await reload(owner);
      const fired = await evaluateBatch(obs, owner);
      return sendJson(res, 200, { evaluated: obs.length, fired: fired.map(({ owner: _o, ...a }) => a) });
    }

    if (req.method === 'GET' && path === '/passes') {
      const norad = params.get('norad') || '';
      const lat = Number(params.get('lat'));
      const lon = Number(params.get('lon'));
      if (!/^\d{1,9}$/.test(norad)) badRequest('norad must be a catalog number');
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
        badRequest('lat and lon required');
      const hours = Math.min(72, Math.max(1, Number(params.get('hours')) || 24));
      const tle = await getTle(norad);
      if (!tle) return sendError(res, 502, 'tle_unavailable');
      const passes = [];
      let from = now();
      const end = from + hours * 3_600_000;
      while (from < end && passes.length < 20) {
        const p = nextPass(tle, { lat, lon, fromMs: from, horizonHours: Math.max(1, (end - from) / 3_600_000) });
        if (!p) break;
        passes.push(p);
        from = p.setMs + 60_000;
      }
      return sendJson(res, 200, { norad, name: tle.name, passes });
    }

    if (req.method === 'GET' && path === '/status')
      return sendJson(res, 200, { ...counters, owners: owners.size, delivery: deliverer.stats() });

    if (typeof next === 'function') return next();
    return sendError(res, 404, 'not_found');
  });

  return { handler, loadAll, reload, evaluateBatch, tick, heartbeat, counters, owners };
}

let service = null;

export function startAlertService(env = process.env) {
  if (service) return service;
  service = createAlertService({ env });
  service.loadAll().catch((e) => console.error('[alerts] load failed:', e?.message));
  onObservations((batch) => {
    service.evaluateBatch(batch).catch((e) => console.error('[alerts] evaluate:', e?.message));
  });
  const timers = [
    setInterval(() => service.tick().catch((e) => console.error('[alerts] tick:', e?.message)), 30_000),
    setInterval(() => service.heartbeat(), 25_000),
  ];
  for (const t of timers) t.unref?.();
  return service;
}

export function alertsProvider({ env = process.env } = {}) {
  const enabled = env.GEV_ALERTS_ENABLED !== '0';
  const install = (server) => {
    if (!enabled) return;
    server.middlewares.use('/api/watch', startAlertService(env).handler);
  };
  return { name: 'gev-alerts', configureServer: install, configurePreviewServer: install };
}
