import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listFrames,
  resolveFrame,
  xweatherStamp,
} from '../../server/providers/xweather/frames.js';

const BASE = 'https://maps.api.xweather.com/ID_SECRET';

test('stamps are UTC YYYYMMDDhhmmss', () => {
  assert.equal(
    xweatherStamp(Date.UTC(2026, 8, 24, 16, 30, 34)),
    '20260924163034',
  );
});

test('a redirect to the canonical frame yields its exact valid time without a body read', async () => {
  let cancelled = false;
  const fetchImpl = async (url, options) => {
    assert.equal(url, `${BASE}/radar-global/0/0/0/current.png`);
    assert.equal(options.redirect, 'manual');
    return {
      status: 302,
      headers: new Headers({
        location:
          '/ID_SECRET/radar-global/0/0/0/20260924163034_20260924163034.png',
      }),
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    };
  };
  const frame = await resolveFrame({
    fetchImpl,
    base: BASE,
    layer: 'radar-global',
    at: 'current',
  });
  assert.deepEqual(frame, {
    time: '2026-09-24T16:30:34.000Z',
    frame: '20260924163034_20260924163034',
  });
  assert.equal(cancelled, true);
});

test('anything but a canonical redirect is an upstream error, never a guessed time', async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { cancel: async () => {} },
  });
  await assert.rejects(
    resolveFrame({
      fetchImpl,
      base: BASE,
      layer: 'radar-global',
      at: 'current',
    }),
    { code: 'xweather_upstream_error' },
  );
});

test('an upstream error never carries the base credentials, whether from a bad response or a failed fetch', async () => {
  const badResponse = async () => ({
    status: 403,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: { cancel: async () => {} },
  });
  await assert.rejects(
    resolveFrame({
      fetchImpl: badResponse,
      base: BASE,
      layer: 'radar-global',
      at: 'current',
    }),
    (err) => {
      assert.equal(err.code, 'xweather_upstream_error');
      assert.ok(!String(err.message).includes(BASE));
      assert.ok(!String(err.code).includes(BASE));
      return true;
    },
  );

  const failingFetch = async () => {
    // A real fetch failure's message often echoes the request URL, which
    // embeds the credentialed base; resolveFrame must not let that through.
    throw new Error(`request to ${BASE}/radar-global/0/0/0/current.png failed`);
  };
  await assert.rejects(
    resolveFrame({
      fetchImpl: failingFetch,
      base: BASE,
      layer: 'radar-global',
      at: 'current',
    }),
    (err) => {
      // A fetch that never reached Xweather is not Xweather refusing it.
      assert.equal(err.code, 'xweather_network');
      assert.equal(err.status, 503);
      assert.ok(!String(err.message).includes(BASE));
      return true;
    },
  );
});

test('an impossible frame stamp in the redirect is unavailable, not a bogus date', async () => {
  const fetchImpl = async () => ({
    status: 302,
    headers: new Headers({
      location: '/X_Y/radar-global/0/0/0/20261399250000_20261399250000.png',
    }),
    body: { cancel: async () => {} },
  });
  await assert.rejects(
    resolveFrame({
      fetchImpl,
      base: BASE,
      layer: 'radar-global',
      at: 'current',
    }),
    { code: 'xweather_upstream_unavailable' },
  );
});

test('only 401, 403 or a JSON 200 is a refusal; 404, 429 and 5xx are unavailable', async () => {
  for (const [status, type, code] of [
    [401, 'application/json', 'xweather_upstream_error'],
    [403, 'application/json; charset=utf-8', 'xweather_upstream_error'],
    [200, 'application/json', 'xweather_upstream_error'],
    [200, 'text/html', 'xweather_upstream_unavailable'],
    [404, 'application/json', 'xweather_upstream_unavailable'],
    [429, 'application/json', 'xweather_upstream_unavailable'],
    [503, 'text/html', 'xweather_upstream_unavailable'],
  ]) {
    const fetchImpl = async () => ({
      status,
      headers: new Headers({ 'content-type': type }),
      body: { cancel: async () => {} },
    });
    await assert.rejects(
      resolveFrame({
        fetchImpl,
        base: BASE,
        layer: 'radar-global',
        at: 'current',
      }),
      { code, status: 503 },
      `${status} ${type}`,
    );
  }
});

