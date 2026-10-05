import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {controllerVisualState,alignHandToGrip,GRIP_TUNE} from '../src/controller-hand.js';
import {syntheticHand,worldOf} from './helpers/synthetic-hand.js';

test('only a controller with a gamepad shows a visual, and only the one the setting names',()=>{
 const controller={targetRayMode:'tracked-pointer',gamepad:{}};
 assert.deepEqual(controllerVisualState(controller,'controller'),{controller:true,hand:false});
 assert.deepEqual(controllerVisualState(controller,'hand'),{controller:false,hand:true});
 for(const mode of ['controller','hand']){
  assert.deepEqual(controllerVisualState({targetRayMode:'tracked-pointer',hand:{}},mode),{controller:false,hand:false},'tracked hands have their own visual');
  assert.deepEqual(controllerVisualState({targetRayMode:'transient-pointer',gamepad:{}},mode),{controller:false,hand:false},'spatial pointers show nothing');
  assert.deepEqual(controllerVisualState({targetRayMode:'gaze'},mode),{controller:false,hand:false});
  assert.deepEqual(controllerVisualState({targetRayMode:'tracked-pointer'},mode),{controller:false,hand:false},'no gamepad, nothing to pose from');
  assert.deepEqual(controllerVisualState(null,mode),{controller:false,hand:false});
 }
 assert.deepEqual(controllerVisualState(controller,'bogus'),{controller:false,hand:false});
});
test('the hand lands on the grip with fingers forward-and-down and the palm toward the body midline',()=>{
 for(const handedness of ['right','left']){
  const hand=syntheticHand({mirror:handedness==='left'});
  alignHandToGrip(hand,handedness);
  const wrist=worldOf(hand,'wrist'),middle=worldOf(hand,'middle-finger-metacarpal');
  const finger=middle.clone().sub(wrist).normalize();
  assert.ok(finger.z<-.5&&finger.y<0,`${handedness}: fingers point along the controller (${finger.toArray().map(n=>n.toFixed(2))})`);
  // The synthetic palm side is where the thumb is; after alignment it must face -X on the right
  // hand and +X on the left, whichever way the source rig was mirrored.
  const palm=worldOf(hand,'thumb-tip').sub(wrist);palm.sub(finger.clone().multiplyScalar(palm.dot(finger)));
  assert.ok(handedness==='right'?palm.x<0:palm.x>0,`${handedness}: palm faces inward (${palm.x.toFixed(3)})`);
  assert.ok(wrist.distanceTo(new THREE.Vector3().fromArray(GRIP_TUNE[handedness].offset))<1e-6,`${handedness}: wrist on the grip target`);
 }
});
test('alignment is idempotent and honours a custom tune',()=>{
 const hand=syntheticHand();alignHandToGrip(hand,'right');const once=hand.quaternion.clone(),position=hand.position.clone();
 alignHandToGrip(hand,'right');assert.ok(once.angleTo(hand.quaternion)<1e-9);assert.ok(position.distanceTo(hand.position)<1e-9);
 alignHandToGrip(hand,'right',{tiltDeg:0,rollDeg:0,yawDeg:0,offset:[0,0,.1]});
 const wrist=worldOf(hand,'wrist'),middle=worldOf(hand,'middle-finger-metacarpal'),finger=middle.clone().sub(wrist).normalize();
 assert.ok(Math.abs(finger.y)<1e-6&&finger.z<-.99,'zero tilt points the fingers straight down the barrel');
 assert.ok(Math.abs(wrist.z-.1)<1e-6,'offset moves the wrist');
});

// Read the shipped skeleton, rather than assuming the synthetic rig has the same palm proportions.
import {readFileSync} from 'node:fs';
import {createHandPoser,controllerCurls} from '../src/hand-pose.js';
function assetSkeleton(side){
 const bytes=readFileSync(new URL(`../public/webxr-profiles/generic-hand/${side}.glb`,import.meta.url));
 const gltf=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
 const nodes=gltf.nodes.map(n=>{const o=new THREE.Bone();o.name=n.name||'';if(n.translation)o.position.fromArray(n.translation);if(n.rotation)o.quaternion.fromArray(n.rotation);if(n.scale)o.scale.fromArray(n.scale);return o});
 gltf.nodes.forEach((n,i)=>n.children?.forEach(j=>nodes[i].add(nodes[j])));
 const root=new THREE.Group();gltf.scenes[gltf.scene??0].nodes.forEach(i=>root.add(nodes[i]));root.updateMatrixWorld(true);return root;
}
test('shipped hands place the wrist and keep the grip transform fixed while posing',()=>{
 for(const side of ['left','right']){
  const hand=assetSkeleton(side),poser=createHandPoser(hand);alignHandToGrip(hand,side);
  const wrist=worldOf(hand,'wrist'),knuckle=worldOf(hand,'middle-finger-phalanx-proximal');
  assert.ok(wrist.distanceTo(new THREE.Vector3(...GRIP_TUNE[side].offset))<1e-6);
  const nearWrist=worldOf(hand,'middle-finger-metacarpal');
  assert.ok(knuckle.distanceTo(nearWrist)*.5>.025,'old anchor misplaced the palm by over 2.5 cm');
  const position=hand.position.clone(),quaternion=hand.quaternion.clone();
  for(const squeeze of [0,.5,1]){poser.setCurls(controllerCurls({squeeze,thumbTouched:true}));assert.ok(hand.position.equals(position));assert.ok(hand.quaternion.equals(quaternion));}
 }
});
test('thumb opposition moves toward the index on both shipped hands',()=>{
 for(const side of ['left','right']){
  const hand=assetSkeleton(side),poser=createHandPoser(hand);
  const before=worldOf(hand,'thumb-tip'),index=worldOf(hand,'index-finger-phalanx-proximal');
  poser.setCurl('thumb',.45);const after=worldOf(hand,'thumb-tip');
  assert.ok(after.distanceTo(index)<before.distanceTo(index),side+' thumb approaches index');
 }
});
test('controller hands are offset toward the dorsal wrist rather than along the handle',()=>{
 assert.deepEqual(GRIP_TUNE.right.offset,[.0272,.042,.0682]);
 assert.deepEqual(GRIP_TUNE.left.offset,[-.0361,.0534,.0796]);
});

test('Quest Touch Plus and its compatibility profiles are available offline',()=>{
 const profiles=JSON.parse(readFileSync(new URL('../public/webxr-profiles/profilesList.json',import.meta.url)));
 for(const id of ['meta-quest-touch-plus','meta-quest-touch-plus-v2','oculus-touch-v3']){
  assert.ok(profiles[id],`${id} profile is present`);
  for(const hand of ['left','right'])assert.ok(readFileSync(new URL(`../public/webxr-profiles/${id}/${hand}.glb`,import.meta.url)).length>0);
 }
});
