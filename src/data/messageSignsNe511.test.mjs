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
} from '../../server/providers/messageSigns.js';

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

test('the fetch fails soft on transport, GraphQL and query errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const cases = [
    async () => new Response('nope', { status: 503 }),
    async () => Response.json({ errors: [{ message: 'Server error.' }] }),
    async () =>
      Response.json({
        data: {
          mapFeaturesQuery: {
            mapFeatures: null,
            error: { message: 'bad bbox' },
          },
        },
      }),
    async () => {
      throw new Error('network down');
    },
  ];
  for (const fetchImpl of cases) {
    assert.deepEqual(await loadNe511Signs({ fetchImpl }), []);
  }
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
  const merged = await loadAllSigns({ packs: [ok, boom, off] });
  assert.deepEqual(
    merged.map((s) => s.id),
    ['a'],
  );

  // Duplicate ids across packs collapse.
  const dup = {
    name: 'dup',
    enabled: () => true,
    load: async () => [sign1('a')],
  };
  assert.equal((await loadAllSigns({ packs: [ok, dup] })).length, 1);
});
