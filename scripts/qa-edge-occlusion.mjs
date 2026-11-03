// Edge case for Navara's transparent meshes (the CCTV case,
// scripts/qa-edge-cctv-occlusion.mjs, for everything else drawn in the
// transparent pass): wind flow, infrastructure stems and Scene Director data
// packs must not paint through a wall. For each, one box 3D tileset stands
// between the camera and the feature; the feature is shown and hidden with
// and without the wall:
//   - without the wall (control) the feature changes the wall's screen area,
//     so the check can fail;
//   - with the wall it must not (the infrastructure points stay on top by
//     design on both engines, so for stems only the long vertical runs of a
//     stem count).
// `--record <dir>` keeps each control screenshot; `--baseline <dir>` compares
// this build's control screenshots with that record over the feature's own
// pixels, so a fix that hides the meshes behind walls is shown not to change
// how they look in the open.
//
// Billing safety: the browser resolves no host but 127.0.0.1, so nothing
// leaves the machine. The wall is served as a local fixture at the photoreal
// tiles URL (the only 3D tileset path both engines have) with a fake key, the
// wind forecast and the data pack assets are local fixtures too. Requests
// for other hosts die at the resolver; the run fails if a response or a
// finished request came from any host but 127.0.0.1 and the fixtures.
//
// Usage: node scripts/qa-edge-occlusion.mjs http://127.0.0.1:<PORT>/
//   [--engines navara,cesium] [--only wind,stems,packs]
//   [--record <dir>] [--baseline <dir>]
// Wind runs on Navara only. Before the scene-depth test
// (src/layers/shared/render/navaraSceneDepth.js) Navara painted stems and
// packs through the wall; wind flow was already hidden and stays as a guard.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import * as geo from '../src/geo/index.js';

const url = new URL(process.argv[2] ?? '');
if (
  url.hostname !== '127.0.0.1' ||
  [
    '',
    '4173',
    '4174',
    '4185',
    '4186',
    '4187',
    '4188',
    '4189',
    '4194',
    '4196',
  ].includes(url.port)
)
  throw Error('Supply a local keyless preview URL on 127.0.0.1');
const option = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const ENGINES = option('engines', 'navara,cesium').split(',');
const ONLY = option('only', 'wind,stems,packs').split(',');
const RECORD = option('record');
const BASELINE = option('baseline');

const TILES_HOST = 'tile.googleapis.com';
const DEVIATION = 60; // summed RGB difference that counts as changed
const MIN_CONTROL_SHARE = 0.003;
const MAX_HIDDEN_SHARE = 0.0005;
const STEM_RUN_PX = 24; // a stem is ~65 px tall; a point is ~14 px
const STEM_WIDTH_PX = 6; // a stem is 3.5 px wide
const MAX_LOOK_CHANGE = 0.01;
const VIEW = { width: 1024, height: 768 };

/** One scenario: a site, a wall in its ENU frame, a camera, a feature. */
const SCENARIOS = {
  // Streamlines at 12 km seen from 2,000 km straight down (as in
  // qa-wind-engine-switch.mjs), under a roof over the western half at 100 km.
  wind: {
    site: { lat: 43.65, lon: -79.38 },
    wall: {
      east: [-1_500_000, 0],
      north: [-1_500_000, 1_500_000],
      up: [100_000, 110_000],
    },
    face: 'top',
    camera: { enu: [0, 0, 2_000_000], heading: 0, pitchDeg: -90 },
    runs: false,
    // Cesium never requests this 3,000 km roof's content (wind on Cesium is
    // a depth-tested primitive, src/layers/wind/gpuRendering.js).
    engines: ['navara'],
  },
  // Ashburn's data centres, 4-12 km north, behind a wall 300 m ahead.
  stems: {
    site: { lat: 38.94, lon: -77.45 },
    wall: { east: [-3000, 3000], north: [300, 340], up: [-200, 1500] },
    face: 'south',
    camera: { enu: [0, 0, 300], heading: 0, pitchDeg: -3 },
    runs: true,
  },
  // A polygon and an image at 300 m, 0.6-1.5 km north, behind a wall 200 m
  // ahead.
  packs: {
    site: { lat: 30.25, lon: -97.75 },
    wall: { east: [-3000, 3000], north: [200, 240], up: [-200, 2500] },
    face: 'south',
    camera: { enu: [0, 0, 600], heading: 0, pitchDeg: -30 },
    runs: false,
  },
};

