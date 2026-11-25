import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from '../layers/installations/controls.js';
import { recordKey, nearbyByKind, nearbyForLayer } from './entityContext.js';

test('installation and its Contacts record exclude each other', () => {
  // Installation analyst record as installations/controls.js builds it.
  const src = {
    id: 'osm:way/42',
    name: 'Fort Example',
    class: 'base',
    latitude: 10,
    longitude: 20,
  };
  const [inst] = createControls({
    state: { enabled: true, records: [src] },
    services: {},
    parts: {},
    source: {},
  }).methods.getAnalystRecords();
  // Contacts record as awareness/controls.js builds it from subjectFromContext({id: record.id}).
  const contact = {
    id: `military-installations:${src.id}`,
    name: src.name,
    subjectLayer: 'military-installations',
    lat: 10,
    lon: 20,
  };
  const layers = new Map([
    [
      'military-installations',
      {
        id: 'military-installations',
        name: 'Installations',
        module: { getAnalystRecords: () => [inst] },
      },
    ],
    [
      'military-awareness',
      {
        id: 'military-awareness',
        name: 'Contacts',
        module: { getAnalystRecords: () => [contact] },
      },
    ],
  ]);
  const dm = {
    isEnabled: () => true,
    layers,
    getAll: () =>
      [...layers.values()].map((l) => ({ id: l.id, enabled: true })),
  };
  const cardKey = recordKey('military-installations', inst);
  const groups = nearbyByKind(
    dm,
    { lat: 10, lon: 20 },
    { radiusKm: 25, excludeKey: cardKey },
  );
  assert.equal(
    groups.other.length,
    0,
    'the selected installation reappears through Contacts',
  );
  const contactKey = recordKey('military-awareness', contact);
  const list = nearbyForLayer(
    dm,
    { id: 'military-installations', enabled: true },
    { lat: 10, lon: 20 },
    { radiusKm: 25, excludeKey: contactKey },
  );
  assert.equal(list.count, 0, 'the Contacts card lists its own subject');
});
