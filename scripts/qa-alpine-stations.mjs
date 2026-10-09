#!/usr/bin/env node
/**
 * qa-alpine-stations — drive the Alpine Stations layer in the real app and
 * check the things unit tests cannot see.
 *
 * Three claims in particular only hold in a browser:
 *   - the `/api/alpine-stations` route is actually mounted, rather than being
 *     answered by the SPA fallback with `index.html` (see the container-restart
 *     note in docs/ALPINE-STATIONS.md);
 *   - changing the selected parameter RECOLOURS the existing entities instead
 *     of rebuilding them, which is checked by identity, not by count;
 *   - settling the camera does not rebuild geometry, and does not leave a
 *     continuous-render hold behind.
 *
 * Usage:
 *   node scripts/qa-alpine-stations.mjs [--url http://localhost:4173]
 *     [--headless] [--out qa-shots/alpine-stations]
 *
 * Requires a running dev or preview server with network access to the three
 * upstream networks. Exits non-zero on the first failed check.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] !== undefined && !argv[at + 1].startsWith('--')
    ? argv[at + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);
const base = arg('--url', 'http://localhost:4173');
const url = `${base}${base.includes('?') ? '&' : '?'}welcome=0`;
const outDir = path.resolve(arg('--out', 'qa-shots/alpine-stations'));
const LAYER = 'alpine-stations';
const PARAMETERS = ['wind', 'temperature', 'snow', 'precipitation', 'pressure'];

mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
let failed = 0;
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const browser = await puppeteer.launch({
  headless: flag('--headless') ? 'new' : false,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  protocolTimeout: 300_000,
  defaultViewport: null,
  // Plain --use-gl=swiftshader fails to create a WebGL context in this Chrome.
  args: [
    '--no-sandbox',
    '--window-size=1400,1000',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-background-timer-throttling',
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 920 });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120_000 });

  // 1. The route is mounted, and answers JSON rather than the SPA fallback.
  //    Fetched from inside the page, so it goes through the same origin the
  //    app uses rather than through a separate client.
  const envelope = await page
    .evaluate(async () => {
      const response = await fetch('/api/alpine-stations');
      const type = response.headers.get('content-type') || '';
      if (!type.includes('json'))
        return { contentType: type, body: (await response.text()).slice(0, 80) };
      return { contentType: type, ...(await response.json()) };
    })
    .catch((error) => ({ error: error.message }));

  check(
    'the proxy route answers JSON, not the SPA fallback',
    envelope.contentType?.includes('json'),
    envelope.contentType?.includes('json')
      ? envelope.contentType
      : `got ${envelope.contentType}: ${envelope.body ?? envelope.error}`,
  );
  check(
    'the proxy merges every network',
    envelope.networks?.length === 3,
    `${envelope.networks?.length} networks`,
  );
  check(
    'at least one network is reachable',
    envelope.unavailable === false,
    envelope.reason || 'all ok',
  );
  check(
    'the envelope carries stations with positions',
    envelope.stations?.length > 100 &&
      envelope.stations.every(
        (station) =>
          Number.isFinite(station.lat) && Number.isFinite(station.lon),
      ),
    `${envelope.stations?.length} stations`,
  );
  check(
    'the envelope credits the operators it used',
    /CC BY 4\.0/.test(envelope.attribution || ''),
    envelope.attribution,
  );
  check(
    'an absent reading is null and a measured zero is kept',
    envelope.stations?.some((station) => station.snowDepthCm === 0) &&
      envelope.stations?.some((station) => station.snowDepthCm === null),
  );
  check(
    'no network reports a sea-level pressure it cannot supply',
    envelope.stations
      ?.filter((station) => station.pressureQffHpa !== null)
      .every((station) => station.pressureQffHpa > 870),
    'a reading below 870 hPa would be station-level, not QFF',
  );

  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 120_000,
  });
  // The loading screen covers the panel until it is hidden.
  await page
    .waitForFunction(
      () =>
        !document.getElementById('loading-screen') ||
        document.getElementById('loading-screen').classList.contains('hidden'),
      { timeout: 120_000 },
    )
    .catch(() => {});

  // 2. The row exists, in the Weather group, and enabling it works.
  const row = await page.evaluate((id) => {
    const node = document.querySelector(`[data-layer-id="${id}"]`);
    if (!node) return null;
    const button = node.querySelector('.data-toggle-btn');
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return { group: node.closest('[data-layer-group]')?.dataset.layerGroup ?? null };
  }, LAYER);
  check('the layer has a row in the data-layers panel', row !== null);

  await page
    .waitForFunction(
      (id) => {
        const entry = window.__godsEyeView.dataManager.layers.get(id);
        return entry?.enabled && entry.module.getStats().count > 0;
      },
      { timeout: 180_000, polling: 500 },
      LAYER,
    )
    .catch(() => {});

  // The app exposes no `window.Cesium` (qa-cctv-v2 / qa-transit precedent), so
  // a destination is built through the scene's own ellipsoid.
  const flyTo = (lon, lat, height) =>
    page.evaluate(
      ({ lon, lat, height }) => {
        const { viewer } = window.__godsEyeView;
        const d2r = Math.PI / 180;
        viewer.camera.cancelFlight();
        viewer.camera.flyTo({
          destination: viewer.scene.ellipsoid.cartographicToCartesian({
            longitude: lon * d2r,
            latitude: lat * d2r,
            height,
          }),
          duration: 0,
        });
      },
      { lon, lat, height },
    );

  const readState = (id) =>
    page.evaluate((layerId) => {
      const app = window.__godsEyeView;
      const entry = app.dataManager.layers.get(layerId);
      const module = entry?.module;
      const source = app.viewer.dataSources._dataSources?.find(
        (candidate) => candidate.name === layerId,
      );
      const entities = source ? source.entities.values : [];
      const controls = module?.getRowControls?.() ?? null;
      // Point graphics are Cesium Properties, not plain values: reading them
      // without getValue() yields objects that compare equal for every marker,
      // which would make a colour check pass without ever seeing a colour.
      const valueOf = (property) =>
        property?.getValue ? property.getValue() : property;
      return {
        enabled: Boolean(entry?.enabled),
        show: Boolean(source?.show),
        stats: module?.getStats?.() ?? null,
        params: module?.getParams?.() ?? null,
        entityCount: entities.length,
        // Identity, so a rebuild is distinguishable from a recolour.
        entityIds: entities.slice(0, 40).map((entity) => entity.id),
        colors: entities.slice(0, 40).map((entity) => {
          const color = valueOf(entity.point?.color);
          return color?.toCssHexString?.() ?? null;
        }),
        sizes: entities
          .slice(0, 40)
          .map((entity) => valueOf(entity.point?.pixelSize) ?? null),
        // Arrow state: a billboard that is shown, its screen rotation, and
        // whether the dot it replaced is correctly hidden.
        arrows: entities
          .slice(0, 60)
          .filter((entity) => valueOf(entity.billboard?.show) === true)
          .map((entity) => ({
            id: entity.id,
            rotation: valueOf(entity.billboard.rotation) ?? null,
            width: valueOf(entity.billboard.width) ?? null,
            pointShown: valueOf(entity.point?.show) !== false,
          })),
        legend: controls?.legend?.length ?? 0,
        listItems: controls?.list?.items?.map((item) => item.id) ?? [],
        status: controls?.summary?.status ?? null,
        units: controls?.summary?.units ?? null,
        hasResult: Boolean(controls?.summary?.result),
        renderHolds: app.getRenderGovernorDiagnostics?.().holds ?? null,
      };
    }, id);

  const enabled = await readState(LAYER);
  check('enabling the row loads the layer', enabled.enabled && enabled.show);
  check(
    'the layer draws one marker per station',
    enabled.entityCount > 100,
    `${enabled.entityCount} entities`,
  );
  check(
    'every marker has a colour and a pixel size',
    enabled.colors.every(Boolean) && enabled.sizes.every(Number.isFinite),
  );
  check('the layer reports no error', !enabled.stats?.error, enabled.stats?.error || '');
  check(
    'the row reports feed staleness separately from late stations',
    enabled.stats?.stale === false &&
      Number.isInteger(enabled.stats?.staleStations),
    `stale=${enabled.stats?.stale} staleStations=${enabled.stats?.staleStations}`,
  );

  // Arrows on the FIRST draw, before any chip has been touched. That is the
  // path a visitor actually takes, and it is a different code path from the
  // one a parameter change follows: the first draw CREATES each billboard
  // while a change UPDATES it. The update path masked a missing `show: true`.
  check(
    'the default wind view draws arrows without touching a chip first',
    enabled.arrows.length > 5,
    `${enabled.arrows.length} arrows in a 60-marker sample of ${enabled.entityCount}`,
  );
  check(
    'and those first-draw arrows report themselves visible',
    enabled.arrows.every((arrow) => !arrow.pointShown),
  );

  // The app opens on the global view, where "nearest stations in view" is
  // correctly empty. The card's list only means anything over the Alps.
  await flyTo(7.75, 46.0, 120_000);
  await sleep(2500);
  const overAlps = await readState(LAYER);
  check(
    'the nearest list is empty from the global view and fills over the Alps',
    enabled.listItems.length === 0 && overAlps.listItems.length > 0,
    `${enabled.listItems.length} -> ${overAlps.listItems.length} rows`,
  );
  await page.screenshot({ path: path.join(outDir, '01-enabled.png') });

  // 3. The WEATHER rail card renders the readings, legend and nearest list.
  const card = await page.evaluate((id) => {
    const node = document.querySelector(`[data-card-id="${id}"]`);
    if (!node) return null;
    const header = node.querySelector('button');
    if (node.dataset.open !== 'true') header?.click();
    const block = (blockId) => node.querySelector(`[data-block-id="${blockId}"]`);
    return {
      title: header?.textContent?.trim() ?? '',
      open: node.dataset.open,
      hasSettings: Boolean(block('settings')),
      hasLegend: Boolean(block('legend')) && !block('legend').hidden,
      // A banded legend renders per-band swatches, not a two-ended ramp: with
      // word labels a ramp shows only "Calm" and "Storm" and leaves the three
      // colours between them unexplained.
      rampVisible: Boolean(
        block('legend')?.querySelector('.rail-card-ramp:not([hidden])'),
      ),
      swatches: [
        ...(block('legend')?.querySelectorAll('.rail-card-legend-entry') ?? []),
      ].map((entry) => ({
        colour: entry.dataset.color ?? '',
        label: entry.textContent.trim(),
      })),
      chips: [...node.querySelectorAll('[data-chip-id]')].map((chip) => ({
        id: chip.dataset.chipId,
        active: chip.classList.contains('active'),
      })),
      listRows: [...(block('stations')?.querySelectorAll('.data-row-list-item') ?? [])]
        .map((item) => item.textContent.trim())
        .slice(0, 8),
      detailLines: [...(block('details')?.children ?? [])]
        .map((line) => line.textContent.trim())
        .filter(Boolean),
    };
  }, LAYER);

  check('the card appears in the WEATHER rail', card !== null);
  check('the card is titled for the layer', /Alpine Stations/i.test(card?.title || ''), card?.title);
  check(
    'the card offers every parameter, with exactly one active',
    card?.chips.length === PARAMETERS.length &&
      card.chips.filter((chip) => chip.active).length === 1 &&
      PARAMETERS.every((id) => card.chips.some((chip) => chip.id === id)),
    card?.chips.map((chip) => `${chip.id}${chip.active ? '*' : ''}`).join(','),
  );
  check(
    'the card explains every band, with a swatch and a name',
    card?.hasLegend &&
      card.swatches.length === overAlps.legend &&
      overAlps.legend >= 5 &&
      card.swatches.every((entry) => entry.label && /^#[0-9a-f]{6}$/i.test(entry.colour)),
    `${card?.swatches.length}/${overAlps.legend} bands: ${card?.swatches.map((e) => e.label).join(', ')}`,
  );
  check(
    'and does not also draw a two-ended ramp over them',
    !card?.rampVisible,
  );
  check(
    'the card lists the nearest stations in view',
    card?.listRows.length > 0 && overAlps.listItems.length > 0,
    `${overAlps.listItems.length} rows: ${card?.listRows[0] ?? ''}`,
  );
  check(
    'the card reports how much of the network is reporting',
    card?.detailLines.some((line) => /reporting/.test(line)),
    card?.detailLines[0] ?? '',
  );

  // 4. A parameter change must RECOLOUR, not rebuild.
  const clickChip = (chipId) =>
    page.evaluate(
      ({ id, chip }) => {
        const button = document.querySelector(
          `[data-card-id="${id}"] [data-chip-id="${chip}"]`,
        );
        if (!button || button.disabled) return false;
        button.scrollIntoView({ block: 'center' });
        button.click();
        return true;
      },
      { id: LAYER, chip: chipId },
    );

  check('the snow chip is clickable at its own centre', await clickChip('snow'));
  await sleep(900);
  const snow = await readState(LAYER);
  check('the chip change applied the parameter', snow.params?.parameter === 'snow', snow.params?.parameter);
  check(
    'changing parameter recolours in place, keeping every entity',
    snow.entityCount === overAlps.entityCount &&
      JSON.stringify(snow.entityIds) === JSON.stringify(overAlps.entityIds),
    `${overAlps.entityCount} -> ${snow.entityCount} entities`,
  );
  check(
    'and the markers really did change colour',
    snow.colors.some(Boolean) &&
      JSON.stringify(snow.colors) !== JSON.stringify(overAlps.colors),
    `${overAlps.colors[0]} -> ${snow.colors[0]}`,
  );
  check('the legend follows the parameter', snow.units === 'cm', snow.units);
  await page.screenshot({ path: path.join(outDir, '02-snow.png') });

  // Every parameter must survive being selected, including the two that only
  // some networks publish.
  for (const parameter of PARAMETERS) {
    await clickChip(parameter);
    await sleep(500);
    const state = await readState(LAYER);
    check(
      `the ${parameter} view draws without error`,
      state.params?.parameter === parameter &&
        !state.stats?.error &&
        state.entityCount === overAlps.entityCount,
      `${state.entityCount} entities, status: ${state.status ?? 'none'}`,
    );
  }

  await clickChip('temperature');
  await sleep(600);
  await page.screenshot({ path: path.join(outDir, '03-temperature.png') });

  // 5. Wind arrows: shown only in the wind view, and actually turned to a
  //    world bearing rather than left at a fixed screen angle.
  await clickChip('wind');
  await sleep(900);
  const windView = await readState(LAYER);
  check(
    'the wind view draws arrows',
    windView.arrows.length > 10,
    `${windView.arrows.length} arrows in a 60-marker sample of ${windView.entityCount}`,
  );
  check(
    'an arrow hides the dot it replaces',
    windView.arrows.every((arrow) => !arrow.pointShown),
  );
  check(
    'arrows carry a real screen rotation, not a default of zero',
    windView.arrows.some((arrow) => Number.isFinite(arrow.rotation) && arrow.rotation !== 0),
    `rotations: ${windView.arrows.slice(0, 3).map((arrow) => arrow.rotation?.toFixed(3)).join(', ')}`,
  );
  check(
    'arrows point in different directions, as a wind field does',
    new Set(windView.arrows.map((arrow) => arrow.rotation?.toFixed(2))).size > 2,
  );
  await page.screenshot({ path: path.join(outDir, '05-wind-arrows.png') });

  // Rotating the camera must turn the arrows, because a billboard is a
  // camera-facing quad and the bearing is resolved in screen space.
  const beforeTurn = new Map(
    windView.arrows.map((arrow) => [arrow.id, arrow.rotation]),
  );
  await page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const d2r = Math.PI / 180;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: viewer.camera.positionWC.clone(),
      orientation: { heading: 90 * d2r, pitch: -90 * d2r, roll: 0 },
    });
  });
  await sleep(1800);
  const turned = await readState(LAYER);
  const moved = turned.arrows.filter(
    (arrow) =>
      beforeTurn.has(arrow.id) && beforeTurn.get(arrow.id) !== arrow.rotation,
  );
  check(
    'turning the camera re-aims the arrows',
    moved.length > 0,
    `${moved.length} of ${turned.arrows.length} arrows turned`,
  );
  check(
    'and re-aiming rebuilt no geometry',
    turned.entityCount === windView.entityCount &&
      JSON.stringify(turned.entityIds) === JSON.stringify(windView.entityIds),
  );
  check(
    're-aiming took no continuous render hold',
    !turned.renderHolds || !JSON.stringify(turned.renderHolds).includes(LAYER),
    JSON.stringify(turned.renderHolds),
  );

  // Switching away from wind must put the dots back.
  await clickChip('snow');
  await sleep(800);
  const snowView = await readState(LAYER);
  check(
    'leaving the wind view puts the dots back',
    snowView.arrows.length === 0 && snowView.entityCount === windView.entityCount,
    `${snowView.arrows.length} arrows remain`,
  );

  await clickChip('wind');
  await sleep(700);

  // 6. Selecting a station from the list, and clearing it.
  const selected = await page.evaluate((id) => {
    const row = document.querySelector(
      `[data-card-id="${id}"] [data-block-id="stations"] .data-row-list-item`,
    );
    if (!row) return null;
    const label = row.textContent.trim();
    row.click();
    return label;
  }, LAYER);
  await sleep(600);
  const afterSelect = await readState(LAYER);
  check('a list row selects its station', afterSelect.hasResult, selected ?? 'no row');
  const cleared = await page.evaluate((id) => {
    const button = document.querySelector(
      `[data-card-id="${id}"] [data-action-id="clear"]`,
    );
    button?.click();
    return Boolean(button);
  }, LAYER);
  await sleep(500);
  const afterClear = await readState(LAYER);
  check('and the selection can be cleared', cleared && !afterClear.hasResult);

  // 7. Settling the camera refreshes the list without touching geometry.
  const beforeMove = await readState(LAYER);
  await flyTo(13.0, 47.3, 60_000);
  await sleep(2500);
  const afterMove = await readState(LAYER);
  check(
    'settling the camera rebuilds no geometry',
    afterMove.entityCount === beforeMove.entityCount &&
      JSON.stringify(afterMove.entityIds) === JSON.stringify(beforeMove.entityIds),
    `${beforeMove.entityCount} -> ${afterMove.entityCount}`,
  );
  check(
    'but it does refresh the nearest list for the new view',
    JSON.stringify(afterMove.listItems) !== JSON.stringify(beforeMove.listItems),
    `${beforeMove.listItems[0] ?? '-'} -> ${afterMove.listItems[0] ?? '-'}`,
  );
  check(
    'the layer holds no continuous render',
    !afterMove.renderHolds ||
      !JSON.stringify(afterMove.renderHolds).includes(LAYER),
    JSON.stringify(afterMove.renderHolds),
  );
  await page.screenshot({ path: path.join(outDir, '04-austria.png') });

  // 8. The attribution is ON THE GLOBE, not only in the lightbox, because
  //    SLF's terms require a clearly visible linked reference while the data
  //    is displayed.
  const onScreen = await page.evaluate(() => {
    const line = document.querySelector('.cesium-widget-credits');
    return {
      text: line?.textContent ?? '',
      links: [...(line?.querySelectorAll('a') ?? [])].map((a) => a.href),
    };
  });
  check(
    'SLF is named in full on the globe, as the licence requires',
    onScreen.text.includes('WSL Institute for Snow and Avalanche Research SLF'),
    onScreen.text.slice(0, 120),
  );
  check(
    'and linked to slf.ch, as the licence requires',
    onScreen.links.some((href) => href.startsWith('https://www.slf.ch/')),
  );
  for (const operator of ['MeteoSwiss', 'GeoSphere Austria'])
    check(`${operator} is credited on the globe`, onScreen.text.includes(operator));
  check('the on-globe credit states the licence', /CC BY 4\.0/.test(onScreen.text));

  const credits = await page.evaluate(() => {
    const lightbox = document.querySelector('.cesium-credit-lightbox');
    document.querySelector('.cesium-credit-expand-link')?.click();
    return (lightbox?.textContent || document.body.textContent || '').slice(0, 20_000);
  });
  for (const operator of ['SLF', 'MeteoSwiss', 'GeoSphere Austria'])
    check(`${operator} is credited in the lightbox too`, credits.includes(operator));

  // 9. Disabling releases everything.
  await page.evaluate((id) => {
    document.querySelector(`[data-layer-id="${id}"] .data-toggle-btn`)?.click();
  }, LAYER);
  await sleep(900);
  const off = await readState(LAYER);
  check('disabling hides the layer', !off.enabled && !off.show);
  check(
    'the on-globe credit leaves with the layer',
    !(await page.evaluate(
      () =>
        document
          .querySelector('.cesium-widget-credits')
          ?.textContent?.includes('Avalanche Research SLF') ?? false,
    )),
  );
  check(
    'the card leaves the WEATHER rail with the layer',
    await page.evaluate(
      (id) => !document.querySelector(`[data-card-id="${id}"]`),
      LAYER,
    ),
  );

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  writeFileSync(
    path.join(outDir, 'checks.json'),
    `${JSON.stringify({ url, checks, failed }, null, 2)}\n`,
  );
  console.log(
    `\n  ${checks.length - failed}/${checks.length} checks passed — evidence in ${outDir}`,
  );
} finally {
  await browser.close();
}

process.exit(failed === 0 ? 0 : 1);
