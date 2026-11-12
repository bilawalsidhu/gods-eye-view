// src/main.js is the page's entry module and reads Vite's `import.meta.env`, so
// it cannot be imported in Node. This runs its source in a vm context with
// the modules it imports replaced by stubs (the way
// src/standalone/startupChrome.test.mjs runs its module).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/import\.meta\.env/g, 'env')
  .replace('export { application };', 'result = application;');

/** Run the entry module with `createStandaloneApplication` behaving as given. */
function loadEntry(createApplication, { loadingScreen = true } = {}) {
  const loaderStatus = { textContent: 'Initializing', style: {} };
  const logged = [];
  const context = {
    result: undefined,
    env: { GOOGLE_MAPS_API_KEY: 'browser-key', DEV: false },
    console: { error: (...args) => logged.push(args) },
    document: {
      querySelector: (selector) =>
        loadingScreen && selector === '#loading-screen .loader-status'
          ? loaderStatus
          : null,
    },
    t: (text, { message }) => text.replace('{message}', message),
    describeError: (error) => error.message,
    fetchServerKeyStatus: async () => ({
      cesiumToken: 'server-managed',
      mapillaryConfigured: true,
    }),
    createMapillarySource: (options) => ({ source: options }),
    createStandaloneApplication: createApplication,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { application: context.result, loaderStatus, logged };
}

test('a synchronous failure to build the application reaches the loading screen and the promise', async () => {
  const failure = new Error('the page is already owned');
  const { application, loaderStatus, logged } = loadEntry(() => {
    throw failure;
  });
  await assert.rejects(application, (error) => error === failure);
  assert.equal(loaderStatus.textContent, 'Error: the page is already owned');
  assert.equal(loaderStatus.style.color, '#ff4444');
  assert.equal(logged.length, 1);
});

test('a failure to start reaches the loading screen and the promise still resolves', async () => {
  const app = {
    start: () => Promise.reject(new Error('Google 3D did not load')),
  };
  const { application, loaderStatus } = loadEntry(() => app);
  assert.equal(await application, app);
  // `start()` rejects after the promise resolved: let its handler run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaderStatus.textContent, 'Error: Google 3D did not load');
  assert.equal(loaderStatus.style.color, '#ff4444');
});

test('the application gets the server marker and the Mapillary answer, and the loading screen is left alone when it starts', async () => {
  let options;
  const app = { start: () => Promise.resolve() };
  const { application, loaderStatus, logged } = loadEntry((given) => {
    options = given;
    return app;
  });
  assert.equal(await application, app);
  assert.equal(options.cesiumToken, 'server-managed');
  assert.equal(options.googleApiKey, 'browser-key');
  assert.equal(options.sources.mapillary.source.configured, true);
  assert.equal(loaderStatus.textContent, 'Initializing');
  assert.deepEqual(logged, []);
});

test('a page without the loading screen still gets the original error from a failure to build', async () => {
  const failure = new Error('the page is already owned');
  const { application, logged } = loadEntry(
    () => {
      throw failure;
    },
    { loadingScreen: false },
  );
  // Not a TypeError from the missing element.
  await assert.rejects(application, (error) => error === failure);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], failure);
});

test('a page without the loading screen does not turn a failure to start into an unhandled rejection', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const failure = new Error('Google 3D did not load');
    const app = { start: () => Promise.reject(failure) };
    const { application, logged } = loadEntry(() => app, {
      loadingScreen: false,
    });
    assert.equal(await application, app);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(unhandled, []);
    assert.equal(logged[0][1], failure);
  } finally {
    process.off('unhandledRejection', record);
  }
});
