// src/main.js is the page's entry module and reads Vite's `import.meta.env`, so
// it cannot be imported in Node. This runs its source in a vm context with
// the modules it imports replaced by stubs (the way
// src/standalone/startupChrome.test.mjs runs its module).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import vm from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/import\.meta\.env/g, 'env')
  .replace('export { application };', 'result = application;');

/** The fixed text the loading screen shows when the application does not start. */
const STARTUP_FAILED = 'The application could not start.';
/** The fixed text the console reports when the application does not start. */
const CONSOLE_REPORT = "God's Eye View initialization failed.";

// Synthetic credentials, built rather than written out: a startup failure
// that echoed one would put it on the loading screen or in the console.
const SECRETS = Object.freeze({
  bearer: 'b'.repeat(24),
  token: `sk-live-${'t'.repeat(20)}-TAIL99`,
  query: `q${'q'.repeat(20)}/+=${'q'.repeat(6)}`,
  userinfo: 'p'.repeat(20),
  apiKey: `AIza${'k'.repeat(33)}`,
});

// The shapes a provider failure can carry: a bearer header, a token, only
// the tail of a token, an API key header, a token in a query string (plain,
// percent-encoded and base64) and a password in a URL's userinfo.
const CREDENTIALS = Object.freeze({
  bearer: `Bearer ${SECRETS.bearer}`,
  token: SECRETS.token,
  tokenSuffix: SECRETS.token.slice(-6),
  apiKey: `X-Goog-Api-Key: ${SECRETS.apiKey}`,
  query: `?access_token=${SECRETS.query}`,
  queryEncoded: `?access_token=${encodeURIComponent(SECRETS.query)}`,
  queryBase64: `?access_token=${Buffer.from(SECRETS.query).toString('base64')}`,
  userinfo: `https://user:${SECRETS.userinfo}@synthetic.invalid/path`,
});

/** A failure whose message carries every synthetic credential. */
function credentialFailure() {
  const message = [
    'the provider answered 401',
    `Authorization: ${CREDENTIALS.bearer}`,
    `X-Goog-Api-Key: ${SECRETS.apiKey}`,
    `token=${CREDENTIALS.token}`,
    `the tail of the token was ${CREDENTIALS.tokenSuffix}`,
    `GET https://api.synthetic.invalid/tiles${CREDENTIALS.query}`,
    `GET https://api.synthetic.invalid/tiles${CREDENTIALS.queryEncoded}`,
    `GET https://api.synthetic.invalid/tiles${CREDENTIALS.queryBase64}`,
    `connect ${CREDENTIALS.userinfo}`,
  ].join(' ');
  return new Error(message);
}

/**
 * Run the entry module with `createStandaloneApplication` behaving as given.
 * `loadingScreen: false` is a page without the loading screen; `document:
 * false` is a page without a document at all.
 */
function loadEntry(
  createApplication,
  { loadingScreen = true, document: hasDocument = true } = {},
) {
  const loaderStatus = { textContent: 'Initializing', style: {} };
  const logged = [];
  const context = {
    result: undefined,
    photonSetting: undefined,
    env: { GOOGLE_MAPS_API_KEY: 'browser-key', DEV: false },
    console: { error: (...args) => logged.push(args) },
    document: hasDocument
      ? {
          querySelector: (selector) =>
            loadingScreen && selector === '#loading-screen .loader-status'
              ? loaderStatus
              : null,
        }
      : undefined,
    t: (text, values) =>
      values?.message ? text.replace('{message}', values.message) : text,
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

/** Everything the entry module said out loud, as one string. */
function outputOf({ loaderStatus, logged }) {
  return [loaderStatus.textContent, ...logged.flat().map(String)].join('\n');
}

/** Assert that no synthetic credential reached what the user or the console sees. */
function assertNoCredential(output) {
  for (const [shape, value] of Object.entries(CREDENTIALS)) {
    assert.ok(
      !output.includes(value),
      `the ${shape} credential reached the output`,
    );
  }
  // The bare secret too, without the shape it travels in.
  for (const [shape, secret] of Object.entries(SECRETS)) {
    assert.ok(
      !output.includes(secret),
      `the ${shape} secret reached the output`,
    );
  }
}

/** Every text a caller can read out of an error. */
function surfacesOf(error) {
  return [
    error.message,
    error.stack,
    error.cause === undefined ? '' : inspect(error.cause),
    JSON.stringify(error),
    JSON.stringify({ ...error }),
    inspect(error),
    String(error),
    ...Object.getOwnPropertyNames(error).map((name) => String(error[name])),
  ];
}

/**
 * Whether a value is an error. The entry module runs in a vm context, which
 * has its own Error, so `instanceof` alone would not see it.
 */
function isError(value) {
  return (
    value instanceof Error ||
    Object.prototype.toString.call(value) === '[object Error]'
  );
}

/**
 * Assert that the error a caller sees carries no trace of the failure: not
 * in its message, its stack, its cause, its serialization, its inspected
 * form or any property it carries.
 */
function assertSanitized(error, failure) {
  assert.ok(isError(error), 'the caller got something else than an error');
  assert.notEqual(error, failure, 'the failure itself reached the caller');
  assert.equal(error.message, STARTUP_FAILED, 'the error is not the fixed one');
  assert.equal(error.cause, undefined, 'the failure was kept as the cause');
  for (const [name, value] of Object.entries(error))
    assert.notEqual(value, failure, `the failure was kept as ${name}`);
  for (const surface of surfacesOf(error)) assertNoCredential(surface);
}

test('a synchronous failure to build the application reaches the loading screen and the promise', async () => {
  const failure = new Error('the page is already owned');
  const { application, loaderStatus, logged } = loadEntry(() => {
    throw failure;
  });
  // The promise still rejects, but with the fixed error: the failure itself
  // never reaches the caller.
  await assert.rejects(application, (error) => {
    assertSanitized(error, failure);
    return true;
  });
  assert.equal(loaderStatus.textContent, STARTUP_FAILED);
  assert.equal(loaderStatus.style.color, '#ff4444');
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], [CONSOLE_REPORT]);
});

