/**
 * The browser for gates that drive an installed Chrome. These gates were
 * written against macOS Google Chrome, which Windows and Linux do not have.
 */
import { existsSync } from 'node:fs';

export const MACOS_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * PUPPETEER_EXECUTABLE_PATH when set, then macOS Google Chrome when it is
 * installed. Otherwise undefined, so Puppeteer launches the browser it manages.
 */
export function chromeExecutablePath({
  env = process.env,
  exists = existsSync,
} = {}) {
  if (env.PUPPETEER_EXECUTABLE_PATH) return env.PUPPETEER_EXECUTABLE_PATH;
  return exists(MACOS_CHROME) ? MACOS_CHROME : undefined;
}

/** Restore an owned test window before capture: focus emulation alone does not
 * unminimize the native compositor, so CDP screenshots can otherwise stall. */
export async function captureQaScreenshot(
  page,
  options,
  { headful = true } = {},
) {
  if (headful) {
    const session = await page.createCDPSession();
    try {
      const { windowId, bounds } = await session.send(
        'Browser.getWindowForTarget',
      );
      if (bounds.windowState === 'minimized') {
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'normal' },
        });
      }
      await page.bringToFront();
    } finally {
      await session.detach();
    }
  }
  return page.screenshot(options);
}
