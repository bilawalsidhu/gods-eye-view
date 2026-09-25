import { readShellSource } from '../testSupport/readShellSource.mjs';
// Director-level pins for scene playback.
//
// scenePolicy.test.mjs pins the pure decisions; these pin the wiring, which is
// where every regression in this file's history actually lived: the reconcile
// walking the whole registry, captured tracking params handing the camera back
// to the follow loop, a refused enable reported as success, STOP landing layer
// changes after the operator stopped, and a stale LOAD completing last.
//
// The cancellation pins matter twice over: checking a boolean AFTER an await
// only stops the NEXT step, so the awaited operation itself has to be
// cancellable — an AbortSignal for the data manager, a liveness predicate for
// the visual commit. Several of these assert exactly that plumbing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SceneDirector } from './director.js';
import { SCENE_TRACKING_PARAM_KEYS } from './scenePolicy.js';
import { SCENE_RECIPES, getSceneAppendRecipeById } from './recipes.js';

const NEPAL_ORIGINAL_SHOT_TITLES = [
  'Global Incident Context',
  'Nepal-Focused Globe Rotation',
  'Bhote Koshi Regional Approach',
  'Bhote Koshi Nearby Cities',
  'Bhote Koshi Incident Corridor',
  'Bhote Koshi Flood Path',
  'Bhote Koshi Corridor Overview',
  'Bhote Koshi Upper Valley',
];

function nepalProjectFixture() {
  const project = structuredClone(PROJECT_FIXTURE);
  project.scenes[0].title = 'Nepal Flood Incident';
  project.scenes[0].shots = NEPAL_ORIGINAL_SHOT_TITLES.map((title, index) => ({
    ...structuredClone(PROJECT_FIXTURE.scenes[0].shots[index % 2]),
    id: `nepal-original-${index + 1}`,
    title,
    camera: {
      lat: 27 + index / 10,
      lon: 85 + index / 10,
      alt: 1000 + index * 100,
      heading: index * 10,
      pitch: -35 - index,
      roll: 0,
    },
    visual: {
      ...structuredClone(PROJECT_FIXTURE.scenes[0].shots[index % 2].visual),
      mapStack: 'photoreal',
    },
    layers: {
      ...structuredClone(PROJECT_FIXTURE.scenes[0].shots[index % 2].layers),
      'bhote-koshi-locator': {
        enabled: index > 0,
        params: { presentation: `fixture-${index + 1}` },
      },
    },
  }));
  project.scenes[0].shots[7].layers['bhote-koshi-locator'] = {
    enabled: true,
    params: { presentation: 'bhote-koshi-trigger-record' },
  };
  project.scenes[0].shots[7].holdSec = 8;
  return project;
}

function legacyThreeShotNepalProjectFixture() {
  const project = structuredClone(PROJECT_FIXTURE);
  project.scenes[0].title = 'Nepal Flood Incident';
  project.scenes[0].shots = [0, 1, 2].map((index) => ({
    ...structuredClone(PROJECT_FIXTURE.scenes[0].shots[index % 2]),
    id: `legacy-nepal-${index + 1}`,
    title: `Shot ${index + 1}`,
    camera: {
      lat: 20 + index,
      lon: 80 + index,
      alt: 1000000 + index * 100000,
      heading: index * 15,
      pitch: -50 - index,
      roll: 0,
    },
  }));
  return project;
}

function legacyDefaultProjectWithoutNepalFixture() {
  const project = structuredClone(PROJECT_FIXTURE);
  project.scenes[0].id = 'bhote-koshi-flood';
  project.scenes[0].title = 'Bhote Koshi Flood Reconstruction';
  project.scenes[0].shots = [
    {
      ...structuredClone(PROJECT_FIXTURE.scenes[0].shots[0]),
      id: 'standalone-shot',
      title: 'Shot 1',
    },
  ];
  return project;
}

test('Mailung clip trim estimates seven seconds and its exit, including older saved holds', () => {
  const { director, restore } = makeDirector();
  try {
    const scene = director._project.scenes[0];
    const shot = scene.shots[0];
    shot.sourcePackId = 'bhote-koshi-nepal-evidence-pack';
    shot.durationSec = 4.2;
    shot.holdSec = 15;
    shot.layers = {
      'bhote-koshi-2026': {
        enabled: true,
        params: {
          presentation: 'scene-beat',
          beatId: 'mailung-bazzar',
        },
      },
    };
    assert.equal(director._effectiveShotHoldSec(scene, shot), 7.65);
    assert.equal(director._shotRuntimeDurationSec(scene, shot), 4.2 + 7.65);
    const state = director._layerStatesForShot(scene, shot)['bhote-koshi-2026'];
    assert.equal(state.params.sceneContext.holdSec, 7.65);
    assert.equal(state.params.sceneControls.mediaPlaybackHoldSec, 7);
    assert.equal(state.params.sceneControls.minimumHoldSec, 7.65);
    assert.equal(
      shot.holdSec,
      15,
      'runtime correction does not rewrite saved shots',
    );
    shot.layers['bhote-koshi-2026'].params.beatId = 'dandagaun';
    assert.equal(
      director._effectiveShotHoldSec(scene, shot),
      15,
      'other shots keep their authored hold',
    );
  } finally {
    restore();
  }
});

test('Incident Corridor gives all overview pins time to reveal without rewriting saved shots', () => {
  const { director, restore } = makeDirector();
  try {
    const scene = director._project.scenes[0];
    const shot = scene.shots[0];
    shot.holdSec = 0.9;
    shot.layers = {
      'bhote-koshi-locator': {
        enabled: true,
        params: { presentation: 'bhote-koshi-incident-places' },
      },
    };
    assert.equal(director._effectiveShotHoldSec(scene, shot), 11);
    assert.equal(shot.holdSec, 0.9);
    shot.holdSec = 15;
    assert.equal(director._effectiveShotHoldSec(scene, shot), 15);
    shot.holdSec = 0.9;
    shot.layers['bhote-koshi-locator'].params.presentation =
      'bhote-koshi-flood-path';
    assert.equal(director._effectiveShotHoldSec(scene, shot), 0.9);
    shot.layers['bhote-koshi-locator'].params.presentation =
      'bhote-koshi-incident-places';
    shot.layers['bhote-koshi-locator'].enabled = false;
    assert.equal(director._effectiveShotHoldSec(scene, shot), 0.9);
  } finally {
    restore();
  }
});

test('scene clock seek resolves the exact shot phase and camera in both directions', async () => {
  const { director, restore } = makeDirector();
  const loads = [];
  director._loadShot = async (sceneId, shotId, options) => {
    loads.push({ sceneId, shotId, options });
    return { started: true, shotId };
  };
  try {
    assert.equal(await director.seekScene('scene-1', 0), true);
    assert.equal(await director.seekScene('scene-1', 0.99), true);
    assert.equal(await director.seekScene('scene-1', 0.25), true);
    assert.equal(await director.seekScene('missing', 0.5), false);
    assert.deepEqual(
      loads.map(({ sceneId, shotId }) => ({ sceneId, shotId })),
      [
        { sceneId: 'scene-1', shotId: 'shot-a' },
        { sceneId: 'scene-1', shotId: 'shot-b' },
        { sceneId: 'scene-1', shotId: 'shot-a' },
      ],
    );
    assert.equal(loads[0].options.sceneSeek.sceneProgress, 0);
    assert.equal(loads[0].options.sceneSeek.cameraProgress, 0);
    assert.ok(loads[1].options.sceneSeek.cameraProgress > 0.9);
    assert.equal(loads[1].options.sceneSeek.shotIndex, 1);
    assert.equal(loads[2].options.sceneSeek.sceneProgress, 0.25);
    assert.equal(loads[2].options.sceneSeek.cameraProgress, 0.5);
    assert.equal(loads[2].options.sceneSeek.camera.lat, 10);
    assert.equal(loads[2].options.sceneSeek.camera.lon, 20);
  } finally {
    restore();
  }
});

