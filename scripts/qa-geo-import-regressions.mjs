#!/usr/bin/env node
/** Import regressions through the real UI controller and Cesium loaders.
 * Run against dev and preview: QA_BASE_URL=http://localhost:4173 node scripts/qa-geo-import-regressions.mjs
 */
import puppeteer from 'puppeteer';
import * as Cesium from 'cesium';
import { hookRenderErrors, readRenderErrors } from './qa-browserEvidence.mjs';

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
const meshBytes = Buffer.alloc(60);
[
  -2000, 2000, -2000, 2000, 2000, -2000, -2000, 2000, 2000, 2000, 2000, 2000,
].forEach((value, i) => meshBytes.writeFloatLE(value, i * 4));
[0, 1, 2, 2, 1, 3].forEach((value, i) =>
  meshBytes.writeUInt16LE(value, 48 + i * 2),
);
const fixture = {
  '/__qa_import_surface/tileset.json': {
    asset: { version: '1.1' },
    geometricError: 0,
    root: {
      transform: Cesium.Matrix4.toArray(
        Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(-122.5, 37.7),
        ),
      ),
      boundingVolume: { box: [0, 0, 2000, 2000, 0, 0, 0, 2000, 0, 0, 0, 100] },
      geometricError: 0,
      content: { uri: 'surface.gltf' },
    },
  },
  '/__qa_import_surface/surface.gltf': {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }],
      },
    ],
    materials: [{ doubleSided: true }],
    buffers: [
      {
        byteLength: 60,
        uri: `data:application/octet-stream;base64,${meshBytes.toString('base64')}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 12, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 4,
        type: 'VEC3',
        min: [-2000, 2000, -2000],
        max: [2000, 2000, 2000],
      },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  },
};
await page.setRequestInterception(true);
page.on('request', (request) => {
  const body = fixture[new URL(request.url()).pathname];
  if (body)
    void request.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  else void request.continue();
});
const errors = [],
  requests = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (/Ignoring clampToGround/.test(m.text())) errors.push(m.text());
});
await hookRenderErrors(page);
let failed = 0;
try {
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () =>
      window.__gevGeoImport &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  await page.evaluate(async () => {
    const { viewer, dataManager } = window.__godsEyeView,
      C = window.__CESIUM__;
    for (const id of dataManager.layers.keys())
      await dataManager.setEnabled(id, false);
    viewer.imageryLayers.removeAll();
    viewer.terrainProvider = new C.EllipsoidTerrainProvider();
    viewer.clock.shouldAnimate = false;
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-122.5, 37.7, 100000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  page.on('request', (r) => {
    if (!/^(data:|blob:)/.test(r.url())) requests.push(r.url());
  });
  const results = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView,
      C = window.__CESIUM__,
      tool = window.__gevGeoImport;
    const results = [],
      now = C.JulianDate.clone(viewer.clock.currentTime);
    const check = (name, pass, detail = '') =>
      results.push({ name, pass: Boolean(pass), detail });
    const wrap = (body, attrs = '') =>
      `<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2" ${attrs}><Document>${body}</Document></kml>`;
    const point = '<Point><coordinates>-122.5,37.7,0</coordinates></Point>';
    const load = async (value, name) => {
      const content =
        typeof value === 'object' && !ArrayBuffer.isView(value)
          ? JSON.stringify(value)
          : value;
      const [outcome] = await tool.importFiles([new File([content], name)]);
      return {
        outcome,
        source: outcome.ok
          ? viewer.dataSources.get(viewer.dataSources.length - 1)
          : null,
      };
    };
    const remove = (r) => {
      if (r.outcome.ok) tool.remove(r.outcome.id);
    };
    let r = await load(
      {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'kartaview-owned',
            properties: {
              name: 'XYZ',
              addProperty: 1,
              'marker-symbol': 'rail',
            },
            geometry: { type: 'Point', coordinates: [-122.5, 37.7, 100] },
          },
          {
            type: 'Feature',
            geometry: {
              type: 'Polygon',
              coordinates: [
                [
                  [-122.5, 37.7, 10],
                  [-122.4, 37.7, 10],
                  [-122.4, 37.8, 10],
                  [-122.5, 37.7, 10],
                ],
              ],
            },
          },
        ],
      },
      'xyz.geojson',
    );
    const pin = (r.source?.importedEntities || r.source?.entities.values).find(
        (e) => e.billboard,
      ),
      polygon = (r.source?.importedEntities || r.source?.entities.values).find(
        (e) => e.polygon,
      );
    check(
      'XYZ ground footprint and isolated entity IDs',
      r.outcome.ok &&
        pin.id !== 'kartaview-owned' &&
        Math.abs(
          C.Cartographic.fromCartesian(pin.position.getValue(now)).height,
        ) < 0.01 &&
        polygon.polygon.perPositionHeight?.getValue(now) !== true,
    );
    check(
      'ground pins have no persistent clamping callbacks',
      pin?.billboard.heightReference?.getValue(now) ===
        C.HeightReference.NONE &&
        pin.billboard.disableDepthTestDistance.getValue(now) === Infinity,
    );
    remove(r);
    r = await load(
      wrap(
        '<Placemark><name>ground</name><gx:Track><gx:coord>-122.5 37.7 0</gx:coord><gx:coord>-122.4 37.8 0</gx:coord></gx:Track></Placemark>' +
          '<Placemark><name>absolute</name><gx:Track><altitudeMode>absolute</altitudeMode><gx:coord>-122.5 37.7 10000</gx:coord><gx:coord>-122.4 37.8 10000</gx:coord></gx:Track></Placemark>' +
          '<Placemark><name>line</name><LineString><coordinates>-122.5,37.7 -122.4,37.8</coordinates></LineString></Placemark>',
      ),
      'tracks.kml',
    );
    const find = (name) =>
      (r.source?.importedEntities || r.source?.entities.values).find(
        (e) => e.name === name,
      );
    check(
      'ground tracks and untessellated authored lines clamp',
      find('ground')?.polyline.clampToGround?.getValue(now) &&
        find('line')?.polyline.clampToGround?.getValue(now),
    );
    check(
      'explicit track altitude and original vertices survive',
      find('absolute')?.polyline.positions.getValue(now).length === 2 &&
        find('absolute')
          .polyline.positions.getValue(now)
          .every(
            (p) =>
              Math.abs(C.Cartographic.fromCartesian(p).height - 10000) < 0.01,
          ),
    );
    remove(r);
    r = await load(
      wrap(
        `<Style id="s"><IconStyle><scale>0.5</scale></IconStyle></Style><Placemark><styleUrl>  #s  </styleUrl>${point}</Placemark>`,
      ),
      'local-style.kml',
    );
    check('whitespace around a local style remains local', r.outcome.ok);
    remove(r);
    r = await load(
      wrap(
        `<Placemark><StyleMap><Pair><key>normal</key><styleUrl>https://gev-qa-trap.invalid/style</styleUrl></Pair></StyleMap>${point}</Placemark>`,
      ),
      'incomplete-style.kml',
    );
    check('removing external style does not hang the queue', r.outcome.ok);
    remove(r);
    r = await load(
      wrap(
        `<Folder><visibility>0</visibility><Placemark>${point}</Placemark></Folder>`,
      ),
      'hidden-folder.kml',
    );
    check(
      'import show controls own previously hidden KML content',
      r.outcome.ok &&
        (r.source.importedEntities || r.source.entities.values).every(
          (e) => e.isShowing,
        ),
    );
    remove(r);
    r = await load(
      wrap(
        '<GroundOverlay><color>ff00ff00</color><LatLonBox><north>37.8</north><south>37.7</south><east>-122.4</east><west>-122.5</west></LatLonBox></GroundOverlay>',
      ),
      'colored.kml',
    );
    check(
      'a colored overlay without an icon is drawable',
      r.outcome.ok &&
        (r.source.importedEntities || r.source.entities.values).some(
          (e) => e.rectangle,
        ),
    );
    remove(r);
    const xml = wrap(`<Placemark>${point}</Placemark>`);
    const utf16 = new Uint8Array(2 + xml.length * 2);
    utf16.set([255, 254]);
    for (let i = 0; i < xml.length; i++) {
      utf16[2 + i * 2] = xml.charCodeAt(i) & 255;
      utf16[3 + i * 2] = xml.charCodeAt(i) >> 8;
    }
    r = await load(utf16, 'utf16.kml');
    check('UTF-16 BOM is decoded', r.outcome.ok);
    remove(r);
    r = await load(
      wrap(
        `<Placemark>${point}</Placemark>`,
        'xmlns:gx="http://www.google.com/kml/ext/2.2" xsi:schemaLocation="test"',
      ),
      'namespaces.kml',
    );
    check(
      'ordinary duplicate and missing export namespaces are repaired',
      r.outcome.ok,
    );
    remove(r);
    for (const [name, value] of [
      ['null geometry', { type: 'Feature', geometry: null }],
      ['invalid coordinates', { type: 'Point', coordinates: ['bad', 37] }],
      [
        'missing feature type',
        {
          type: 'FeatureCollection',
          features: [{ geometry: { type: 'Point', coordinates: [0, 0] } }],
        },
      ],
      [
        'nested unsupported geometry',
        { type: 'Feature', geometry: { type: 'Topology', arcs: [] } },
      ],
    ]) {
      r = await load(value, 'refused.geojson');
      check(`${name} is refused without stopping rendering`, !r.outcome.ok);
      remove(r);
    }
    r = await load(
      wrap(
        '<Placemark><Point><coordinates>NaN,37,0</coordinates></Point></Placemark>',
      ),
      'invalid.kml',
    );
    check('non-finite KML coordinates are refused', !r.outcome.ok);
    remove(r);
    r = await load(
      {
        type: 'LineString',
        coordinates: [
          [-122.6, 37.7],
          [-122.4, 37.7],
        ],
      },
      'portrait.geojson',
    );
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const positions = (r.source?.importedEntities ||
      r.source?.entities.values)[0].polyline.positions.getValue(now);
    const screen = positions?.map((p) =>
      C.SceneTransforms.worldToWindowCoordinates(viewer.scene, p),
    );
    check(
      'portrait flight includes both route endpoints',
      screen?.every(
        (p) => p && p.x > 0 && p.x < innerWidth && p.y > 0 && p.y < innerHeight,
      ),
      screen?.map((p) => p && [p.x, p.y]),
    );
    remove(r);
    r = await load(
      {
        type: 'MultiPoint',
        coordinates: [
          [-74, 40.7],
          [139.7, 35.7],
        ],
      },
      'intercontinental.geojson',
    );
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const intercontinental = (
      r.source?.importedEntities || r.source?.entities.values
    )
      .filter((e) => e.position)
      .map((e) => e.position.getValue(now));
    const occluder = new C.EllipsoidalOccluder(
      C.Ellipsoid.WGS84,
      viewer.camera.positionWC,
    );
    check(
      'intercontinental points remain in frame and in front of the horizon',
      intercontinental?.every((p) => {
        const s = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, p);
        return (
          occluder.isPointVisible(p) &&
          s &&
          s.x > 0 &&
          s.x < innerWidth &&
          s.y > 0 &&
          s.y < innerHeight
        );
      }),
    );
    remove(r);
    r = await load(
      wrap(
        '<Placemark><LineString><altitudeMode>absolute</altitudeMode><extrude>1</extrude><coordinates>4.9,52.37,3000 5.12,52.09,3000</coordinates></LineString></Placemark><Placemark><Point><coordinates>5.12,52.09</coordinates></Point></Placemark>',
      ),
      'wall.kml',
    );
    await new Promise((resolve) => setTimeout(resolve, 2300));
    check(
      'a wall contributes both endpoints to the flight',
      r.outcome.ok &&
        (r.source.importedEntities || r.source.entities.values)
          .find((e) => e.wall)
          ?.wall.positions.getValue(now)
          .every((p) => {
            const s = C.SceneTransforms.worldToWindowCoordinates(
              viewer.scene,
              p,
            );
            return (
              s && s.x > 0 && s.x < innerWidth && s.y > 0 && s.y < innerHeight
            );
          }),
    );
    remove(r);
    r = await load(
      {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [180, 0],
        ],
      },
      'antipodal.geojson',
    );
    await new Promise((resolve) => setTimeout(resolve, 1800));
    check(
      'symmetric global extents keep a finite camera',
      r.outcome.ok &&
        Number.isFinite(viewer.camera.positionCartographic.height),
    );
    remove(r);
    viewer.camera.cancelFlight();
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(-122.5, 37.7, 100000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const mesh = await C.Cesium3DTileset.fromUrl(
      `${location.origin}/__qa_import_surface/tileset.json`,
    );
    viewer.scene.primitives.add(mesh);
    // This fixture installs a mesh outside the app's map-source lifecycle.
    // Let the new camera/tiles reach a rendered frame before testing sampling.
    await new Promise((resolve) => {
      let frames = 0;
      const remove = viewer.scene.postRender.addEventListener(() => {
        if (++frames >= 2) {
          remove();
          resolve();
        } else viewer.scene.requestRender();
      });
      viewer.scene.requestRender();
    });
    const fixtureDeadline = performance.now() + 5000;
    while (!mesh.tilesLoaded && performance.now() < fixtureDeadline) {
      viewer.scene.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const globeShown = viewer.scene.globe.show;
    viewer.scene.globe.show = false;

    r = await load(
      { type: 'Point', coordinates: [-122.5, 37.7, 0] },
      'mesh-point.geojson',
    );
    const meshPoint = (r.source?.importedEntities || r.source?.entities.values)
      .find((e) => e.billboard)
      ?.position.getValue(now);
    const meshHeight =
      meshPoint && C.Cartographic.fromCartesian(meshPoint).height;
    check(
      'native 3D Tiles ground sampling keeps pins on the rendered mesh',
      r.outcome.ok && Math.abs(meshHeight - 2000) < 2,
      {
        meshHeight,
        tilesLoaded: mesh.tilesLoaded,
        globeShown: viewer.scene.globe.show,
      },
    );
    tool.flyTo(r.outcome.id);
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const meshScreen =
      meshPoint &&
      C.SceneTransforms.worldToWindowCoordinates(viewer.scene, meshPoint);
    check(
      'a high-surface arrival frames the elevated pin',
      meshScreen &&
        Math.abs(meshScreen.x - innerWidth / 2) < 20 &&
        Math.abs(meshScreen.y - innerHeight / 2) < 20,
      {
        screen: meshScreen && [meshScreen.x, meshScreen.y],
        camera: {
          height: viewer.camera.positionCartographic.height,
          pitch: viewer.camera.pitch,
        },
        meshHeight,
      },
    );
    const groundSource = r.source;
    const elevated = await load(
      wrap(
        '<Placemark><Point><altitudeMode>absolute</altitudeMode><coordinates>-122.5,37.7,5000</coordinates></Point></Placemark>',
      ),
      'elevated-pin.kml',
    );
    await new Promise((resolve) => setTimeout(resolve, 2600));
    check(
      'a higher imported pin never becomes the sampled ground',
      elevated.outcome.ok &&
        Math.abs(
          C.Cartographic.fromCartesian(
            groundSource.importedBillboards.get(0).position,
          ).height - 2000,
        ) < 2,
    );
    remove(elevated);
    remove(r);
    viewer.scene.primitives.remove(mesh);
    viewer.scene.globe.show = globeShown;
    const before = tool.list().length;
    const transfer = new DataTransfer();
    transfer.items.add(
      new File(
        [JSON.stringify({ type: 'Point', coordinates: [-122.5, 37.7] })],
        'panel-drop.geojson',
      ),
    );
    const event = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    });
    document.getElementById('geo-import-button').dispatchEvent(event);
    for (let i = 0; i < 100 && tool.list().length === before; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    check(
      'a panel drop imports and prevents the browser default',
      event.defaultPrevented && tool.list().length === before + 1,
    );
    for (const file of tool.list()) tool.remove(file.id);
    check(
      'the shared clock stays exactly unchanged',
      C.JulianDate.equals(now, viewer.clock.currentTime),
    );
    check('no file sources remain', tool.list().length === 0);
    return results;
  });
  for (const r of results) {
    console.log(
      `[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`,
      JSON.stringify(r.detail),
    );
    if (!r.pass) failed++;
  }
  const renderErrors = await readRenderErrors(page);
  if (errors.length || renderErrors.length) {
    failed++;
    console.log(
      '[FAIL] browser/render errors',
      JSON.stringify({ errors, renderErrors }),
    );
  }
  // Terrain belongs to the base map; imported files may sample that provider.
  const unexpected = requests.filter(
    (url) =>
      new URL(url).pathname !== '/logo.svg' &&
      !new URL(url).pathname.startsWith('/__qa_import_surface/') &&
      !/\/api\/|\.terrain(?:\?|$)|reearth|cesium|arcgis|openstreetmap|\.pbf(?:\?|$)/i.test(
        url,
      ),
  );
  console.log(
    `[${unexpected.length ? 'FAIL' : 'PASS'}] no unexpected file-directed requests`,
    JSON.stringify(unexpected),
  );
  if (unexpected.length) failed++;
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
