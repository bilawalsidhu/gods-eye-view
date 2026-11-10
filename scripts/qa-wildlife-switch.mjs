import assert from 'node:assert/strict';
import { fromDegrees } from '../src/geo/cartesian3.js';
import { fromCartesian } from '../src/geo/cartographic.js';
import {
  WILDLIFE_SIGHTINGS,
  WILDLIFE_VIEW,
  wildlifeRoutes,
} from './fixtures/wildlife.mjs';
import {
  createStrict,
  localPreview,
  openPage,
  waitForCameraAtRest,
  waitForEngine,
} from './qa-strict-harness.mjs';

// Wildlife Sightings over Cesium → Navara → Cesium → Navara: on each engine
// the four fixture sightings are badges in engine.movers at their positions
// (each one picks as itself), the density glow is its own sprite set, and
// the obscured record's privacy cell is a fill and outline on engine.ground; a
// pointer click on a badge selects that sighting and opens its card.
//
// The first two switches are made from the keyboard with the card open (Tab
// to the Globe Engine picker, then type-ahead): the layer keeps its model,
// the selection and the card. A pointer on the picker is a click outside the
// card, which closes it by design, so the last switch (pointer and keyboard
// on the picker) checks that instead, with the model kept.
//
//   node scripts/qa-wildlife-switch.mjs http://127.0.0.1:4260

const LAYER = 'wildlife-sightings';
const BADGES = 'wildlife-sightings';
const GLOW = 'wildlife-sightings-density';
const CELL_SET = 'wildlife-sightings-cells';
// One density cell per iNaturalist observation (Acartia has no grid).
const GLOW_CELLS = WILDLIFE_SIGHTINGS.filter((s) =>
  s.id.startsWith('inat:'),
).length;
const CELLS = WILDLIFE_SIGHTINGS.filter((s) => s.cell);
const byId = new Map(WILDLIFE_SIGHTINGS.map((s) => [s.id, s]));
// Each leg: its engine, how the switch to it is made, and the sighting it
// clicks (an iNaturalist badge, the Acartia report, the obscured record).
const LEGS = [
  { kind: 'cesium', click: 'inat:910001' },
  { kind: 'navara', via: 'keyboard', click: 'acartia:qa-orca-1' },
  { kind: 'cesium', via: 'keyboard', click: 'inat:910003' },
  { kind: 'navara', via: 'pointer', click: 'inat:910002' },
];

const base = localPreview(process.argv[2]);
base.search = '?engine=cesium&welcome=0';
base.hash =
  `v=2&lat=${WILDLIFE_VIEW.lat.toFixed(4)}&lon=${WILDLIFE_VIEW.lon.toFixed(4)}` +
  `&alt=${WILDLIFE_VIEW.alt}&heading=0&pitch=-90&roll=0&map=sentinel2&l=`;