test('scene clock subscribers receive authoritative forward playback snapshots', () => {
  const { director, restore } = makeDirector();
  const snapshots = [];
  const unsubscribe = director.subscribeSceneClock((snapshot) =>
    snapshots.push(snapshot),
  );
  try {
    const scene = director._project.scenes[0];
    director._publishSceneClock(scene, scene.shots[0], 0.1, { running: true });
    director._publishSceneClock(scene, scene.shots[1], 0.3, { running: true });
    unsubscribe();
    director._publishSceneClock(scene, scene.shots[1], 0.4, { running: false });
    assert.deepEqual(
      snapshots.map(({ shotId, sceneElapsedSec, running }) => ({
        shotId,
        sceneElapsedSec,
        running,
      })),
      [
        { shotId: 'shot-a', sceneElapsedSec: 0.1, running: true },
        { shotId: 'shot-b', sceneElapsedSec: 0.3, running: true },
      ],
    );
  } finally {
    restore();
  }
});

test('the Nepal evidence pack appends once and applies the approved corridor framing', () => {
  const project = nepalProjectFixture();
  const originalShots = structuredClone(project.scenes[0].shots);
  const { director, restore } = makeDirector({ project });
  try {
    const scene = director._project.scenes[0];
    const originalShotIds = scene.shots.map(({ id }) => id);
    const first = director.appendShotPack(
      'scene-1',
      'bhote-koshi-nepal-evidence-pack',
    );
    assert.deepEqual(first, {
      appended: true,
      updated: false,
      shotCount: 17,
      patchedShotCount: 14,
      firstShotId: scene.shots[8].id,
    });
    assert.deepEqual(
      scene.shots.slice(0, 8).map(({ id }) => id),
      originalShotIds,
    );
    assert.equal(scene.shots.length, 25);
    assert.ok(scene.releaseLayerIds.includes('bhote-koshi-2026'));
    assert.ok(scene.releaseLayerIds.includes('bhote-koshi-locator'));
    assert.equal(
      scene.appliedShotPacks[0].id,
      'bhote-koshi-nepal-evidence-pack',
    );
    assert.equal(scene.appliedShotPacks[0].version, 18);
    assert.deepEqual(Object.keys(scene.appliedShotPacks[0].shotBindings), [
      ...NEPAL_ORIGINAL_SHOT_TITLES,
      ...scene.shots.slice(8).map(({ title }) => title),
    ]);
    assert.deepEqual(
      scene.shots.map((shot) => shot.visual.mapStack),
      [...Array(25).fill('photoreal')],
    );
    assert.deepEqual(
      scene.shots.map((shot) => shot.layers['bhote-koshi-2026'].params.beatId),
      [
        'immediate-collapse-viewpoint',
        'debris-dammed-lake',
        'gyirong-border-gate',
        'timure-cluster',
        'syabru-besi',
        'bidur-trishuli-bridge',
        'gyirong-border-gate',
        'immediate-collapse-viewpoint',
        'immediate-collapse-viewpoint',
        'debris-dammed-lake',
        'second-landslide',
        'gyirong-border-gate',
        'timure-cluster',
        'syabru-besi',
        'dhunche',
        'mailung-upper-trishuli',
        'mailung-bazzar',
        'dandagaun',
        'dandagaun-viewpoint',
        'betrawati-bazaar',
        'bhainse',
        'bidur-trishuli-bridge',
        'devighat-taadi-khola-bridge',
        'charaudi',
        'final-view',
      ],
    );
    assert.deepEqual(
      scene.shots[8].layers['bhote-koshi-2026'].params.sceneControls,
      { evidenceMediaAutoplay: true },
    );
    assert.deepEqual(
      scene.shots[9].layers['bhote-koshi-2026'].params.sceneControls,
      { evidenceMediaAutoplay: true },
    );
    assert.deepEqual(
      scene.shots[11].layers['bhote-koshi-2026'].params.sceneControls,
      {
        imageryComparison: true,
        evidenceSequence: true,
        evidenceSequenceDurationSec: 2.5,
        deferEvidenceUntilCameraSettled: true,
        evidenceRevealDurationSec: 2.5,
      },
    );
    assert.deepEqual(
      scene.shots
        .slice(12, 14)
        .map((shot) => shot.layers['bhote-koshi-2026'].params.sceneControls),
      [
        {
          imageryComparison: true,
          evidenceSequence: true,
          evidenceSequenceDurationSec: 4,
        },
        {
          imageryComparison: true,
          evidenceSequence: true,
          evidenceSequenceDurationSec: 4,
        },
      ],
    );
    assert.deepEqual(
      scene.shots[21].layers['bhote-koshi-2026'].params.sceneControls,
      {
        evidenceSequence: true,
        evidenceSequenceDurationSec: 4,
      },
    );
    for (const shot of scene.shots) {
      assert.equal(shot.layers['bhote-koshi-2026'].enabled, true);
      assert.equal(
        shot.layers['bhote-koshi-2026'].params.presentation,
        'scene-beat',
      );
    }
    assert.deepEqual(
      scene.shots
        .slice(0, 8)
        .filter((_, index) => index !== 4)
        .map(({ camera }) => camera),
      originalShots
        .filter((_, index) => index !== 4)
        .map(({ camera }) => camera),
    );
    assert.deepEqual(scene.shots[4].camera, {
      lat: 28.0529,
      lon: 85.2189,
      alt: 126931,
      heading: 0,
      pitch: -90,
      roll: 0,
    });
    assert.equal(scene.shots[4].holdSec, 11);
    assert.deepEqual(
      scene.shots.slice(0, 8).map((shot) => shot.layers['bhote-koshi-locator']),
      originalShots.map((shot) => shot.layers['bhote-koshi-locator']),
    );
    assert.equal(new Set(scene.shots.map(({ id }) => id)).size, 25);
    assert.deepEqual(
      director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack'),
      { appended: false, reason: 'already-appended' },
    );
    assert.equal(scene.shots.length, 25);
  } finally {
    restore();
  }
});

test('installed v12 Nepal pack inserts ten points without replacing renamed cameras', () => {
  const first = makeDirector({ project: nepalProjectFixture() });
  let legacy;
  const recipe = getSceneAppendRecipeById('bhote-koshi-nepal-evidence-pack');
  try {
    first.director.appendShotPack('scene-1', recipe.id);
    legacy = structuredClone(first.director._project);
    const scene = legacy.scenes[0];
    scene.shots = scene.shots.filter(
      (shot) =>
        !shot.sourcePackId ||
        recipe.previousRequiredSourcePackBeatIds.includes(
          shot.layers['bhote-koshi-2026'].params.beatId,
        ),
    );
    scene.appliedShotPacks[0].version = 12;
    const ids = new Set(scene.shots.map(({ id }) => id));
    scene.appliedShotPacks[0].shotBindings = Object.fromEntries(
      Object.entries(scene.appliedShotPacks[0].shotBindings).filter(([, id]) =>
        ids.has(id),
      ),
    );
    scene.shots[8].title = 'My collapse camera';
    scene.shots[8].camera.heading = 149;
  } finally {
    first.restore();
  }
  const originalShots = structuredClone(legacy.scenes[0].shots);
  const upgraded = makeDirector({ project: legacy });
  try {
    const scene = upgraded.director._project.scenes[0];
    assert.equal(scene.shots.length, 25);
    for (const old of originalShots) {
      const current = scene.shots.find(({ id }) => id === old.id);
      assert.ok(current);
      assert.deepEqual(current.camera, old.camera);
      assert.equal(current.title, old.title);
    }
    assert.deepEqual(
      scene.shots
        .filter((shot) => shot.sourcePackId)
        .map((shot) => shot.layers['bhote-koshi-2026'].params.beatId),
      recipe.requiredSourcePackBeatIds,
    );
    assert.equal(scene.appliedShotPacks[0].version, 18);
    assert.equal(
      upgraded.director.appendShotPack(scene.id, recipe.id).reason,
      'already-appended',
    );
  } finally {
    upgraded.restore();
  }
});

test('a legacy three-shot Nepal browser project bootstraps to the current 25-shot sequence', () => {
  const project = legacyThreeShotNepalProjectFixture();
  const originalIds = project.scenes[0].shots.map(({ id }) => id);
  const originalCameras = project.scenes[0].shots.map(({ camera }) =>
    structuredClone(camera),
  );
  const { director, restore } = makeDirector({ project });
  try {
    const scene = director._project.scenes[0];
    assert.equal(scene.shots.length, 25);
    assert.deepEqual(
      scene.shots.map(({ title }) => title),
      getSceneAppendRecipeById('bhote-koshi-nepal-evidence-pack')
        .requiredShotTitles,
    );
    assert.deepEqual(
      scene.shots.slice(0, 3).map(({ id }) => id),
      originalIds,
    );
    assert.deepEqual(
      scene.shots.slice(0, 3).map(({ camera }) => camera),
      originalCameras,
    );
    assert.equal(
      scene.appliedShotPacks[0].id,
      'bhote-koshi-nepal-evidence-pack',
    );
    assert.equal(scene.appliedShotPacks[0].version, 18);
    assert.equal(director._selectedSceneId, scene.id);
    assert.equal(director._selectedShotId, scene.shots[0].id);
  } finally {
    restore();
  }
});

