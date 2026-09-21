import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWorldNewsLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { WORLD_NEWS_OVERLAY_SOURCE_ID } from './policy.js';

const ROTTERDAM = 'wn-place:51.920:4.480';
const TOKYO = 'wn-place:35.680:139.690';

function fakeViewer() {
  const sources = [];
  return {
    sources,
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        const index = sources.indexOf(value);
        if (index >= 0) sources.splice(index, 1);
        return index >= 0;
      },
    },
    scene: {
      canvas: {
        disableRootEvents: true,
        onwheel: null,
        addEventListener() {},
        removeEventListener() {},
      },
      pick: () => null,
    },
    camera: {},
    creditDisplay: { addStaticCredit() {} },
  };
}

function fakeServices() {
  const calls = [];
  const store = { entities: new Map(), selectedId: null };
  const owners = new Map();
  return {
    calls,
    store,
    owners,
    render: {
      governorRequestRender(reason) {
        calls.push(['render', reason]);
      },
    },
    picking: {
      registerPickOwner(layerId, predicate) {
        owners.set(layerId, predicate);
        calls.push(['registerPickOwner', layerId]);
      },
      unregisterPickOwner(layerId) {
        owners.delete(layerId);
        calls.push(['unregisterPickOwner', layerId]);
      },
      resolvePickId(picked) {
        const id = picked?.id;
        if (typeof id === 'string') return id;
        return typeof id?.id === 'string' ? id.id : null;
      },
      isOwnedByOtherLayer(layerId, pickedId) {
        for (const [owner, predicate] of owners)
          if (owner !== layerId && predicate(pickedId)) return true;
        return false;
      },
    },
    context: {
      registerEntityContext(entity, metadata) {
        entity.__gevContextId = metadata.id;
        store.entities.set(metadata.id, { ...metadata, entity });
        calls.push(['register', metadata.id]);
      },
      selectEntityContext(entity) {
        const id = entity?.__gevContextId;
        if (!id || !store.entities.has(id)) return null;
        store.selectedId = id;
        calls.push(['select', id]);
        return store.entities.get(id);
      },
      getSelectedEntityContext() {
        return store.selectedId
          ? store.entities.get(store.selectedId) || null
          : null;
      },
      clearSelectedEntityContextForLayer(layerId, { evicted = false } = {}) {
        const record = store.selectedId
          ? store.entities.get(store.selectedId)
          : null;
        if (record?.layerId === layerId) {
          store.selectedId = null;
          calls.push(['clear', layerId, evicted]);
        }
      },
      removeEntityContextsForLayer(layerId, { retainIds } = {}) {
        for (const [id, record] of store.entities)
          if (record.layerId === layerId && !retainIds?.has(id))
            store.entities.delete(id);
        if (store.selectedId && !store.entities.has(store.selectedId))
          store.selectedId = null;
      },
    },
    overlays: {
      refreshReadout(entity) {
        calls.push(['refreshReadout', entity.id]);
      },
    },
    credits: {
      register(viewer, credit) {
        calls.push(['credit', credit.key]);
        return true;
      },
    },
  };
}

function fakeOverlayHost() {
  const events = [];
  return {
    events,
    setEntries(...args) {
      events.push(['set', ...args]);
    },
    setVisible(...args) {
      events.push(['visible', ...args]);
    },
    clearSource(...args) {
      events.push(['clear', ...args]);
    },
  };
}

function fakeHandlerFactory() {
  const handlers = [];
  return {
    handlers,
    factory: () => {
      const handler = {
        actions: new Map(),
        destroyed: false,
        setInputAction(callback, type) {
          handler.actions.set(type, callback);
        },
        destroy() {
          handler.destroyed = true;
        },
        click(position = { x: 1, y: 1 }) {
          handler.actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
            position,
          });
        },
      };
      handlers.push(handler);
      return handler;
    },
  };
}

