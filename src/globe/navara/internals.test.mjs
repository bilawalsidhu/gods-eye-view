import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';

// The package's browser entry needs WebGL; only its prototype matters here.
const sdkStub =
  'data:text/javascript,export class ModelMesh { _releaseGeometryArrays() {} }';
const loader = registerHooks({
  resolve(specifier, context, next) {
    return specifier === '@navaramap/three'
      ? { url: sdkStub, shortCircuit: true }
      : next(specifier, context);
  },
});
const { navaraHooks, forEachLuminanceUniform } = await import('./internals.js');
loader.deregister();
const { ModelMesh } = await import(sdkStub);

const here = new URL('./', import.meta.url);
const read = (name) => readFileSync(new URL(name, here), 'utf8');

test('Navara internals are pinned: package.json and internals.js name the same exact version', () => {
  const pkg = JSON.parse(read('../../../package.json'));
  const declared = read('internals.js').match(
    /NAVARA_INTERNALS_VERSION = '([^']+)'/,
  )?.[1];
  assert.equal(declared, '0.2.1');
  for (const name of ['@navaramap/three', '@navaramap/three-default-plugin']) {
    assert.equal(pkg.dependencies[name], declared, name);
    const installed = JSON.parse(
      read(`../../../node_modules/${name}/package.json`),
    );
    assert.equal(installed.version, declared, `installed ${name}`);
  }
});

// `x._member`, `x?._member` and `x['_member']`.
const PRIVATE_ACCESS =
  /\.\s*_[A-Za-z]|\[\s*['"`]_[A-Za-z]|(?:\.\s*|\[\s*['"`])(?:viewContext|renderPassOrchestrator|cloudsPass|currentMaterial)\b/;

test('the private-member pattern catches dotted and bracketed access', () => {
  for (const code of [
    'view._isIdle',
    'view?._scenes',
    "view['_isIdle']",
    'v[ "_x" ]',
    'view.viewContext',
    "ctx['renderPassOrchestrator']",
    'clouds.rawEffect.cloudsPass.currentMaterial',
  ])
    assert.ok(PRIVATE_ACCESS.test(code), code);
  for (const code of [
    'view.isIdle',
    'a_b.c',
    "map['key']",
    'aerial.ref.raw.rawEffect.blendMode.opacity',
  ])
    assert.ok(!PRIVATE_ACCESS.test(code), code);
});

test('only internals.js reaches private Navara members', () => {
  const offenders = readdirSync(here, { recursive: true }).filter(
    (name) =>
      name.endsWith('.js') &&
      name !== 'internals.js' &&
      PRIVATE_ACCESS.test(read(name).replace(/\/\/.*$/gm, '')),
  );
  assert.deepEqual(offenders, []);
});

function stubView() {
  return {
    _isIdle: false,
    _startMainLoop() {},
    _renderer: { setAnimationLoop() {} },
    _scenes: { mrt: { children: [] }, light: { children: [] } },
    _eventManager: {
      stacks: { renderable_feature_changed: [] },
      removeAt() {},
    },
    viewContext: {
      renderPassOrchestrator: { passMap: { list: [] } },
      findMesh() {},
      findEffect() {},
    },
  };
}

test('engine startup probes every required view internal', () => {
  const view = stubView();
  const hooks = navaraHooks(view);
  assert.equal(hooks.isIdle(), false);
  view._isIdle = true;
  assert.equal(hooks.isIdle(), true);
  for (const path of [
    '_isIdle',
    '_startMainLoop',
    '_renderer.setAnimationLoop',
    '_scenes.mrt.children',
    '_scenes.light.children',
    '_eventManager.stacks.renderable_feature_changed',
    '_eventManager.removeAt',
    'viewContext.findMesh',
    'viewContext.findEffect',
    'viewContext.renderPassOrchestrator.passMap.list',
  ]) {
    for (const value of [undefined, null, 42]) {
      const broken = stubView();
      const keys = path.split('.');
      const key = keys.pop();
      const parent = keys.reduce((object, name) => object[name], broken);
      if (value === undefined) delete parent[key];
      else parent[key] = value;
      assert.throws(
        () => navaraHooks(broken),
        (error) => {
          assert.ok(error.message.includes('Navara 0.2.1'));
          assert.ok(
            error.message.includes(
              path.replace(
                'viewContext.renderPassOrchestrator',
                'renderPassOrchestrator',
              ),
            ),
            error.message,
          );
          return true;
        },
      );
    }
  }
});

test('engine startup rejects a missing tile geometry release method', () => {
  const release = ModelMesh.prototype._releaseGeometryArrays;
  delete ModelMesh.prototype._releaseGeometryArrays;
  try {
    assert.throws(
      () => navaraHooks(stubView()),
      /Navara 0\.2\.1:.*ModelMesh\.prototype\._releaseGeometryArrays/,
    );
  } finally {
    ModelMesh.prototype._releaseGeometryArrays = release;
  }
});

test('lazy atmosphere materials reject missing private uniforms in every build', () => {
  for (const name of ['sky', 'stars', 'aerialPerspective', 'clouds']) {
    assert.doesNotThrow(() =>
      forEachLuminanceUniform({ [name]: { ref: {} } }, () => {}),
    );
    assert.throws(
      () => forEachLuminanceUniform({ [name]: { ref: { raw: {} } } }, () => {}),
      (error) =>
        error.message.includes('Navara 0.2.1') &&
        error.message.includes(`${name}.ref.raw.`),
    );
  }
});

test('engine startup checks the active look materials before the first frame', () => {
  for (const name of ['sky', 'stars', 'aerialPerspective', 'clouds']) {
    const view = stubView();
    const find = name === 'sky' || name === 'stars' ? 'findMesh' : 'findEffect';
    view.viewContext[find] = (key) => (key === name ? { raw: {} } : undefined);
    assert.throws(
      () => navaraHooks(view),
      (error) =>
        error.message.includes('Navara 0.2.1') &&
        error.message.includes(`${name}.ref.raw.`),
    );
  }
});

test('feature changes of a deleted vector layer leave the queue; live ones stay', async () => {
  const { dropOrphanFeatureChanges } = await import('./featureQueue.js');
  const freed = [];
  const change = (layerId) => ({
    layer_id: layerId,
    free: () => freed.push(layerId),
  });
  const events = [change('gone'), change('live'), change('gone'), change(null)];
  const queue = { events, remove: (index) => events.splice(index, 1) };
  assert.equal(
    dropOrphanFeatureChanges(queue, (id) => id === 'live'),
    2,
  );
  assert.deepEqual(
    events.map((event) => event.layer_id),
    ['live', null],
  );
  assert.deepEqual(freed, ['gone', 'gone']);
  // No queue, or an empty one, costs nothing.
  assert.equal(
    dropOrphanFeatureChanges(null, () => false),
    0,
  );
  assert.equal(
    dropOrphanFeatureChanges({ events: [], remove() {} }, () => false),
    0,
  );
});