test('the Nepal evidence pack refuses a partial inventory without mutating the scene', () => {
  const project = nepalProjectFixture();
  project.scenes[0].shots[3].title = 'Renamed Nearby Cities';
  const { director, restore } = makeDirector({ project });
  try {
    const sceneBefore = structuredClone(director._project.scenes[0]);
    assert.deepEqual(
      director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack'),
      {
        appended: false,
        updated: false,
        reason: 'shot-inventory-mismatch',
      },
    );
    assert.deepEqual(director._project.scenes[0], sceneBefore);
  } finally {
    restore();
  }
});

test('the Nepal pack upgrades the upper-valley shots without duplicating evidence beats', () => {
  const initial = makeDirector({ project: nepalProjectFixture() });
  initial.director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack');
  const project = structuredClone(initial.director._project);
  initial.restore();
  project.scenes[0].appliedShotPacks = [
    {
      id: 'bhote-koshi-nepal-evidence-pack',
      version: 4,
    },
  ];
  for (const shot of project.scenes[0].shots.slice(0, 8)) {
    delete shot.layers['bhote-koshi-2026'];
  }
  const originalLength = project.scenes[0].shots.length;
  const originalIds = project.scenes[0].shots.map(({ id }) => id);
  const originalCameras = project.scenes[0].shots.map(({ camera }) =>
    structuredClone(camera),
  );
  const originalLocators = project.scenes[0].shots.map((shot) =>
    structuredClone(shot.layers['bhote-koshi-locator']),
  );
  const { director, restore } = makeDirector({ project });
  try {
    const scene = director._project.scenes[0];
    assert.deepEqual(
      director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack'),
      { appended: false, reason: 'already-appended' },
    );
    assert.equal(scene.shots.length, originalLength);
    assert.deepEqual(
      scene.shots.map(({ id }) => id),
      originalIds,
    );
    assert.deepEqual(
      scene.shots.map(({ camera }) => camera),
      originalCameras,
    );
    assert.deepEqual(
      scene.shots.map((shot) => shot.layers['bhote-koshi-locator']),
      originalLocators,
    );
    assert.deepEqual(scene.shots[8].camera, {
      lat: 28.417,
      lon: 85.3937,
      alt: 9850,
      heading: 146,
      pitch: -34,
      roll: 0,
    });
    assert.equal(scene.appliedShotPacks[0].version, 18);
    assert.equal(
      Object.keys(scene.appliedShotPacks[0].shotBindings).length,
      25,
    );
    assert.ok(
      scene.shots.every(
        (shot) =>
          shot.layers['bhote-koshi-2026']?.enabled === true &&
          shot.layers['bhote-koshi-2026']?.params?.presentation ===
            'scene-beat',
      ),
    );
    const afterUpgrade = structuredClone(scene);
    assert.deepEqual(
      director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack'),
      { appended: false, reason: 'already-appended' },
    );
    assert.deepEqual(scene, afterUpgrade);
  } finally {
    restore();
  }
});

test('an older default project gains the complete selectable Nepal scene once', () => {
  const project = legacyDefaultProjectWithoutNepalFixture();
  const { director, restore } = makeDirector({
    project,
    data: {
      registered: [...REGISTERED, 'bhote-koshi-2026', 'bhote-koshi-locator'],
    },
  });
  try {
    const nepal = director._project.scenes.find(
      ({ title }) => title === 'Nepal Flood Incident',
    );
    assert.ok(nepal);
    assert.equal(nepal.shots.length, 25);
    assert.equal(nepal.shots[0].title, 'Global Incident Context');
    assert.equal(nepal.shots.at(-1).title, 'Final view');
    assert.deepEqual(director._project.installedBuiltInSceneIds, [
      'bhote-koshi-nepal-scene',
    ]);
  } finally {
    restore();
  }
});

test('a previously installed Nepal scene stays deleted when its marker remains', () => {
  const project = legacyDefaultProjectWithoutNepalFixture();
  project.installedBuiltInSceneIds = ['bhote-koshi-nepal-scene'];
  const { director, restore } = makeDirector({ project });
  try {
    assert.equal(
      director._project.scenes.some(
        ({ title }) => title === 'Nepal Flood Incident',
      ),
      false,
    );
  } finally {
    restore();
  }
});

test('public defaults include Nepal without an extra standalone flood recipe', () => {
  assert.equal(
    SCENE_RECIPES.some((item) => item.id === 'bhote-koshi-flood'),
    false,
  );
  assert.equal(
    SCENE_RECIPES.filter((item) => item.id === 'bhote-koshi-nepal-scene')
      .length,
    1,
  );
});

test('an existing public default project gains Nepal without replacing authored shots', () => {
  const project = structuredClone(PROJECT_FIXTURE);
  project.scenes[0].id = 'flights-radar';
  const original = structuredClone(project.scenes[0].shots);
  const { director, restore } = makeDirector({ project });
  try {
    assert.deepEqual(
      director._project.scenes[0].shots.map(({ id, camera }) => ({
        id,
        camera,
      })),
      original.map(({ id, camera }) => ({ id, camera })),
    );
    assert.equal(director._project.scenes[1].title, 'Nepal Flood Incident');
    assert.equal(director._project.scenes[1].shots.length, 25);
    assert.deepEqual(director._project.installedBuiltInSceneIds, [
      'bhote-koshi-nepal-scene',
    ]);
  } finally {
    restore();
  }
});

test('Nepal comparison shots load Esri beneath Vantor even from a saved OSM or photoreal shot', async () => {
  const { director, styleManager, restore } = makeDirector({
    project: nepalProjectFixture(),
    data: {
      registered: [...REGISTERED, 'bhote-koshi-2026', 'bhote-koshi-locator'],
    },
  });
  try {
    director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack');
    const scene = director._project.scenes[0];
    const comparisonShots = scene.shots.filter(
      (shot) =>
        director._layerStatesForShot(scene, shot)['bhote-koshi-2026']?.params
          ?.sceneControls?.imageryComparison,
    );
    assert.ok(
      comparisonShots.length >= 2,
      'the real comparison beats must be exercised',
    );
    for (const shot of comparisonShots) {
      for (const prior of ['osm', 'photoreal']) {
        shot.visual.mapStack = prior;
        await director.loadShot(scene.id, shot.id, { flyDuration: 0.2 });
        assert.equal(
          styleManager.visualStates.at(-1).mapStack,
          'esri-imagery',
          shot.title,
        );
      }
    }
  } finally {
    await director.destroy();
    restore();
  }
});

test('all saved Nepal shots choose a usable map in keyed and keyless runtimes without rewriting the project', async () => {
  let photorealAvailable = false;
  const { director, styleManager, restore } = makeDirector({
    project: nepalProjectFixture(),
    isMapStackAvailable: (id) => id === 'photoreal' && photorealAvailable,
    data: {
      registered: [...REGISTERED, 'bhote-koshi-2026', 'bhote-koshi-locator'],
    },
  });
  try {
    director.appendShotPack('scene-1', 'bhote-koshi-nepal-evidence-pack');
    const scene = director._project.scenes[0];
    const savedShots = structuredClone(scene.shots);
    for (const available of [false, true, false]) {
      photorealAvailable = available;
      for (const shot of scene.shots) {
        const comparison = director._layerStatesForShot(scene, shot)[
          'bhote-koshi-2026'
        ]?.params?.sceneControls?.imageryComparison;
        const visual = director._visualStateForShot(shot);
        assert.equal(
          visual.mapStack,
          available && !comparison ? 'photoreal' : 'esri-imagery',
          shot.title,
        );
      }
      await director.loadShot(scene.id, scene.shots[0].id, {
        flyDuration: 0.2,
      });
      assert.equal(
        styleManager.visualStates.at(-1).mapStack,
        available ? 'photoreal' : 'esri-imagery',
      );
    }
    assert.deepEqual(scene.shots, savedShots);
    const unrelated = {
      visual: { mapStack: 'photoreal' },
      layers: { flights: { enabled: true } },
    };
    assert.equal(
      director._visualStateForShot(unrelated),
      unrelated.visual,
      'other scenes keep their provider policy',
    );
  } finally {
    await director.destroy();
    restore();
  }
});