function row(overrides = {}) {
  const publishedAt = overrides.publishedAt ?? '2026-09-15T06:00:00Z';
  return {
    id: 'wn-a',
    title: 'Port strike halts shipping in Rotterdam',
    url: 'https://a.example/1',
    domain: 'a.example',
    publishedAt,
    publishedMs: publishedAt ? Date.parse(publishedAt) : null,
    sentiment: -0.5,
    category: 'business',
    language: 'en',
    sourceCountry: 'nl',
    lat: 51.92,
    lon: 4.48,
    place: 'Rotterdam',
    placeFoundIn: 'title',
    placeMentions: 1,
    ...overrides,
  };
}
const ROW_A = row();
const ROW_B = row({
  id: 'wn-b',
  title: 'Rotterdam museum reopens after renovation',
  url: 'https://b.example/2',
  domain: 'b.example',
  publishedAt: '2026-09-15T05:00:00Z',
  sentiment: 0.6,
  lat: 51.9201,
  lon: 4.4801,
});
const ROW_C = row({
  id: 'wn-c',
  title: 'Heat advisory extended across Tokyo',
  url: 'https://c.example/3',
  domain: 'c.example',
  publishedAt: '2026-09-15T07:00:00Z',
  sentiment: null,
  lat: 35.68,
  lon: 139.69,
  place: 'Tokyo',
});

function snapshot(rows, overrides = {}) {
  return {
    rows,
    fetchedAt: 1_757_916_000_000,
    stale: false,
    blocked: null,
    budget: { spent: 4, limit: 50, date: '2026-09-15' },
    quota: { left: 90, used: 10 },
    requested: 20,
    unplacedCount: 20 - rows.length,
    morePagesLeft: 2,
    costPerRequest: 2,
    costMeasured: true,
    ...overrides,
  };
}