test('an already-aborted signal is reported as xweather_aborted, distinct from an upstream error, and stays credential-free', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = async () => {
    throw new DOMException(
      `This operation was aborted ${BASE}/radar-global/0/0/0/current.png`,
      'AbortError',
    );
  };
  await assert.rejects(
    resolveFrame({
      fetchImpl,
      base: BASE,
      layer: 'radar-global',
      at: 'current',
      signal: controller.signal,
    }),
    (err) => {
      assert.equal(err.code, 'xweather_aborted');
      assert.equal(err.name, 'AbortError');
      assert.ok(!String(err.message).includes(BASE));
      assert.ok(!String(err.message).includes('ID_SECRET'));
      return true;
    },
  );
});

test('listFrames returns an empty list without ever calling resolve when count < 1', async () => {
  let calls = 0;
  const resolve = async () => {
    calls++;
    return { time: new Date().toISOString(), frame: 'x_x' };
  };
  assert.deepEqual(await listFrames({ resolve, count: 0 }), []);
  assert.deepEqual(await listFrames({ resolve, count: -5 }), []);
  assert.equal(calls, 0);
});

// Xweather answers a time with the first frame at or after it (a ceiling),
// measured on 2026-09-25: 052237 -> 052238, 051100 -> 051239, 045959 ->
// 050039. These fakes serve a fixed list of irregular valid times that way.
const at = (iso) => Date.parse(`2026-09-25T${iso}Z`);
const stampMs = (stamp) =>
  Date.UTC(
    +stamp.slice(0, 4),
    +stamp.slice(4, 6) - 1,
    +stamp.slice(6, 8),
    +stamp.slice(8, 10),
    +stamp.slice(10, 12),
    +stamp.slice(12, 14),
  );
function ceilingFake(validTimes) {
  const ascending = validTimes.map(at).sort((a, b) => a - b);
  const asked = [];
  const resolve = async (stamp) => {
    asked.push(stamp);
    const valid =
      stamp === 'current'
        ? ascending.at(-1)
        : (ascending.find((time) => time >= stampMs(stamp)) ??
          ascending.at(-1));
    return {
      time: new Date(valid).toISOString(),
      frame: `${xweatherStamp(valid)}_${xweatherStamp(valid)}`,
    };
  };
  return { asked, resolve };
}
// radar-global: about 2 minutes apart at :38/:39/:40 s, with one 6 min gap
// (05:14:39 back to 05:08:40).
const RADAR = [
  '05:22:38',
  '05:20:39',
  '05:18:38',
  '05:16:40',
  '05:14:39',
  '05:08:40',
  '05:06:38',
  '05:04:40',
  '05:02:39',
  '05:00:39',
  '04:58:38',
  '04:56:40',
  '04:54:39',
  '04:52:38',
  '04:50:39',
];
const iso = (time) => new Date(at(time)).toISOString();

test('listFrames rejects as a whole, with no partial list, when resolve fails partway through the walk', async () => {
  const { resolve: frame } = ceilingFake(RADAR);
  let calls = 0;
  const resolve = async (stamp) => {
    if (++calls === 3) throw new Error('upstream boom');
    return frame(stamp);
  };
  await assert.rejects(
    listFrames({ resolve, stepMs: 180_000, now: () => at('05:23:00') }),
    /upstream boom/,
  );
});

test('listFrames needs a positive step', async () => {
  const { resolve } = ceilingFake(RADAR);
  await assert.rejects(listFrames({ resolve }), TypeError);
  await assert.rejects(listFrames({ resolve, stepMs: 0 }), TypeError);
});

test('listFrames walks radar back 1.5 cadences per frame under ceiling lookups, retrying once across a gap', async () => {
  const { asked, resolve } = ceilingFake(RADAR);
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => at('05:23:00'),
  });
  assert.deepEqual(
    frames.map(({ time }) => time),
    RADAR.slice(0, 13).reverse().map(iso),
  );
  assert.equal(frames.at(-1).frame, '20260925052238_20260925052238');
  // 'current', one probe per frame, and one retry across the 6 min gap.
  assert.equal(asked.length, 14);
  assert.equal(asked[0], 'current');
  assert.equal(asked[1], xweatherStamp(at('05:22:38') - 180_000));
  assert.equal(asked[5], xweatherStamp(at('05:14:39') - 180_000));
  assert.equal(asked[6], xweatherStamp(at('05:14:39') - 360_000));
  // Never more than two probes for any one frame.
  const probesPerFrame = new Map();
  for (const stamp of asked.slice(1)) {
    const index = frames.findIndex(
      ({ time }) => Date.parse(time) >= stampMs(stamp),
    );
    probesPerFrame.set(index, (probesPerFrame.get(index) ?? 0) + 1);
  }
  assert.ok([...probesPerFrame.values()].every((probes) => probes <= 2));
});

