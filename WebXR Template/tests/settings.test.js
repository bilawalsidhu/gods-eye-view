import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettings,labelFor,SETTINGS,STORAGE_KEY} from '../src/settings.js';

const fakeStorage=(initial={})=>{const data=new Map(Object.entries(initial));return {getItem:key=>data.has(key)?data.get(key):null,setItem:(key,value)=>data.set(key,value),data}};

test('controller hands default off and read a stored preference back',()=>{
 assert.equal(createSettings({storage:undefined}).get('controllerVisual'),'controller');
 const stored=fakeStorage({[STORAGE_KEY]:JSON.stringify({controllerVisual:'hand'})});
 assert.equal(createSettings({storage:stored}).get('controllerVisual'),'hand');
});
test('storage is untrusted: unknown values, wrong types and malformed JSON fall back to defaults',()=>{
 for(const raw of [JSON.stringify({controllerVisual:'hands'}),JSON.stringify({controllerVisual:42}),'{not json','42','null',JSON.stringify([1,2])]){
  assert.equal(createSettings({storage:fakeStorage({[STORAGE_KEY]:raw})}).get('controllerVisual'),'controller',raw);
 }
 const throwing={getItem(){throw new Error('blocked')},setItem(){throw new Error('blocked')}};
 const settings=createSettings({storage:throwing});
 assert.equal(settings.set('controllerVisual','hand'),true,'a storage that throws still changes the live value');
 assert.equal(settings.get('controllerVisual'),'hand');
});
test('set persists only known keys, ignores no-ops and invalid values, and toggle cycles',()=>{
 const storage=fakeStorage(),settings=createSettings({storage});
 assert.equal(settings.set('controllerVisual','controller'),false,'same value is not a change');
 assert.equal(settings.set('controllerVisual','bogus'),false);
 assert.equal(settings.get('controllerVisual'),'controller');
 assert.equal(settings.toggle('controllerVisual'),'hand');
 assert.deepEqual(JSON.parse(storage.data.get(STORAGE_KEY)),{controllerVisual:'hand',renderQuality:'balanced',microgestures:'on'});
 assert.equal(settings.toggle('controllerVisual'),'controller');
 assert.throws(()=>settings.set('nope','x'),/Unknown setting/);
 assert.deepEqual(settings.snapshot(),{controllerVisual:'controller',renderQuality:'balanced',microgestures:'on'});
 assert.equal(settings.toggle('renderQuality'),'smooth');assert.equal(settings.toggle('renderQuality'),'sharp','quality cycles sharp, balanced, smooth');
});
test('subscribers hear each real change once and can unsubscribe',()=>{
 const settings=createSettings({storage:undefined}),heard=[];
 const off=settings.subscribe((name,value,snapshot)=>heard.push([name,value,snapshot.controllerVisual]));
 settings.set('controllerVisual','hand');settings.set('controllerVisual','hand');settings.set('controllerVisual','bogus');
 assert.deepEqual(heard,[['controllerVisual','hand','hand']]);
 off();settings.toggle('controllerVisual');assert.equal(heard.length,1);
});
test('labels read the same on the board and in the bench',()=>{
 assert.equal(labelFor('controllerVisual','hand'),'Controller hands: on');
 assert.equal(labelFor('controllerVisual','controller'),'Controller hands: off');
 assert.throws(()=>labelFor('nope','x'),/Unknown setting/);
 for(const name in SETTINGS)assert.ok(SETTINGS[name].values.includes(SETTINGS[name].default),`${name} default is one of its values`);
});
