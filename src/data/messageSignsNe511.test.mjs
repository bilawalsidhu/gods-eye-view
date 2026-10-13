import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSignImageUrl,
  signHeadingFromTitle,
  parseSignLocation,
  normalizeSignView,
  normalizeSignFeature,
  loadNe511Signs,
  NE511_SIGN_IMAGE_ORIGIN,
} from '../../server/providers/messageSigns/ne511.js';
import { NE511_GRAPHQL_URL } from '../../server/providers/cctv/constants.js';
import {
  serializeSigns,
  signImagePath,
  loadAllSigns,
  imageMediaType,
  createSignsCache,
} from '../../server/providers/messageSigns.js';
import { readResponseBytesCapped } from '../../server/providers/common/http.js';

/** Minimal normalized sign, for pack-merge assertions. */
const sign1 = (id) => ({ id, views: [{ textLines: ['X'], imageUrl: '' }] });

const IMAGE = `${NE511_SIGN_IMAGE_ORIGIN}NE/prod/12_2026-07-21T193626.43821Z.png`;

const sign = (overrides = {}) => ({
  __typename: 'Sign',
  uri: 'electronic-sign/necarsxsigns*229',
  title: 'I-80: I-80 EB Mile 17.61',
  signStatus: 'DISPLAYING_MESSAGE',
  signDisplayType: 'CMS',
  bbox: [-103.7205, 41.20517, -103.7205, 41.20517],
  views: [
    {
      uri: 'electronic-sign/necarsxsigns*229/661361846',
      category: 'CMS',
      textJustification: 'CENTER',
      textLines: ['ROADWORK AHEAD', 'LEFT LANE CLOSED', 'KEEP RIGHT'],
    },
  ],
  ...overrides,
});

test('sign face images are pinned to the vendor bucket', () => {
  assert.equal(normalizeSignImageUrl(IMAGE), IMAGE);
  // Query strings are dropped; host, scheme and extension are enforced.
  assert.equal(normalizeSignImageUrl(`${IMAGE}?v=2`), IMAGE);
  assert.equal(normalizeSignImageUrl('https://evil.example/x.png'), '');
  assert.equal(
    normalizeSignImageUrl(NE511_SIGN_IMAGE_ORIGIN.replace('https', 'http')),
    '',
  );
  assert.equal(normalizeSignImageUrl(`${NE511_SIGN_IMAGE_ORIGIN}x.svg`), '');
  assert.equal(normalizeSignImageUrl(null), '');
});

test('a sign title yields a real facing, unlike a camera title', () => {
  // Signs address oncoming traffic, so the posted bearing is the facing.
  assert.equal(signHeadingFromTitle('I-80: I-80 EB Mile 17.61'), 90);
  assert.equal(signHeadingFromTitle('I-80: I-80 WB Mile 447.5'), 270);
  assert.equal(signHeadingFromTitle('I-680: I-680 SB Mile 3.9'), 180);
  assert.equal(signHeadingFromTitle('US 6: US 6 EB Mile 363.25'), 90);
  assert.ok(Number.isNaN(signHeadingFromTitle('I-80: Overton Exit')));
  assert.ok(Number.isNaN(signHeadingFromTitle('')));
});

test('route and mile marker come off the title', () => {
  assert.deepEqual(parseSignLocation('I-80: I-80 WB Mile 447.5'), {
    route: 'I-80',
    mileMarker: 447.5,
  });
  assert.deepEqual(parseSignLocation('US 75: US 75 SB Mile 87.33'), {
    route: 'US 75',
    mileMarker: 87.33,
  });
  const none = parseSignLocation('no colon here');
  assert.equal(none.route, '');
  assert.ok(Number.isNaN(none.mileMarker));
});

test('a page needs text or an image to be a page at all', () => {
  const text = normalizeSignView({
    category: 'CMS',
    textLines: ['ROADWORK AHEAD', '', '  KEEP RIGHT  '],
  });
  // Blank lines are dropped and the rest trimmed.
  assert.deepEqual(text.textLines, ['ROADWORK AHEAD', 'KEEP RIGHT']);
  assert.equal(text.justification, 'CENTER');

  const image = normalizeSignView({ category: 'VMS_IMAGE', imageUrl: IMAGE });
  assert.equal(image.imageUrl, IMAGE);
  assert.deepEqual(image.textLines, []);

  assert.equal(normalizeSignView({ category: 'CMS', textLines: [] }), null);
  assert.equal(
    normalizeSignView({ imageUrl: 'https://evil.example/x.png' }),
    null,
  );
  assert.equal(normalizeSignView(null), null);
});

