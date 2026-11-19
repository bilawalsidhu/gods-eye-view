import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { createGhostMapsLayer, GHOSTMAPS_OVERLAY_SOURCE_ID } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { inputFor } from '../../input/dispatcher.js';
import { MISSION_LABEL } from '../../input/testDoubles.mjs';
import { clickCard, setClickCardHitTest } from '../../data/pickRegistry.js';
import { GHOSTMAPS_PRODUCTS, GHOSTMAPS_LATEST_DROP } from './catalog.js';

function element(localName, children = [], value = '', attributes = {}) {
  const node = {
    localName,
    children,
    get textContent() {
      return value + children.map((child) => child.textContent).join('');
    },
    getAttribute: (key) => attributes[key] ?? null,
    getElementsByTagName(name) {
      return children.flatMap((child) => [
        ...(name === '*' || name === child.localName ? [child] : []),
        ...child.getElementsByTagName(name),
      ]);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function documentFixture(reports = [{ name: 'Test report' }]) {
  return element('document', [
    element('kml', [
      element('Document', [
        element(
          'Style',
          [
            element('IconStyle', [
              element('Icon', [element('href', [], 'icon.png')]),
            ]),
          ],
          '',
          { id: 'pin' },
        ),
        ...reports.map(({ name, description = '', geometry }) =>
          element('Placemark', [
            element('name', [], name),
            element('description', [], description),
            element('styleUrl', [], '#pin'),
            geometry || element('Point', [element('coordinates', [], '12,34')]),
          ]),
        ),
      ]),
    ]),
  ]);
}

// A stored KMZ with a local icon; the XML DOM double supplies its one point.
function fixtureKmz() {
  const files = [
    ['doc.kml', '<kml/>'],
    ['icon.png', 'packed icon'],
  ];
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of files) {
    const key = Buffer.from(name);
    const bytes = Buffer.from(value);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(key.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(key.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, key, bytes);
    central.push(directory, key);
    offset += header.length + key.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}

function fixture(
  t,
  {
    beforeFileReturns,
    onCreateUrl,
    reports,
    now,
    products,
    controls = {},
  } = {},
) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  globalThis.DOMParser = class {
    parseFromString() {
      return documentFixture(reports);
    }
  };
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'DOMParser', previous);
    else delete globalThis.DOMParser;
  });
  const created = [];
  const revoked = [];
  t.mock.method(URL, 'createObjectURL', () => {
    const url = `blob:local-${created.length}`;
    created.push(url);
    onCreateUrl?.(layer);
    return url;
  });
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url));
  t.mock.method(console, 'warn', () => {});
  const viewer = {};
  // An input port and a query port: a click picks what `click(id)` names.
  const listeners = new Set();
  let picked = null;
  const { draw, unbind } = bindFakeDraw(viewer, {
    input: {
      on(type, cb) {
        if (type !== 'click') return () => {};
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
    query: { pick: () => picked },
  });
  t.after(unbind);
  // Every live item, by id, with the id of the set drawing it.
  const items = () =>
    new Map(
      [...draw.sets.values()]
        .filter((set) => !set.disposed)
        .flatMap((set) => [...set.items.keys()].map((id) => [id, set.spec.id])),
    );
  const liveSets = () => [...draw.sets.values()].filter((set) => !set.disposed);
  const click = (id) => {
    const set = items().get(id);
    picked = set ? { set, id } : null;
    for (const cb of [...listeners])
      cb({
        position: { x: 0, y: 0 },
        button: 0,
        modifiers: { shift: false, ctrl: false, alt: false },
      });
  };
  // The editions drawn: each draws in sets of its own.
  const mounted = {
    get size() {
      return new Set(
        [...draw.sets.values()]
          .filter((set) => !set.disposed)
          .map((set) => set.spec.id.split(':').slice(0, 3).join(':')),
      ).size;
    },
  };
  const layer = createGhostMapsLayer({
    storage: null,
    now,
    ...controls,
    source: {
      getCatalog: async () => ({
        products: products ?? [
          { id: 'cip', version: 'a'.repeat(40), defaultOn: true },
        ],
      }),
      getFile: async () => {
        beforeFileReturns?.(layer);
        return fixtureKmz();
      },
    },
  });
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return {
    layer,
    viewer,
    draw,
    unbind,
    mounted,
    created,
    revoked,
    items,
    liveSets,
    click,
  };
}

test('cancelling a file read does not allocate packed-image URLs', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t, {
    beforeFileReturns: (layer) => queueMicrotask(() => layer.disable()),
  });
  await layer.update(viewer);
  assert.equal(created.length, 0);
  assert.equal(revoked.length, 0);
  assert.equal(mounted.size, 0);
});

