import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelection } from './selection.js';

const row = {
  stableId: 'inat:123',
  origin: 'inaturalist',
  lat: 48.1,
  lon: 8.2,
  commonName: 'Synthetic bird',
  iconic: 'Aves',
  observedAt: Date.UTC(2026, 10, 4),
  link: 'https://www.inaturalist.org/observations/123',
};

function fixture(sighting = row) {
  const position = { x: 300, y: 300, z: 0 };
  const entries = new Map();
  const flights = [];
  const seen = [];
  const painted = new Set();
  let hit = null;
  let projections = 0;
  let picked = null;
  let click;
  const state = {
    enabled: true,
    destroyed: false,
    selectedId: null,
    selectedRow: null,
    rowById: new Map([[sighting.stableId, sighting]]),
    positions: new Map([[sighting.stableId, position]]),
    renderedRows: [sighting],
    carriers: new Map(),
    contextIds: new Set(),
    ambientIds: [],
    ambientRows: [],
    labelRows: [],
    viewer: {
      scene: {
        pick: () => picked,
        canvas: { clientWidth: 1200, clientHeight: 900 },
      },
      camera: { positionCartographic: { height: 30_000 } },
    },
  };
  const selection = createSelection({
    state,
    services: {
      overlayHost: {
        setEntries: (id, value) => entries.set(id, value),
        clearSource: (id) => entries.delete(id),
        setVisible() {},
        hitTest: (_x, _y, { sourceId }) =>
          hit?.sourceId === sourceId ? hit : null,
      },
      now: () => row.observedAt + 60_000,
      project: (_scene, anchor) => {
        projections++;
        return anchor;
      },
      focus: { requestWorldFocus: (request) => flights.push(request) },
      screenSpaceEventHandlerFactory: () => ({
        setInputAction: (fn) => (click = fn),
        destroy() {},
      }),
      cesium: { ScreenSpaceEventType: { LEFT_CLICK: 0 } },
      eventTarget: new EventTarget(),
    },
    parts: {
      rendering: {
        refreshSelection() {},
        requestRender() {},
        occluder: () => null,
        hasPhotoCard: (id) => painted.has(id),
      },
      photos: { get: () => ({ width: 75, height: 75 }), setAmbient() {} },
    },
  });
  selection.subscribe((value, metadata) => seen.push({ value, metadata }));
  return {
    state,
    selection,
    position,
    flights,
    entries,
    seen,
    get projections() {
      return projections;
    },
    hit(sourceId, entryId) {
      const entry = entries
        .get(sourceId)
        ?.find((entry) => entry.id === entryId);
      hit = entry ? { sourceId, entryId, entry } : null;
    },
    paint(ids) {
      painted.clear();
      for (const id of ids) painted.add(id);
      selection.photoCardsChanged();
    },
    click(id = `wildlife:${sighting.stableId}`) {
      picked = id ? { id } : null;
      click({ position: { x: 10, y: 20 } });
    },
  };
}

test('a real sighting click pins its row, opens its label and focuses its true position', () => {
  const f = fixture();
  f.selection.install();
  f.click();
  assert.equal(f.state.selectedId, row.stableId);
  assert.equal(f.state.selectedRow, row);
  assert.equal(f.flights.length, 1);
  assert.deepEqual(f.flights[0], {
    kind: 'sighting',
    id: row.stableId,
    label: row.commonName,
    position: f.position,
  });
  assert.deepEqual(f.seen.at(-1), {
    value: row,
    metadata: { explicitSelection: true },
  });
  assert.equal(f.entries.get('wildlife-sightings-selected').length, 1);
  f.selection.remove();
});

test('selected photo and name cards use the selected lane, select on click and never open links themselves', () => {
  for (const photo of [
    null,
    {
      square:
        'https://inaturalist-open-data.s3.amazonaws.com/photos/123/square.jpg',
      licence: 'cc-by',
      attribution: 'Synthetic Photographer',
    },
  ]) {
    const sighting = { ...row, photo };
    const f = fixture(sighting);
    f.selection.install();
    f.selection.refreshAmbient();
    const source = photo ? 'wildlife-sightings' : 'wildlife-sightings-labels';
    const id = photo
      ? 'sighting:inat:123'
      : 'wildlife-sightings-label:inat:123';
    f.hit(source, id);
    f.click();
    assert.equal(f.flights.length, 1);
    if (photo) f.paint([row.stableId]);
    const selectedSource = photo ? source : 'wildlife-sightings-selected';
    const card = f.entries.get(selectedSource)[0];
    assert.equal(card.selected, true);
    assert.equal(card.paintLane, 'selected');
    assert.ok(
      !(card.details || []).some((line) => line.includes('↗')),
      'the anchored photo card owns the single source link',
    );
    assert.match(card.accessibilityLabel, /Synthetic bird/);
    if (photo) {
      assert.equal(card.variant, 'thumbnail');
      assert.ok(card.image);
      assert.deepEqual(f.entries.get('wildlife-sightings-selected'), []);
    }
    f.hit(selectedSource, card.id);
    f.click('other:aircraft');
    assert.equal(f.flights.length, photo ? 2 : 1);
    f.selection.clearAndRebuild();
    if (photo) {
      const ambient = f.entries.get(source)[0];
      assert.equal(ambient.selected, undefined);
      assert.deepEqual(ambient.details, ['© Synthetic Photographer']);
    }
  }
});

