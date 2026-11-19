/**
 * The second ratchet, beside `noCesiumOutsideRender.test.mjs`: files off
 * the Cesium allow-list may not import Cesium, and they may not drive it
 * through the viewer either (`viewer.scene`, `scene.primitives`,
 * `viewer.trackedEntity`...). `viewerAccessAllowList.json` records, per
 * file, how many such accesses each still has; a file may have no more
 * than recorded (none, unrecorded), and a recorded count that is now too
 * high fails too, so the record only ever shrinks. What counts is in
 * `src/testSupport/viewerAccess.mjs`; `node scripts/viewer-access-baseline.mjs`
 * lowers the record to what the files now hold (it never raises it).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  BASELINE,
  countedFiles,
  currentHits,
  readBaseline,
  ROOT,
  UPDATE_COMMAND,
  viewerAccessHits,
} from '../testSupport/viewerAccess.mjs';

const baseline = readBaseline();
const hits = currentHits();

const describe = (file) =>
  (hits.get(file) ?? [])
    .map(({ line, access }) => `    ${file}:${line} ${access}`)
    .join('\n');

test('the matcher catches Cesium-shaped access through a viewer', () => {
  const caught = {
    'viewer.scene.requestRender();': 2,
    'viewer?.scene?.globe?.show;': 2,
    'this.viewer.camera.flyTo(x);': 1,
    'layerState._viewer.entities.add(e);': 1,
    'state.mainViewer.dataSources;': 1,
    'viewer.clock.currentTime;': 1,
    'viewer.imageryLayers.add(l);': 1,
    'viewer.terrainProvider;': 1,
    'viewer.trackedEntity = undefined;': 1,
    "viewer['scene'];": 1,
    'viewer[`camera`];': 1,
    'viewer?.["entities"];': 1,
    'viewer[name];': 1,
    'scene.primitives.add(p);': 1,
    'scene?.pick(position);': 1,
    'scene.drillPick(p, 8);': 1,
    'scene.preRender.addEventListener(f);': 1,
    'scene.postRender;': 1,
    'scene.preUpdate;': 1,
    'scene.postUpdate;': 1,
    'scene.canvas.style;': 1,
    'scene.camera;': 1,
    'this._scene.globe;': 1,
    'const { scene } = viewer;': 1,
    'const { scene: s, camera } = viewer;': 2,
    'let g; ({ globe: g } = viewer.scene);': 2,
    'const { primitives } = this.scene;': 1,
    '(viewer).scene;': 1,
    'viewer.canvas.style;': 1,
    'scene.pickPosition(p);': 1,
    'getViewer().scene;': 1,
    'this.getViewer?.().camera;': 1,
    'const { viewer: { scene } } = state;': 1,
    'function f({ viewer: { camera } }) {}': 1,
    'const { scene: { globe } = {} } = viewer;': 2,
    'const { [key]: e } = viewer;': 1,
    'function f({ camera } = viewer) {}': 1,
    'const { value: { camera } = viewer } = options;': 1,
  };
  for (const [source, count] of Object.entries(caught))
    assert.equal(viewerAccessHits(source).length, count, source);
  const allowed = [
    'viewer.container.append(el);',
    'viewer?.container;',
    'const { container } = viewer;',
    '// viewer.scene.requestRender();',
    '/* scene.primitives.add(p) */',
    "const s = 'viewer.scene';",
    'viewers[0];',
    'viewer.isDestroyed();',
    'scenes.camera;',
    'sceneDoc.camera;',
    'renderer.canvas;',
    'const v = viewer; v.something;',
    'camera.pose();',
    'cameraOf(viewer).flyTo(x);',
    'const { scene } = options;',
    'const { viewer: { container } } = state;',
    'getViewer().container;',
  ];
  for (const source of allowed)
    assert.deepEqual(viewerAccessHits(source), [], source);
});

test('off-list files reach through the viewer no more than recorded', () => {
  const over = [];
  for (const [file, found] of hits) {
    const allowed = baseline[file] ?? 0;
    if (found.length > allowed)
      over.push(
        `  ${file}: ${found.length} accesses, ${allowed} recorded\n${describe(file)}`,
      );
  }
  assert.deepEqual(
    over,
    [],
    `Cesium-shaped access through the viewer in files off the Cesium list.\n` +
      `Reach the renderer through its ports (src/render/rendererOf.js) instead;\n` +
      `${BASELINE} is never raised. A file that has just left the Cesium list\n` +
      `must port these in the same change.\n${over.join('\n')}`,
  );
});

test('the record holds no file that now has fewer accesses', () => {
  const counted = new Set(countedFiles());
  const stale = [];
  for (const [file, allowed] of Object.entries(baseline)) {
    const found = hits.get(file)?.length ?? 0;
    if (!counted.has(file))
      stale.push(`  ${file}: gone, a test, or on the Cesium list`);
    else if (found < allowed)
      stale.push(`  ${file}: ${allowed} recorded, ${found} found`);
  }
  assert.deepEqual(
    stale,
    [],
    `Lower ${BASELINE} to what the files hold (\`${UPDATE_COMMAND}\`):\n${stale.join('\n')}`,
  );
});

test('the record is sorted, with positive counts', () => {
  const files = Object.keys(baseline);
  assert.deepEqual(files, [...files].sort());
  for (const [file, count] of Object.entries(baseline))
    assert.ok(Number.isInteger(count) && count > 0, `${file}: ${count}`);
});

test('the record only shrinks', (t) => {
  // As for the Cesium list: only the record's confirmed absence on
  // origin/main (before it lands) skips this.
  const git = (...args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const base = git('merge-base', 'HEAD', 'origin/main').trim();
  if (!git('ls-tree', '--name-only', base, '--', BASELINE).trim()) {
    t.skip(`${BASELINE} is not on origin/main yet`);
    return;
  }
  const before = JSON.parse(git('show', `${base}:${BASELINE}`));
  const raised = Object.entries(baseline)
    .filter(([file, count]) => count > (before[file] ?? 0))
    .map(([file, count]) => `${file}: ${before[file] ?? 0} → ${count}`);
  assert.deepEqual(
    raised,
    [],
    `Raised in ${BASELINE} since ${base}: it is never raised; port the access instead.`,
  );
});