test('cancellation during parsing releases every packed-image URL', async (t) => {
  const { layer, viewer, mounted, created, revoked } = fixture(t, {
    onCreateUrl: (layer) => layer.disable(),
  });
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
});

test('a draw failure releases parsed image URLs', async (t) => {
  const { layer, viewer, draw, mounted, created, revoked } = fixture(t);
  t.mock.method(draw, 'icons', () => {
    throw new Error('fixture entity failure');
  });
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
  assert.equal(layer.getStats().error, 'fixture entity failure');
});

test('a viewer with no renderer bound releases parsed image URLs', async (t) => {
  const { layer, viewer, unbind, mounted, created, revoked } = fixture(t);
  unbind();
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
  assert.ok(layer.getStats().error);
});

test('successful load keeps icons until the product is disabled', async (t) => {
  const { layer, viewer, draw, mounted, created, revoked } = fixture(t);
  await layer.update(viewer);
  assert.equal(created.length, 1);
  assert.equal(revoked.length, 0);
  assert.equal(mounted.size, 1);
  assert.equal(layer.getStats().count, 1);
  const pins = [...draw.sets.values()].find(
    (set) => !set.disposed && set.kind === 'icons',
  );
  const [pin] = pins.items.values();
  assert.equal(pin.id, 'ghostmaps:cip:0:0');
  assert.equal(pin.image, 'blob:local-0');
  assert.equal(pin.height, 'clampGround');
  assert.equal(pins.spec.clampTo, 'both');
  assert.equal(pin.disableDepthTest, Infinity);
  assert.equal(pin.scale, 0.7);
  assert.deepEqual(pin.size, [20, 20], 'unread in Node: the marker size');
  layer.disable();
  assert.deepEqual(revoked, created);
  assert.equal(mounted.size, 0);
});

const dated = (name, value, label = 'Date') => ({
  name,
  description: `<table><tr><td>${label}</td><td>${value}</td></tr></table>`,
});

const ageChip = (layer, days) =>
  layer
    .getRowControls()
    .segmented.options.find(({ id }) => id === `age-${days ?? 'all'}`);

test('age controls default to seven days and widening restores filtered and expired reports', async (t) => {
  let at = Date.UTC(2026, 10, 3, 12);
  const { layer, viewer, mounted } = fixture(t, {
    now: () => at,
    reports: [
      dated('Old', '10/1/2026'),
      dated('Ten days', '10/24/2026'),
      dated('Recent', '11/2/2026'),
      { name: 'Undated' },
    ],
  });
  await layer.update(viewer);
  assert.equal(layer.getStats().ageDays, 7);
  assert.equal(ageChip(layer, 7).active, true);
  assert.equal(layer.getStats().count, 2);
  await ageChip(layer, 14).onClick();
  assert.equal(layer.getStats().count, 3);
  await ageChip(layer, null).onClick();
  assert.equal(layer.getStats().count, 4);
  at += 100 * 86400_000;
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 4, 'all markers never ages out');
  await ageChip(layer, 1).onClick();
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getAnalystRecords()[0].name, 'Undated');
  await ageChip(layer, null).onClick();
  assert.equal(layer.getStats().count, 4);
  assert.equal(mounted.size, 1, 'filter changes never duplicate data sources');
  const controls = layer.getRowControls();
  assert.equal(
    controls.segmented.options.filter(({ active }) => active).length,
    1,
  );
  assert.equal(
    controls.chips.some(({ id }) => id.startsWith('age-')),
    false,
    'age options are one switch, not product chips',
  );
  assert.equal(ageChip(layer, null).active, true);
});

