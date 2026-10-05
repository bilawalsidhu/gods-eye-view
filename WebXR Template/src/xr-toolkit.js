import {isSpatialPointer} from './xr-capabilities.js';
import {headPosition,headDirection} from './xr-head.js';
import {createAimRay,createHandAim,readHandAimPoints} from './xr-ray.js';
import {createToonHandFactory,trackedHandPose,pinchHeld,handAssetCache} from './xr-hands.js';
import {createControllerHandFactory,controllerVisualState} from './controller-hand.js';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {XRControllerModelFactory} from 'three/addons/webxr/XRControllerModelFactory.js';
import {ballistic,validFloor,STEP,MAX_TIME} from './locomotion.js';
// Every point a ballistic flight can produce: the launch point, each step (float accumulation can
// add one) and the floor hit.
export const ARC_POINTS=Math.ceil(MAX_TIME/STEP)+3;
// Write a flight into the arc's fixed buffer and draw exactly that many points. An arc without a
// preallocated buffer (a test stub, or an application's own line) falls back to setFromPoints.
export function writeArc(line,points){
 const attribute=line.geometry?.attributes?.position;
 if(!attribute){line.geometry?.setFromPoints?.(points.map(p=>new THREE.Vector3(p.x,p.y,p.z)));return points.length}
 const count=Math.min(points.length,attribute.count);
 for(let i=0;i<count;i++)attribute.setXYZ(i,points[i].x,points[i].y,points[i].z);
 attribute.needsUpdate=true;line.geometry.setDrawRange(0,count);
 return count;
}
import {VelocityTracker,limit,THROW_SPEED_LIMIT} from './grab.js';
import {createGestureTracker,readJoints} from './hand-gestures.js';
import {createSwipeHint,swipeHintPlacement} from './gesture-hints.js';
import {createMicrogestureTracker,hasMicrogestures,MICROGESTURE_TUNE} from './microgestures.js';

