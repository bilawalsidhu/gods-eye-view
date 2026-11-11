// Cesium-only probes: native ground-primitive inspection verifies the Cesium outline paint.
import { whenUiSettled } from './qa/ready.mjs';
/** Shared browser assertions for installation label persistence and selection. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { moveCamera, createScreencast } from './qa-journey-recorder.mjs';

export async function checkInstallationPan(page, dir) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('local-datacenters', true),
  );
  await whenUiSettled(page);
  await page.evaluate(async () => {
    const { getPaintRect } = (
      await import('/src/overlays/worldOverlay.js')
    ).worldOverlayFor(window.__godsEyeView.engine);
    const g = window.__godsEyeView;
    const installations = g.dataManager.layers.get(
      'military-installations',
    ).module;
    // The datacenters' overlay entry ids: the layer draws through the globe
    // contract and registers each reference row (its overlay entry's id) in
    // the context store; it owns no Cesium entities.
    const centerIds = [];
    for (const record of window.__gevContextStore?.entities.values() ?? [])
      if (record.layerId === 'local-datacenters' && record.entity?.id != null)
        centerIds.push(record.entity.id);
    window.__polishPanFrames = [];
    window.__stopPolishPan = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
      const sites = [],
        centers = [];
      installations.visitNamedMarkers((id) => {
        if (getPaintRect('military-installations', id)) sites.push(id);
      });
      for (const id of centerIds)
        if (getPaintRect('local-datacenters', id)) centers.push(id);
      window.__polishPanFrames.push({ t: performance.now(), sites, centers });
    });
  });
  await moveCamera(page, { lon: -99, lat: 39, height: 6500000, pitch: -90 }, 8);
  const frames = await page.evaluate(() => {
    window.__stopPolishPan();
    return window.__polishPanFrames;
  });
  const count = (key) => {
    let appeared = 0,
      disappeared = 0,
      reappeared = 0;
    const seen = new Set(frames[0][key]);
    for (let i = 1; i < frames.length; i++) {
      const previous = new Set(frames[i - 1][key]),
        next = new Set(frames[i][key]);
      frames[i][`${key}Appeared`] = [...next].filter((id) => !previous.has(id));
      frames[i][`${key}Disappeared`] = [...previous].filter(
        (id) => !next.has(id),
      );
      for (const id of frames[i][`${key}Appeared`]) {
        appeared++;
        if (seen.has(id)) reappeared++;
        seen.add(id);
      }
      disappeared += frames[i][`${key}Disappeared`].length;
    }
    const mean =
      frames.reduce((sum, f) => sum + f[key].length, 0) / frames.length;
    return {
      appeared,
      disappeared,
      reappeared,
      mean,
      eventsPerLabel: (appeared + disappeared) / mean,
    };
  };
  const result = {
    frames: frames.length,
    installations: count('sites'),
    datacenters: count('centers'),
  };
  await fs.writeFile(
    `${dir}/slow-pan-frames.json`,
    JSON.stringify(frames, null, 2),
  );
  await fs.writeFile(`${dir}/slow-pan.json`, JSON.stringify(result, null, 2));
  assert.ok(frames.length > 100);
  assert.ok(
    result.installations.mean >= 5 && result.datacenters.mean >= 5,
    'both real layers contribute visible labels on the same pan',
  );
  assert.ok(
    frames.every((f) => f.sites.length <= 24),
    'shared-domain budget cannot exceed the installation title cap',
  );
  assert.ok(
    result.installations.eventsPerLabel <=
      result.datacenters.eventsPerLabel + 0.1,
    'installation label transitions per label match Data Centers on the same slow pan',
  );
  assert.ok(
    result.installations.reappeared <= result.datacenters.reappeared,
    'installation labels do not flicker off and back on more than Data Centers',
  );
  await page.screenshot({ path: `${dir}/slow-pan-side-by-side.png` });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('local-datacenters', false),
  );
  return result;
}

export async function checkInstallationSelection(
  page,
  dir,
  { video = true } = {},
) {
  await page.evaluate(() => {
    const ground = window.__godsEyeView.engine.ground;
    const create = ground.createSet.bind(ground);
    window.__polishGroundSets = new Map();
    ground.createSet = (options) => {
      const set = create(options);
      window.__polishGroundSets.set(options.id, { set, drape: options.drape ?? 'both' });
      return set;
    };
    window.__restorePolishGround = () => { ground.createSet = create; };
  });
  const result = [];
  const recorder = video
    ? await createScreencast(page, `${dir}/selection-orbit`, { fps: 24 })
    : null;
  await recorder?.start();
  try {
    for (const site of [
      {
        key: 'mabry',
        name: 'Camp Mabry',
        lon: -97.765,
        lat: 30.3125,
        height: 3500,
      },
      {
        key: 'naval',
        name: 'Naval Base San Diego',
        lon: -117.119,
        lat: 32.684,
        height: 6500,
      },
    ]) {
      await moveCamera(page, { ...site, pitch: -80 }, 1.5);
      await page.waitForFunction(
        () => {
          const s = window.__godsEyeView.dataManager.layers
            .get('military-installations')
            .module.getStats();
          return !s.loading && s.count > 0;
        },
        { timeout: 60000 },
      );
      await whenUiSettled(page);
      const picked = await page.evaluate(async (site) => {
        const C = await import('/node_modules/cesium/Build/Cesium/index.js');
        const g = window.__godsEyeView,
          layer = g.dataManager.layers.get('military-installations').module;
        const record = layer
          .getNearby(C.Cartesian3.fromDegrees(site.lon, site.lat), 100000, 1000)
          .find((r) => r.name === site.name && r.footprints?.length);
        if (!record) throw new Error(`No polygon for ${site.name}`);
        let point;
        layer.visitNamedMarkers((id, p) => {
          if (id === record.id) point = p.position;
        });
        const screen = window.__godsEyeView.engine.projector.worldToWindow(point);
        window.__polishSelectedId = record.id;
        window.__polishTitlePaints = [];
        const canvas = document.getElementById('world-overlay-canvas'),
          ctx = canvas.getContext('2d');
        const original = ctx.fillText;
        const matches = (text) =>
          String(text).toLowerCase() === site.name.toLowerCase();
        ctx.fillText = function (text, ...args) {
          if (matches(text))
            window.__polishTitlePaints.push({ t: performance.now(), text });
          return original.call(this, text, ...args);
        };
        window.__restorePolishPaint = () => {
          ctx.fillText = original;
        };
        window.__polishSelectionFrames = [];
        const { getSelectedEntityContext } =
          await import('/src/data/contextStore.js');
        const { getPaintRect, getDiagnostics } = (
          await import('/src/overlays/worldOverlay.js')
        ).worldOverlayFor(window.__godsEyeView.engine);
        // The selected site's fill is one engine.ground polygon set
        // (render/display.js SELECTION_FILL_SET_ID), an item per footprint
        // part; the layer owns no Cesium entities or ground primitives.
        const fillSet = () =>
          g.engine.ground
            .list()
            .find((set) => set.id === 'military-installations-selection-fill');
        window.__polishFillProbe = () => {
          const set = fillSet();
          const items = set?.shown ? set.count : 0;
          const captured = window.__polishGroundSets.get(set?.id);
          // A retained fill may predate this probe. Its engine-owned batches
          // prove readiness and classification on this Cesium-only check.
          const batches = [];
          const visit = collection => {
            for (let i = 0; i < collection.length; i++) {
              const primitive = collection.get(i);
              if (primitive.gevGroundSet === set?.id) batches.push(primitive);
              else if (typeof primitive.get === 'function') visit(primitive);
            }
          };
          if (!captured && set) visit(g.viewer.scene.groundPrimitives);
          const ready = captured ? captured.set.ready() : batches.length > 0 && batches.every(p => p.ready);
          const drape = captured?.drape ?? ['terrain', 'tiles', 'both'][batches[0]?.classificationType];
          return {
            items,
            readyItems: ready ? items : 0,
            drape,
            expectedDrape: g.engine.maps.photorealActive() ? 'tiles' : 'both',
            selected: getSelectedEntityContext()?.id || null,
          };
        };
        window.__stopPolishSelection =
          window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
            window.__polishSelectionFrames.push({
              paints: window.__polishTitlePaints.splice(0).length,
              own: Boolean(getPaintRect('military-installations', record.id)),
              tracked: Boolean(
                getPaintRect('tracked', `installations:${record.id}`),
              ),
              selected: getSelectedEntityContext()?.id === record.id,
              total:
                getDiagnostics().paintedBySource['military-installations'] || 0,
            });
          });
        return {
          id: record.id,
          x: screen.x,
          y: screen.y,
          parts: record.footprints.length,
        };
      }, site);
      await page.screenshot({
        path: `${dir}/after-${site.key}-unselected.png`,
      });
      await page.mouse.click(picked.x, picked.y);
      await page
        .waitForFunction(
          () => {
            const p = window.__polishFillProbe();
            return p.selected === window.__polishSelectedId && p.readyItems > 0;
          },
          { timeout: 20000 },
        )
        .catch(async (error) => {
          await page.screenshot({ path: `${dir}/selection-failure.png` });
          const diagnostic = await page.evaluate(() => {
            const g = window.__godsEyeView;
            return {
              probe: window.__polishFillProbe(),
              stats: g.dataManager.layers
                .get('military-installations')
                .module.getStats(),
              ground: g.engine.ground.list(),
              frames: window.__polishSelectionFrames.slice(-5),
            };
          });
          await fs.writeFile(
            `${dir}/selection-failure.json`,
            JSON.stringify({ picked, ...diagnostic }, null, 2),
          );
          throw error;
        });
      await whenUiSettled(page);
      const selected = await page.evaluate(() => window.__polishFillProbe());
      await page.screenshot({ path: `${dir}/after-selection-${site.key}.png` });
      // Close, oblique angles expose surface clipping and floating fills.
      for (const heading of [30, 120]) {
        await page.evaluate(
          async (site, heading) => {
            const C =
              await import('/node_modules/cesium/Build/Cesium/index.js');
            const target = C.Cartesian3.fromDegrees(
              site.lon,
              site.lat,
              site.key === 'mabry' ? 180 : 10,
            );
            window.__godsEyeView.engine.camera.lookAt(
              target,
              new C.HeadingPitchRange(
                C.Math.toRadians(heading),
                C.Math.toRadians(-30),
                800,
              ),
            );
            window.__godsEyeView.engine.camera.lookAtTransform(C.Matrix4.IDENTITY);
          },
          site,
          heading,
        );
        await whenUiSettled(page);
        assert.ok(
          (await page.evaluate(() => window.__polishFillProbe())).selected,
          'orbit must preserve installation selection',
        );
        await page.screenshot({
          path: `${dir}/after-${site.key}-orbit-${heading}.png`,
        });
      }
      await moveCamera(page, { ...site, pitch: -80 }, 1);
      await whenUiSettled(page);
      const empty = await page.evaluate(() => {
        const g = window.__godsEyeView;
        for (let y = 250; y < 650; y += 75)
          for (let x = 400; x < 850; x += 75) {
            // Nothing drawn there: no mover, line or ground item's pickId.
            const pick = g.engine.picker.pick({ x, y });
            if (pick?.id == null) return { x, y };
          }
        throw new Error('No empty map point');
      });
      await page.mouse.click(empty.x, empty.y);
      await page.waitForFunction(
        () =>
          window.__polishFillProbe().selected === null &&
          window.__polishFillProbe().items === 0,
      );
      await whenUiSettled(page);
      const deselected = await page.evaluate(() => {
        window.__stopPolishSelection();
        window.__restorePolishPaint();
        return {
          ...window.__polishFillProbe(),
          frames: window.__polishSelectionFrames,
        };
      });
      assert.equal(selected.items, picked.parts);
      assert.equal(selected.readyItems, picked.parts);
      assert.equal(selected.drape, selected.expectedDrape, 'selection fill follows the map surface');
      assert.equal(deselected.items, 0);
      assert.equal(deselected.readyItems, 0);
      const selectedFrames = deselected.frames.filter(
        (f) => f.selected && f.own,
      );
      assert.ok(selectedFrames.length > 10);
      assert.ok(
        selectedFrames.every((f) => !f.tracked && f.paints === 1),
        'selected record has exactly one painted overlay element',
      );
      assert.ok(
        deselected.frames
          .slice(-5)
          .every((f) => !f.selected && f.own && !f.tracked && f.paints === 1),
        'deselect restores the one ambient entry',
      );
      await page.screenshot({
        path: `${dir}/after-${site.key}-deselected.png`,
      });
      result.push({ site, picked, selected, deselected });
    }
  } finally {
    await page.evaluate(() => window.__restorePolishGround?.());
    await fs.writeFile(
      `${dir}/selection-checks.json`,
      JSON.stringify(result, null, 2),
    );
    if (recorder)
      await fs.writeFile(
        `${dir}/selection-video.json`,
        JSON.stringify(await recorder.stop(), null, 2),
      );
  }
  return result.map(({ site, picked, selected, deselected }) => ({
    site: site.name,
    id: picked.id,
    selected,
    deselected: {
      entities: deselected.items,
      primitives: deselected.readyItems,
    },
    frames: deselected.frames.length,
  }));
}
