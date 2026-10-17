#!/usr/bin/env node
/**
 * The W1 layer parity checklist (plan, "Чек-лист паритета"), engine-neutral:
 * everything goes through the globe engine and the QA probe
 * (window.__godsEyeView.layers), the layer's data through the QA fixture
 * sources (?qaFeed=, src/app/layers/qaSources.js). The same run on Cesium and
 * on Navara writes comparable JSON; --compare diffs two runs.
 *
 *   node scripts/qa-w1-layers.mjs --base-url=http://localhost:PORT/
 *     --layer=flights --engine=cesium|navara [--feed=flights:synthetic:10000]
 *     [--out=qa-artifacts/w1-layers/<layer>-<engine>.json]
 *   node scripts/qa-w1-layers.mjs --compare=A.json,B.json
 *
 * Sections (the checklist's numbers). Filled now: 1 view (object counts per
 * pose, screen points of 5 known objects), 2 click for layers with a tracked
 * selection (a real mouse click selects the clearest object at the city pose,
 * empty space and Escape release it; the select latency is recorded) with the
 * follow part of 4, 8 idle (frames drawn in 2 s with
 * the layer on and the camera still), 9 errors (console errors; the layer
 * on/off 10 times leaves no mover sets behind), 5 voice in part (the runner's
 * layer-neutral answers; a viewer-only action refuses off Cesium). 2 click,
 * 3 focus, 4 tracking, the layer queries of 5, 6 share link and 7 the layer's
 * own qa:* scripts are filled by each layer's task (*b); until then they
 * report TODO. A layer the engine does not have is SKIPPED with its reason.
 *
 * The server is the caller's (never ports 4185-4189). Browsers are always
 * headless. Exits 1 on a failed check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const RESERVED_PORTS = new Set([4185, 4186, 4187, 4188, 4189]);
const POSES = {
  global: [-40, 30, 15_000_000, 0, -90],
  city: [-73.78, 40.64, 60_000, 0, -90],
  orbit: [-73.78, 40.64, 1_500_000, 0, -90],
};
const KNOWN_OBJECTS = 5;
const SCREEN_TOLERANCE_PX = 2;
const DEFAULT_FEEDS = {
  flights: 'flights:synthetic:10000',
  // Military with the civil fleet: 25 military hexes are also civil
  // flights (duplicate suppression), and the follow passes between them.
  military: 'military:synthetic:1000,flights:synthetic:10000',
  'local-adsb': 'local-adsb:fixture',
  'ais-live-vessels': 'vessels:fixture',
};
const TODO_SECTIONS = {
  2: 'click',
  3: 'focus',
  4: 'tracking',
  6: 'share link',
  7: "the layer's own qa:* scripts",
};

function compare(files) {
  const [a, b] = files.map((file) =>
    JSON.parse(fs.readFileSync(path.resolve(repoRoot, file), 'utf8')),
  );
  const differences = [];
  for (const pose of Object.keys(a.view ?? {})) {
    const left = a.view[pose];
    const right = b.view?.[pose];
    if (!right) {
      differences.push(`${pose}: missing in ${files[1]}`);
      continue;
    }
    if (left.onScreen !== right.onScreen)
      differences.push(
        `${pose}: ${left.onScreen} vs ${right.onScreen} objects on screen`,
      );
    for (const known of left.known) {
      const other = right.known.find(({ id }) => id === known.id);
      if (!known.screen || !other?.screen) {
        if (Boolean(known.screen) !== Boolean(other?.screen))
          differences.push(`${pose} ${known.id}: on screen on one engine only`);
        continue;
      }
      const d = Math.max(
        Math.abs(known.screen.x - other.screen.x),
        Math.abs(known.screen.y - other.screen.y),
      );
      // At 15,000 km the engines' cameras differ by 2.27 px vertically:
      // Cesium's set-view "up" is the ellipsoid gradient at the camera, 0.117°
      // off the geodetic normal below that Navara uses (qa-flights-engines
      // explains it): a camera difference, reported apart.
      if (d > SCREEN_TOLERANCE_PX && pose === 'global')
        console.log(
          `[w1-layers] INFO ${pose} ${known.id}: ${d.toFixed(2)} px apart (camera)`,
        );
      else if (d > SCREEN_TOLERANCE_PX)
        differences.push(`${pose} ${known.id}: ${d.toFixed(2)} px apart`);
    }
  }
  const qa = a.sections?.[5]?.queries;
  const qb = b.sections?.[5]?.queries;
  if (qa && qb && JSON.stringify(qa) !== JSON.stringify(qb))
    differences.push(
      `5 queries: ${JSON.stringify(qa)} vs ${JSON.stringify(qb)}`,
    );
  for (const line of differences) console.log(`[w1-layers] DIFF ${line}`);
  console.log(
    `[w1-layers] ${a.engine} vs ${b.engine} (${a.layer}): ${
      differences.length ? `${differences.length} difference(s)` : 'parity'
    }`,
  );
  process.exit(differences.length ? 1 : 0);
}

const compareArg = argument('compare');
if (compareArg) compare(compareArg.split(','));

const baseUrl = argument('base-url');
const layer = argument('layer');
const engineKind = argument('engine') ?? 'cesium';
if (!baseUrl || !layer) {
  console.error('--base-url=URL and --layer=ID are required');
  process.exit(2);
}
if (RESERVED_PORTS.has(Number(new URL(baseUrl).port))) {
  console.error('ports 4185-4189 are reserved');
  process.exit(2);
}
const feed = argument('feed') ?? DEFAULT_FEEDS[layer] ?? null;
const outFile =
  argument('out') ?? `qa-artifacts/w1-layers/${layer}-${engineKind}.json`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(
    `  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
};
const report = { layer, engine: engineKind, feed, view: {}, sections: {} };

const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage blocked */
    }
  });
  const url = new URL(baseUrl);
  url.searchParams.set('engine', engineKind);
  if (feed) url.searchParams.set('qaFeed', feed);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
    timeout: 180_000,
    polling: 250,
  });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const available = await page.evaluate(
    (id) => window.__godsEyeView.layers.available(id),
    layer,
  );
  if (!available) {
    report.skipped = `no ${layer} layer on ${engineKind}`;
    console.log(`[w1-layers] SKIP ${report.skipped}`);
  } else {
    await page.evaluate((id) => window.__godsEyeView.layers.enable(id), layer);
    // 1. view: objects per pose, screen points of 5 known objects.
    let known = null;
    for (const [pose, camera] of Object.entries(POSES)) {
      const read = await page.evaluate(
        async ([lon, lat, height, heading, pitch], id) => {
          const geo = await import('/src/geo/index.js');
          const { engine, layers } = window.__godsEyeView;
          const rad = geo.math.toRadians;
          engine.camera.setView({
            destination: geo.cartesian3.fromDegrees(lon, lat, height),
            orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
          });
          for (let frame = 0; frame < 30; frame++) {
            engine.render.request('qa-w1-layers');
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          const { width, height: h } = engine.host.size();
          const objects = layers.objects(id, 1_000_000);
          const inView = objects.filter(
            ({ screen }) =>
              screen &&
              screen.x >= 0 &&
              screen.y >= 0 &&
              screen.x <= width &&
              screen.y <= h,
          );
          return { total: objects.length, inView };
        },
        camera,
        layer,
      );
      known ??= read.inView
        .map(({ id }) => id)
        .sort()
        .slice(0, KNOWN_OBJECTS);
      report.view[pose] = {
        total: read.total,
        onScreen: read.inView.length,
        known: known.map((id) => ({
          id,
          screen: read.inView.find((row) => row.id === id)?.screen ?? null,
        })),
      };
      check(
        `1 view ${pose}: objects drawn`,
        read.total > 0,
        `${read.inView.length}/${read.total} on screen`,
      );
    }
    // 2. click (layers with a tracked selection): a click on an object
    // selects it (and the camera follows), a click on empty space and Escape
    // release it — through the engine's input, as a user clicks.
    const selectable = await page.evaluate(
      (id) =>
        typeof window.__godsEyeView.dataManager.layers.get(id)?.module
          ?.getTrackedInfo === 'function',
      layer,
    );
    if (selectable) {
      await page.evaluate(async ([lon, lat, height, heading, pitch]) => {
        const geo = await import('/src/geo/index.js');
        const { engine } = window.__godsEyeView;
        const rad = geo.math.toRadians;
        engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
        });
        for (let frame = 0; frame < 30; frame++) {
          engine.render.request('qa-w1-layers');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }, POSES.city);
      // The on-screen object farthest from its neighbours (and the edges),
      // and the emptiest point of the screen.
      const pickTargets = () =>
        page.evaluate((id) => {
          const { engine, layers } = window.__godsEyeView;
          const { width, height } = engine.host.size();
          const shown = layers
            .objects(id, 1_000_000)
            .filter(
              ({ screen }) =>
                screen &&
                screen.x > 120 &&
                screen.y > 120 &&
                screen.x < width - 120 &&
                screen.y < height - 120,
            );
          const clearance = (x, y, skip) =>
            Math.min(
              Infinity,
              ...shown
                .filter((row) => row !== skip)
                .map(({ screen }) => Math.hypot(screen.x - x, screen.y - y)),
            );
          // Only points where the canvas itself takes the click (not a panel
          // or an attribution card over it).
          const onCanvas = (x, y) =>
            document.elementFromPoint(x, y) === engine.host.canvas;
          let target = null;
          for (const row of shown) {
            if (!onCanvas(row.screen.x, row.screen.y)) continue;
            const room = clearance(row.screen.x, row.screen.y, row);
            if (!target || room > target.room)
              target = { id: row.id, screen: row.screen, room };
          }
          let empty = null;
          for (let x = 140; x < width - 140; x += 40)
            for (let y = 140; y < height - 140; y += 40) {
              if (!onCanvas(x, y)) continue;
              const room = clearance(x, y, null);
              if (!empty || room > empty.room) empty = { x, y, room };
            }
          return { target, empty };
        }, layer);
      const selectedId = () =>
        page.evaluate((id) => {
          const info = window.__godsEyeView.layers.selected(id);
          return info ? String(info.icao24 ?? info.id ?? '') : null;
        }, layer);
      const waitFor = async (predicate, ms = 3000) => {
        const start = Date.now();
        for (;;) {
          const value = await selectedId();
          if (predicate(value)) return { value, ms: Date.now() - start };
          if (Date.now() - start > ms) return { value, ms: null };
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      const clickAt = (point) => page.mouse.click(point.x, point.y);
      const section = {};
      let targets = await pickTargets();
      section.target = targets.target;
      if (targets.target) {
        await clickAt(targets.target.screen);
        const picked = await waitFor((value) => value === targets.target.id);
        section.selectMs = picked.ms;
        section.following = await page.evaluate(() =>
          window.__godsEyeView.layers.following(),
        );
        check(
          '2 click: a click on an object selects it',
          picked.value === targets.target.id,
          `${targets.target.id} at ${targets.target.screen.x.toFixed(0)},${targets.target.screen.y.toFixed(0)} (${targets.target.room.toFixed(0)} px clear) → ${picked.value} in ${picked.ms} ms`,
        );
        check(
          '4 tracking: the camera follows the selected object',
          Boolean(section.following),
          JSON.stringify(section.following),
        );
        // Let the follow settle, then empty space (re-read: the camera moved).
        await new Promise((resolve) => setTimeout(resolve, 1500));
        targets = await pickTargets();
        section.empty = targets.empty;
        await clickAt(targets.empty);
        const released = await waitFor((value) => value === null);
        check(
          '2 click: a click on empty space releases it',
          released.value === null,
          `at ${targets.empty.x},${targets.empty.y} (${targets.empty.room.toFixed(0)} px clear) → ${released.value}`,
        );
        // Select again, then Escape.
        targets = await pickTargets();
        await clickAt(targets.target.screen);
        const again = await waitFor((value) => value === targets.target.id);
        await page.keyboard.press('Escape');
        const escaped = await waitFor((value) => value === null);
        check(
          '2 click: Escape releases it',
          again.value === targets.target.id && escaped.value === null,
          `${again.value} → ${escaped.value}`,
        );
        section.followingAfter = await page.evaluate(() =>
          window.__godsEyeView.layers.following(),
        );
        check(
          '4 tracking: release frees the camera',
          section.followingAfter === null,
          JSON.stringify(section.followingAfter),
        );
        // 3 focus, 4 tracking, 5 the layer's queries, 6 share link: on the
        // clearest object, selected again by a click.
        targets = await pickTargets();
        const id = targets.target.id;
        await clickAt(targets.target.screen);
        await waitFor((value) => value === id);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // 3. focus: the selected object publishes the focus target the other
        // sprites dim around (data/focusDeemphasis), at its drawn (dead-
        // reckoned) position: the centre of the followed view.
        const focusAt = () =>
          page.evaluate(async () => {
            const { getFocusTarget } =
              await import('/src/data/focusDeemphasis.js');
            const { engine } = window.__godsEyeView;
            const target = getFocusTarget();
            if (!target) return null;
            const { width, height } = engine.host.size();
            const { left, right, top, bottom } = target.screenRect;
            return {
              owner: target.ownerLayer,
              id: target.id,
              width: right - left,
              fromCentre: Math.hypot(
                (left + right) / 2 - width / 2,
                (top + bottom) / 2 - height / 2,
              ),
            };
          });
        const focus = await focusAt();
        report.sections[3] = focus;
        check(
          '3 focus: the selected object is the focus target, at the centre (≤ 3 px)',
          focus?.id === id && focus.fromCentre <= 3,
          JSON.stringify(focus),
        );
        // 4. tracking: the target held in the centre for 5 s.
        let worstHeld = 0;
        for (let step = 0; step < 10; step++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const now = await focusAt();
          worstHeld = Math.max(worstHeld, now?.fromCentre ?? Infinity);
        }
        report.sections[4] = { worstFromCentrePx: worstHeld };
        check(
          '4 tracking: the target held at the centre for 5 s (≤ 3 px)',
          worstHeld <= 3,
          `worst ${worstHeld.toFixed(2)} px`,
        );
        await page.mouse.move(640, 400);
        for (let notch = 0; notch < 25; notch++) {
          await page.mouse.wheel({ deltaY: -600 });
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const range = await page.evaluate(async (layerId) => {
          const geo = await import('/src/geo/index.js');
          const { engine, dataManager } = window.__godsEyeView;
          const module = dataManager.layers.get(layerId).module;
          const target = module.getTrackedSubject?.()?.position;
          return target
            ? geo.cartesian3.distance(engine.camera.livePosition, target)
            : null;
        }, layer);
        report.sections[4].rangeAfterWheelM = range;
        check(
          '4 tracking: wheeled in, the camera keeps ≥ 149 m',
          Number.isFinite(range) && range >= 149,
          `${range?.toFixed(1)} m`,
        );
        // 5. the layer's queries (the voice tools' data), for --compare.
        report.sections[5] = {
          ...(report.sections[5] ?? {}),
          queries: await page.evaluate(
            ([objectId, layerId]) => {
              const module =
                window.__godsEyeView.dataManager.layers.get(layerId).module;
              const tracked = module.getTrackedInfo();
              const subject = module.getTrackedSubject?.();
              const nearby = subject
                ? module.getNearby(subject.position, 50_000, 10)
                : [];
              return {
                tracked: tracked?.icao24 ?? null,
                all: module.getAllPositions(1_000_000).length,
                nearby: nearby.map((row) => row.id).sort(),
                detectable: module.getDetectableObjects({ maxCount: 50 })
                  .length,
                hasContact: module.hasContact(objectId),
              };
            },
            [id, layer],
          ),
        };
        check(
          '5 queries: tracked info and contacts answer',
          report.sections[5].queries.tracked === id &&
            report.sections[5].queries.hasContact === true,
          JSON.stringify(report.sections[5].queries),
        );
        // 6. share link: the link of this page, opened in a fresh page of
        // this engine, restores the layer and the followed object.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const hash = await page.evaluate(() => location.hash);
        report.sections[6] = {};
        for (const opened of [
          engineKind,
          engineKind === 'cesium' ? 'navara' : 'cesium',
        ]) {
          const sharedContext = await browser.createBrowserContext();
          const shared = await sharedContext.newPage();
          await shared.setViewport({ width: 1280, height: 800 });
          const sharedUrl = new URL(page.url());
          sharedUrl.searchParams.set('engine', opened);
          sharedUrl.hash = hash;
          await shared.goto(sharedUrl.href, { waitUntil: 'domcontentloaded' });
          await shared.waitForFunction(
            () => Boolean(window.__godsEyeView?.layers),
            { timeout: 180_000, polling: 250 },
          );
          const restored = await shared
            .waitForFunction(
              (objectId, layerId) =>
                window.__godsEyeView.layers.selected(layerId)?.icao24 ===
                  objectId && window.__godsEyeView.layers.following() !== null,
              { timeout: 60_000, polling: 250 },
              id,
              layer,
            )
            .then(() => true)
            .catch(() => false);
          const sharedState = await shared.evaluate(
            (layerId) => ({
              selected:
                window.__godsEyeView.layers.selected(layerId)?.icao24 ?? null,
              following: window.__godsEyeView.layers.following(),
            }),
            layer,
          );
          await sharedContext.close();
          report.sections[6][opened] = { restored, ...sharedState };
          check(
            `6 share link: opened on ${opened}, the followed object is restored`,
            restored,
            JSON.stringify(sharedState),
          );
        }
        // 4. tracking under navigation, the same on both engines: north-up
        // and tilt keep the follow; a city pill (the place search's fly-to)
        // and voice fly_to_location release it.
        const followedId = () =>
          page.evaluate(
            (layerId) =>
              window.__godsEyeView.layers.selected(layerId)?.icao24 ?? null,
            layer,
          );
        const isFollowing = () =>
          page.evaluate(() => window.__godsEyeView.layers.following() !== null);
        const retrack = async () => {
          await page.evaluate(
            async (objectId, layerId) => {
              window.__godsEyeView.dataManager.layers
                .get(layerId)
                .module.trackById(objectId);
            },
            id,
            layer,
          );
          await new Promise((resolve) => setTimeout(resolve, 2500));
        };
        report.sections[4].navigation = {};
        for (const button of ['#north-up-view', '#tilt-map-view']) {
          await retrack();
          await page.click(button);
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const state = {
            selected: await followedId(),
            following: await isFollowing(),
          };
          report.sections[4].navigation[button] = state;
          check(
            `4 tracking: ${button} keeps the follow`,
            state.selected === id && state.following,
            JSON.stringify(state),
          );
        }
        await retrack();
        // The pills sit in a collapsed row: a DOM click, as the row's own.
        const pill = await page.evaluate(() => {
          const button = document.querySelector('.location-pill');
          button?.click();
          return button?.dataset.locationId ?? null;
        });
        if (pill) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const state = {
            selected: await followedId(),
            following: await isFollowing(),
          };
          report.sections[4].navigation.pill = state;
          check(
            '4 tracking: a city pill (search fly-to) releases the follow and the selection',
            !state.following && state.selected === null,
            JSON.stringify(state),
          );
        }
        await retrack();
        const voiceFly = await page.evaluate(async () => {
          const answer = await window.__gevVoiceCommands?.runner?.(
            'fly_to_location',
            { latitude: 48.8566, longitude: 2.3522, rangeM: 20_000 },
          );
          return { ok: answer?.ok !== false, error: answer?.error ?? null };
        });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const voiceState = {
          ...voiceFly,
          selected: await followedId(),
          following: await isFollowing(),
        };
        report.sections[4].navigation.voiceFlyTo = voiceState;
        check(
          '4 tracking: voice fly_to_location releases the follow and the selection',
          voiceFly.ok && !voiceState.following && voiceState.selected === null,
          JSON.stringify(voiceState),
        );
        await page.keyboard.press('Escape');
      } else {
        check('2 click: an object to click at the city pose', false);
      }
      report.sections[2] = section;
    }
    // Local ADS-B (the same on both engines): a click on a marker selects it
    // and shows its card (receiver line), the camera never follows it, a
    // click on empty map releases it, and Escape does not (the layer has
    // never answered Escape).
    if (layer === 'local-adsb') {
      await page.evaluate(async ([lon, lat, height, heading, pitch]) => {
        const geo = await import('/src/geo/index.js');
        const { engine } = window.__godsEyeView;
        const rad = geo.math.toRadians;
        engine.camera.setView({
          destination: geo.cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 },
        });
        for (let frame = 0; frame < 30; frame++) {
          engine.render.request('qa-w1-layers');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      }, POSES.city);
      const targets = await page.evaluate((id) => {
        const { engine, layers } = window.__godsEyeView;
        const { width, height } = engine.host.size();
        const onCanvas = (x, y) =>
          document.elementFromPoint(x, y) === engine.host.canvas;
        const shown = layers
          .objects(id, 1_000_000)
          .filter(
            ({ screen }) =>
              screen &&
              screen.x > 120 &&
              screen.y > 120 &&
              screen.x < width - 120 &&
              screen.y < height - 120,
          );
        const clearance = (x, y, skip) =>
          Math.min(
            Infinity,
            ...shown
              .filter((row) => row !== skip)
              .map(({ screen }) => Math.hypot(screen.x - x, screen.y - y)),
          );
        let target = null;
        for (const row of shown) {
          if (!onCanvas(row.screen.x, row.screen.y)) continue;
          const room = clearance(row.screen.x, row.screen.y, row);
          if (!target || room > target.room)
            target = { id: row.id, screen: row.screen, room };
        }
        let empty = null;
        for (let x = 140; x < width - 140; x += 40)
          for (let y = 140; y < height - 140; y += 40) {
            if (!onCanvas(x, y)) continue;
            const room = clearance(x, y, null);
            if (!empty || room > empty.room) empty = { x, y, room };
          }
        return { target, empty };
      }, layer);
      const selectedCard = () =>
        page.evaluate(async () => {
          const { getSelectedEntityContext } =
            await import('/src/data/contextStore.js');
          const record = getSelectedEntityContext();
          if (record?.layerId !== 'local-adsb') return null;
          return {
            id: record.id,
            title: record.entity?.gevLabelModel?.title ?? null,
            receiver: record.entity?.gevLabelModel?.details?.at(-1) ?? null,
          };
        });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 800));
      const section = { target: targets.target };
      if (targets.target) {
        const started = Date.now();
        await page.mouse.click(
          targets.target.screen.x,
          targets.target.screen.y,
        );
        let card = null;
        while (Date.now() - started < 3000) {
          card = await selectedCard();
          if (card) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        section.selectMs = card ? Date.now() - started : null;
        section.card = card;
        check(
          '2 click: a click on a local aircraft selects it and shows its card',
          card?.id === `local-adsb:${targets.target.id}` &&
            Boolean(card.title) &&
            /heard|receiver|mhz/i.test(card.receiver ?? ''),
          JSON.stringify(card),
        );
        section.following = await page.evaluate(() =>
          window.__godsEyeView.layers.following(),
        );
        check(
          '4 tracking: the camera does not follow a local aircraft',
          section.following === null,
          JSON.stringify(section.following),
        );
        await page.keyboard.press('Escape');
        await settle();
        const afterEscape = await selectedCard();
        check(
          '2 click: Escape leaves the selection (as before)',
          afterEscape?.id === card?.id,
          JSON.stringify(afterEscape),
        );
        await page.mouse.click(targets.empty.x, targets.empty.y);
        await settle();
        const afterEmpty = await selectedCard();
        check(
          '2 click: a click on empty map releases it',
          afterEmpty === null,
          JSON.stringify(afterEmpty),
        );
        report.sections[4] = { following: section.following };
      } else
        check('2 click: a local aircraft to click at the city pose', false);
      report.sections[2] = section;
    }
    // Military with the civil flights layer (the same on both engines): the
    // follow passes between the two layers, and the flights layer leaves
    // the aircraft both feeds report to the military layer while it is on.
    if (layer === 'military') {
      const both = await page.evaluate(async () => {
        const { layers, dataManager } = window.__godsEyeView;
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const civil = () => dataManager.layers.get('flights').module;
        const military = () => dataManager.layers.get('military').module;
        const count = () => civil().getAllPositions(1_000_000).length;
        const until = async (predicate, ms = 20_000) => {
          const start = Date.now();
          while (!predicate() && Date.now() - start < ms) await wait(100);
          return predicate();
        };
        await layers.enable('flights');
        await until(() => count() > 0);
        await wait(1500);
        const shared = military()
          .getAllPositions(1_000_000)
          .map(({ id }) => id)
          .filter((id) => /^a000/.test(id));
        const withMilitary = count();
        const civilHasShared = shared.some((id) => civil().hasContact(id));
        await layers.disable('military');
        await until(() => count() > withMilitary);
        const withoutMilitary = count();
        await layers.enable('military');
        await until(() => count() < withoutMilitary);
        await wait(1500);
        const restoredMilitary = count();
        // The follow: military → flights → military.
        // The follow's label (the engine's own follow; null on Cesium,
        // which follows the tracked entity: the selection tells there).
        const label = () =>
          layers.following() === null
            ? 'none'
            : (layers.following().label ?? 'entity');
        const milId = military()
          .getAllPositions(1_000_000)
          .map(({ id }) => id)
          .find((id) => !/^a000/.test(id));
        const civilId = civil()
          .getAllPositions(1_000_000)
          .map(({ id }) => id)
          .find((id) => !shared.includes(id));
        military().trackById(milId, { origin: 'voice' });
        await wait(800);
        const first = {
          military: layers.selected('military')?.icao24 ?? null,
          label: label(),
        };
        civil().trackById(civilId, { origin: 'voice' });
        await wait(800);
        const second = {
          military: layers.selected('military')?.icao24 ?? null,
          flights: layers.selected('flights')?.icao24 ?? null,
          label: label(),
        };
        military().trackById(milId, { origin: 'voice' });
        await wait(800);
        const third = {
          military: layers.selected('military')?.icao24 ?? null,
          flights: layers.selected('flights')?.icao24 ?? null,
          label: label(),
        };
        military().stopTracking({ origin: 'user' });
        await layers.disable('flights');
        return {
          shared: shared.length,
          withMilitary,
          withoutMilitary,
          restoredMilitary,
          civilHasShared,
          milId,
          civilId,
          handoff: [first, second, third],
        };
      });
      report.sections[4] = { ...(report.sections[4] ?? {}), withFlights: both };
      const followed = (state, expected) =>
        state.label === expected || state.label === 'entity';
      check(
        '4 tracking: the follow passes military → flights → military',
        both.handoff[0].military === both.milId &&
          followed(both.handoff[0], `military:${both.milId}`) &&
          both.handoff[1].military === null &&
          both.handoff[1].flights === both.civilId &&
          followed(both.handoff[1], `flights:${both.civilId}`) &&
          both.handoff[2].flights === null &&
          followed(both.handoff[2], `military:${both.milId}`),
        JSON.stringify(both.handoff),
      );
      check(
        '1 view: flights leaves the shared aircraft to military while it is on',
        both.withoutMilitary - both.withMilitary === 25 &&
          both.restoredMilitary === both.withMilitary &&
          !both.civilHasShared,
        `flights ${both.withMilitary} with military, ${both.withoutMilitary} without, ${both.restoredMilitary} with it again`,
      );
    }
    // 8. idle: the camera still for 2 s.
    const idleFrames = await page.evaluate(async () => {
      const { layers } = window.__godsEyeView;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const before = layers.framesDrawn();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return layers.framesDrawn() - before;
    });
    report.sections[8] = { framesIn2s: idleFrames };
    console.log(
      `  [INFO] 8 idle: ${idleFrames} frames in 2 s with ${layer} on`,
    );
    // 9. on/off 10 times: no mover sets left behind.
    const leftover = await page.evaluate(async (id) => {
      const { layers } = window.__godsEyeView;
      await layers.disable(id);
      const baseline = layers.movers().length;
      for (let i = 0; i < 10; i++) {
        await layers.enable(id);
        await layers.disable(id);
      }
      return { baseline, after: layers.movers().length };
    }, layer);
    report.sections[9] = { ...leftover, consoleErrors: consoleErrors.length };
    check(
      '9 on/off ×10 leaves no mover sets',
      leftover.after <= leftover.baseline,
      JSON.stringify(leftover),
    );
    check(
      '9 no console errors',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | ') || '0',
    );
    // 5. voice: the runner's answers (window.__gevVoiceCommands.runner), kept
    // in the JSON for --compare; the per-layer queries (track_entity,
    // select_nearest_aircraft, analyst_query, next_*_pass…) are added by the
    // layer tasks.
    const voice = await page.evaluate(async (id) => {
      const runner = window.__gevVoiceCommands?.runner;
      if (!runner) return { available: false };
      const ask = async (name, args) => {
        try {
          const answer = await runner(name, args);
          return {
            ok: answer?.ok !== false,
            code: answer?.code ?? null,
            error: answer?.ok === false ? String(answer.error ?? '') : null,
          };
        } catch (error) {
          return { ok: false, thrown: String(error?.message ?? error) };
        }
      };
      return {
        available: true,
        setVisibility: await ask('set_layer_visibility', {
          layerId: id,
          enabled: true,
        }),
        viewState: await ask('get_current_view_state', {}),
        frameOverhead: await ask('frame_overhead', { target: id }),
        cockpit: await ask('control_cockpit', { action: 'enter' }),
      };
    }, layer);
    // Kept beside the layer's queries (5), which --compare reads.
    report.sections[5] = { ...(report.sections[5] ?? {}), ...voice };
    check('5 voice: the runner is there', voice.available === true);
    if (voice.available) {
      check(
        '5 voice: set_layer_visibility',
        voice.setVisibility.ok,
        JSON.stringify(voice.setVisibility),
      );
      check(
        '5 voice: get_current_view_state',
        voice.viewState.ok,
        JSON.stringify(voice.viewState),
      );
      console.log(
        `  [INFO] 5 voice: frame_overhead ${JSON.stringify(voice.frameOverhead)}; control_cockpit ${JSON.stringify(voice.cockpit)}`,
      );
      if (engineKind !== 'cesium')
        check(
          '5 voice: a viewer-only action refuses (UNAVAILABLE_ON_ENGINE)',
          voice.cockpit.code === 'UNAVAILABLE_ON_ENGINE',
          JSON.stringify(voice.cockpit),
        );
    }
    for (const [number, name] of Object.entries(TODO_SECTIONS)) {
      if (report.sections[number]) continue;
      report.sections[number] = 'TODO';
      console.log(
        `  [TODO] ${number} ${name} — filled by the ${layer} layer task`,
      );
    }
  }
} finally {
  await browser.close();
}
const file = path.resolve(repoRoot, outFile);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(report, null, 2));
const failed = results.filter(({ pass }) => !pass).length;
console.log(
  `[w1-layers] ${layer} on ${engineKind}: ${results.length - failed}/${results.length} passed → ${outFile}`,
);
process.exit(failed ? 1 : 0);
