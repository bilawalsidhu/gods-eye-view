import test from 'node:test';
import assert from 'node:assert/strict';
import {discoveryShellPlugin} from '../../build/discovery-shell.js';
import {panelBuildConfig} from '../../build/panel.js';
test('discovery strips globe dependencies while other pages retain their SDK',()=>{
 const html='<head><link rel="stylesheet" href="/cesium/Widgets/widgets.css"><script src="/cesium/Cesium.js"></script><script type="module" src="/assets/discovery.js"></script></head>';
 const transform=discoveryShellPlugin().transformIndexHtml.handler;
 assert.doesNotMatch(transform(html,{path:'/discovery.html'}),/cesium/);
 assert.match(transform(html,{path:'/discovery.html'}),/assets\/discovery/);
 assert.equal(transform(html,{path:'/index.html'}),html);
});
test('panel keeps one inline document even when the standalone build has two entries',()=>{
 const result=panelBuildConfig({build:{rollupOptions:{input:{globe:'index.html',discovery:'discovery.html'}}}});
 assert.equal(result.build.rollupOptions.input,'index.html');
 assert.equal(result.build.rollupOptions.output.inlineDynamicImports,true);
});
