import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {syntheticHand} from './helpers/synthetic-hand.js';
import {readJoints} from '../src/hand-gestures.js';
import {XRToolkit} from '../src/xr-toolkit.js';
import {MICROGESTURE_BUTTON as B,MICROGESTURE_TUNE as TUNE,hasMicrogestures,wristRoll,createMicrogestureTracker} from '../src/microgestures.js';
import {createSettings,SETTINGS} from '../src/settings.js';

const INDEX=['index-finger-metacarpal','index-finger-phalanx-proximal','index-finger-phalanx-intermediate','index-finger-phalanx-distal','index-finger-tip'];
// Bends the index at its three real hinges, the same way tests/hand-gestures.test.js folds a finger,
// so a fixture can be a resting microgesture hand (softly bent) or a pointing one (straight).
function bendIndex(hand,angleDeg){
 const bones=INDEX.map(name=>hand.getObjectByName(name)),original=bones.map(bone=>bone.position.clone()),theta=THREE.MathUtils.degToRad(angleDeg);
 let direction=original[1].clone().sub(original[0]).normalize(),cursor=bones[0].position.clone();
 for(let i=1;i<bones.length;i++){if(i>1)direction.applyAxisAngle(new THREE.Vector3(1,0,0),theta);cursor=cursor.clone().add(direction.clone().multiplyScalar(original[i].distanceTo(original[i-1])));bones[i].position.copy(cursor);}
 hand.updateMatrixWorld(true);
}
function jointsOf(hand){
 const joints={};hand.traverse(node=>{if(node.isBone)joints[node.name]={visible:true,getWorldPosition:target=>node.getWorldPosition(target)}});
 return readJoints({joints});
}
// A hand at rest for microgestures: forearm pointing ahead (-Z), index softly bent, optionally
// rolled about that forearm. The synthetic hand's fingers run along +Y, so it is laid forward first.
function resting({roll=0,bend=25}={}){
 const hand=syntheticHand();bendIndex(hand,bend);hand.rotation.y=roll;
 const pose=new THREE.Group();pose.rotation.x=-Math.PI/2;pose.add(hand);pose.updateMatrixWorld(true);
 return jointsOf(pose);
}
const pad=pressed=>({buttons:Array.from({length:10},(_,i)=>({pressed:pressed.includes(i),touched:false,value:0}))});
const NONE=pad([]),TAP=pad([B.tapThumb]),LEFT=pad([B.swipeLeft]),RIGHT=pad([B.swipeRight]),FORWARD=pad([B.swipeForward]),BACK=pad([B.swipeBackward]);
// Presses a button for one frame and releases it, returning what the press produced.
function press(tracker,gamepad,joints,t,enabled=true,canEnter=true){const out=tracker.update(gamepad,joints,t,enabled,canEnter);tracker.update(NONE,joints,t+.05,enabled,canEnter);return out;}

