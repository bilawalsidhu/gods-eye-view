#!/usr/bin/env node
/** Real console + Cesium viewer, scripted model responses, no account or imagery. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const template = await fs.readFile(
  'src/ui/templates/agent-console.html',
  'utf8',
);
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/node_modules/cesium/Build/Cesium/Widgets/widgets.css">
<link rel="stylesheet" href="/style.css">
<style>html,body,#map{width:100%;height:100%;margin:0;overflow:hidden}</style>
</head><body><div id="map"></div>${template}<script type="module">
import * as Cesium from 'cesium';
import { mountAgentConsole } from '/src/agent/agentConsole.js';
import { createGevActionRunner } from '/src/voice/gevActions.js';
import { getActiveCameraMotion } from '/src/cameraVerbs.js';
import { GLOBE_VIEW } from '/src/locations.js';
window.CESIUM_BASE_URL = '/node_modules/cesium/Build/Cesium/';
const viewer = new Cesium.Viewer('map', {
  baseLayer: false, geocoder: false, animation: false, timeline: false,
  baseLayerPicker: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, fullscreenButton: false, skyBox: false,
  skyAtmosphere: false, infoBox: false, selectionIndicator: false,
});
const setHeight = (height) => viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0,15,height),
  orientation: { heading:0, pitch:-Math.PI/2, roll:0 },
});
setHeight(GLOBE_VIEW.heightM);
let failReset = false;
const calls = [], posts = [], results = [];
const runner = createGevActionRunner({ viewer, dataManager:{layers:new Map()}, styleManager:{
  runImmediateNavigation: (_noun,navigate) => navigate(),
  resetToGlobeView: () => {
    if (failReset) return {ok:false,action:'zoom_to_globe'};
    setHeight(GLOBE_VIEW.heightM); return {ok:true,action:'zoom_to_globe'};
  },
}});
const spin = (args={}) => ({name:'move_camera',args:{motion:'rotate_globe',...args}});
const plans = {
  'Rotate the globe': [spin()],
  'Rotate left slowly': [spin({direction:'left',speed:'slow'})],
  'Rotate left fast': [spin({direction:'left',speed:'fast'})],
  'Stop moving the camera': [{name:'move_camera',args:{motion:'stop'}}],
  'Zoom out': [{name:'adjust_camera_zoom',args:{direction:'out',amount:'little'}}],
  'Try rotation and reset': [spin(),{name:'zoom_to_globe',args:{}},spin()],
  'Reset and rotate': [{name:'zoom_to_globe',args:{}},spin()],
};
let id=0;
const fetchImpl = async (url,init={}) => {
  if (url==='/api/agent/config') return Response.json({providers:[{id:'chatgpt',authType:'oauth',label:'Fixture ChatGPT',configured:true}],defaultProvider:'chatgpt'});
  if (url==='/api/agent/chatgpt/status') return Response.json({configured:true,active:'fixture-account',binding:'fixture',accounts:[{id:'fixture-account',label:'Fixture account',signedIn:true}]});
  if (url.startsWith('/api/agent/models')) return Response.json({binding:'fixture',models:[{id:'fixture',label:'Scripted responses'}]});
  if (url!=='/api/agent/command') throw Error('Unexpected request '+url);
  const body=JSON.parse(init.body); posts.push(body);
  if(body.messages.at(-1).role==='user') {
    const toolCalls=plans[body.messages.at(-1).content].map(c=>({...c,id:'call-'+(++id)}));
    return Response.json({message:{role:'assistant',content:'Camera already moved!',tool_calls:toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},toolCalls});
  }
  const last=JSON.parse(body.messages.at(-1).content);
  return Response.json({message:{role:'assistant',content:JSON.stringify({ok:last.ok,motion:last.motion,direction:last.direction,speed:last.speed,stopped:last.stopped})},toolCalls:[]});
};
const consoleController=mountAgentConsole({fetchImpl,runAction:async(...args)=>{
  calls.push(args[0]); const result=await runner(...args); results.push(result); return result;
}});
consoleController.open();
window.qa={viewer,consoleController,calls,posts,results,setHeight,
  failReset:()=>{failReset=true;},
  motion:()=>getActiveCameraMotion(),
  pose:()=>[viewer.camera.positionWC.x,viewer.camera.positionWC.y,viewer.camera.positionWC.z],
};
</script></body></html>`;
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'camera-fixture',
      configureServer(server) {
        server.middlewares.use('/__qa_camera.html', async (req, res, next) => {
          if (req.url.includes('html-proxy')) return next();
          res.setHeader('Content-Type', 'text/html');
          res.end(await server.transformIndexHtml('/__qa_camera.html', html));
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await puppeteer.launch({
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('PAGE:', error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('BROWSER:', message.text());
  });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/__qa_camera.html`,
  );
  await page
    .waitForFunction(
      () =>
        window.qa && document.querySelector('#agent-model').value === 'fixture',
      { timeout: 20000 },
    )
    .catch(async (error) => {
      console.error(
        await page.evaluate(() => ({
          qa: !!window.qa,
          model: document.querySelector('#agent-model')?.outerHTML,
          text: document.body.innerText.slice(-2000),
          scripts: [...document.scripts].map(
            (s) => s.src || s.text.slice(0, 100),
          ),
        })),
      );
      throw error;
    });
  const send = async (text) => {
    await page.type('#agent-input', text);
    await page.click('#agent-send');
    await page.waitForFunction(() => !window.qa.consoleController.session.busy);
  };
  const pose = () => page.evaluate(() => window.qa.pose());
  const moved = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  const waitMotion = () => new Promise((resolve) => setTimeout(resolve, 180));
  await send('Rotate the globe');
  const before = await pose();
  await page.waitForFunction(
    (start) => Math.hypot(...window.qa.pose().map((v, i) => v - start[i])) > 1,
    { timeout: 10000 },
    before,
  );
  assert.ok(moved(before, await pose()) > 1);
  await send('Rotate left slowly');
  assert.equal(
    await page.evaluate(() => window.qa.results.at(-1).direction),
    'left',
  );
  await send('Rotate left fast');
  assert.equal(
    await page.evaluate(() => window.qa.results.at(-1).speed),
    'fast',
  );
  await send('Stop moving the camera');
  const stopped = await pose();
  await waitMotion();
  assert.ok(moved(stopped, await pose()) < 0.001);
  await send('Rotate the globe');
  await send('Zoom out');
  assert.equal(await page.evaluate(() => window.qa.motion()), null);
  await page.evaluate(() => window.qa.setHeight(1000));
  const close = await pose();
  const counts = await page.evaluate(() => [
    window.qa.posts.length,
    window.qa.calls.length,
  ]);
  await send('Try rotation and reset');
  assert.deepEqual(
    await page.evaluate(() => [window.qa.posts.length, window.qa.calls.length]),
    [counts[0] + 1, counts[1] + 1],
  );
  assert.ok(moved(close, await pose()) < 0.001);
  assert.match(
    await page.evaluate(
      () => window.qa.consoleController.session.transcript.at(-1).content,
    ),
    /isn’t available/,
  );
  await send('Reset and rotate');
  assert.equal(await page.evaluate(() => window.qa.results.at(-1).ok), true);
  await send('Stop moving the camera');
  await page.evaluate(() => window.qa.failReset());
  await send('Reset and rotate');
  assert.equal(await page.evaluate(() => window.qa.motion()), null);
  assert.match(
    await page.evaluate(
      () => window.qa.consoleController.session.transcript.at(-1).content,
    ),
    /reset did not finish/,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real console + rendered Cesium camera; rotation, direction/speed, explicit stop, navigation, refusal, fresh reset and failed-reset guard. Scripted model replies; no live inference.',
  );
} finally {
  await browser?.close();
  await server.close();
}