test('a displaying sign maps to a normalized record', () => {
  const out = normalizeSignFeature(sign());
  // The vendor id carries an asterisk and is kept verbatim.
  assert.equal(out.id, 'ne511-sign-necarsxsigns*229');
  assert.equal(out.route, 'I-80');
  assert.equal(out.mileMarker, 17.61);
  assert.equal(out.headingDeg, 90);
  assert.equal(out.headingConfidence, 'high');
  assert.equal(out.displayType, 'CMS');
  assert.equal(out.views.length, 1);
  assert.match(out.license, /Nebraska Department of Transportation/);
});

test('non-displaying, off-type, unplaced and empty signs are dropped', () => {
  assert.equal(normalizeSignFeature({ __typename: 'Camera' }), null);
  assert.equal(normalizeSignFeature(sign({ signStatus: 'BLANK' })), null);
  assert.equal(normalizeSignFeature(sign({ uri: 'camera/5' })), null);
  assert.equal(normalizeSignFeature(sign({ views: [] })), null);
  // Out of area and null island.
  assert.equal(
    normalizeSignFeature(sign({ bbox: [-122.4, 37.8, -122.4, 37.8] })),
    null,
  );
  assert.equal(normalizeSignFeature(sign({ bbox: [0, 0, 0, 0] })), null);
});

test('a sign with no bearing in its title reports no heading, never a guess', () => {
  const out = normalizeSignFeature(sign({ title: 'I-80: Gretna Gantry' }));
  assert.equal(out.headingDeg, null);
  assert.equal(out.headingConfidence, 'none');
});

test('the fetch posts one keyless query and refuses redirects', async (t) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      data: { mapFeaturesQuery: { mapFeatures: [sign()], error: null } },
    });
  };
  const signs = await loadNe511Signs({ fetchImpl });
  assert.equal(calls[0].url, NE511_GRAPHQL_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.ok(!('Authorization' in calls[0].init.headers));
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.variables.input.layerSlugs, ['electronicSigns']);
  assert.deepEqual(
    signs.map((s) => s.id),
    ['ne511-sign-necarsxsigns*229'],
  );
});

test('vendor image URLs never reach the client', () => {
  const signs = [
    {
      id: 'ne511-sign-a*1',
      views: [
        { textLines: ['ROADWORK'], imageUrl: '' },
        { textLines: [], imageUrl: IMAGE },
      ],
    },
  ];
  const out = serializeSigns(signs);
  // A text page keeps no image; an image page becomes an app-origin path.
  assert.equal(out[0].views[0].imageUrl, '');
  assert.equal(out[0].views[1].imageUrl, signImagePath('ne511-sign-a*1', 1));
  assert.ok(out[0].views[1].imageUrl.startsWith('/api/signs/image'));
  assert.doesNotMatch(JSON.stringify(out), /amazonaws/);
  // The id carries an asterisk and must round-trip: the route looks the sign
  // up by exact id, so a value that does not decode back is a 404.
  const parsed = new URL(out[0].views[1].imageUrl, 'http://localhost');
  assert.equal(parsed.searchParams.get('sign'), 'ne511-sign-a*1');
  assert.equal(parsed.searchParams.get('page'), '1');
});

test('every enabled pack is merged and a failing pack costs only its own signs', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const ok = {
    name: 'ok',
    enabled: () => true,
    load: async () => [sign1('a')],
  };
  const boom = {
    name: 'boom',
    enabled: () => true,
    load: async () => {
      throw new Error('upstream down');
    },
  };
  const off = {
    name: 'off',
    enabled: () => false,
    load: async () => [sign1('c')],
  };
  const outcomes = await loadAllSigns({ packs: [ok, boom, off] });
  assert.deepEqual(
    outcomes.map(({ name, ok: answered, signs }) => [
      name,
      answered,
      signs.map((s) => s.id),
    ]),
    [
      ['ok', true, ['a']],
      ['boom', false, []],
    ],
  );
  const cache = createSignsCache({ cacheMs: 0, packs: [ok, boom, off] });
  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    ['a'],
  );

  // Duplicate ids across packs collapse.
  const dup = {
    name: 'dup',
    enabled: () => true,
    load: async () => [sign1('a')],
  };
  const merged = createSignsCache({ cacheMs: 0, packs: [ok, dup] });
  assert.equal((await merged.getSigns()).length, 1);
});

