import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {syntheticHand} from './helpers/synthetic-hand.js';
import {readJoints,fistFrame,CHAINS} from '../src/hand-gestures.js';
import {swipeHintPlacement,SWIPE_HINT} from '../src/gesture-hints.js';

// readJoints wants renderer-shaped joints; the synthetic hand gives bones. Same adapter the
// hand-gestures tests use, kept local so this file needs nothing from them.
function jointsOf(hand){
 const joints={};
 hand.traverse(node=>{if(node.isBone)joints[node.name]={...node,visible:true,getWorldPosition:target=>node.getWorldPosition(target)}});
 return readJoints({joints});
}
// The hint belongs to the closed fist, so every fixture here poses one: each finger folded at the
// three joints that really hinge, which is what fingerCurl measures.
function curlFinger(hand,finger,angleDeg){
 const chain=CHAINS[finger],theta=THREE.MathUtils.degToRad(angleDeg);
 const bones=chain.map(name=>hand.getObjectByName(name)),original=bones.map(b=>b.position.clone());
 const segments=[];for(let i=1;i<bones.length;i++)segments.push(original[i].distanceTo(original[i-1]));
 let direction=original[1].clone().sub(original[0]).normalize(),cursor=bones[0].position.clone();
 for(let i=1;i<bones.length;i++){if(i>1)direction.applyAxisAngle(new THREE.Vector3(1,0,0),theta);cursor=cursor.clone().add(direction.clone().multiplyScalar(segments[i-1]));bones[i].position.copy(cursor);}
 hand.updateMatrixWorld(true);
}
function fistHand({mirror=false}={}){
 const hand=syntheticHand({mirror});
 for(const finger of ['index-finger','middle-finger','ring-finger','pinky-finger'])curlFinger(hand,finger,75);
 return hand;
}
const vec=p=>new THREE.Vector3(p.x,p.y,p.z);
const placementOf=hand=>{const joints=jointsOf(hand);return {joints,frame:fistFrame(joints),placement:swipeHintPlacement(joints,fistFrame(joints))}};

test('the arrows run along the same axis the swipe itself is measured on',()=>{
 const {frame,placement}=placementOf(fistHand());
 assert.ok(placement,'a fully tracked fist places the hint');
 // hand-gestures.js projects thumb travel onto fistFrame's across. If the arrows pointed anywhere
 // else they would be telling the user to slide in a direction that does not register.
 assert.ok(vec(placement.across).distanceTo(vec(frame.across))<1e-9);
 assert.ok(Math.abs(vec(placement.across).length()-1)<1e-9,'and it is a unit direction');
});

test('the pair floats off the top face of the fist, above the thumb',()=>{
 const {joints,frame,placement}=placementOf(fistHand());
 const offset=vec(placement.origin).sub(vec(joints['thumb-tip']));
 assert.ok(Math.abs(offset.length()-SWIPE_HINT.lift)<1e-9,'lifted by exactly the configured clearance');
 // Straight off the face: a component across the fist would slide the pair out from under the
 // thumb, and a component along the finger would walk it up the knuckles.
 assert.ok(Math.abs(offset.dot(vec(frame.across)))<1e-9);
 assert.ok(Math.abs(offset.dot(vec(frame.along)))<1e-9);
 assert.ok(offset.dot(vec(frame.normal))>0,'and on the side the thumb rests, not through the fist');
});

test('the pair follows the thumb across the fist, since it is what the thumb is sliding between',()=>{
 const hand=fistHand(),before=placementOf(hand).placement;
 const across=vec(before.across).multiplyScalar(.012);
 for(const name of ['thumb-metacarpal','thumb-phalanx-proximal','thumb-phalanx-distal','thumb-tip'])hand.getObjectByName(name).position.add(across);
 hand.updateMatrixWorld(true);
 const after=placementOf(hand).placement;
 assert.ok(vec(after.origin).distanceTo(vec(before.origin))>.011,'the arrows travel with the thumb');
 assert.ok(vec(after.across).distanceTo(vec(before.across))<1e-9,'but the direction they point does not move');
});

test('a hand that cannot define the frame gets no hint rather than an arbitrary one',()=>{
 const {joints,frame}=placementOf(fistHand());
 assert.equal(swipeHintPlacement(null,frame),null);
 assert.equal(swipeHintPlacement(joints,null),null,'no frame, no axis to lay the arrows on');
 assert.equal(swipeHintPlacement({},frame),null,'no thumb, nothing to sit above');
 const collapsed=jointsOf(fistHand());
 // A pinky knuckle sitting on the index knuckle leaves no across-the-fist direction to derive.
 collapsed['pinky-finger-metacarpal']={...collapsed['index-finger-metacarpal']};
 assert.equal(fistFrame(collapsed),null);
});

test('the mirrored hand lays its arrows across its own knuckles',()=>{
 const {joints,frame,placement}=placementOf(fistHand({mirror:true}));
 assert.ok(placement,'left.glb is right.glb mirrored; nothing here may assume a handedness');
 const toPinky=vec(joints['pinky-finger-metacarpal']).sub(vec(joints['index-finger-metacarpal']));
 assert.ok(vec(frame.across).dot(toPinky)>0);
 assert.ok(vec(placement.origin).sub(vec(joints['thumb-tip'])).dot(vec(frame.normal))>0);
});
