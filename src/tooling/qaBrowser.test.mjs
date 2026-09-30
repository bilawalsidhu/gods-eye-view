import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  getPuppeteerPinnedPath,
  getSystemChromeCandidates,
  resolveChromeExecutable,
  launchQaBrowser,
} from '../../scripts/qa-browser.mjs';

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

describe('scripts/qa-browser.mjs (unified browser resolver #770)', () => {
  describe('getPuppeteerPinnedPath', () => {
    it('returns null when puppeteer is null, undefined, or missing executablePath', async () => {
      assert.equal(await getPuppeteerPinnedPath(null), null);
      assert.equal(await getPuppeteerPinnedPath({}), null);
    });

    it('resolves synchronous executablePath returning string', async () => {
      const fakePuppeteer = {
        executablePath: () => '/mock/chrome-for-testing',
      };
      assert.equal(await getPuppeteerPinnedPath(fakePuppeteer), '/mock/chrome-for-testing');
    });

    it('resolves asynchronous executablePath returning Promise', async () => {
      const fakePuppeteer = {
        executablePath: async () => '/mock/async-chrome',
      };
      assert.equal(await getPuppeteerPinnedPath(fakePuppeteer), '/mock/async-chrome');
    });

    it('safely catches synchronous throw from executablePath', async () => {
      const fakePuppeteer = {
        executablePath: () => {
          throw new Error('Chrome-for-testing binary missing');
        },
      };
      assert.equal(await getPuppeteerPinnedPath(fakePuppeteer), null);
    });

    it('safely catches rejected promise from executablePath', async () => {
      const fakePuppeteer = {
        executablePath: async () => {
          throw new Error('Async download missing');
        },
      };
      assert.equal(await getPuppeteerPinnedPath(fakePuppeteer), null);
    });
  });

  describe('getSystemChromeCandidates', () => {
    it('returns macOS paths on darwin', () => {
      const candidates = getSystemChromeCandidates('darwin');
      assert.ok(candidates.some((c) => c.includes('/Applications/Google Chrome.app')));
    });

    it('returns Windows paths on win32', () => {
      const candidates = getSystemChromeCandidates('win32');
      assert.ok(candidates.some((c) => c.toLowerCase().includes('chrome.exe')));
    });

    it('returns Linux paths on linux', () => {
      const candidates = getSystemChromeCandidates('linux');
      assert.ok(candidates.some((c) => c.includes('/usr/bin/google-chrome')));
    });
  });

  describe('resolveChromeExecutable resolution order', () => {
    it('priority 1: uses PUPPETEER_EXECUTABLE_PATH if exists', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: PACKAGE_JSON_PATH,
        pinnedPath: '/mock/pinned',
        systemCandidates: ['/mock/system'],
      });
      assert.equal(resolved, PACKAGE_JSON_PATH);
    });

    it('priority 2: falls back to pinned path if env does not exist', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/nonexistent/path',
        pinnedPath: PACKAGE_JSON_PATH,
        systemCandidates: ['/mock/system'],
      });
      assert.equal(resolved, PACKAGE_JSON_PATH);
    });

    it('priority 3: falls back to system candidate if env and pinned do not exist', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/nonexistent/env',
        pinnedPath: '/nonexistent/pinned',
        systemCandidates: ['/nonexistent/1', PACKAGE_JSON_PATH, '/nonexistent/2'],
      });
      assert.equal(resolved, PACKAGE_JSON_PATH);
    });

    it('returns null if no candidate exists', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/nonexistent/env',
        pinnedPath: '/nonexistent/pinned',
        systemCandidates: ['/nonexistent/1', '/nonexistent/2'],
      });
      assert.equal(resolved, null);
    });
  });

  describe('launchQaBrowser', () => {
    it('passes resolved executablePath into puppeteer.launch', async () => {
      let capturedOptions = null;
      const fakePuppeteer = {
        executablePath: () => PACKAGE_JSON_PATH,
        launch: async (opts) => {
          capturedOptions = opts;
          return { close: async () => {} };
        },
      };

      await launchQaBrowser(
        fakePuppeteer,
        { headless: 'new' },
        { envPath: PACKAGE_JSON_PATH, systemCandidates: [] }
      );
      assert.equal(capturedOptions?.headless, 'new');
      assert.equal(capturedOptions?.executablePath, PACKAGE_JSON_PATH);
    });
  });
});
