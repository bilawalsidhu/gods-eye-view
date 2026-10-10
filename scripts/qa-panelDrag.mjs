/**
 * Header press-and-verify for the QA gates that lift a rail panel into a
 * floating window and dock it again. The rail animates panel heights, so a
 * point read once can be under another panel by the time the pointer goes
 * down. Only a provable miss (a recorded press outside the header) is
 * retried, with a GitHub `::warning::`. With QA_FAIL_ON_RETRY=1 a miss the
 * panel's own movement cannot explain fails the run instead.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries after the first attempt, and the pause before each. */
export const PRESS_RETRIES = 2;
const RETRY_PAUSE_MS = 1000;

/** Whether a retry fails the run (QA_FAIL_ON_RETRY=1 or --fail-on-retry). */
export function failOnRetryDefault(
  env = process.env,
  argv = process.argv.slice(2),
) {
  return env.QA_FAIL_ON_RETRY === '1' || argv.includes('--fail-on-retry');
}

/**
 * A failed attempt whose press landed outside the header. No recorded press
 * is a failure, not a miss: a retry would only hide it.
 * @param {{done: boolean, pressed: {inHeader: boolean}|null}} attempt
 */
export function pressMissed(attempt) {
  return !attempt.done && attempt.pressed?.inHeader === false;
}

/** Whether the panel's box changed by more than 2 px between two reads. */
export function panelMoved(before, after) {
  if (!before || !after) return false;
  return ['left', 'top', 'width', 'height'].some(
    (key) => Math.abs((after[key] ?? NaN) - (before[key] ?? NaN)) > 2,
  );
}

/** The panel's box, rounded, as `left,top widthxheight`. */
export function formatBox(box) {
  if (!box) return 'unknown';
  const r = (value) => Math.round(value ?? NaN);
  return `${r(box.left)},${r(box.top)} ${r(box.width)}x${r(box.height)}`;
}

function panelBox(page, panelId) {
  return page.evaluate((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, panelId);
}

export function headerPoint(page, panelId) {
  return page.evaluate((id) => {
    const title = document.querySelector(`#${id} .panel-header .panel-title`);
    const r = title.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, panelId);
}

/** Name the element at a point, and whether it is the panel's header. */
export function hitAt(page, point, panelId) {
  return page.evaluate(
    ({ x, y, id }) => {
      const node = document.elementFromPoint(x, y);
      if (!node) return { target: 'nothing', inHeader: false };
      return {
        target: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${[...node.classList].join('.')}`,
        inHeader: Boolean(node.closest(`#${id} .panel-header`)),
      };
    },
    { ...point, id: panelId },
  );
}

/**
 * Re-resolve the header point until it hits the header or the wait runs out
 * (the press then records the miss).
 */
export async function headerTarget(
  page,
  panelId,
  { tries = 20, intervalMs = 500 } = {},
) {
  let point = await headerPoint(page, panelId);
  let hit = await hitAt(page, point, panelId);
  for (let i = 0; i < tries && !hit.inHeader; i++) {
    await delay(intervalMs);
    point = await headerPoint(page, panelId);
    hit = await hitAt(page, point, panelId);
  }
  const box = await panelBox(page, panelId);
  return { point, hit, timedOut: !hit.inHeader, box };
}

/**
 * Best effort: wait until the panel's box has held still for `stillMs`, so
 * the header does not move between the hit check and the press.
 */
export async function waitForStill(
  page,
  panelId,
  { stillMs = 300, timeout = 5000 } = {},
) {
  try {
    await page.waitForFunction(
      (id, ms) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const box = [r.left, r.top, r.width, r.height].map(Math.round).join();
        const now = performance.now();
        if (window.__qaStillBox !== box) {
          window.__qaStillBox = box;
          window.__qaStillSince = now;
        }
        return now - window.__qaStillSince >= ms;
      },
      { polling: 100, timeout },
      panelId,
      stillMs,
    );
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
  }
}

/** Record the next pointerdown's target and the panel's box at that moment. */
export function recordNextPress(page, panelId) {
  return page.evaluate((id) => {
    window.__qaPressBox = null;
    window.addEventListener(
      'pointerdown',
      (event) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const target = event.target;
        window.__qaPressBox = {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          target: `${target.tagName?.toLowerCase()}${target.id ? `#${target.id}` : ''}.${[...(target.classList || [])].join('.')}`,
          inHeader: Boolean(target.closest?.(`#${id} .panel-header`)),
        };
      },
      { capture: true, once: true },
    );
  }, panelId);
}