const frameOf = ({ lat, lon }) =>
  Array.from(
    geo.transforms.eastNorthUpToFixedFrame(
      geo.cartesian3.fromDegrees(lon, lat, 0),
    ),
  );
const toEcef = (frame, [e, n, u]) => ({
  x: frame[0] * e + frame[4] * n + frame[8] * u + frame[12],
  y: frame[1] * e + frame[5] * n + frame[9] * u + frame[13],
  z: frame[2] * e + frame[6] * n + frame[10] * u + frame[14],
});
/** The wall face the camera looks at, in ECEF: its south side or its top. */
function faceCorners({ site, wall, face }) {
  const frame = frameOf(site);
  const [e0, e1] = wall.east;
  const [n0, n1] = wall.north;
  const [u0, u1] = wall.up;
  const corners =
    face === 'top'
      ? [
          [e0, n0, u1],
          [e1, n0, u1],
          [e1, n1, u1],
          [e0, n1, u1],
        ]
      : [
          [e0, n0, u0],
          [e1, n0, u0],
          [e1, n0, u1],
          [e0, n0, u1],
        ];
  return corners.map((corner) => toEcef(frame, corner));
}
const offset = ({ lat, lon }, eastM, northM) => ({
  lat: lat + northM / 111_320,
  lon: lon + eastM / (111_320 * Math.cos((lat * Math.PI) / 180)),
});

/** A glTF binary with one box, written in glTF's y-up axes (x, z, -y). */
function boxGlb({ east: [e0, e1], north: [n0, n1], up: [u0, u1] }) {
  const faces = [
    [
      [1, 0, 0],
      [
        [e1, n0, u0],
        [e1, n1, u0],
        [e1, n1, u1],
        [e1, n0, u1],
      ],
    ],
    [
      [-1, 0, 0],
      [
        [e0, n1, u0],
        [e0, n0, u0],
        [e0, n0, u1],
        [e0, n1, u1],
      ],
    ],
    [
      [0, 1, 0],
      [
        [e1, n1, u0],
        [e0, n1, u0],
        [e0, n1, u1],
        [e1, n1, u1],
      ],
    ],
    [
      [0, -1, 0],
      [
        [e0, n0, u0],
        [e1, n0, u0],
        [e1, n0, u1],
        [e0, n0, u1],
      ],
    ],
    [
      [0, 0, 1],
      [
        [e0, n0, u1],
        [e1, n0, u1],
        [e1, n1, u1],
        [e0, n1, u1],
      ],
    ],
    [
      [0, 0, -1],
      [
        [e0, n1, u0],
        [e1, n1, u0],
        [e1, n0, u0],
        [e0, n0, u0],
      ],
    ],
  ];
  const yUp = ([x, y, z]) => [x, z, -y];
  const positions = [];
  const normals = [];
  const indices = [];
  for (const [normal, corners] of faces) {
    const base = positions.length / 3;
    for (const corner of corners) {
      positions.push(...yUp(corner));
      normals.push(...yUp(normal));
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const pos = Buffer.from(new Float32Array(positions).buffer);
  const nor = Buffer.from(new Float32Array(normals).buffer);
  const idx = Buffer.from(new Uint16Array(indices).buffer);
  const bin = Buffer.concat([
    pos,
    nor,
    idx,
    Buffer.alloc((4 - (idx.length % 4)) % 4),
  ]);
  const axis = (a, pick) => pick(...positions.filter((_, i) => i % 3 === a));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.5, 0.5, 0.55, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        doubleSided: true,
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length, target: 34962 },
      {
        buffer: 0,
        byteOffset: pos.length,
        byteLength: nor.length,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: pos.length + nor.length,
        byteLength: idx.length,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [0, 1, 2].map((a) => axis(a, Math.min)),
        max: [0, 1, 2].map((a) => axis(a, Math.max)),
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: normals.length / 3,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        componentType: 5123,
        count: indices.length,
        type: 'SCALAR',
      },
    ],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([
    header,
    chunk(0x4e4f534a, text),
    chunk(0x004e4942, bin),
  ]);
}

