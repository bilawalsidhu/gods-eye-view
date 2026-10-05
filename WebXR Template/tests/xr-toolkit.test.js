import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {XRToolkit,writeArc,ARC_POINTS} from '../src/xr-toolkit.js';
import {createGestureTracker} from '../src/hand-gestures.js';
import {THROW_SPEED_LIMIT} from '../src/grab.js';
import {handAimRay} from '../src/xr-ray.js';
// Models three.js's cameraXR as it really is: an ArrayCamera that is NEVER added to the scene
// graph, whose local `matrix` holds the runtime's head pose and whose `matrixWorld` WebXRManager
// hand-composes against the rig each frame. The fixture this replaces called rig.add(head), which
// made getWorldPosition() resolve through the rig -- so the head read correctly in tests and could
// never read correctly in a headset. The rig is displaced AND turned here, the way Nuclear's is
// from the first frame of a session, so a rig-local read is wrong by a wide margin.
function fixture(){
 const rig=new THREE.Group();rig.position.set(2,0,3);rig.rotation.y=Math.PI/3;rig.updateMatrixWorld(true);
 const head=new THREE.PerspectiveCamera();head.position.set(.7,1.6,-.4);head.updateMatrix();
 head.matrixWorld.multiplyMatrices(rig.matrixWorld,head.matrix);
 const kit=Object.create(XRToolkit.prototype);Object.assign(kit,{rig,renderer:{xr:{getCamera:()=>head}},onToast:()=>{},blockers:[]});return {kit,head,rig};
}
// Where the head actually is in the world, composed the way WebXRManager does. Tests assert against
// this rather than head.getWorldPosition(), which on an unparented camera returns the local pose.
function headWorld({rig,head}){rig.updateMatrixWorld(true);return new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().multiplyMatrices(rig.matrixWorld,head.matrix));}
test('teleport lands the headset at the destination despite room-scale offset',()=>{
 const {kit,head,rig}=fixture();let called=0;kit.onTeleport=()=>called++;kit.teleport({x:-2,z:1});
 const p=headWorld({rig,head});
 assert.ok(Math.abs(p.x+2)<1e-9,`head x ${p.x}, wanted -2`);assert.ok(Math.abs(p.z-1)<1e-9,`head z ${p.z}, wanted 1`);assert.equal(called,1);
});
test('snap turn rotates around the headset rather than the rig origin',()=>{
 const {kit,head,rig}=fixture(),before=headWorld({rig,head});kit.snapTurn(Math.PI/6);
 const after=headWorld({rig,head});
 assert.ok(before.distanceTo(after)<1e-9,`the head moved ${before.distanceTo(after).toFixed(3)}m; a snap turn must pivot about it`);
 assert.ok(Math.abs(rig.rotation.y-Math.PI/3-Math.PI/6)<1e-9,'and the rig gained exactly the angle');
});
test('release resets physics before notifying drop handlers and runs once',()=>{
 const {kit}=fixture(),body=new CANNON.Body({mass:1});let drops=[];const input={tracker:{linear:()=>({x:1,y:2,z:3})}};const item={body,held:input,onDrop:flag=>{assert.equal(input.held,null);assert.equal(body.type,CANNON.Body.DYNAMIC);drops.push(flag);}};input.held=item;kit.release(input,false);assert.deepEqual([body.velocity.x,body.velocity.y,body.velocity.z],[0,0,0]);kit.release(input);assert.deepEqual(drops,[false]);
});
// The throw speed cap moved out of VelocityTracker and onto the call site when the tracker was
// promoted to the shared module, so the release path is what has to enforce it now.
test('a throw carries the tracked hand velocity and is capped at the throw speed limit',()=>{
 const {kit}=fixture(),body=new CANNON.Body({mass:1});const speeds=[];kit.onEvent=(name,detail)=>{if(name==='release')speeds.push(detail.speed)};
 for(const [linear,expected] of [[{x:1,y:2,z:3},Math.hypot(1,2,3)],[{x:300,y:0,z:0},THROW_SPEED_LIMIT]]){
  const input={tracker:{linear:()=>linear}},item={body,held:null};input.held=item;item.held=input;
  kit.release(input);
  assert.ok(Math.abs(Math.hypot(body.velocity.x,body.velocity.y,body.velocity.z)-expected)<1e-9,JSON.stringify(linear));
 }
 assert.deepEqual(speeds.map(s=>Math.round(s*1e6)/1e6),[Math.round(Math.hypot(1,2,3)*1e6)/1e6,THROW_SPEED_LIMIT]);
});
test('application teleport validation overrides demonstration bounds',()=>{
 const {kit}=fixture();assert.equal(kit.valid({x:10,z:10}),false);kit.canTeleport=p=>p.x===10;assert.equal(kit.valid({x:10,z:10}),true);
});
test('the controller visual follows the setting and swaps immediately for connected inputs',()=>{
 const {kit}=fixture();kit.controllerVisual='controller';
 const input={source:{targetRayMode:'tracked-pointer',gamepad:{}},controllerModel:new THREE.Group(),controllerHand:{root:new THREE.Group(),reset(){}}};
 const handInput={source:{targetRayMode:'tracked-pointer',hand:{}},controllerModel:new THREE.Group(),controllerHand:{root:new THREE.Group(),reset(){}}};
 kit.inputs=[input,handInput];
 kit.syncControllerVisual(input);assert.equal(input.controllerModel.visible,true);assert.equal(input.controllerHand.root.visible,false);
 kit.setControllerVisual('hand');assert.equal(input.controllerModel.visible,false);assert.equal(input.controllerHand.root.visible,true);
 assert.equal(handInput.controllerModel.visible,false);assert.equal(handInput.controllerHand.root.visible,false,'tracked hands show neither');
 kit.setControllerVisual('bogus');assert.equal(kit.controllerVisual,'hand','unknown modes are ignored');
 input.source=null;kit.syncControllerVisual(input);assert.equal(input.controllerModel.visible,false);assert.equal(input.controllerHand.root.visible,false,'a disconnected input shows nothing');
});

