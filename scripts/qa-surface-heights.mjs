// Run this checkout's probe against either build; no page-side source imports.
// node scripts/qa-surface-heights.mjs http://localhost:4308 --out=heights.json
// Add --compare=before.json for the 0.1 m gate, or --tiles for the 50 m block.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as geo from '../src/geo/index.js';
import {
  createStrict,
  localPreview,
  openPage,
  waitForEngine,
  TILES_FIXTURE_PATH,
} from './qa-strict-harness.mjs';
import { whenSettled } from './qa/ready.mjs';
import {
  center,
  points,
  layers,
  offsets,
  counts,
  features,
  fixtureRoutes,
  observeSurfaceMovers,
  settledPositions,
} from './qa/surfaceHeights.mjs';

export function compareHeights(before, after, { tiles = false } = {}) {
  assert.equal(before.version, 1, 'before snapshot version');
  assert.equal(after.version, 1, 'after snapshot version');
  assert.equal(
    before.surface,
    tiles ? 'tiles' : 'terrain',
    'before surface (tiles require --tiles)',
  );
  assert.equal(after.surface, before.surface, 'matching surfaces');
  assert.equal(before.fixture, after.fixture, 'matching fixtures');
  const reports = [];
  for (const engine of new Set([
    'cesium',
    'navara',
    ...Object.keys(before.engines),
    ...Object.keys(after.engines),
  ])) {
    const left = before.engines[engine] ?? {},
      right = after.engines[engine] ?? {};
    for (const layer of new Set([
      ...layers,
      ...Object.keys(left),
      ...Object.keys(right),
    ])) {
      const a = left[layer] ?? {},
        b = right[layer] ?? {};
      const missing = Object.keys(a).filter((id) => !Object.hasOwn(b, id));
      const extra = Object.keys(b).filter((id) => !Object.hasOwn(a, id));
      const invalid = [];
      let maxAbsM = 0,
        point = null;
      for (const id of Object.keys(a)) {
        if (!Object.hasOwn(b, id)) continue;
        if (![a[id]?.heightM, b[id]?.heightM].every(Number.isFinite)) {
          invalid.push(id);
          continue;
        }
        const delta = Math.abs(a[id].heightM - b[id].heightM);
        if (delta > maxAbsM) {
          maxAbsM = delta;
          point = id;
        }
      }
      reports.push({
        engine,
        layer,
        maxAbsM,
        point,
        missing,
        extra,
        invalid,
        ok:
          Object.keys(a).length > 0 &&
          Object.keys(b).length > 0 &&
          !missing.length &&
          !extra.length &&
          !invalid.length &&
          maxAbsM <= 0.1 + 1e-9,
      });
    }
  }
  return { ok: reports.every((r) => r.ok), reports };
}

