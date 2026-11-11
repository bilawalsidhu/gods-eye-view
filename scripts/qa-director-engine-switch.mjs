import { whenPickable, whenSettled } from './qa/ready.mjs';
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createStrict, localPreview } from './qa-strict-harness.mjs';
import { fromDegrees } from '../src/geo/cartesian3.js';
const url = localPreview(process.argv[2]);
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&lat=30.2672&lon=-97.742&alt=4000&pitch=-90&heading=0&map=sentinel2&l=';
const png = await sharp({
  create: { width: 64, height: 64, channels: 4, background: '#fd2233' },
})
  .png()
  .toBuffer();
const features = [
  {
    id: 'point',
    geometry: { type: 'Point', coordinates: [-97.742, 30.27, 450] },
  },
  {
    id: 'line',
    geometry: {
      type: 'LineString',
      coordinates: [
        [-97.745, 30.268, 400],
        [-97.735, 30.268, 400],
      ],
    },
  },
  {
    id: 'polygon',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [-97.747, 30.264, 450],
          [-97.74, 30.264, 450],
          [-97.74, 30.267, 450],
          [-97.747, 30.264, 450],
        ],
      ],
    },
  },
].map((f) => ({ ...f, type: 'Feature' }));
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(16000, 40);
const pack = (id, format, path, placement) => ({
  id,
  version: 1,
  format,
  source: { adapter: 'assets', path },
  attribution: { text: 'Local fixture', license: 'CC0-1.0' },
  placement,
});
const camera = {
  lat: 30.2672,
  lon: -97.742,
  alt: 4000,
  heading: 0,
  pitch: -90,
  roll: 0,
  altitudeReference: 'ellipsoid',
};
const shot = {
  id: 'one',
  title: 'Pack view',
  camera,
  durationSec: 5,
  holdSec: 3,
  visual: { style: 'normal', mapStack: 'sentinel2' },
  layers: { earthquakes: true },
  dataPackIds: ['data', 'image', 'audio'],
  interactions: features.map((f) => ({
    id: f.id,
    label: 'Show ' + f.id,
    target: { packId: 'data', featureId: f.id },
    action: { type: 'card', text: f.id },
  })),
};
const project = {
  version: 6,
  scenes: [
    {
      id: 'parity',
      title: 'Test project',
      anchors: [
        {
          id: 'station',
          lat: 30.271,
          lon: -97.735,
          alt: 500,
          altitudeReference: 'ellipsoid',
        },
      ],
      dataPacks: [
        pack('data', 'geojson', 'data.json', {
          altitudeReference: 'ellipsoid',
        }),
        pack('image', 'image', 'image.png', {
          altitudeReference: 'ellipsoid',
          bounds: [-97.738, 30.264, -97.732, 30.267],
          height: 500,
        }),
        pack('audio', 'media', 'audio.wav', { anchorId: 'station' }),
      ],
      shots: [
        shot,
        {
          ...shot,
          id: 'two',
          title: 'Next shot',
          camera: { ...camera, heading: 15 },
          move: { from: camera, easing: 'linear' },
          dataPackIds: [],
          interactions: [],
        },
      ],
    },
  ],
};
// Scene Director is not a catalog layer; the scenario answers the scene's
// earthquake feed itself.
const strict = createStrict({
  origin: url.origin,
  layers: [],
  fixtures: ['https://earthquake.usgs.gov/*'],
});
await strict.run({}, async (b) => {
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 900 });
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message);
  });
  const reads = [];
  await p.setRequestInterception(true);
  p.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith('/scene-assets/')) {
      reads.push(path);
      const file = path.split('/').pop();
      return req.respond({
        status: 200,
        contentType:
          file === 'data.json'
            ? 'application/geo+json'
            : file === 'audio.wav'
              ? 'audio/wav'
              : 'image/png',
        body:
          file === 'data.json'
            ? JSON.stringify({ type: 'FeatureCollection', features })
            : file === 'audio.wav'
              ? wav
              : png,
      });
    }
    if (new URL(req.url()).hostname === 'earthquake.usgs.gov')
      return req.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{"type":"FeatureCollection","features":[]}',
      });
    return req.continue();
  });
  await p.goto(url.href);
  await whenSettled(p);
  await assertKeylessPreview(p);
  await p.evaluate(async (project) => {
    const a = window.__godsEyeView;

    await a.styleManager.initialRestorePromise;
    window.director = a.sceneDirector;
    await window.director.importProjectFile(
      new File([JSON.stringify(project)], 'qa.json'),
    );
    const out = await window.director.loadShot('parity', 'one', {
      flyDuration: 0.2,
    });
    if (!out.started)
      throw Error(
        'Pack load failed: ' +
          JSON.stringify(out) +
          ' ' +
          window.director._presentation.status,
      );
  }, project);
  await p.waitForSelector('[data-director-pack="audio"] audio');
  await p.evaluate(() => {
    window.qaAudio = document.querySelector(
      '[data-director-pack="audio"] audio',
    );
  });
  const at = (world) =>
    p.evaluate((world) => {
      const a = window.__godsEyeView;
      const xy = a.engine.projector.worldToWindow(world),
        rect = a.engine.host.canvas.getBoundingClientRect();
      return { x: xy.x + rect.x, y: xy.y + rect.y };
    }, world);
  for (const kind of ['navara', 'cesium', 'navara']) {
    if ((await p.evaluate(() => window.__godsEyeView.engine.kind)) !== kind)
      await strict.switchTo(p, kind);
    await whenSettled(p);
    const st = await p.evaluate(() => ({
      same: window.director === window.__godsEyeView.sceneDirector,
      media:
        window.qaAudio ===
        document.querySelector('[data-director-pack="audio"] audio'),
      packs: window.director.getDataPackState(),
      actions: window.director.getInteractionState(),
    }));
    assert.ok(
      st.same && st.media && st.packs.count === 3 && st.actions.count === 3,
    );
    const xy = await at(fromDegrees(-97.742, 30.27, 450));
    await whenPickable(p, xy, (picked) => picked?.id === '["data","point"]');
    await p.mouse.click(xy.x, xy.y);
    await p.waitForFunction(
      () => document.activeElement?.dataset.directorAction === 'point',
    );
    await p.keyboard.press('Enter');
    await p.waitForFunction(
      () => window.director.getInteractionState().selected === 'point',
    );
    for (const [id, coords] of [
      ['line', [-97.74, 30.268, 400]],
      ['polygon', [-97.742, 30.265, 450]],
    ]) {
      const hit = await at(fromDegrees(...coords));
      await p.mouse.click(hit.x, hit.y);
      await p.waitForFunction(
        (id) => document.activeElement?.dataset.directorAction === id,
        { timeout: 10000 },
        id,
      );
    }
    const imageAt = await at(fromDegrees(-97.735, 30.2655, 500));
    const sample = await sharp(await p.screenshot())
      .extract({
        left: Math.round(imageAt.x),
        top: Math.round(imageAt.y),
        width: 1,
        height: 1,
      })
      .removeAlpha()
      .raw()
      .toBuffer();
    console.log(kind, st.packs.count, st.actions.count, Array.from(sample));
    assert.ok(
      sample[0] > 100 && sample[0] > sample[1] * 2,
      'authored image really draws',
    );
    assert.equal(
      reads.length,
      3,
      'packs are not acquired again on a globe change',
    );
  }
  await p.evaluate(() => {
    window.qaRun = window.director.startScene('parity', {
      single: true,
      preview: false,
    });
  });
  await p.waitForFunction(
    () =>
      window.director.running &&
      window.director.getPlaybackTimingState().snapshot?.shotId === 'one',
  );
  await strict.switchTo(p, 'cesium');
  assert.ok(
    await p.evaluate(
      () =>
        window.director.running &&
        window.director === window.__godsEyeView.sceneDirector,
    ),
  );
  await p.waitForFunction(
    () => window.director.getPlaybackTimingState().snapshot?.shotId === 'two',
    { timeout: 20000 },
  );
  await strict.switchTo(p, 'navara');
  const complete = await p.evaluate(() => window.qaRun);
  assert.ok(complete.started && complete.shots === 2);
  assert.deepEqual(errors, []);
  console.log(
    'PASS authored packs, geographic picks, same player, original multi-shot timeline',
  );
});