test('MR cancels pending teleport and blocks locomotion until VR resumes',()=>{
 const {kit}=fixture();let cleared=0;
 const input={teleporting:true,teleportHit:{x:4,z:4},teleportBlocked:true,turning:true,tracker:{clear(){cleared++}}};
 Object.assign(kit,{inputs:[input],marker:{visible:true},arc:{visible:true}});
 kit.setMixedReality(true);const before=kit.rig.position.clone(),rotation=kit.rig.quaternion.clone();
 kit.teleport({x:9,z:9});kit.snapTurn(Math.PI/6);
 assert.ok(kit.rig.position.equals(before));assert.ok(kit.rig.quaternion.equals(rotation));
 assert.equal(input.teleportHit,null);assert.equal(input.teleporting,false);assert.equal(kit.arc.visible,false);assert.equal(kit.marker.visible,false);assert.equal(cleared,1);
 kit.setMixedReality(false);kit.teleport({x:9,z:9});assert.ok(!kit.rig.position.equals(before));
});

function grabbableFixture(position){
 const object=new THREE.Object3D();object.position.copy(position);object.updateMatrixWorld(true);
 const body={type:null,velocity:{setZero(){}},updateMassProperties(){}};
 return {object,body,held:null};
}

test('a spatial-pointer grab is direct-only: it picks the nearest grabbable within reach of the hand pose and ignores a farther one even on the same ray',()=>{
 const {kit}=fixture();
 const near=grabbableFixture(new THREE.Vector3(.2,1.2,-.35)),far=grabbableFixture(new THREE.Vector3(.2,1.2,-1.3));
 kit.grabbables=[near,far];
 const grip=new THREE.Object3D();grip.position.set(.2,1.2,-.3);grip.visible=true;grip.updateMatrixWorld(true);
 // The controller still points straight down the ray toward `far` -- proving grab() no longer
 // raycasts at all, direct-only, per this round's change.
 const controller=new THREE.Object3D();controller.position.set(.2,1.2,-.3);controller.lookAt(.2,1.2,10);controller.updateMatrixWorld(true);
 const input={source:{targetRayMode:'transient-pointer'},grip,controller,tracker:{clear(){}},held:null};
 kit.grab(input);
 assert.equal(input.held,near,'the grabbable within the .12 m radius is picked up');
 assert.equal(near.held,input);
 assert.equal(far.held,null,'a grabbable a metre away is never reached, even though the controller points straight at it');
});

