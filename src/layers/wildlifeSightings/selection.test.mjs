import assert from 'node:assert/strict';
import test from 'node:test';
import { createSelection } from './selection.js';
import { bindWildlifeViewer } from '../../testSupport/wildlifeViewer.mjs';
import { clickCard } from '../../data/pickRegistry.js';
import { fakeInputUnderLabel } from '../../input/testDoubles.mjs';

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

function fixture(sighting = row, extraServices = {}) {
  const position = { x: 300, y: 300, z: 0 };
  const entries = new Map();
  const flights = [];
  const seen = [];
  const painted = new Set();
  let hit = null;
  let coveringHit = null;
  let projections = 0;
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
      scene: { canvas: { clientWidth: 1200, clientHeight: 900 } },
      camera: { positionCartographic: { height: 30_000 } },
    },
  };
  bindWildlifeViewer(state.viewer);
  const overlayHost = {
    setEntries: (id, value) => entries.set(id, value),
    clearSource: (id) => entries.delete(id),
    setVisible() {},
    hitTest: (_x, _y, { sourceId } = {}) =>
      sourceId ? (hit?.sourceId === sourceId ? hit : null) : coveringHit || hit,
  };
  const selection = createSelection({
    state,
    services: {
      overlayHost,
      now: () => row.observedAt + 60_000,
      project: (_scene, anchor) => {
        projections++;
        return anchor;
      },
      focus: { requestWorldFocus: (request) => flights.push(request) },
      input: () => ({
        onClick(fn) {
          click = fn;
          return () => (click = null);
        },
      }),
      eventTarget: new EventTarget(),
      ...extraServices,
      // The card on top at a click, as the registry answers from the host;
      // a mission label painted over everything comes first.
      picking: {
        clickCard: (c) =>
          clickCard(c) ??
          overlayHost.hitTest(c.screenPosition?.x, c.screenPosition?.y),
        ...extraServices.picking,
      },
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
    cover(value) {
      coveringHit = value;
    },
    paint(ids) {
      painted.clear();
      for (const id of ids) painted.add(id);
      selection.photoCardsChanged();
    },
    click(id = `wildlife:${sighting.stableId}`, { touchId } = {}) {
      // The exact top hit, and the id a touch's wider contact search finds.
      click({
        screenPosition: { x: 10, y: 20 },
        topHit: id ? { set: 'wildlife', id } : null,
        id: touchId ?? id ?? undefined,
      });
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

test('a covered sighting label and icon yield; the top label acts over trails and other scene items', () => {
  const f = fixture(row, {
    // Registered owners, as the app has them: an aircraft, and the flight
    // trails every layer reads as a no-op (src/data/trailRenderer.js).
    picking: {
      isOwnedByOtherLayer: (_layer, id) =>
        id === 'other:aircraft' || String(id).startsWith('gev-trail:'),
    },
  });
  f.selection.install();
  f.selection.refreshAmbient();
  f.hit('wildlife-sightings-labels', 'wildlife-sightings-label:inat:123');
  f.click(null);
  assert.equal(f.flights.length, 1);
  f.cover({ sourceId: 'earthquakes', entryId: 'quake:cover' });
  f.click(null);
  assert.equal(f.flights.length, 1);
  assert.equal(f.state.selectedRow, row);
  // A sighting icon under another layer's card is that card's click too.
  f.click();
  assert.equal(f.flights.length, 1, 'a covered sighting does not act');
  f.cover(null);
  // The top label acts over a flight trail: never a dead click.
  f.click('gev-trail:fl-a1b2c3:head');
  assert.equal(f.flights.length, 2, 'the label acts over a flight trail');
  // And over another layer's scene item.
  f.click('other:aircraft');
  assert.equal(f.flights.length, 3, 'the top label acts');
  assert.equal(f.state.selectedRow, row);
  f.selection.remove();
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

test("a click on a mission label over a sighting's card never selects the sighting, and keeps the selected one", (t) => {
  let fake = null;
  const f = fixture(row, {
    input: (viewer) => {
      fake ??= fakeInputUnderLabel(viewer);
      return fake.input;
    },
  });
  f.selection.install();
  t.after(() => {
    f.selection.remove();
    fake.destroy();
  });
  f.selection.refreshAmbient();
  // The sighting's name card lies under every click.
  f.hit('wildlife-sightings-labels', 'wildlife-sightings-label:inat:123');

  // Under the label, the card beneath it selects nothing.
  fake.label.over = true;
  fake.click();
  assert.equal(f.state.selectedId, null);
  assert.equal(f.flights.length, 0);

  // Off the label, a click on the card selects and focuses the sighting.
  fake.label.over = false;
  fake.click();
  assert.equal(f.state.selectedId, row.stableId);
  assert.equal(f.flights.length, 1);

  // The label on top is its own click: the sighting stays selected, and
  // the camera is not sent to it again.
  fake.label.over = true;
  fake.click();
  assert.equal(f.state.selectedId, row.stableId, 'the sighting stays');
  assert.equal(f.state.selectedRow, row);
  assert.equal(f.flights.length, 1, 'the camera is not sent to the sighting');
});

test('a tap selects only a sighting exactly under it, not one the touch search found near it', () => {
  const f = fixture();
  f.selection.install();
  f.click(null, { touchId: `wildlife:${row.stableId}` });
  assert.equal(f.state.selectedId, null);
  f.click();
  assert.ok(f.state.selectedId);
  f.click(null, { touchId: 'other:aircraft' });
  assert.equal(f.state.selectedId, null, 'a tap near another contact clears');
});

test('each sighting in context carries the point voice projects to find what is in view', () => {
  const registered = [];
  const f = fixture(row, {
    context: {
      registerEntityContext: (entity, metadata) =>
        registered.push({ entity, metadata }),
    },
  });
  f.selection.refreshContexts();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].metadata.id, row.stableId);
  assert.equal(registered[0].metadata.targetPosition, f.position);
});