/** The layer registry as main.js builds it (src/main.js dataManager.register calls). */
const REGISTERED = [
  'flights',
  'military',
  'earthquakes',
  'satellites',
  'rocket-launches',
  'traffic',
  'cctv',
  'radio',
  'bikeshare',
  'ais-live-vessels',
  'military-installations',
  'military-awareness',
  'local-datacenters',
  'local-dams',
  'telegeography-submarine-cables',
  'local-firms',
];

/** Layers Space Missions permits while it isolates the globe (contextModePolicy). */
const SPACE_MISSIONS_ALLOWED = new Set([
  'rocket-launches',
  'satellites',
  'radio',
]);

const PROJECT_FIXTURE = {
  version: 3,
  scenes: [
    {
      id: 'scene-1',
      title: 'Fixture Scene',
      shots: [
        {
          id: 'shot-a',
          title: 'Shot A',
          durationSec: 0.2,
          holdSec: 0,
          camera: {
            lat: 10,
            lon: 20,
            alt: 500000,
            heading: 0,
            pitch: -40,
            roll: 0,
          },
          visual: { style: 'normal' },
          layers: { flights: { enabled: true } },
        },
        {
          id: 'shot-b',
          title: 'Shot B',
          durationSec: 0.2,
          holdSec: 0,
          camera: {
            lat: -30,
            lon: 140,
            alt: 900000,
            heading: 0,
            pitch: -40,
            roll: 0,
          },
          visual: { style: 'retro' },
          layers: { traffic: { enabled: true } },
        },
      ],
    },
  ],
};

/** Stub the browser globals the director touches, headlessly. */
function installSceneRuntime(project = PROJECT_FIXTURE) {
  const originalDocument = globalThis.document;
  const originalLocalStorage = globalThis.localStorage;
  const noopClassList = {
    add() {},
    remove() {},
    toggle() {},
    contains: () => false,
  };

  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      classList: noopClassList,
      style: {},
      appendChild() {},
      remove() {},
    }),
    addEventListener() {},
    removeEventListener() {},
    body: { classList: noopClassList, appendChild() {} },
  };
  const stored = new Map([
    ['godsEyeView.sceneProject.v2', JSON.stringify(project)],
  ]);
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };

  return () => {
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;
  };
}

/**
 * Data manager double recording every reconcile call the director makes.
 *
 * Models the real abort contract (src/data/manager.js): an aborted transition
 * is rolled back through the module's own disable() and answers false, so an
 * abort leaves NO half-applied layer — which is the whole point of passing the
 * signal rather than only checking a boolean afterwards.
 */
function fakeDataManager({
  registered = REGISTERED,
  refuse = () => false,
} = {}) {
  const enabled = new Map();
  const setEnabledCalls = [];
  const setParamsCalls = [];
  const committed = [];
  return {
    setEnabledCalls,
    subscribeVisibilityRequests(listener) {
      this.visibilityListener = listener;
      return () => {
        this.visibilityListener = null;
      };
    },
    setParamsCalls,
    committed,
    getAll: () => registered.map((id) => ({ id, enabled: !!enabled.get(id) })),
    getLayerParams: () => null,
    async setEnabled(id, shouldEnable, { signal } = {}) {
      setEnabledCalls.push({ id, enabled: shouldEnable, signal });
      if (refuse(id, shouldEnable)) return false;
      // Yield once so a stop landing during the transition is observable.
      await Promise.resolve();
      if (signal?.aborted) return false;
      enabled.set(id, shouldEnable);
      committed.push({ id, enabled: shouldEnable });
      return true;
    },
    setLayerParams(id, params) {
      setParamsCalls.push({ id, params });
      return true;
    },
  };
}

/** Style manager double covering the camera, visual, and Context facades. */
function fakeStyleManager({ contextMode = null, exitFails = false } = {}) {
  const manager = {
    contextMode,
    contextExits: [],
    visualStates: [],
    visualCalls: [],
    runImmediateNavigation: (noun, navigate) => navigate(),
    applyVisualState: async (visual, options = {}) => {
      manager.visualStates.push(visual);
      manager.visualCalls.push({ visual, isCurrent: options.isCurrent });
      return true;
    },
    getCameraState: () => ({
      lat: 0,
      lon: 0,
      alt: 1000,
      heading: 0,
      pitch: -40,
      roll: 0,
    }),
    getVisualState: () => ({ style: 'normal' }),
    setRecordingMode() {},
    getContextModeState: () => ({ mode: manager.contextMode, entering: null }),
    async setContextMode(mode) {
      manager.contextExits.push(mode);
      if (exitFails) return { ok: false, error: 'transition did not complete' };
      manager.contextMode = null;
      return { ok: true };
    },
  };
  return manager;
}

/** Cesium viewer double whose flights complete on the next microtask turn. */
function fakeViewer() {
  const flights = [];
  let cancelled = 0;
  return {
    flights,
    get cancelledFlights() {
      return cancelled;
    },
    camera: {
      flyTo(options) {
        flights.push(options);
        Promise.resolve().then(() => options.complete?.());
      },
      cancelFlight() {
        cancelled++;
      },
    },
  };
}

/** Yield enough turns for the director's pending awaits to advance. */
async function settle(turns = 8) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** Build a director over doubles, with the fixture project loaded. */
function makeDirector(options = {}) {
  const restore = installSceneRuntime(options.project);
  const viewer = fakeViewer();
  const styleManager = fakeStyleManager(options.style);
  const dataManager = fakeDataManager(options.data);
  const director = new SceneDirector(viewer, styleManager, dataManager, {
    isMapStackAvailable: options.isMapStackAvailable,
  });
  // Telemetry is only accumulated during a run; observable-failure assertions
  // need the accumulator without driving a whole run.
  director._activeRun = { events: [] };
  return { director, viewer, styleManager, dataManager, restore };
}

test('only Play Shot or a scene run grants transient media authority; LOAD, Stop and replacement revoke it', async () => {
  const { director, dataManager, restore } = makeDirector();
  let owner = null;
  const owners = [];
  dataManager.layers = new Map([
    [
      'flights',
      {
        module: {
          setSceneMediaPlayback(value = null) {
            owner = value;
            if (value) owners.push(value.shotId);
          },
        },
      },
    ],
  ]);
  try {
    await director.loadShot('scene-1', 'shot-a', { flyDuration: 0 });
    assert.equal(owner, null, 'passive LOAD is not playback');
    await director.replayShot('scene-1', 'shot-a');
    assert.equal(owner?.shotId, 'shot-a');
    assert.equal(owner.token.cancelled, false);
    await director.loadShot('missing-scene', 'missing-shot');
    assert.equal(
      owner?.shotId,
      'shot-a',
      'rejected navigation does not revoke another action',
    );
    director._running = true;
    await director.loadShot('scene-1', 'shot-b');
    assert.equal(
      owner?.shotId,
      'shot-a',
      'LOAD refused during a run cannot stop its media',
    );
    director._running = false;
    await director.loadShot('scene-1', 'shot-b', { flyDuration: 0 });
    assert.equal(owner, null, 'replacement LOAD revokes the prior replay');
    await director.replayShot('scene-1', 'shot-a');
    director.stopScene();
    assert.equal(owner, null);
    director._sleep = async () => {};
    owners.length = 0;
    await director.startScene('scene-1', { single: true, preview: false });
    assert.deepEqual(
      owners,
      ['shot-a'],
      'only enabled opt-in layers receive playback authority',
    );
    assert.equal(owner, null, 'run completion releases the last shot owner');
  } finally {
    await director.destroy();
    restore();
  }
});

