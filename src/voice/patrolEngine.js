import {
  matchesFilter,
  resolveScope,
  inScope,
  withDistance,
  recordLabel,
} from './watchEngine.js';

/**
 * Standing missions: "watch the Gulf for ships that stop or go dark and
 * brief me every 20 minutes". A patrol re-reads its layers on an interval,
 * diffs against the previous pass (arrivals, departures, stops, big altitude
 * changes) and speaks a short briefing with the receipts kept in a ledger.
 */
export const PATROL_STORAGE_KEY = 'gev:voice-patrols:v1';
const MAX_PATROLS = 6;
const MAX_LEDGER = 20;
const MIN = 60_000;

/** Pure diff between two passes of {id -> compact record}. */
export function diffPasses(previous, current, layerId) {
  const arrived = [];
  const departed = [];
  const stopped = [];
  const climbed = [];
  const descended = [];
  for (const [id, record] of current) {
    const before = previous.get(id);
    if (!before) {
      arrived.push(record);
      continue;
    }
    if (layerId === 'ais-live-vessels') {
      if (Number.isFinite(before.speedKts) && Number.isFinite(record.speedKts))
        if (before.speedKts > 3 && record.speedKts < 0.6) stopped.push(record);
    } else if (
      Number.isFinite(before.altitudeM) &&
      Number.isFinite(record.altitudeM)
    ) {
      const delta = record.altitudeM - before.altitudeM;
      if (delta > 3000) climbed.push(record);
      else if (delta < -3000) descended.push(record);
    }
  }
  for (const [id, record] of previous)
    if (!current.has(id)) departed.push(record);
  return { arrived, departed, stopped, climbed, descended };
}

/** One spoken paragraph for a pass. */
export function composeBriefing(patrol, passes, { anomalies = [] } = {}) {
  const parts = [`Patrol ${patrol.name}:`];
  const nonEmpty = passes.filter((p) => p.count > 0);
  const shown = nonEmpty.length ? nonEmpty : passes.slice(0, 1);
  for (const pass of shown) {
    const { layerId, count, diff, first } = pass;
    const noun = nounFor(layerId, count);
    let line = `${count} ${noun} in range`;
    if (first) line += ' on the first pass';
    else {
      const bits = [];
      if (diff.arrived.length)
        bits.push(`${diff.arrived.length} new (${names(diff.arrived)})`);
      if (diff.departed.length) bits.push(`${diff.departed.length} left`);
      if (diff.stopped.length)
        bits.push(`${diff.stopped.length} stopped (${names(diff.stopped)})`);
      if (diff.climbed.length)
        bits.push(`${diff.climbed.length} climbed sharply`);
      if (diff.descended.length)
        bits.push(
          `${diff.descended.length} descended sharply (${names(diff.descended)})`,
        );
      line += bits.length ? `, ${bits.join(', ')}` : ', no change';
    }
    parts.push(`${line}.`);
  }
  if (anomalies.length)
    parts.push(
      `${anomalies.length} ${anomalies.length === 1 ? 'anomaly' : 'anomalies'}: ${anomalies
        .slice(0, 3)
        .map((a) => a.text.replace(/\.$/, ''))
        .join('; ')}.`,
    );
  return parts.join(' ');
}

function names(records, max = 3) {
  const labels = records.slice(0, max).map((r) => r.label);
  return records.length > max
    ? `${labels.join(', ')} and ${records.length - max} more`
    : labels.join(', ');
}

function nounFor(layerId, count) {
  const one =
    layerId === 'ais-live-vessels'
      ? 'vessel'
      : layerId === 'earthquakes'
        ? 'quake'
        : layerId === 'local-firms'
          ? 'fire'
          : 'aircraft';
  if (one === 'aircraft') return 'aircraft';
  return count === 1 ? one : `${one}s`;
}