function harness(source, { credit = { key: 'test-credit', html: 'x' } } = {}) {
  const viewer = fakeViewer();
  const services = fakeServices();
  const overlayHost = fakeOverlayHost();
  const handlers = fakeHandlerFactory();
  const opened = [];
  const layer = createWorldNewsLayer({
    source,
    services,
    overlayHost,
    credit,
    openArticle: (url) => opened.push(url),
    screenSpaceEventHandlerFactory: handlers.factory,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    services,
    overlayHost,
    opened,
    handler: handlers.handlers[0],
    entities: () => viewer.sources[0]?.entities.values ?? [],
    chips: () => layer.getRowControls().chips,
    chip: (id) => layer.getRowControls().chips.find((chip) => chip.id === id),
    setEvents: () =>
      overlayHost.events.filter(
        ([op, sourceId]) =>
          op === 'set' && sourceId === WORLD_NEWS_OVERLAY_SOURCE_ID,
      ),
  };
}

test('construction validates its collaborators before touching a scene', () => {
  const services = fakeServices();
  const overlayHost = fakeOverlayHost();
  const source = { getSnapshot: async () => snapshot([]) };
  assert.throws(
    () => createWorldNewsLayer({ services, overlayHost }),
    /snapshot source/,
  );
  assert.throws(
    () => createWorldNewsLayer({ source, services }),
    /overlay host/,
  );
  assert.throws(
    () =>
      createWorldNewsLayer({
        source,
        overlayHost,
        services: { render: services.render },
      }),
    /context, picking and render/,
  );
  const layer = createWorldNewsLayer({ source, services, overlayHost });
  assert.equal(layer.id, 'world-news');
  assert.equal(layer.requiresKeyId, 'world-news');
  assert.equal(layer.updateInterval, 600_000);
  const viewer = fakeViewer();
  layer.init(viewer);
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.destroy(viewer);
});

test('lifecycle: pins, contexts, ambient labels and readout hooks follow enable/update/disable/destroy', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  assert.equal(
    h.services.owners.has('world-news'),
    true,
    'pick owner registered on enable',
  );
  assert.equal(await h.layer.update(h.viewer), true);

  const stats = h.layer.getStats();
  assert.equal(stats.count, 2, 'one pin per place');
  assert.equal(stats.countLabel, '3 pinned');
  assert.equal(
    stats.lastUpdate,
    1_757_916_000_000,
    'data age, not response age',
  );
  assert.equal(stats.keyRequired, false);
  assert.equal(stats.error, null);
  assert.equal(stats.status, undefined);
  assert.match(
    stats.loadingLabel,
    /^3 of 20 latest headlines place-tagged · updated /,
  );
  assert.equal(layerFeedState(stats), 'nominal');

  assert.equal(h.services.owners.get('world-news')(ROTTERDAM), true);
  assert.equal(
    h.services.owners.get('world-news')('wn-a'),
    false,
    'stories are not pick targets, places are',
  );

  const entities = h.entities();
  assert.deepEqual(
    entities.map((entity) => entity.id).sort(),
    [TOKYO, ROTTERDAM].sort(),
  );
  const rotterdam = entities.find((entity) => entity.id === ROTTERDAM);
  assert.equal(rotterdam.gevTrackedId, ROTTERDAM);
  assert.equal(
    typeof rotterdam.gevDisplayPosition,
    'function',
    'the readout card requires a function',
  );
  const anchor = rotterdam.gevDisplayPosition();
  assert.ok(anchor instanceof Cesium.Cartesian3 && Number.isFinite(anchor.x));
  assert.equal(
    rotterdam.point.pixelSize.getValue(),
    11,
    '8 + 2*sqrt(2) rounded',
  );
  assert.equal(
    rotterdam.gevLabelModel.title,
    ROW_A.title,
    'newest story first',
  );
  assert.deepEqual(rotterdam.gevLabelModel.details.slice(1), [
    'Rotterdam · 1/2 stories here',
    'TONE NEGATIVE (-0.50)',
    // A story with a link says so: the card itself opens the publisher.
    'Click to open · World News API',
  ]);
  assert.equal(rotterdam.gevLabelModel.interactive, true);
  assert.equal(rotterdam.gevLabelModel.url, ROW_A.url);
  assert.equal(rotterdam.gevLabelModel.accent, '#ff5c8a');

  const context = h.services.store.entities.get(ROTTERDAM);
  assert.equal(context.layerId, 'world-news');
  assert.equal(context.layerName, 'World News');
  assert.equal(context.label, 'Headline place');
  assert.deepEqual(context.properties, {
    place: 'Rotterdam',
    count: 2,
    newestPublishedAt: ROW_A.publishedAt,
    headline: ROW_A.title,
    domain: 'a.example',
    url: 'https://a.example/1',
  });
  const forbidden =
    /author|person|organi[sz]ation|\bper\b|\borg\b|entities|summary|text|image/i;
  for (const key of [
    ...Object.keys(context),
    ...Object.keys(context.properties),
  ])
    assert.doesNotMatch(key, forbidden, `context leaks ${key}`);

  const sets = h.setEvents();
  assert.equal(sets.length, 1);
  const [, , entries, options] = sets[0];
  assert.deepEqual(options, {
    cohortLimit: 48,
    collisionCapacity: 24,
    moving: false,
  });
  assert.deepEqual(
    entries.map((entry) => entry.title),
    ['Rotterdam · 2', 'Tokyo'],
    'busier places outrank fresher single stories',
  );
  assert.equal(
    entries[0].position,
    rotterdam.gevNewsPosition,
    'label and pin share one anchor',
  );

  h.layer.disable(h.viewer);
  assert.equal(
    h.services.owners.has('world-news'),
    false,
    'pick owner released on disable',
  );
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getStats().countLabel, '');
  assert.equal(h.entities().length, 0);
  assert.equal(h.services.store.entities.size, 0, 'contexts pruned');
  assert.ok(
    h.overlayHost.events.some(
      ([op, id]) => op === 'clear' && id === WORLD_NEWS_OVERLAY_SOURCE_ID,
    ),
  );
  assert.deepEqual(h.overlayHost.events.at(-1), [
    'visible',
    WORLD_NEWS_OVERLAY_SOURCE_ID,
    false,
  ]);

  h.layer.destroy(h.viewer);
  assert.equal(h.viewer.sources.length, 0, 'data source removed');
  assert.equal(h.handler.destroyed, true);
});