test('cross-scene replay grants media ownership only after the previous scene releases its layers', async () => {
  const { director, dataManager, restore } = makeDirector();
  let owner = null;
  const events = [];
  const media = {
    setSceneMediaPlayback(value = null) {
      owner = value;
    },
  };
  dataManager.layers = new Map([['flights', { module: media }]]);
  const setEnabled = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, enabled, options) => {
    if (id === 'flights') {
      events.push({ enabled, owner: owner?.shotId ?? null });
      if (!enabled) media.setSceneMediaPlayback();
    }
    return setEnabled(id, enabled, options);
  };
  try {
    const previous = director._project.scenes[0];
    previous.releaseLayerIds = ['flights'];
    const target = structuredClone(previous);
    target.id = 'other-media-scene';
    director._project.scenes.push(target);
    await director.loadShot(previous.id, 'shot-a', { flyDuration: 0 });
    events.length = 0;
    const result = await director.replayShot(target.id, 'shot-a');
    assert.equal(result.started, true);
    assert.deepEqual(
      events.slice(0, 2),
      [
        { enabled: false, owner: null },
        { enabled: true, owner: 'shot-a' },
      ],
      'old-scene disable must finish before granting the new owner',
    );
    assert.equal(owner?.sceneId, target.id);
    assert.equal(owner?.token.cancelled, false);
    director.stopScene();
    assert.equal(owner, null);
  } finally {
    await director.destroy();
    restore();
  }
});

test('scene camera waits for provider completion and fade rather than the saved media hold', async () => {
  const { director, viewer, dataManager, restore } = makeDirector();
  let release;
  let pending = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const scene = director._project.scenes[0];
    scene.shots[0].layers.flights.params = { beatId: 'trimmed' };
    dataManager.layers = new Map([
      [
        'flights',
        {
          module: {
            getSceneShotMediaHold: (id) =>
              id === 'trimmed' ? { pending, maxWaitMs: 20000 } : null,
          },
        },
      ],
    ]);
    const waits = [];
    director._sleep = async (ms) => {
      waits.push(ms);
      if (ms === 70) await gate;
    };
    const run = director.startScene('scene-1', {
      single: true,
      preview: false,
    });
    await settle(40);
    assert.equal(
      viewer.flights.length,
      1,
      'no next flight while source is starting, playing or fading',
    );
    assert.deepEqual(waits, [70]);
    pending = false;
    release();
    await run;
    assert.equal(
      viewer.flights.length,
      2,
      'the next shot starts immediately after owned media completion',
    );
  } finally {
    release();
    await director.destroy();
    restore();
  }
});

test('Stop cancels a provider-owned shot hold and late completion cannot fly the next camera', async () => {
  const { director, viewer, dataManager, restore } = makeDirector();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    dataManager.layers = new Map([
      [
        'flights',
        {
          module: {
            getSceneShotMediaHold: () => ({ pending: true, maxWaitMs: 20000 }),
          },
        },
      ],
    ]);
    director._sleep = () => gate;
    const run = director.startScene('scene-1', {
      single: true,
      preview: false,
    });
    await settle(40);
    assert.equal(viewer.flights.length, 1);
    director.stopScene('test stop');
    release();
    await run;
    assert.equal(viewer.flights.length, 1);
    assert.equal(director.running, false);
  } finally {
    release();
    await director.destroy();
    restore();
  }
});

test('a provider-owned hold fails boundedly if its owner never settles', async () => {
  const { director, restore } = makeDirector();
  try {
    director.dataManager.layers = new Map([
      [
        'flights',
        {
          module: {
            getSceneShotMediaHold: () => ({ pending: true, maxWaitMs: 0 }),
          },
        },
      ],
    ]);
    const scene = director._project.scenes[0];
    await assert.rejects(
      director._holdShot(scene, scene.shots[0], { cancelled: false }),
      /bounded playback window/,
    );
  } finally {
    await director.destroy();
    restore();
  }
});

/** The layer map a shipped recipe declares, in normalized form. */
function recipeLayers(recipeId) {
  const recipe = SCENE_RECIPES.find((item) => item.id === recipeId);
  return Object.fromEntries(
    Object.entries(recipe.layers).map(([id, enabled]) => [id, { enabled }]),
  );
}

test('destroyed directors refuse seek, replay, adjacent and continuation without writes', async () => {
  const { director, viewer, dataManager, restore } = makeDirector();
  try {
    await director.destroy();
    director._loadedSceneId = 'scene-1';
    assert.equal(await director.seekScene('scene-1', 0), false);
    assert.equal(
      (await director.replayShot('scene-1', 'shot-a')).started,
      false,
    );
    assert.equal(
      await director.loadAdjacentShot('scene-1', 'shot-a', 1),
      false,
    );
    assert.equal(
      (await director.continueScene('scene-1', 'shot-a')).started,
      false,
    );
    assert.equal(viewer.flights.length, 0);
    assert.equal(dataManager.setParamsCalls.length, 0);
  } finally {
    restore();
  }
});

test('replay, adjacent and seek report layer refusal rather than success', async () => {
  const { director, restore } = makeDirector({ data: { refuse: () => true } });
  try {
    assert.equal(
      (await director.replayShot('scene-1', 'shot-a')).started,
      false,
    );
    assert.equal(
      await director.loadAdjacentShot('scene-1', 'shot-a', 1),
      false,
    );
    assert.equal(await director.seekScene('scene-1', 0), false);
  } finally {
    await director.destroy();
    restore();
  }
});

test('a seek waiting for run teardown is revoked by newer Stop, Load, Start or destroy', async () => {
  for (const action of ['stop', 'load', 'start', 'destroy']) {
    const { director, restore } = makeDirector();
    try {
      let release;
      director._waitForRunIdle = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      director._running = true;
      director._runToken = { cancelled: false };
      const seek = director.seekScene('scene-1', 0);
      assert.equal(director._pendingWork.has(seek), true);
      let newer;
      if (action === 'stop') director.stopScene();
      if (action === 'load') newer = director.loadShot('scene-1', 'shot-b');
      if (action === 'start') newer = director.startScene('scene-1');
      if (action === 'destroy') newer = director.destroy();
      director._running = false;
      release();
      assert.equal(await seek, false, action);
      await newer;
    } finally {
      await director.destroy();
      restore();
    }
  }
});

test('explicit scene-layer OFF revokes continuation during enable, flight and hold; internal OFF does not', async () => {
  for (const phase of ['enable', 'flight', 'hold']) {
    const { director, dataManager, restore } = makeDirector();
    try {
      director._project.scenes[0].releaseLayerIds = ['flights'];
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      if (phase === 'enable') {
        const enable = dataManager.setEnabled.bind(dataManager);
        dataManager.setEnabled = async (...args) => {
          await gate;
          return enable(...args);
        };
      } else if (phase === 'flight') director._flyCamera = () => gate;
      else director._sleep = () => gate;
      director._project.scenes[0].shots[0].holdSec = 1;
      const run = director.startScene('scene-1', {
        single: true,
        preview: false,
      });
      await settle(40);
      const token = director._runToken;
      dataManager.visibilityListener({
        layerId: 'flights',
        enabled: false,
        origin: 'scene',
      });
      assert.equal(token.cancelled, false);
      dataManager.visibilityListener({
        layerId: 'flights',
        enabled: false,
        origin: 'user',
      });
      assert.equal(token.cancelled, true, phase);
      dataManager.visibilityListener({
        layerId: 'flights',
        enabled: false,
        origin: 'tool',
      });
      release();
      await run;
      assert.equal(
        dataManager.committed.some(
          ({ id, enabled }) => id === 'traffic' && enabled,
        ),
        false,
      );
    } finally {
      await director.destroy();
      restore();
    }
  }
});

test('scene preview owns recording chrome while panel playback leaves it available', async () => {
  for (const preview of [true, false]) {
    const { director, styleManager, restore } = makeDirector();
    const recording = [];
    const playback = [];
    let release;
    const flight = new Promise((resolve) => {
      release = resolve;
    });
    director._flyCamera = () => flight;
    styleManager.setRecordingMode = (active) => recording.push(active);
    director._setPlaybackActive = (active) => playback.push(active);
    try {
      const run = director.startScene('scene-1', { single: true, preview });
      await settle(40);
      assert.deepEqual(recording, preview ? [true] : []);
      assert.deepEqual(playback, preview ? [true] : []);
      director.stopScene();
      release();
      await run;
      assert.deepEqual(recording, preview ? [true, false] : []);
      assert.deepEqual(playback, preview ? [true, false] : []);
    } finally {
      release();
      await director.destroy();
      restore();
    }
  }
});

