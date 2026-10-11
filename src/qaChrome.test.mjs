import assert from 'node:assert/strict';
import test from 'node:test';
import { MACOS_CHROME, chromeExecutablePath } from '../scripts/qa-chrome.mjs';

test('gates keep macOS Chrome where it is installed', () => {
  assert.equal(
    chromeExecutablePath({ env: {}, exists: (p) => p === MACOS_CHROME }),
    MACOS_CHROME,
  );
});

test('gates fall back to Puppeteer’s browser without macOS Chrome', () => {
  assert.equal(
    chromeExecutablePath({ env: {}, exists: () => false }),
    undefined,
  );
});

test('an explicit executable path wins', () => {
  assert.equal(
    chromeExecutablePath({
      env: { PUPPETEER_EXECUTABLE_PATH: 'C:\Chrome\chrome.exe' },
      exists: () => true,
    }),
    'C:\Chrome\chrome.exe',
  );
});
