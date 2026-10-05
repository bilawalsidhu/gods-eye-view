import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionController } from './session.js';

function fixture({ error, attach } = {}) {
  let requests = 0, started = 0, ended = 0;
  const messages = [];
  const session = new EventTarget(); session.visibilityState = 'visible';
  session.end = async () => { session.dispatchEvent(new Event('end')); };
  const controller = createSessionController({ renderer: {}, secure: true,
    xrSystem: { requestSession() { requests++; return error ? Promise.reject(error) : Promise.resolve(session); } },
    detect: async () => ({ ar: true, vr: true, mode: 'immersive-ar' }), attach: attach || (async () => ({ floor: true })),
    onStart: async () => { started++; }, onEnd: () => { ended++; }, onStatus: text => messages.push(text),
  });
  return { controller, session, messages, counts: () => ({ requests, started, ended }) };
}
test('entry requests in the click turn, rejects double entry, and restores on exit', async () => {
  const f = fixture(); await f.controller.detect();
  const entry = f.controller.enter(); assert.equal(f.counts().requests, 1);
  await f.controller.enter(); await entry; assert.deepEqual(f.counts(), { requests: 1, started: 1, ended: 0 });
  await f.controller.exit(); await f.controller.exit(); assert.equal(f.controller.state().active, false); assert.equal(f.counts().ended, 1);
  await f.controller.destroy();
});
test('AR rejection offers explicit VR retry without a second automatic session request', async () => {
  const error = Object.assign(new Error('AR unavailable'), { name: 'NotSupportedError' });
  const f = fixture({ error }); await f.controller.detect(); await f.controller.enter();
  assert.equal(f.counts().requests, 1); assert.equal(f.controller.state().selected, 'immersive-vr');
  assert.match(f.messages[0], /Choose Enter VR/); assert.equal(f.controller.state().pending, false); await f.controller.destroy();
});
test('system exit during attachment cannot start or revive a finished session', async () => {
  let resolveAttach;
  const f = fixture({ attach: () => new Promise(resolve => { resolveAttach = resolve; }) }); await f.controller.detect();
  const entry = f.controller.enter(); await Promise.resolve();
  await f.session.end(); resolveAttach({ floor: true }); await entry;
  assert.equal(f.counts().started, 0); assert.equal(f.controller.state().active, false); await f.controller.destroy();
});
