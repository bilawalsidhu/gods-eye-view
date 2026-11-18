import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  gltfMeshMatrix,
  PART_HIDDEN,
  PART_HIGHLIGHT,
  partMatrices,
  partTableOf,
  readPartTable,
  asksHighlight,
} from './modelParts.js';

/** `m` (column-major 4×4 at `at`) times the point `p`. */
function apply(m, at, p) {
  const out = [0, 0, 0];
  for (let row = 0; row < 3; row++)
    out[row] =
      m[at + row] * p[0] +
      m[at + 4 + row] * p[1] +
      m[at + 8 + row] * p[2] +
      m[at + 12 + row];
  return out;
}

function close(actual, expected, digits = 6) {
  assert.equal(actual.length, expected.length);
  const tolerance = 10 ** -digits / 2;
  actual.forEach((value, i) =>
    assert.ok(
      Math.abs(value - expected[i]) <= tolerance,
      `[${i}] ${value} is not ${expected[i]}`,
    ),
  );
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A model in the glTF frame (nose −X, Y up, right −Z). */
const TABLE = partTableOf({
  parts: [
    { name: 'body', kind: 'body' },
    // Nose gear: stowed at 90, down at 0, turning about +Z through a point ahead and below.
    {
      name: 'gear_nose',
      kind: 'hinge',
      pivot: [-10, -1, 0],
      axis: [0, 0, 1],
      limits: [90, 0],
    },
    // A flap about the right axis (−Z), 0 to 40 degrees, drawn at 0.
    {
      name: 'flap',
      kind: 'hinge',
      pivot: [2, 0, -3],
      axis: [0, 0, -1],
      limits: [0, 40],
    },
    { name: 'engine', kind: 'marker', pivot: [0, -2, -5] },
    {
      name: 'fan',
      kind: 'spin',
      parent: 'engine',
      pivot: [-2, -2, -5],
      axis: [1, 0, 0],
    },
    {
      name: 'stage_1',
      kind: 'separable',
      pivot: [0, 40, 0],
      axis: [0, -1, 0],
      limits: [0, 30],
    },
    {
      name: 'leg_1',
      kind: 'hinge',
      parent: 'stage_1',
      pivot: [1, 1, 0],
      axis: [0, 0, -1],
      limits: [0, 110],
    },
    {
      name: 'door',
      kind: 'slide',
      pivot: [0, 0, 1],
      axis: [2, 0, 0],
      limits: [0, 1.5],
    },
    {
      name: 'panel',
      kind: 'deploy',
      pivot: [0, 0, 4],
      axis: [1, 0, 0],
      limits: [90, 0],
      rest: 0,
    },
  ],
});

function matrices(state, timeS = 0) {
  const out = new Float64Array(TABLE.parts.length * 16);
  const flags = new Uint8Array(TABLE.parts.length);
  const posed = partMatrices(TABLE, state, timeS, out, { flags });
  const at = (name) => TABLE.byName.get(name) * 16;
  return { out, flags, posed, at };
}

const slice = (out, at) => Array.from(out.subarray(at, at + 16));

describe('partTableOf', () => {
  test('reads a table with its defaults', () => {
    assert.deepEqual(
      TABLE.parts.map((p) => p.name),
      [
        'body',
        'gear_nose',
        'flap',
        'engine',
        'fan',
        'stage_1',
        'leg_1',
        'door',
        'panel',
      ],
    );
    const body = TABLE.parts[0];
    assert.equal(body.kind, 'body');
    assert.equal(body.parent, null);
    assert.equal(body.parentIndex, -1);
    assert.deepEqual(body.pivot, [0, 0, 0]);
    assert.equal(body.axis, null);
    assert.equal(body.limits, null);
    assert.equal(body.rest, null);
    // `rest` is the stowed limit unless given; `parent` is the body unless given.
    assert.equal(TABLE.parts[1].parent, 'body');
    assert.equal(TABLE.parts[1].parentIndex, 0);
    assert.equal(TABLE.parts[1].rest, 90);
    assert.deepEqual(TABLE.parts[8].limits, [90, 0]);
    assert.equal(TABLE.parts[8].rest, 0);
    assert.equal(TABLE.parts[4].parent, 'engine');
    assert.equal(TABLE.parts[4].parentIndex, 3);
    assert.equal(TABLE.parts[4].rest, null);
    // The axis is made unit length.
    assert.deepEqual(TABLE.parts[7].axis, [1, 0, 0]);
    assert.equal(TABLE.byName.get('leg_1'), 6);
  });

  test('a model without a table has none', () => {
    assert.equal(partTableOf(undefined), null);
    assert.equal(partTableOf({}), null);
    assert.equal(partTableOf({ other: 1 }), null);
  });

  const body = { name: 'body', kind: 'body' };
  for (const [extras, message] of [
    [{ parts: [] }, /list of parts/],
    [{ parts: [{ name: 'hull', kind: 'marker' }] }, /body/],
    [{ parts: [body, { name: 'x', kind: 'wobble' }] }, /kind wobble/],
    [{ parts: [body, { name: 'body', kind: 'marker' }] }, /twice/],
    [
      { parts: [body, { name: 'a', kind: 'marker', parent: 'b' }] },
      /not an earlier part/,
    ],
    [{ parts: [body, { name: 'a', kind: 'spin', axis: [0, 0] }] }, /axis/],
    [
      { parts: [body, { name: 'a', kind: 'spin', axis: [0, 0, 0] }] },
      /zero axis/,
    ],
    [{ parts: [body, { name: 'a', kind: 'hinge', limits: [0] }] }, /limits/],
  ])
    test(`refuses a malformed table (${message})`, () => {
      assert.throws(() => partTableOf(extras), message);
    });
});

/** A GLB of `json` and no binary chunk. */
function glb(json) {
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(20 + text.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  return out;
}

describe('readPartTable', () => {
  test('reads the table of the scene’s root node', () => {
    const extras = {
      parts: [
        { name: 'body', kind: 'body' },
        { name: 'radar', kind: 'spin' },
      ],
    };
    const bytes = glb({
      scene: 0,
      scenes: [{ nodes: [1] }],
      nodes: [
        { extras: { parts: [{ name: 'body', kind: 'body' }] } },
        { mesh: 0, extras },
      ],
    });
    assert.deepEqual(
      readPartTable(bytes).parts.map((p) => p.name),
      ['body', 'radar'],
    );
    assert.equal(readPartTable(bytes.buffer).parts.length, 2);
  });

  test('a model that is only its body has none', () => {
    assert.equal(
      readPartTable(glb({ scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }] })),
      null,
    );
  });

  test('refuses bytes that are not a GLB', () => {
    assert.throws(
      () => readPartTable(new TextEncoder().encode('glTF but not really')),
      /GLB/,
    );
  });
});