test('listFrames walks lightning back on its 5 min cadence', async () => {
  const LIGHTNING = [
    '05:25:00',
    '05:20:00',
    '05:15:01',
    '05:10:00',
    '05:04:59',
    '05:00:00',
    '04:55:00',
    '04:50:01',
    '04:45:00',
    '04:40:00',
    '04:34:59',
    '04:30:00',
    '04:25:00',
    '04:20:00',
  ];
  const { asked, resolve } = ceilingFake(LIGHTNING);
  const frames = await listFrames({
    resolve,
    stepMs: 450_000,
    now: () => at('05:25:30'),
  });
  assert.deepEqual(
    frames.map(({ time }) => time),
    LIGHTNING.slice(0, 13).reverse().map(iso),
  );
  assert.equal(asked.length, 13);
});

test('listFrames stops after two probes when every lookup returns the same frame', async () => {
  const start = Date.UTC(2026, 8, 24, 16, 30, 34);
  let calls = 0;
  const resolve = async () => {
    calls++;
    return {
      time: new Date(start).toISOString(),
      frame: '20260924163034_20260924163034',
    };
  };
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => start,
  });
  assert.equal(frames.length, 1);
  assert.equal(calls, 3);
});

test('listFrames stops at a gap wider than two steps', async () => {
  const { asked, resolve } = ceilingFake([
    '05:22:38',
    '05:20:39',
    '05:10:39',
    '05:08:40',
  ]);
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => at('05:23:00'),
  });
  assert.deepEqual(
    frames.map(({ time }) => time),
    ['05:20:39', '05:22:38'].map(iso),
  );
  assert.equal(asked.length, 4);
});

test('listFrames stops at the age limit before reaching 13 frames', async () => {
  const { asked, resolve } = ceilingFake(RADAR);
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => at('05:22:38'),
    maxAgeMs: 10 * 60_000,
  });
  assert.deepEqual(
    frames.map(({ time }) => time),
    RADAR.slice(0, 5).reverse().map(iso),
  );
  // The retry across the gap finds 05:08:40, which is too old; nothing more.
  assert.equal(asked.length, 7);
});

// The previous walk's list, oldest first, as the proxy keeps it.
const listed = (times) =>
  times.map((time) => ({
    time: iso(time),
    frame: `${xweatherStamp(at(time))}_${xweatherStamp(at(time))}`,
  }));

test('listFrames refreshes incrementally: one new frame costs two lookups and merges with the known list', async () => {
  const { asked, resolve } = ceilingFake(RADAR);
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => at('05:23:00'),
    known: listed(RADAR.slice(1, 14).reverse()),
  });
  assert.deepEqual(
    frames.map(({ time }) => time),
    RADAR.slice(0, 13).reverse().map(iso),
  );
  assert.equal(frames.at(-1).frame, '20260925052238_20260925052238');
  assert.deepEqual(asked, ['current', xweatherStamp(at('05:22:38') - 180_000)]);
});

test('listFrames makes one lookup when no frame is newer than the known list', async () => {
  const { asked, resolve } = ceilingFake(RADAR);
  const known = listed(RADAR.slice(0, 13).reverse());
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => at('05:23:00'),
    known,
  });
  assert.deepEqual(frames, known);
  assert.deepEqual(asked, ['current']);
});

test('listFrames drops known frames past the age limit before merging', async () => {
  const { resolve } = ceilingFake(RADAR);
  const frames = await listFrames({
    resolve,
    stepMs: 180_000,
    now: () => at('05:23:00'),
    maxAgeMs: 10 * 60_000,
    known: listed(RADAR.slice(1, 14).reverse()),
  });
  assert.deepEqual(
    frames.map(({ time }) => time),
    RADAR.slice(0, 5).reverse().map(iso),
  );
});