test('one pack failing keeps its own last good list beside a live pack', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let round = 0;
  const steady = {
    name: 'steady',
    enabled: () => true,
    load: async () => (round === 1 ? [sign1('a')] : []),
  };
  const flaky = {
    name: 'flaky',
    enabled: () => true,
    load: async () => {
      round += 1;
      if (round === 1) return [sign1('b')];
      throw new Error('upstream down');
    },
  };
  const cache = createSignsCache({ cacheMs: 0, packs: [flaky, steady] });
  assert.deepEqual((await cache.getSigns()).map((s) => s.id).sort(), [
    'a',
    'b',
  ]);
  // The live pack retires its sign; the failed pack's sign is not touched.
  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    ['b'],
  );
});

test('a sign face is identified by its own bytes, not its file extension', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(imageMediaType(png), 'image/png');
  assert.equal(imageMediaType(jpeg), 'image/jpeg');
  assert.equal(imageMediaType(gif), 'image/gif');
  // An upstream error page served from a .png URL must not be relabelled.
  assert.equal(imageMediaType(new TextEncoder().encode('<!DOCTYPE html>')), '');
  assert.equal(imageMediaType(new Uint8Array([1, 2])), '');
  assert.equal(imageMediaType(null), '');
});

test('the image read is bounded before and during the body', async () => {
  const cap = 2 * 1024 * 1024;
  // Declared oversize: refused without reading the body at all.
  let cancelled = false;
  const declared = new Response(new Uint8Array(8), {
    headers: { 'content-length': String(cap + 1) },
  });
  Object.defineProperty(declared, 'body', {
    value: {
      cancel: async () => {
        cancelled = true;
      },
    },
  });
  await assert.rejects(
    readResponseBytesCapped(declared, cap),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.equal(cancelled, true, 'the body is cancelled, not buffered');

  // Streamed oversize with no declared length: cancelled once past the cap.
  const chunk = new Uint8Array(64 * 1024);
  let pushed = 0;
  const streamed = new Response(
    new ReadableStream({
      pull(controller) {
        pushed += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  await assert.rejects(
    readResponseBytesCapped(streamed, cap),
    (error) => error.code === 'RESPONSE_TOO_LARGE',
  );
  assert.ok(
    pushed < cap * 4,
    `read stopped near the cap, not unbounded (pushed ${pushed})`,
  );

  // A body inside the cap still reads whole.
  const ok = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assert.equal((await readResponseBytesCapped(ok, cap)).byteLength, 4);
});

test('an empty upstream snapshot clears the board; a failed one does not', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A road warning that is taken down upstream must stop being displayed, and
  // an upstream outage must not take a live warning down. Both arrive at the
  // pack boundary as zero signs, so length alone cannot tell them apart.
  let round = 0;
  const pack = {
    name: 'fake',
    enabled: () => true,
    load: async () => {
      round += 1;
      if (round === 1) return [sign1('a')];
      if (round === 2) return [];
      throw new Error('upstream down');
    },
  };
  const cache = createSignsCache({ cacheMs: 0, packs: [pack] });

  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    ['a'],
    'the active sign is served',
  );
  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    [],
    'a successful empty refresh clears the retired sign',
  );
  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    [],
    'a failed refresh with nothing live keeps serving nothing',
  );
});

test('a failed refresh serves the last good list rather than clearing it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let round = 0;
  const pack = {
    name: 'fake',
    enabled: () => true,
    load: async () => {
      round += 1;
      if (round === 1) return [sign1('a')];
      throw new Error('upstream down');
    },
  };
  const cache = createSignsCache({ cacheMs: 0, packs: [pack] });
  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    ['a'],
  );
  assert.deepEqual(
    (await cache.getSigns()).map((s) => s.id),
    ['a'],
    'the prior snapshot survives an upstream failure',
  );
});

test('the pack reports failure and emptiness as different outcomes', async (t) => {
  t.mock.method(console, 'warn', () => {});
  // A valid response carrying no signs is a success, not a failure.
  const empty = await loadNe511Signs({
    fetchImpl: async () =>
      Response.json({
        data: { mapFeaturesQuery: { mapFeatures: [], error: null } },
      }),
  });
  assert.deepEqual(empty, [], 'an empty valid snapshot resolves');

  const failures = [
    async () => new Response('nope', { status: 503 }),
    async () => Response.json({ errors: [{ message: 'Server error.' }] }),
    async () =>
      Response.json({
        data: {
          mapFeaturesQuery: { mapFeatures: null, error: { message: 'bad' } },
        },
      }),
    async () => {
      throw new Error('network down');
    },
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(
      loadNe511Signs({ fetchImpl }),
      'a failure is distinguishable from an empty snapshot',
    );
  }
});