test('the director reconciles only the layers a shot declares', async () => {
  // Regression: _applyLayerStates walked the LIVE registry and forced every
  // undeclared layer off, tearing down CCTV/vessels/fires with no restore pass.
  // Pinned here rather than only on the helper, because the walk lived here.
  const { director, dataManager, restore } = makeDirector();
  try {
    await director._applyLayerStates({
      flights: { enabled: true },
      satellites: { enabled: false },
    });
    assert.deepEqual(
      dataManager.setEnabledCalls.map(({ id, enabled }) => ({ id, enabled })),
      [
        { id: 'flights', enabled: true },
        { id: 'satellites', enabled: false },
      ],
    );
  } finally {
    restore();
  }
});

test('a shot captured while tracking never re-establishes tracking on playback', async () => {
  // Two writers on the camera is the documented jitter failure mode: the scene
  // claims the camera, then a captured tracking id hands it straight back to
  // the follow loop. Playback drops those keys on the way to the layer.
  const { director, dataManager, restore } = makeDirector();
  try {
    await director._applyLayerStates({
      flights: {
        enabled: true,
        params: { models3d: true, selectedFlightsTrackingId: 'a835af' },
      },
      military: {
        enabled: true,
        params: { selectedMilitaryTrackingId: 'ae1460' },
      },
      satellites: {
        enabled: true,
        params: { catalog: 'dense', selectedSatTrackingId: 25544 },
      },
    });

    const pushed = Object.fromEntries(
      dataManager.setParamsCalls.map((call) => [call.id, call.params]),
    );
    assert.deepEqual(pushed.flights, { models3d: true });
    assert.deepEqual(pushed.satellites, { catalog: 'dense' });
    // Nothing survived military's params, so nothing is pushed at all.
    assert.equal(Object.hasOwn(pushed, 'military'), false);
    for (const call of dataManager.setParamsCalls) {
      for (const key of SCENE_TRACKING_PARAM_KEYS) {
        assert.equal(
          Object.hasOwn(call.params, key),
          false,
          `${call.id} leaked ${key}`,
        );
      }
    }
  } finally {
    restore();
  }
});

test('a dirty Space Missions state is exited before a recipe applies its layers', async () => {
  // Space Missions refuses every enable outside its own replay bundle. The old
  // full-registry walk dismantled it by accident; the sparse policy never does,
  // so all four Flights Radar enables were refused and reported as success.
  const style = { contextMode: 'space-missions' };
  const holder = {};
  const data = {
    refuse: (id, on) =>
      on &&
      holder.styleManager?.contextMode === 'space-missions' &&
      !SPACE_MISSIONS_ALLOWED.has(id),
  };
  const { director, styleManager, dataManager, restore } = makeDirector({
    style,
    data,
  });
  holder.styleManager = styleManager;
  try {
    const result = await director._applyLayerStates(
      recipeLayers('flights-radar'),
    );

    assert.deepEqual(styleManager.contextExits, ['off']);
    assert.equal(styleManager.contextMode, null);
    assert.deepEqual(result.refused, []);
    assert.ok(result.applied.includes('flights'));
    assert.deepEqual(
      dataManager.setEnabledCalls
        .filter((call) => call.enabled)
        .map((call) => call.id),
      ['flights'],
    );
  } finally {
    restore();
  }
});

test('Orbital Watch does not compose over a Space Missions replay', async () => {
  // Orbital Watch declares satellites, which the guard permits — so nothing is
  // refused and a refusal-only check would pass while rocket-launches stayed
  // on screen. Playback leaves an isolating mode whether or not it refuses.
  const { director, styleManager, dataManager, restore } = makeDirector({
    style: { contextMode: 'space-missions' },
  });
  try {
    await director._applyLayerStates(recipeLayers('orbital-watch'));
    assert.deepEqual(styleManager.contextExits, ['off']);
    assert.equal(
      dataManager.setEnabledCalls.some((call) => call.id === 'rocket-launches'),
      false,
      'the recipe never declares rocket-launches; exiting the mode is what clears it',
    );
  } finally {
    restore();
  }
});

test('a non-isolating context mode is left alone', async () => {
  for (const contextMode of [null, 'flights']) {
    const { director, styleManager, restore } = makeDirector({
      style: { contextMode },
    });
    try {
      await director._applyLayerStates({ flights: { enabled: true } });
      assert.deepEqual(
        styleManager.contextExits,
        [],
        `${contextMode} must not be exited`,
      );
    } finally {
      restore();
    }
  }
});

test('a refused layer is reported, never counted as applied', async () => {
  const { director, dataManager, restore } = makeDirector({
    data: { refuse: (id) => id === 'flights' },
  });
  try {
    const result = await director._applyLayerStates({
      flights: { enabled: true, params: { models3d: true } },
      traffic: { enabled: false },
    });

    assert.deepEqual(result.refused, ['flights']);
    assert.deepEqual(result.applied, ['traffic']);
    // Params must not be pushed at a layer whose transition was vetoed.
    assert.deepEqual(dataManager.setParamsCalls, []);
    const refusals = director._activeRun.events.filter(
      (event) => event.type === 'shot_layers_refused',
    );
    assert.equal(refusals.length, 1);
    assert.deepEqual(refusals[0].payload, { layerIds: ['flights'] });
  } finally {
    restore();
  }
});

test('cancellation between two layers ends the reconcile where it stands', async () => {
  const { director, dataManager, restore } = makeDirector();
  const token = { cancelled: false };
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, on) => {
    const settled = await inner(id, on);
    if (id === 'flights') token.cancelled = true;
    return settled;
  };
  try {
    const result = await director._applyLayerStates(
      {
        flights: { enabled: true },
        satellites: { enabled: true },
        traffic: { enabled: true },
      },
      token,
    );

    assert.deepEqual(
      dataManager.setEnabledCalls.map((call) => call.id),
      ['flights'],
    );
    assert.equal(result.cancelled, true);
  } finally {
    restore();
  }
});

test('STOP during a suspended visual transition lands no layer changes', async () => {
  // Repro shape from review: applyVisualState suspends (a map-stack switch),
  // STOP arrives, the visual resolves — and the shot's layer pass still ran.
  const { director, viewer, styleManager, dataManager, restore } =
    makeDirector();
  let releaseVisual;
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    return new Promise((resolve) => {
      releaseVisual = resolve;
    });
  };
  try {
    const run = director.startScene('scene-1', { single: true });
    await settle();
    assert.equal(
      styleManager.visualStates.length,
      1,
      'the run must be parked on the visual await',
    );

    director.stopScene('Stopped (Esc)');
    releaseVisual();
    await run;

    assert.deepEqual(dataManager.setEnabledCalls, []);
    assert.deepEqual(viewer.flights, []);
    assert.equal(director.running, false);
  } finally {
    restore();
  }
});

test('STOP between two layers lands no further layer changes', async () => {
  const { director, dataManager, restore } = makeDirector({
    project: {
      version: 3,
      scenes: [
        {
          id: 'scene-1',
          title: 'Fixture Scene',
          shots: [
            {
              id: 'shot-a',
              title: 'Shot A',
              durationSec: 0.2,
              holdSec: 0,
              camera: {
                lat: 10,
                lon: 20,
                alt: 500000,
                heading: 0,
                pitch: -40,
                roll: 0,
              },
              visual: { style: 'normal' },
              layers: {
                flights: { enabled: true },
                satellites: { enabled: true },
                traffic: { enabled: true },
              },
            },
          ],
        },
      ],
    },
  });
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = async (id, on) => {
    const settled = await inner(id, on);
    if (id === 'flights') director.stopScene('Stopped (Esc)');
    return settled;
  };
  try {
    await director.startScene('scene-1', { single: true });
    assert.deepEqual(
      dataManager.setEnabledCalls.map((call) => call.id),
      ['flights'],
    );
  } finally {
    restore();
  }
});