test('nearby duplicate display names yield to painted cards and higher-ranked labels using cached screens', () => {
  const low = {
    ...row,
    stableId: 'inat:low',
    quality: 'research',
    photo: {
      square:
        'https://inaturalist-open-data.s3.amazonaws.com/photos/123/square.jpg',
      licence: 'cc-by',
      attribution: 'Synthetic Photographer',
    },
  };
  const high = { ...low, stableId: 'inat:high', favesCount: 50 };
  const far = { ...row, stableId: 'inat:far' };
  const different = {
    ...row,
    stableId: 'inat:different',
    commonName: 'Other bird',
  };
  const f = fixture();
  f.state.renderedRows = [low, high, far, different];
  f.state.rowById = new Map(
    f.state.renderedRows.map((row) => [row.stableId, row]),
  );
  f.state.positions = new Map([
    [low.stableId, { x: 300, y: 300 }],
    [high.stableId, { x: 379, y: 300 }],
    [far.stableId, { x: 460, y: 300 }],
    [different.stableId, { x: 310, y: 300 }],
  ]);
  const labelIds = () =>
    f.entries.get('wildlife-sightings-labels').map((entry) => entry.id);
  f.selection.refreshAmbient();
  assert.ok(!labelIds().includes('wildlife-sightings-label:inat:low'));
  assert.ok(labelIds().includes('wildlife-sightings-label:inat:high'));
  assert.ok(
    labelIds().includes('wildlife-sightings-label:inat:far'),
    '81px names survive',
  );
  assert.ok(labelIds().includes('wildlife-sightings-label:inat:different'));
  const projections = f.projections;
  f.state.ambientRows = [low];
  f.paint([low.stableId]);
  assert.ok(
    !labelIds().includes('wildlife-sightings-label:inat:high'),
    'a painted lower-score card wins',
  );
  assert.equal(
    f.projections,
    projections,
    'paint membership uses the last label pass',
  );
  f.paint([]);
  assert.ok(
    labelIds().includes('wildlife-sightings-label:inat:high'),
    'a queued/unpainted card suppresses nothing',
  );
  f.selection.selectAndFocus(low.stableId);
  assert.ok(
    !labelIds().includes('wildlife-sightings-label:inat:high'),
    'selected labels outrank ambient names',
  );
  assert.equal(
    f.projections,
    projections,
    'selection never projects the population',
  );
  f.selection.clearAndRebuild();
  f.state.positions.set(high.stableId, { x: 600, y: 300 });
  f.selection.refreshAmbient();
  assert.ok(
    labelIds().includes('wildlife-sightings-label:inat:low'),
    'moveEnd admits separated names',
  );
});

test('selection remains published while a new sample or camera pass replaces rendered lookup rows', () => {
  const f = fixture();
  f.selection.selectAndFocus(row.stableId);
  f.state.rowById.clear();
  f.state.renderedRows = [];
  f.selection.publishSelected();
  f.selection.notify();
  assert.equal(f.seen.at(-1).value, row);
  assert.equal(
    f.entries.get('wildlife-sightings-selected')[0].position,
    f.position,
  );
  assert.equal(
    f.flights.length,
    1,
    'refresh notifications never start another flight',
  );
  f.selection.clearAndRebuild();
  assert.equal(f.state.selectedId, null);
  assert.equal(f.state.selectedRow, null);
  assert.equal(f.seen.at(-1).value, null);
  assert.deepEqual(f.entries.get('wildlife-sightings-selected'), []);
});

test('an obscured observation focuses only its existing privacy-safe anchor', () => {
  const obscured = { ...row, obscured: true, lat: 48.1, lon: 8.3 };
  const f = fixture(obscured);
  assert.equal(f.selection.selectAndFocus(obscured.stableId), true);
  assert.equal(f.flights[0].kind, 'sighting-area');
  assert.equal(f.flights[0].position, f.position);
  assert.equal(f.state.selectedRow, obscured);
});

test('empty clicks and layer removal release the selected row and its overlay', () => {
  const f = fixture();
  f.selection.install();
  f.click();
  f.click(null);
  assert.equal(f.state.selectedRow, null);
  assert.equal(f.state.selectedId, null);
  f.click();
  f.state.enabled = false;
  f.selection.remove();
  assert.equal(f.state.selectedRow, null);
  assert.equal(f.state.selectedId, null);
  assert.equal(f.seen.at(-1).value, null);
  assert.equal(f.entries.size, 0);
});