function tilesetOf(scenario) {
  const { wall } = scenario;
  const half = (r) => (r[1] - r[0]) / 2;
  const mid = (r) => (r[0] + r[1]) / 2;
  return {
    asset: { version: '1.1' },
    geometricError: 1000,
    root: {
      transform: frameOf(scenario.site),
      boundingVolume: {
        box: [
          mid(wall.east),
          mid(wall.north),
          mid(wall.up),
          half(wall.east),
          0,
          0,
          0,
          half(wall.north),
          0,
          0,
          0,
          half(wall.up),
        ],
      },
      geometricError: 0,
      refine: 'REPLACE',
      content: { uri: 'qa-wall.glb' },
    },
  };
}

// The wind forecast: a uniform field, as in qa-wind-engine-switch.mjs.
function windReply(target) {
  const model = target.searchParams.get('model');
  const count = 36 * 19;
  if (target.pathname.endsWith('/manifest'))
    return {
      type: 'application/json',
      data: Buffer.from(
        JSON.stringify({
          model,
          overlay: 'none',
          grid: { nx: 36, ny: 19, lo1: 0, la1: 90, dx: 10, dy: 10 },
          gridUrl: `/api/wind/grid/${model}-qa.bin${target.search}`,
          cycle: {
            validIso: '2026-11-02T12:00:00Z',
            runIso: '2026-11-02T06:00:00Z',
          },
        }),
      ),
    };
  const values = new Float32Array(count * 2);
  values.fill(8, 0, count);
  values.fill(6, count, count * 2);
  return {
    type: 'application/octet-stream',
    data: Buffer.from(values.buffer),
  };
}

// A self-authored data pack: a polygon and an image 0.6-1.5 km north at 300 m.
function packOutline(site) {
  const corner = (e, n) => {
    const p = offset(site, e, n);
    return [p.lon, p.lat, 300];
  };
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'polygon',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              corner(-700, 600),
              corner(-100, 600),
              corner(-100, 1500),
              corner(-700, 1500),
              corner(-700, 600),
            ],
          ],
        },
      },
    ],
  };
}
const packImage = await sharp({
  create: {
    width: 64,
    height: 64,
    channels: 4,
    background: { r: 255, g: 80, b: 30, alpha: 1 },
  },
})
  .png()
  .toBuffer();

/** Serve the wall, the forecast and the pack locally; refuse the rest. */
async function installFixtures(page, log) {
  const session = await page.createCDPSession();
  await session.send('Fetch.enable', {
    patterns: [
      { urlPattern: `https://${TILES_HOST}/*` },
      ...['/api/wind/*', '/scene-assets/*'].map((route) => ({
        urlPattern: `http://127.0.0.1:*${route}`,
      })),
    ],
  });
  session.on('Fetch.requestPaused', ({ requestId, request }) => {
    const target = new URL(request.url);
    const scenario = SCENARIOS[log.scenario];
    let body = null;
    if (target.hostname === TILES_HOST) {
      if (target.pathname.endsWith('/root.json'))
        body = {
          type: 'application/json',
          data: Buffer.from(JSON.stringify(tilesetOf(scenario))),
        };
      else if (target.pathname.endsWith('/qa-wall.glb'))
        body = { type: 'model/gltf-binary', data: boxGlb(scenario.wall) };
    } else if (target.pathname.startsWith('/api/wind/'))
      body = windReply(target);
    else if (target.pathname.endsWith('/outline.json'))
      body = {
        type: 'application/geo+json',
        data: Buffer.from(JSON.stringify(packOutline(scenario.site))),
      };
    else if (target.pathname.endsWith('/image.png'))
      body = { type: 'image/png', data: packImage };
    log.served.push({ url: request.url, fulfilled: Boolean(body) });
    const send = body
      ? session.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: body.type },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: body.data.toString('base64'),
        })
      : session.send('Fetch.failRequest', {
          requestId,
          errorReason: 'BlockedByClient',
        });
    send.catch(() => {});
  });
}

