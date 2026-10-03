import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutBoard,
  renderBoardCanvas,
} from '../layers/messageSigns/board.js';
import {
  normalizeSignRecord,
  currentPageIndex,
  signSummary,
  signMessageLines,
} from '../layers/messageSigns/model.js';
import { createMessageSignsSource } from '../layers/messageSigns/source.js';
import { faceBearingDeg } from '../layers/messageSigns/presentation.js';
import { SIGNS_URL, BOARD_WIDTH_M } from '../layers/messageSigns/policy.js';

const record = (overrides = {}) => ({
  id: 'ne511-sign-necarsxsigns*229',
  name: 'I-80: I-80 EB Mile 17.61',
  route: 'I-80',
  mileMarker: 17.61,
  lat: 41.20517,
  lon: -103.7205,
  headingDeg: 90,
  displayType: 'CMS',
  views: [
    {
      category: 'CMS',
      justification: 'CENTER',
      textLines: ['ROADWORK AHEAD', 'LEFT LANE CLOSED', 'KEEP RIGHT'],
      imageUrl: '',
    },
  ],
  ...overrides,
});

test('a board face is sized by whichever constraint binds first', () => {
  const three = layoutBoard(['AAA', 'BBB', 'CCC']);
  const one = layoutBoard(['AAA']);
  // Fewer lines means a taller font on the same board.
  assert.ok(one.fontPx > three.fontPx);

  // A long line is width-bound, so it shrinks below the 3-line height fit.
  const wide = layoutBoard(['X'.repeat(80)]);
  assert.ok(wide.fontPx < one.fontPx);

  // Whatever binds, the text must stay inside the face.
  for (const layout of [three, one, wide]) {
    const longest = Math.max(...layout.lines.map((l) => l.text.length));
    assert.ok(
      longest * layout.fontPx * 0.6 <= layout.width,
      'text overflows the board width',
    );
    const bottom = layout.lines.at(-1).y + layout.lineHeight / 2;
    assert.ok(bottom <= layout.height, 'text overflows the board height');
    assert.ok(layout.fontPx >= 8, 'font collapsed below legibility');
  }
});

test('justification places the anchor, and blank lines never render', () => {
  const left = layoutBoard(['A'], { justification: 'LEFT' });
  const center = layoutBoard(['A'], { justification: 'CENTER' });
  const right = layoutBoard(['A'], { justification: 'RIGHT' });
  assert.equal(left.textAlign, 'left');
  assert.equal(center.textAlign, 'center');
  assert.equal(right.textAlign, 'right');
  assert.ok(left.lines[0].x < center.lines[0].x);
  assert.ok(center.lines[0].x < right.lines[0].x);

  const empty = layoutBoard([]);
  assert.deepEqual(empty.lines, []);
  assert.equal(empty.fontPx, 0);
  // Still sized, so a blank board draws as an unlit face.
  assert.ok(empty.width > 0 && empty.height > 0);
});

test('the board renders through a canvas factory and fails soft without one', () => {
  const calls = [];
  const stubCanvas = {
    getContext: () => ({
      clearRect() {},
      fillRect() {},
      fillText: (text) => calls.push(text),
      set fillStyle(v) {},
      set font(v) {},
      set textAlign(v) {},
      set textBaseline(v) {},
      set shadowColor(v) {},
      set shadowBlur(v) {},
    }),
  };
  const canvas = renderBoardCanvas(['ROADWORK AHEAD', 'KEEP RIGHT'], {
    createCanvas: () => stubCanvas,
  });
  assert.equal(canvas, stubCanvas);
  assert.deepEqual(calls, ['ROADWORK AHEAD', 'KEEP RIGHT']);

  // No canvas or context returns null, not a throw.
  assert.equal(renderBoardCanvas(['X'], { createCanvas: () => null }), null);
  assert.equal(
    renderBoardCanvas(['X'], {
      createCanvas: () => ({ getContext: () => null }),
    }),
    null,
  );
});

test('a sign face looks BACK at the traffic it addresses', () => {
  // "I-80 EB" is eastbound (90°), approached from the west, so the face must
  // point west.
  assert.equal(faceBearingDeg(90), 270);
  assert.equal(faceBearingDeg(270), 90);
  assert.equal(faceBearingDeg(0), 180);
  assert.equal(faceBearingDeg(180), 0);
  // Wraps into range for any input.
  assert.ok(faceBearingDeg(-90) >= 0 && faceBearingDeg(-90) < 360);
});

test('client normalization rejects what the server should never send', () => {
  assert.ok(normalizeSignRecord(record()));
  assert.equal(normalizeSignRecord({ ...record(), id: '' }), null);
  assert.equal(normalizeSignRecord({ ...record(), lat: 'x' }), null);
  assert.equal(normalizeSignRecord({ ...record(), lat: 0, lon: 0 }), null);
  assert.equal(normalizeSignRecord({ ...record(), lat: 999 }), null);
  assert.equal(normalizeSignRecord({ ...record(), views: [] }), null);
  // A page with neither text nor image is not a page.
  assert.equal(
    normalizeSignRecord({
      ...record(),
      views: [{ textLines: [], imageUrl: '' }],
    }),
    null,
  );
  // Heading wraps into range.
  assert.equal(
    normalizeSignRecord({ ...record(), headingDeg: -90 }).headingDeg,
    270,
  );
  assert.equal(
    normalizeSignRecord({ ...record(), headingDeg: null }).headingDeg,
    null,
  );
});

