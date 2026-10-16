// Wind source failures are English data (src/layers/wind/source.js) and
// are shown in the UI language; the HTTP line keeps its status number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindLayer } from './index.js';
import { setLocale } from '../../i18n/index.js';

function harness(problem) {
  const rendering = Object.fromEntries(
    [
      'attach',
      'start',
      'stop',
      'clear',
      'destroy',
      'setField',
      'setOptions',
    ].map((name) => [name, () => {}]),
  );
  rendering.getDiagnostics = () => ({});
  const layer = createWindLayer({
    feed: {
      getSnapshot: async () => {
        throw new Error(problem);
      },
    },
    createRendering: () => rendering,
  });
  layer.init({ container: {} });
  layer.enable();
  return layer;
}

async function statusFor(problem) {
  const layer = harness(problem);
  await layer.update();
  return layer.getRowControls().summary.status;
}

test('en: wind source failures read as before', async () => {
  assert.equal(await statusFor('Wind HTTP 503'), 'Wind HTTP 503');
  assert.equal(
    await statusFor('Wind request timed out'),
    'Wind request timed out',
  );
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: wind source failures are shown in the UI language`, async () => {
    setLocale(locale);
    try {
      const http = await statusFor('Wind HTTP 503');
      assert.notEqual(http, 'Wind HTTP 503');
      assert.match(http, /503/);
      for (const problem of [
        'Wind request timed out',
        'Malformed wind manifest',
        'Malformed wind grid',
      ])
        assert.notEqual(await statusFor(problem), problem);
    } finally {
      setLocale('en');
    }
  });
}