test('a keyless proxy keeps the toggle on and reports KEY REQUIRED', async () => {
  let keyed = false;
  const h = harness({
    getSnapshot: async () =>
      keyed ? snapshot([ROW_C]) : { keyRequired: true },
  });
  assert.equal(
    await h.layer.update(h.viewer),
    true,
    'false would revert the enable',
  );
  const stats = h.layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.error, 'KEY REQUIRED');
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.loadingLabel, 'KEY REQUIRED');
  assert.equal(stats.count, 0);
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(h.chip('load-more').disabled, true);
  assert.match(h.chip('load-more').title, /key/i);

  keyed = true;
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().keyRequired, false);
  assert.equal(h.layer.getStats().count, 1);
  h.layer.destroy(h.viewer);
});

test('an upstream fault degrades the row but keeps the previous headlines', async () => {
  let fail = null;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw fail;
      return snapshot([ROW_A, ROW_B]);
    },
  });
  assert.equal(await h.layer.update(h.viewer), true);
  fail = Object.assign(new Error('World News HTTP 502'), { code: 'upstream' });
  assert.equal(
    await h.layer.update(h.viewer),
    true,
    'a refresh failure is not a rejection',
  );
  let stats = h.layer.getStats();
  assert.equal(stats.error, 'World News HTTP 502');
  assert.equal(stats.count, 1, 'last good pins stay');
  assert.equal(stats.loadingLabel, 'World News HTTP 502');
  assert.equal(layerFeedState(stats), 'degraded');

  fail = Object.assign(new Error('World News quota exhausted'), {
    code: 'quota',
  });
  assert.equal(await h.layer.update(h.viewer), true);
  stats = h.layer.getStats();
  assert.equal(stats.blocked, 'quota');
  assert.equal(stats.loadingLabel, 'QUOTA EXHAUSTED · resets 00:00 UTC');
  assert.equal(
    stats.error,
    'QUOTA EXHAUSTED · resets 00:00 UTC',
    'with data the row names the block and when it lifts',
  );
  assert.equal(layerFeedState(stats), 'degraded');
  assert.equal(h.chip('load-more').disabled, true);

  const empty = harness({
    getSnapshot: async () => {
      throw Object.assign(new Error('daily news budget exhausted'), {
        code: 'budget',
      });
    },
  });
  assert.equal(await empty.layer.update(empty.viewer), true);
  stats = empty.layer.getStats();
  assert.equal(stats.error, 'BUDGET REACHED · resumes 00:00 UTC');
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.stale, true);
  assert.equal(layerFeedState(stats), 'unavailable');
  h.layer.destroy(h.viewer);
  empty.layer.destroy(empty.viewer);
});