test('grab falls back to the grip pose when there is no hand pose, and picks up nothing beyond the radius',()=>{
 const {kit}=fixture();
 const object=grabbableFixture(new THREE.Vector3(0,1.2,-.5));
 kit.grabbables=[object];
 const grip=new THREE.Object3D();grip.position.set(0,1.2,-.7);grip.visible=true;grip.updateMatrixWorld(true);
 const controller=new THREE.Object3D();
 const input={source:{targetRayMode:'tracked-pointer',gamepad:{}},grip,controller,tracker:{clear(){}},held:null};
 kit.grab(input);
 assert.equal(input.held,object,'.2 m is within the plain-controller .4 m radius');
 const input2={source:{targetRayMode:'tracked-pointer',gamepad:{}},grip:{visible:false},controller,tracker:{clear(){}},held:null};
 kit.grab(input2);
 assert.equal(input2.held,null,'no visible grip, no pose to grab from');
});

test('an item that keeps its grip is held where it was taken, not snapped to the palm',()=>{
 const {kit}=fixture();
 const object=grabbableFixture(new THREE.Vector3(.1,1.2,-.5));object.keepGrip=true;
 kit.grabbables=[object];
 const grip=new THREE.Object3D();grip.position.set(0,1.2,-.7);grip.visible=true;grip.updateMatrixWorld(true);
 const input={source:{targetRayMode:'tracked-pointer',gamepad:{}},grip,controller:new THREE.Object3D(),tracker:{clear(){}},held:null};
 kit.grab(input);
 assert.equal(input.held,object);
 assert.ok(object.gripPosition.distanceTo(new THREE.Vector3(.1,0,.2))<1e-6,'the offset from the grip, in the grip frame');
 assert.ok(Math.abs(object.gripQuaternion.w-1)<1e-6);
});

test('select reaches a target and a gaze-flagged grabbable, but not an unflagged one',()=>{
 const {kit}=fixture();
 const target=new THREE.Mesh(new THREE.BoxGeometry(1,1,1));target.position.set(0,1.2,-2);target.updateMatrixWorld(true);
 const gazeObject=new THREE.Mesh(new THREE.BoxGeometry(1,1,1));gazeObject.position.set(0,1.2,-2);gazeObject.userData.gaze=true;gazeObject.updateMatrixWorld(true);
 const plainObject=new THREE.Mesh(new THREE.BoxGeometry(1,1,1));plainObject.position.set(0,1.2,-2);plainObject.updateMatrixWorld(true);
 // lookAt(0,1.2,10) rather than -10: the toolkit reads a controller's forward as the NEGATION of
 // getWorldDirection() (WebXR controller space points forward along local +Z, not a camera's -Z),
 // so the local -Z lookAt() aims has to face away from the target for the negated direction to
 // land on it.
 const controller=new THREE.Object3D();controller.position.set(0,1.2,0);controller.lookAt(0,1.2,10);controller.updateMatrixWorld(true);
 let events=[];kit.onEvent=(name,detail)=>events.push([name,detail.object]);
 kit.raycaster=new THREE.Raycaster();
 kit.targets=[target];kit.grabbables=[{object:gazeObject,held:null},{object:plainObject,held:null}];
 const input={controller};
 kit.select(input);
 assert.equal(events.length,1);assert.equal(events[0][1],target,'a target is always reachable');
 kit.targets=[];events=[];
 kit.select(input);
 assert.equal(events.length,1,'the gaze-flagged grabbable is reached even with no targets in the way');
 assert.equal(events[0][1],gazeObject);
 kit.grabbables=[{object:plainObject,held:null}];events=[];
 kit.select(input);
 assert.equal(events.length,0,'an unflagged grabbable is invisible to select()');
});

test('showTeleportPreview marks a valid flight with the marker and clears teleportHit for an invalid one',()=>{
 const {kit}=fixture();
 Object.assign(kit,{marker:{visible:false,position:{set(){}},material:{color:{set(){}}}},arc:{visible:false,geometry:{setFromPoints(){}}}});
 const input={};
 kit.showTeleportPreview(input,{hit:{x:1,z:1},points:[{x:0,y:0,z:0},{x:1,y:0,z:1}]});
 assert.equal(kit.marker.visible,true);assert.equal(kit.arc.visible,true);assert.ok(input.teleportHit);assert.equal(input.teleportBlocked,false);
 kit.canTeleport=()=>false;
 kit.showTeleportPreview(input,{hit:{x:9,z:9},points:[{x:0,y:0,z:0},{x:9,y:0,z:9}]});
 assert.equal(input.teleportHit,null,'an invalid destination clears the stored hit');
 assert.equal(input.teleportBlocked,true);
 kit.showTeleportPreview(input,{hit:null,points:[]});
 assert.equal(kit.marker.visible,false);assert.equal(kit.arc.visible,false);assert.equal(input.teleportHit,null,'no floor hit at all shows nothing');
});