test('the event age agrees with its number of days', async (t) => {
  t.after(() => setLocale('en'));
  const { layer, viewer } = fixture(t, { reports: [{ name: 'Undated' }] });
  await layer.update(viewer);
  const info = () =>
    layer.getRowControls().info.split(' · ').slice(0, 2).join(' · ');
  assert.equal(
    ageChip(layer, 1).title,
    'Maximum event age: 1d; undated markers are kept',
  );
  setLocale('de');
  assert.equal(
    ageChip(layer, 1).title,
    'Maximales Ereignisalter: 1 Tag; undatierte Markierungen bleiben erhalten',
  );
  assert.equal(
    ageChip(layer, 7).title,
    'Maximales Ereignisalter: 7 Tage; undatierte Markierungen bleiben erhalten',
  );
  assert.equal(info(), 'Ereignisalter: 7 Tage · undatierte bleiben');
  await ageChip(layer, 1).onClick();
  assert.equal(info(), 'Ereignisalter: 1 Tag · undatierte bleiben');
  setLocale('es');
  assert.equal(
    info(),
    'Antigüedad: 1 día · se conservan los marcadores sin fecha',
  );
});

test('age preferences persist independently of product choices and reject invalid storage', async (t) => {
  const values = new Map([['gev.ghostmaps.products', '["cip"]']]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  await t.test('save All markers without changing products', async (t) => {
    const { layer, viewer } = fixture(t, { controls: { storage } });
    await layer.update(viewer);
    await ageChip(layer, null).onClick();
    assert.equal(values.get('gev.ghostmaps.ageDays'), 'null');
    assert.equal(values.get('gev.ghostmaps.products'), '["cip"]');
  });
  await t.test('restore All markers and save thirty days', async (t) => {
    const { layer } = fixture(t, { controls: { storage } });
    assert.equal(layer.getStats().ageDays, null);
    await ageChip(layer, 30).onClick();
    assert.equal(values.get('gev.ghostmaps.ageDays'), '30');
  });
  await t.test('restore thirty days', (t) => {
    const { layer } = fixture(t, { controls: { storage } });
    assert.equal(layer.getStats().ageDays, 30);
  });
  for (const value of ['garbage', '"7"', '-1', '0', '2', '{}']) {
    await t.test(`reject ${value}`, (t) => {
      values.set('gev.ghostmaps.ageDays', value);
      const { layer } = fixture(t, { controls: { storage } });
      assert.equal(layer.getStats().ageDays, 7);
    });
  }
});

test('blocked storage still permits changing the age within the session', async (t) => {
  const storage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const { layer, viewer } = fixture(t, { controls: { storage } });
  await layer.update(viewer);
  assert.equal(layer.getStats().ageDays, 7);
  await ageChip(layer, null).onClick();
  assert.equal(layer.getStats().ageDays, null);
});

test('a filter changed during a pending load never installs the superseded filter', async (t) => {
  let changed = false;
  const { layer, viewer, mounted, revoked, created } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3),
    reports: [dated('Old', '10/1/2026')],
    beforeFileReturns: (layer) => {
      if (changed) return;
      changed = true;
      ageChip(layer, null).onClick();
    },
  });
  await layer.update(viewer);
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().ageDays, null);
  assert.equal(mounted.size, 1);
  assert.equal(
    revoked.length,
    created.length - 1,
    'discarded load releases icons',
  );
});

