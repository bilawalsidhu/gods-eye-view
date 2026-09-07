import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const html = read('index.html');
const main = read('src/main.js');
const mission = read('src/droneMission.js');

test('Drone View is explicitly simulated and exposes complete mission controls', () => {
  assert.match(html, /id="drone-mission-title">DRONE VIEW/);
  assert.match(html, /SIMULATED \/ DEMO ONLY/);
  for (const id of [
    'drone-set-launch',
    'drone-add-waypoint',
    'drone-set-destination',
    'drone-min-clearance',
    'drone-speed',
    'drone-max-climb',
    'drone-max-descent',
    'drone-confirm-launch',
    'drone-pause',
    'drone-abort',
    'drone-reset',
    'drone-replay',
    'drone-playback-speed',
    'drone-enter-view',
    'drone-exit-view',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  }
});

test('integration reuses annotation picking and the complete drone pipeline', () => {
  assert.match(main, /pickWorldFromScreen\(viewer, x, y\)/);
  assert.match(mission, /createTerrainSamplingPlan\(this\.route/);
  assert.match(mission, /sampleTerrain\(plan, this\.terrainSampler\)/);
  assert.match(mission, /createTerrainAwareProfile\(sampledTerrain, settings\)/);
  assert.match(mission, /new DroneMissionSimulator/);
  assert.match(mission, /createMissionEntitySnapshots\(\{/);
  assert.match(mission, /LAUNCH BLOCKED/);
  assert.match(mission, /preparationGeneration/);
  assert.match(mission, /this\.preparing/);
});