test('the profile buttons match the oculus-hand layout',()=>{
 assert.deepEqual(B,{swipeLeft:5,swipeRight:6,swipeForward:7,swipeBackward:8,tapThumb:9});
});
test('microgestures are recognised by profile, or by the profile buttons on a hand',()=>{
 assert.equal(hasMicrogestures({hand:{},profiles:['oculus-hand','generic-hand'],gamepad:{buttons:[]}}),true);
 assert.equal(hasMicrogestures({hand:{},profiles:['generic-hand'],gamepad:pad([])}),true,'ten buttons on a hand is enough');
 assert.equal(hasMicrogestures({hand:{},profiles:['generic-hand'],gamepad:{buttons:[{},{}]}}),false,'a plain hand with two buttons has none');
 assert.equal(hasMicrogestures({profiles:['oculus-hand'],gamepad:pad([])}),false,'a controller is never a microgesture hand');
 assert.equal(hasMicrogestures(null),false);
});
test('the setting defaults on and survives bad storage',()=>{
 const settings=createSettings({definitions:{microgestures:SETTINGS.microgestures},storage:{getItem:()=>'{"microgestures":"sideways"}',setItem(){}}});
 assert.equal(settings.get('microgestures'),'on');assert.equal(settings.toggle('microgestures'),'off');
});
test('wrist roll reads the change, not the hand',()=>{
 const flat=wristRoll(resting());
 assert.ok(Number.isFinite(flat));
 assert.ok(Math.abs(wristRoll(resting())-flat)<1e-9,'the same pose reads the same');
 // Turning the hand about its own finger axis rolls the wrist through exactly that angle.
 const a=wristRoll(resting({roll:.5})),diff=Math.atan2(Math.sin(a-flat),Math.cos(a-flat));
 assert.ok(Math.abs(Math.abs(diff)-.5)<.05,`rolled .5 rad, read ${diff}`);
 const vertical={wrist:{x:0,y:0,z:0},'middle-finger-metacarpal':{x:0,y:.03,z:0},'index-finger-metacarpal':{x:-.03,y:.03,z:0},'pinky-finger-metacarpal':{x:.03,y:.03,z:0}};
 assert.equal(wristRoll(vertical),null,'a hand pointing at the ceiling has no roll to read');
 assert.equal(wristRoll(null),null);assert.equal(wristRoll({wrist:{x:0,y:0,z:0}}),null);
});

test('nothing happens until a tap starts locomotion, then the swipes answer',()=>{
 const tracker=createMicrogestureTracker(),joints=resting();
 for(const [name,gamepad] of Object.entries({LEFT,RIGHT,FORWARD,BACK})){
  const out=press(tracker,gamepad,joints,1);
  assert.deepEqual([out.active,out.turn,out.step,out.tap],[false,0,0,false],`${name} before entering is ignored`);
 }
 const entered=press(tracker,TAP,joints,2);
 assert.deepEqual([entered.active,entered.entered,entered.tap],[true,true,false],'the entering tap does not also teleport');
 assert.equal(press(tracker,TAP,joints,3).tap,true,'the next tap teleports');
 assert.equal(press(tracker,LEFT,joints,3.2).turn,1,'left turns left');
 assert.equal(press(tracker,RIGHT,joints,3.4).turn,-1,'right turns right');
 assert.equal(press(tracker,FORWARD,joints,3.6).step,1);
 assert.equal(press(tracker,BACK,joints,3.8).step,-1);
});
test('a held button fires once, on its rising edge',()=>{
 const tracker=createMicrogestureTracker(),joints=resting();press(tracker,TAP,joints,1);
 const fires=[tracker.update(LEFT,joints,2),tracker.update(LEFT,joints,2.02),tracker.update(LEFT,joints,2.04)].map(o=>o.turn);
 assert.deepEqual(fires,[1,0,0]);
});
test('two opposite swipes on one frame cancel rather than pick one',()=>{
 const tracker=createMicrogestureTracker(),joints=resting();press(tracker,TAP,joints,1);
 assert.equal(tracker.update(pad([B.swipeLeft,B.swipeRight]),joints,2).turn,0);
});
test('rolling the wrist past the limit, or pointing the index, leaves locomotion',()=>{
 const joints=resting(),tracker=createMicrogestureTracker();press(tracker,TAP,joints,1);
 assert.equal(tracker.update(NONE,resting({roll:TUNE.exitRoll*.6}),1.1).active,true,'a modest roll stays in');
 const out=tracker.update(NONE,resting({roll:TUNE.exitRoll*1.4}),1.2);
 assert.deepEqual([out.active,out.exited],[false,'roll']);
 assert.equal(press(tracker,LEFT,joints,1.5).turn,0,'and the swipes are ignored again');
 press(tracker,TAP,joints,2);
 const pointing=tracker.update(NONE,resting({bend:0}),2.1);
 assert.deepEqual([pointing.active,pointing.exited],[false,'index']);
});
test('a tap with the index pointed does not start locomotion',()=>{
 const tracker=createMicrogestureTracker();
 assert.equal(press(tracker,TAP,resting({bend:0}),1).active,false);
});
test('locomotion times out when nothing is asked of it, and activity keeps it alive',()=>{
 const joints=resting(),tracker=createMicrogestureTracker();press(tracker,TAP,joints,1);
 press(tracker,LEFT,joints,1+TUNE.idleTimeout-1);
 assert.equal(tracker.update(NONE,joints,1+TUNE.idleTimeout+.5).active,true,'the swipe restarted the clock');
 const out=tracker.update(NONE,joints,1+2*TUNE.idleTimeout);
 assert.deepEqual([out.active,out.exited],[false,'idle']);
});
test('a busy hand ends locomotion, and a blocked entry only stops the start',()=>{
 const joints=resting(),tracker=createMicrogestureTracker();
 assert.equal(press(tracker,TAP,joints,1,true,false).active,false,'pointing at a button: the tap belongs to the button');
 press(tracker,TAP,joints,2);assert.equal(tracker.active,true);
 assert.equal(tracker.update(NONE,joints,2.1,true,false).active,true,'aiming across a button later does not end a running session');
 const out=tracker.update(NONE,joints,2.2,false);assert.deepEqual([out.active,out.exited],[false,'busy']);
});
test('a swipe made while the hand was busy is spent, not replayed when it frees up',()=>{
 const joints=resting(),tracker=createMicrogestureTracker();press(tracker,TAP,joints,1);
 tracker.update(LEFT,joints,2,false);// busy: locomotion ended, press recorded
 const free=tracker.update(LEFT,joints,2.02,true);
 assert.deepEqual([free.active,free.turn],[false,0]);
});
test('losing the gamepad or resetting drops locomotion',()=>{
 const joints=resting(),tracker=createMicrogestureTracker();press(tracker,TAP,joints,1);
 assert.equal(tracker.update(null,joints,1.1).exited,'lost');
 press(tracker,TAP,joints,2);tracker.reset();assert.equal(tracker.active,false);
});

