import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createOffshoreInventorySource } from 'gods-eye-view/layers/offshore-platforms/source';
import { createOffshorePlatformsLayer } from 'gods-eye-view/layers/offshore-platforms';
import { normalizeOffshoreSnapshot, structureKind } from './records.js';

const raw = JSON.parse(
  await readFile(
    new URL(
      '../../data/local_data/offshore-platforms/platforms.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const snapshot = normalizeOffshoreSnapshot(raw);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('bundled inventory agrees with audit and retains unknown types without inventing production status', async () => {
  const bytes = await readFile(
    new URL(
      '../../data/local_data/offshore-platforms/platforms.json',
      import.meta.url,
    ),
  );
  const provenance = JSON.parse(
    await readFile(
      new URL(
        '../../data/local_data/offshore-platforms/provenance.json',
        import.meta.url,
      ),
    ),
  );
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    provenance.outputSha256,
  );
  assert.equal(snapshot.records.length, provenance.counts.included);
  assert.equal(
    provenance.counts.shapeRows,
    provenance.counts.included +
      provenance.counts.removedExcluded +
      provenance.counts.mobileProductionExcluded,
  );
  assert.equal(
    new Set(snapshot.records.map((r) => r.id)).size,
    snapshot.records.length,
  );
  assert(
    snapshot.records.every(
      (r) =>
        r.removed === null &&
        !('active' in r) &&
        r.lon > -98 &&
        r.lon < -81 &&
        r.lat > 23 &&
        r.lat < 31,
    ),
  );
  assert.equal(
    snapshot.records.filter((r) => !r.typeCode).length,
    provenance.counts.unmatchedIncluded,
  );
  assert.equal(structureKind('SSTMP'), 'subsea');
  assert.equal(structureKind('UCOMP'), 'subsea');
  assert.equal(structureKind('FIXED'), 'surface');
  assert.equal(structureKind('NEW'), 'unknown');
});

test('record normalization fails malformed snapshots and excludes explicitly removed and mobile records', () => {
  const record = raw.records[0];
  for (const patch of [
    { lon: NaN },
    { lat: 91 },
    { id: 'invented' },
    { installed: 'yesterday' },
  ]) {
    assert.throws(() =>
      normalizeOffshoreSnapshot({ ...raw, records: [{ ...record, ...patch }] }),
    );
  }
  assert.throws(() =>
    normalizeOffshoreSnapshot({ ...raw, records: [record, record] }),
  );
  assert.throws(() => normalizeOffshoreSnapshot({ ...raw, schemaVersion: 9 }));
  for (const patch of [{ removed: '2026-01-01' }, { typeCode: 'MOPU' }]) {
    assert.equal(
      normalizeOffshoreSnapshot({ ...raw, records: [{ ...record, ...patch }] })
        .records.length,
      0,
    );
  }
});

test('public source is lazy, passes cancellation, rejects HTTP failure and validates records', async () => {
  let calls = 0;
  const controller = new AbortController();
  const source = createOffshoreInventorySource({
    url: 'https://fixture.invalid/platforms.json',
    fetchImpl: async (url, { signal }) => {
      calls++;
      assert.equal(signal, controller.signal);
      return { ok: true, json: async () => raw };
    },
  });
  assert.equal(calls, 0);
  assert.equal(
    (await source.getSnapshot({ signal: controller.signal })).records.length,
    1542,
  );
  controller.abort();
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(calls, 1);
  await assert.rejects(
    createOffshoreInventorySource({
      url: 'fixture',
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }).getSnapshot(),
    /503/,
  );
});

test('instances coalesce loads, release renderer on disable, cache only data and clear cache on destruction', async () => {
  let reads = 0,
    builds = 0,
    releases = 0;
  const source = {
    getSnapshot: async () => {
      reads++;
      return snapshot;
    },
  };
  const rendererFactory = async () => {
    builds++;
    return {
      destroy() {
        releases++;
      },
      getDiagnostics() {
        return {};
      },
    };
  };
  const a = createOffshorePlatformsLayer({ source, rendererFactory });
  const b = createOffshorePlatformsLayer({ source, rendererFactory });
  a.init({});
  b.init({});
  const first = a.enable();
  assert.equal(first, a.enable());
  await first;
  assert.equal(reads, 1);
  a.disable();
  assert.equal(releases, 1);
  assert.equal(a.getStats().count, 0);
  await a.enable();
  assert.equal(reads, 1);
  assert.equal(builds, 2);
  await b.enable();
  assert.equal(reads, 2);
  a.destroy();
  a.destroy();
  assert.equal(releases, 2);
  assert.equal(b.getStats().count, snapshot.records.length);
  b.destroy();
  assert.equal(releases, 3);
  assert.equal(await a.enable(), false);
});

test('late source and render results cannot resurrect a disabled or destroyed layer', async () => {
  const load = deferred();
  let signal;
  let builds = 0;
  const layer = createOffshorePlatformsLayer({
    source: {
      getSnapshot(options) {
        signal = options.signal;
        return load.promise;
      },
    },
    rendererFactory: () => {
      builds++;
    },
  });
  layer.init({});
  const pending = layer.enable();
  await Promise.resolve();
  layer.disable();
  assert(signal.aborted);
  load.resolve(snapshot);
  await pending;
  assert.equal(builds, 0);
  const render = deferred();
  let released = 0;
  const second = createOffshorePlatformsLayer({
    source: { getSnapshot: async () => snapshot },
    rendererFactory: () => render.promise,
  });
  second.init({});
  const pendingRender = second.enable();
  await Promise.resolve();
  await Promise.resolve();
  second.destroy();
  render.resolve({
    destroy() {
      released++;
    },
  });
  await pendingRender;
  assert.equal(released, 1);
  assert.equal(second.getStats().count, 0);
});

// The manager treats an explicit false update as a rejected enable transaction.
test('static layer remains enabled through the manager initial-update contract', async () => {
  const { LayerLifecycle } = await import('../../data/lifecycle.js');
  const manager = new LayerLifecycle({});
  const layer = createOffshorePlatformsLayer({
    source: { getSnapshot: async () => snapshot },
    rendererFactory: async () => ({
      destroy() {},
      getDiagnostics() {
        return {};
      },
    }),
  });
  manager.register(layer);
  assert.equal(await manager.setEnabled(layer.id, true), true);
  assert.equal(manager.isEnabled(layer.id), true);
  assert.equal(layer.getStats().count, 1542);
  await manager.setEnabled(layer.id, false);
  layer.destroy();
});
