import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {headMatrix,headPosition,headQuaternion,headDirection} from '../src/xr-head.js';

// Models three.js's cameraXR the way it actually behaves: NOT a child of anything, with its local
// `matrix` holding the runtime's head pose and `matrixWorld` hand-composed against the rig by
// WebXRManager. Getting this shape right is the whole point -- the fixture this replaces added the
// head to the rig, which made getWorldPosition() work in tests and only in tests.
function xrCamera(rig,{position=new THREE.Vector3(),quaternion=new THREE.Quaternion()}={}){
 const camera=new THREE.PerspectiveCamera();
 camera.position.copy(position);camera.quaternion.copy(quaternion);
 camera.updateMatrix();
 assert.equal(camera.parent,null,'the real cameraXR is never parented; a fixture that parents it cannot catch this bug');
 rig.updateMatrixWorld(true);
 camera.matrixWorld.multiplyMatrices(rig.matrixWorld,camera.matrix); // what WebXRManager.updateCamera does
 return camera;
}
// A rig that is both displaced and turned, the way Nuclear's is from the first frame of a session.
function displacedRig(){
 const rig=new THREE.Group();
 rig.position.set(1.5,0,10.7);rig.rotation.y=Math.PI/3;
 rig.updateMatrixWorld(true);
 return rig;
}

test('the head position is composed through the rig, not read off an unparented camera',()=>{
 const rig=displacedRig(),camera=xrCamera(rig,{position:new THREE.Vector3(.7,1.6,-.4)});
 const expected=new THREE.Vector3(.7,1.6,-.4).applyMatrix4(rig.matrixWorld);
 assert.ok(headPosition(rig,camera).distanceTo(expected)<1e-9);
 // And it is emphatically not the local pose, which is what the accessor would have handed back.
 assert.ok(headPosition(rig,camera).distanceTo(new THREE.Vector3(.7,1.6,-.4))>1);
});

test('reading the head does not mutate the camera, which the three.js accessors do',()=>{
 const rig=displacedRig(),camera=xrCamera(rig,{position:new THREE.Vector3(.7,1.6,-.4)});
 const before=camera.matrixWorld.clone(),localBefore=camera.matrix.clone();
 headPosition(rig,camera);headQuaternion(rig,camera);headDirection(rig,camera);headMatrix(rig,camera);
 assert.deepEqual([...camera.matrixWorld.elements],[...before.elements],'matrixWorld is left alone');
 assert.deepEqual([...camera.matrix.elements],[...localBefore.elements]);
});

test('the head follows the rig within the same frame, so a move can be read back immediately',()=>{
 // Teleport and snap turn both move the rig and then depend on the head reading the new position.
 // cameraXR.matrixWorld would still hold the old rig here; the composed matrix does not.
 const rig=displacedRig(),camera=xrCamera(rig,{position:new THREE.Vector3(.7,1.6,-.4)});
 const before=headPosition(rig,camera).clone();
 rig.position.x+=4;
 const after=headPosition(rig,camera);
 assert.ok(Math.abs(after.x-(before.x+4))<1e-9,'the move is visible at once');
 assert.ok(Math.abs(after.z-before.z)<1e-9);
});

test('rotation and facing carry the rig yaw',()=>{
 const rig=new THREE.Group();rig.rotation.y=Math.PI/2;rig.updateMatrixWorld(true);
 const camera=xrCamera(rig);
 // Head looking down its own -Z, rig turned a quarter turn: facing is the rig's -X.
 const direction=headDirection(rig,camera);
 assert.ok(Math.abs(direction.x-(-1))<1e-9,`facing x ${direction.x}`);
 assert.ok(Math.abs(direction.z)<1e-9);
 const quaternion=headQuaternion(rig,camera);
 const expected=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI/2);
 assert.ok(Math.abs(quaternion.angleTo(expected))<1e-9);
});

test('a camera with no rig falls back to its own world matrix, which is right for the desktop camera',()=>{
 const rig=new THREE.Group();rig.position.set(2,0,3);rig.updateMatrixWorld(true);
 const camera=new THREE.PerspectiveCamera();camera.position.set(0,1.65,0);
 rig.add(camera);rig.updateMatrixWorld(true);
 assert.ok(headPosition(null,camera).distanceTo(new THREE.Vector3(2,1.65,3))<1e-9);
 assert.equal(headMatrix(null,null).equals(new THREE.Matrix4()),true,'no camera at all is the identity, not a throw');
});