test('a single-page board never cycles', () => {
  const one = normalizeSignRecord(record());
  // Pinned to page 0 regardless of the clock, so it is not redrawn.
  for (const now of [0, 1e6, 5e9]) assert.equal(currentPageIndex(one, now), 0);

  const two = normalizeSignRecord(
    record({
      views: [
        { textLines: ['PAGE ONE'], justification: 'CENTER' },
        { textLines: ['PAGE TWO'], justification: 'CENTER' },
      ],
    }),
  );
  assert.equal(currentPageIndex(two, 0, 4000), 0);
  assert.equal(currentPageIndex(two, 4000, 4000), 1);
  assert.equal(currentPageIndex(two, 8000, 4000), 0);
  // A nonsense clock or dwell falls back to the first page rather than NaN.
  assert.equal(currentPageIndex(two, NaN, 4000), 0);
  assert.equal(currentPageIndex(two, 1000, 0), 0);
});

test('summary and message lines read the way a person would say them', () => {
  const one = normalizeSignRecord(record());
  assert.equal(signSummary(one), 'I-80 · MM 17.61 · CMS');
  assert.deepEqual(signMessageLines(one), [
    'ROADWORK AHEAD',
    'LEFT LANE CLOSED',
    'KEEP RIGHT',
  ]);

  // Multi-page boards get page markers.
  const two = normalizeSignRecord(
    record({
      views: [
        { textLines: ['PAGE ONE'] },
        { textLines: [], imageUrl: 'https://x/y.png', category: 'VMS_IMAGE' },
      ],
    }),
  );
  const lines = signMessageLines(two);
  assert.equal(lines[0], '(1/2)');
  assert.ok(lines.includes('PAGE ONE'));
  assert.ok(lines.some((l) => l.includes('[image]')));
});

test('the source reads the app-origin route and dedupes', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    return Response.json({ signs: [record(), record()] });
  };
  const source = createMessageSignsSource({ fetchImpl });
  const { records } = await source.fetch();
  assert.deepEqual(seen, [SIGNS_URL]);
  assert.equal(records.length, 1, 'duplicate ids must collapse');
  assert.equal(source.attribution.name, 'Message signs');
});

test('the source throws on a refusal or a malformed body', async () => {
  const source = (fetchImpl) => createMessageSignsSource({ fetchImpl });
  await assert.rejects(
    source(async () => new Response('nope', { status: 503 })).fetch(),
    /temporarily unavailable/,
  );
  await assert.rejects(
    source(async () => new Response('nope', { status: 504 })).fetch(),
    /timed out/,
  );
  await assert.rejects(
    source(async () => Response.json({ nope: true })).fetch(),
    /incomplete/,
  );
});

test('board geometry constants stay coherent', () => {
  // A highway board is wider than it is tall.
  const layout = layoutBoard(['X']);
  assert.ok(layout.width > layout.height);
  assert.ok(BOARD_WIDTH_M > 0);
});

test('the layer names no agency: attribution rides on each record', async () => {
  // A second pack must be attributable without touching the layer, so nothing
  // here may hard-code one agency's name, error text or link.
  const generic = createMessageSignsSource();
  assert.equal(generic.attribution.href, undefined);
  for (const value of Object.values(generic.attribution))
    assert.doesNotMatch(String(value), /nebraska|ndot|511/i);
  assert.doesNotMatch(generic.label, /nebraska|ndot|511/i);

  // Upstream failures report the layer, not a particular agency.
  const rejects = async (status, re) => {
    const s = createMessageSignsSource({
      fetchImpl: async () => new Response('x', { status }),
    });
    await assert.rejects(s.fetch(), re);
  };
  await rejects(504, /^Error: Message signs timed out$/);
  await rejects(503, /^Error: Message signs temporarily unavailable$/);
  await assert.rejects(
    createMessageSignsSource({
      fetchImpl: async () => Response.json({ nope: true }),
    }).fetch(),
    /Message signs returned an incomplete response/,
  );
});

test('a record keeps the provider and licence its agency published', () => {
  const out = normalizeSignRecord({
    ...record(),
    provider: 'Nebraska 511',
    license: 'Nebraska 511 - Nebraska Department of Transportation',
  });
  assert.equal(out.provider, 'Nebraska 511');
  assert.match(out.license, /Department of Transportation/);
  // Absent fields degrade to empty strings rather than undefined.
  const bare = normalizeSignRecord(record());
  assert.equal(bare.provider, '');
  assert.equal(bare.license, '');
});
