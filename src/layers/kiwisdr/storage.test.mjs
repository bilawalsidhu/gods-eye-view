import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KIWI_STORAGE_KEY,
  MAX_FAVORITES,
  MAX_PRESETS_PER_STATION,
  createKiwiStore,
} from './storage.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
  };
}
const station = (id, over = {}) => ({
  id,
  name: `Rx ${id}`,
  loc: 'Somewhere',
  lat: 51.5,
  lon: -0.12,
  ...over,
});

test('favorites toggle on and off, survive a reload, and tell listeners', () => {
  const storage = memoryStorage();
  const store = createKiwiStore({ storage });
  const seen = [];
  store.onChange((what) => seen.push(what));
  assert.equal(store.isFavorite('abcd1234'), false);
  assert.equal(store.toggleFavorite(station('abcd1234')), true);
  assert.equal(store.isFavorite('abcd1234'), true);
  assert.deepEqual(seen, ['favorites']);

  const again = createKiwiStore({ storage });
  assert.equal(again.isFavorite('abcd1234'), true);
  assert.equal(again.getFavorites()[0].name, 'Rx abcd1234');

  assert.equal(store.toggleFavorite(station('abcd1234')), false);
  assert.equal(store.isFavorite('abcd1234'), false);
  assert.equal(createKiwiStore({ storage }).getFavorites().length, 0);
});

test('removeFavorite removes by id and reports whether anything changed', () => {
  const store = createKiwiStore({ storage: memoryStorage() });
  store.toggleFavorite(station('abcd1234'));
  assert.equal(store.removeFavorite('abcd1234'), true);
  assert.equal(store.removeFavorite('abcd1234'), false);
  assert.equal(store.isFavorite('abcd1234'), false);
});

test('presets are per receiver, de-duplicated, sorted and removable', () => {
  const storage = memoryStorage();
  const store = createKiwiStore({ storage });
  assert.equal(
    store.addPreset('aaaa1111', { freqKhz: 7200, mode: 'lsb' }),
    true,
  );
  assert.equal(
    store.addPreset('aaaa1111', { freqKhz: 5000, mode: 'am' }),
    true,
  );
  assert.equal(
    store.addPreset('aaaa1111', { freqKhz: 7200, mode: 'lsb' }),
    false,
    'duplicate',
  );
  assert.equal(
    store.addPreset('aaaa1111', { freqKhz: 7200, mode: 'usb' }),
    true,
    'same freq, other mode',
  );
  assert.equal(
    store.addPreset('bbbb2222', { freqKhz: 1000, mode: 'am' }),
    true,
  );
  assert.deepEqual(
    store.getPresets('aaaa1111').map((p) => p.freqKhz),
    [5000, 7200, 7200],
  );
  assert.deepEqual(store.getPresets('bbbb2222'), [
    { freqKhz: 1000, mode: 'am' },
  ]);
  assert.deepEqual(store.getPresets('cccc3333'), []);

  const again = createKiwiStore({ storage });
  assert.equal(again.getPresets('aaaa1111').length, 3);

  assert.equal(
    store.removePreset('aaaa1111', { freqKhz: 7200, mode: 'lsb' }),
    true,
  );
  assert.equal(
    store.removePreset('aaaa1111', { freqKhz: 7200, mode: 'lsb' }),
    false,
  );
  assert.equal(store.getPresets('aaaa1111').length, 2);
  store.removePreset('bbbb2222', { freqKhz: 1000, mode: 'am' });
  assert.ok(
    !('bbbb2222' in JSON.parse(storage.getItem(KIWI_STORAGE_KEY)).presets),
  );
});

test('rejects nonsense input instead of storing it', () => {
  const store = createKiwiStore({ storage: memoryStorage() });
  assert.equal(store.toggleFavorite({ id: '../x' }), false);
  assert.equal(store.toggleFavorite(null), false);
  assert.equal(store.getFavorites().length, 0);
  assert.equal(store.addPreset('aaaa1111', { freqKhz: NaN }), false);
  assert.equal(store.addPreset('aaaa1111', { freqKhz: -5 }), false);
  assert.equal(store.addPreset('bad id', { freqKhz: 1000 }), false);
  assert.equal(
    store.addPreset('aaaa1111', { freqKhz: 1000, mode: 'warp' }),
    true,
    'unknown mode saved as frequency only',
  );
  assert.equal(store.getPresets('aaaa1111')[0].mode, null);
});

test('survives corrupt, hostile or missing storage', () => {
  for (const raw of [
    '{not json',
    'null',
    '[]',
    '"x"',
    '{"favorites":5,"presets":7}',
  ]) {
    const store = createKiwiStore({
      storage: memoryStorage({ [KIWI_STORAGE_KEY]: raw }),
    });
    assert.deepEqual(store.getFavorites(), [], raw);
    assert.deepEqual(store.getPresets('aaaa1111'), [], raw);
  }
  const hostile = JSON.stringify({
    favorites: [
      { id: 'good1234', name: 'ok\u0000\n<b>x</b>', lat: 999, lon: 1 },
      { id: '../../etc', name: 'bad' },
      { id: 'good1234', name: 'duplicate' },
      null,
    ],
    presets: {
      good1234: [{ freqKhz: 'abc' }, { freqKhz: 7100, mode: 'usb' }],
      __proto__: [{ freqKhz: 1 }],
    },
  });
  const store = createKiwiStore({
    storage: memoryStorage({ [KIWI_STORAGE_KEY]: hostile }),
  });
  assert.equal(store.getFavorites().length, 1);
  assert.equal(store.getFavorites()[0].lat, null);
  assert.ok(!/[\u0000\n]/.test(store.getFavorites()[0].name));
  assert.deepEqual(store.getPresets('good1234'), [
    { freqKhz: 7100, mode: 'usb' },
  ]);
  assert.equal(
    Object.getPrototypeOf(store.getPresets('good1234')[0]),
    Object.prototype,
  );

  // No storage at all, or one that throws, still works for the session.
  const none = createKiwiStore({ storage: null });
  assert.equal(none.toggleFavorite(station('abcd1234')), true);
  assert.equal(none.isFavorite('abcd1234'), true);
  const throwing = createKiwiStore({
    storage: {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('full');
      },
    },
  });
  assert.equal(
    throwing.addPreset('aaaa1111', { freqKhz: 7100, mode: 'am' }),
    true,
  );
  assert.equal(throwing.getPresets('aaaa1111').length, 1);
});

test('keeps its lists bounded', () => {
  const store = createKiwiStore({ storage: memoryStorage() });
  for (let i = 0; i < MAX_FAVORITES + 5; i++)
    store.toggleFavorite(station(`id${String(i).padStart(6, '0')}`));
  assert.equal(store.getFavorites().length, MAX_FAVORITES);
  assert.equal(store.isFavorite('id000000'), false, 'oldest dropped');
  for (let i = 0; i < MAX_PRESETS_PER_STATION + 3; i++)
    store.addPreset('aaaa1111', { freqKhz: 1000 + i, mode: 'am' });
  assert.equal(store.getPresets('aaaa1111').length, MAX_PRESETS_PER_STATION);
});

test('a throwing listener does not break the store', () => {
  const store = createKiwiStore({ storage: memoryStorage() });
  const warn = console.warn;
  console.warn = () => {};
  try {
    let called = 0;
    store.onChange(() => {
      throw new Error('boom');
    });
    store.onChange(() => called++);
    store.toggleFavorite(station('abcd1234'));
    assert.equal(called, 1);
  } finally {
    console.warn = warn;
  }
});
