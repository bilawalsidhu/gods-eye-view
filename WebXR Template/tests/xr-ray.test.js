import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createAimRay,handRayOrigin,HAND_RAY_ORIGIN,handAimRay,createHandAim,readHandAimPoints,inputAim,HAND_AIM,HAND_AIM_JOINTS} from '../src/xr-ray.js';

const rig=()=>{const scene=new THREE.Scene(),controller=new THREE.Object3D();scene.add(controller);return {scene,controller,aim:createAimRay(controller,scene)};};

test('the pointer reaches its hit, falls back to full length without one, and hides on demand',()=>{
 const {aim}=rig();
 aim.update(null,{visible:true});
 assert.equal(aim.beam.visible,true);
 assert.equal(aim.beam.scale.z,2.5,'no hit means the beam runs to its maximum reach');
 assert.equal(aim.cursor.visible,false,'no hit, no cursor');
 aim.update({distance:.8,point:new THREE.Vector3(0,1.5,-.8)},{visible:true});
 assert.equal(aim.beam.scale.z,.8,'the beam stops at what it is pointing at');
 assert.equal(aim.cursor.visible,true);
 aim.update({distance:9,point:new THREE.Vector3(0,1.5,-9)},{visible:true});
 assert.equal(aim.cursor.visible,false,'a hit beyond reach gets no cursor');
 aim.hide();
 assert.equal(aim.beam.visible,false);assert.equal(aim.cursor.visible,false);
});

test('a panel hit has no mesh face, so the cursor squares up to the panel instead',()=>{
 const {aim}=rig();
 const group=new THREE.Group();group.rotateY(Math.PI/2);group.updateMatrixWorld(true);
 const point=new THREE.Vector3(-.5,1.5,0);
 aim.update({distance:.5,point,panel:{group}},{visible:true});
 assert.equal(aim.cursor.visible,true);
 const facing=new THREE.Vector3(0,0,1).applyQuaternion(aim.cursor.quaternion);
 const panelNormal=new THREE.Vector3(0,0,1).applyQuaternion(group.getWorldQuaternion(new THREE.Quaternion()));
 assert.ok(facing.dot(panelNormal)>.999,'cursor lies flat on the panel it is pointing at');
 assert.ok(aim.cursor.position.distanceTo(point)>0,'cursor is lifted clear of the surface it marks');
});

test('pressing is visible in the pointer without moving it',()=>{
 const {aim}=rig();
 const hit={distance:1,point:new THREE.Vector3(0,1.5,-1)};
 aim.update(hit,{visible:true,active:false});
 const resting=aim.cursor.position.clone(),restingBeam=aim.beam.material.opacity;
 aim.update(hit,{visible:true,active:true});
 assert.ok(aim.beam.material.opacity>restingBeam,'the beam brightens under a press');
 assert.ok(aim.cursor.position.equals(resting),'and the cursor stays put');
});

test('a tracked hand beam leaves from the pinch and still ends on its cursor',()=>{
 const {aim,controller}=rig();
 controller.position.set(0,1.5,0);controller.updateMatrixWorld(true);
 const hit={distance:1,point:new THREE.Vector3(0,1.5,-1)};
 const pinch=new THREE.Vector3(0.03,1.44,-0.02);
 aim.update(hit,{visible:true,origin:pinch});
 assert.equal(aim.beam.visible,true);
 aim.beam.updateMatrixWorld(true);
 assert.ok(aim.beam.getWorldPosition(new THREE.Vector3()).distanceTo(pinch)<1e-6,'the beam root sits on the pinch, not the aim frame');
 // The geometry runs from local 0 to local -1 along z, scaled by reach, so the far end is -Z * scale.
 const tip=aim.beam.localToWorld(new THREE.Vector3(0,0,-1));
 assert.ok(tip.distanceTo(hit.point)<1e-6,'and its tip lands on the point the cursor marks');
 aim.update(hit,{visible:true});
 assert.ok(aim.beam.position.lengthSq()<1e-12&&Math.abs(aim.beam.scale.z-1)<1e-9,'without an origin the beam is back on the aim frame');
});

test('a system-aimed pointer shows the cursor without a beam',()=>{
 const {aim}=rig();
 const hit={distance:1.2,point:new THREE.Vector3(0,1.5,-1.2)};
 aim.update(hit,{visible:true,showBeam:false});
 assert.equal(aim.beam.visible,false,'no drawn beam: the platform aims this pointer and already shows the target');
 assert.equal(aim.cursor.visible,true,'but the cursor still reports where the platform ray landed');
 aim.update(hit,{visible:true,showBeam:true});assert.equal(aim.beam.visible,true);
});

test('the pinch origin is derived from the hand pose, nudged along the aim, and absent without one',()=>{
 const pose={position:new THREE.Vector3(0,1,0)},direction=new THREE.Vector3(0,0,-1);
 const origin=handRayOrigin(pose,direction,{forward:.02,drop:.01});
 assert.ok(origin.distanceTo(new THREE.Vector3(0,.99,-.02))<1e-9);
 assert.equal(handRayOrigin(null,direction),null);assert.equal(handRayOrigin(pose,null),null);
 assert.ok(HAND_RAY_ORIGIN.forward>0&&HAND_RAY_ORIGIN.drop>=0);
});