test('a tracked hand draws its beam only while pointing at something or pinching; a controller always does',()=>{
 const {kit}=fixture();kit.renderer.xr.isPresenting=true;kit.targets=[];kit.grabbables=[];kit.raycaster=new THREE.Raycaster();kit.marker=new THREE.Object3D();kit.arc=new THREE.Object3D();kit.handTeleport=true;
 const joint=(x,y,z)=>({visible:true,getWorldPosition:v=>v.set(x,y,z),getWorldQuaternion:q=>q.identity()});
 // Wrist, index tip and thumb tip are all trackedHandPose needs; the index chain is left out, so
 // readJoints() yields no gesture joints and the finger gun stays out of this test's way.
 const hand={visible:true,joints:{wrist:joint(0,1,0),'index-finger-tip':joint(0,1.1,-.1),'thumb-tip':joint(0,1.16,-.1)}};
 const seen=[];const visual=()=>({controllerModel:new THREE.Group(),controllerHand:{root:new THREE.Group(),update(){},reset(){}},swipeHint:{show(){},hide(){}},aim:{update(hit,options){seen.push(options.visible)},hide(){}},tracker:{clear(){},push(){}},held:null,teleporting:false,gestures:createGestureTracker(),controller:new THREE.Object3D(),grip:new THREE.Object3D()});
 const input={...visual(),source:{handedness:'right',targetRayMode:'tracked-pointer',hand:{}},hand,pinching:false};
 kit.inputs=[input];
 kit.update(0);assert.equal(seen.at(-1),false,'a hand at rest, pointing at nothing, draws no beam');
 const button=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial());button.position.z=-1;button.updateMatrixWorld(true);kit.targets=[button];
 kit.update(.1);assert.equal(seen.at(-1),true,'over a target the beam appears');
 kit.targets=[];hand.joints['thumb-tip']=joint(0,1.11,-.1);
 kit.update(.2);assert.equal(seen.at(-1),true,'a pinch shows the beam even over empty space');
 const controller={...visual(),source:{handedness:'left',targetRayMode:'tracked-pointer',gamepad:{axes:[0,0,0,0],buttons:[]}}};
 kit.inputs=[controller];kit.update(.3);assert.equal(seen.at(-1),true,'a controller beam is always on');
});

test('a tracked hand aims with its own ray, not targetRaySpace, and falls back to it without knuckles',()=>{
 const {kit,head,rig}=fixture();kit.renderer.xr.isPresenting=true;kit.grabbables=[];kit.raycaster=new THREE.Raycaster();kit.marker=new THREE.Object3D();kit.arc=new THREE.Object3D();kit.handTeleport=false;
 const joint=v=>({visible:true,getWorldPosition:out=>out.copy(v),getWorldQuaternion:q=>q.identity()});
 const at={wrist:new THREE.Vector3(2.3,1.2,2.6),thumb:new THREE.Vector3(2.27,1.19,2.52),index:new THREE.Vector3(2.29,1.2,2.5),middle:new THREE.Vector3(2.31,1.2,2.49)};
 const hand={visible:true,joints:{wrist:joint(at.wrist),'thumb-phalanx-proximal':joint(at.thumb),'index-finger-phalanx-proximal':joint(at.index),'middle-finger-phalanx-proximal':joint(at.middle),'index-finger-tip':joint(new THREE.Vector3(2.3,1.2,2.4)),'thumb-tip':joint(new THREE.Vector3(2.3,1.26,2.4))}};
 const headAt=headWorld({rig,head}),forward=new THREE.Vector3(0,0,-1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().multiplyMatrices(rig.matrixWorld,head.matrix)));
 const expected=handAimRay(at,headAt,forward,'right');
 // A target 1.2 m down the hand's own ray; targetRaySpace (the controller at the origin, facing -Z) points elsewhere.
 const button=new THREE.Mesh(new THREE.SphereGeometry(.05),new THREE.MeshBasicMaterial());button.position.copy(expected.origin).addScaledVector(expected.direction,1.2);button.updateMatrixWorld(true);kit.targets=[button];
 const seen=[];const input={controllerModel:new THREE.Group(),controllerHand:{root:new THREE.Group(),update(){},reset(){}},swipeHint:{show(){},hide(){}},aim:{update(hit,options){seen.push({hit,options})},hide(){}},tracker:{clear(){},push(){}},held:null,teleporting:false,gestures:createGestureTracker(),controller:new THREE.Object3D(),grip:new THREE.Object3D(),source:{handedness:'right',targetRayMode:'tracked-pointer',hand:{}},hand,pinching:false};
 kit.inputs=[input];kit.update(0);
 assert.equal(seen.at(-1).hit?.object,button,'the hand ray lands on what the hand points at');
 assert.ok(seen.at(-1).options.origin.distanceTo(expected.origin)<1e-9&&seen.at(-1).options.direction.distanceTo(expected.direction)<1e-9,'and the beam is drawn along that same ray');
 assert.equal(kit.aimOf(input),input.ray,'selection and panels read the same ray');
 delete hand.joints['middle-finger-phalanx-proximal'];kit.update(.1);
 assert.ok(!seen.at(-1).hit,'without the knuckles, the runtime ray is used again');
 assert.equal(seen.at(-1).options.direction,null);
});