test('stale, budget-limited and empty batches read honestly on the chip', async () => {
  let reply = snapshot([ROW_A], { stale: true });
  const h = harness({ getSnapshot: async () => reply });
  await h.layer.update(h.viewer);
  let stats = h.layer.getStats();
  assert.equal(stats.stale, true);
  assert.match(stats.loadingLabel, /^STALE · cached /);
  assert.equal(layerFeedState(stats), 'stale');

  reply = snapshot([ROW_A], { blocked: 'budget', morePagesLeft: 0 });
  await h.layer.update(h.viewer);
  stats = h.layer.getStats();
  assert.equal(
    stats.stale,
    true,
    'a budget-frozen cache ages like a stale one',
  );
  assert.match(
    stats.loadingLabel,
    /^BUDGET REACHED · resumes 00:00 UTC · cached /,
  );
  assert.equal(
    stats.error,
    stats.loadingLabel,
    'the row names the block and the age of the pins it still shows',
  );
  assert.equal(
    layerFeedState(stats),
    'stale',
    'with data on the map the row is stale, not broken',
  );
  assert.equal(h.chip('load-more').disabled, true);

  reply = snapshot([]);
  await h.layer.update(h.viewer);
  stats = h.layer.getStats();
  assert.equal(stats.status, 'empty');
  assert.equal(
    stats.statusMessage,
    'No place-tagged headlines in the latest batch',
  );
  assert.equal(stats.error, null);
  assert.equal(layerFeedState(stats), 'nominal', 'guidance, not a fault');
  h.layer.destroy(h.viewer);
});

test('a superseded request yields to the newer one', async () => {
  const pending = [];
  const h = harness({
    getSnapshot: () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  });
  const first = h.layer.update(h.viewer);
  const second = h.layer.update(h.viewer);
  pending[0](snapshot([ROW_A]));
  pending[1](snapshot([ROW_C]));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(
    h.entities().map((entity) => entity.id),
    [TOKYO],
  );
  h.layer.destroy(h.viewer);
});

test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve(snapshot([ROW_A]));
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.setEvents().length, 0);
    assert.equal(h.services.store.entities.size, 0);
    h.layer.destroy(h.viewer);
  }
});

test('the manager abort signal cancels an in-flight refresh', async () => {
  let signal;
  const h = harness({
    getSnapshot(options) {
      signal = options.signal;
      // Like fetch: settle only by rejecting once the request is aborted.
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  });
  const external = new AbortController();
  const pending = h.layer.update(h.viewer, { signal: external.signal });
  external.abort();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, false);
  h.layer.destroy(h.viewer);
});

test('selection: chips, story paging, readout refresh and the injected opener', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.chip('open-article').disabled, true);
  assert.equal(
    h.chip('next-story'),
    undefined,
    'no paging chips without a selection',
  );
  assert.equal(h.chip('load-more').disabled, false);
  assert.match(
    h.chip('load-more').title,
    /1 request ≈ 2 points of today's budget \(4\/50 used\)/,
  );

  assert.equal(h.layer.selectPlace('missing'), false);
  assert.equal(h.layer.selectPlace(ROTTERDAM), true);
  assert.deepEqual(
    h.chips().map((chip) => chip.id),
    ['open-article', 'load-more', 'prev-story', 'next-story'],
    'always-present chips precede the paging chips the panel appends',
  );
  assert.equal(h.services.store.selectedId, ROTTERDAM);
  const rotterdam = h.entities().find((entity) => entity.id === ROTTERDAM);
  assert.equal(
    rotterdam.point.color.getValue().equals(Cesium.Color.WHITE),
    true,
  );
  assert.equal(rotterdam.point.pixelSize.getValue(), 15, 'max(12, 11 + 4)');
  assert.equal(h.chip('open-article').disabled, false);
  assert.ok(h.chip('prev-story') && h.chip('next-story'), 'two stories here');
  h.chip('open-article').onClick();
  assert.deepEqual(h.opened, ['https://a.example/1']);

  h.chip('next-story').onClick();
  assert.equal(rotterdam.gevLabelModel.title, ROW_B.title);
  assert.equal(
    rotterdam.gevLabelModel.details[1],
    'Rotterdam · 2/2 stories here',
  );
  assert.equal(rotterdam.gevLabelModel.details[2], 'TONE POSITIVE (0.60)');
  assert.equal(rotterdam.gevLabelModel.accent, '#4fd1a5');
  assert.ok(
    h.services.calls.some(
      ([op, id]) => op === 'refreshReadout' && id === ROTTERDAM,
    ),
  );
  h.chip('open-article').onClick();
  assert.equal(
    h.opened.at(-1),
    'https://b.example/2',
    'opens the story being read',
  );
  h.chip('next-story').onClick();
  assert.equal(rotterdam.gevLabelModel.title, ROW_A.title, 'wraps around');
  h.chip('prev-story').onClick();
  assert.equal(rotterdam.gevLabelModel.title, ROW_B.title);

  assert.equal(h.layer.selectPlace(TOKYO), true);
  assert.equal(
    h.chip('next-story'),
    undefined,
    'a single story has nothing to page',
  );
  assert.equal(
    rotterdam.point.color.getValue().equals(Cesium.Color.WHITE),
    false,
    'previous pin restored',
  );
  const tokyo = h.entities().find((entity) => entity.id === TOKYO);
  assert.equal(tokyo.gevLabelModel.details[2], 'TONE UNKNOWN');

  h.layer.clearSelection();
  assert.equal(h.services.store.selectedId, null);
  assert.deepEqual(h.services.calls.filter(([op]) => op === 'clear').at(-1), [
    'clear',
    'world-news',
    false,
  ]);
  assert.equal(h.chip('open-article').disabled, true);
  h.layer.destroy(h.viewer);
});