test('age filtering and All markers apply to every conflict-map product, including optional maps', async (t) => {
  for (const product of [...GHOSTMAPS_PRODUCTS, GHOSTMAPS_LATEST_DROP]) {
    await t.test(product.id, async (t) => {
      const { layer, viewer, mounted } = fixture(t, {
        now: () => Date.UTC(2026, 10, 3, 12),
        products: [{ ...product, version: 'a'.repeat(40) }],
        reports: [
          dated(
            'Old event',
            '10/1/2026',
            product.id === 'cip' ? 'Date of Event' : 'Date',
          ),
          dated('Recent event', '11/2/2026'),
          { name: 'Undated reference feature' },
        ],
      });
      await layer.update(viewer);
      if (!product.defaultOn) {
        layer
          .getRowControls()
          .chips.find(({ id }) => id === product.id)
          .onClick();
        await layer.update(viewer);
      }
      assert.deepEqual(layer.getStats().products, [product.id]);
      assert.equal(layer.getStats().count, 2);
      assert.deepEqual(
        layer.getAnalystRecords().map(({ name }) => name),
        ['Recent event', 'Undated reference feature'],
      );
      await ageChip(layer, null).onClick();
      assert.equal(
        layer.getStats().count,
        3,
        "All markers restores this product's old events",
      );
      await ageChip(layer, 7).onClick();
      assert.equal(layer.getStats().count, 2);
      assert.equal(mounted.size, 1);
    });
  }
});

test('default products filter old event dates while keeping recent, future and undated markers', async (t) => {
  const { layer, viewer, items } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3, 12),
    reports: [
      dated('Old event', '10/20/2026'),
      dated('Recent event', '11/2/2026'),
      dated('At cutoff', '10/27/2026 12:00:00 PM'),
      dated('Before cutoff', '10/27/2026 11:59:59 AM'),
      dated('Future event', '11/4/2026'),
      { name: 'Undated site' },
      dated('Blank date', '&lt;Null&gt;'),
      dated('Invalid date', '2/30/2026'),
      dated('Only a report date', '10/1/2026', 'Date Of Report'),
      {
        name: 'Old event reported recently',
        description:
          '<table><tr><td>Date of Event</td><td>10/1/2026</td></tr><tr><td>Date Of Report</td><td>11/2/2026</td></tr></table>',
      },
    ],
  });
  await layer.update(viewer);
  assert.deepEqual(layer.getStats().products, ['cip']);
  assert.deepEqual(
    layer.getAnalystRecords().map((r) => r.name),
    [
      'Recent event',
      'At cutoff',
      'Future event',
      'Undated site',
      'Blank date',
      'Invalid date',
      'Only a report date',
    ],
  );
  assert.equal(layer.getStats().count, 7);
  assert.equal(items().size, 7);
  // Filtering cannot shift pick ids onto a different report.
  assert.ok(items().has('ghostmaps:cip:1:0'));
  assert.equal(items().has('ghostmaps:cip:0:0'), false);
});

test('unchanged cached products age out on the timer, clear selected cards and keep surviving picks', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let at = Date.UTC(2026, 10, 3, 12);
  const cards = [];
  const { layer, viewer, mounted, items, liveSets, click } = fixture(t, {
    now: () => at,
    reports: [
      dated('Expiring', '10/27/2026 12:00:00 PM'),
      dated('Surviving', '11/2/2026'),
    ],
    controls: {
      overlayHost: { setEntries: (_id, entries) => cards.push(entries) },
      picking: { resolvePickId: (picked) => picked },
    },
  });
  await layer.update(viewer);
  const sets = liveSets();
  click('ghostmaps:cip:0:0');
  assert.equal(cards.at(-1).length, 1);
  at += 60_000;
  t.mock.timers.tick(60_000);
  assert.equal(layer.getStats().count, 1);
  assert.equal(items().size, 1);
  assert.equal(items().has('ghostmaps:cip:0:0'), false);
  assert.ok(items().has('ghostmaps:cip:1:0'));
  assert.deepEqual(cards.at(-1), []);
  await layer.update(viewer);
  assert.deepEqual(liveSets(), sets, 'same-version KMZ is not reloaded');
  click('ghostmaps:cip:1:0');
  assert.match(cards.at(-1)[0].title, /Surviving/);
  layer.disable();
  at += 14 * 86400_000;
  t.mock.timers.tick(60_000);
  assert.equal(mounted.size, 0);
  layer.enable();
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 0);
});

