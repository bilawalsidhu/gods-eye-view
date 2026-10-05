import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createHandPoser,controllerCurls,readControllerInputs,smoothCurls,CONTROLLER_CURL,FINGERS,POSES,POSE_RECIPES} from '../src/hand-pose.js';
import {syntheticHand,worldOf} from './helpers/synthetic-hand.js';

const near=(a,b,eps=1e-9)=>Math.abs(a-b)<eps;
const GRIP=['middle-finger','ring-finger','pinky-finger'];

test('rest keeps a relaxed wrap with progressively curled grip fingers',()=>{
 const c=controllerCurls({});
 for(const finger of FINGERS)assert.ok(c[finger]>0&&c[finger]<.6);
 assert.ok(c['middle-finger']<c['ring-finger']&&c['ring-finger']<c['pinky-finger']);
 assert.equal(c.spread,CONTROLLER_CURL.restSpread);
});
test('the trigger drives only the index finger, resting hooked and pointing when released',()=>{
 assert.ok(near(controllerCurls({trigger:0,triggerTouched:true})['index-finger'],.24));
 assert.ok(near(controllerCurls({trigger:.5,triggerTouched:true})['index-finger'],.62));
 assert.equal(controllerCurls({trigger:1,triggerTouched:true})['index-finger'],1);
 assert.equal(controllerCurls({trigger:0,triggerTouched:false})['index-finger'],.12);
 const c=controllerCurls({trigger:1,triggerTouched:true});for(const [i,finger] of GRIP.entries())assert.equal(c[finger],CONTROLLER_CURL.gripRest[i]);
});
test('grip curls the fingers without pulling the thumb off the controls',()=>{
 const fist=controllerCurls({squeeze:1,thumbTouched:true});
 for(const finger of GRIP)assert.equal(fist[finger],1);assert.equal(fist.thumb,CONTROLLER_CURL.thumbRest);assert.equal(fist.spread,0);
 assert.equal(controllerCurls({squeeze:1,thumbTouched:false}).thumb,.08,'relaxed lifted thumb');
 assert.ok(near(controllerCurls({squeeze:0,thumbTouched:true}).thumb,.34));
});
test('out-of-range and non-finite inputs clamp instead of producing NaN bone matrices',()=>{
 assert.equal(controllerCurls({trigger:1.4,triggerTouched:true})['index-finger'],1);
 assert.ok(near(controllerCurls({trigger:-.2,triggerTouched:true})['index-finger'],.24));
 assert.equal(controllerCurls({trigger:NaN,triggerTouched:true})['index-finger'],.24);
 const c=controllerCurls({squeeze:Infinity,thumbTouched:true});assert.equal(c['middle-finger'],1);
});
test('gamepad snapshots read the xr-standard mapping with fallbacks for runtimes without capacitive touch',()=>{
 const full=readControllerInputs({buttons:[{value:.4,touched:true},{value:.7},{},{touched:true},{},{}],axes:[0,0,0,0]});
 assert.deepEqual(full,{trigger:.4,squeeze:.7,triggerTouched:true,thumbTouched:true});
 assert.equal(readControllerInputs({buttons:[{value:.3,touched:false}],axes:[]}).triggerTouched,true,'a pull counts as touching');
 assert.equal(readControllerInputs({buttons:[{value:0,touched:false}],axes:[]}).triggerTouched,false);
 assert.equal(readControllerInputs({buttons:[{},{},{},{pressed:true}],axes:[]}).thumbTouched,true,'a press implies a touch');
 assert.equal(readControllerInputs({buttons:[],axes:[0,0,.5,0]}).thumbTouched,true,'stick deflection implies a thumb on it');
 assert.deepEqual(readControllerInputs(null),{trigger:0,squeeze:0,triggerTouched:false,thumbTouched:false});
 assert.equal(readControllerInputs({buttons:[{value:NaN}]}).trigger,0);
});
test('smoothing approaches exponentially, never overshoots and snaps when settled',()=>{
 const from={a:0},to={a:1};
 assert.ok(near(smoothCurls(from,to,1/72).a,1-Math.exp(-18/72),1e-9));
 assert.equal(smoothCurls(from,to,0).a,0);
 assert.equal(smoothCurls(from,to,1).a,1,'a full second settles');
 let value={a:0},last=0;for(let i=0;i<30;i++){value=smoothCurls(value,to,1/72);assert.ok(value.a>=last&&value.a<=1);last=value.a}
 assert.deepEqual(Object.keys(smoothCurls({},controllerCurls({}),.1)).sort(),[...FINGERS,'spread'].sort(),'keys follow the target');
 assert.equal(smoothCurls(undefined,{a:.4},.01).a,.4,'no history starts at the target');
});
test('the poser bends the requested finger and leaves the rest of the hand at bind',()=>{
 for(const mirror of [false,true]){
  const hand=syntheticHand({mirror}),poser=createHandPoser(hand);
  const tipBefore=worldOf(hand,'index-finger-tip'),thumbBefore=worldOf(hand,'thumb-tip'),wristBefore=worldOf(hand,'wrist');
  poser.setCurl('index-finger',.3);hand.updateMatrixWorld(true);
  const tipAfter=worldOf(hand,'index-finger-tip');
  assert.ok(tipAfter.distanceTo(tipBefore)>.03,`index tip moved (${mirror?'left':'right'})`);
  // Flexion folds toward the palm (+Z here), never through the back of the hand.
  assert.ok(tipAfter.z>tipBefore.z+.02,`curls toward the palm (${mirror?'left':'right'})`);
  assert.ok(worldOf(hand,'thumb-tip').distanceTo(thumbBefore)<1e-9);assert.ok(worldOf(hand,'wrist').distanceTo(wristBefore)<1e-9);
 }
});
test('setCurls in one call matches sequential setCurl calls and poses return to bind without drift',()=>{
 const a=syntheticHand(),b=syntheticHand(),pa=createHandPoser(a),pb=createHandPoser(b);
 const curls=controllerCurls({trigger:.6,triggerTouched:true,squeeze:.3,thumbTouched:true});
 pa.setCurls(curls);for(const finger of FINGERS)pb.setCurl(finger,curls[finger]);
 a.updateMatrixWorld(true);b.updateMatrixWorld(true);
 for(const name of Object.keys(pa.bones))assert.ok(worldOf(a,name).distanceTo(worldOf(b,name))<1e-9,name);
 const fresh=syntheticHand(),bind=Object.fromEntries(Object.keys(pa.bones).map(name=>[name,worldOf(fresh,name)]));
 pa.setPose('fist');pa.setPose('open');pa.setPose('rest');pa.setCurls(Object.fromEntries(FINGERS.map(finger=>[finger,0])));pa.setSpread(0);a.updateMatrixWorld(true);
 for(const name in bind)assert.ok(worldOf(a,name).distanceTo(bind[name])<1e-6,`${name} back at bind`);
 assert.equal(pa.pose,'rest');assert.throws(()=>pa.setPose('nope'),/unknown pose/);assert.throws(()=>pa.setCurl('toe',1),/unknown finger/);
 for(const pose of POSES)assert.ok(POSE_RECIPES[pose],pose);
});
test('the poser refuses an object without a wrist',()=>{assert.throws(()=>createHandPoser(new THREE.Group()),/wrist/)});

test('touchpad contact rests the thumb even without a thumbstick',()=>{assert.equal(readControllerInputs({buttons:[{},{},{touched:true}],axes:[0,0]}).thumbTouched,true)});
