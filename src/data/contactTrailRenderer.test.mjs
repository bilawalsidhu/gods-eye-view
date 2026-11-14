import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import {
  createContactTrailRenderer,
  trailAlpha,
} from './contactTrailRenderer.js';

const GREEN = [0x5e / 255, 0xf0 / 255, 0x8a / 255];
const DARK = [0.02, 0.03, 0.05];

function viewerWithDraw(t) {
  const viewer = { isDestroyed: () => false };
  const { draw, unbind } = bindFakeDraw(viewer);
  t.after(unbind);
  return { viewer, draw };
}

const point = (i) => ({ x: 1000 * i, y: 2000, z: 3000 });
function history(revision = 1) {
  return {
    revision,
    segments: [
      {
        fromSeq: 0,
        toSeq: 1,
        fromT: 0,
        toT: 10000,
        positions: [point(0), point(1)],
      },
      {
        fromSeq: 0,
        toSeq: 1,
        fromT: 10000,
        toT: 20000,
        positions: [point(1), point(2)],
      },
    ],
  };
}

/** The trail's live set whose id ends with `suffix`. */
const setOf = (draw, suffix) =>
  [...draw.sets.values()].find(
    (set) => !set.disposed && set.spec.id.endsWith(suffix),
  );

const close = (actual, expected) =>
  actual.every((value, i) => Math.abs(value - expected[i]) < 1e-9);

test('the body is two draped lanes whose passed segments show, faded by age', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  renderer.replaceHistory(history());
  const body = setOf(draw, ':body');
  assert.equal(body.spec.pickable, false);
  const lines = [...body.items.values()];
  // One run (the segments join): a backing lane under the mode colour.
  assert.deepEqual(
    lines.map((line) => [line.id, line.widthPx, line.mode, line.clampTo]),
    [
      ['backing:0', 5, 'draped', 'both'],
      ['line:0', 3, 'draped', 'both'],
    ],
  );
  assert.deepEqual(lines[0].positions, [point(0), point(1), point(2)]);
  assert.deepEqual(lines[0].segmentShow, [false, false], 'none passed yet');

  const marker = { x: 1500, y: 2000, z: 3000 };
  const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
  renderer.setDisplaySample(sample, marker);
  const [backing, line] = body.items.values();
  assert.deepEqual(line.segmentShow, [true, false], 'the future is clipped');
  assert.deepEqual(backing.segmentShow, [true, false]);
  assert.ok(close(line.segmentColors[0], [...GREEN, trailAlpha(5000)]));
  assert.ok(close(backing.segmentColors[0], [...DARK, trailAlpha(5000)]));

  // Within the second, nothing is written again; a rewind hides again.
  const writes = body.writes;
  for (let i = 0; i < 60; i++) renderer.setDisplaySample(sample, marker);
  assert.equal(body.writes, writes);
  renderer.setDisplaySample(
    { ...sample, displayT: 5000, fraction: 0.25 },
    point(0),
  );
  assert.deepEqual(
    body.items.get('line:0').segmentShow,
    [false, false],
    'rewind hides future geometry again',
  );
  assert.equal(renderer.diagnostics().rebuilds, 1);
  renderer.destroy();
  assert.equal(body.disposed, true);
});

test('the head is revealed to the vehicle and drawn anew only at a crossing', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  renderer.replaceHistory(history());
  const head = renderer.diagnostics().headLines;
  const record = setOf(draw, ':head');
  assert.equal(record.spec.pickable, false);
  const marker = { x: 1500, y: 2000, z: 3000 };
  const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
  for (let i = 0; i < 120; i++) renderer.setDisplaySample(sample, marker);
  assert.equal(head.show, true);
  // One line, its dark edge in the same pass: lanes stacked would darken
  // its centre where their translucent passes overlap.
  const lines = [...record.items.values()];
  assert.deepEqual(
    lines.map((line) => [line.id, line.widthPx, line.revealFraction]),
    [['head', 5, 0.5]],
  );
  assert.deepEqual(lines[0].positions, [point(1), point(2)]);
  assert.ok(close(lines[0].style.color, [...GREEN, 0.8]));
  assert.ok(close(lines[0].style.outline.color, [...DARK, 0.8]));
  assert.equal(lines[0].style.outline.widthPx, 2);
  const result = renderer.diagnostics();
  assert.equal(result.headRebuilds, 1, '120 frames retain head geometry');
  assert.equal(result.entitiesAdded, 0);
  assert.equal(result.ground, true);
  assert.deepEqual(result.head.positions, [point(1), marker]);
  assert.equal(result.head.width, 3);
  assert.equal(result.backing.width, 5);

  // A frame further along writes only how far it is revealed.
  renderer.setDisplaySample({ ...sample, displayT: 17500 }, marker);
  assert.equal(record.items.get('head').revealFraction, 0.75);
  assert.equal(renderer.diagnostics().headRebuilds, 1);
  // The next subdivision, or the end of the leg, hides it.
  renderer.setDisplaySample({ ...sample, fraction: 1 }, marker);
  assert.equal(head.show, false);
  renderer.setVisible(false);
  renderer.setDisplaySample(sample, marker);
  assert.equal(head.show, false, 'hidden with the trail');
  assert.equal(result.body.show, false);
});