// The Quest 3 symptom: the swipe rail appeared on a finger gun but the arc never did. Hand input
// sources there carry a gamepad with no axes, so the thumbstick block ran for them, read the stick
// as released, and hid -- or committed -- the preview the gesture had drawn the same frame.
test('an armed finger gun on a hand that also reports a gamepad keeps its arc and does not teleport through the stick path',()=>{
 const {kit}=fixture();kit.renderer.xr.isPresenting=true;kit.targets=[];kit.grabbables=[];kit.raycaster=new THREE.Raycaster();kit.handTeleport=true;
 kit.marker=new THREE.Mesh(new THREE.RingGeometry(.1,.2,8),new THREE.MeshBasicMaterial());kit.arc={visible:false,geometry:{setFromPoints(){}},setPath(points,ok){this.visible=true;this.ok=ok;}};
 let teleports=0;kit.teleport=()=>teleports++;
 const joint=(x,y,z)=>({visible:true,getWorldPosition:v=>v.set(x,y,z),getWorldQuaternion:q=>q.identity()});
 const hand={visible:true,joints:{wrist:joint(0,1,0),'index-finger-tip':joint(0,1.1,-.1),'thumb-tip':joint(0,1.16,-.1)}};
 // The gesture tracker is stubbed armed and aiming forward-and-down; what is under test is what
 // the rest of update() does with an armed hand, not the joint geometry that arms it.
 const gestures={update:()=>({armed:true,aim:{origin:{x:0,y:1.1,z:-.1},direction:{x:0,y:-.3,z:-.95}},shoot:false,swipe:null,turn:0}),reset(){}};
 const input={source:{handedness:'right',targetRayMode:'tracked-pointer',hand:{},gamepad:{axes:[],buttons:[]}},hand,gestures,controller:new THREE.Object3D(),grip:new THREE.Object3D(),aim:{update(){},hide(){}},tracker:{clear(){},push(){}},held:null,pinching:false,teleporting:false,turning:false,teleportHit:null,swipeHint:{show(){},hide(){}},controllerModel:new THREE.Group(),controllerHand:{root:new THREE.Group(),update(){},reset(){}}};
 kit.inputs=[input];
 kit.update(0);
 assert.equal(kit.arc.visible,true,'the arc is still showing at the end of the frame');
 assert.equal(input.teleporting,true,'the input is still in its aiming state');
 assert.ok(input.teleportHit,'the flight found the floor');
 assert.equal(teleports,0,'nothing jumped -- only the thumb tap may commit');
 kit.update(.1);
 assert.equal(kit.arc.visible,true);assert.equal(teleports,0);
});

test('the teleport arc draws only the current flight, never the tail of a longer earlier one',async()=>{
 const THREE=await import('three');
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(ARC_POINTS*3),3));
 const line={geometry};
 const long=Array.from({length:40},(_,i)=>({x:i,y:1,z:0})),short=Array.from({length:8},(_,i)=>({x:i,y:2,z:0}));
 assert.equal(writeArc(line,long),40);assert.equal(geometry.drawRange.count,40);
 assert.equal(writeArc(line,short),8);assert.equal(geometry.drawRange.count,8,'the old 32-point tail is not drawn');
 assert.equal(geometry.attributes.position.getY(7),2);
 const tooLong=Array.from({length:ARC_POINTS+10},(_,i)=>({x:i,y:0,z:0}));
 assert.equal(writeArc(line,tooLong),ARC_POINTS,'never writes past the buffer');
});
