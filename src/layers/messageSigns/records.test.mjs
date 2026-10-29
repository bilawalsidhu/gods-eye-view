import test from 'node:test';
import assert from 'node:assert/strict';
import { joinMessageSigns } from './records.js';

const TRAVEL_TIME = 'FREEWAY TIME TO[nl][jl2]I-394 7 MI[jl4]10 MIN';

function feeds(overrides = {}) {
  return {
    signs: [
      {
        name: 'V100N01',
        sign_config: 'sc_270x56_1',
        roadway: 'T.H.100',
        road_dir: 'NB',
        location: 'T.H.100 NB @ 50th St',
        lat: 44.912,
        lon: -93.349,
      },
      {
        name: 'V35WN06',
        sign_config: 'sc_592x96_1',
        location: 'I-35W NB @ 40th St',
        lat: 44.929,
        lon: -93.273,
      },
      ...(overrides.extraSigns ?? []),
    ],
    states: [
      { name: 'V100N01', msg_current: 'msg_AE72DF0B', failed: false },
      { name: 'V35WN06', msg_current: 'msg_DF994F5B', failed: false },
      ...(overrides.extraStates ?? []),
    ],
    messages: [
      { name: 'msg_AE72DF0B', multi: TRAVEL_TIME },
      { name: 'msg_DF994F5B', multi: 'EXPRESS LANE[nl]HOV 2+ FREE' },
      ...(overrides.extraMessages ?? []),
    ],
  };
}

test('the three feeds join into one row per lit sign', () => {
  const { signs, joinMisses } = joinMessageSigns(feeds());
  assert.equal(joinMisses, 0);
  assert.deepEqual(signs[0], {
    id: 'V100N01',
    provider: 'mndot',
    lat: 44.912,
    lon: -93.349,
    location: 'T.H.100 NB @ 50th St',
    message: 'msg_AE72DF0B',
    multi: TRAVEL_TIME,
  });
  assert.deepEqual(
    signs.map((sign) => sign.id),
    ['V100N01', 'V35WN06'],
  );
});

test('blank, failed, missing and unjoined signs are dropped', () => {
  const { signs, joinMisses } = joinMessageSigns(
    feeds({
      extraSigns: ['VBLANK', 'VFAILED', 'VNOSTATE', 'VMISS', 'VNOFLAG'].map(
        (name, i) => ({
          name,
          location: name,
          lat: 44.9 + i / 100,
          lon: -93.2,
        }),
      ),
      extraStates: [
        { name: 'VBLANK', msg_current: 'msg_00000001', failed: false },
        { name: 'VFAILED', msg_current: 'msg_AE72DF0B', failed: true },
        { name: 'VMISS', msg_current: 'msg_0000FFFF', failed: false },
        { name: 'VNOFLAG', msg_current: 'msg_AE72DF0B' },
      ],
      extraMessages: [{ name: 'msg_00000001', multi: '[jl3][nl][pt10o]' }],
    }),
  );
  assert.deepEqual(
    signs.map((sign) => sign.id),
    ['V100N01', 'V35WN06'],
  );
  assert.equal(joinMisses, 1);
});

test('a graphic-only message is lit', () => {
  const { signs } = joinMessageSigns(
    feeds({
      extraSigns: [
        { name: 'V94W10A', location: 'I-94 WB', lat: 44.95, lon: -93.1 },
      ],
      extraStates: [
        { name: 'V94W10A', msg_current: 'sys_0C3FCDE3', failed: false },
      ],
      extraMessages: [{ name: 'sys_0C3FCDE3', multi: '[g1,8,1]' }],
    }),
  );
  assert.ok(signs.some((sign) => sign.id === 'V94W10A'));
});

test('coordinates outside Minnesota or not numbers are dropped', () => {
  const bad = [
    { name: 'VNOLAT', location: 'x', lon: -93.2 },
    { name: 'VSTRING', location: 'x', lat: '44.9', lon: '-93.2' },
    { name: 'VIOWA', location: 'x', lat: 41.6, lon: -93.6 },
    { name: 'VNAN', location: 'x', lat: Number.NaN, lon: -93.2 },
  ];
  const { signs } = joinMessageSigns(
    feeds({
      extraSigns: bad,
      extraStates: bad.map(({ name }) => ({
        name,
        msg_current: 'msg_AE72DF0B',
        failed: false,
      })),
    }),
  );
  assert.equal(signs.length, 2);
});

test('location text is cleaned and bounded', () => {
  const { signs } = joinMessageSigns(
    feeds({
      extraSigns: [
        {
          name: 'VTEXT',
          location: '  I-94\u0000EB\n@   Benesch\u202e  ',
          lat: 44.95,
          lon: -93.1,
        },
        { name: 'VLONG', location: 'X'.repeat(500), lat: 44.95, lon: -93.1 },
        { name: 'VNONE', lat: 44.95, lon: -93.1 },
      ],
      extraStates: ['VTEXT', 'VLONG', 'VNONE'].map((name) => ({
        name,
        msg_current: 'msg_AE72DF0B',
        failed: false,
      })),
    }),
  );
  const byId = new Map(signs.map((sign) => [sign.id, sign]));
  assert.equal(byId.get('VTEXT').location, 'I-94 EB @ Benesch');
  assert.equal(byId.get('VLONG').location.length, 120);
  assert.equal(byId.get('VNONE').location, 'VNONE');
});

test('malformed names drop the sign, long MULTI is truncated, not dropped', () => {
  const { signs } = joinMessageSigns(
    feeds({
      extraSigns: [
        { name: 'BAD NAME!', location: 'x', lat: 44.95, lon: -93.1 },
        { name: 'VBADMSG', location: 'x', lat: 44.95, lon: -93.1 },
        { name: 'VHUGE', location: 'x', lat: 44.95, lon: -93.1 },
      ],
      extraStates: [
        { name: 'BAD NAME!', msg_current: 'msg_AE72DF0B', failed: false },
        { name: 'VBADMSG', msg_current: '../../etc', failed: false },
        { name: 'VHUGE', msg_current: 'msg_ABCDEF12', failed: false },
      ],
      extraMessages: [{ name: 'msg_ABCDEF12', multi: 'A'.repeat(5000) }],
    }),
  );
  const ids = signs.map((sign) => sign.id);
  assert.ok(!ids.includes('BAD NAME!'));
  assert.ok(!ids.includes('VBADMSG'));
  assert.equal(signs.find((sign) => sign.id === 'VHUGE').multi.length, 4096);
});

test('duplicate sign names keep the first row', () => {
  const { signs } = joinMessageSigns(
    feeds({
      extraSigns: [
        { name: 'V100N01', location: 'second', lat: 44.95, lon: -93.1 },
      ],
      extraStates: [
        { name: 'V100N01', msg_current: 'msg_DF994F5B', failed: false },
      ],
    }),
  );
  const rows = signs.filter((sign) => sign.id === 'V100N01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location, 'T.H.100 NB @ 50th St');
  assert.equal(rows[0].message, 'msg_AE72DF0B');
});

test('a feed that is not an array fails closed; empty feeds do not', () => {
  for (const key of ['signs', 'states', 'messages']) {
    assert.throws(
      () => joinMessageSigns({ ...feeds(), [key]: { rows: [] } }),
      /^Error: Malformed message signs response$/,
    );
  }
  assert.deepEqual(joinMessageSigns({ signs: [], states: [], messages: [] }), {
    signs: [],
    joinMisses: 0,
  });
});