describe('gltfMeshMatrix', () => {
  test('the mesh node’s transform with its parents’', () => {
    const m = gltfMeshMatrix({
      scenes: [{ nodes: [0] }],
      nodes: [
        { translation: [1, 2, 3], children: [1] },
        // A packed model's dequantization: a scale and an offset.
        { mesh: 0, translation: [0, 2, 0], scale: [10, 10, 10] },
      ],
    });
    close(apply(m, 0, [1, 0, 0]), [11, 4, 3]);
    close(apply(m, 0, [0, -1, 0]), [1, -6, 3]);
  });

  test('turned by a node’s rotation', () => {
    // 90 degrees about +Y: +X turns to −Z.
    const s = Math.SQRT1_2;
    const m = gltfMeshMatrix({
      nodes: [{ mesh: 0, rotation: [0, s, 0, s] }],
    });
    close(apply(m, 0, [1, 0, 0]), [0, 0, -1]);
  });

  test('the identity without a mesh', () => {
    assert.deepEqual(gltfMeshMatrix({ nodes: [{}] }), IDENTITY);
  });
});

describe('partMatrices', () => {
  test('no state, or an empty one, leaves every part at rest', () => {
    for (const state of [null, {}, { poses: {}, spin: {}, deploy: {} }]) {
      const { out, flags, posed } = matrices(state);
      assert.equal(posed, false);
      for (let k = 0; k < TABLE.parts.length; k++)
        assert.deepEqual(slice(out, k * 16), IDENTITY);
      assert.deepEqual(
        Array.from(flags),
        new Array(TABLE.parts.length).fill(0),
      );
    }
  });

  test('a hinge turns about its pivot, off the origin', () => {
    // Deployed: from 90 (as drawn) to 0, so −90 degrees about +Z through [-10, -1, 0].
    const { out, at, posed } = matrices({ deploy: { gear_nose: 1 } });
    assert.equal(posed, true);
    close(apply(out, at('gear_nose'), [-10, -1, 0]), [-10, -1, 0]);
    // 2 m along −Y from the pivot turns to 2 m along −X.
    close(apply(out, at('gear_nose'), [-10, -3, 0]), [-12, -1, 0]);
    // Halfway is 45 degrees.
    const half = matrices({ deploy: { gear_nose: 0.5 } });
    const s = Math.SQRT1_2 * 2;
    close(apply(half.out, half.at('gear_nose'), [-10, -3, 0]), [
      -10 - s,
      -1 - s,
      0,
    ]);
    // Other parts stay at rest.
    assert.deepEqual(slice(out, at('flap')), IDENTITY);
  });

  test('a hinge’s pose is clamped to its limits, its swing left free', () => {
    // The flap's axis is the model's right, so pitch turns it: 0 to 40 degrees.
    const tip = [3, 0, -3];
    const turned = (deg) => [
      2 + Math.cos(deg * (Math.PI / 180)),
      // Nose up: what is behind the hinge goes down.
      -Math.sin(deg * (Math.PI / 180)),
      -3,
    ];
    for (const [pitch, expected] of [
      [25, 25],
      [60, 40],
      [-10, 0],
      [400, 40],
    ]) {
      const { out, at } = matrices({ poses: { flap: { pitchDeg: pitch } } });
      close(apply(out, at('flap'), tip), turned(expected));
    }
    // A roll is about the forward axis, not the hinge's: kept as posed.
    const rolled = matrices({ poses: { flap: { rollDeg: 90 } } });
    close(apply(rolled.out, rolled.at('flap'), [2, 1, -3]), [2, 0, -4]);
  });

  test('the deploy fraction is clamped to 0..1, and a pose adds to it within limits', () => {
    const over = matrices({ deploy: { gear_nose: 3 } });
    const full = matrices({ deploy: { gear_nose: 1 } });
    close(Array.from(over.out), Array.from(full.out));
    // The gear down (0) and pitched 30 more (−30 about its +Z axis): still
    // 0, its limit; pitched the other way, it comes 30 back up.
    const past = matrices({
      deploy: { gear_nose: 1 },
      poses: { gear_nose: { pitchDeg: 30 } },
    });
    close(Array.from(past.out), Array.from(full.out));
    const back = matrices({
      deploy: { gear_nose: 1 },
      poses: { gear_nose: { pitchDeg: -30 } },
    });
    const thirty = matrices({ deploy: { gear_nose: 1 - 30 / 90 } });
    close(Array.from(back.out), Array.from(thirty.out));
    // A deploy part drawn deployed (rest 0) stows to 90 about +X.
    const stowed = matrices({ deploy: { panel: 0 } });
    close(apply(stowed.out, stowed.at('panel'), [0, 1, 4]), [0, 0, 5]);
  });

  test('a child part rides its parent', () => {
    // The engine moved 1 m up: its fan, at rest about its own hub, moves with it.
    const { out, at } = matrices({ poses: { engine: { offsetM: [0, 0, 1] } } });
    close(apply(out, at('engine'), [0, -2, -5]), [0, -1, -5]);
    close(apply(out, at('fan'), [-2, -2, -5]), [-2, -1, -5]);
    // Spinning too: the hub stays on the moved axis, a blade tip turns about it.
    const spun = matrices(
      { poses: { engine: { offsetM: [0, 0, 1] } }, spin: { fan: 90 } },
      1,
    );
    close(apply(spun.out, spun.at('fan'), [-2, -2, -5]), [-2, -1, -5]);
    // +90 about +X: +Y turns to +Z.
    close(apply(spun.out, spun.at('fan'), [-2, -1, -5]), [-2, -1, -4]);
  });

  test('a child hinge turns about its pivot as carried by its parent', () => {
    const { out, at } = matrices({ deploy: { stage_1: 1, leg_1: 1 } });
    // The stage leaves 30 m along −Y; the leg's hinge goes with it and turns 110 about −Z there.
    close(apply(out, at('leg_1'), [1, 1, 0]), [1, -29, 0]);
    const deg = 110 * (Math.PI / 180);
    close(apply(out, at('leg_1'), [1, 2, 0]), [
      1 + Math.sin(deg),
      -29 + Math.cos(deg),
      0,
    ]);
  });

  test('a spin turns at its rate over time', () => {
    const tip = [-2, -1, -5];
    const at = (timeS) => {
      const m = matrices({ spin: { fan: 90 } }, timeS);
      return apply(m.out, m.at('fan'), tip);
    };
    close(at(0), tip);
    close(at(1), [-2, -2, -4]);
    close(at(2), [-2, -3, -5]);
    close(at(4), tip);
    // A rate times an epoch clock still lands where it should.
    close(at(1_700_000_000), tip, 4);
    close(at(1_700_000_001), [-2, -2, -4], 4);
    // A spin driving a part with no axis does nothing.
    assert.equal(matrices({ spin: { engine: 90 } }, 1).posed, false);
  });

  test('a separable part moves freely: its limits bound only the deploy fraction', () => {
    const half = matrices({ deploy: { stage_1: 0.5 } });
    close(apply(half.out, half.at('stage_1'), [0, 40, 0]), [0, 25, 0]);
    // Posed 500 m right and turned, past any limit (right is −Z).
    const { out, at } = matrices({
      poses: { stage_1: { offsetM: [500, 0, -200], yawDeg: 30 } },
    });
    close(apply(out, at('stage_1'), [0, 40, 0]), [0, -160, -500]);
  });

  test('a slide is clamped along its axis, free across it', () => {
    // The door slides along +X (the model's back) 0 to 1.5 m; offsetM is [right, forward, up].
    const back = (metres) =>
      matrices({ poses: { door: { offsetM: [0, -metres, 0] } } });
    close(apply(back(1).out, back(1).at('door'), [0, 0, 1]), [1, 0, 1]);
    close(apply(back(9).out, back(9).at('door'), [0, 0, 1]), [1.5, 0, 1]);
    close(apply(back(-2).out, back(-2).at('door'), [0, 0, 1]), [0, 0, 1]);
    const up = matrices({ poses: { door: { offsetM: [0, -9, 2] } } });
    close(apply(up.out, up.at('door'), [0, 0, 1]), [1.5, 2, 1]);
  });

  test('hidden hides the part and every part riding it', () => {
    const { out, flags, at, posed } = matrices({
      poses: { engine: { hidden: true } },
    });
    assert.equal(posed, true);
    assert.deepEqual(slice(out, at('engine')), new Array(16).fill(0));
    assert.deepEqual(slice(out, at('fan')), new Array(16).fill(0));
    assert.equal(flags[TABLE.byName.get('engine')], PART_HIDDEN);
    assert.equal(flags[TABLE.byName.get('fan')], PART_HIDDEN);
    assert.equal(flags[TABLE.byName.get('flap')], 0);
    assert.deepEqual(slice(out, at('flap')), IDENTITY);
  });

  test('highlight marks the part alone, and does not move it', () => {
    const { out, flags, posed } = matrices({
      poses: { engine: { highlight: '#ff0' } },
    });
    assert.equal(posed, true);
    assert.equal(flags[TABLE.byName.get('engine')], PART_HIGHLIGHT);
    assert.equal(flags[TABLE.byName.get('fan')], 0);
    for (let k = 0; k < TABLE.parts.length; k++)
      assert.deepEqual(slice(out, k * 16), IDENTITY);
    assert.equal(
      matrices({ poses: { engine: { highlight: false } } }).posed,
      false,
    );
  });

  test('a highlight is true or a colour; anything else asks for none', () => {
    for (const value of [true, '#ff0', 'red', [1, 0.5, 0], [1, 0, 0, 0.5]])
      assert.equal(asksHighlight(value), true, String(value));
    for (const value of [
      false,
      '',
      '  ',
      0,
      1,
      null,
      undefined,
      {},
      [1, 0],
      [1, 'x', 0],
      [NaN, 0, 0],
    ])
      assert.equal(asksHighlight(value), false, String(value));
    assert.equal(
      matrices({ poses: { engine: { highlight: '' } } }).posed,
      false,
    );
    assert.equal(
      matrices({ poses: { engine: { highlight: 0 } } }).posed,
      false,
    );
  });

  test('a pose value that is not finite counts as 0', () => {
    const { out, posed } = matrices({
      poses: {
        engine: {
          yawDeg: NaN,
          pitchDeg: Infinity,
          rollDeg: -Infinity,
          offsetM: [NaN, Infinity, undefined],
        },
      },
    });
    assert.equal(posed, false);
    for (let k = 0; k < TABLE.parts.length; k++)
      assert.deepEqual(slice(out, k * 16), IDENTITY);
    // Beside a finite one, it is still 0 and no NaN is written.
    const mixed = matrices({
      poses: { engine: { yawDeg: 90, pitchDeg: NaN, offsetM: [NaN, 0, 1] } },
    });
    assert.equal(mixed.posed, true);
    assert.ok(mixed.out.every(Number.isFinite));
  });

  test('names the table does not have are ignored', () => {
    const { posed } = matrices({
      poses: { rotor_main: { yawDeg: 30, hidden: true } },
      spin: { rotor_main: 100 },
      deploy: { gear_main: 1 },
    });
    assert.equal(posed, false);
  });

  test('writes from an offset, into float32', () => {
    const out = new Float32Array(16 + TABLE.parts.length * 16).fill(7);
    const flags = new Uint8Array(3 + TABLE.parts.length).fill(9);
    partMatrices(TABLE, { poses: { flap: { hidden: true } } }, 0, out, {
      offset: 16,
      flags,
      flagsOffset: 3,
    });
    assert.deepEqual(Array.from(out.subarray(0, 16)), new Array(16).fill(7));
    assert.deepEqual(Array.from(out.subarray(16, 32)), IDENTITY);
    assert.deepEqual(Array.from(flags.subarray(0, 3)), [9, 9, 9]);
    assert.equal(flags[3 + TABLE.byName.get('flap')], PART_HIDDEN);
  });
});

