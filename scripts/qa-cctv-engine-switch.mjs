import { waitForEngine } from './qa-strict-harness.mjs';
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { installCctvFixture } from './fixtures/layers/cctv.mjs';
import { createStrict, localPreview } from './qa-strict-harness.mjs';
const url = localPreview(process.argv[2]);
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
const strict = createStrict({ origin: url.origin, layers: ['cctv'] });
await strict.run({}, async (b) => {
  const p = await b.newPage();
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
  await waitForEngine(p, 'navara');
  await assertKeylessPreview(p);
  await p.evaluate(async () => {
    const { dataManager, styleManager } = window.__godsEyeView;

    await styleManager.initialRestorePromise;
    await dataManager.setEnabled('cctv', true, { origin: 'user' });
    window.qaCctv = dataManager.layers.get('cctv').module;
    window.qaCctv.setParams({
      selectedCameraId: 'fixture-cctv-video',
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
    await strict.switchTo(p, kind);
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
        .find((r) => r.camera.id === 'fixture-cctv-video').projection
        ?.planeEntity,
      projection: (() => {
        const r = window.qaCctv
          ._cctvRecordsForTest()
          .find((r) => r.camera.id === 'fixture-cctv-video');
        return {
          show: r.projection?.planeEntity?.show === true,
          visible: r.projection?.planeVisible === true,
          calibration: r.camera.calibration,
        };
      })(),
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
    assert.equal(v.params.selectedCameraId, 'fixture-cctv-video');
    assert.equal(v.params.coverageMode, 'viewshed');
    assert.equal(catalogs, count);
    await strict.passed(
      p,
      'cctv',
      'same model and video element decoding new frames; textured projection plane; no catalog read',
    );
    // The calibration patch (31 m mount, 20° pitch) and the plane's
    // visibility are kept on the new engine.
    const { calibration } = v.projection;
    await strict.check(
      p,
      'cctv',
      'calibration patch kept (31 m, 20° pitch); monitor plane visible',
      v.projection.show &&
        v.projection.visible &&
        calibration?.heightM === 31 &&
        calibration?.pitchDeg === 20 &&
        v.params.calibration?.values?.heightM === 31 &&
        v.params.calibration?.values?.pitchDeg === 20,
      v.projection,
    );
    previous = v.frames;
  }
  assert.deepEqual(errors, []);
  console.log('PASS retained CCTV catalog, decoder and textured projection');
});
