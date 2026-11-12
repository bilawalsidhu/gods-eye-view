import test from 'node:test';
import assert from 'node:assert/strict';
import { appBaseHref } from './appBaseUrl.js';

function withGlobals(values, run) {
  const names = ['GEV_APP_BASE_URL', 'location'];
  const saved = names.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]);
  for (const name of names) delete globalThis[name];
  Object.assign(globalThis, values);
  try {
    return run();
  } finally {
    for (const name of names) delete globalThis[name];
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  }
}

test('the app address the panel names wins over the page address', () => {
  assert.equal(
    withGlobals(
      {
        GEV_APP_BASE_URL: 'https://gev.example/',
        location: { href: 'https://host.example/page' },
      },
      appBaseHref,
    ),
    'https://gev.example/',
  );
});

test('without a named address the page address is the base', () => {
  assert.equal(
    withGlobals(
      { location: { href: 'https://host.example/page' } },
      appBaseHref,
    ),
    'https://host.example/page',
  );
});

test('outside a page there is a placeholder origin', () => {
  assert.equal(withGlobals({}, appBaseHref), 'http://localhost/');
});