export class XRToolkit {
 constructor({renderer,scene,rig,world,grabbables,targets,blockers,onToast,onEvent,canTeleport,onTeleport,handTeleport=true,microgestures=true,controllerVisual='controller',panelInput=null}) {
  Object.assign(this,{renderer,scene,rig,world,grabbables,targets,blockers,onToast,canTeleport,onTeleport,handTeleport,microgestures,controllerVisual,panelInput});
  // Optional observer for applications that need to react to interaction outcomes -- a test
  // checklist, analytics, an assessment score. No-op by default; never affects behaviour.
  this.onEvent=onEvent??(()=>{});this.raycaster=new THREE.Raycaster();this.inputs=[];this.marker=this.makeMarker();this.arc=this.makeArc();
  const path=import.meta.env.BASE_URL+'webxr-profiles/',loader=new GLTFLoader();this.controllerFactory=new XRControllerModelFactory(loader);this.controllerFactory.setPath(path);this.handFactory=createToonHandFactory(import.meta.env.BASE_URL,handAssetCache);this.controllerHandFactory=createControllerHandFactory(import.meta.env.BASE_URL,{cache:handAssetCache});
  for(let index=0;index<2;index++)this.makeInput(index);renderer.xr.addEventListener('sessionstart',()=>onToast('Reach and pinch a block to pick it up. Controllers also work.'));renderer.xr.addEventListener('sessionend',()=>{for(const input of this.inputs){this.release(input,false);input.aim.hide();input.pinching=false;input.teleporting=false;input.turning=false;input.teleportHit=null;input.aimHit=null;input.controllerHand.reset();input.swipeHint.hide();input.gestures.reset();input.thumb.reset();input.thumbTeleport=false;}this.marker.visible=this.arc.visible=false;});
 }
 makeInput(index) {
  const controller=this.renderer.xr.getController(index),grip=this.renderer.xr.getControllerGrip(index),hand=this.renderer.xr.getHand(index);this.rig.add(controller,grip,hand);
  // Two visuals live under the grip -- the runtime's controller model and a controller-driven hand --
  // and the controllerVisual setting decides which one is shown. Both stay attached; see syncControllerVisual.
  const controllerModel=this.controllerFactory.createControllerModel(grip),controllerHand=this.controllerHandFactory.createControllerHand(grip);grip.add(controllerModel,controllerHand.root);hand.add(this.handFactory.createHandModel(hand,'mesh'));
  // gestures is recreated (not just reset) on every 'connected' event, because handedness is fixed
  // for the life of a tracker instance -- see hand-gestures.js's SWIPE_TURN -- and the same physical
  // slot can connect a left hand after a right one disconnects.
  const input={aim:createAimRay(controller,this.scene),controller,grip,hand,controllerModel,controllerHand,aimHit:null,pinching:false,source:null,held:null,tracker:new VelocityTracker(),teleporting:false,turning:false,teleportHit:null,gestures:createGestureTracker(),thumb:createMicrogestureTracker(),thumbTeleport:false,swipeHint:createSwipeHint(this.scene)};controller.addEventListener('connected',event=>{this.release(input,false);input.tracker.clear();input.pinching=false;input.teleporting=false;input.turning=false;input.teleportHit=null;input.aim.hide();input.source=event.data;input.thumb.reset();input.thumbTeleport=false;input.gestures=createGestureTracker({handedness:event.data.handedness==='left'?'left':'right'});this.syncControllerVisual(input);});controller.addEventListener('selectstart',()=>{if(isSpatialPointer(input.source))input.pinching=true;if((!input.source?.hand||isSpatialPointer(input.source))&&this.panelInput?.begin(input,isSpatialPointer(input.source)?'pointer':'select'))return;if(isSpatialPointer(input.source)){this.grab(input);if(!input.held)this.select(input);}else if(!input.source?.hand)this.select(input)});controller.addEventListener('selectend',()=>{if(isSpatialPointer(input.source))input.pinching=false;if((!input.source?.hand||isSpatialPointer(input.source))&&this.panelInput?.end(input,false,'select'))return;if(isSpatialPointer(input.source))this.release(input)});controller.addEventListener('squeezestart',()=>{if(this.panelInput?.begin(input,'grab'))return;if(!input.source?.hand)this.grab(input)});controller.addEventListener('squeezeend',()=>{if(this.panelInput?.end(input,false,'grab'))return;if(!input.source?.hand)this.release(input)});controller.addEventListener('disconnected',()=>{this.release(input,false);input.source=null;input.controllerHand.reset();this.syncControllerVisual(input);input.aim.hide();input.tracker.clear();input.pinching=false;input.teleporting=false;input.turning=false;input.teleportHit=null;input.swipeHint.hide();input.gestures.reset();input.thumb.reset();input.thumbTeleport=false;this.marker.visible=this.arc.visible=false});this.inputs.push(input);
 }
 makeMarker(){const marker=new THREE.Mesh(new THREE.RingGeometry(.14,.19,32),new THREE.MeshBasicMaterial({color:'#ffffff',side:THREE.DoubleSide}));marker.rotation.x=-Math.PI/2;marker.visible=false;this.scene.add(marker);return marker}
 // 'controller' shows the runtime's controller model, 'hand' the controller-driven hand mesh. Applies
 // to every connected input immediately and to later connections through syncControllerVisual.
 setControllerVisual(mode){if(mode!=='controller'&&mode!=='hand')return;this.controllerVisual=mode;for(const input of this.inputs)this.syncControllerVisual(input)}
 syncControllerVisual(input){const state=controllerVisualState(input.source,this.controllerVisual);if(input.controllerModel)input.controllerModel.visible=state.controller;if(input.controllerHand)input.controllerHand.root.visible=state.hand}
 // The arc owns a fixed buffer sized for the longest flight and draws only the points in use.
 // BufferGeometry.setFromPoints() now reuses an existing position buffer instead of resizing it, so
 // a shorter arc after a longer one left the old tail in the buffer and drew it as stray lines.
 makeArc(){const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(ARC_POINTS*3),3).setUsage(THREE.DynamicDrawUsage));geometry.setDrawRange(0,0);const line=new THREE.Line(geometry,new THREE.LineBasicMaterial({color:'#ffffff'}));line.frustumCulled=false;line.visible=false;this.scene.add(line);return line}
 setMixedReality(active){this.mixedReality=active;for(const input of this.inputs){input.teleporting=false;input.teleportHit=null;input.teleportBlocked=false;input.turning=false;input.tracker.clear()}this.marker.visible=this.arc.visible=false}
 valid(point){return this.canTeleport?this.canTeleport(point):validFloor(point,this.blockers)}
 teleport(point){if(this.mixedReality)return;const head=headPosition(this.rig,this.renderer.xr.getCamera());this.rig.position.x+=point.x-head.x;this.rig.position.z+=point.z-head.z;this.panelInput?.discontinuity();this.onTeleport?.();this.onEvent?.('teleport',{point});this.onToast('Teleported')}
 snapTurn(angle){if(this.mixedReality)return;const head=headPosition(this.rig,this.renderer.xr.getCamera()),offset=this.rig.position.clone().sub(head).applyAxisAngle(new THREE.Vector3(0,1,0),angle);this.rig.position.x=head.x+offset.x;this.rig.position.z=head.z+offset.z;this.rig.rotation.y+=angle;this.panelInput?.discontinuity();this.onEvent?.('snapturn',{angle})}
 // One swipe forward or back along where the head faces, flattened to the floor. Refused, like a
 // teleport, when the destination is not somewhere the learner could stand.
 step(direction){
  if(this.mixedReality)return false;
  const camera=this.renderer.xr.getCamera(),head=headPosition(this.rig,camera),look=headDirection(this.rig,camera,new THREE.Vector3());look.y=0;
  if(look.lengthSq()<1e-6)return false;look.normalize().multiplyScalar(direction*MICROGESTURE_TUNE.stepDistance);
  if(!this.valid({x:head.x+look.x,y:0,z:head.z+look.z})){this.onEvent?.('step-rejected',{direction});return false}
  this.rig.position.x+=look.x;this.rig.position.z+=look.z;this.panelInput?.discontinuity();this.onEvent?.('step',{direction});return true;
 }
 // Meta's thumb microgestures for one hand (see microgestures.js): a tap starts locomotion, then a
 // tap teleports to where the hand's own ray lands the arc, a left/right swipe snap-turns and a
 // forward/back swipe steps. Runs before the pinch and panel code, so it gates on last frame's aim.
 updateThumb(input,handPose,ray,time){
  const enabled=!!handPose&&this.handTeleport&&!this.mixedReality&&!input.held&&!this.panelInput?.captured(input);
  const joints=handPose?readJoints(input.hand):null;
  const move=input.thumb.update(input.source.gamepad,joints,time,enabled,!input.aimHit);
  if(move.entered)this.onToast('Thumb tap to teleport. Swipe to turn or step.');
  if(move.active){
   // A ray resting on a button or panel belongs to that control, not to the arc: the beam stays and
   // the tap is left for the UI, but turning and stepping still answer.
   if(input.aimHit){if(input.thumbTeleport){input.thumbTeleport=false;this.hideTeleportPreview(input)}}
   else{
    input.thumbTeleport=true;input.teleporting=true;input.aim.hide();
    this.showTeleportPreview(input,ballistic(ray.origin,ray.direction));
    if(move.tap){if(input.teleportHit)this.teleport(input.teleportHit);else if(input.teleportBlocked){this.onEvent?.('teleport-rejected',{input});this.onToast('Destination blocked')}}
   }
   if(move.turn)this.snapTurn(move.turn*MICROGESTURE_TUNE.turnAngle);
   if(move.step)this.step(move.step);
  }else if(input.thumbTeleport){input.thumbTeleport=false;this.hideTeleportPreview(input)}
 }
 // Turns the thumb microgestures on or off. Off hands every tracked hand back to the finger-gun and
 // fist gestures in hand-gestures.js; either way a preview the thumb path had drawn is dropped.
 setMicrogestures(on){this.microgestures=!!on;for(const input of this.inputs){input.thumb.reset();if(input.thumbTeleport){input.thumbTeleport=false;this.hideTeleportPreview(input)}}}
 // Reaches this.targets (buttons, pads -- always selectable) plus any grabbable object that has
 // opted into gaze/spatial-pointer pickup with userData.gaze=true (Solar's sun; the template
 // itself flags nothing). Everything else is direct-grab only -- see grab() -- so a spatial
 // pointer or gaze ray can still trigger the few things the design allowlists without being able
 // to pick up an arbitrary block by looking at it.
 // Where an input aims: a tracked hand's own ray (createHandAim in xr-ray.js, refreshed each frame
 // by updateAim), or the runtime's targetRaySpace for controllers, spatial pointers and a hand
 // whose knuckles are not tracked. The beam, cursor, panels and selection all use this one ray.
 aimOf(input){if(input.ray?.hand&&input.source?.hand&&!isSpatialPointer(input.source))return input.ray;const ray=input.targetRay??={origin:new THREE.Vector3(),direction:new THREE.Vector3(),hand:false};input.controller.getWorldPosition(ray.origin);input.controller.getWorldDirection(ray.direction).negate();return ray}
 updateAim(input,dt){
  if(input.source?.hand&&!isSpatialPointer(input.source)){
   const camera=this.renderer.xr.getCamera(),points=input.aimPoints??={wrist:new THREE.Vector3(),thumb:new THREE.Vector3(),index:new THREE.Vector3(),middle:new THREE.Vector3()};
   input.handAim??=createHandAim();
   input.ray=input.handAim.update(readHandAimPoints(input.hand,points),headPosition(this.rig,camera,this.aimHead??=new THREE.Vector3()),headDirection(this.rig,camera,this.aimForward??=new THREE.Vector3()),input.source.handedness,dt);
  }else{input.ray=null;input.handAim?.reset();}
  return this.aimOf(input);
 }
 select(input){const {origin,direction}=this.aimOf(input);this.raycaster.set(origin,direction);const gazeAllowed=this.grabbables.filter(item=>!item.held&&item.object.userData.gaze===true).map(item=>item.object);const hit=this.raycaster.intersectObjects([...this.targets,...gazeAllowed],false)[0];if(!hit)return;this.onEvent?.('select',{input,object:hit.object});hit.object.userData.action?.(input)}
 // Direct-only pickup, for every kind of input: tracked hands, spatial pointers (Vision Pro's
 // transient-pointer -- the pinch's grip pose stands in for a hand pose when no joints are
 // exposed) and plain controllers all resolve to a proximity check against a single hand/grip
 // position. No ray, no distance cap beyond the grab radius -- reaching for a block is the only
 // way to pick one up, on every platform, which is the whole point of this round's change.
 grab(input){if(input.held)return;
  const spatial=isSpatialPointer(input.source),pose=input.source?.hand?trackedHandPose(input.hand):null;
  if(input.source?.hand&&!pose)return;
  const hand=pose?.position||(input.grip?.visible?input.grip.getWorldPosition(new THREE.Vector3()):null);
  if(!hand)return;
  const choice=this.grabbables.filter(item=>!item.held).map(item=>({item,distance:hand.distanceTo(item.object.getWorldPosition(new THREE.Vector3()))})).sort((a,b)=>a.distance-b.distance)[0];
  if(!choice||choice.distance>(input.source?.hand||spatial?.12:.4))return;
  const item=choice.item;item.held=input;input.held=item;
  // An item that opts in (keepGrip) stays where the hand took hold of it, instead of snapping its
  // origin into the palm: its pose is kept relative to the hand from this moment on.
  if(item.keepGrip){const q0=pose?.quaternion||input.grip.getWorldQuaternion(new THREE.Quaternion()),inverse=q0.clone().invert();item.object.getWorldPosition(item.gripPosition??=new THREE.Vector3());item.gripPosition.sub(hand).applyQuaternion(inverse);item.gripQuaternion=(item.gripQuaternion??new THREE.Quaternion()).copy(inverse).multiply(item.object.getWorldQuaternion(new THREE.Quaternion()));}
  item.body.type=CANNON.Body.KINEMATIC;item.body.velocity.setZero();input.tracker.clear();this.onEvent?.('grab',{input,item});this.onToast('Object grabbed');
 }
 release(input,throwObject=true){if(!throwObject)this.panelInput?.cancel(input);const item=input.held;if(!item)return;input.held=null;item.held=null;item.body.type=CANNON.Body.DYNAMIC;item.body.updateMassProperties();const velocity=throwObject?limit(input.tracker.linear(),THROW_SPEED_LIMIT):{x:0,y:0,z:0};item.body.velocity.set(velocity.x,velocity.y,velocity.z);this.onEvent?.('release',{input,item,throwObject,speed:Math.hypot(velocity.x,velocity.y,velocity.z)});item.onDrop?.(throwObject)}
 // Draws the shared marker/arc from a ballistic flight and records the validated hit on `input`.
 // Shared by the thumbstick-teleport path (update(), below) and the finger-gun gesture path, so
 // the two locomotion inputs read identically on the ground regardless of which aimed them.
 showTeleportPreview(input,flight){
  const hit=flight.hit;input.teleportHit=null;input.teleportBlocked=false;
  if(!hit){this.marker.visible=this.arc.visible=false;return;}
  const ok=this.valid(hit);
  this.marker.position.set(hit.x,.015,hit.z);this.marker.material.color.set(ok?'#ffffff':'#fb7185');this.marker.visible=true;
  writeArc(this.arc,flight.points);this.arc.visible=true;
  input.teleportHit=ok?hit:null;input.teleportBlocked=!ok;
 }
 hideTeleportPreview(input){input.teleporting=false;input.teleportHit=null;input.teleportBlocked=false;this.marker.visible=this.arc.visible=false}
 update(time) {
  if(!this.renderer.xr.isPresenting)return;
  const dt=Math.min(Math.max(time-(this.lastUpdate??time),0),.05);this.lastUpdate=time;
  for(const input of this.inputs) {
   const handPose=input.source?.hand?trackedHandPose(input.hand):null,ray=this.updateAim(input,dt);
   // The gesture read happens once per input per frame (a tracker mutates latched state on every
   // call, so calling it twice would corrupt the shoot/swipe hysteresis) and is reused below both
   // to gate the pinch-grab guard and to drive teleport/turn. Disabled in MR, while something is
   // already held, and while a panel owns this input, same gates as the thumbstick path.
   // A hand the browser reports thumb microgestures for is read through them instead (below) while the
   // setting is on; the joint-read finger gun would otherwise fire on the very thumb tap Meta's
   // recognizer already claimed.
   const thumbHand=this.microgestures&&hasMicrogestures(input.source)&&!isSpatialPointer(input.source);
   const gestureReady=input.source?.hand&&this.handTeleport&&!thumbHand&&!this.mixedReality&&!input.held&&!this.panelInput?.captured(input);
   const joints=gestureReady?readJoints(input.hand):null;
   const gesture=gestureReady?input.gestures.update(joints,time):null;
   // Aim draws the teleport arc and a tap moves the marker, but a swipe turn had nothing on
   // screen to say it was available at all. The rail appears with the armed posture and an empty
   // hand -- which is every condition above -- so each gate that nulls `gesture` also hides it.
   // The hint belongs to the fist alone. The finger gun draws its arc instead, and showing arrows
   // beside a pointing finger suggested a slide that posture does not answer.
   if(gesture?.fist)input.swipeHint.show(swipeHintPlacement(joints,gesture.frame));else input.swipeHint.hide();
   if(thumbHand)this.updateThumb(input,handPose,ray,time);else if(input.thumbTeleport){input.thumbTeleport=false;this.hideTeleportPreview(input);input.thumb.reset();}
   if(input.source?.hand&&!isSpatialPointer(input.source)){if(!handPose){input.aim.hide();this.release(input,false);input.pinching=false;continue;}const pinching=pinchHeld(handPose.distance,input.pinching);
    // An extended index finger cannot physically pinch, but the finger-gun/D-pad postures guard
    // this explicitly rather than relying on that: armed only blocks the pinch from STARTING a
    // new grab, so a pinch already in progress still releases normally.
    if(pinching&&!input.pinching&&!gesture?.armed&&!gesture?.fist){if(!this.panelInput?.begin(input,'pinch')){this.grab(input);if(!input.held)this.select(input);}}
    if(!pinching&&input.pinching){if(!this.panelInput?.end(input,false,'pinch'))this.release(input);}input.pinching=pinching;}
   if(input.held){const p=handPose?.position||input.grip.getWorldPosition(new THREE.Vector3()),q=handPose?.quaternion||input.grip.getWorldQuaternion(new THREE.Quaternion());if(input.held.keepGrip&&input.held.gripQuaternion){p.add(input.held.gripPosition.clone().applyQuaternion(q));q.multiply(input.held.gripQuaternion);}input.held.body.position.copy(p);input.held.body.quaternion.copy(q);input.held.object.position.copy(p);input.held.object.quaternion.copy(q);input.tracker.push(p,q,time)}
   this.raycaster.set(ray.origin,ray.direction);const panelHit=this.panelInput?.update(input,dt);const worldHit=this.raycaster.intersectObjects(this.targets,false)[0];const aimHit=panelHit?{point:panelHit.point,distance:panelHit.distance,object:panelHit.panel.view.face}:worldHit;
   // A tracked hand's beam runs along its own aim ray, from the pinch (see HAND_AIM in xr-ray.js),
   // the same ray the raycast used, so the cursor and the beam agree. A system-aimed pointer gets
   // the cursor alone -- the platform already shows what it is aiming at, and a beam from the eyes
   // to the target is what made it read as head-cast.
   const spatialPointer=isSpatialPointer(input.source),beamOrigin=ray.hand?ray.origin:null,beamDirection=ray.hand?ray.direction:null;
   // A controller's beam is always on. A tracked hand's appears only while it has something to point
   // at -- a target or panel under the ray, or a pinch in progress -- the rule Rooftop Solar's
   // `pointable` already applies: a hand at rest or reaching for a block draws nothing, so the only
   // thing a hand carries around the room is the finger-gun arc while it is armed.
   const pointable=!input.source?.hand||spatialPointer||!!aimHit||input.pinching;
   input.aim.update(aimHit,{visible:!!input.source&&input.controller.visible&&!input.held&&!input.teleporting&&pointable,active:input.pinching,origin:beamOrigin,direction:beamDirection,showBeam:!spatialPointer});input.aimHit=aimHit;
   this.syncControllerVisual(input);if(input.controllerHand.root.visible)input.controllerHand.update(input.source.gamepad,dt);
   if(this.panelInput?.captured(input)||panelHit){input.teleporting=false;input.teleportHit=null;this.marker.visible=this.arc.visible=false;continue;}
   if(this.mixedReality)continue;
   if(gesture){
    // Finger-gun aim beats the tracked-hand pointer beam entirely -- hidden here on the frame it
    // first arms (aim.update() above may already have shown it this same frame, since the gesture
    // read happens after; every frame after this one, input.teleporting alone keeps it hidden).
    if(gesture.armed&&gesture.aim){
     input.teleporting=true;input.aim.hide();
     const flight=ballistic(gesture.aim.origin,gesture.aim.direction);
     this.showTeleportPreview(input,flight);
     if(gesture.shoot&&input.teleportHit){this.teleport(input.teleportHit);this.hideTeleportPreview(input);}
    }else if(input.teleporting){
     // Left the finger-gun shape without shooting: drop the preview, but only the shoot above ever
     // calls this.teleport() -- opening the hand or curling the index must never commit a jump.
     this.hideTeleportPreview(input);
    }
    if(gesture.turn&&!input.turning){this.snapTurn(gesture.turn*Math.PI/6);input.turning=true;}
    if(!gesture.swipe&&gesture.turn===0)input.turning=false;
   }
   // Everything below is the controller's thumbstick and buttons. A tracked hand is finished for
   // this frame: on Quest a hand input source carries a gamepad object too, with no axes, and
   // letting it fall through read "stick released" every frame -- the release branch below then hid
   // the finger-gun preview on the same frame the gesture had drawn it, and would have committed the
   // jump the moment the destination validated. Hand locomotion is the gesture path above, only.
   if(input.source?.hand)continue;
   const axes=input.source?.gamepad?.axes;if(!axes)continue;const horizontal=axes[2]||0;
   if(Math.abs(horizontal)>.65&&!input.turning){this.snapTurn(-Math.sign(horizontal)*Math.PI/6);input.turning=true;}if(Math.abs(horizontal)<.3)input.turning=false;
   const aiming=axes[3]<-.5;
   if(aiming){const origin=input.controller.getWorldPosition(new THREE.Vector3()),direction=input.controller.getWorldDirection(new THREE.Vector3()).negate(),flight=ballistic(origin,direction);this.showTeleportPreview(input,flight);input.teleporting=true}
   else if(input.teleporting){if(input.teleportHit){this.teleport(input.teleportHit)}else if(input.teleportBlocked){this.onEvent?.('teleport-rejected',{input});this.onToast('Destination blocked')}this.hideTeleportPreview(input);input.turning=false}
  }
 }
}

