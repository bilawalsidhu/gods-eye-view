/**
 * @module render/conformance/cameraScripts
 * @description Camera scripts in the contract's own terms, each a list of
 * steps run from a fixed start: commands, frames (1/60 s each, on a clock
 * that restarts per script) and records of what the camera reports.
 *
 * The same scripts are run on the default renderer to make the reference
 * traces (`goldens/camera.json`, by `scripts/record-camera-goldens.mjs`) and
 * on a renderer under test by the conformance suite, which compares the two.
 *
 * Step kinds:
 * - `{ do: 'setView' | 'lookAt' | 'release' | 'move' | 'look' | 'rotateAround' | 'zoom', args }`
 * - `{ do: 'flyTo' | 'flyToBounds', args }`: starts a flight; its outcome and
 *   the frame it ended on are recorded when it ends.
 * - `{ do: 'cancelFlight' }`
 * - `{ do: 'listen', threshold }`: counts `changed` with that threshold.
 * - `{ do: 'frames', count }`
 * - `{ record: 'pose' }`, `{ record: 'project', points }`,
 *   `{ record: 'pickEllipsoid', screen }`, `{ record: 'pickRay', screen }`,
 *   `{ record: 'occluded', points }`, `{ record: 'changed' }`,
 *   `{ record: 'flying' }`, `{ record: 'matrices' }`, `{ record: 'viewRectangle' }`.
 */

/** Where the scripts, scenes and checks look: downtown Austin, degrees. */
export const AUSTIN = Object.freeze({ lon: -97.7431, lat: 30.2672 });
const START = {
  do: 'setView',
  args: [
    {
      destination: { ...AUSTIN, height: 15000000 },
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    },
  ],
};

const city = (height, heading, pitch, roll = 0) => ({
  do: 'setView',
  args: [
    {
      destination: { ...AUSTIN, height },
      orientation: { heading, pitch, roll },
    },
  ],
});

const AUSTIN_GROUND = [
  { lon: -97.7431, lat: 30.2672, height: 0 },
  { lon: -97.75, lat: 30.27, height: 150 },
  { lon: -97.735, lat: 30.26, height: 20 },
  { lon: -97.7431, lat: 30.28, height: 0 },
  { lon: -97.72, lat: 30.25, height: 300 },
];

const SCREEN_GRID = [
  { x: 640, y: 360 },
  { x: 10, y: 10 },
  { x: 1270, y: 10 },
  { x: 10, y: 710 },
  { x: 1270, y: 710 },
  { x: 320, y: 540 },
];

/** The viewport every script runs in, CSS pixels. */
export const SCRIPT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });

