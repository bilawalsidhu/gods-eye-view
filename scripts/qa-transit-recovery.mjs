/** Camera-jump regression against an existing server; never starts a server. */
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';
import { reduceTrailPixels } from '../src/layers/transit/qaMetrics.js';

const base = process.env.QA_BASE_URL || 'http://localhost:4305';
const shots = process.env.QA_SHOTS || 'qa-shots/transit-recovery';
await mkdir(shots, { recursive: true });
const browser = await puppeteer.launch({
  headless: false,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/?welcome=0#lat=30.271&lon=-97.7431&alt=600&heading=0&pitch=-60`);
  await page.waitForFunction(() => window.__godsEyeView?.dataManager?.layers.has('transit'));
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.dataManager.setEnabled('transit', true, { source: 'qa' });
  });
  await page.waitForFunction(() => {
    const scene = window.__godsEyeView.viewer.scene;
    return scene.globe.tilesLoaded && scene.globe.show;
  }, { timeout: 60000 });
  await page.waitForFunction(() => document.getElementById('loading-screen')?.classList.contains('hidden'), { timeout: 60000 });
  await page.evaluate(() => {
    const app = window.__godsEyeView, camera = app.viewer.camera;
    const C = camera.positionCartographic.constructor, lat = 30.267 + 90 / 111320;
    const floor = app.viewer.scene.globe.getHeight(C.fromDegrees(-97.7431, lat)) || 0;
    camera.setView({ destination: C.toCartesian(C.fromDegrees(-97.7431,
      lat - 600 / Math.tan(Math.PI / 3) / 111320, floor + 600)),
      orientation: {heading:0, pitch:-Math.PI / 3, roll:0} });
  });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await page.waitForFunction(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded, {timeout:60000});
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const result = await page.evaluate(async () => {
    const app = window.__godsEyeView, scene = app.viewer.scene, camera = app.viewer.camera;
    const layer = app.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest(), parts = layer._transitPartsForTest();
    const { getRegisteredTransitFeed } = await import('/src/data/transitFeeds.js');
    const { setRate } = await import('/src/data/contactPlayback.js');
    const C = camera.positionCartographic.constructor;
    const feed = { ...getRegisteredTransitFeed('capmetro-austin'), id: 'qa-camera-recovery' };
    const aim = (lat, height = 600) => camera.setView({
      destination: C.toCartesian(C.fromDegrees(-97.7431, lat - 600 / Math.tan(Math.PI / 3) / 111320, height)),
      orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
    });
    parts.selection.clearSelection();
    parts.ingestion.abortAllInFlight();
    state._activeFeeds.clear();
    for (const key of state._vehicles.keys()) parts.ingestion.removeVehicle(key);
    // Model an outstanding floor lookup while reports arrive off screen.
    // Only acquisition is controlled; selection, visibility, paths and rendering
    // use their real owners. Release to the loaded terrain at the camera jump.
    const requestHeight = parts.height.requestHeight;
    parts.height.requestHeight = (lat, lon) => ({ cell: `${lat},${lon}`, height: null, prior: null });
    aim(30.28);
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      const timestamp = now - 135000 + i * 15000;
      parts.ingestion.applySnapshot(feed, {
        fetchedAt: timestamp,
        vehicles: [{ id: 'moving-bus', routeId: '1', tripId: 'qa',
          lat: 30.267 + i * 90 / 111320, lon: -97.7431,
          timestamp: timestamp / 1000, timestampSource: 'vehicle', bearing: 0 }],
      }, { stale: false });
    }
    const entry = state._vehicles.get(`${feed.id}:moving-bus`);
    entry.qaFixture = true; // Protect this disclosed fixture from live feed eviction.
    parts.rendering.sampleIdle(entry);
    const before = { shown: entry.marker.show, heightPending: entry.heightPending,
      phase: entry.sample.phase, fixes: entry.track.count };
    clearTimeout(state._floorTimer);
    state._floorTimer = null;
    const started = performance.now();
    parts.selection.selectVehicle(entry.key);
    const preparedAtSelection = !!parts.trails.diagnostics()?.body;
    parts.height.requestHeight = requestHeight;
    const floor = scene.globe.getHeight(C.fromDegrees(entry.sample.lon, entry.sample.lat)) || 0;
    aim(entry.sample.lat, floor + 600);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let trail;
    while (performance.now() - started < 1400) {
      trail = parts.trails.diagnostics();
      if (entry.marker.show && trail?.body?.show && trail.body.ready) break;
      scene.requestRender();
      await wait(25);
    }
    const status = { before, preparedAtSelection,
      markerShow: entry.marker.show, body: !!trail?.body, bodyShow: trail?.body?.show === true,
      visibility: layer._transitVisibilityForTest().find((e) => e.key === entry.key),
      recoveryMs: performance.now() - started };
    if (!entry.marker.show || !trail?.body?.show || !trail.body.ready)
      return { ...status, reason: 'marker or body did not recover before pixel deadline' };
    setRate(entry.track, 0, { wallNowMs: Date.now(), monoNowMs: performance.now() });
    parts.rendering.sampleIdle(entry);
    parts.rendering.schedulePlayback(entry);
    const V = entry.marker.position.constructor;
    const points = entry.trailSegments.filter((s) => s.toT <= entry.sample.displayT).flatMap((s) => s.positions);
    const lengths = [0];
    for (let i = 1; i < points.length; i++) lengths.push(lengths.at(-1) + V.distance(points[i-1], points[i]));
    const canvas = scene.canvas, gl = scene.context._gl, scale = canvas.width / canvas.clientWidth;
    const mul = (m, v) => [0,1,2,3].map((i) => m[i]*v[0]+m[i+4]*v[1]+m[i+8]*v[2]+m[i+12]*v[3]);
    const project = (p) => {
      const q = mul(camera.frustum.projectionMatrix, mul(camera.viewMatrix, [p.x,p.y,p.z,1]));
      return { x: (q[0]/q[3]*0.5+0.5)*canvas.clientWidth,
        y: (0.5-q[1]/q[3]*0.5)*canvas.clientHeight, inFront: q[3]>0 };
    };
    const samples = Array.from({length:8}, (_,i) => {
      const d = lengths.at(-1)*(i+1)/9;
      let j=1;
      while(j<lengths.length-1 && lengths[j]<d) j++;
      const p=V.lerp(points[j-1],points[j],(d-lengths[j-1])/Math.max(.001,lengths[j]-lengths[j-1]),new V());
      const cart=C.fromCartesian(p);
      cart.height=scene.globe.getHeight(cart) || 0;
      return {...project(C.toCartesian(cart)), radius:Math.SQRT2*Math.ceil(3*scale)/scale};
    });
    const sprite = {...project(entry.marker.position), radius:Math.hypot(entry.marker.width,entry.marker.height)/2+4};
    const read = () => samples.map(({x,y}) => {
      const r=Math.ceil(3*scale), px=Math.round(x*scale), py=Math.round(canvas.height-1-y*scale);
      if(px<r||py<r||px+r>=canvas.width||py+r>=canvas.height) return null;
      const data=new Uint8Array((2*r+1)**2*4);
      gl.readPixels(px-r,py-r,2*r+1,2*r+1,gl.RGBA,gl.UNSIGNED_BYTE,data);
      return Array.from(data);
    });
    const frame=()=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{remove();reject(new Error('No recovery frame'));},500);
      const remove=scene.postRender.addEventListener(()=>{remove();clearTimeout(timer);resolve(read());});
      scene.requestRender();
    });
    let visible=true;
    const remove=scene.preRender.addEventListener(()=>{
      trail.body.show=visible;
      if(trail.headPrimitive) trail.headPrimitive.show=visible && trail.head.show;
    });
    const captures=[];
    try {
      for(const show of [false,true,false,true]) { visible=show; await frame(); captures.push(await frame()); }
    } finally { remove(); parts.trails.update(); }
    const [off,on,offAgain,onAgain]=captures;
    return {...status, samples,sprite,off,on,offAgain,onAgain,tilesReady:scene.globe.tilesLoaded && parts.trails.diagnostics().body === trail.body,
      elapsedMs:performance.now()-started,
      attributes: Array.from({length:4},(_,i)=>{
        const a=trail.body.getGeometryInstanceAttributes(`${i}:1`);
        return {show:Array.from(a.show),color:Array.from(a.color)};
      })};
  });
  const pixels = reduceTrailPixels(result.on, result.off, result);
  result.present = pixels.present;
  result.pixelPass = pixels.pass;
  result.pixelDetails = pixels;
  result.errors = errors;
  await page.screenshot({ path: `${shots}/recovery.png` });
  await writeFile(`${shots}/recovery.json`, JSON.stringify(result, null, 2));
  for (const key of ['on','off','onAgain','offAgain']) delete result[key];
  const pass = result.before?.shown === false && result.before?.phase === 'playing' &&
    result.preparedAtSelection && result.markerShow && result.body && result.bodyShow &&
    result.elapsedMs <= 2000 && pixels.pass && !errors.length;
  console.log(`${pass ? 'PASS' : 'FAIL'} select moving bus, setView, marker + body + >=6/8 trail pixels within 2 s`);
  console.log(JSON.stringify(result));
  process.exitCode = pass ? 0 : 1;
} finally { await browser.close(); }
