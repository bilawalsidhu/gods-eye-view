const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const BOSTON = {
  id: 'boston',
  label: 'Boston (MBTA)',
  lat: 42.3554,
  lon: -71.0605,
  heading: 25,
  zone: 'America/New_York',
};
const LIVE_CITIES = [
  BOSTON,
  {
    id: 'austin',
    label: 'Austin (CapMetro)',
    lat: 30.2672,
    lon: -97.7431,
    heading: 340,
    zone: 'America/Chicago',
  },
  {
    id: 'minneapolis',
    label: 'Minneapolis (Metro Transit)',
    lat: 44.9778,
    lon: -93.265,
    heading: 0,
    zone: 'America/Chicago',
  },
  {
    id: 'helsinki',
    label: 'Helsinki (HSL)',
    lat: 60.1699,
    lon: 24.9384,
    heading: 0,
    zone: 'Europe/Helsinki',
  },
  {
    id: 'oslo',
    label: 'Oslo (Entur)',
    lat: 59.9139,
    lon: 10.7522,
    heading: 0,
    zone: 'Europe/Oslo',
  },
];
export function chooseLiveCities(now = new Date()) {
  return LIVE_CITIES.filter((city) => {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: city.zone,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(now),
    );
    return hour >= 6 && hour < 22;
  }).slice(0, 2);
}

/**
 * Switch the post-FX style the way a user does — the preset button — and
 * fall back to the style manager only when the tray is not clickable, saying
 * so. Then set any style parameters through their sliders.
 * @param {import('puppeteer').Page} page
 * @param {string} name
 * @param {Record<string, number>} [params] aria-label → slider value
 * @returns {Promise<string>} how the style was set
 */
export async function selectStyle(page, name, params = {}, wait = pause) {
  let how = 'button';
  // The presets live in the bottom control panel, which auto-dismisses when
  // the pointer leaves it: pin it open the way a user does, once.
  await page.evaluate(() => {
    const panel = document.getElementById('control-panel');
    if (panel && !panel.classList.contains('dock-pinned')) {
      document
        .querySelector('.dock-pin-btn[data-pin-target="control-panel"]')
        ?.click();
    }
    window.__godsEyeView.styleManager.setPanelCollapsed?.(
      'control-panel',
      false,
      { explicit: true },
    );
  });
  await wait(400);
  try {
    await page.$eval(`.style-btn[data-style="${name}"]`, (el) =>
      el.scrollIntoView({ block: 'center' }),
    );
    await page.click(`.style-btn[data-style="${name}"]`);
  } catch {
    how = 'styleManager.setStyle (button not clickable)';
    await page.evaluate(
      (n) => window.__godsEyeView.styleManager.setStyle(n),
      name,
    );
  }
  // A click can be swallowed by a loading cover or a collapsed tray without
  // Puppeteer throwing. Verify the active style before querying generated rows.
  if (
    !(await page.evaluate(
      (n) => document.documentElement.dataset.gevStyle === n,
      name,
    ))
  ) {
    how = 'styleManager.setStyle (button did not activate style)';
    await page.evaluate(
      (n) => window.__godsEyeView.styleManager.setStyle(n),
      name,
    );
  }
  await page.waitForFunction(
    (n) => document.documentElement.dataset.gevStyle === n,
    { timeout: 10000 },
    name,
  );
  await wait(1_800);
  for (const [label, value] of Object.entries(params)) {
    const selector = `#param-sliders input.param-slider[aria-label="${label}"]`;
    await page.waitForSelector(selector, { timeout: 10000 });
    await page.$eval(
      selector,
      (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      value,
    );
    await wait(700);
  }
  return how;
}

/**
 * Turn DETECT on through its own button, cycling until the dense profile is
 * reported on the detection surface.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<string>} the profile reached
 */
export async function detectOn(page, wait = pause) {
  // The real button toggles OFF/restore. Density determines its on-profile.
  const mode = () =>
    page.evaluate(() => {
      const button = document.getElementById('detection-toggle');
      const label = button?.getAttribute('aria-label') || '';
      return {
        on: button?.getAttribute('aria-pressed') === 'true',
        mode: (label.split(':')[1] || 'off').trim().toUpperCase(),
      };
    });
  // The loading screen swallows the first click of a fresh page.
  await page
    .waitForFunction(() => !document.getElementById('loading-screen'), {
      timeout: 30_000,
    })
    .catch(() => {});
  // The DISPLAY rail starts collapsed on a first run: open it the way a user
  // does, then press DETECT until it reports on.
  await page.evaluate(() => {
    const rail = document.getElementById('pp-toggles');
    if (rail?.classList.contains('collapsed'))
      document
        .querySelector('.panel-collapse-btn[data-collapse-target="pp-toggles"]')
        ?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById('detection-toggle')?.getBoundingClientRect()
        .width > 0,
    { timeout: 10_000 },
  );
  if (!(await mode()).on) {
    await page.click('#detection-toggle');
    await wait(300);
  }
  await page.$eval('#detection-density-slider', (el) => {
    el.value = '100';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(
    () =>
      document
        .getElementById('detection-toggle')
        ?.getAttribute('aria-label') === 'Detection overlay: dense',
    { timeout: 10000 },
  );
  // Prove the button's actual OFF/restore cycle preserves DENSE.
  await page.click('#detection-toggle');
  await page.waitForFunction(
    () =>
      document
        .getElementById('detection-toggle')
        ?.getAttribute('aria-pressed') === 'false',
    { timeout: 10000 },
  );
  await page.click('#detection-toggle');
  await page.waitForFunction(
    () =>
      document
        .getElementById('detection-toggle')
        ?.getAttribute('aria-label') === 'Detection overlay: dense',
    { timeout: 10000 },
  );
  return (await mode()).mode;
}
