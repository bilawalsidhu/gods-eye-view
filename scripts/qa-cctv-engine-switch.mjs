import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import puppeteer from 'puppeteer';
import { installCctvFixture } from './fixtures/w2/cctv.mjs';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { switchGlobe } from './qa-switch-globe.mjs';
const url = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    url.port,
  )
)
  throw Error('Supply local keyless preview URL');
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&lat=30.2718&lon=-97.744&alt=900&pitch=-70&heading=0&map=sentinel2&l=';
const { stdout: video } = await promisify(execFile)(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=12',
    '-t',
    '60',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-threads',
    '1',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ],
  { encoding: 'buffer', maxBuffer: 16000000 },
);
const b = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const p = await b.newPage();
  await blockPaidQaMaps(p);
  const errors = [];
  p.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('error', e.message);
  });
  await installCctvFixture(p, { video });
  let catalogs = 0;
  p.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/cctv/sources') catalogs++;
  });
  await p.goto(url.href);
  await p.waitForFunction(
    () =>
      window.__godsEyeView?.engine.kind === 'navara' &&
      document.querySelector('#loading-screen.hidden'),
  );
  await p.evaluate(async () => {
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    if (tileset || window.__GOOGLE_MAPS_API_KEY__)
      throw Error('Expected keyless preview');
    await styleManager.initialRestorePromise;
    await dataManager.setEnabled('cctv', true, { origin: 'user' });
    window.qaCctv = dataManager.layers.get('cctv').module;
    window.qaCctv.setParams({
      selectedCameraId: 'w2-cctv-video',
      showProjection: true,
      coverageMode: 'viewshed',
      calibration: { patch: { heightM: 31, pitchDeg: 20 } },
    });
  });
  await p.waitForFunction(
    () =>
      window.qaCctv.getActiveVideoElement()?.videoWidth === 320 &&
      window.qaCctv.getActiveVideoElement().currentTime > 0.1,
    { timeout: 40000 },
  );
  const first = await p.evaluate(() => {
    window.qaVideo = window.qaCctv.getActiveVideoElement();
    return window.qaVideo.getVideoPlaybackQuality().totalVideoFrames;
  });
  let previous = first;
  const count = catalogs;
  for (const kind of ['cesium', 'navara']) {
    await switchGlobe(p, kind);
    await p.waitForFunction(
      (n) =>
        window.qaCctv.getActiveVideoElement()?.getVideoPlaybackQuality()
          .totalVideoFrames > n,
      {},
      previous,
    );
    const v = await p.evaluate(() => ({
      same:
        window.qaCctv ===
        window.__godsEyeView.dataManager.layers.get('cctv').module,
      media: window.qaCctv.getActiveVideoElement() === window.qaVideo,
      frames: window.qaVideo.getVideoPlaybackQuality().totalVideoFrames,
      paused: window.qaVideo.paused,
      params: window.qaCctv.getParams(),
      plane: !!window.qaCctv
        ._cctvRecordsForTest()
        .find((r) => r.camera.id === 'w2-cctv-video').projection?.planeEntity,
    }));
    console.log(
      kind,
      v.same,
      v.media,
      v.frames,
      v.plane,
      v.params.selectedCameraId,
      v.params.coverageMode,
    );
    assert.ok(v.same && v.media && v.plane && !v.paused);
    assert.equal(v.params.selectedCameraId, 'w2-cctv-video');
    assert.equal(v.params.coverageMode, 'viewshed');
    assert.equal(catalogs, count);
    previous = v.frames;
  }
  assert.deepEqual(errors, []);
  console.log('PASS retained CCTV catalog, decoder and textured projection');
} finally {
  await b.close();
}