async function raw(png) {
  const { data, info } = await sharp(png)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Pixels that differ between two shots (optionally only long vertical runs). */
function changed(a, b, { runs = false } = {}) {
  const { width, height } = a;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const d =
      Math.abs(a.data[i * 3] - b.data[i * 3]) +
      Math.abs(a.data[i * 3 + 1] - b.data[i * 3 + 1]) +
      Math.abs(a.data[i * 3 + 2] - b.data[i * 3 + 2]);
    mask[i] = d > DEVIATION ? 1 : 0;
  }
  if (!runs) return mask;
  // Keep a changed pixel only when it belongs to a thin vertical structure:
  // its row run is at most STEM_WIDTH_PX wide (a point is ~14 px) and a
  // vertical run of such pixels through a 3-pixel-wide column reaches
  // STEM_RUN_PX. A stem passes, a point or a stack of points does not.
  const thin = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const on = x < width && mask[y * width + x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) {
        if (x - start <= STEM_WIDTH_PX)
          for (let k = start; k < x; k++) thin[y * width + k] = 1;
        start = -1;
      }
    }
  }
  const column = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      column[i] =
        thin[i] || (x > 0 && thin[i - 1]) || (x < width - 1 && thin[i + 1])
          ? 1
          : 0;
    }
  const kept = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const on = y < height && column[y * width + x];
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        if (y - start >= STEM_RUN_PX)
          for (let k = start; k < y; k++)
            kept[k * width + x] = thin[k * width + x];
        start = -1;
      }
    }
  }
  return kept;
}

const share = (mask, region) => {
  let total = 0;
  let on = 0;
  for (let y = region.y0; y < region.y1; y++)
    for (let x = region.x0; x < region.x1; x++) {
      total++;
      on += mask[y * VIEW.width + x];
    }
  return on / total;
};