export function createPatrolEngine({
  dataManager,
  getCamera = () => null,
  getAnomalies = () => [],
  speak = () => {},
  storage = safeStorage(),
  now = () => Date.now(),
  tickMs = 30_000,
  setTimer = (fn, ms) => {
    const id = setInterval(fn, ms);
    id?.unref?.(); // never keep a Node process (tests) alive
    return id;
  },
  clearTimer = (id) => clearInterval(id),
} = {}) {
  let patrols = load();
  const passes = new Map(); // patrol id -> Map(layerId -> Map(id -> record))
  let timer = null;

  function load() {
    try {
      const raw = storage?.getItem(PATROL_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function save() {
    try {
      storage?.setItem(PATROL_STORAGE_KEY, JSON.stringify(patrols));
    } catch {
      /* no-op */
    }
  }

  function records(layerId) {
    if (!dataManager?.isEnabled?.(layerId)) return null;
    const module = dataManager.layers?.get?.(layerId)?.module;
    if (typeof module?.getAnalystRecords !== 'function') return null;
    try {
      return module.getAnalystRecords(6000) || [];
    } catch {
      return [];
    }
  }

  function compact(record, layerId) {
    return {
      id: String(record.id ?? record.icao24 ?? record.mmsi ?? ''),
      label: recordLabel(record, layerId),
      speedKts: record.speedKts,
      altitudeM: record.altitudeM,
      lat: record.lat,
      lon: record.lon,
    };
  }

  function run(patrol, { speakIt = true } = {}) {
    const t = now();
    const resolved = resolveScope(
      patrol.scope,
      patrol.scopeCamera || getCamera(),
    );
    const filters = Array.isArray(patrol.filters) ? patrol.filters : [];
    const previousByLayer = passes.get(patrol.id) || new Map();
    const nextByLayer = new Map();
    const results = [];
    for (const layerId of patrol.layers) {
      const rows = records(layerId);
      if (!rows) {
        results.push({
          layerId,
          count: 0,
          unavailable: true,
          first: !previousByLayer.has(layerId),
          diff: diffPasses(new Map(), new Map(), layerId),
        });
        continue;
      }
      const current = new Map();
      for (const record of withDistance(rows, resolved)) {
        if (!inScope(record, resolved)) continue;
        if (!filters.every((f) => matchesFilter(record, f))) continue;
        const c = compact(record, layerId);
        if (c.id) current.set(c.id, c);
      }
      const previous = previousByLayer.get(layerId);
      nextByLayer.set(layerId, current);
      results.push({
        layerId,
        count: current.size,
        first: !previous,
        diff: diffPasses(previous || new Map(), current, layerId),
      });
    }
    passes.set(patrol.id, nextByLayer);
    const anomalies = (getAnomalies() || []).filter(
      (a) =>
        !resolved ||
        (Number.isFinite(a.lat) &&
          inScope({ lat: a.lat, lon: a.lon }, resolved)),
    );
    const text = composeBriefing(patrol, results, { anomalies });
    patrol.lastRunAt = t;
    patrol.ledger = [{ at: t, text }, ...(patrol.ledger || [])].slice(
      0,
      MAX_LEDGER,
    );
    save();
    if (speakIt) speak(text);
    return { text, results };
  }

  function tick() {
    const t = now();
    for (const patrol of patrols) {
      const due =
        !patrol.lastRunAt ||
        t - patrol.lastRunAt >= patrol.intervalMinutes * MIN;
      if (due) run(patrol);
    }
  }

  return {
    start() {
      if (timer != null) return;
      timer = setTimer(tick, tickMs);
    },
    tick,
    run,
    add({
      name,
      layers = ['flights'],
      scope = { kind: 'view' },
      filters = [],
      intervalMinutes = 20,
      briefNow = true,
    }) {
      const existing = this.find(name);
      if (existing) {
        const again = run(existing, { speakIt: false });
        return {
          id: existing.id,
          name: existing.name,
          layers: existing.layers,
          intervalMinutes: existing.intervalMinutes,
          alreadyRunning: true,
          firstBriefing: again.text,
        };
      }
      if (patrols.length >= MAX_PATROLS)
        throw new Error(`At most ${MAX_PATROLS} patrols`);
      const camera = getCamera();
      const patrol = {
        id: `p${now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        name: String(name || `patrol ${patrols.length + 1}`).slice(0, 60),
        layers: layers.filter(Boolean),
        scope: scope || { kind: 'view' },
        scopeCamera:
          scope?.kind === 'view' ||
          (scope?.kind === 'radius' && !Number.isFinite(scope?.latitude))
            ? camera
            : null,
        filters,
        intervalMinutes: Math.min(
          120,
          Math.max(2, Number(intervalMinutes) || 20),
        ),
        createdAt: now(),
        lastRunAt: null,
        ledger: [],
      };
      patrols.push(patrol);
      save();
      this.start();
      const first = run(patrol, { speakIt: briefNow });
      return {
        id: patrol.id,
        name: patrol.name,
        layers: patrol.layers,
        intervalMinutes: patrol.intervalMinutes,
        firstBriefing: first.text,
      };
    },
    list() {
      return patrols.map((p) => ({
        id: p.id,
        name: p.name,
        layers: p.layers,
        scope: p.scope?.kind || 'anywhere',
        intervalMinutes: p.intervalMinutes,
        lastRunMinutesAgo: p.lastRunAt
          ? Math.round((now() - p.lastRunAt) / MIN)
          : null,
        lastBriefing: p.ledger?.[0]?.text || null,
      }));
    },
    find(nameOrId) {
      const key = String(nameOrId || '')
        .toLowerCase()
        .trim();
      return (
        patrols.find(
          (p) => p.id === nameOrId || p.name.toLowerCase() === key,
        ) ||
        patrols.find((p) => p.name.toLowerCase().includes(key)) ||
        null
      );
    },
    ledger(nameOrId) {
      const patrol = this.find(nameOrId) || patrols[0];
      return patrol ? patrol.ledger || [] : [];
    },
    stop(nameOrId) {
      if (!nameOrId) {
        const n = patrols.length;
        patrols = [];
        passes.clear();
        save();
        return n;
      }
      const patrol = this.find(nameOrId);
      if (!patrol) return 0;
      patrols = patrols.filter((p) => p.id !== patrol.id);
      passes.delete(patrol.id);
      save();
      return 1;
    },
    destroy() {
      if (timer != null) clearTimer(timer);
      timer = null;
    },
  };
}

function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