test('STOP aborts the layer transition in flight, not merely the next one', async () => {
  // Checking the token AFTER the await is a backstop, not the fix: by then an
  // un-aborted transition has already committed, and the pass returns without
  // its params — the layer left enabled carrying stale ones. The signal is
  // what actually stops the layer that is currently moving.
  const { director, dataManager, restore } = makeDirector({
    project: {
      version: 3,
      scenes: [
        {
          id: 'scene-1',
          title: 'Fixture Scene',
          shots: [
            {
              id: 'shot-a',
              title: 'Shot A',
              durationSec: 0.2,
              holdSec: 0,
              camera: {
                lat: 10,
                lon: 20,
                alt: 500000,
                heading: 0,
                pitch: -40,
                roll: 0,
              },
              visual: { style: 'normal' },
              layers: {
                flights: { enabled: true, params: { models3d: true } },
                satellites: { enabled: true },
              },
            },
          ],
        },
      ],
    },
  });
  const inner = dataManager.setEnabled.bind(dataManager);
  dataManager.setEnabled = (id, on, options) => {
    // STOP lands while the transition is in flight, before it can commit.
    if (id === 'flights') director.stopScene('Stopped (Esc)');
    return inner(id, on, options);
  };
  try {
    await director.startScene('scene-1', { single: true });

    assert.equal(
      dataManager.setEnabledCalls.length,
      1,
      'only the in-flight layer is touched',
    );
    assert.ok(
      dataManager.setEnabledCalls[0].signal instanceof AbortSignal,
      'the run must hand its abort signal to every transition',
    );
    assert.equal(
      dataManager.setEnabledCalls[0].signal.aborted,
      true,
      'STOP must abort that signal',
    );
    assert.deepEqual(
      dataManager.committed,
      [],
      'an aborted transition must not commit',
    );
    assert.deepEqual(
      dataManager.setParamsCalls,
      [],
      'no params for a layer that never moved',
    );
  } finally {
    restore();
  }
});

test('a newer LOAD aborts the previous LOAD transition rather than disowning it', async () => {
  const { director, styleManager, dataManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => {
      gates.push(resolve);
    });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    await settle();
    const second = director.loadShot('scene-1', 'shot-b');
    gates[0]();
    gates[1]();
    await Promise.all([first, second]);

    // Only the newer LOAD reconciled, and it carried a live (unaborted) signal.
    assert.deepEqual(
      dataManager.setEnabledCalls.map((call) => call.id),
      ['traffic'],
    );
    assert.ok(dataManager.setEnabledCalls[0].signal instanceof AbortSignal);
    assert.equal(dataManager.setEnabledCalls[0].signal.aborted, false);
  } finally {
    restore();
  }
});

