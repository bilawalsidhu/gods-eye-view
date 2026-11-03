import assert from 'node:assert/strict';
export async function switchGlobe(page, kind) {
  const start = await page.evaluate(() => performance.timeOrigin);
  await page.select('#globe-engine', kind);
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine.kind === expected &&
      !document.querySelector('#globe-engine')?.disabled &&
      !document.querySelector('.engine-switch-frame') &&
      document.querySelector('#loading-screen.hidden'),
    { timeout: 90000 },
    kind,
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  assert.equal(
    await page.evaluate(() => performance.timeOrigin),
    start,
    'same document after switching globes',
  );
}