test('clicks select our pins, yield to sibling-owned picks, and clear on empty space', async () => {
  const h = harness({ getSnapshot: async () => snapshot([ROW_A, ROW_C]) });
  await h.layer.update(h.viewer);
  h.services.owners.set('flights', (id) => id === 'plane-1');
  let picked = null;
  h.viewer.scene.pick = () => picked;

  picked = { id: h.entities().find((entity) => entity.id === ROTTERDAM) };
  h.handler.click();
  assert.equal(h.services.store.selectedId, ROTTERDAM);

  picked = { id: 'plane-1' };
  h.handler.click();
  assert.equal(
    h.services.store.selectedId,
    ROTTERDAM,
    'a sibling pick is not empty space',
  );

  picked = null;
  h.handler.click();
  assert.equal(h.services.store.selectedId, null);

  h.layer.disable(h.viewer);
  picked = { id: ROTTERDAM };
  h.handler.click();
  assert.equal(
    h.services.store.selectedId,
    null,
    'a disabled layer ignores clicks',
  );
  h.layer.destroy(h.viewer);
});

test('a refresh that drops the selected place evicts rather than deselects', async () => {
  let rows = [ROW_A, ROW_C];
  const h = harness({ getSnapshot: async () => snapshot(rows) });
  await h.layer.update(h.viewer);
  h.layer.selectPlace(ROTTERDAM);
  rows = [ROW_C];
  await h.layer.update(h.viewer);
  assert.deepEqual(h.services.calls.filter(([op]) => op === 'clear').at(-1), [
    'clear',
    'world-news',
    true,
  ]);
  assert.equal(h.chip('open-article').disabled, true);
  assert.deepEqual(
    h.entities().map((entity) => entity.id),
    [TOKYO],
  );

  // A retained selection survives the refresh and republishes its card.
  h.layer.selectPlace(TOKYO);
  const before = h.services.calls.filter(
    ([op]) => op === 'refreshReadout',
  ).length;
  await h.layer.update(h.viewer);
  assert.equal(h.services.store.selectedId, TOKYO);
  assert.ok(
    h.services.calls.filter(([op]) => op === 'refreshReadout').length > before,
  );
  h.layer.destroy(h.viewer);
});

