import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSceneDocument,
  stringifySceneDocument,
  validateSceneDocument,
  SCENE_DOCUMENT_LIMITS,
} from './document.js';
import { createDefaultProject, normalizeProject } from '../scenes/project.js';

const fixture = () => ({
  version: 3,
  scenes: [
    {
      id: 'scene',
      title: 'My scene',
      shots: [
        {
          id: 'shot',
          title: 'My shot',
          durationSec: 3,
          holdSec: 0,
          camera: { lat: 1, lon: 2, alt: 42, pitch: 0 },
          layers: {
            traffic: { enabled: true, params: { nested: [1, 'two', null] } },
          },
        },
      ],
    },
  ],
});
test('all built-in authored content exports and normalizes without edit loss', () => {
  const project = createDefaultProject();
  const migrated = normalizeProject(
    parseSceneDocument(stringifySceneDocument(project)),
  );
  assert.deepEqual(
    JSON.parse(stringifySceneDocument(migrated)),
    JSON.parse(stringifySceneDocument(project)),
  );
  const edited = normalizeProject(fixture());
  edited.scenes[0].appliedShotPacks = [
    { id: 'pack', version: 3, shotBindings: { Original: 'shot' } },
  ];
  assert.deepEqual(
    normalizeProject(parseSceneDocument(stringifySceneDocument(edited))),
    edited,
  );
  assert.equal(edited.scenes[0].shots[0].camera.pitch, 0);
  assert.equal(edited.scenes[0].shots[0].camera.alt, 42);
});
test('v1/v2 bloom migrates once; IDs, edits, pack bindings and zero holds survive', () => {
  for (const version of [undefined, 1, 2]) {
    const project = fixture();
    project.version = version;
    project.scenes[0].shots[0].visual = {
      bloom: { enabled: true, intensity: 25 },
    };
    const migrated = normalizeProject(
      parseSceneDocument(JSON.stringify(project)),
    );
    assert.equal(migrated.version, 6);
    assert.equal(migrated.scenes[0].shots[0].visual.bloom.intensity, 150);
    assert.equal(migrated.scenes[0].shots[0].id, 'shot');
    assert.deepEqual(
      normalizeProject(parseSceneDocument(stringifySceneDocument(migrated))),
      migrated,
    );
  }
});
test('an intentionally empty project stays empty', () => {
  assert.deepEqual(
    normalizeProject(parseSceneDocument('{"version":3,"scenes":[]}')).scenes,
    [],
  );
});
test('missing legacy IDs become stable after the first saved migration', () => {
  const project = { scenes: [{ shots: [{}] }] };
  const migrated = normalizeProject(validateSceneDocument(project));
  assert.ok(migrated.scenes[0].id);
  assert.ok(migrated.scenes[0].shots[0].id);
  assert.deepEqual(
    normalizeProject(parseSceneDocument(stringifySceneDocument(migrated))),
    migrated,
  );
});
test('invalid shapes, versions, unknown fields and unsafe keys fail with field paths', () => {
  for (const text of [
    'null',
    '[]',
    '{}',
    '{"version":99,"scenes":[]}',
    '{"version":3,"scenes":[],"run":{}}',
    '{"scenes":[],"__proto__":{}}',
  ]) {
    assert.throws(() => parseSceneDocument(text), {
      name: 'SceneDocumentError',
    });
  }
  const project = fixture();
  project.scenes[0].shots[0].camera.lat = 91;
  assert.throws(
    () => validateSceneDocument(project),
    /\$\.scenes\[0\]\.shots\[0\]\.camera.lat/,
  );
  project.scenes[0].shots[0].camera.lat = 1;
  project.scenes[0].shots.push(structuredClone(project.scenes[0].shots[0]));
  assert.throws(() => validateSceneDocument(project), /duplicate ID/);
});
test('document byte, nesting, collection, finite-number and string bounds are enforced', () => {
  assert.throws(
    () => parseSceneDocument(' '.repeat(SCENE_DOCUMENT_LIMITS.bytes + 1)),
    /5 MiB/,
  );
  assert.throws(
    () =>
      parseSceneDocument(
        JSON.stringify({
          scenes: [],
          createdAt: 'é'.repeat(SCENE_DOCUMENT_LIMITS.bytes / 2),
        }),
      ),
    /5 MiB/,
  );
  const project = fixture();
  project.scenes[0].shots[0].camera.lat = Infinity;
  assert.throws(() => validateSceneDocument(project), /JSON value/);
  project.scenes[0].shots[0].camera.lat = 1;
  let nested = project.scenes[0].shots[0].layers.traffic.params;
  for (let i = 0; i < 30; i++) nested = nested.child = {};
  assert.throws(() => validateSceneDocument(project), /complexity/);
  assert.throws(
    () => validateSceneDocument({ scenes: Array(257).fill({ shots: [] }) }),
    /256/,
  );
});

test('captured scope and extended detection edits survive migration', () => {
  const project = fixture();
  project.scenes[0].shots[0].visual = {
    scope: { enabled: true, featherPct: 11 },
    detection: {
      mode: 'DENSE',
      density: 75,
      allocation: 'ELASTIC',
      fadePct: 7,
      outsideOpacityPct: 1,
    },
  };
  const migrated = normalizeProject(
    parseSceneDocument(JSON.stringify(project)),
  );
  assert.deepEqual(
    migrated.scenes[0].shots[0].visual.scope,
    project.scenes[0].shots[0].visual.scope,
  );
  assert.deepEqual(
    migrated.scenes[0].shots[0].visual.detection,
    project.scenes[0].shots[0].visual.detection,
  );
});
