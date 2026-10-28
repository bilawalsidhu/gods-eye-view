#!/usr/bin/env node
// Shipped console, voice panel, provider dialog and runner; scripted inference.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';
const template = await fs.readFile(
  'src/ui/templates/agent-console.html',
  'utf8',
);
const providers = await fs.readFile(
  'src/ui/templates/provider-settings.html',
  'utf8',
);
const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body>${template}${providers}<script type="module">
import {mountAgentConsole} from '/src/agent/agentConsole.js';
import {initGevVoiceCommands} from '/src/voice/gevRealtime.js';
import {initKeySetup} from '/src/keySetup.js';
let active=false, delayed=false, release, starts=0;
const commands=initGevVoiceCommands({panel:true,
 viewer:{clock:{onTick:{addEventListener:()=>()=>{}}},scene:{canvas:{addEventListener(){},removeEventListener(){}}},camera:{moveEnd:{addEventListener(){}}}},
 dataManager:{layers:new Map(),getAll:()=>[]},
 styleManager:{getCockpitState:()=>({active}),controlCockpit(){active=false;document.body.classList.remove('cockpit-mode');window.dispatchEvent(new Event('gev:cockpit-mode-changed'));return delayed?new Promise(r=>release=()=>r({ok:true})):{ok:true};}},
 createSession:({runner})=>({controller:{runner},capabilities:{},start(){starts++;},stop(){},sendText(){return false},sendMapEvent(){},bindControls(){}})
});
await initKeySetup({fetchImpl:async()=>Response.json({setCount:0,total:1,keys:[]})});
const panel=(panelId,open=true)=>({name:'set_panel_open',args:{panelId,open}});
const plans={
 'Open Voice Preview':[panel('voice-preview')], 'Close Voice Preview':[panel('voice-preview',false)],
 'Open Voice Settings':[panel('voice-settings')], 'Close Voice Settings':[panel('voice-settings',false)],
 'Open Provider Settings':[panel('provider-settings')], 'Close Provider Settings':[panel('provider-settings',false)],
 'Set timeout to 7':[{name:'set_voice_inactivity_timeout',args:{minutes:7}}],
 'Disable timeout':[{name:'set_voice_inactivity_timeout',args:{minutes:0}}],
 'Invalid timeout':[{name:'set_voice_inactivity_timeout',args:{minutes:61}}],
 'Exit then open':[panel('voice-settings'),{name:'set_voice_inactivity_timeout',args:{minutes:1}}],
};
const results=[],posts=[];let id=0;
const fetchImpl=async(url,init={})=>{
 if(url==='/api/agent/config')return Response.json({providers:[{id:'chatgpt',authType:'oauth',label:'Fixture',configured:true}],defaultProvider:'chatgpt'});
 if(url==='/api/agent/chatgpt/status')return Response.json({configured:true,active:'fixture',binding:'fixture',accounts:[{id:'fixture',label:'Fixture',signedIn:true}]});
 if(url.startsWith('/api/agent/models'))return Response.json({binding:'fixture',models:[{id:'fixture',label:'Scripted'}]});
 const body=JSON.parse(init.body);posts.push(body);
 if(body.messages.at(-1).role==='user'){
  const text=body.messages.at(-1).content;
  if(text==='Open settings')return Response.json({message:{role:'assistant',content:'Voice settings or Provider settings?'},toolCalls:[]});
  const toolCalls=plans[text].map(c=>({...c,id:'c'+(++id)}));
  return Response.json({message:{role:'assistant',content:'Settings already changed!',tool_calls:toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},toolCalls});
 }
 const last=JSON.parse(body.messages.at(-1).content);
 return Response.json({message:{role:'assistant',content:last.ok?last.say:'Settings already changed!'},toolCalls:[]});
};
const consoleController=mountAgentConsole({fetchImpl,runAction:async(...args)=>{const result=await commands.runner(...args);results.push(result);return result;}});
consoleController.open();
window.qa={commands,consoleController,results,posts,starts:()=>starts,
 cockpit(delay=false){active=true;delayed=delay;document.body.classList.add('cockpit-mode');},
 pending:()=>!!release,release:()=>{release?.();release=null;delayed=false;},
};
</script></body></html>`;
const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'voice-panel-fixture',
      configureServer(server) {
        server.middlewares.use(
          '/__qa_voice_panel.html',
          async (req, res, next) => {
            if (req.url.includes('html-proxy')) return next();
            res.setHeader('Content-Type', 'text/html');
            res.end(
              await server.transformIndexHtml('/__qa_voice_panel.html', html),
            );
          },
        );
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
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.error(e.message);
  });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 800, height: 800 },
  ]) {
    await page.setViewport(viewport);
    await page.goto(
      'http://127.0.0.1:' +
        server.httpServer.address().port +
        '/__qa_voice_panel.html',
    );
    await page.waitForFunction(
      () =>
        window.qa && document.querySelector('#agent-model').value === 'fixture',
    );
    const send = async (text) => {
      await page.$eval('#agent-input', (e) => (e.value = ''));
      await page.type('#agent-input', text);
      await page.$eval('#agent-form', (e) => e.requestSubmit());
      await page.waitForFunction(
        () => !window.qa.consoleController.session.busy,
      );
    };
    for (const name of [
      'Voice Preview',
      'Voice Settings',
      'Provider Settings',
    ]) {
      await send('Open ' + name);
      assert.equal(
        await page.evaluate(() => window.qa.results.at(-1).ok),
        true,
      );
      const selector =
        name === 'Provider Settings' ? '#key-setup' : '#gev-voice-panel';
      assert.equal(await page.$eval(selector, (e) => !e.hidden), true);
      await send('Close ' + name);
      assert.equal(
        await page.evaluate(() => window.qa.results.at(-1).ok),
        true,
      );
    }
    const n = await page.evaluate(() => window.qa.results.length);
    await send('Open settings');
    assert.equal(await page.evaluate(() => window.qa.results.length), n);
    assert.match(
      await page.$eval('#agent-transcript', (e) => e.textContent),
      /Voice settings or Provider settings/,
    );
    await send('Set timeout to 7');
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('godsEyeView.voice.inactivityMinutes'),
      ),
      '7',
    );
    await send('Disable timeout');
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('godsEyeView.voice.inactivityMinutes'),
      ),
      'none',
    );
    await send('Invalid timeout');
    assert.equal(await page.evaluate(() => window.qa.results.at(-1).ok), false);
    assert.doesNotMatch(
      await page.$eval('#agent-transcript', (e) => e.textContent),
      /Settings already changed!/,
    );
    await send('Open Voice Settings');
    await page.click('#gev-voice-preview-enabled');
    assert.equal(
      await page.evaluate(() =>
        localStorage.getItem('godsEyeView.voice.previewEnabled'),
      ),
      'false',
    );
    await page.focus('#gev-voice-settings-tab');
    await page.keyboard.press('Home');
    assert.equal(
      await page.evaluate(() => window.qa.commands.voicePanel.snapshot().view),
      'preview',
    );
    await page.keyboard.press('End');
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.voicePanel.snapshot().settingsOpen,
      ),
      true,
    );
    await page.keyboard.press('Escape');
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.voicePanel.snapshot().panelOpen,
      ),
      false,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      'gev-voice-settings-button',
    );
    assert.equal(await page.$eval('#agent-console', (e) => e.open), true);
    await page.evaluate(() => window.qa.cockpit());
    await send('Open Voice Preview');
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.voicePanel.snapshot().panelOpen,
      ),
      true,
    );
    assert.equal(
      await page.evaluate(() =>
        document.body.classList.contains('cockpit-mode'),
      ),
      false,
    );
    await page.evaluate(() => window.qa.cockpit());
    await send('Open Provider Settings');
    assert.equal(await page.evaluate(() => window.qa.results.at(-1).ok), false);
    await page.evaluate(() => {
      document.body.classList.remove('cockpit-mode');
      window.qa.commands.voicePanel.close();
      window.qa.cockpit(true);
    });
    await page.type('#agent-input', 'Exit then open');
    await page.$eval('#agent-form', (e) => e.requestSubmit());
    await page.waitForFunction(() => window.qa.pending());
    await page.$eval('#agent-stop', (e) => e.click());
    await page.evaluate(() => window.qa.release());
    await page.waitForFunction(() => !window.qa.consoleController.session.busy);
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.voicePanel.snapshot().panelOpen,
      ),
      false,
    );
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.getVoicePreferences().minutes,
      ),
      0,
    );
    assert.equal(await page.evaluate(() => window.qa.starts()), 0);
    const history = await page.evaluate(
      () => window.qa.consoleController.session.transcript.length,
    );
    await page.evaluate(() => window.qa.commands.session.destroy());
    assert.equal(
      await page.evaluate(
        () => window.qa.consoleController.session.transcript.length,
      ),
      history,
    );
    await send('Open Voice Settings');
    assert.equal(await page.evaluate(() => window.qa.results.at(-1).ok), false);
    await page.reload();
    await page.waitForFunction(() => window.qa);
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.getVoicePreferences().minutes,
      ),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => window.qa.commands.getVoicePreferences().previewEnabled,
      ),
      false,
    );
    console.log(
      'PASS voice panel + typed console ' +
        viewport.width +
        'x' +
        viewport.height,
    );
    await page.evaluate(() => localStorage.clear());
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
}