test('LOAD MORE merges the extra page and explains its own failures without degrading the feed', async () => {
  let moreReply = () => snapshot([ROW_A, ROW_B, ROW_C], { morePagesLeft: 1 });
  const calls = [];
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A]),
    loadMore: async ({ signal }) => {
      calls.push(signal);
      return moreReply();
    },
  });
  assert.equal(await h.layer.loadMore(), false, 'nothing loaded yet');
  await h.layer.update(h.viewer);
  assert.equal(await h.layer.loadMore(), true);
  assert.equal(calls.length, 1);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().countLabel, '3 pinned');
  assert.match(h.chip('load-more').title, /1 left this hour/);

  moreReply = () => {
    throw Object.assign(new Error('extra pages exhausted'), { code: 'pages' });
  };
  assert.equal(await h.layer.loadMore(), true);
  assert.equal(h.layer.getStats().error, null, 'the base feed is intact');
  assert.equal(h.chip('load-more').disabled, true);
  assert.match(h.chip('load-more').title, /extra pages exhausted/);
  assert.equal(await h.layer.loadMore(), false, 'no pages left');
  h.layer.destroy(h.viewer);
});

test('the provider credit registers once, on the first non-empty batch', async () => {
  let rows = [];
  const h = harness({ getSnapshot: async () => snapshot(rows) });
  await h.layer.update(h.viewer);
  const credits = () => h.services.calls.filter(([op]) => op === 'credit');
  assert.equal(credits().length, 0, 'an empty batch shows nothing to credit');
  rows = [ROW_A];
  await h.layer.update(h.viewer);
  await h.layer.update(h.viewer);
  assert.deepEqual(credits(), [['credit', 'test-credit']]);
  h.layer.destroy(h.viewer);
});

test('legend tallies every story by tone and the analyst seam mirrors the rows', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([ROW_A, ROW_B, ROW_C]),
  });
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  await h.layer.update(h.viewer);
  const { legend } = h.layer.getRowControls();
  assert.deepEqual(
    legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Negative tone', '#ff5c8a', 1],
      ['Neutral tone', '#8b8cf8', 0],
      ['Positive tone', '#4fd1a5', 1],
      ['No tone score', '#b8c4d0', 1],
    ],
  );
  assert.ok(legend.every((item) => /named in the headline/.test(item.blurb)));
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    id: 'wn-a',
    title: ROW_A.title,
    domain: 'a.example',
    url: 'https://a.example/1',
    publishedAt: ROW_A.publishedAt,
    sentiment: -0.5,
    category: 'business',
    place: 'Rotterdam',
    sourceCountry: 'nl',
    lat: 51.92,
    lon: 4.48,
  });
  assert.equal(records[2].sentiment, null);
  assert.equal(h.layer.getAnalystRecords(2).length, 2);
  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
  h.layer.destroy(h.viewer);
});

test('row-control listeners hear every async state change and survive throwing', async () => {
  let resolve;
  const h = harness({
    getSnapshot: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  let notified = 0;
  h.layer.setRowControlsListener(() => {
    notified++;
    throw new Error('listener bug');
  });
  const pending = h.layer.update(h.viewer);
  assert.ok(notified >= 1, 'loading disables the chip immediately');
  assert.equal(h.chip('load-more').disabled, true);
  resolve(snapshot([ROW_A]));
  await pending;
  assert.ok(notified >= 2, 'completion re-enables it');
  assert.equal(h.chip('load-more').disabled, false);
  h.layer.setRowControlsListener(null);
  h.layer.destroy(h.viewer);
});

test('an unmeasured request cost is labelled as the documented estimate', async () => {
  let reply = snapshot([ROW_A], { costPerRequest: 1.03, costMeasured: false });
  const h = harness({ getSnapshot: async () => reply });
  await h.layer.update(h.viewer);
  assert.match(
    h.chip('load-more').title,
    /1 request ≈ 1\.03 points \(estimate\) of today's budget/,
  );
  reply = snapshot([ROW_A], { costPerRequest: null, costMeasured: false });
  await h.layer.update(h.viewer);
  assert.match(h.chip('load-more').title, /≈ 2 points \(estimate\) of/);
  reply = snapshot([ROW_A]);
  await h.layer.update(h.viewer);
  assert.match(h.chip('load-more').title, /≈ 2 points of today's budget/);
  h.layer.destroy(h.viewer);
});