function readPress(page) {
  return page.evaluate(() => window.__qaPressBox ?? null);
}

export async function waitForFloating(
  page,
  panelId,
  floating,
  { timeout = 3000 } = {},
) {
  try {
    await page.waitForFunction(
      (id, want) =>
        document.getElementById(id).classList.contains('panel-floating') ===
        want,
      { polling: 50, timeout },
      panelId,
      floating,
    );
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
  }
}

/** Two paints: by then every layout change an input caused is on screen. */
export function nextFrames(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export async function dragPointer(page, from, dx, dy, { steps = 6 } = {}) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps });
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
  await nextFrames(page);
}

export function describeRetry(
  panelId,
  attempt,
  { round, retries, extra = '' },
) {
  const { hit, pressed, timedOut, still, box } = attempt;
  return [
    `retry ${round + 1}/${retries}: the press missed the ${panelId} header (on ${pressed?.target ?? hit.target})`,
    `pre-press hit check ${timedOut ? `timed out (on ${hit.target})` : 'passed'}`,
    `stillness ${still === false ? 'timed out' : 'held'}`,
    `panel box at hit check ${formatBox(box)} -> at press ${formatBox(pressed)}`,
  ]
    .concat(extra ? [extra] : [])
    .join('; ');
}

/** Retry `press` only while it provably misses the header. */
async function pressUntilDecided(
  page,
  panelId,
  press,
  {
    retries,
    log,
    note,
    pauseMs = RETRY_PAUSE_MS,
    failOnRetry = failOnRetryDefault(),
  },
) {
  for (let round = 0; ; round++) {
    const still = await waitForStill(page, panelId);
    await recordNextPress(page, panelId);
    const { point, hit, timedOut, box } = await headerTarget(page, panelId);
    const done = await press(point);
    const attempt = {
      point,
      hit,
      timedOut,
      still,
      box,
      done,
      pressed: await readPress(page),
      retries: round,
    };
    if (round >= retries || !pressMissed(attempt)) return attempt;
    const why = describeRetry(panelId, attempt, {
      round,
      retries,
      extra: note ? await note() : '',
    });
    if (failOnRetry && !panelMoved(box, attempt.pressed))
      throw new Error(
        `QA_FAIL_ON_RETRY=1 turns this retry into a failure: ${why}`,
      );
    log(`note: ${why}; retrying`);
    log(`::warning title=Panel press retried::${why}`);
    await delay(pauseMs);
  }
}

/**
 * Lift a docked panel into a floating window with a header drag.
 * @returns {Promise<{point: {x: number, y: number}, hit: {target: string, inHeader: boolean}, done: boolean, pressed: object|null}>}
 */
export function liftPanelByHeader(
  page,
  panelId,
  {
    dx,
    dy,
    retries = PRESS_RETRIES,
    log = console.log,
    note,
    pauseMs,
    failOnRetry,
  } = {},
) {
  return pressUntilDecided(
    page,
    panelId,
    async (point) => {
      await dragPointer(page, point, dx, dy);
      return waitForFloating(page, panelId, true);
    },
    { retries, log, note, pauseMs, failOnRetry },
  );
}

/** Dock a floating panel with a header double-click; same result as lifting. */
export function dockPanelByDoubleClick(
  page,
  panelId,
  {
    retries = PRESS_RETRIES,
    log = console.log,
    note,
    pauseMs,
    failOnRetry,
  } = {},
) {
  return pressUntilDecided(
    page,
    panelId,
    async (point) => {
      await page.mouse.click(point.x, point.y, { clickCount: 1 });
      await page.mouse.click(point.x, point.y, { clickCount: 2 });
      return waitForFloating(page, panelId, false);
    },
    { retries, log, note, pauseMs, failOnRetry },
  );
}

/** Where an attempt pressed, for an assertion message. */
export function describePress(attempt) {
  const { point, hit, pressed } = attempt;
  const where = `pressed ${Math.round(point.x)},${Math.round(point.y)}`;
  if (!pressed)
    return `${where}: no pointerdown reached the page (hit check on ${hit.target}, in header: ${hit.inHeader})`;
  const n = attempt.retries || 0;
  const retried = n ? `, after ${n} ${n === 1 ? 'retry' : 'retries'}` : '';
  return `${where} on ${pressed.target}, in header: ${pressed.inHeader}${retried}`;
}
