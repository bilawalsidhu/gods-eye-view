import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  createCameraReconstructionHandler,
  boundedReconstructionPng,
  cameraReconstructionProxy,
} from './camera-reconstruction.js';
import { sameSiteGated } from './common/same-site.js';
function png() {
  const b = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b);
  b.writeUInt32BE(32, 16);
  b.writeUInt32BE(32, 20);
  return 'data:image/png;base64,' + b.toString('base64');
}
async function invoke(handler, method = 'GET', body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url: '/api/camera-reconstruction',
    originalUrl: '/api/camera-reconstruction',
    headers: {
      host: '127.0.0.1:4173',
      origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.end = (s) => {
    res.writableEnded = true;
    res.body = JSON.parse(s);
  };
  await handler(req, res);
  return res;
}
test('unapproved provider cannot generate or consume input even with explicit client confirmation', async () => {
  let calls = 0;
  const handler = createCameraReconstructionHandler({
    provider: { approved: false, generate: () => calls++ },
  });
  assert.equal((await invoke(handler)).body.available, false);
  assert.equal(
    (await invoke(handler, 'POST', { confirmReconstruction: true })).statusCode,
    503,
  );
  assert.equal(calls, 0);
});
test('Vite install hook returns no middleware as a post-configure callback', () => {
  const plugin = cameraReconstructionProxy();
  let route;
  assert.equal(
    plugin.configureServer({
      middlewares: {
        use: (path) => {
          route = path;
          return () => {};
        },
      },
    }),
    undefined,
  );
  assert.equal(route, '/api/camera-reconstruction');
});
test('approved provider receives only bounded pristine image, scope, explicit note and signal', async () => {
  let request;
  const provider = {
    approved: true,
    id: 'Fixture',
    model: 'fixture-image',
    priceLabel: 'Fixture only',
    generate: async (args) => {
      request = args;
      return { image: png() };
    },
  };
  const handler = createCameraReconstructionHandler({
    provider,
    rateLimit: () => true,
  });
  const body = {
    confirmReconstruction: true,
    provider: 'Fixture',
    model: 'fixture-image',
    scope: 'region',
    sourceImage: png(),
    note: 'Optional hypothesis',
    privateCredential: 'must not forward',
  };
  const response = await invoke(handler, 'POST', body);
  assert.equal(response.statusCode, 200);
  assert.equal(request.sourceImage, body.sourceImage);
  assert.equal(request.scope, 'region');
  assert.equal(request.note, 'Optional hypothesis');
  assert.equal(request.privateCredential, undefined);
  assert.match(response.body.label, /not factual/);
});
test('confirmation, exact provider/model and valid PNG are required before generation', async () => {
  let calls = 0;
  const handler = createCameraReconstructionHandler({
    provider: {
      approved: true,
      id: 'Fixture',
      model: 'fixture-image',
      priceLabel: 'Fixture',
      generate: async () => {
        calls++;
        return { image: png() };
      },
    },
    rateLimit: () => true,
  });
  for (const body of [
    {},
    { confirmReconstruction: true, provider: 'other', model: 'fixture-image' },
    {
      confirmReconstruction: true,
      provider: 'Fixture',
      model: 'fixture-image',
      scope: 'whole',
      note: '',
      sourceImage: 'https://arbitrary.invalid/image',
    },
  ])
    assert.ok((await invoke(handler, 'POST', body)).statusCode >= 400);
  assert.equal(calls, 0);
  assert.equal(
    boundedReconstructionPng('data:image/svg+xml;base64,evil'),
    null,
  );
});
test('foreign origin is rejected before a provider callback', async () => {
  let calls = 0;
  const handler = sameSiteGated(
    createCameraReconstructionHandler({
      provider: { checkAccess: () => calls++ },
    }),
  );
  const req = Readable.from([]);
  Object.assign(req, {
    method: 'GET',
    url: '/api/camera-reconstruction',
    headers: { host: '127.0.0.1:4173', origin: 'https://foreign.invalid' },
  });
  const res = new EventEmitter();
  res.setHeader = () => {};
  res.end = () => {};
  handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls, 0);
});