function serialize(rows, layer) {
  const result = {};
  for (const row of rows) {
    const position = geo.cartographic.fromCartesian(row.position);
    const lon = geo.math.toDegrees(position.longitude),
      lat = geo.math.toDegrees(position.latitude);
    let id = row.id;
    if (layer === 'import') {
      // Imported sprites have no pick ids; match the fixture's unique coordinates.
      const point = points.find(
        (p) => Math.abs(p.lon - lon) < 1e-7 && Math.abs(p.lat - lat) < 1e-7,
      );
      assert.ok(point, `Unknown import pin at ${lon},${lat}`);
      id = point.id;
    }
    if (layer === 'directions')
      id = `${row.index === 0 ? 'a' : 'b'}/${row.setId === 'directions-markers' ? 'disc' : 'letter'}`;
    assert.ok(!Object.hasOwn(result, id), `Duplicate ${layer} point ${id}`);
    assert.ok(
      Number.isFinite(position.height),
      `Nonfinite ${layer} point ${id}`,
    );
    assert.ok(
      Math.abs(lon - center.lon) < 0.0004 &&
        Math.abs(lat - center.lat) < 0.0004,
      `${layer}/${id} outside the block fixture`,
    );
    result[id] = { heightM: position.height, lon, lat };
  }
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function loadDisplay(page, layer) {
  await page.evaluate(
    async ({ layer, points, features }) => {
      const { dataManager } = window.__godsEyeView;
      const enable = async (id) => {
        if (!(await dataManager.setEnabled(id, true)))
          throw new Error(`Cannot enable ${id}`);
        return dataManager.layers.get(id).module;
      };
      if (layer === 'import') {
        const outcomes = await window.__gevGeoImport.importFiles([
          new File(
            [JSON.stringify({ type: 'FeatureCollection', features })],
            'surface-heights.geojson',
            { type: 'application/geo+json' },
          ),
        ]);
        if (outcomes.some((o) => o.error))
          throw new Error(JSON.stringify(outcomes));
      } else if (layer === 'infrastructure') {
        await enable('local-datacenters');
        await enable('local-dams');
      } else if (layer === 'directions') {
        const mod = await enable(layer);
        mod.placeEndpoint('a', points[0]);
        mod.placeEndpoint('b', points[2]);
      } else if (layer === 'story') {
        const mod = dataManager.layers.get('bhote-koshi-2026').module;
        mod.setParams({
          presentation: 'scene-beat',
          sceneSurface: 'evidence-beat',
          progress: 0.5,
          autoPlay: false,
        });
        await enable('bhote-koshi-2026');
        mod.setParams({ progress: 0.5, autoPlay: false });
      } else await enable(layer === 'alpr' ? 'alpr-cameras' : layer);
    },
    { layer, points, features },
  );
}

async function unloadDisplay(page, layer) {
  await page.evaluate(async (layer) => {
    if (layer === 'import') {
      for (const file of window.__gevGeoImport.list())
        window.__gevGeoImport.remove(file.id);
    } else {
      const ids =
        layer === 'infrastructure'
          ? ['local-datacenters', 'local-dams']
          : [
              layer === 'story'
                ? 'bhote-koshi-2026'
                : layer === 'alpr'
                  ? 'alpr-cameras'
                  : layer,
            ];
      for (const id of ids)
        await window.__godsEyeView.dataManager.setEnabled(id, false);
    }
  }, layer);
}

async function main(argv) {
  const option = (name) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const base = localPreview(
    argv.find((a) => !a.startsWith('--')) ??
      process.env.QA_BASE_URL ??
      'http://localhost:4308',
  );
  const tiles = argv.includes('--tiles');
  const before = option('compare')
    ? JSON.parse(readFileSync(option('compare'), 'utf8'))
    : null;
  const snapshot = {
    version: 1,
    fixture: 'surface-heights-v1',
    surface: tiles ? 'tiles' : 'terrain',
    engines: {},
  };
  if (before) compareHeights(before, snapshot, { tiles });
  const routes = fixtureRoutes(base.origin, tiles);
  const strict = createStrict({ origin: base.origin, layers, routes });
  base.search = '?engine=navara&welcome=0';
  if (tiles) base.searchParams.set('qaTileset', TILES_FIXTURE_PATH);
  base.hash = `v=2&lat=${center.lat}&lon=${center.lon}&alt=1100&heading=0&pitch=-90&roll=0&map=${tiles ? 'photoreal' : 'osm'}&l=`;
  await strict.run({}, async (browser) => {
    for (const kind of ['navara', 'cesium']) {
      const { page, errors } = await openPage(browser);
      await page.goto(base.href, { waitUntil: 'domcontentloaded' });
      await waitForEngine(page, 'navara');
      if (kind === 'cesium') await strict.pick(page, kind);
      await page.evaluate(
        async ({ destination, tiles }) => {
          const { engine, styleManager } = window.__godsEyeView;
          styleManager.orbitController.stop();
          engine.camera.cancelFlight();
          await engine.maps.setTerrain({
            kind: tiles ? 'ellipsoid' : 'keyless',
          });
          engine.camera.setView({
            destination,
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          engine.render.request('qa-surface-heights');
        },
        {
          destination: geo.cartesian3.fromDegrees(center.lon, center.lat, 1100),
          tiles,
        },
      );
      await whenSettled(page);
      await page.waitForFunction(
        ({ points, tiles }) => {
          const { engine } = window.__godsEyeView;
          engine.render.request('qa-surface-heights');
          return (
            engine.surface.tilesLoaded() &&
            engine.maps.photorealActive() === tiles &&
            points.every((p) => {
              const place = {
                longitude: (p.lon * Math.PI) / 180,
                latitude: (p.lat * Math.PI) / 180,
                height: 0,
              };
              const height = tiles
                ? engine.surface.sampleHeight(place)
                : engine.surface.terrainHeight(place);
              return (
                Number.isFinite(height) &&
                (tiles ? Math.abs(height - 50) < 0.1 : height > 1)
              );
            })
          );
        },
        { timeout: 90000 },
        { points, tiles },
      );
      await page.evaluate(observeSurfaceMovers);
      snapshot.engines[kind] = {};
      for (const layer of layers) {
        await loadDisplay(page, layer);
        await page.evaluate(
          (destination) => {
            const { engine } = window.__godsEyeView;
            engine.camera.cancelFlight();
            engine.camera.setView({
              destination,
              orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
            });
            engine.render.request('qa-surface-heights');
          },
          geo.cartesian3.fromDegrees(center.lon, center.lat, 1100),
        );
        await whenSettled(page);
        const rows = await settledPositions(page, layer, counts[layer]);
        const values = serialize(rows, layer);
        snapshot.engines[kind][layer] = values;
        if (tiles)
          for (const [id, p] of Object.entries(values))
            assert.ok(
              Math.abs(p.heightM - (50 + offsets[layer])) <= 0.1,
              `${kind}/${layer}/${id}: ${p.heightM} m, expected ${50 + offsets[layer]} m`,
            );
        await strict.passed(
          page,
          layer,
          `${counts[layer]} committed surface points`,
          values,
        );
        console.log(
          `PASS ${kind}/${layer}: ${rows.length} points${tiles ? ` at ${50 + offsets[layer]} m (±0.1 m)` : ''}`,
        );
        await unloadDisplay(page, layer);
      }
      await page.evaluate(() => window.qaSurfaceMovers.restore());
      assert.deepEqual(errors, []);
      await page.close();
    }
    if (option('out')) {
      writeFileSync(option('out'), JSON.stringify(snapshot, null, 2) + '\n');
      console.log(`WROTE ${option('out')}`);
    }
    if (before) {
      const comparison = compareHeights(before, snapshot, { tiles });
      for (const r of comparison.reports)
        console.log(
          `${r.ok ? 'PASS' : 'FAIL'} ${r.engine}/${r.layer}: max |Δ|=${r.maxAbsM.toFixed(6)} m; missing=${r.missing.join(',') || 'none'}; extra=${r.extra.join(',') || 'none'}; invalid=${r.invalid.join(',') || 'none'}`,
        );
      assert.ok(
        comparison.ok,
        'Surface heights differ by more than 0.1 m or the point sets changed',
      );
    }
    console.log(
      `PASS surface heights: 12 engine/layer measurements (${snapshot.surface})`,
    );
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
