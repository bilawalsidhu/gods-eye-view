// Edge case for the CCTV layer (docs/migration/planet-separation/layers.md,
// row `cctv`): the drawn camera frame must not pass through a wall. On each
// engine a one-box 3D tileset stands 80-100 m in front of a camera; the
// activation probe must end the frame before the wall, and seen from behind
// the wall the GPU must not show any of it. A control with the range slider
// moved (which by design skips the probe) proves the check can fail.
//
// Billing safety: the browser resolves no host but 127.0.0.1, so nothing
// leaves the machine. The box is served as a local fixture at the photoreal
// tiles URL, the only 3D tileset path both engines have (src/globe/navara/
// maps.js hard-codes it), with a fake key; no Google request is ever sent.
//
// Usage: node scripts/qa-edge-cctv-occlusion.mjs http://127.0.0.1:<PORT>/ [outDir]
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import * as geo from '../src/geo/index.js';
import { cameras, installCctvFixture } from './fixtures/w2/cctv.mjs';

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
const outDir = process.argv[3] ?? null;

const FIXTURE_KEY = 'qa-fixture-no-network';
const TILES_HOST = 'tile.googleapis.com';
const CAMERA_ID = 'w2-cctv-020';
const camera = cameras.find((entry) => entry.id === CAMERA_ID);
// Level the camera, face it north and lift it clear of the ground, so its
// axis meets the wall's face and nothing else.
const CALIBRATION = {
  headingDeg: -camera.headingDeg,
  pitchDeg: -camera.pitchDeg,
  heightM: 100,
};
const WALL = { east: [-400, 400], north: [80, 100], up: [-300, 700] };
const VIEW_NORTH_M = 600;
const DEVIATION = 60; // summed RGB difference that counts as "not wall"
const MAX_CLAMPED_FRACTION = 0.1;
const MIN_CONTROL_FRACTION = 0.4;

const enuFrame = geo.transforms.eastNorthUpToFixedFrame(
  geo.cartesian3.fromDegrees(camera.lon, camera.lat, 0),
);
const frame = Array.from({ length: 16 }, (_, i) => enuFrame[i]);
const toEcef = ([e, n, u]) => ({
  x: frame[0] * e + frame[4] * n + frame[8] * u + frame[12],
  y: frame[1] * e + frame[5] * n + frame[9] * u + frame[13],
  z: frame[2] * e + frame[6] * n + frame[10] * u + frame[14],
});
const toEnu = (p) => {
  const d = [p.x - frame[12], p.y - frame[13], p.z - frame[14]];
  return [0, 1, 2].map(
    (axis) =>
      frame[axis * 4] * d[0] +
      frame[axis * 4 + 1] * d[1] +
      frame[axis * 4 + 2] * d[2],
  );
};
const dirEcef = ([e, n, u]) => {
  const p = toEcef([e, n, u]);
  return { x: p.x - frame[12], y: p.y - frame[13], z: p.z - frame[14] };
};