test('expiry removes every geometry and polygon outline belonging to an old report', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // 10/27 is a whole UTC day: at 7d it expires when 11/3 ends.
  let at = Date.UTC(2026, 10, 4) - 30_000;
  const polygon = element('Polygon', [
    element('outerBoundaryIs', [
      element('LinearRing', [
        element('coordinates', [], '12,34 13,34 13,35 12,34'),
      ]),
    ]),
  ]);
  const { layer, viewer, items } = fixture(t, {
    now: () => at,
    reports: [
      {
        ...dated('Multi-part', '10/27/2026'),
        geometry: element('MultiGeometry', [
          element('Point', [element('coordinates', [], '12,34')]),
          element('LineString', [element('coordinates', [], '12,34 13,35')]),
          polygon,
        ]),
      },
    ],
  });
  await layer.update(viewer);
  assert.equal(items().size, 4);
  at += 60_000;
  t.mock.timers.tick(60_000);
  assert.equal(items().size, 0);
  assert.equal(layer.getStats().count, 0);
});

test('narrowing then returning to the previous window restores its reports without a duplicate source', async (t) => {
  const { layer, viewer, mounted } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3, 12),
    reports: [dated('Today', '11/3/2026'), dated('Three days', '10/31/2026')],
  });
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 2);
  await ageChip(layer, 1).onClick();
  assert.equal(layer.getStats().count, 1);
  await ageChip(layer, 7).onClick();
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 2, '7d must show both reports again');
  assert.equal(mounted.size, 1);
});

test('two quick clicks, 1d then 7d, restore the report', async (t) => {
  const at = Date.UTC(2026, 10, 3, 12);
  const { layer, viewer } = fixture(t, {
    now: () => at,
    reports: [dated('Today', '11/3/2026'), dated('Three days', '10/31/2026')],
  });
  await layer.update(viewer);
  const a = ageChip(layer, 1).onClick();
  const b = ageChip(layer, 7).onClick();
  await a;
  await b;
  await layer.update(viewer);
  assert.equal(layer.getStats().count, 2);
});

test('narrowing the window keeps the open card of a surviving marker', async (t) => {
  const cards = [];
  const { layer, viewer, click } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3, 12),
    reports: [dated('Recent', '11/2/2026'), dated('Older', '10/20/2026')],
    controls: {
      overlayHost: { setEntries: (_id, entries) => cards.push(entries) },
      picking: { resolvePickId: (picked) => picked },
    },
  });
  await layer.update(viewer);
  await ageChip(layer, 30).onClick();
  assert.equal(layer.getStats().count, 2);
  click('ghostmaps:cip:0:0');
  assert.equal(cards.at(-1).length, 1);
  await ageChip(layer, 3).onClick();
  assert.equal(layer.getStats().count, 1);
  assert.equal(
    cards.at(-1).length,
    1,
    'card of the surviving marker stays open',
  );
});

test('a report dated yesterday is shown by 1d one hour into today (UTC)', async (t) => {
  const { layer, viewer } = fixture(t, {
    now: () => Date.UTC(2026, 10, 6, 1),
    reports: [dated('Yesterday', '11/5/2026')],
  });
  await layer.update(viewer);
  await ageChip(layer, 1).onClick();
  assert.equal(layer.getStats().count, 1);
});

test('a widened reload that returns a different report at the selected index closes its card', async (t) => {
  const cards = [];
  const reports = [dated('Recent', '11/2/2026'), dated('Older', '10/20/2026')];
  const { layer, viewer, click } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3, 12),
    reports,
    controls: {
      overlayHost: { setEntries: (_id, entries) => cards.push(entries) },
      picking: { resolvePickId: (picked) => picked },
    },
  });
  await layer.update(viewer);
  click('ghostmaps:cip:0:0');
  assert.equal(cards.at(-1).length, 1);
  // The server answers the pinned version with a newer edition's bytes.
  reports[0] = dated('Replacement', '11/2/2026');
  await ageChip(layer, 30).onClick();
  assert.equal(layer.getStats().count, 2);
  assert.equal(
    cards.at(-1).length,
    0,
    'a different report must not keep the old card',
  );
});

test('narrowing to a window the loaded data covers clears a failed wider reload', async (t) => {
  let fail = false;
  const { layer, viewer } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3, 12),
    reports: [dated('Recent', '11/2/2026'), dated('Older', '10/20/2026')],
    beforeFileReturns: () => {
      if (fail) throw new Error('network down');
    },
  });
  await layer.update(viewer);
  fail = true;
  await ageChip(layer, 30).onClick();
  assert.ok(layer.getStats().error, 'the wider reload failed');
  await ageChip(layer, 3).onClick();
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().count, 1);
});