async function checkEngine(browser, kind) {
  const page = await browser.newPage();
  await page.setViewport({ ...VIEW, deviceScaleFactor: 1 });
  const errors = [];
  const log = { scenario: null, served: [] };
  const remote = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Requests for other hosts die at the resolver (the base map, terrain);
  // any response or finished request from one would be traffic that left.
  const local = (address) => {
    const target = new URL(address);
    return (
      !['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) ||
      target.hostname === '127.0.0.1' ||
      log.served.some((entry) => entry.url === address)
    );
  };
  let refusedRemote = 0;
  page.on('requestfailed', (request) => {
    if (!local(request.url())) refusedRemote++;
  });
  page.on('requestfinished', (request) => {
    if (!local(request.url())) remote.push(`finished ${request.url()}`);
  });
  page.on('response', (response) => {
    if (!local(response.url())) remote.push(`response ${response.url()}`);
  });
  await installFixtures(page, log);
  const start = new URL(url);
  start.search = `?engine=${kind}&welcome=0`;
  start.hash = 'v=2&lat=30&lon=-90&alt=20000000&pitch=-90&heading=0&l=';
  await page.goto(start.href);
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView?.engine?.kind === expected &&
      document.querySelector('#loading-screen.hidden'),
    { timeout: 120000 },
    kind,
  );
  await page.evaluate(async () => {
    const debug = window.__godsEyeView;
    if (debug.tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Expected a keyless preview');
    await debug.styleManager.initialRestorePromise;
  });
  // Only the canvas is captured: the HUD, cards and legends are hidden.
  await page.evaluate(() =>
    window.__godsEyeView.engine.host.canvas.setAttribute(
      'data-qa-occlusion',
      '',
    ),
  );
  await page.addStyleTag({
    content:
      'body *:not([data-qa-occlusion]) { visibility: hidden !important } [data-qa-occlusion] { visibility: visible !important }',
  });

  const settle = (frames = 40) =>
    page.evaluate(async (count) => {
      const { engine } = window.__godsEyeView;
      for (let i = 0; i < count; i++) {
        engine.render.request('qa-occlusion');
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, frames);
  const shot = async () => {
    await settle();
    return raw(await page.screenshot({ type: 'png' }));
  };
  const setWall = async (name) => {
    await page.evaluate(
      (key) =>
        window.__godsEyeView.engine.maps.setPhotorealTiles(
          key ? { kind: 'photoreal', googleApiKey: key } : null,
        ),
      name && `qa-fixture-${name}-no-network`,
    );
  };

  const results = {};
  for (const name of ONLY) {
    const scenario = SCENARIOS[name];
    if (scenario.engines && !scenario.engines.includes(kind)) continue;
    log.scenario = name;
    const frame = frameOf(scenario.site);
    const pose = {
      destination: toEcef(frame, scenario.camera.enu),
      orientation: {
        heading: scenario.camera.heading,
        pitch: (scenario.camera.pitchDeg * Math.PI) / 180,
        roll: 0,
      },
    };
    const aim = () =>
      page.evaluate(async (v) => {
        const { engine } = window.__godsEyeView;
        engine.camera.cancelFlight?.();
        engine.camera.setView(v);
      }, pose);
    await setWall(null);
    await aim();

    // The feature on and off: wind and stems are layers, the pack a shot.
    const show = {
      async wind(on) {
        await page.evaluate(async (enabled) => {
          const { dataManager } = window.__godsEyeView;
          await dataManager.setEnabled('wind', enabled, { origin: 'user' });
        }, on);
        if (on) {
          await page.waitForFunction(
            () => {
              const stats = window.__godsEyeView.dataManager.layers
                .get('wind')
                .module.getStats?.();
              return stats && !stats.loading && stats.count > 0;
            },
            { timeout: 60000 },
          );
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      },
      async stems(on) {
        await page.evaluate(async (enabled) => {
          const { dataManager } = window.__godsEyeView;
          await dataManager.setEnabled('local-datacenters', enabled, {
            origin: 'user',
          });
        }, on);
        if (on) {
          await page.waitForFunction(
            () =>
              window.__godsEyeView.dataManager.layers
                .get('local-datacenters')
                .module.getStats?.().count > 0,
            { timeout: 60000 },
          );
          // Let the level-of-detail sweep raise the stems in view.
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      },
      async packs(on) {
        await page.evaluate(
          async (shotId, camera) => {
            const d = window.__godsEyeView.sceneDirector;
            if (!window.__qaPackProject) {
              const manifest = (id, format, file, placement) => ({
                id,
                version: 1,
                format,
                source: { adapter: 'assets', path: `qa/${file}` },
                attribution: {
                  text: 'Synthetic QA fixture',
                  license: 'CC0-1.0',
                },
                placement,
              });
              const project = {
                version: 5,
                scenes: [
                  {
                    id: 'occlusion',
                    title: 'Occlusion QA',
                    dataPacks: [
                      manifest('outline', 'geojson', 'outline.json', {
                        altitudeReference: 'ellipsoid',
                      }),
                      manifest('image', 'image', 'image.png', {
                        bounds: camera.imageBounds,
                        height: 300,
                        altitudeReference: 'ellipsoid',
                      }),
                    ],
                    shots: ['with', 'without'].map((id) => ({
                      id,
                      title: id,
                      camera: camera.pose,
                      durationSec: 0.3,
                      holdSec: 0.2,
                      layers: {},
                      dataPackIds: id === 'with' ? ['outline', 'image'] : [],
                    })),
                  },
                ],
              };
              await d.importProjectFile(
                new File([JSON.stringify(project)], 'occlusion.json'),
              );
              window.__qaPackProject = true;
            }
            await d.loadShot('occlusion', shotId, { flyDuration: 0 });
          },
          on ? 'with' : 'without',
          {
            pose: {
              lat: scenario.site.lat,
              lon: scenario.site.lon,
              alt: scenario.camera.enu[2],
              heading: 0,
              pitch: scenario.camera.pitchDeg,
              roll: 0,
            },
            imageBounds: (() => {
              const sw = offset(scenario.site, 100, 600);
              const ne = offset(scenario.site, 700, 1500);
              return [sw.lon, sw.lat, ne.lon, ne.lat];
            })(),
          },
        );
        if (on)
          await page.waitForFunction(
            () =>
              window.__godsEyeView.sceneDirector.getDataPackState().count >= 2,
            { timeout: 60000 },
          );
        await new Promise((resolve) => setTimeout(resolve, 800));
      },
    }[name];

    // The wall face the camera sees, on screen, inside a 10 % margin.
    const face = await page.evaluate((corners) => {
      const { engine } = window.__godsEyeView;
      return corners.map((p) => {
        const w = engine.projector.worldToWindow(p);
        return w && { x: w.x, y: w.y };
      });
    }, faceCorners(scenario));
    const clip = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
    const xs = face.filter(Boolean).map((p) => p.x);
    const ys = face.filter(Boolean).map((p) => p.y);
    const x0 = face.every(Boolean) ? Math.min(...xs) : 0;
    const x1 = face.every(Boolean) ? Math.max(...xs) : VIEW.width;
    const y0 = face.every(Boolean) ? Math.min(...ys) : 0;
    const y1 = face.every(Boolean) ? Math.max(...ys) : VIEW.height;
    const region = {
      x0: clip(Math.max(x0, VIEW.width * 0.1), VIEW.width),
      x1: clip(Math.min(x1, VIEW.width * 0.9), VIEW.width),
      y0: clip(Math.max(y0, VIEW.height * 0.1), VIEW.height),
      y1: clip(Math.min(y1, VIEW.height * 0.9), VIEW.height),
    };
    assert.ok(
      region.x1 - region.x0 > 200 && region.y1 - region.y0 > 150,
      `${kind} ${name}: the wall covers too little of the view ${JSON.stringify(region)}`,
    );

    // Control: no wall.
    await show(false);
    await aim();
    const openOff = await shot();
    await show(true);
    await aim();
    const openOn = await shot();
    const controlMask = changed(openOff, openOn, scenario);
    const control = share(controlMask, region);

    // The wall between the camera and the feature: wait until a ray to the
    // middle of the face the camera sees stops on that face.
    await setWall(name);
    await aim();
    const origin = toEcef(frame, scenario.camera.enu);
    const corners = faceCorners(scenario);
    const middle = ['x', 'y', 'z'].map(
      (axis) => corners.reduce((sum, p) => sum + p[axis], 0) / 4,
    );
    const toward = [
      middle[0] - origin.x,
      middle[1] - origin.y,
      middle[2] - origin.z,
    ];
    const expected = Math.hypot(...toward);
    const direction = {
      x: toward[0] / expected,
      y: toward[1] / expected,
      z: toward[2] / expected,
    };
    const wallDistance = await page
      .waitForFunction(
        (origin, direction, expected) => {
          const debug = window.__godsEyeView;
          const { engine } = debug;
          engine.render.request('qa-occlusion');
          const hit = engine.surface.raycastSupported
            ? engine.surface.raycast({ origin, direction, far: expected * 2 })
            : debug.viewer?.scene.pickFromRay({ origin, direction }, []);
          if (!hit?.position) return false;
          const p = hit.position;
          const distance = Math.hypot(
            p.x - origin.x,
            p.y - origin.y,
            p.z - origin.z,
          );
          return Math.abs(distance - expected) < Math.max(5, expected * 0.005)
            ? distance
            : false;
        },
        { timeout: 60000, polling: 250 },
        origin,
        direction,
        expected,
      )
      .then((handle) => handle.jsonValue())
      .catch(() => {
        throw Error(
          `${kind} ${name}: the fixture wall never stood in the view (served: ${JSON.stringify(log.served.slice(-6))})`,
        );
      });
    const walledOn = await shot();
    await show(false);
    await aim();
    const walledOff = await shot();
    const hidden = share(changed(walledOff, walledOn, scenario), region);
    if (RECORD) {
      await mkdir(RECORD, { recursive: true });
      for (const [suffix, image] of [
        ['walled-on', walledOn],
        ['walled-off', walledOff],
      ])
        await sharp(image.data, {
          raw: { width: image.width, height: image.height, channels: 3 },
        })
          .png()
          .toFile(path.join(RECORD, `${kind}-${name}-${suffix}.png`));
    }

    // Look in the open, compared with a recorded build.
    const controlPng = await sharp(openOn.data, {
      raw: { width: openOn.width, height: openOn.height, channels: 3 },
    })
      .png()
      .toBuffer();
    let look = null;
    if (RECORD) {
      await mkdir(RECORD, { recursive: true });
      await writeFile(
        path.join(RECORD, `${kind}-${name}-open.png`),
        controlPng,
      );
      await writeFile(
        path.join(RECORD, `${kind}-${name}-open-off.png`),
        await sharp(openOff.data, {
          raw: { width: openOff.width, height: openOff.height, channels: 3 },
        })
          .png()
          .toBuffer(),
      );
      await writeFile(
        path.join(RECORD, `${kind}-${name}.json`),
        JSON.stringify({ control }),
      );
    }
    if (BASELINE) {
      const before = await raw(
        await readFile(path.join(BASELINE, `${kind}-${name}-open.png`)),
      );
      const beforeOff = await raw(
        await readFile(path.join(BASELINE, `${kind}-${name}-open-off.png`)),
      );
      const recorded = JSON.parse(
        await readFile(path.join(BASELINE, `${kind}-${name}.json`), 'utf8'),
      );
      // The feature's own pixels in the recorded build.
      const featureMask = changed(beforeOff, before);
      const sceneDrift = share(changed(beforeOff, openOff), region);
      let pixels = 0;
      let moved = 0;
      for (let i = 0; i < featureMask.length; i++) {
        if (!featureMask[i]) continue;
        pixels++;
        const d =
          Math.abs(before.data[i * 3] - openOn.data[i * 3]) +
          Math.abs(before.data[i * 3 + 1] - openOn.data[i * 3 + 1]) +
          Math.abs(before.data[i * 3 + 2] - openOn.data[i * 3 + 2]);
        if (d > DEVIATION) moved++;
      }
      look = {
        featurePixels: pixels,
        changedShare: pixels ? moved / pixels : 0,
        recordedControl: recorded.control,
        sceneDrift,
      };
    }
    results[name] = { wallDistance, control, hidden, look };
    console.log(kind, name, JSON.stringify(results[name]));
    await show(false);
    await setWall(null);
  }

  console.log(
    kind,
    JSON.stringify({
      fixtureResponses: log.served.filter((entry) => entry.fulfilled).length,
      refused: log.served.filter((entry) => !entry.fulfilled).length,
      refusedRemote,
      errors,
    }),
  );
  assert.deepEqual(remote, [], `${kind}: traffic left 127.0.0.1`);
  for (const [name, result] of Object.entries(results)) {
    assert.ok(
      result.control >= MIN_CONTROL_SHARE,
      `${kind} ${name}: the control does not show the feature (${result.control})`,
    );
    assert.ok(
      result.hidden <= MAX_HIDDEN_SHARE,
      `${kind} ${name}: the feature paints through the wall (${result.hidden})`,
    );
    if (result.look && name !== 'wind')
      assert.ok(
        result.look.changedShare <= MAX_LOOK_CHANGE,
        `${kind} ${name}: the feature looks different in the open (${JSON.stringify(result.look)})`,
      );
  }
  await page.close();
}

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--use-angle=metal',
    '--enable-gpu',
    // Default-deny network: no host but the preview resolves.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ],
});
try {
  for (const kind of ENGINES) await checkEngine(browser, kind);
  console.log(
    `PASS ${ONLY.join(', ')} do not paint through a wall on ${ENGINES.join(', ')}`,
  );
} finally {
  await browser.close();
}
