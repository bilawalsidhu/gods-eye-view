import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canExecuteBinary,
  clearProbeCache,
  getPuppeteerPinnedPath,
  getSystemChromeCandidates,
  resolveChromeExecutable,
  launchQaBrowser,
} from '../../scripts/qa-browser.mjs';

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));

describe('scripts/qa-browser.mjs (unified browser resolver #770)', () => {
  beforeEach(() => {
    clearProbeCache();
  });

  describe('canExecuteBinary', () => {
    it('returns false for null, undefined, or empty path', () => {
      assert.equal(canExecuteBinary(null), false);
      assert.equal(canExecuteBinary(undefined), false);
      assert.equal(canExecuteBinary(''), false);
    });

    it('returns false when file does not exist on disk', () => {
      const fsImpl = { existsSync: () => false };
      assert.equal(canExecuteBinary('/nonexistent/binary', { fsImpl }), false);
    });

    it('returns true on win32 when binary exists', () => {
      const fsImpl = { existsSync: () => true };
      assert.equal(canExecuteBinary('C:\\chrome.exe', { platform: 'win32', fsImpl }), true);
    });

    it('on posix: probes with --version and returns true when status === 0', () => {
      const fsImpl = { existsSync: () => true };
      let probedArgs = null;
      let probedOptions = null;
      const spawnSyncImpl = (bin, args, opts) => {
        probedArgs = { bin, args };
        probedOptions = opts;
        return { status: 0 };
      };
      const usable = canExecuteBinary('/snap/bin/chromium', {
        platform: 'linux',
        fsImpl,
        spawnSyncImpl,
      });
      assert.equal(usable, true);
      assert.equal(probedArgs.bin, '/snap/bin/chromium');
      assert.deepEqual(probedArgs.args, ['--version']);
      assert.equal(probedOptions.timeout, 10000);
    });

    it('on posix: returns false when probe status !== 0 (e.g. arm64/x86_64 Exec format error)', () => {
      const fsImpl = { existsSync: () => true };
      const spawnSyncImpl = () => ({ status: 2, error: new Error('Exec format error') });
      const usable = canExecuteBinary('/mock/pinned/x86_chrome_on_arm64', {
        platform: 'linux',
        fsImpl,
        spawnSyncImpl,
      });
      assert.equal(usable, false);
    });

    it('on posix: returns false when spawnSync throws', () => {
      const fsImpl = { existsSync: () => true };
      const spawnSyncImpl = () => {
        throw new Error('EACCES');
      };
      const usable = canExecuteBinary('/mock/forbidden', {
        platform: 'linux',
        fsImpl,
        spawnSyncImpl,
      });
      assert.equal(usable, false);
    });

    it('caches probe results across calls for the same binary', () => {
      const fsImpl = { existsSync: () => true };
      let spawnCount = 0;
      const spawnSyncImpl = () => {
        spawnCount++;
        return { status: 0 };
      };
      assert.equal(canExecuteBinary('/cached/chrome', { platform: 'linux', fsImpl, spawnSyncImpl }), true);
      assert.equal(canExecuteBinary('/cached/chrome', { platform: 'linux', fsImpl, spawnSyncImpl }), true);
      assert.equal(spawnCount, 1);
    });
  });

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

  describe('resolveChromeExecutable resolution order and architecture filtering', () => {
    it('priority 1: uses PUPPETEER_EXECUTABLE_PATH if exists and executable', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/custom/env/chrome',
        pinnedPath: '/mock/pinned',
        systemCandidates: ['/mock/system'],
        canExecute: (c) => c === '/custom/env/chrome',
      });
      assert.equal(resolved, '/custom/env/chrome');
    });

    it('priority 2: falls back to pinned path if env does not exist or cannot execute', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/incompatible/env',
        pinnedPath: '/valid/pinned/chrome',
        systemCandidates: ['/mock/system'],
        canExecute: (c) => c === '/valid/pinned/chrome',
      });
      assert.equal(resolved, '/valid/pinned/chrome');
    });

    it('priority 3: falls back to system candidate if env and pinned are not executable', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/nonexistent/env',
        pinnedPath: '/incompatible/arm64_mismatch',
        systemCandidates: ['/nonexistent/1', '/snap/bin/chromium', '/nonexistent/2'],
        canExecute: (c) => c === '/snap/bin/chromium',
      });
      assert.equal(resolved, '/snap/bin/chromium');
    });

    it('returns null if no candidate can be executed and required is not set', async () => {
      const resolved = await resolveChromeExecutable(null, {
        envPath: '/nonexistent/env',
        pinnedPath: '/nonexistent/pinned',
        systemCandidates: ['/nonexistent/1', '/nonexistent/2'],
        canExecute: () => false,
      });
      assert.equal(resolved, null);
    });

    it('throws with descriptive candidate list when required is true and no candidate resolves', async () => {
      await assert.rejects(
        () =>
          resolveChromeExecutable(null, {
            envPath: '/nonexistent/env',
            pinnedPath: '/nonexistent/pinned',
            systemCandidates: ['/snap/bin/chromium'],
            canExecute: () => false,
            required: true,
          }),
        {
          name: 'Error',
          message: /No usable Chrome or Chromium executable found.*\/snap\/bin\/chromium/s,
        },
      );
    });
  });

  describe('launchQaBrowser', () => {
    it('passes resolved executablePath into puppeteer.launch', async () => {
      let capturedOptions = null;
      const fakePuppeteer = {
        executablePath: () => '/valid/chrome',
        launch: async (opts) => {
          capturedOptions = opts;
          return { close: async () => {} };
        },
      };

      await launchQaBrowser(
        fakePuppeteer,
        { headless: 'new' },
        {
          envPath: '/valid/chrome',
          systemCandidates: [],
          canExecute: (c) => c === '/valid/chrome',
        },
      );
      assert.equal(capturedOptions?.headless, 'new');
      assert.equal(capturedOptions?.executablePath, '/valid/chrome');
    });

    it('throws when no usable candidate can be resolved', async () => {
      const fakePuppeteer = {
        executablePath: () => null,
        launch: async () => {},
      };

      await assert.rejects(
        () =>
          launchQaBrowser(fakePuppeteer, {}, {
            envPath: null,
            pinnedPath: null,
            systemCandidates: ['/usr/bin/google-chrome'],
            canExecute: () => false,
          }),
        {
          name: 'Error',
          message: /No usable Chrome or Chromium executable found/s,
        },
      );
    });
  });
});
