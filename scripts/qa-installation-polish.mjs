/** Shared browser assertions for installation label persistence and selection. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { moveCamera, createScreencast } from './qa-journey-recorder.mjs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function checkInstallationPan(page, dir) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('local-datacenters', true),
  );
  await sleep(3000);
  await page.evaluate(async () => {
    const { getOverlayPaintRect } =
      await import('/src/overlays/worldOverlay.js');
    const g = window.__godsEyeView;
    const installations = g.dataManager.layers.get(
      'military-installations',
    ).module;
    const centerIds = [];
    for (let i = 0; i < g.viewer.dataSources.length; i++)
      for (const e of g.viewer.dataSources.get(i).entities.values)
        if (e.__localLayerId === 'local-datacenters') centerIds.push(e.id);
    window.__polishPanFrames = [];
    window.__stopPolishPan = g.viewer.scene.postRender.addEventListener(() => {
      const sites = [],
        centers = [];
      installations.visitNamedMarkers((id) => {
        if (getOverlayPaintRect('military-installations', id)) sites.push(id);
      });
      for (const id of centerIds)
        if (getOverlayPaintRect('local-datacenters', id)) centers.push(id);
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
      await sleep(1500);
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
        const screen = C.SceneTransforms.worldToWindowCoordinates(
          g.viewer.scene,
          point,
        );
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
        const { getOverlayPaintRect, getWorldOverlayDiagnostics } =
          await import('/src/overlays/worldOverlay.js');
        const knownFills = new Set();
        const fillEntities = () => {
          const list = [];
          for (let i = 0; i < g.viewer.dataSources.length; i++)
            for (const e of g.viewer.dataSources.get(i).entities.values)
              if (e.id.startsWith(`${record.id}:selected-fill:`)) list.push(e);
          for (const e of list) knownFills.add(e);
          return list;
        };
        // Geometry-instance ids prove the ground primitive actually built, not just an entity declaration.
        const primitives = () => {
          let count = 0;
          const walk = (collection) => {
            if (collection?._collectionsArray) {
              for (const child of collection._collectionsArray) walk(child);
              return;
            }
            for (let i = 0; i < (collection?.length || 0); i++) {
              const p = collection.get(i);
              if (
                p.ready &&
                typeof p.getGeometryInstanceAttributes === 'function'
              ) {
                for (const e of knownFills) {
                  try {
                    const a = p.getGeometryInstanceAttributes(e);
                    if (a && (!a.show || a.show[0])) count++;
                  } catch {}
                }
              }
              if (typeof p.get === 'function' || p._collectionsArray) walk(p);
            }
          };
          walk(g.viewer.scene.groundPrimitives);
          return count;
        };
        window.__polishFillProbe = () => ({
          entities: fillEntities().length,
          primitives: primitives(),
          classification: fillEntities().map((e) =>
            e.polygon.classificationType.getValue(),
          ),
          selected: getSelectedEntityContext()?.id || null,
        });
        window.__stopPolishSelection =
          g.viewer.scene.postRender.addEventListener(() => {
            window.__polishSelectionFrames.push({
              paints: window.__polishTitlePaints.splice(0).length,
              own: Boolean(
                getOverlayPaintRect('military-installations', record.id),
              ),
              tracked: Boolean(
                getOverlayPaintRect('tracked', `installations:${record.id}`),
              ),
              selected: getSelectedEntityContext()?.id === record.id,
              total:
                getWorldOverlayDiagnostics().paintedBySource[
                  'military-installations'
                ] || 0,
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
            return p.selected === window.__polishSelectedId && p.primitives > 0;
          },
          { timeout: 20000 },
        )
        .catch(async (error) => {
          await page.screenshot({ path: `${dir}/selection-failure.png` });
          const diagnostic = await page.evaluate(() => {
            const g = window.__godsEyeView;
            const describe = (p) => ({
              type: p.constructor.name,
              ready: p.ready,
              length: p.length,
              keys: Object.keys(p).filter((k) =>
                /primitive|instance|collection/i.test(k),
              ),
              ids: p._instanceIds?.map((id) => id.id || String(id)),
              children:
                typeof p.get === 'function'
                  ? Array.from({ length: p.length }, (_, i) =>
                      describe(p.get(i)),
                    )
                  : p._collectionsArray?.map(describe),
            });
            return {
              probe: window.__polishFillProbe(),
              stats: g.dataManager.layers
                .get('military-installations')
                .module.getStats(),
              primitives: describe(g.viewer.scene.groundPrimitives),
              frames: window.__polishSelectionFrames.slice(-5),
            };
          });
          await fs.writeFile(
            `${dir}/selection-failure.json`,
            JSON.stringify({ picked, ...diagnostic }, null, 2),
          );
          throw error;
        });
      await sleep(500);
      const selected = await page.evaluate(() => window.__polishFillProbe());
      await page.screenshot({ path: `${dir}/after-selection-${site.key}.png` });
      // Close, oblique angles expose surface clipping and floating fills.
      for (const heading of [30, 120]) {
        await page.evaluate(
          async (site, heading) => {
            const C =
              await import('/node_modules/cesium/Build/Cesium/index.js');
            const g = window.__godsEyeView;
            const target = C.Cartesian3.fromDegrees(
              site.lon,
              site.lat,
              site.key === 'mabry' ? 180 : 10,
            );
            g.viewer.camera.lookAt(
              target,
              new C.HeadingPitchRange(
                C.Math.toRadians(heading),
                C.Math.toRadians(-30),
                800,
              ),
            );
            g.viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
          },
          site,
          heading,
        );
        await sleep(1700);
        assert.ok(
          (await page.evaluate(() => window.__polishFillProbe())).selected,
          'orbit must preserve installation selection',
        );
        await page.screenshot({
          path: `${dir}/after-${site.key}-orbit-${heading}.png`,
        });
      }
      await moveCamera(page, { ...site, pitch: -80 }, 1);
      await sleep(900);
      const empty = await page.evaluate(() => {
        const g = window.__godsEyeView;
        for (let y = 250; y < 650; y += 75)
          for (let x = 400; x < 850; x += 75) {
            const pick = g.viewer.scene.pick({ x, y });
            if (!pick?.id?.installationId && !pick?.id?.gevTrackedId)
              return { x, y };
          }
        throw new Error('No empty map point');
      });
      await page.mouse.click(empty.x, empty.y);
      await page.waitForFunction(
        () =>
          window.__polishFillProbe().selected === null &&
          window.__polishFillProbe().entities === 0,
      );
      await sleep(600);
      const deselected = await page.evaluate(() => {
        window.__stopPolishSelection();
        window.__restorePolishPaint();
        return {
          ...window.__polishFillProbe(),
          frames: window.__polishSelectionFrames,
        };
      });
      assert.equal(selected.entities, picked.parts);
      assert.equal(selected.primitives, picked.parts);
      assert.ok(
        selected.classification.every((c) => c === 1),
        'Google 3D tile classification',
      );
      assert.equal(deselected.entities, 0);
      assert.equal(deselected.primitives, 0);
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
      entities: deselected.entities,
      primitives: deselected.primitives,
    },
    frames: deselected.frames.length,
  }));
}