test('a failure to start reaches the loading screen and the promise still resolves', async () => {
  const app = {
    start: () => Promise.reject(new Error('Google 3D did not load')),
  };
  const { application, loaderStatus } = loadEntry(() => app);
  assert.equal(await application, app);
  // `start()` rejects after the promise resolved: let its handler run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaderStatus.textContent, STARTUP_FAILED);
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

test('a page without the loading screen still gets the fixed error from a failure to build', async () => {
  const failure = new Error('the page is already owned');
  const { application, logged } = loadEntry(
    () => {
      throw failure;
    },
    { loadingScreen: false },
  );
  // Not a TypeError from the missing element.
  await assert.rejects(application, (error) => {
    assertSanitized(error, failure);
    return true;
  });
  assert.equal(logged.length, 1);
  // The failure itself is not logged: only that it happened.
  assert.deepEqual(logged[0], [CONSOLE_REPORT]);
});

test('a page without a document still reports a failure to build without the failure', async () => {
  const failure = credentialFailure();
  const { application, logged } = loadEntry(
    () => {
      throw failure;
    },
    { document: false },
  );
  await assert.rejects(application, (error) => {
    assertSanitized(error, failure);
    return true;
  });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], [CONSOLE_REPORT]);
});

test('a page without the loading screen does not turn a failure to start into an unhandled rejection', async () => {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const failure = credentialFailure();
    const app = { start: () => Promise.reject(failure) };
    const { application, loaderStatus, logged } = loadEntry(() => app, {
      loadingScreen: false,
    });
    assert.equal(await application, app);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(logged[0], [CONSOLE_REPORT]);
    assertNoCredential(outputOf({ loaderStatus, logged }));
  } finally {
    process.off('unhandledRejection', record);
  }
});

test('a failure to build that carries credentials shows and rejects none of them', async () => {
  const failure = credentialFailure();
  const { application, loaderStatus, logged } = loadEntry(() => {
    throw failure;
  });
  // The promise still rejects, but with the fixed error: it is not swallowed
  // and the failure itself never reaches the caller.
  await assert.rejects(application, (error) => {
    assertSanitized(error, failure);
    return true;
  });
  assert.equal(loaderStatus.textContent, STARTUP_FAILED);
  assertNoCredential(outputOf({ loaderStatus, logged }));
  assert.deepEqual(logged[0], [CONSOLE_REPORT]);
});

test('the rejection reason an unhandled rejection would report carries no credential', async () => {
  const failure = credentialFailure();
  const { application } = loadEntry(() => {
    throw failure;
  });
  // What the runtime reports for an unhandled rejection is the rejection
  // reason: its message and its stack. Both are checked.
  const reason = await application.then(
    () => null,
    (error) => error,
  );
  assertSanitized(reason, failure);
});

test('a failure to start that carries credentials shows none of them', async () => {
  const failure = credentialFailure();
  const app = { start: () => Promise.reject(failure) };
  const { application, loaderStatus, logged } = loadEntry(() => app);
  assert.equal(await application, app);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loaderStatus.textContent, STARTUP_FAILED);
  assertNoCredential(outputOf({ loaderStatus, logged }));
  assert.deepEqual(logged[0], [CONSOLE_REPORT]);
});

test('a page without the loading screen reports a failure that carries credentials without them', async () => {
  const failure = credentialFailure();
  const { application, loaderStatus, logged } = loadEntry(
    () => {
      throw failure;
    },
    { loadingScreen: false },
  );
  await assert.rejects(application, (error) => {
    assertSanitized(error, failure);
    return true;
  });
  assert.equal(loaderStatus.textContent, 'Initializing');
  assertNoCredential(outputOf({ loaderStatus, logged }));
  assert.deepEqual(logged[0], [CONSOLE_REPORT]);
});
