import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeGlmGranule,
  parseProductTimeUnits,
  unpackPacked,
} from '../../server/providers/glm/flashes.js';

test('packed values and product units', () => {
  assert.equal(unpackPacked(99, { _FillValue: { value: 99 } }), null);
  assert.equal(
    unpackPacked(3, { scale_factor: { value: 2 }, add_offset: { value: 1 } }),
    7,
  );
  // NetCDF unsigned int16 stored in a signed container.
  assert.equal(unpackPacked(-6370, { _Unsigned: { value: 'true' } }), 59166);
  assert.equal(
    parseProductTimeUnits('seconds since 2000-01-01 12:00:00'),
    Date.UTC(2000, 0, 1, 12),
  );
  assert.equal(parseProductTimeUnits('nope'), null);
});
test('decodes and closes a fake granule', async () => {
  let closed = false;
  const ds = (value, attrs = {}) => ({ value, attrs });
  const values = {
    flash_count: ds(2),
    product_time: ds(10, {
      units: { value: 'seconds since 2000-01-01 12:00:00' },
    }),
    flash_lat: ds([1, NaN]),
    flash_lon: ds([2, 3]),
    flash_id: ds([4, 5]),
    flash_energy: ds([2, 2], {
      scale_factor: { value: 2 },
      add_offset: { value: 1 },
    }),
    flash_area: ds([3, 3]),
    flash_quality_flag: ds([0, 0]),
    flash_time_offset_of_first_event: ds([5, 5]),
  };
  class File {
    get(name) {
      return values[name];
    }
    close() {
      closed = true;
    }
  }
  const result = await decodeGlmGranule('/tmp/x', {
    satelliteId: 'GOES-19',
    granuleStartMs: 8,
    h5wasmModule: { ready: Promise.resolve(), File },
  });
  assert.equal(result.flashes.length, 1);
  assert.deepEqual(result.flashes[0], {
    id: 'GOES-19:8:4',
    satelliteId: 'GOES-19',
    lon: 2,
    lat: 1,
    timeMs: Date.UTC(2000, 0, 1, 12) + 15000,
    energyJ: 5,
    areaM2: 3,
    qualityFlag: 0,
  });
  assert.equal(closed, true);
});
test('rejects a granule whose product_time units cannot be parsed', async () => {
  const ds = (value, attrs = {}) => ({ value, attrs });
  class File {
    get(name) {
      if (name === 'flash_count') return ds(0);
      if (name === 'product_time') return ds(0, { units: { value: 'bogus' } });
      return ds([]);
    }
    close() {}
  }
  await assert.rejects(
    decodeGlmGranule('/tmp/x', {
      satelliteId: 'GOES-19',
      h5wasmModule: { ready: Promise.resolve(), File },
    }),
    /product_time units/,
  );
});