test('a beam given its own direction runs along it and ends on its cursor',()=>{
 const {aim,controller}=rig();
 controller.position.set(0,1.5,0);controller.rotation.x=.4;controller.updateMatrixWorld(true);
 const origin=new THREE.Vector3(.1,1.2,-.2),direction=new THREE.Vector3(0,-.2,-1).normalize(),point=origin.clone().addScaledVector(direction,1.4);
 aim.update({distance:1.4,point},{visible:true,origin,direction});aim.beam.updateMatrixWorld(true);
 assert.ok(aim.beam.getWorldPosition(new THREE.Vector3()).distanceTo(origin)<1e-6,'from the given origin');
 assert.ok(aim.beam.localToWorld(new THREE.Vector3(0,0,-1)).distanceTo(point)<1e-6,'to the hit, whatever way the controller frame faces');
});

// A right hand held out in front at chest height, palm down, knuckles forward (-Z).
const handAt=(x,y,z)=>({wrist:new THREE.Vector3(x,y,z+.07),thumb:new THREE.Vector3(x-.03,y-.01,z+.03),index:new THREE.Vector3(x-.02,y,z),middle:new THREE.Vector3(x,y,z)});
const head=new THREE.Vector3(0,1.6,0),forward=new THREE.Vector3(0,0,-1);

test('a hand aims from the shoulder through the web of the hand: a low hand points down, a raised one level',()=>{
 const low=handAimRay(handAt(.2,1.05,-.35),head,forward,'right').direction.clone();
 assert.ok(low.y<-.42,`a hand held low points at the floor (${low.y.toFixed(2)})`);
 const reached=handAimRay(handAt(.2,1.4,-.55),head,forward,'right').direction.clone();
 assert.ok(Math.abs(reached.y)<.15&&reached.z<-.9,`an arm reached out at shoulder height points level and ahead (${reached.toArray().map(n=>n.toFixed(2))})`);
 const lookingDown=handAimRay(handAt(.2,1.4,-.55),head,new THREE.Vector3(0,-.9,-.3),'right').direction;
 assert.ok(lookingDown.distanceTo(reached)<1e-9,'looking down does not move the shoulders, so the aim stays where the hand is');
});

test('the aim starts at about the pinch and a pinch does not move it',()=>{
 const points=handAt(.2,1.3,-.45),ray=handAimRay(points,head,forward,'right');
 const web=points.thumb.clone().add(points.index).multiplyScalar(.5);
 assert.ok(Math.abs(ray.origin.distanceTo(web)-HAND_AIM.start)<1e-9,'a pinch-length past the web of the hand');
 assert.ok(Object.values(HAND_AIM_JOINTS).every(name=>!/tip/.test(name)),'built from knuckles and the wrist only, never the fingertips a pinch closes');
});

test('the aim follows a sweep quickly and settles a held one, and needs a tracked hand',()=>{
 const aim=createHandAim();
 assert.equal(aim.update(null,head,forward,'right',1/72),null,'no hand, no ray');
 const a=handAt(.2,1.3,-.45),b=handAt(-.25,1.3,-.45);
 const first=aim.update(a,head,forward,'right',1/72).direction.clone();
 assert.ok(first.distanceTo(handAimRay(a,head,forward,'right').direction)<1e-9,'the first reading is taken as is');
 aim.update(b,head,forward,'right',1/72);
 const target=handAimRay(b,head,forward,'right').direction.clone();
 for(let i=0;i<12;i++)aim.update(b,head,forward,'right',1/72);
 assert.ok(aim.ray.direction.angleTo(target)<.02,'a sweep is caught up within a sixth of a second');
 // A tremor of a fraction of a degree is damped more than a sweep is.
 const still=aim.ray.direction.clone(),shaken=handAt(-.25,1.302,-.45);
 aim.update(shaken,head,forward,'right',1/72);
 const moved=aim.ray.direction.angleTo(still),wanted=handAimRay(shaken,head,forward,'right').direction.angleTo(still);
 assert.ok(moved<wanted*.3,`a small tremor mostly filtered (${moved.toExponential(2)} of ${wanted.toExponential(2)})`);
});

test('the aim points are read from the joints the runtime tracks, and not without them',()=>{
 const joints={};for(const name of Object.values(HAND_AIM_JOINTS)){const j=new THREE.Object3D();j.visible=true;joints[name]=j;}
 joints['index-finger-phalanx-proximal'].position.set(.1,1.2,-.3);joints['index-finger-phalanx-proximal'].updateMatrixWorld(true);
 const hand={visible:true,joints};
 assert.ok(readHandAimPoints(hand).index.distanceTo(new THREE.Vector3(.1,1.2,-.3))<1e-9);
 joints.wrist.visible=false;assert.equal(readHandAimPoints(hand),null);
 assert.equal(readHandAimPoints(null),null);
});

test('code outside the toolkit reads the same aim: the hand ray while there is one, else targetRaySpace',()=>{
 const controller=new THREE.Object3D();controller.position.set(0,1,0);controller.updateMatrixWorld(true);
 const ray={origin:new THREE.Vector3(.1,1.2,-.3),direction:new THREE.Vector3(0,-1,0),hand:true};
 const hand={controller,source:{hand:{}},ray};
 const a=inputAim(hand);assert.ok(a.origin.equals(ray.origin)&&a.direction.equals(ray.direction));
 assert.notEqual(a.origin,ray.origin,'a copy, so callers cannot move the hand ray');
 const b=inputAim({controller,source:{hand:{}},ray:null});
 assert.ok(b.origin.equals(new THREE.Vector3(0,1,0))&&b.direction.distanceTo(new THREE.Vector3(0,0,-1))<1e-9);
 const c=inputAim({controller,source:{gamepad:{}},ray});assert.ok(c.direction.distanceTo(new THREE.Vector3(0,0,-1))<1e-9,'a controller never takes a stale hand ray');
});
