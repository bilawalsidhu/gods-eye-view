import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {trackedHandPose,pinchHeld,createHandMaterial,createControllerHandMaterial,createMetaDarkV6OutlineMaterial,styleHandModel,handAssetCache} from '../src/xr-hands.js';
test('pinch hysteresis avoids repeated pickup and releases outside threshold',()=>{
 assert.equal(pinchHeld(.017,false),true);assert.equal(pinchHeld(.023,true),true);assert.equal(pinchHeld(.023,false),false);assert.equal(pinchHeld(.029,true),false);assert.equal(pinchHeld(NaN,true),false);
});
test('joint loss invalidates pose and tracked midpoint uses world space',()=>{
 const hand=new THREE.Group();hand.joints={};for(const n of ['wrist','thumb-tip','index-finger-tip']){const j=new THREE.Group();hand.joints[n]=j;hand.add(j);}hand.position.x=2;hand.joints['index-finger-tip'].position.x=.02;hand.updateMatrixWorld(true);
 assert.equal(trackedHandPose(hand).position.x,2.01);hand.joints.wrist.visible=false;assert.equal(trackedHandPose(hand),null);
});
test('Meta Dark v6 hands retain depth tests and translucency with a depth-writing body',()=>{
 const m=createHandMaterial();assert.equal(m.isMeshToonMaterial,true);assert.equal(m.name,'Meta Dark v6');assert.equal(m.transparent,true);assert.equal(m.depthTest,true);assert.equal(m.depthWrite,true);assert.ok(m.opacity>.7&&m.opacity<1);m.gradientMap.dispose();m.dispose();
});
test('the controller-hand material is a second slot with the same rendering contract and its own program',()=>{
 const tracked=createHandMaterial(),controller=createControllerHandMaterial();
 assert.equal(controller.isMeshToonMaterial,true);assert.equal(controller.name,'Meta Dark v6 controller hand');assert.equal(controller.transparent,true);assert.equal(controller.depthTest,true);assert.equal(controller.depthWrite,true);assert.ok(controller.opacity>.7&&controller.opacity<1);
 assert.notEqual(controller.customProgramCacheKey(),tracked.customProgramCacheKey(),'two slots, two programs');
 assert.deepEqual(controller.defaultAttributeValues.handFade,tracked.defaultAttributeValues.handFade,'both consume the baked wrist fade');
 assert.equal(typeof handAssetCache,'object');
 for(const m of [tracked,controller]){m.gradientMap.dispose();m.dispose()}
});
test('Meta Dark v6 adds a solid white skinned hull outline to each hand mesh',()=>{
 const root=new THREE.Group(),mesh=new THREE.SkinnedMesh(new THREE.BoxGeometry(.02,.02,.02),new THREE.MeshBasicMaterial());
 const bone=new THREE.Bone();root.add(bone);root.add(mesh);mesh.bind(new THREE.Skeleton([bone]));
 styleHandModel(root);const hull=root.children.find(child=>child.userData.handOutline);
 assert.ok(hull?.isSkinnedMesh);assert.equal(hull.skeleton,mesh.skeleton);assert.equal(hull.material.name,'Meta Dark v6 solid white hull outline');
 assert.equal(hull.material.side,THREE.BackSide);assert.equal(hull.material.depthWrite,false);assert.equal(hull.material.transparent,true);
 for(const material of [mesh.material,hull.material]){material.gradientMap?.dispose();material.dispose()}
 mesh.geometry.dispose();
});