/** @type {ReadonlyArray<{name: string, steps: object[]}>} */
export const CAMERA_SCRIPTS = Object.freeze([
  {
    name: 'setView angles',
    steps: [
      START,
      { record: 'pose' },
      city(600, 0.3, -0.6),
      { record: 'pose' },
      city(600, 5.9, -0.2, 0.15),
      { record: 'pose' },
      city(25000, 3.1, -1.2),
      { record: 'pose' },
      {
        do: 'setView',
        args: [
          {
            destination: { lon: 12.5, lat: 89.95, height: 40000 },
            orientation: { heading: 1.0, pitch: -0.7, roll: 0 },
          },
        ],
      },
      { record: 'pose' },
      {
        do: 'setView',
        args: [
          {
            destination: { lon: 151.2, lat: -33.87, height: 2000 },
            orientation: { heading: 0.0 },
          },
        ],
      },
      { record: 'pose' },
    ],
  },
  {
    name: 'view rectangles',
    steps: [
      START,
      { record: 'viewRectangle' },
      ...[
        [5000, 0, -Math.PI / 2],
        [2000, 0, -0.3],
        [600, 0.3, -0.6],
        [2000, 0, 1.2],
        [15000000, 0, Math.PI / 2],
      ].flatMap(([height, heading, pitch]) => [
        city(height, heading, pitch),
        { record: 'viewRectangle' },
      ]),
      ...[
        { lon: 0, lat: 89.9, height: 1000000 },
        { lon: 180, lat: 10, height: 2000000 },
      ].flatMap((destination) => [
        { do: 'setView', args: [{ destination }] },
        { record: 'viewRectangle' },
      ]),
    ],
  },
  {
    name: 'view and projection matrices',
    steps: [
      START,
      { record: 'matrices' },
      city(600, 0.3, -0.6, 0.1),
      { record: 'matrices' },
      city(25000, 3.1, -1.2),
      { record: 'matrices' },
    ],
  },
  {
    name: 'setView keeps the position when only orientation is given',
    steps: [
      START,
      city(800, 1.0, -0.5),
      {
        do: 'setView',
        args: [{ orientation: { heading: 2.0, pitch: -0.3, roll: 0 } }],
      },
      { record: 'pose' },
    ],
  },
  {
    name: 'lookAt sweep and release',
    steps: [
      START,
      ...Array.from({ length: 12 }, (_, i) => [
        {
          do: 'lookAt',
          args: [
            { ...AUSTIN, height: 0 },
            { heading: (i * Math.PI) / 6, pitch: -0.4, range: 2000 },
          ],
        },
        { record: 'pose' },
      ]).flat(),
      { do: 'release' },
      { record: 'pose' },
    ],
  },
  {
    name: 'move, look, rotate and zoom',
    steps: [
      START,
      city(600, 0.3, -0.6),
      { do: 'move', args: ['forward', 100] },
      { record: 'pose' },
      { do: 'move', args: ['right', 50] },
      { do: 'move', args: ['up', 20] },
      { record: 'pose' },
      { do: 'look', args: ['left', 0.1] },
      { record: 'pose' },
      { do: 'look', args: ['up', 0.05] },
      { record: 'pose' },
      { do: 'rotateAround', args: [{ x: 0, y: 0, z: 1 }, 0.01] },
      { record: 'pose' },
      { do: 'zoom', args: [200] },
      { record: 'pose' },
      { do: 'move', args: ['back', 300] },
      { do: 'look', args: ['down', 0.2] },
      { do: 'look', args: ['right', 0.3] },
      { record: 'pose' },
    ],
  },
  {
    name: 'commands inside a lookAt frame',
    steps: [
      START,
      {
        do: 'lookAt',
        args: [
          { ...AUSTIN, height: 0 },
          { heading: 0.7, pitch: -0.5, range: 3000 },
        ],
      },
      { do: 'move', args: ['forward', 500] },
      { record: 'pose' },
      { do: 'rotateAround', args: [{ x: 0, y: 0, z: 1 }, 0.4] },
      { record: 'pose' },
      { do: 'zoom', args: [-1000] },
      { record: 'pose' },
      { do: 'release' },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyTo from orbit, default orientation and duration',
    steps: [
      START,
      { do: 'flyTo', args: [{ ...AUSTIN, height: 600 }] },
      { do: 'frames', count: 45 },
      { record: 'flying' },
      { do: 'frames', count: 60 },
      { record: 'flying' },
      { do: 'frames', count: 135 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyTo with duration and orientation',
    steps: [
      START,
      city(5000, 0, -1.0),
      {
        do: 'flyTo',
        args: [
          { lon: -97.7, lat: 30.3, height: 1200 },
          {
            durationS: 2,
            orientation: { heading: 1.2, pitch: -0.35, roll: 0 },
          },
        ],
      },
      { do: 'frames', count: 40 },
      { record: 'flying' },
      { do: 'frames', count: 110 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyTo with a height cap, pitch adjustment and named easings',
    steps: [
      START,
      city(3000, 0.5, -0.4),
      {
        do: 'flyTo',
        args: [
          { lon: 2.35, lat: 48.86, height: 2000 },
          {
            durationS: 3,
            easing: 'linear',
            pitchAdjustHeight: 500000,
            // Not straight down: there heading is ill-conditioned, and the
            // next flight would start from a last-bit difference in it.
            orientation: { heading: 0.2, pitch: -0.6, roll: 0 },
          },
        ],
      },
      { do: 'frames', count: 50 },
      { record: 'flying' },
      { do: 'frames', count: 50 },
      { record: 'flying' },
      { do: 'frames', count: 100 },
      { record: 'pose' },
      {
        do: 'flyTo',
        args: [
          { lon: 2.4, lat: 48.9, height: 800 },
          { durationS: 1, easing: 'cubicOut', maxHeight: 50000 },
        ],
      },
      { do: 'frames', count: 20 },
      { record: 'flying' },
      { do: 'frames', count: 50 },
      { record: 'pose' },
      {
        do: 'flyTo',
        args: [
          { lon: 2.3, lat: 48.8, height: 1500 },
          { durationS: 1, easing: 'quadraticInOut' },
        ],
      },
      { do: 'frames', count: 25 },
      { record: 'flying' },
      { do: 'frames', count: 50 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyTo with a duration of 0 completes inside the call',
    steps: [
      START,
      { do: 'flyTo', args: [{ ...AUSTIN, height: 900 }, { durationS: 0 }] },
      { record: 'flying' },
      { do: 'frames', count: 3 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyTo where the camera already is completes inside the call',
    steps: [
      city(600, 0.3, -0.6),
      {
        do: 'flyTo',
        args: [
          { ...AUSTIN, height: 600 },
          { orientation: { heading: 0.3, pitch: -0.6, roll: 0 } },
        ],
      },
      { record: 'flying' },
    ],
  },
  {
    name: 'rectangle destinations',
    steps: [
      START,
      ...[
        { west: -98, south: 30, east: -97.5, north: 30.4 },
        { west: -10, south: 0, east: 40, north: 60 },
        { west: -60, south: -20, east: 10, north: 60 },
        { west: 170, south: -50, east: -170, north: -30 },
        { west: -30, south: -89.5, east: 30, north: 89.5 },
      ].flatMap((rect) => [
        { do: 'setView', args: [{ destination: { rect } }] },
        { record: 'pose' },
      ]),
      {
        do: 'setView',
        args: [
          {
            destination: { rect: { west: 2, south: 48, east: 3, north: 49 } },
            orientation: { heading: 0.5, pitch: -0.9, roll: 0 },
          },
        ],
      },
      { record: 'pose' },
      {
        do: 'flyTo',
        args: [
          { rect: { west: -10, south: 0, east: 40, north: 60 } },
          { durationS: 1 },
        ],
      },
      { do: 'frames', count: 70 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyToBounds default offset and explicit offset',
    steps: [
      START,
      {
        do: 'flyToBounds',
        args: [{ center: { ...AUSTIN, height: 0 }, radius: 500 }],
      },
      { do: 'frames', count: 240 },
      { record: 'pose' },
      {
        do: 'flyToBounds',
        args: [
          { center: { ...AUSTIN, height: 0 }, radius: 500 },
          { offset: { heading: 1.0, pitch: -0.3, range: 3000 }, durationS: 1 },
        ],
      },
      { do: 'frames', count: 90 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyToBounds easing',
    steps: [
      START,
      {
        do: 'flyToBounds',
        args: [
          { center: { ...AUSTIN, height: 0 }, radius: 500 },
          {
            offset: { heading: 0.5, pitch: -0.4, range: 2500 },
            durationS: 1,
            easing: 'cubicInOut',
          },
        ],
      },
      { do: 'frames', count: 20 },
      { record: 'pose' },
      { do: 'frames', count: 70 },
      { record: 'pose' },
    ],
  },
  {
    name: 'flyTo sineInOut',
    steps: [
      START,
      {
        do: 'flyTo',
        args: [
          { ...AUSTIN, height: 4000 },
          {
            durationS: 1,
            easing: 'sineInOut',
            orientation: { heading: 0.3, pitch: -0.5, roll: 0 },
          },
        ],
      },
      { do: 'frames', count: 15 },
      { record: 'pose' },
      { do: 'frames', count: 30 },
      { record: 'pose' },
      { do: 'frames', count: 30 },
      { record: 'pose' },
    ],
  },
  {
    name: 'a cancelled flight stops where it was',
    steps: [
      START,
      { do: 'flyTo', args: [{ ...AUSTIN, height: 600 }, { durationS: 3 }] },
      { do: 'frames', count: 30 },
      { do: 'cancelFlight' },
      { do: 'frames', count: 5 },
      { record: 'flying' },
    ],
  },
  {
    name: 'changed fires by each listener’s threshold',
    steps: [
      START,
      city(2000, 0, -0.5),
      { do: 'listen', threshold: 0.5 },
      { do: 'listen', threshold: 0.1 },
      { do: 'frames', count: 1 },
      ...Array.from({ length: 24 }, () => [
        { do: 'look', args: ['right', 0.05] },
        { do: 'frames', count: 1 },
      ]).flat(),
      { record: 'changed' },
    ],
  },
  {
    name: 'projection, picks and the horizon',
    steps: [
      START,
      city(600, 0.3, -0.6),
      { record: 'project', points: AUSTIN_GROUND },
      { record: 'pickEllipsoid', screen: SCREEN_GRID },
      { record: 'pickRay', screen: SCREEN_GRID },
      START,
      {
        record: 'occluded',
        points: [
          { lon: -97.7431, lat: 30.2672, height: 0 },
          { lon: 82.26, lat: -30.27, height: 0 },
          { lon: -97.7431, lat: -55, height: 0 },
          { lon: -10, lat: 30, height: 0 },
          { lon: -10, lat: 30, height: 2000000 },
          { lon: 170, lat: 10, height: 30000000 },
        ],
      },
    ],
  },
]);
