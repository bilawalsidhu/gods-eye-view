import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aircraftViewRef,
  isAircraftViewRef,
  registerAircraftViews,
  VIEW_SHEETS_CAPABILITY,
  withAircraftView,
} from './aircraftViews.js';
import { AIRCRAFT_VIEWS } from './viewSheet.js';
import { ROTOR_FRAMES, ROTOR_STILL_FRAME } from './rotorFrames.js';
import { aircraftIcon, FLEET_ICON_PX } from './aircraftIcons.js';

const STILL_KINDS = [
  'airliner',
  'widebody',
  'quadjet',
  'turboprop',
  'light',
  'glider',
  'fastjet',
  'bizjet',
  'uav',
];

test('every aircraft class draws its own block of the view sheet', () => {
  for (const kind of STILL_KINDS)
    assert.deepEqual(
      aircraftViewRef(kind),
      {
        views: AIRCRAFT_VIEWS.id,
        first: AIRCRAFT_VIEWS.subjects[kind],
        fallback: aircraftIcon(kind, FLEET_ICON_PX),
      },
      kind,
    );
  const firsts = STILL_KINDS.map((kind) => aircraftViewRef(kind).first);
  assert.equal(
    new Set(firsts).size,
    STILL_KINDS.length,
    'no two share a block',
  );
  assert.equal(
    aircraftViewRef('airliner'),
    aircraftViewRef('airliner'),
    'one ref per block, so an unchanged image writes nothing',
  );
  assert.ok(Object.isFrozen(aircraftViewRef('airliner')));
});

test('a helicopter draws the block of its rotor frame, the still frame by default', () => {
  assert.equal(ROTOR_FRAMES, 3);
  for (let frame = 0; frame < ROTOR_FRAMES; frame++) {
    const ref = aircraftViewRef('helicopter', frame);
    assert.equal(
      ref.first,
      AIRCRAFT_VIEWS.subjects[`helicopter${frame}`],
      `frame ${frame}`,
    );
    assert.equal(
      ref.fallback,
      aircraftIcon('helicopter', FLEET_ICON_PX, frame),
      `its fallback is the glyph of rotor frame ${frame}`,
    );
  }
  assert.equal(
    aircraftViewRef('helicopter').fallback,
    aircraftIcon('helicopter', FLEET_ICON_PX, ROTOR_STILL_FRAME),
  );
  const still = AIRCRAFT_VIEWS.subjects[`helicopter${ROTOR_STILL_FRAME}`];
  for (const frame of [undefined, -1, 3, 1.5, NaN])
    assert.equal(aircraftViewRef('helicopter', frame).first, still, `${frame}`);
});

test('the TR-3B, airport vehicles, ground stations and unknown kinds have no views', () => {
  for (const kind of [
    'tr3b',
    'tr3bHot',
    'vehicle',
    'station',
    'jet',
    '',
    undefined,
  ])
    assert.equal(aircraftViewRef(kind), null, String(kind));
  assert.equal(
    aircraftViewRef('airliner', 1).first,
    0,
    'a frame means nothing to a fixed wing',
  );
});

test('a view ref is told apart from flat images', () => {
  assert.equal(isAircraftViewRef(aircraftViewRef('glider')), true);
  for (const image of [
    'data:image/svg+xml;base64,AAA',
    null,
    undefined,
    { atlas: 'a', slot: 's' },
  ])
    assert.equal(isAircraftViewRef(image), false, String(image));
});

test('the sheet is registered once per draw port, only with the capability', () => {
  const calls = [];
  const port = { views: (id, sheet) => calls.push([id, sheet]) };
  const caps = new Set([VIEW_SHEETS_CAPABILITY]);
  assert.equal(VIEW_SHEETS_CAPABILITY, 'viewSheets');
  assert.equal(registerAircraftViews(port, new Set()), false);
  assert.equal(registerAircraftViews(port, null), false);
  assert.equal(calls.length, 0, 'nothing registered without the capability');
  assert.equal(registerAircraftViews(port, caps), true);
  assert.equal(registerAircraftViews(port, caps), true);
  assert.deepEqual(calls, [[AIRCRAFT_VIEWS.id, AIRCRAFT_VIEWS.sheet]]);
  const other = { views: (id) => calls.push([id]) };
  assert.equal(registerAircraftViews(other, caps), true);
  assert.equal(calls.length, 2, 'a second port registers its own');
  assert.equal(
    registerAircraftViews({}, caps),
    false,
    'a port without views()',
  );
  assert.equal(registerAircraftViews(null, caps), false);
});

test('a look takes the view only when views are on and it is drawn along its course', () => {
  const look = {
    image: 'flat',
    imageLod: { near: 'near', switchPx: 30 },
    size: [20, 20],
    scale: 1.5,
  };
  const on = { views: true, kind: 'airliner', rotationMode: 'course' };
  const viewed = withAircraftView(look, on);
  assert.deepEqual(viewed, {
    image: aircraftViewRef('airliner'),
    imageLod: undefined,
    size: [20, 20],
    scale: 1.5,
  });
  assert.ok('imageLod' in viewed, 'imageLod is cleared, so an update drops it');
  assert.equal(look.image, 'flat', 'the look given is left as it was');
  assert.equal(withAircraftView(look, { ...on, views: false }), look);
  assert.equal(withAircraftView(look, { ...on, rotationMode: 'screen' }), look);
  assert.equal(
    withAircraftView(look, { ...on, rotationMode: undefined }),
    look,
  );
  assert.equal(withAircraftView(look, { ...on, kind: 'tr3b' }), look);
  assert.equal(withAircraftView(look, { ...on, kind: 'station' }), look);
  assert.equal(
    withAircraftView(look, { ...on, kind: 'helicopter', frame: 2 }).image,
    aircraftViewRef('helicopter', 2),
  );
});

test('the sheet is registered with its image resolved as the layer resolves its assets', () => {
  const calls = [];
  const port = { views: (id, sheet) => calls.push([id, sheet]) };
  const caps = new Set([VIEW_SHEETS_CAPABILITY]);
  registerAircraftViews(port, caps, (url) => `https://cdn.example/app${url}`);
  assert.equal(calls.length, 1);
  const [id, sheet] = calls[0];
  assert.equal(id, AIRCRAFT_VIEWS.id);
  assert.equal(
    sheet.image,
    'https://cdn.example/app/sprites/aircraft-views.webp',
  );
  assert.deepEqual(
    { ...sheet, image: AIRCRAFT_VIEWS.sheet.image },
    { ...AIRCRAFT_VIEWS.sheet },
    'the layout as it is',
  );
  assert.equal(AIRCRAFT_VIEWS.sheet.image, '/sprites/aircraft-views.webp');
});
