import fs from 'node:fs';
import path from 'node:path';

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
 * 1. PUPPETEER_EXECUTABLE_PATH environment variable (if exists on disk)
 * 2. Puppeteer's pinned Chrome-for-Testing binary
 * 3. Platform / system Chrome/Chromium fallbacks
 */
export async function resolveChromeExecutable(puppeteer = null, options = {}) {
  const envPath = options.envPath ?? process.env.PUPPETEER_EXECUTABLE_PATH;
  if (envPath) {
    try {
      if (fs.existsSync(envPath)) return envPath;
    } catch {
      /* ignore */
    }
  }

  const pinnedPath = options.pinnedPath ?? (await getPuppeteerPinnedPath(puppeteer));
  if (pinnedPath) {
    try {
      if (fs.existsSync(pinnedPath)) return pinnedPath;
    } catch {
      /* ignore */
    }
  }

  const systemCandidates = options.systemCandidates ?? getSystemChromeCandidates();
  for (const candidate of systemCandidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }

  return null;
}

/**
 * Alias for backward compatibility across QA harnesses.
 */
export const findChromeExecutable = resolveChromeExecutable;

/**
 * Launches Puppeteer with the resolved executablePath injected (if found).
 */
export async function launchQaBrowser(puppeteer, launchOptions = {}, resolveOptions = {}) {
  const executablePath = await resolveChromeExecutable(puppeteer, resolveOptions);
  const finalOptions = {
    ...launchOptions,
    ...(executablePath ? { executablePath } : {}),
  };
  return puppeteer.launch(finalOptions);
}
