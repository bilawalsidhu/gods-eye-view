import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { appendLedgerEvent } from './ledger.js';
import { validateInvestigationArea, queryInvestigationArea, appendInvestigationEntry, encryptInvestigationBackup, decryptInvestigationBackup } from './areaInvestigation.js';
import { createFranceEuDraft } from './requestStudio.js';
const area = {lat:30,lon:-97,radius_km:10};
const base = () => ({id:'synthetic-case',kind:'area-investigation',area,workflow:[],ledger:appendLedgerEvent([],{type:'AREA_CASE_CREATED',actor:'operator',payload:{area}},100)});

test('invalid or unbounded areas and unsupported sources cannot query',async()=>{
  assert.throws(()=>validateInvestigationArea({...area,radius_km:101}));
  assert.throws(()=>validateInvestigationArea({...area,lat:NaN}));
  let calls=0;
  await assert.rejects(queryInvestigationArea({catalog:{call(){calls++;}},area,sourceIds:['people']}));
  assert.equal(calls,0);
});
test('only area parameters leave the case; partial failures preserve source coverage',async()=>{
  const calls=[];
  const results=await queryInvestigationArea({area:{...area,title:'PRIVATE',notes:'PRIVATE'},sourceIds:['dams','earthquakes'],now:()=>200,catalog:{async call(name,args){calls.push({name,args});if(name==='get_earthquakes')throw new Error('private provider detail');return {summary:'One dam',data:{rows:[{name:'Synthetic dam',lat:30,lon:-97}],attribution:'Synthetic attribution'}};}}});
  assert.ok(calls.every(call=>!JSON.stringify(call).includes('PRIVATE')));
  assert.equal(results[0].status,'unavailable');
  assert.equal(results[1].status,'available');
  assert.equal(results[1].observedAt,null);
  assert.equal(results[1].retrievedAtMs,200);
  assert.match(results[0].summary,/does not establish absence/);
  assert.doesNotMatch(JSON.stringify(results),/private provider detail/);
});
test('aborted source results are discarded instead of being saved as failures',async()=>{
  const controller=new AbortController();
  await assert.rejects(queryInvestigationArea({area,sourceIds:['earthquakes'],signal:controller.signal,catalog:{async call(){controller.abort();return {summary:'stale',data:{rows:[]}};}}}),/abort/i);
});
test('evidence preserves history, kinds and human confidence',()=>{
  const record=base();
  const next=appendInvestigationEntry(record,{kind:'hypothesis',text:'Synthetic hypothesis',confidence:'low'},200);
  assert.equal(record.workflow.length,0);
  assert.equal(next.workflow[0].kind,'hypothesis');
  assert.equal(next.workflow[0].confidence,'low');
  assert.throws(()=>appendInvestigationEntry(next,{kind:'identity-match',text:'x'}));
});
test('encrypted backup roundtrip, wrong passphrase and tampering fail closed',async()=>{
  const record=appendInvestigationEntry(base(),{kind:'note',text:'Synthetic confidential note'},200);
  const backup=await encryptInvestigationBackup(record,'synthetic backup passphrase',webcrypto);
  assert.doesNotMatch(JSON.stringify(backup),/confidential|synthetic-case/);
  assert.deepEqual(await decryptInvestigationBackup(JSON.stringify(backup),'synthetic backup passphrase',webcrypto),record);
  await assert.rejects(decryptInvestigationBackup(JSON.stringify(backup),'wrong passphrase',webcrypto),/DECRYPTION_FAILED/);
  backup.envelope.ciphertext=(backup.envelope.ciphertext[0]==='A'?'B':'A')+backup.envelope.ciphertext.slice(1);
  await assert.rejects(decryptInvestigationBackup(JSON.stringify(backup),'synthetic backup passphrase',webcrypto),/DECRYPTION_FAILED/);
});
test('authenticated backups with rewritten or unrelated evidence are rejected',async()=>{
  const record=appendInvestigationEntry(base(),{kind:'note',text:'Original'},200);
  record.workflow[0]={...record.workflow[0],text:'Rewritten'};
  const backup=await encryptInvestigationBackup(record,'synthetic backup passphrase',webcrypto);
  await assert.rejects(decryptInvestigationBackup(JSON.stringify(backup),'synthetic backup passphrase',webcrypto),/evidence history/);
});
test('drafts default to English and offer explicit French',()=>{
  const input={action:'erasure',controllerName:'Synthetic',contactRoute:'https://example.test/privacy',candidate:{url:'https://example.test/profile'}};
  assert.match(createFranceEuDraft(input).body,/DRAFT/);
  assert.match(createFranceEuDraft({...input,language:'fr'}).body,/BROUILLON/);
  assert.throws(()=>createFranceEuDraft({...input,language:'unknown'}));
});
test('authenticated but unrenderable evidence dates are rejected before restore',async()=>{
  const record=appendInvestigationEntry(base(),{kind:'note',text:'Invalid date'},9e15);
  const backup=await encryptInvestigationBackup(record,'synthetic backup passphrase',webcrypto);
  await assert.rejects(decryptInvestigationBackup(JSON.stringify(backup),'synthetic backup passphrase',webcrypto),/evidence history/);
});