describe('partMatrices on a stretched model', () => {
  /** Where `p` is drawn by a model stretched `scale` whose part is `out`'s matrix at `at`: S · X · p. */
  const drawnAt = (out, at, scale, p) => {
    const x = apply(out, at, p);
    return [x[0] * scale[0], x[1] * scale[1], x[2] * scale[2]];
  };
  const RADAR = partTableOf({
    parts: [
      { name: 'body', kind: 'body' },
      { name: 'radar', kind: 'spin', pivot: [5, 3, 0], axis: [0, 1, 0] },
    ],
  });
  const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  test('a radar on a hull drawn twice its length keeps its length at every angle', () => {
    const scale = [2, 1, 1];
    const hub = [5, 3, 0];
    const tip = [6, 3, 0];
    const state = { spin: { radar: 30 } };
    for (let timeS = 0; timeS < 12; timeS++) {
      const out = new Float64Array(32);
      partMatrices(RADAR, state, timeS, out, { scale });
      const h = drawnAt(out, 16, scale, hub);
      const t = drawnAt(out, 16, scale, tip);
      // The hub stays where the stretched hull draws it; the 1 m arm is drawn 2 m long.
      close(h, [10, 3, 0]);
      assert.ok(Math.abs(length(t, h) - 2) < 1e-9);
    }
    // Unscaled matrices under the same stretch distort it: 1 m long across the hull.
    const naive = new Float64Array(32);
    partMatrices(RADAR, state, 3, naive);
    const h = drawnAt(naive, 16, scale, hub);
    const t = drawnAt(naive, 16, scale, tip);
    assert.ok(Math.abs(length(t, h) - 1) < 1e-9);
  });

  test('a hinge turns rigidly about its stretched pivot', () => {
    const scale = [1, 3, 1];
    const out = new Float64Array(TABLE.parts.length * 16);
    partMatrices(TABLE, { deploy: { gear_nose: 1 } }, 0, out, { scale });
    const at = TABLE.byName.get('gear_nose') * 16;
    close(drawnAt(out, at, scale, [-10, -1, 0]), [-10, -3, 0]);
    close(drawnAt(out, at, scale, [-10, -3, 0]), [-16, -3, 0]);
  });

  test('a slide keeps its limits in the model’s own metres', () => {
    const scale = [2, 1, 1];
    const out = new Float64Array(TABLE.parts.length * 16);
    // Offsets are stretched with the model: 9 m back asked, 1.5 m allowed, drawn 3 m.
    partMatrices(TABLE, { poses: { door: { offsetM: [0, -9, 0] } } }, 0, out, {
      scale,
    });
    close(
      drawnAt(out, TABLE.byName.get('door') * 16, scale, [0, 0, 1]),
      [3, 0, 1],
    );
  });

  test('a scale of one, or none, writes the same matrices', () => {
    const state = {
      deploy: { gear_nose: 0.3, stage_1: 1, leg_1: 0.5 },
      spin: { fan: 33 },
      poses: { engine: { offsetM: [1, 2, 3], yawDeg: 10 } },
    };
    const a = new Float64Array(TABLE.parts.length * 16);
    const b = new Float64Array(TABLE.parts.length * 16);
    partMatrices(TABLE, state, 1.5, a);
    partMatrices(TABLE, state, 1.5, b, { scale: [1, 1, 1] });
    assert.deepEqual(Array.from(b), Array.from(a));
  });
});