/** A glTF binary with one box, written in glTF's y-up axes (x, z, -y). */
function wallGlb() {
  const [e0, e1] = WALL.east;
  const [n0, n1] = WALL.north;
  const [u0, u1] = WALL.up;
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
  const min = [0, 1, 2].map((a) =>
    Math.min(...positions.filter((_, i) => i % 3 === a)),
  );
  const max = [0, 1, 2].map((a) =>
    Math.max(...positions.filter((_, i) => i % 3 === a)),
  );
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
        min,
        max,
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

const tileset = {
  asset: { version: '1.1' },
  geometricError: 1000,
  root: {
    transform: frame,
    boundingVolume: {
      box: [
        (WALL.east[0] + WALL.east[1]) / 2,
        (WALL.north[0] + WALL.north[1]) / 2,
        (WALL.up[0] + WALL.up[1]) / 2,
        (WALL.east[1] - WALL.east[0]) / 2,
        0,
        0,
        0,
        (WALL.north[1] - WALL.north[0]) / 2,
        0,
        0,
        0,
        (WALL.up[1] - WALL.up[0]) / 2,
      ],
    },
    geometricError: 0,
    refine: 'REPLACE',
    content: { uri: 'qa-wall.glb' },
  },
};
const glb = wallGlb();

/** Serve the wall at the photoreal URL; every other request there is refused. */
async function installWallFixture(page, served) {
  const session = await page.createCDPSession();
  await session.send('Fetch.enable', {
    patterns: [{ urlPattern: `https://${TILES_HOST}/*` }],
  });
  session.on('Fetch.requestPaused', ({ requestId, request }) => {
    const target = new URL(request.url);
    const body = target.pathname.endsWith('/root.json')
      ? { type: 'application/json', data: Buffer.from(JSON.stringify(tileset)) }
      : target.pathname.endsWith('/qa-wall.glb')
        ? { type: 'model/gltf-binary', data: glb }
        : null;
    served.push({ url: request.url, fulfilled: Boolean(body) });
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

/** Share of pixels inside the quad (shrunk, mount icon cut out) unlike the wall. */
async function paintedShare(png, quad, mount, reference, name) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x, y) => {
    const i = (Math.round(y) * info.width + Math.round(x)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const patch = [];
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++)
      patch.push(at(reference.x + dx, reference.y + dy));
  const wall = [0, 1, 2].map(
    (c) => patch.map((p) => p[c]).sort((a, b) => a - b)[40],
  );
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const shrink = (lo, hi) => [lo + (hi - lo) * 0.15, hi - (hi - lo) * 0.15];
  const [x0, x1] = shrink(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = shrink(Math.min(...ys), Math.max(...ys));
  assert.ok(
    x1 - x0 > 20 && y1 - y0 > 10,
    `${name}: frame quad too small on screen`,
  );
  let total = 0;
  let painted = 0;
  for (
    let y = Math.max(0, Math.ceil(y0));
    y <= Math.min(info.height - 1, y1);
    y++
  )
    for (
      let x = Math.max(0, Math.ceil(x0));
      x <= Math.min(info.width - 1, x1);
      x++
    ) {
      if (Math.abs(x - mount.x) < 24 && Math.abs(y - mount.y) < 24) continue;
      total++;
      const p = at(x, y);
      if (
        Math.abs(p[0] - wall[0]) +
          Math.abs(p[1] - wall[1]) +
          Math.abs(p[2] - wall[2]) >
        DEVIATION
      )
        painted++;
    }
  return { share: painted / total, total, wall };
}

async function checkEngine(browser, kind) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  const errors = [];
  const served = [];
  const remote = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const host = new URL(response.url()).hostname;
    if (host && host !== '127.0.0.1' && !response.url().startsWith('data:'))
      remote.push(response.url());
  });
  await installCctvFixture(page);
  await installWallFixture(page, served);
  const start = new URL(url);
  start.search = `?engine=${kind}&welcome=0`;
  start.hash = `v=2&lat=${camera.lat + 0.005}&lon=${camera.lon}&alt=300&pitch=-10&heading=180&l=`;
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

  // The wall, then wait until a ray along the camera axis meets it.
  const probeOrigin = toEcef([0, 0, 300]);
  const north = dirEcef([0, 1, 0]);
  await page.evaluate(
    (key) =>
      window.__godsEyeView.engine.maps.setPhotorealTiles({
        kind: 'photoreal',
        googleApiKey: key,
      }),
    FIXTURE_KEY,
  );
  const viewpoint = (up) => ({
    destination: toEcef([0, VIEW_NORTH_M, up]),
    orientation: { heading: Math.PI, pitch: 0, roll: 0 },
  });
  const look = (view) =>
    page.evaluate(async (v) => {
      const { engine } = window.__godsEyeView;
      engine.camera.cancelFlight?.();
      engine.camera.setView(v);
      for (let i = 0; i < 20; i++) {
        engine.render.request('qa-occlusion');
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, view);
  await look(viewpoint(300));
  const wallDistance = await page
    .waitForFunction(
      (origin, direction) => {
        const debug = window.__godsEyeView;
        const { engine } = debug;
        engine.render.request('qa-occlusion');
        let hit;
        if (engine.surface.raycastSupported)
          hit = engine.surface.raycast({ origin, direction, far: 1000 });
        else hit = debug.viewer?.scene.pickFromRay({ origin, direction }, []);
        if (!hit?.position) return false;
        const p = hit.position;
        return Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z);
      },
      { timeout: 60000, polling: 250 },
      probeOrigin,
      north,
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null);
  assert.ok(
    wallDistance !== null,
    `${kind}: the fixture wall never became hittable (served: ${JSON.stringify(served)})`,
  );
  assert.ok(
    Math.abs(wallDistance - WALL.north[0]) < 2,
    `${kind}: wall at ${wallDistance} m`,
  );

  // Activate the camera with the wall in its range.
  await page.evaluate(
    async (id, patch) => {
      const { dataManager } = window.__godsEyeView;
      await dataManager.setEnabled('cctv', true, { origin: 'user' });
      window.qaCctv = dataManager.layers.get('cctv').module;
      await new Promise((resolve) => {
        const ready = () =>
          window.qaCctv._cctvRecordsForTest().some((r) => r.camera.id === id)
            ? resolve()
            : setTimeout(ready, 100);
        ready();
      });
      window.qaCctv.setParams({
        coverageMode: 'viewshed',
        calibration: { cameraId: id, patch },
      });
      window.qaCctv.setParams({ selectedCameraId: id, showProjection: true });
    },
    CAMERA_ID,
    CALIBRATION,
  );

  const settle = async (label, predicate) => {
    await page.waitForFunction(
      (id) => {
        const record = window.qaCctv
          ._cctvRecordsForTest()
          .find((r) => r.camera.id === id);
        return Boolean(
          record?.projection?.planeEntity &&
          record.projection.imageReady &&
          record.frustumPositions,
        );
      },
      { timeout: 60000 },
      CAMERA_ID,
    );
    const state = await page.evaluate((id) => {
      const record = window.qaCctv
        ._cctvRecordsForTest()
        .find((r) => r.camera.id === id);
      const plain = (p) => ({ x: p.x, y: p.y, z: p.z });
      const f = record.frustumPositions;
      return {
        clamp: record.probeClampRangeM,
        range: record.camera.rangeM,
        mount: plain(f.mount),
        cap: plain(f.capCenter),
        corners: [f.tl, f.tr, f.br, f.bl].map(plain),
      };
    }, CAMERA_ID);
    const mount = toEnu(state.mount);
    const cap = toEnu(state.cap);
    const corners = state.corners.map(toEnu);
    predicate?.(state, { mount, cap, corners });
    // Behind the wall, looking back at the camera; the dim depth-fail
    // wireframe is by design visible through geometry, so it is hidden here.
    await look(viewpoint(mount[2]));
    await page.addStyleTag({
      content:
        'body *:not([data-qa-occlusion]) { visibility: hidden !important } [data-qa-occlusion] { visibility: visible !important }',
    });
    const screen = await page.evaluate(
      async (id, cornersEcef, mountEcef, referenceEcef) => {
        const { engine } = window.__godsEyeView;
        engine.host.canvas.setAttribute('data-qa-occlusion', '');
        const record = window.qaCctv
          ._cctvRecordsForTest()
          .find((r) => r.camera.id === id);
        for (const entity of record.coverageEntities ?? []) entity.show = false;
        for (let i = 0; i < 30; i++) {
          engine.render.request('qa-occlusion');
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const project = (p) => {
          const w = engine.projector.worldToWindow(p);
          return w && { x: w.x, y: w.y };
        };
        const rect = engine.host.canvas.getBoundingClientRect();
        return {
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          quad: cornersEcef.map(project),
          mount: project(mountEcef),
          reference: project(referenceEcef),
          planeShown: record.projection.planeEntity.show,
        };
      },
      CAMERA_ID,
      state.corners,
      state.mount,
      toEcef([-260, WALL.north[1], mount[2]]),
    );
    assert.ok(screen.planeShown, `${kind} ${label}: the frame plane is hidden`);
    assert.ok(screen.quad.every(Boolean) && screen.mount && screen.reference);
    assert.deepEqual([screen.rect.x, screen.rect.y], [0, 0]);
    const png = await page.screenshot({ type: 'png' });
    if (outDir) await writeFile(path.join(outDir, `${kind}-${label}.png`), png);
    const result = await paintedShare(
      png,
      screen.quad,
      screen.mount,
      screen.reference,
      `${kind} ${label}`,
    );
    await page.evaluate(() =>
      document
        .querySelectorAll('style')
        .forEach(
          (s) => s.textContent.includes('data-qa-occlusion') && s.remove(),
        ),
    );
    return { ...state, enu: { mount, cap }, ...result };
  };

  const clamped = await settle('clamped', (state, { mount, cap }) => {
    assert.ok(
      Math.abs(mount[0]) < 1 && Math.abs(mount[1]) < 1,
      `${kind}: mount moved`,
    );
    assert.ok(
      Number.isFinite(state.clamp) && state.clamp < WALL.north[0],
      `${kind}: no activation clamp before the wall (clamp ${state.clamp})`,
    );
    assert.ok(
      cap[1] <= WALL.north[0],
      `${kind}: the frame ends ${cap[1].toFixed(1)} m north, past the wall`,
    );
  });

  // Control: the range slider takes manual control and skips the probe, so
  // the frame stands beyond the wall and must be seen from behind it.
  await page.evaluate(
    (id) =>
      window.qaCctv.setParams({
        calibration: { cameraId: id, patch: { rangeScale: 1.01 } },
      }),
    CAMERA_ID,
  );
  await page.waitForFunction(
    (id) => {
      const record = window.qaCctv
        ._cctvRecordsForTest()
        .find((r) => r.camera.id === id);
      return record.probeClampRangeM == null;
    },
    {},
    CAMERA_ID,
  );
  const control = await settle('control', (state, { cap }) => {
    assert.ok(
      cap[1] > WALL.north[1],
      `${kind}: control frame did not pass the wall`,
    );
  });

  const servedOk = served.filter((entry) => entry.fulfilled).length;
  const fixtureUrls = new Set(served.map((entry) => entry.url));
  const leaked = remote.filter((entry) => !fixtureUrls.has(entry));
  console.log(
    kind,
    JSON.stringify({
      wallDistance: +wallDistance.toFixed(2),
      clamp: +clamped.clamp.toFixed(2),
      clampedCapNorth: +clamped.enu.cap[1].toFixed(2),
      clampedPaintedShare: +clamped.share.toFixed(4),
      controlCapNorth: +control.enu.cap[1].toFixed(2),
      controlPaintedShare: +control.share.toFixed(4),
      pixels: clamped.total,
      wallColour: clamped.wall,
      fixtureResponses: servedOk,
      errors: errors.length,
    }),
  );
  assert.deepEqual(leaked, [], `${kind}: responses from the network`);
  assert.ok(
    control.share >= MIN_CONTROL_FRACTION,
    `${kind}: the control frame is not visible behind the wall (${control.share})`,
  );
  assert.ok(
    clamped.share <= MAX_CLAMPED_FRACTION,
    `${kind}: the frame paints through the wall (${clamped.share})`,
  );
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
  if (outDir) await mkdir(outDir, { recursive: true });
  for (const kind of (process.argv[4] ?? 'navara,cesium').split(','))
    await checkEngine(browser, kind);
  console.log(
    'PASS the CCTV frame ends at the wall and does not paint through it on both engines',
  );
} finally {
  await browser.close();
}