test('applyVisualState gates the map-stack switch on both sides of its await', () => {
  // The other half of the contract, and the half these doubles cannot see.
  // ui.js cannot be imported here (its mgrs dependency is CJS), so this pins
  // the structure the way the repo pins other cross-module shape
  // (cockpitMarkup.test.mjs), while qa-shots/scenes-audit.mjs proves the
  // BEHAVIOUR against the real StyleManager in a browser.
  //
  // Gating only the post-await uniform commit is not enough: the stack switch
  // is ITSELF a mutation. The controller invalidates a switch only when
  // another setStack() arrives, and a winning state that omits `mapStack`
  // never issues one — every normalized scene shot omits it — so a stale
  // switch would otherwise stand on the globe.
  const source = readShellSource();
  const method = source.match(
    /\n {2}async applyVisualState\([\s\S]*?\n {2}\}\n/,
  );
  assert.ok(method, 'applyVisualState is missing from ui.js');
  assert.match(
    method[0],
    /async applyVisualState\(state = \{\}, \{ isCurrent = null \} = \{\}\)/,
  );

  const mapStackBlock = method[0].match(
    /if \(state\.mapStack\) \{[\s\S]*?\n {4}\}/,
  );
  assert.ok(
    mapStackBlock,
    'the map-stack block is missing from applyVisualState',
  );
  const block = mapStackBlock[0];

  // Before: an already-superseded caller must not start the switch at all.
  assert.match(
    block,
    /if \(superseded\(\)\) return false;\s*const stackBefore =/,
    'the switch must be skipped outright when the caller is already superseded',
  );
  // After: supersession that landed DURING the switch must put the globe back.
  assert.match(
    block,
    /await this\._setMapStack\(state\.mapStack[\s\S]*?if \(superseded\(\)\) \{[\s\S]*?await this\._setMapStack\(stackBefore/,
    'a switch superseded mid-flight must be reverted to the stack the winner inherited',
  );
  // And only what is still ours — a newer switch owns the globe, never revert it.
  assert.match(
    block,
    /getSwitchGeneration/,
    'the revert must consult the switch generation',
  );
  assert.match(
    block,
    /if \(globeIsStillOurs && stackBefore && landed !== stackBefore\) \{\s*await this\._setMapStack\(stackBefore/,
    'the revert must be guarded by the generation check and the stack that actually landed',
  );
});

test('a superseded LOAD is refused its visual commit', async () => {
  // applyVisualState suspends on a map-stack switch and writes its shader
  // uniforms AFTER that await. A stale LOAD resuming there would commit the
  // look of a shot the operator has already moved past, so the director hands
  // it a liveness predicate that is false by the time it would commit.
  const { director, styleManager, restore } = makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => {
      gates.push(resolve);
    });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    const second = director.loadShot('scene-1', 'shot-b');
    gates[1]();
    await settle();
    gates[0]();
    await Promise.all([first, second]);

    const [stale, live] = styleManager.visualCalls;
    assert.equal(
      typeof stale.isCurrent,
      'function',
      'the visual call must carry a liveness predicate',
    );
    assert.equal(
      stale.isCurrent(),
      false,
      'the superseded LOAD must be refused its commit',
    );
    assert.equal(
      live.isCurrent(),
      true,
      'the live LOAD must still be allowed to commit',
    );
  } finally {
    restore();
  }
});

test('a run refuses the visual commit of a shot cancelled mid-transition', async () => {
  const { director, styleManager, restore } = makeDirector();
  let releaseVisual;
  styleManager.applyVisualState = (visual, options = {}) => {
    styleManager.visualCalls.push({ visual, isCurrent: options.isCurrent });
    return new Promise((resolve) => {
      releaseVisual = resolve;
    });
  };
  const run = director.startScene('scene-1', { single: true });
  try {
    await settle();
    const call = styleManager.visualCalls[0];
    assert.equal(
      typeof call.isCurrent,
      'function',
      'the visual call must carry a liveness predicate',
    );
    assert.equal(call.isCurrent(), true, 'live while the run owns the shot');

    director.stopScene('Stopped (Esc)');
    assert.equal(
      call.isCurrent(),
      false,
      'STOP must revoke the pending commit',
    );
  } finally {
    // Always let the run finish: _finishRun() owns the progress interval, so a
    // failed assertion that skipped this would leave a live timer behind and
    // hang the suite instead of reporting.
    director.stopScene('cleanup');
    releaseVisual?.();
    await run;
    restore();
  }
});

test('the newest LOAD wins when two loads race', async () => {
  // Both loads suspend on their visual await; the OLDER one resolves second.
  // Without a generation it completes last and overwrites the newer intent.
  const { director, viewer, styleManager, dataManager, restore } =
    makeDirector();
  const gates = [];
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    return new Promise((resolve) => {
      gates.push(resolve);
    });
  };
  try {
    const first = director.loadShot('scene-1', 'shot-a');
    const second = director.loadShot('scene-1', 'shot-b');
    assert.equal(gates.length, 2);

    gates[1]();
    await settle();
    gates[0]();
    await Promise.all([first, second]);

    assert.deepEqual(
      dataManager.setEnabledCalls.map(({ id, enabled }) => ({ id, enabled })),
      [{ id: 'traffic', enabled: true }],
    );
    assert.equal(viewer.flights.length, 1);
    assert.equal(director._selectedShotId, 'shot-b');
  } finally {
    restore();
  }
});

test('a scene run supersedes a LOAD still suspended on its visual await', async () => {
  const { director, styleManager, dataManager, restore } = makeDirector();
  let releaseLoadVisual;
  let calls = 0;
  styleManager.applyVisualState = (visual) => {
    styleManager.visualStates.push(visual);
    if (++calls === 1)
      return new Promise((resolve) => {
        releaseLoadVisual = resolve;
      });
    return Promise.resolve();
  };
  try {
    const load = director.loadShot('scene-1', 'shot-a');
    await settle();
    const run = director.startScene('scene-1', { single: true });
    releaseLoadVisual();
    await Promise.all([load, run]);

    // Only the run's own shots reconciled; the stale LOAD's flights never did.
    assert.deepEqual(
      dataManager.setEnabledCalls.map((call) => call.id),
      ['flights', 'traffic'],
    );
  } finally {
    restore();
  }
});

test('destroy drains cancelled LOAD work before its viewer can be discarded', async (t) => {
  const restore = installSceneRuntime();
  t.after(restore);
  let finishVisual;
  const dataManager = fakeDataManager();
  const viewer = { camera: { cancelFlight() {} } };
  const director = new SceneDirector(
    viewer,
    {
      applyVisualState: () =>
        new Promise((resolve) => {
          finishVisual = resolve;
        }),
    },
    dataManager,
  );
  const loading = director.loadShot('scene-1', 'shot-a');
  let destroyed = false;
  const stopping = director.destroy().then(() => {
    destroyed = true;
  });
  await Promise.resolve();
  assert.equal(destroyed, false);
  finishVisual();
  await Promise.all([loading, stopping]);
  assert.equal(destroyed, true);
  assert.equal(dataManager.setEnabledCalls.length, 0);
  assert.equal((await director.startScene('scene-1')).reason, 'destroyed');
  await director.destroy();
});

test('Scene snapshots are immutable and editing outcomes retain the affected shot and index', async () => {
  const { director, restore } = makeDirector();
  try {
    director._activeRun = null;
    const seen = [];
    const unsubscribe = director.subscribe((notification) =>
      seen.push(notification),
    );
    assert.equal(seen[0].initial, true);
    assert.equal(seen[0].state.selectedShotId, 'shot-a');
    assert.ok(Object.isFrozen(seen[0].state));
    director.captureShot();
    const captured = seen.find(
      ({ change }) => change?.type === 'shot-captured',
    );
    assert.equal(captured.change.index, 2);
    assert.ok(Object.isFrozen(captured.change.shot.camera));
    const id = captured.change.shot.id;
    director.deleteShot('scene-1', id);
    const deleted = seen.find(({ change }) => change?.type === 'shot-deleted');
    assert.equal(deleted.change.index, 2);
    assert.equal(deleted.change.shot.id, id);
    assert.equal(captured.state.selectedShotId, id);
    unsubscribe();
    const count = seen.length;
    director.captureShot();
    assert.equal(seen.length, count);
    await director.destroy();
  } finally {
    restore();
  }
});

test('Scene load outcomes exclude superseded and disposed completions', async () => {
  const { director, styleManager, restore } = makeDirector();
  try {
    director._activeRun = null;
    const seen = [];
    director.subscribe(({ change }) => {
      if (change) seen.push(change);
    });
    const pending = [];
    styleManager.applyVisualState = () =>
      new Promise((resolve) => pending.push(resolve));
    const old = director.loadShot('scene-1', 'shot-a');
    const current = director.loadShot('scene-1', 'shot-b');
    pending[1]();
    await current;
    pending[0]();
    await old;
    assert.deepEqual(
      seen
        .filter((change) => change.type === 'shot-loaded')
        .map((change) => change.shot.id),
      ['shot-b'],
    );
    const late = director.loadShot('scene-1', 'shot-a');
    const disposal = director.destroy();
    const count = seen.length;
    pending[2]();
    await Promise.all([late, disposal]);
    director.subscribe(() => assert.fail('disposed director must not notify'));
    assert.equal(seen.length, count);
  } finally {
    restore();
  }
});

test('invalid and unsupported imports retain the current project, selection and saved bytes', async () => {
  const { director, restore } = makeDirector();
  try {
    const project = director._project;
    const selected = director._selectedShotId;
    const saved = localStorage.getItem('godsEyeView.sceneProject.v2');
    for (const value of [
      '{}',
      '{"version":99,"scenes":[]}',
      '{"scenes":[{"shots":"bad"}]}',
    ]) {
      await director.importProjectFile({
        name: 'bad.json',
        text: async () => value,
      });
      assert.equal(director._project, project);
      assert.equal(director._selectedShotId, selected);
      assert.equal(localStorage.getItem('godsEyeView.sceneProject.v2'), saved);
      assert.match(director._presentation.status, /Import failed: \$/);
    }
    let read = false;
    await director.importProjectFile({
      size: 6 * 1024 * 1024,
      text: async () => {
        read = true;
      },
    });
    assert.equal(read, false);
    assert.equal(director._project, project);
  } finally {
    restore();
  }
});

test('newer imports win delayed file reads, and an empty project is preserved', async () => {
  const { director, restore } = makeDirector();
  try {
    let release;
    const older = director.importProjectFile({
      name: 'old.json',
      text: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await director.importProjectFile({
      name: 'empty.json',
      text: async () => '{"version":3,"scenes":[]}',
    });
    release(JSON.stringify(PROJECT_FIXTURE));
    await older;
    assert.deepEqual(director._project.scenes, []);
    assert.equal(director._selectedSceneId, null);
    assert.deepEqual(
      JSON.parse(localStorage.getItem('godsEyeView.sceneProject.v2')).scenes,
      [],
    );
  } finally {
    restore();
  }
});

test('unsupported stored documents cannot be overwritten by fallback edits', async () => {
  const { director, restore } = makeDirector({
    project: { version: 99, scenes: [] },
  });
  try {
    const saved = localStorage.getItem('godsEyeView.sceneProject.v2');
    assert.ok(director._storageReadError);
    director._project.scenes[0].title = 'Fallback edit';
    director._saveProject();
    assert.equal(localStorage.getItem('godsEyeView.sceneProject.v2'), saved);
    await director.importProjectFile({
      name: 'valid.json',
      text: async () => JSON.stringify(PROJECT_FIXTURE),
    });
    assert.equal(director._storageReadError, null);
    assert.equal(
      JSON.parse(localStorage.getItem('godsEyeView.sceneProject.v2')).version,
      6,
    );
  } finally {
    restore();
  }
});

test('valid import settles a cancelled load before replacing the project', async () => {
  const { director, styleManager, restore } = makeDirector();
  let release;
  styleManager.applyVisualState = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  try {
    const before = director._project;
    const load = director.loadShot('scene-1', 'shot-a');
    await settle();
    const importing = director.importProjectFile({
      name: 'empty.json',
      text: async () => '{"version":3,"scenes":[]}',
    });
    await settle();
    assert.equal(director._project, before, 'old work still owns cleanup');
    release(true);
    await Promise.all([load, importing]);
    assert.deepEqual(director._project.scenes, []);
    assert.equal(director._pendingWork.size, 0);
    assert.equal(director.getPlaybackTimingState().activeTimers, 0);
  } finally {
    restore();
  }
});

test('a delayed import cannot publish after disposal', async () => {
  const { director, restore } = makeDirector();
  let release;
  try {
    const before = director._project;
    const reading = director.importProjectFile({
      name: 'empty.json',
      text: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await director.destroy();
    release('{"version":3,"scenes":[]}');
    await reading;
    assert.equal(director._project, before);
  } finally {
    restore();
  }
});

test('invalid authored edits cannot persist an unreadable project over a good save', () => {
  const { director, restore } = makeDirector();
  try {
    const before = localStorage.getItem('godsEyeView.sceneProject.v2');
    let notice;
    director._toastStorageError = (message) => {
      notice = message;
    };
    director._project.scenes[0].shots[0].camera.lat = 91;
    director._saveProject();
    assert.equal(localStorage.getItem('godsEyeView.sceneProject.v2'), before);
    assert.match(notice, /camera.lat/);
  } finally {
    restore();
  }
});

test('zero camera pitch is preserved by both immediate placement and ordinary flight', async () => {
  const { director, viewer, restore } = makeDirector();
  try {
    let placed;
    viewer.camera.setView = (options) => {
      placed = options;
    };
    const pose = { lat: 10, lon: 20, alt: 500, heading: 0, pitch: 0, roll: 0 };
    director._setCameraView(pose);
    assert.equal(placed.orientation.pitch, 0);
    await director._flyCamera(pose, 0.2, { cancelled: false });
    assert.equal(viewer.flights.at(-1).orientation.pitch, 0);
  } finally {
    restore();
  }
});

test('camera refusal starts no authored frame or playback clock', async () => {
  const { director, styleManager, viewer, restore } = makeDirector();
  try {
    const shot = director._project.scenes[0].shots[0];
    shot.move = {
      from: { ...shot.camera, altitudeReference: 'ellipsoid' },
      easing: 'linear',
    };
    styleManager.runImmediateNavigation = () => false;
    assert.equal(
      (await director.startScene('scene-1', { single: true })).reason,
      'camera-unavailable',
    );
    assert.equal(director._cameraMotion.active, false);
    assert.equal(director.getPlaybackTimingState().activeTimers, 0);
    assert.deepEqual(viewer.flights, []);
  } finally {
    restore();
  }
});