test('a new mode colour is written into the segments, never rebuilding the body', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  renderer.replaceHistory(history());
  const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
  renderer.setDisplaySample(sample, point(1));
  const body = setOf(draw, ':body');
  const look = body.items.get('line:0').style;
  renderer.setStyle('#FFFFFF');
  renderer.setDisplaySample(sample, point(1));
  const line = body.items.get('line:0');
  assert.deepEqual(line.style, look, 'the line itself is unchanged');
  assert.ok(close(line.segmentColors[0], [1, 1, 1, trailAlpha(5000)]));
  assert.equal(renderer.diagnostics().rebuilds, 1);
  assert.equal(renderer.diagnostics().headRebuilds, 1, 'no crossing');
  const headLine = setOf(draw, ':head').items.get('head');
  assert.ok(close(headLine.style.color, [1, 1, 1, 0.8]), 'and the head');
});

test('separate runs of the history are separate lines', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  const { segments } = history();
  segments[1] = { ...segments[1], positions: [point(5), point(6)] };
  renderer.replaceHistory({ revision: 2, segments });
  assert.deepEqual(
    [...setOf(draw, ':body').items.keys()],
    ['backing:0', 'backing:1', 'line:0', 'line:1'],
  );
  renderer.replaceHistory({ revision: 3, segments: [] });
  assert.equal(setOf(draw, ':body').items.size, 0);
});

test('a viewer with nothing to draw with draws no trail', () => {
  const renderer = createContactTrailRenderer({ isDestroyed: () => false });
  assert.doesNotThrow(() => {
    renderer.replaceHistory(history());
    renderer.setDisplaySample(
      { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 },
      point(1),
    );
  });
  assert.equal(renderer.diagnostics().ground, false);
  renderer.destroy();
});

test('playback across a crossing redraws the head once and shows the passed segment', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  renderer.replaceHistory({
    revision: 1,
    segments: history().segments.map((segment) => ({ ...segment, toSeq: 2 })),
  });
  const body = setOf(draw, ':body'),
    head = setOf(draw, ':head');
  // 60 fps through both subdivisions of one leg.
  for (let t = 0; t < 20000; t += 16)
    renderer.setDisplaySample(
      { displayT: t, fromSeq: 0, toSeq: 2, fraction: t / 20000 },
      point(t / 10000),
    );
  assert.equal(renderer.diagnostics().headRebuilds, 2, 'one per subdivision');
  assert.deepEqual(body.items.get('line:0').segmentShow, [true, false]);
  assert.deepEqual(head.items.get('head').positions, [point(1), point(2)]);
  assert.ok(head.items.get('head').revealFraction > 0.99);
  // Body writes: one a second, and one at the crossing at most.
  assert.ok(body.writes <= 1 + 20 + 1, `${body.writes} body writes`);
});

test('the head hides off its leg and with no sample, and shows again', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  renderer.replaceHistory(history());
  const head = renderer.diagnostics().headLines;
  const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
  renderer.setDisplaySample({ ...sample, toSeq: 9 }, point(1));
  assert.equal(head.show, false, 'another leg');
  renderer.setDisplaySample(sample, point(1));
  assert.equal(head.show, true);
  renderer.setDisplaySample(null, null);
  assert.equal(head.show, false, 'no sample');
  renderer.setVisible(false);
  renderer.setVisible(true);
  renderer.setDisplaySample(sample, point(1));
  assert.equal(head.show, true, 'shown again with the trail');
  assert.equal(renderer.diagnostics().body.show, true);
  const sets = [setOf(draw, ':body'), setOf(draw, ':head')];
  renderer.destroy();
  assert.ok(
    sets.every((set) => set.disposed),
    'both sets disposed',
  );
});

test('a segment with no length ends a run and later ones keep their times', (t) => {
  const { viewer, draw } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  const { segments } = history();
  segments.splice(1, 0, {
    fromSeq: 0,
    toSeq: 1,
    fromT: 10000,
    toT: 10000,
    positions: [],
  });
  segments[2] = { ...segments[2], fromT: 10000, toT: 20000 };
  renderer.replaceHistory({ revision: 1, segments });
  renderer.setDisplaySample(
    { displayT: 25000, fromSeq: 0, toSeq: 1, fraction: 1 },
    point(2),
  );
  const body = setOf(draw, ':body');
  assert.deepEqual(
    [...body.items.keys()],
    ['backing:0', 'backing:1', 'line:0', 'line:1'],
  );
  const later = body.items.get('line:1');
  assert.deepEqual(later.positions, [point(1), point(2)]);
  assert.deepEqual(later.segmentShow, [true]);
  assert.ok(close(later.segmentColors[0], [...GREEN, trailAlpha(5000)]));
});

test('frames that change nothing write no show', (t) => {
  const { viewer } = viewerWithDraw(t);
  const renderer = createContactTrailRenderer(viewer);
  renderer.replaceHistory(history());
  const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
  renderer.setVisible(true);
  renderer.setDisplaySample(sample, point(1));
  const { body, headLines } = renderer.diagnostics();
  let writes = 0;
  for (const set of [body, headLines]) {
    let show = set.show;
    Object.defineProperty(set, 'show', {
      get: () => show,
      set(value) {
        writes++;
        show = value;
      },
    });
  }
  for (let i = 0; i < 30; i++) {
    renderer.setVisible(true);
    renderer.setDisplaySample(sample, point(1));
  }
  assert.equal(writes, 0, 'a renderer may redraw for each show written');
});

test('trail age curve uses the specified four alpha anchors', () => {
  assert.equal(trailAlpha(0), 0.8);
  assert.equal(trailAlpha(120000), 0.45);
  assert.equal(trailAlpha(600000), 0.2);
  assert.equal(trailAlpha(900000), 0.08);
  assert.ok(Math.abs(trailAlpha(60000) - 0.625) < 1e-10);
});