const fixture = wildlifeRoutes(base.origin);
const strict = createStrict({
  origin: base.origin,
  layers: [LAYER],
  // Wildlife freshness is checked against fixtures timestamped in Node.
  time: 'real',
  routes: fixture.routes,
});
await strict.run({}, async (b) => {
  const { page: p, errors } = await openPage(b);
  await p.goto(base.href);
  await waitForEngine(p, 'cesium');
  await p.evaluate(async (id) => {
    const { dataManager } = window.__godsEyeView;

    await dataManager.setEnabled(id, true, { origin: 'user' });
    window.qaWild = dataManager.layers.get(id).module;
    // Every selection the layer reports, in order.
    window.qaWildSelected = [];
    window.qaWild.subscribeSelection((row) =>
      window.qaWildSelected.push(row?.stableId ?? null),
    );
  }, LAYER);

  // The framing view, straight down over the fixture.
  const frame = () =>
    p.evaluate(
      (destination) => {
        const { camera, render } = window.__godsEyeView.engine;
        camera.setView({
          destination,
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        render.request('qa-wildlife-frame');
      },
      fromDegrees(WILDLIFE_VIEW.lon, WILDLIFE_VIEW.lat, WILDLIFE_VIEW.alt),
    );
  const still = () => waitForCameraAtRest(p, { timeout: 30000 });
  // What the engine draws for the layer, and what its picker answers at each
  // sighting's anchor.
  const drawing = () =>
    p.evaluate(
      (ids, prefix) => {
        const { engine } = window.__godsEyeView;
        const canvas = engine.host.canvas;
        const box = canvas.getBoundingClientRect();
        const sets = Object.fromEntries(
          engine.movers
            .list()
            .filter((set) => set.id.startsWith('wildlife-sightings'))
            .map((set) => [set.id, { kind: set.kind, count: set.count }]),
        );
        const cells = engine.ground
          .list()
          .filter((set) => set.id === prefix)
          .map(({ kind, count, shown }) => ({ kind, count, shown }));
        const badges = ids.map((id) => {
          const position = window.qaWild.getSightingPosition(id);
          const screen =
            position && engine.projector.worldToWindow(position, {});
          const picked = screen && engine.picker.pick(screen);
          return {
            id,
            position: position && {
              x: position.x,
              y: position.y,
              z: position.z,
            },
            screen: screen && { x: screen.x, y: screen.y },
            onCanvas:
              !!screen &&
              canvas.contains(
                document.elementFromPoint(
                  box.left + screen.x,
                  box.top + screen.y,
                ),
              ),
            picked: picked
              ? {
                  id: typeof picked.id === 'string' ? picked.id : picked.id?.id,
                  owner: picked.owner ?? null,
                }
              : null,
          };
        });
        return { sets, cells, badges };
      },
      [...byId.keys()],
      CELL_SET,
    );
  // Every badge in engine.movers and picked as itself, the glow drawn and
  // the privacy cell outlined (the engines draw a few frames after the data).
  const settled = async () => {
    const deadline = Date.now() + 45000;
    let drawn;
    for (;;) {
      await p.evaluate(() =>
        window.__godsEyeView.engine.render.request('qa-wildlife'),
      );
      drawn = await drawing();
      const ok =
        drawn.sets[BADGES]?.count === byId.size &&
        drawn.sets[GLOW]?.count === GLOW_CELLS &&
        drawn.cells.length === 1 &&
        drawn.cells[0].count === CELLS.length &&
        drawn.badges.every(
          (badge) => badge.picked?.id === `wildlife:${badge.id}`,
        );
      if (ok || Date.now() > deadline) return drawn;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const degrees = (position) => {
    const c = fromCartesian(position);
    return {
      lat: (c.latitude * 180) / Math.PI,
      lon: (c.longitude * 180) / Math.PI,
      height: c.height,
    };
  };
  const card = () =>
    p.evaluate(() => {
      const hosts = document.querySelectorAll(
        '[data-wildlife-sighting-card-host]',
      );
      const host = hosts[hosts.length - 1];
      const section = host?.querySelector('[data-wildlife-sighting-card]');
      const box = section?.getBoundingClientRect();
      return {
        hosts: hosts.length,
        shown:
          host?.style.display === 'block' && box?.width > 0 && box?.height > 0,
        name: section?.getAttribute('aria-label') ?? null,
        text: section?.textContent.replace(/\s+/g, ' ').trim() ?? '',
      };
    });
  const selection = () =>
    p.evaluate(() => ({
      context: window.__gevContextStore?.selectedEntityId ?? null,
      layer: window.qaWildSelected.at(-1) ?? null,
    }));
  const cardFor = (name) =>
    p.waitForFunction(
      (name) => {
        const host = [
          ...document.querySelectorAll('[data-wildlife-sighting-card-host]'),
        ].at(-1);
        const section = host?.querySelector('[data-wildlife-sighting-card]');
        return (
          host?.style.display === 'block' &&
          section?.getBoundingClientRect().width > 0 &&
          section.textContent.includes(name)
        );
      },
      { timeout: 15000 },
      name,
    );

  const session = () =>
    p.evaluate(
      (id) => ({
        same:
          window.qaWild ===
          window.__godsEyeView.dataManager.layers.get(id).module,
        enabled: window.__godsEyeView.dataManager.isEnabled(id),
        selected: window.__gevContextStore?.selectedEntityId ?? null,
        reported: window.qaWildSelected.at(-1) ?? null,
      }),
      LAYER,
    );
  // The Globe Engine picker from the keyboard alone: Tab until it has the
  // focus, then type-ahead (no pointer, so nothing clicks outside the card).
  strict.extra.keyboardPicks = [];
  const keyboardSwitch = async (kind) => {
    const origin = await p.evaluate(() => performance.timeOrigin);
    const picker = () =>
      p.evaluate(() => {
        const el = document.querySelector('#globe-engine');
        const box = el?.getBoundingClientRect();
        return {
          panel: document
            .querySelector('#control-panel-toggle')
            ?.getAttribute('aria-expanded'),
          disabled: el?.disabled ?? null,
          box: box ? [box.x, box.y, box.width, box.height] : null,
        };
      });
    // The picker sits in VISUAL PRESETS, out of the Tab order while that
    // panel is collapsed: open it from the keyboard too.
    if ((await picker()).panel !== 'true') {
      await p.focus('#control-panel-toggle');
      await p.keyboard.press('Enter');
    }
    await p
      .waitForFunction(
        () => {
          const el = document.querySelector('#globe-engine');
          return (
            el &&
            !el.disabled &&
            el.checkVisibility({ visibilityProperty: true })
          );
        },
        { timeout: 30000 },
      )
      .catch(async (error) => {
        throw Error(
          `the picker is not ready: ${JSON.stringify(await picker())}`,
          { cause: error },
        );
      });
    // Each focus stop, as tag#id and label (the path is in the failure).
    const path = [];
    for (;;) {
      const at = await p.evaluate(() => {
        const el = document.activeElement;
        return {
          id: el?.id ?? null,
          stop: el
            ? `${el.tagName.toLowerCase()}#${el.id} ${(
                el.getAttribute('aria-label') ||
                el.textContent ||
                ''
              )
                .trim()
                .slice(0, 30)}`
            : 'none',
          picker: (({ disabled, tabIndex } = {}) => ({ disabled, tabIndex }))(
            document.querySelector('#globe-engine') ?? undefined,
          ),
        };
      });
      if (at.id === 'globe-engine') break;
      path.push(at.stop);
      assert.ok(
        path.length <= 200,
        `Tab never reaches the Globe Engine picker ${JSON.stringify({ picker: at.picker, path: path.slice(0, 80) })}`,
      );
      await p.keyboard.press('Tab');
    }
    const tabs = path.length;
    const from = await p.$eval('#globe-engine', (el) => el.value);
    await p.keyboard.type(kind[0]);
    await waitForEngine(p, kind).catch(async (error) => {
      const state = await p.evaluate(() => ({
        engine: window.__godsEyeView?.engine?.kind ?? null,
        picker: document.querySelector('#globe-engine')?.value ?? null,
        focus: document.activeElement?.id ?? null,
        busy: Boolean(
          document.querySelector(
            '#globe-engine:is([disabled], [aria-busy="true"])',
          ),
        ),
        frame: Boolean(document.querySelector('.engine-switch-frame')),
        loading: document.querySelector('#loading-screen')?.className ?? null,
      }));
      throw Error(
        `no ${kind} globe after typing ${kind[0]}: ${JSON.stringify({ from, tabs: path.length, ...state })}`,
        { cause: error },
      );
    });
    assert.equal(
      await p.evaluate(() => performance.timeOrigin),
      origin,
      'same document after switching globes',
    );
    strict.extra.keyboardPicks.push({ from, to: kind, tabs });
  };
  const expandPanel = async () => {
    const expanded = () =>
      p.$eval(
        '#control-panel-toggle',
        (el) => el.getAttribute('aria-expanded') === 'true',
      );
    if (await expanded()) return;
    await p.click('#control-panel-toggle');
    await p.waitForFunction(
      () =>
        document
          .querySelector('#control-panel-toggle')
          ?.getAttribute('aria-expanded') === 'true',
    );
  };

  let selected = null;
  for (const { kind, via, click: id } of LEGS) {
    if (via) {
      const poseBefore = await p.evaluate(() =>
        window.__godsEyeView.engine.camera.pose(),
      );
      const reads = { ...fixture.asked };
      const sighting = byId.get(selected);
      if (via === 'keyboard') {
        await keyboardSwitch(kind);
        // The session carries over: the same layer model, still on, the
        // clicked sighting still selected, and the new globe's card shows it.
        await cardFor(sighting.name);
        const kept = await session();
        const shown = await card();
        await strict.check(
          p,
          LAYER,
          `a switch keeps the layer model on, ${sighting.name} selected and its card open`,
          kept.same &&
            kept.enabled &&
            kept.selected === selected &&
            kept.reported === selected &&
            shown.hosts === 1 &&
            shown.shown &&
            shown.name === sighting.name,
          { ...kept, card: shown, readsBefore: reads, reads: fixture.asked },
        );
        console.log('PASS', kind, 'selection kept', selected);
      } else {
        await strict.switchTo(p, kind);
        // The pointer on the picker clicked outside the card: it closed and
        // the selection cleared; the layer model stayed on.
        const kept = await session();
        const shown = await card();
        await strict.check(
          p,
          LAYER,
          `a pointer on the picker closes the ${sighting.name} card; the layer model stays on`,
          kept.same &&
            kept.enabled &&
            kept.selected === null &&
            kept.reported === null &&
            shown.hosts === 1 &&
            !shown.shown,
          { ...kept, card: shown, readsBefore: reads, reads: fixture.asked },
        );
        console.log('PASS', kind, 'picker click closed the card');
        selected = null;
      }
      const poseAfter = await p.evaluate(() =>
        window.__godsEyeView.engine.camera.pose(),
      );
      const positionErrorM = Math.hypot(
        ...['x', 'y', 'z'].map(
          (axis) => poseAfter.position[axis] - poseBefore.position[axis],
        ),
      );
      const angleError = (key) =>
        Math.abs(
          Math.atan2(
            Math.sin(poseAfter[key] - poseBefore[key]),
            Math.cos(poseAfter[key] - poseBefore[key]),
          ),
        );
      await strict.check(
        p,
        LAYER,
        'switch preserves the camera position and orientation',
        positionErrorM < 1 &&
          ['heading', 'pitch', 'roll'].every((key) => angleError(key) < 1e-4),
        { poseBefore, poseAfter, positionErrorM },
      );
      await frame();
    }

    // Drawn through the contract: badges, glow, privacy cell.
    await still();
    const drawn = await settled();
    const badges = drawn.badges.map((badge) => ({
      ...badge,
      at: badge.position && degrees(badge.position),
    }));
    for (const badge of badges) {
      const expected = byId.get(badge.id);
      assert.ok(badge.at, `${kind}: ${badge.id} has no anchor`);
      assert.ok(
        Math.abs(badge.at.lat - expected.lat) < 1e-6 &&
          Math.abs(badge.at.lon - expected.lon) < 1e-6 &&
          badge.at.height > -500 &&
          badge.at.height < 3000,
        `${kind}: ${badge.id} anchored at ${JSON.stringify(badge.at)}`,
      );
    }
    await strict.check(
      p,
      LAYER,
      `${byId.size} badges live in engine.movers at their sightings, each picked as itself`,
      drawn.sets[BADGES]?.kind === 'sprite' &&
        drawn.sets[BADGES].count === byId.size &&
        badges.every(
          (badge) =>
            badge.picked?.id === `wildlife:${badge.id}` &&
            badge.picked.owner === BADGES,
        ),
      {
        set: drawn.sets[BADGES],
        badges: badges.map(({ id, at, screen, picked }) => ({
          id,
          at,
          screen,
          picked,
        })),
      },
    );
    await strict.check(
      p,
      LAYER,
      `the density glow is its own sprite set with ${GLOW_CELLS} cells`,
      drawn.sets[GLOW]?.kind === 'sprite' &&
        drawn.sets[GLOW].count === GLOW_CELLS,
      drawn.sets[GLOW],
    );
    await strict.check(
      p,
      LAYER,
      'the obscured record’s privacy cell is a shown fill and outline on engine.ground',
      drawn.cells.length === 1 &&
        drawn.cells[0].count === CELLS.length &&
        drawn.cells.every((set) => set.shown && set.kind === 'cell'),
      drawn.cells,
    );
    console.log(
      'PASS',
      kind,
      'drawn',
      JSON.stringify(drawn.sets),
      JSON.stringify(drawn.cells),
    );

    // Escape closes the carried-over card and clears the selection.
    if (selected) {
      await p.keyboard.press('Escape');
      await p.waitForFunction(
        () =>
          !window.__gevContextStore?.selectedEntityId &&
          window.qaWildSelected.at(-1) === null &&
          [
            ...document.querySelectorAll('[data-wildlife-sighting-card-host]'),
          ].every((host) => host.style.display === 'none'),
        { timeout: 10000 },
      );
      await strict.passed(
        p,
        LAYER,
        'Escape closes the card and clears the selection',
      );
    }

    // The keyboard switches reach the picker in the expanded control panel
    // (opened with no card up, so the click closes nothing).
    await expandPanel();

    // A pointer click on a badge selects its sighting and opens its card.
    const sighting = byId.get(id);
    const target = (await drawing()).badges.find((badge) => badge.id === id);
    assert.ok(
      target.onCanvas && target.picked?.id === `wildlife:${id}`,
      `${kind}: the ${id} badge is covered or not picked`,
    );
    const box = await p.evaluate(() => {
      const r = window.__godsEyeView.engine.host.canvas.getBoundingClientRect();
      return { left: r.left, top: r.top };
    });
    await p.mouse.click(box.left + target.screen.x, box.top + target.screen.y);
    await p.waitForFunction(
      (id) =>
        window.__gevContextStore?.selectedEntityId === id &&
        window.qaWildSelected.at(-1) === id,
      { timeout: 15000 },
      id,
    );
    await cardFor(sighting.name);
    const opened = { selection: await selection(), card: await card() };
    await strict.check(
      p,
      LAYER,
      `a click on the ${sighting.name} badge selects it and opens its card`,
      opened.selection.context === id &&
        opened.selection.layer === id &&
        opened.card.hosts === 1 &&
        opened.card.shown &&
        opened.card.name === sighting.name,
      { at: target.screen, ...opened },
    );
    console.log('PASS', kind, 'click', id, JSON.stringify(opened.card.text));
    selected = id;
    // The click flies to the sighting; switch once it has landed.
    await still();
  }
  console.log(
    'requests',
    JSON.stringify(fixture.asked),
    'upstream',
    JSON.stringify(fixture.upstream),
  );
  assert.ok(fixture.asked.observations && fixture.asked.grid);
  assert.ok(fixture.asked.acartia);
  assert.deepEqual(errors, []);
});
