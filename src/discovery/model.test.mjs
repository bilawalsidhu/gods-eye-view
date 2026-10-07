import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {starterPack} from './starterPack.js';
import {cardFromEntity,searchDiscovery,validateDiscoveryPack,createNearbyKnowledgeSource,safeDiscoveryLink} from './model.js';
import {createDiscoveryStorage,exportDiscoveryFile,importDiscoveryFile} from './storage.js';
const fixture=(id='Q243')=>({id,lastrevid:123,labels:{en:{value:'Synthetic monument'},fr:{value:'Monument synthétique'}},descriptions:{en:{value:'Synthetic public place'}},claims:{P625:[{rank:'normal',mainsnak:{snaktype:'value',datavalue:{value:{latitude:48.85,longitude:2.3,globe:'http://www.wikidata.org/entity/Q2'}}}}]},sitelinks:{enwiki:{title:'Synthetic monument'}}});
test('starter is a small body-aware CC0 library with pinned revisions',()=>{
 const pack=validateDiscoveryPack(starterPack);
 assert.equal(pack.cards.length,15);
 assert.equal(pack.cards.filter(card=>card.body==='moon').length,2);
 assert.equal(pack.cards.filter(card=>card.body==='mars').length,2);
 assert.ok(pack.cards.every(card=>card.provenance.revision>0));
 assert.match(pack.selection,/Not a global ranking/);
});
test('local names, accents, IDs and body-specific proximity require no fetch',()=>{
 assert.equal(searchDiscovery(starterPack.cards,{query:'Colisee'})[0].card.id,'Q10285');
 assert.equal(searchDiscovery(starterPack.cards,{query:'Q243'})[0].card.id,'Q243');
 const nearby=searchDiscovery(starterPack.cards,{center:{lat:48.8583,lon:2.2945},radiusKm:1});
 assert.equal(nearby.length,1);assert.equal(nearby[0].card.id,'Q243');
 assert.equal(searchDiscovery(starterPack.cards,{body:'moon',query:'Tycho'})[0].card.body,'moon');
 assert.equal(searchDiscovery(starterPack.cards,{body:'earth',query:'Olympus'}).length,0);
});
test('entity normalization rejects humans and wrong celestial bodies',()=>{
 const human=fixture();human.claims.P31=[{mainsnak:{snaktype:'value',datavalue:{value:{id:'Q5'}}}}];
 assert.equal(cardFromEntity(human),null);
 assert.equal(cardFromEntity(fixture(),{body:'moon'}),null);
 assert.equal(cardFromEntity({...fixture(),id:'javascript:alert(1)'}),null);
});
test('source years preserve BCE signs and preferred statements',()=>{
 const entity=fixture();entity.claims.P571=[{rank:'normal',mainsnak:{snaktype:'value',datavalue:{value:{time:'-2560-00-00T00:00:00Z',precision:9}}}}];
 assert.equal(cardFromEntity(entity).facts[0].value,'-2560');
 entity.claims.P571.push({rank:'preferred',mainsnak:{snaktype:'value',datavalue:{value:{time:'+000000001990-00-00T00:00:00Z',precision:9}}}});
 assert.equal(cardFromEntity(entity).facts[0].value,'1990');
});
test('pack links and coordinates are checked and private workflow fields are discarded',()=>{
 const pack=structuredClone(starterPack);pack.cards[0].privateCase={passphrase:'PRIVATE'};
 assert.doesNotMatch(JSON.stringify(validateDiscoveryPack(pack)),/PRIVATE/);
 pack.cards[0].coordinate.globe='http://www.wikidata.org/entity/Q405';assert.throws(()=>validateDiscoveryPack(pack));
 assert.equal(safeDiscoveryLink('javascript:alert(1)'),null);assert.equal(safeDiscoveryLink('https://user:secret@example.test/'),null);assert.equal(safeDiscoveryLink('https://127.0.0.1/'),null);
});
test('public pack export/import detects corruption and refuses private case formats',async()=>{
 const file=await exportDiscoveryFile(starterPack,webcrypto);
 assert.equal((await importDiscoveryFile(JSON.stringify(file),webcrypto)).cards.length,15);
 file.payload.cards[0].labels.en='changed';await assert.rejects(importDiscoveryFile(JSON.stringify(file),webcrypto),/checksum/);
 await assert.rejects(importDiscoveryFile(JSON.stringify({kind:'area-investigation'}),webcrypto));
});
test('public storage is independent and malformed cached libraries fail closed',()=>{
 const map=new Map();const storage=createDiscoveryStorage({getItem:key=>map.get(key),setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)});
 storage.save(starterPack);assert.equal(storage.load().cards.length,15);storage.clear();assert.equal(storage.load(),null);
});
test('a host denying localStorage cannot prevent the public library from starting',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('SecurityError');}});
 try {const storage=createDiscoveryStorage();assert.equal(storage.load(),null);storage.clear();assert.throws(()=>storage.save(starterPack),/unavailable/);}
 finally {if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete globalThis.localStorage;}
});
test('geographic web lookup is bounded, preserves source IDs and excludes biographies',async()=>{
 const calls=[];const person=fixture('Q42');person.claims.P31=[{mainsnak:{snaktype:'value',datavalue:{value:{id:'Q5'}}}}];
 const source=createNearbyKnowledgeSource({now:()=> '2026-10-05',fetchImpl:async url=>{calls.push(url);return {ok:true,text:async()=>JSON.stringify(calls.length===1?{query:{pages:{1:{pageprops:{wikibase_item:'Q243'}},2:{pageprops:{wikibase_item:'Q42'}}}}}:{entities:{Q243:fixture(),Q42:person}})};}});
 const result=await source.nearby({lat:48.85,lon:2.3,radiusKm:1,title:'PRIVATE'});
 assert.equal(calls.length,2);assert.equal(result.length,1);assert.equal(result[0].id,'Q243');assert.ok(calls.every(url=>!url.includes('PRIVATE')));
});
test('cancelled web lookup cannot return late cards',async()=>{
 const controller=new AbortController();const source=createNearbyKnowledgeSource({fetchImpl:async()=>{controller.abort();return{ok:true,text:async()=>JSON.stringify({query:{pages:{}}})};}});
 await assert.rejects(source.nearby({lat:48,lon:2},{signal:controller.signal}),/abort/i);
});
