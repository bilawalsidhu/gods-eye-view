import test from 'node:test';
import assert from 'node:assert/strict';
import { OrbitController } from './orbit.js';
import { GROUND_HARNESSES } from './testSupport/groundDisplayEngines.mjs';
import { createSceneServices, sceneServicesFor } from './data/sceneServices.js';
import { renderGovernorFor, governorRequestRender } from './renderGovernor.js';

for (const makeHarness of GROUND_HARNESSES) {
  test(`${makeHarness.name}: owner holds, installation and idle requests`, (t) => {
    const harness = makeHarness();
    const { engine } = harness;
    const services = createSceneServices(engine);
    const governor = services.render;
    t.after(() => { services.destroy(); harness.destroy(); });
    const requests = [];
    const request = engine.render.request;
    engine.render.request = (reason) => { requests.push(reason); request(reason); };
    assert.equal(renderGovernorFor(engine), governor);
    governor.holdContinuousRender('flights');
    governor.governorRequestRender('before-install');
    assert.equal(requests.length, 0);
    governor.install();
    assert.equal(engine.render.isContinuous(), true);
    governor.holdContinuousRender('flights');
    governor.holdContinuousRender('satellites');
    governor.governorRequestRender('while-held');
    assert.equal(requests.at(-1), 'while-held', 'requests forward even while held');
    assert.deepEqual(governor.getRenderGovernorDiagnostics().recentRequests, []);
    governor.releaseContinuousRender('flights');
    assert.equal(engine.render.isContinuous(), true);
    assert.deepEqual(governor.getRenderGovernorDiagnostics().holds, ['satellites']);
    governor.releaseContinuousRender('satellites');
    assert.equal(engine.render.isContinuous(), false);
    assert.equal(requests.at(-1), 'governor-idle', 'last release paints a settling frame');
    const settled = requests.length;
    governor.releaseContinuousRender('satellites');
    governor.releaseContinuousRender('absent');
    assert.equal(requests.length, settled, 'absent releases do not wake an idle engine');
    for (let i = 0; i < 20; i++) governorRequestRender(`tick-${i}`, engine);
    const diagnostics = governor.getRenderGovernorDiagnostics();
    assert.equal(diagnostics.recentRequests.length, 16);
    assert.equal(diagnostics.recentRequests[0].reason, 'tick-4');
    diagnostics.holds.push('external');
    assert.deepEqual(governor.getRenderGovernorDiagnostics().holds, []);
  });

  test(`${makeHarness.name}: identical owners and teardown stay in their scene`, (t) => {
    const first = makeHarness();
    const second = makeHarness();
    const a = createSceneServices(first.engine);
    const b = createSceneServices(second.engine);
    t.after(() => { sceneServicesFor(first.engine).destroy(); b.destroy(); first.destroy(); second.destroy(); });
    a.render.install();
    b.render.install();
    a.render.holdContinuousRender('flights');
    b.render.holdContinuousRender('flights');
    a.render.releaseContinuousRender('flights');
    assert.equal(first.engine.render.isContinuous(), false);
    assert.equal(second.engine.render.isContinuous(), true);
    a.destroy();
    const replacement = createSceneServices(first.engine);
    replacement.render.install();
    replacement.render.holdContinuousRender('flights');
    const oldRelease = a.render.releaseContinuousRender;
    oldRelease('flights');
    a.render.install();
    a.render.holdContinuousRender('late');
    a.render.governorRequestRender('late');
    a.destroy();
    assert.deepEqual(a.render.getRenderGovernorDiagnostics(), {
      installed: false, mode: 'idle', holds: [], recentRequests: [],
    });
    assert.equal(first.engine.render.isContinuous(), true);
    assert.equal(second.engine.render.isContinuous(), true);
    b.destroy();
    assert.equal(second.engine.render.isContinuous(), false);
    assert.equal(first.engine.render.isContinuous(), true);
    replacement.destroy();
    assert.equal(first.engine.render.isContinuous(), false);
    assert.equal(sceneServicesFor(first.engine), replacement, 'late lookups cannot revive a detached scene');
  });
}

for (const makeHarness of GROUND_HARNESSES) {
  test(`${makeHarness.name}: an old orbit release cannot idle a replacement attachment`, (t) => {
    const harness = makeHarness();
    const { engine } = harness;
    const first = createSceneServices(engine);
    first.render.install();
    const oldOrbit = new OrbitController(engine);
    const newOrbit = new OrbitController(engine);
    t.after(() => {
      oldOrbit.stop(); newOrbit.stop(); sceneServicesFor(engine).destroy(); harness.destroy();
    });
    oldOrbit.start({ x: 6378137, y: 0, z: 0 });
    assert.equal(engine.render.isContinuous(), true);
    first.destroy();
    const next = createSceneServices(engine);
    next.render.install();
    newOrbit.start({ x: 6378137, y: 0, z: 0 });
    oldOrbit.stop();
    assert.deepEqual(next.render.getRenderGovernorDiagnostics().holds, ['camera-orbit']);
    assert.equal(engine.render.isContinuous(), true);
    newOrbit.stop();
    assert.equal(engine.render.isContinuous(), false);
  });
}
