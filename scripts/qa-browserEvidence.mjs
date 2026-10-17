/**
 * Evidence the browser QA gates collect while they run and save under
 * `qa-artifacts/<gate>/` when they fail (CI uploads that directory). Tokens
 * and keys are masked before anything is printed or saved.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Console messages and failed requests kept per page. */
export const EVIDENCE_LIMIT = 200;

/** Cesium's console line when the render loop throws (CesiumWidget). */
export const RENDER_ERROR_PATTERN = /An error occurred while rendering/i;

/** Mask tokens in a URL or message before it is printed or saved. */
export function redact(text) {
  return String(text ?? '')
    .replace(
      /([?&](?:access_token|token|key|api_key|apikey|client_secret|signature)=)[^&\s"']*/gi,
      '$1REDACTED',
    )
    .replace(/MLY\|[^\s&"',)]+/g, 'MLY|REDACTED')
    .replace(/AIza[\w-]{30,}/g, 'AIza…REDACTED');
}

function push(list, entry) {
  list.push(entry);
  if (list.length > EVIDENCE_LIMIT)
    list.splice(0, list.length - EVIDENCE_LIMIT);
}

/**
 * Subscribe to `viewer.scene.renderError` in every document the page loads
 * (reloads included), into `window.__qaRenderErrors`. Call before `goto`.
 */
export function hookRenderErrors(page) {
  return page.evaluateOnNewDocument(() => {
    window.__qaRenderErrors = [];
    const hook = () => {
      const scene = window.__godsEyeView?.viewer?.scene;
      if (!scene?.renderError) return false;
      scene.renderError.addEventListener((_, error) =>
        window.__qaRenderErrors.push(
          String(error?.stack || error?.message || error),
        ),
      );
      return true;
    };
    const timer = setInterval(() => {
      if (hook()) clearInterval(timer);
    }, 250);
  });
}

export async function readRenderErrors(page) {
  try {
    return await page.evaluate(() => window.__qaRenderErrors ?? []);
  } catch {
    return [];
  }
}

/**
 * Watch one page's console, errors and failed requests. `errors` is shared
 * across pages; `isError(text)` adds console lines a gate treats as errors.
 * @returns {{name: string, page: object, console: Array<object>, failed: Array<object>, renderErrors: Array<string>}}
 */
export function watchPage(page, { name, errors, isError = () => false }) {
  const monitor = { name, page, console: [], failed: [], renderErrors: [] };
  page.on('console', (message) => {
    const text = redact(message.text());
    push(monitor.console, { type: message.type(), text });
    if (message.type() === 'error' && RENDER_ERROR_PATTERN.test(text)) {
      monitor.renderErrors.push(text);
      errors.push(`[${name}] render loop: ${text}`);
    } else if (isError(text)) errors.push(`[${name}] ${text}`);
  });
  page.on('pageerror', (error) => {
    const text = redact(error?.stack || error?.message || error);
    push(monitor.console, { type: 'pageerror', text });
    errors.push(`[${name}] ${text}`);
  });
  page.on('requestfailed', (request) =>
    push(monitor.failed, {
      url: redact(request.url()),
      method: request.method(),
      failure: request.failure()?.errorText ?? 'failed',
    }),
  );
  page.on('response', (response) => {
    if (response.status() < 400) return;
    push(monitor.failed, {
      url: redact(response.url()),
      method: response.request().method(),
      status: response.status(),
    });
  });
  return monitor;
}

const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), ms),
    ),
  ]);

function streetLevelState(page) {
  return page.evaluate(() => {
    const module =
      window.__godsEyeView?.dataManager?.layers?.get('street-level')?.module;
    return module?.getUIState ? module.getUIState() : null;
  });
}

/**
 * Save a screenshot and JSON record per page, plus the error. A page that
 * cannot be captured records why instead.
 * @returns {Promise<string>} the directory written
 */
export async function saveFailureArtifacts({ dir, browser, monitors, error }) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'error.txt'),
    redact(error?.stack || error?.message || String(error)),
  );
  const known = new Map(monitors.map((monitor) => [monitor.page, monitor]));
  let pages = [];
  try {
    pages = await browser.pages();
  } catch {
    pages = monitors.map((monitor) => monitor.page);
  }
  let index = 0;
  for (const page of pages) {
    const monitor = known.get(page);
    // The browser's first blank tab holds nothing worth saving.
    if (!monitor && page.url() === 'about:blank') continue;
    const base = `${String(index++).padStart(2, '0')}-${monitor?.name ?? 'page'}`;
    const record = { url: redact(page.url()) };
    try {
      await withTimeout(
        page.screenshot({
          path: path.join(dir, `${base}.png`),
          fullPage: true,
        }),
        30_000,
        'screenshot',
      );
    } catch (shotError) {
      record.screenshotError = String(shotError?.message || shotError);
    }
    try {
      record.streetLevel = await withTimeout(
        streetLevelState(page),
        10_000,
        'getUIState',
      );
    } catch (stateError) {
      record.streetLevelError = String(stateError?.message || stateError);
    }
    record.renderErrors = [
      ...(monitor?.renderErrors ?? []),
      ...(await withTimeout(readRenderErrors(page), 10_000, 'render errors')
        .then((list) => list.map((text) => `scene.renderError: ${text}`))
        .catch(() => [])),
    ].map(redact);
    record.console = monitor?.console ?? [];
    record.failedRequests = monitor?.failed ?? [];
    await fs.writeFile(
      path.join(dir, `${base}.json`),
      redact(JSON.stringify(record, null, 2)),
    );
  }
  return dir;
}
