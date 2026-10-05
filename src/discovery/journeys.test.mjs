import test from 'node:test';
import assert from 'node:assert/strict';
import {starterPack} from './starterPack.js';
import {JOURNEYS,quizForCard,journeyProgressKey,createJourneyProgress} from './journeys.js';
import {exportDiscoveryFile} from './storage.js';
import {webcrypto} from 'node:crypto';
test('journeys reference installed public cards and keep all coordinate bodies',()=>{
 for(const journey of JOURNEYS)for(const id of journey.steps)assert.ok(starterPack.cards.find(card=>card.id===id));
 const bodies=JOURNEYS.find(journey=>journey.id==='other-worlds').steps.map(id=>starterPack.cards.find(card=>card.id===id).body);
 assert.deepEqual(bodies,['moon','moon','mars','mars']);
});
test('every quiz answer is grounded in a current card field, with unique options',()=>{
 for(const card of starterPack.cards){const quiz=quizForCard(card);assert.ok(quiz);assert.equal(new Set(quiz.choices).size,3);assert.equal(quiz.choices[quiz.correctIndex],quiz.answer);assert.match(quiz.sourceUrl,new RegExp(`oldid=${card.provenance.revision}`));if(quiz.property==='P2048')assert.equal(quiz.answer,card.facts.find(fact=>fact.property==='P2048').value);if(quiz.property==='P625')assert.equal(quiz.answer,card.body);}
});
test('vehicle-family quizzes do not convert a representative height into individual identification',()=>{
 const card=starterPack.cards.find(card=>card.id==='Q6475');const quiz=quizForCard(card);
 assert.equal(quiz.property,'source');assert.equal(quiz.answer,'Wikidata');
});
test('progress is invalidated by a changed revision or changed source answer',()=>{
 const card=starterPack.cards.find(card=>card.id==='Q243');const quiz=quizForCard(card);const key=journeyProgressKey('monuments',card,quiz);
 const updated=structuredClone(card);updated.provenance.revision++;
 assert.notEqual(journeyProgressKey('monuments',updated,quizForCard(updated)),key);
 updated.provenance.revision=card.provenance.revision;updated.facts.find(fact=>fact.property==='P2048').value='999 m';
 assert.notEqual(journeyProgressKey('monuments',updated,quizForCard(updated)),key);
 assert.equal(quizForCard(undefined),null);
});
test('local study state survives reload but never enters public pack export',async()=>{
 const memory=new Map();const storage={getItem:key=>memory.get(key),setItem:(key,value)=>memory.set(key,value),removeItem:key=>memory.delete(key)};
 const card=starterPack.cards.find(card=>card.id==='Q243'),quiz=quizForCard(card),key=journeyProgressKey('monuments',card,quiz);
 const progress=createJourneyProgress(storage);progress.record(key,quiz.correctIndex,true);
 assert.deepEqual(createJourneyProgress(storage).get(key),{choice:quiz.correctIndex,correct:true});
 assert.ok(memory.has('gods-eye-view.discovery.learning.v1'));
 const file=await exportDiscoveryFile(starterPack,webcrypto);assert.doesNotMatch(JSON.stringify(file),/learning|choice|correct/);
 progress.clear();assert.equal(progress.get(key),null);
});
test('malformed study state and unsupported lessons are rejected safely',()=>{
 const progress=createJourneyProgress({getItem:()=>'{bad',setItem(){},removeItem(){}});
 assert.equal(progress.get('unknown'),null);assert.throws(()=>progress.record('__proto__',0,true));
 assert.throws(()=>journeyProgressKey('private-case',starterPack.cards[0],quizForCard(starterPack.cards[0])));
});