function stepFixture({valid=()=>true}={}){
 const rig=new THREE.Group();rig.position.set(2,0,3);rig.rotation.y=Math.PI/2;rig.updateMatrixWorld(true);
 // Head at the rig origin looking along the rig's own -Z, which the rig turns to world -X.
 const head=new THREE.PerspectiveCamera();head.position.set(0,1.6,0);head.updateMatrix();head.matrixWorld.multiplyMatrices(rig.matrixWorld,head.matrix);
 const events=[];
 const kit=Object.create(XRToolkit.prototype);Object.assign(kit,{rig,renderer:{xr:{getCamera:()=>head}},onToast:()=>{},blockers:[],canTeleport:valid,onEvent:(name,detail)=>events.push([name,detail])});
 return {kit,rig,events};
}
test('a step moves the learner along where they face, flattened to the floor',()=>{
 const {kit,rig,events}=stepFixture();
 assert.equal(kit.step(1),true);
 assert.ok(Math.abs(rig.position.x-(2-TUNE.stepDistance))<1e-6,`x ${rig.position.x}`);assert.ok(Math.abs(rig.position.z-3)<1e-6,`z ${rig.position.z}`);
 kit.step(-1);kit.step(-1);assert.ok(Math.abs(rig.position.x-(2+TUNE.stepDistance))<1e-6,'back goes the other way');
 assert.deepEqual(events.map(e=>e[0]),['step','step','step']);
});
test('a step into somewhere the learner cannot stand is refused',()=>{
 const {kit,rig,events}=stepFixture({valid:()=>false});
 assert.equal(kit.step(1),false);assert.equal(rig.position.x,2);assert.equal(events[0][0],'step-rejected');
});
test('no step in mixed reality',()=>{
 const {kit,rig}=stepFixture();kit.mixedReality=true;assert.equal(kit.step(1),false);assert.equal(rig.position.x,2);
});