test("a click on a mission label over the open card never opens the card's link, and keeps the card open", async (t) => {
  const cards = [];
  const opened = [];
  let cardUnder = null;
  // A Space Missions label painted over the map: while it is over, it takes
  // each click and is the card on top; under it may lie our open card.
  let labelOver = false;
  setClickCardHitTest(() =>
    labelOver
      ? MISSION_LABEL
      : cardUnder
        ? { sourceId: GHOSTMAPS_OVERLAY_SOURCE_ID, entryId: cardUnder }
        : null,
  );
  t.after(() => setClickCardHitTest(null));
  const { layer, viewer, click } = fixture(t, {
    now: () => Date.UTC(2026, 10, 3, 12),
    reports: [
      {
        name: 'Linked',
        description:
          '<table><tr><td>Date</td><td>11/2/2026</td></tr>' +
          '<tr><td>Source</td><td><a href="https://example.com/report">report</a></td></tr></table>',
      },
    ],
    controls: {
      overlayHost: { setEntries: (_id, entries) => cards.push(entries) },
      picking: { resolvePickId: (picked) => picked?.id ?? null, clickCard },
      openExternal: (url) => opened.push(url),
    },
  });
  inputFor(viewer).onOverlayClick(() => labelOver);
  await layer.update(viewer);
  click('ghostmaps:cip:0:0');
  const [card] = cards.at(-1);
  assert.equal(card.interactive, true);

  // The open card lies under the label: the click opens nothing, and the
  // label on top is its own click, so the card stays open.
  cardUnder = card.id;
  labelOver = true;
  click(null);
  assert.deepEqual(opened, [], 'the link beneath the label is not opened');
  assert.equal(cards.at(-1)[0]?.id, card.id, 'the card stays open');

  // Off the label, a click on the open card opens its link.
  labelOver = false;
  click(null);
  assert.deepEqual(opened, ['https://example.com/report']);
});

test('a covered selected card yields while genuine GhostMaps markers still select', async (t) => {
  const cards = [];
  const opened = [];
  let painted = [];
  const { layer, viewer, click } = fixture(t, {
    reports: [
      {
        name: 'First',
        description: '<a href="https://example.com/first">Source</a>',
      },
      {
        name: 'Second',
        description: '<a href="https://example.com/second">Source</a>',
      },
    ],
    controls: {
      overlayHost: {
        setEntries: (_id, entries) => cards.push(entries),
        hitTest: (_x, _y, { sourceId } = {}) =>
          painted.find((hit) => !sourceId || hit.sourceId === sourceId) ?? null,
      },
      picking: {
        resolvePickId: (picked) => picked,
        // The card on top at a click, as the registry answers from the host.
        clickCard: () => painted[0] ?? null,
      },
      openExternal: (url) => opened.push(url),
    },
  });
  await layer.update(viewer);
  click('ghostmaps:cip:0:0');
  const first = cards.at(-1)[0];
  const foreign = {
    sourceId: 'earthquake-card',
    entryId: 'earthquake-card:ak1',
  };
  painted = [foreign, { sourceId: 's2-ghostmaps', entryId: first.id }];
  click(null);
  assert.deepEqual(opened, []);
  assert.equal(cards.at(-1)[0].id, first.id);
  // A marker under another layer's card is that card's click too.
  click('ghostmaps:cip:1:0');
  assert.equal(cards.at(-1)[0].id, first.id, 'a covered marker yields');
  painted = [];
  click('ghostmaps:cip:1:0');
  const second = cards.at(-1)[0];
  assert.notEqual(second.id, first.id, 'a bare marker selects');
  painted = [{ sourceId: 's2-ghostmaps', entryId: second.id }];
  click(null);
  assert.deepEqual(opened, ['https://example.com/second']);
  painted = [];
  click(null);
  assert.deepEqual(cards.at(-1), [], 'bare map still clears the selection');
});
