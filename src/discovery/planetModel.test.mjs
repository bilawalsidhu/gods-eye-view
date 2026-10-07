import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {starterPack} from './starterPack.js';
import {PLANETS,longitudeEast,planetPoint,cameraBasis,projectPlanetPoint,pickPlanetPoint,planetViewUrl} from './planetModel.js';
import {discoveryShellPlugin} from '../../build/discovery-shell.js';
test('body coordinates normalize east longitude without applying terrestrial defaults',()=>{
 assert.equal(longitudeEast(226.2),-133.8);assert.equal(longitudeEast(360),0);
 const mars=starterPack.cards.find(card=>card.id==='Q520');const point=planetPoint(mars,'mars');assert.ok(Math.abs(point.lon+133.8)<1e-9);
 assert.throws(()=>planetPoint(mars,'moon'));assert.throws(()=>planetPoint(starterPack.cards[0],'moon'));
 assert.equal(PLANETS.moon.radiusKm,1737.4);assert.equal(PLANETS.mars.radiusKm,3389.5);
});
test('orthographic projection/picking roundtrips body points and hides the far side',()=>{
 const center={lat:18.65,lon:-133.8},viewport={width:1000,height:700,zoom:.85};
 const p=projectPlanetPoint(center,center,viewport);assert.ok(p.visible);assert.ok(Math.abs(p.x-500)<1e-8&&Math.abs(p.y-350)<1e-8);
 const restored=pickPlanetPoint(p.x,p.y,center,viewport);assert.ok(Math.abs(restored.lat-center.lat)<1e-8);assert.ok(Math.abs(restored.lon-center.lon)<1e-8);
 assert.equal(projectPlanetPoint({lat:-center.lat,lon:center.lon+180},center,viewport).visible,false);
 assert.equal(pickPlanetPoint(0,0,center,viewport),null);
 const basis=cameraBasis(center);for(const vector of Object.values(basis))assert.ok(Math.abs(vector.reduce((sum,value)=>sum+value*value,0)-1)<1e-10);
});
test('planetary URLs only select source sites on supported non-Earth bodies',()=>{
 const moon=starterPack.cards.find(card=>card.body==='moon');assert.match(planetViewUrl(moon),/^\/planet.html\?body=moon&site=Q\d+$/);
 assert.throws(()=>planetViewUrl(starterPack.cards[0]));
});
test('independent planetary page does not acquire the terrestrial SDK',()=>{
 const html='<head><script src="/cesium/Cesium.js"></script><link href="/cesium/Widgets/widgets.css"><script src="/assets/planet.js"></script></head>';
 const result=discoveryShellPlugin().transformIndexHtml.handler(html,{path:'/planet.html'});assert.doesNotMatch(result,/cesium/);assert.match(result,/planet.js/);
});
test('bundled texture bytes match source manifest hashes and the small offline budget',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../../public/planetary/manifest.json',import.meta.url),'utf8'));
 let bytes=0;for(const asset of manifest.assets){const data=await readFile(new URL(`../../public${asset.path}`,import.meta.url));assert.equal(data.length,asset.bytes);assert.equal(createHash('sha256').update(data).digest('hex'),asset.sha256);assert.equal(asset.width/asset.height,2);bytes+=asset.bytes;}
 assert.ok(bytes<2*1024*1024);
});
