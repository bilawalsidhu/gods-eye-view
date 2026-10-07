import test from 'node:test';
import assert from 'node:assert/strict';
import { createAreaScienceSource, soilPercentage, soilPointUrl, historicalFrameUrl } from './areaScience.js';
import { appendLedgerEvent } from '../demonForge/ledger.js';
import { appendInvestigationEntry, encryptInvestigationBackup, decryptInvestigationBackup } from '../demonForge/areaInvestigation.js';
import { webcrypto } from 'node:crypto';
const now = () => Date.parse('2026-10-05T12:00:00Z');
const area = {lat:45,lon:3,radius_km:10};
const reply = value => ({ok:true,text:async()=>JSON.stringify(value)});
const item = (year,cloud=5) => ({id:`LT05_L2SP_199026_${year}0720_02_T1`,bbox:[-20,20,20,60],properties:{datetime:`${year}-07-20T10:00:00Z`,'eo:cloud_cover':cloud,platform:'landsat-5'}});

test('soil units and parameter choices are validated without invented percentages',()=>{
 assert.equal(soilPercentage(376),37.6);
 assert.equal(soilPercentage(-9999),null);
 assert.equal(soilPercentage(null),null);
 assert.throws(()=>soilPointUrl(area,'gold','0-5cm','mean'));
 const url=new URL(soilPointUrl(area,'sand','0-5cm','mean'));
 assert.equal(url.searchParams.get('CRS'),'EPSG:3857');
 assert.equal(url.searchParams.get('QUERY_LAYERS'),'sand_0-5cm_mean');
});
test('soil queries retain each independent quantile and do not force 100 percent',async()=>{
 const urls=[];
 const source=createAreaScienceSource({now,fetchImpl:async url=>{urls.push(url); const layer=new URL(url).searchParams.get('LAYERS');const value=layer.endsWith('Q0.05')?100:layer.endsWith('Q0.95')?700:400;return reply({features:[{properties:{unit:'g/kg',pixel_value:value}}]});}});
 const result=await source.soil({...area,privateNotes:'PRIVATE'});
 assert.equal(urls.length,9);
 assert.ok(urls.every(url=>!url.includes('PRIVATE')));
 assert.equal(result.rows[0].mean_percent,40);
 assert.equal(result.rows[0].lower_percent,10);
 assert.equal(result.rows[0].upper_percent,70);
 assert.equal(result.sum_percent,120);
 await assert.rejects(source.soil(area),/COOLDOWN/);
});
test('missing soil cells and service failures remain unavailable, not zero',async()=>{
 const source=createAreaScienceSource({now,fetchImpl:async()=>reply({features:[]})});
 const result=await source.soil(area);
 assert.equal(result.status,'unavailable');assert.equal(result.rows[0].mean_percent,null);
});
test('historical series keeps gaps, acquisition dates and bounded geographic queries',async()=>{
 const urls=[];
 const source=createAreaScienceSource({now,fetchImpl:async url=>{urls.push(url);const year=Number(new URL(url).searchParams.get('datetime').slice(0,4));return reply({features:year===1995?[]:[item(year,60),item(year,5)]});}});
 const result=await source.history({...area,title:'PRIVATE'},{startYear:1990,endYear:2000,stepYears:5,maxCloud:30});
 assert.deepEqual(result.rows.map(row=>row.status),['available','missing','available']);
 assert.equal(result.rows[0].cloud_percent,5);assert.match(result.rows[0].observed_at,/1990/);
 assert.equal(urls.length,3);assert.ok(urls.every(url=>!url.includes('PRIVATE')));
 const url=new URL(historicalFrameUrl(result.rows[0],result.bbox));assert.equal(url.hostname,'planetarycomputer.microsoft.com');assert.match(url.pathname,/bbox/);
 assert.throws(()=>historicalFrameUrl({id:'https://host.invalid'},result.bbox));
});
test('future dates, oversized ranges and antimeridian areas are refused',async()=>{
 const source=createAreaScienceSource({now,fetchImpl:async()=>{throw new Error('Should not fetch.');}});
 await assert.rejects(source.history(area,{endYear:2027}));
 await assert.rejects(source.history({...area,lon:180}));
 await assert.rejects(source.history(area,{stepYears:0}));
});
test('current-year queries stop at the current date and cancellation discards late metadata',async()=>{
 const controller=new AbortController();let target;
 const source=createAreaScienceSource({now,fetchImpl:async url=>{target=url;controller.abort();return reply({features:[item(2026)]});}});
 await assert.rejects(source.history(area,{startYear:2026,endYear:2026,signal:controller.signal}),/abort/i);
 assert.match(new URL(target).searchParams.get('datetime'),/2026-10-05/);
});
test('science provenance survives authenticated case backup/restore',async()=>{
 const source=createAreaScienceSource({now,fetchImpl:async()=>reply({features:[item(1990)]})});
 const snapshot=await source.history(area,{startYear:1990,endYear:1990});
 const base={id:'synthetic',kind:'area-investigation',area,workflow:[],ledger:appendLedgerEvent([],{type:'AREA_CASE_CREATED',actor:'operator',payload:{area}},now())};
 const record=appendInvestigationEntry(base,{kind:'observation',text:snapshot.summary,snapshot},now());
 const backup=await encryptInvestigationBackup(record,'synthetic passphrase',webcrypto);
 const restored=await decryptInvestigationBackup(JSON.stringify(backup),'synthetic passphrase',webcrypto);
 assert.equal(restored.workflow[0].snapshot.sourceId,'history');
});
