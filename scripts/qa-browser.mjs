import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const probeCache = new Map();

/**
 * Clear the internal execution probe cache (primarily for unit tests).
 */
export function clearProbeCache() {
  probeCache.clear();
}

/**
 * Returns candidate paths for system browser binaries based on the platform.
 * Supports macOS (darwin), Linux (linux), and Windows (win32).
 */
export function getSystemChromeCandidates(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  if (platform === 'win32') {
    const progFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const progFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData =
      process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
    return [
      path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
      path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);
  }
  // Linux and other Unixes
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/**
 * Verifies that a browser candidate file exists and can actually be executed
 * by the current machine architecture.
 *
 * fs.existsSync() and fs.accessSync(X_OK) return true even if the file is
 * compiled for an incompatible architecture (e.g. x86_64 binary in an arm64
 * Linux Puppeteer cache directory, which fails with "Exec format error").
 * A quick spawnSync(candidate, ['--version']) probe confirms it runs.
 */
export function canExecuteBinary(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'string') return false;
  const platform = options.platform ?? process.platform;
  const fsImpl = options.fsImpl ?? fs;
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;

  const cacheKey = `${platform}:${candidate}`;
  if (probeCache.has(cacheKey) && !options.noCache) {
    return probeCache.get(cacheKey);
  }

  try {
    if (!fsImpl.existsSync(candidate)) {
      probeCache.set(cacheKey, false);
      return false;
    }
    // On Windows, GUI binaries like chrome.exe don't exit cleanly on --version;
    // existence is sufficient.
    if (platform === 'win32') {
      probeCache.set(cacheKey, true);
      return true;
    }
    const probe = spawnSyncImpl(candidate, ['--version'], {
      stdio: 'ignore',
      timeout: 3000,
    });
    const usable = probe.status === 0;
    probeCache.set(cacheKey, usable);
    return usable;
  } catch {
    probeCache.set(cacheKey, false);
    return false;
  }
}

/**
 * Safely resolves Puppeteer's pinned Chrome-for-Testing executable path.
 * Handles both synchronous and asynchronous executablePath implementations,
 * catching throws without failing the harness.
 */
export async function getPuppeteerPinnedPath(puppeteer) {
  if (!puppeteer || typeof puppeteer.executablePath !== 'function') {
    return null;
  }
  try {
    return await Promise.resolve()
      .then(() => puppeteer.executablePath())
      .catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Resolves a usable browser executable path following the strict priority order:
 * 1. PUPPETEER_EXECUTABLE_PATH environment variable (if exists and executable on this architecture)
 * 2. Puppeteer's pinned Chrome-for-Testing binary (if executable on this architecture)
 * 3. Platform / system Chrome/Chromium fallbacks (e.g. /usr/bin/google-chrome, /snap/bin/chromium)
 */
export async function resolveChromeExecutable(puppeteer = null, options = {}) {
  const canExec = options.canExecute ?? ((c) => canExecuteBinary(c, options));

  const envPath = options.envPath ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try {
      if (canExec(envPath)) return envPath;
    } catch {
      /* ignore */
    }
  }

  const pinnedPath = options.pinnedPath ?? (await getPuppeteerPinnedPath(puppeteer));
  if (pinnedPath) {
    try {
      if (canExec(pinnedPath)) return pinnedPath;
    } catch {
      /* ignore */
    }
  }

  const systemCandidates = options.systemCandidates ?? getSystemChromeCandidates(options.platform);
  for (const candidate of systemCandidates) {
    try {
      if (candidate && canExec(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }

  if (options.required) {
    const list = [
      envPath ? `PUPPETEER_EXECUTABLE_PATH (${envPath})` : null,
      pinnedPath ? `Puppeteer pinned (${pinnedPath})` : null,
      ...systemCandidates,
    ].filter(Boolean);
    throw new Error(
      'No usable Chrome or Chromium executable found. Checked candidates:\n' +
        list.map((c) => `  - ${c}`).join('\n') +
        '\nInstall the pinned browser with `npx puppeteer browsers install chrome`, or set PUPPETEER_EXECUTABLE_PATH.',
    );
  }

  return null;
}

/**
 * Alias for backward compatibility across QA harnesses.
 */
export const findChromeExecutable = resolveChromeExecutable;

/**
 * Launches Puppeteer with the resolved executablePath injected.
 * Throws a descriptive error with candidates checked if no usable binary is found.
 */
export async function launchQaBrowser(puppeteer, launchOptions = {}, resolveOptions = {}) {
  const executablePath = await resolveChromeExecutable(puppeteer, {
    required: true,
    ...resolveOptions,
  });
  const finalOptions = {
    ...launchOptions,
    executablePath,
  };
  return puppeteer.launch(finalOptions);
}
