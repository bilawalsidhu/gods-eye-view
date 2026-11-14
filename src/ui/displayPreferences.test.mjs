import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPLAY_PREFERENCES_KEY,
  readDisplayPreferences,
  writeDisplayPreferences,
} from './displayPreferences.js';

const schema = {
  styles: { thermal: { uniforms: { palette: { min: 0, max: 1 } } } },
  layouts: ['tactical', 'minimal', 'cyber'],
  maps: ['osm', 'esri-hybrid'],
};
function storage(value) {
  let raw = value;
  return {
    getItem: () => raw,
    setItem: (key, next) => {
      assert.equal(key, DISPLAY_PREFERENCES_KEY);
      raw = next;
    },
  };
}

test('a new startup restores an explicit sonar OFF with its layout and sliders', () => {
  const disk = storage(null);
  const saved = {
    style: 'thermal',
    hudVariant: 'cyber',
    hudVisible: false,
    bloom: false,
    sharpen: true,
    scopeEnabled: false,
    scopeFeatherPct: 160,
    styleParams: { palette: 0.42 },
    mapStack: 'esri-hybrid',
    detectionMode: 'OFF',
    detectionDensity: 25,
    scopeTerminusPct: null,
    sonar: { enabled: false, rings: 5, range: 80, sector: 30 },
  };
  writeDisplayPreferences(disk, saved);
  assert.deepEqual(readDisplayPreferences(disk, schema), saved);
  writeDisplayPreferences(disk, { ...saved, sonar: { enabled: true } });
  assert.equal(readDisplayPreferences(disk, schema).sonar.enabled, true);
});

test('damaged, unavailable and future storage never prevents startup or controls', () => {
  for (const raw of [null, '', '{', 'null', '[]', '{"version":2}']) {
    assert.equal(readDisplayPreferences(storage(raw), schema), null);
  }
  const blocked = {
    getItem() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('full');
    },
  };
  assert.equal(readDisplayPreferences(blocked, schema), null);
  assert.doesNotThrow(() =>
    writeDisplayPreferences(blocked, { sonar: { enabled: false } }),
  );
});

test('restoration ignores unknown controls, retired layouts and invalid values', () => {
  const raw = {
    version: 1,
    style: 'thermal',
    hudVariant: 'operator',
    mapStack: 'unknown',
    detectionMode: 'garbage',
    hudVisible: 'false',
    bloomIntensity: 900,
    scopeFeatherPct: -20,
    styleParams: { palette: 9, unknown: 8 },
    sonar: { enabled: 'false', rings: 'bad', range: 90, unknown: 2 },
  };
  assert.deepEqual(
    readDisplayPreferences(storage(JSON.stringify(raw)), schema),
    {
      style: 'thermal',
      bloomIntensity: 200,
      scopeFeatherPct: 0,
      styleParams: { palette: 1 },
      sonar: { range: 90 },
    },
  );
});

test('unchanged snapshots avoid repeated synchronous storage writes', () => {
  const disk = storage(null);
  const put = disk.setItem;
  let writes = 0;
  disk.setItem = (...args) => {
    writes++;
    put(...args);
  };
  writeDisplayPreferences(disk, { sonar: { enabled: false } });
  writeDisplayPreferences(disk, { sonar: { enabled: false } });
  assert.equal(writes, 1);
});
