import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('./qa-gbfs-names.mjs', import.meta.url),
  'utf8',
);
const openSource = source.slice(
  source.indexOf('async function open('),
  source.indexOf('async function nextFrame('),
);

function fixture({ extended, dev }) {
  const page = {
    bringToFront: async () => {},
    on() {},
    setViewport: async () => {},
    evaluateOnNewDocument: async () => {},
    goto: async () => {},
    evaluate: async () => dev,
    waitForFunction: async () => {},
  };
  const dependencies = {
    browser: { newPage: async () => page },
    extended,
    watchBrowserPage() {},
    report: {},
    appUrl: 'http://localhost:4000',
    information: {},
    status: {},
    fromDegrees: () => ({}),
    whenSettled: async () => {},
  };
  return new Function(
    ...Object.keys(dependencies),
    `${openSource}\nreturn open;`,
  )(...Object.values(dependencies));
}

test('preview rejects the optional dev-only raster checks before importing source modules', async () => {
  await assert.rejects(
    fixture({ extended: true, dev: false })(),
    /--w2 requires a Vite dev server/,
  );
});

test('normal preview checks and extended dev checks remain available', async () => {
  await fixture({ extended: false, dev: false })();
  await fixture({ extended: true, dev: true })();
});
