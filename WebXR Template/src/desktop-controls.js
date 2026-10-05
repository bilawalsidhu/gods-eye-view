import * as THREE from 'three';
import {validFloor as defaultFloor} from './locomotion.js';
import {createDesktopModes} from './desktop-modes.js';
import {createReticle,createCaptureOverlay} from './desktop-reticle.js';
import {resolveAim,reticleFor,grabbableOf} from './desktop-aim.js';
import {DISTANCE_GRAB_RANGE} from './grab.js';

// The desktop input surface: looking, walking, and putting the pointer on something. One module
// so every application behaves the same way on a mouse, and so the headset path never has to
// carry a second copy of it.
//
// Two profiles, chosen by the shape of the scene rather than by whether it can run in MR:
//
//  'tabletop'  -- the camera stays in essentially one place and you manipulate objects in front
//                 of it. Free cursor, drag to look, click what the cursor is on. A solar table.
//  'roomScale' -- a scene you walk around in. The mouse is captured like a desktop game and a
//                 fixed centre crosshair is the aim point. A workshop.
//
// Capture is how roomScale is meant to be played, but it is never a dependency: a browser will
// not lock the pointer without a user gesture, and a cross-origin embed may refuse outright. So
// the crosshair is the aim point either way, and an unavailable lock degrades to drag-to-look
// with every binding unchanged rather than to a different control scheme.
//
// The interaction that sits on top -- what a click does, what is grabbable -- belongs to the
// application, which is why selection is reported rather than performed.

export const DESKTOP={
 speed:2,              // metres per second on the keys, matching the template's original walk
 look:.004,            // radians per pixel of drag
 captureLook:.0022,    // radians per pixel of captured motion; a captured mouse travels further
 pitchLimit:1.2,       // radians either side of level
 dragThreshold:3,      // pixels of movement before a press counts as a look rather than a click
 reach:DISTANCE_GRAB_RANGE,
};

const FORWARD=new THREE.Vector3(0,0,-1),UP=new THREE.Vector3(0,1,0);
const CAPTURE_LINES=['WASD to move','E to pick up','Scroll to push and pull','Esc to release the mouse'];

export function createDesktopControls({
 canvas,camera,rig,
 // What walking moves. A rig-based scene moves the rig; one that flies the camera directly
 // moves the camera. Defaults to the rig, which is what a headset-shaped scene has.
 mover=rig,
 profile='tabletop',
 targets=()=>[],
 grabbables=()=>[],
 blockers=()=>[],
 floorTest=defaultFloor,
 // The carry driver, when the application has one. Left out, E and the wheel do nothing and the
 // crosshair never offers a pickup -- which is exactly what a tabletop scene wants.
 carry=null,
 canGrab=()=>true,
 // Reported rather than performed: the template's targets carry a function, the applications'
 // carry a descriptor they dispatch themselves. Returning false marks the select as unhandled.
 onSelect=null,
 // Optional observer for applications that score or check off interactions. No-op by default.
 onEvent=()=>{},
 container=document.body,
 captureTitle='Click to play',
 captureLines=CAPTURE_LINES,
 tuning={},
}={}){
 const feel={...DESKTOP,...tuning};
 const modes=createDesktopModes({onChange:(next,previous)=>{syncCapture();onEvent('mode',{next,previous})}});
 const keys=new Set(),ray=new THREE.Raycaster(),pointer=new THREE.Vector2();
 const forward=new THREE.Vector3(),right=new THREE.Vector3(),move=new THREE.Vector3(),candidate=new THREE.Vector3(),heading=new THREE.Quaternion();
 const origin=new THREE.Vector3(),direction=new THREE.Vector3();
 const reticle=createReticle({container});
 let yaw=0,pitch=0,drag=null,enabled=true,aim=null;
 // `captured` is the browser's truth, read back from pointerlockchange. `lockRefused` latches
 // the embed case so the overlay stops asking for a gesture that will never be granted.
 let captured=false,lockRefused=false;
 const overlay=createCaptureOverlay({container,title:captureTitle,lines:captureLines});

 const applyLook=()=>camera.rotation.set(pitch,yaw,0,'YXZ');
 const setAngles=(nextYaw,nextPitch)=>{yaw=nextYaw;pitch=THREE.MathUtils.clamp(nextPitch,-feel.pitchLimit,feel.pitchLimit);applyLook()};
 const turn=(dx,dy,scale)=>{setAngles(yaw-dx*scale,pitch-dy*scale);onEvent('look',{yaw,pitch})};

 /* -- Mouse capture ------------------------------------------------------ */

 // A mode that needs the learner to click things wants the cursor back; everything else in a
 // roomScale scene wants it captured.
 const wantsCursor=()=>modes.state().pointer==='cursor';
 const shouldCapture=()=>enabled&&profile==='roomScale'&&!wantsCursor();
 const requestCapture=()=>{
  if(!shouldCapture()||captured||!canvas.requestPointerLock)return;
  // Chrome throttles re-lock for about a second after a user-initiated exit, and an embed may
  // refuse outright. Neither deserves a toast: the overlay simply stays up, or steps aside.
  try{const pending=canvas.requestPointerLock();pending?.catch?.(()=>{lockRefused=true;syncOverlay()})}
  catch{lockRefused=true;syncOverlay()}
 };
 const syncOverlay=()=>overlay.show(shouldCapture()&&!captured&&!lockRefused);
 const syncCapture=()=>{if(!shouldCapture()&&captured)document.exitPointerLock?.();syncOverlay();reticle.show(profile==='roomScale'&&enabled&&!wantsCursor())};
 const onLockChange=()=>{
  const now=document.pointerLockElement===canvas;
  if(now===captured)return;
  captured=now;
  if(captured)lockRefused=false;
  syncOverlay();
  // Esc is consumed by the lock exit and never reaches keydown, so losing capture is the only
  // signal the application gets that the learner asked to come up for air.
  onEvent('capture',{captured});
 };
 const onLockError=()=>{lockRefused=true;syncOverlay()};

 /* -- Aiming ------------------------------------------------------------- */

 const setRay=(clientX,clientY)=>{
  pointer.set(clientX/innerWidth*2-1,-clientY/innerHeight*2+1);
  ray.setFromCamera(pointer,camera);ray.far=Infinity;
  return ray;
 };
 const hitsAlong=()=>{
  const objects=[...targets()];
  for(const item of grabbables())if(item?.object)objects.push(item.object);
  return ray.intersectObjects(objects,true);
 };
 // Centre of the view: the crosshair is the aim point in roomScale, captured or not.
 const aimCentre=()=>{
  setRay(innerWidth/2,innerHeight/2);
  origin.copy(ray.ray.origin);direction.copy(ray.ray.direction);
  return resolveAim(hitsAlong(),{origin,direction,blockers:blockers(),reach:feel.reach});
 };
 // Cursor position: the tabletop path. No blocker rejection -- the camera sits with the objects
 // rather than walking around behind furniture, so pull-through is not a hazard there.
 const pick=(clientX,clientY)=>{setRay(clientX,clientY);return resolveAim(hitsAlong(),{})};

 const select=target=>{
  if(!target)return false;
  const {object,action,hit}=target;
  onEvent('use',{object,action,hit});
  if(onSelect)return onSelect({object,action,hit})!==false;
  if(typeof action==='function'){action();return true}
  return false;
 };

 /* -- Carrying ----------------------------------------------------------- */

 const held=()=>carry?.held??null;
 const tryGrab=()=>{
  if(!carry||held())return false;
  if(!aim?.item||aim.beyondReach||!canGrab(aim.item))return false;
  const took=carry.grab(aim.item,{distance:aim.distance,camera});
  if(took)onEvent('grab',{item:aim.item});
  return took;
 };
 const tryDrop=(thrown=false)=>{
  const item=held();if(!carry||!item)return false;
  carry.release(thrown);onEvent('release',{item,thrown});
  return true;
 };

 /* -- Events ------------------------------------------------------------- */

 const onPointerDown=event=>{
  if(!enabled)return;
  if(captured)return;                                   // captured presses act on release
  drag={x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,moved:false};
  canvas.setPointerCapture?.(event.pointerId);
 };
 const onPointerMove=event=>{
  if(!enabled)return;
  if(captured){
   // R turns what is in your hand rather than your head, which is how a battery gets squared
   // up with its bay without walking around it.
   if(carry&&held()&&keys.has('KeyR'))carry.rotate(event.movementX||0,event.movementY||0);
   else if(!modes.state().lookLocked)turn(event.movementX||0,event.movementY||0,feel.captureLook);
   return;
  }
  if(!drag)return;
  if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>feel.dragThreshold)drag.moved=true;
  if(drag.moved){
   if(carry&&held()&&keys.has('KeyR'))carry.rotate(event.clientX-drag.lastX,event.clientY-drag.lastY);
   else if(!modes.state().lookLocked)turn(event.clientX-drag.lastX,event.clientY-drag.lastY,feel.look);
  }
  drag.lastX=event.clientX;drag.lastY=event.clientY;
 };
 const onPointerUp=event=>{
  if(!enabled)return;
  // Captured, the crosshair is the pointer and the cursor position means nothing.
  if(captured){if(event.button===2)tryDrop(true);else select(aim);return}
  // A mode that asked for the cursor owns the pointer while it is up -- dragging a probe onto a
  // terminal is its gesture, not a crosshair select.
  if(wantsCursor()){drag=null;return}
  const wasDrag=drag;drag=null;
  if(!wasDrag||wasDrag.moved)return;
  // The click that asks for the mouse does nothing else. Clicking the scene is the gesture
  // pointer lock needs, and a learner who meant "start" should not also fire whatever the
  // crosshair happened to be resting on.
  if(shouldCapture()&&!lockRefused){requestCapture();return}
  select(profile==='roomScale'?aim:pick(event.clientX,event.clientY));
 };
 const onPointerCancel=()=>{drag=null};
 const onContextMenu=event=>{if(captured||profile==='roomScale')event.preventDefault()};
 const onWheel=event=>{
  if(!enabled||!carry||!held())return;
  // Only swallow the page's scroll while something is actually in hand, or a partially visible
  // embed loses its own scrolling to a scene the learner is not even holding anything in.
  event.preventDefault();
  carry.push(event.deltaY>0?1:-1);
 };
 const onKeyDown=event=>{
  if(document.querySelector('dialog[open]'))return;
  keys.add(event.code);
  if(!enabled)return;
  if(event.code==='KeyE'){if(!tryDrop(false))tryGrab()}
  else if(event.code==='KeyG')tryDrop(true);
  else{const mode=modes.byKey(event.code);if(mode)modes.toggle(mode)}
 };
 const onKeyUp=event=>keys.delete(event.code);
 const onBlur=()=>{keys.clear();drag=null};

 canvas.addEventListener('pointerdown',onPointerDown);
 canvas.addEventListener('pointermove',onPointerMove);
 canvas.addEventListener('pointerup',onPointerUp);
 canvas.addEventListener('pointercancel',onPointerCancel);
 canvas.addEventListener('contextmenu',onContextMenu);
 canvas.addEventListener('wheel',onWheel,{passive:false});
 addEventListener('keydown',onKeyDown);
 addEventListener('keyup',onKeyUp);
 addEventListener('blur',onBlur);
 document.addEventListener?.('pointerlockchange',onLockChange);
 document.addEventListener?.('pointerlockerror',onLockError);
 syncCapture();

 return {
  modes,keys,reticle,overlay,
  get profile(){return profile},
  get yaw(){return yaw},
  get pitch(){return pitch},
  get captured(){return captured},
  get lockRefused(){return lockRefused},
  get aim(){return aim},
  get held(){return held()},
  setProfile(next){
   if(next!=='tabletop'&&next!=='roomScale')throw new Error(`Unknown desktop profile: ${next}`);
   if(next===profile)return;
   profile=next;drag=null;keys.clear();aim=null;lockRefused=false;
   tryDrop(false);syncCapture();
  },
  setAngles,
  // Read the angles back off a camera the application has aimed itself, so a scene reset that
  // uses lookAt does not leave the controls turning from the old heading on the next drag.
  syncFromCamera(){const e=new THREE.Euler().setFromQuaternion(camera.quaternion,'YXZ');yaw=e.y;pitch=e.x;return {yaw,pitch}},
  pick,aimCentre,select,requestCapture,
  releaseCapture(){if(captured)document.exitPointerLock?.()},
  grab:tryGrab,
  drop:(thrown=false)=>tryDrop(thrown),
  // Applications freeze input for their own reasons; route those through the mode registry so
  // there is one lock rather than two that can disagree.
  suppress:(reason,on)=>modes.suppress(reason,on),
  setEnabled(value){
   const next=!!value;if(next===enabled)return;
   enabled=next;if(!enabled){keys.clear();drag=null;aim=null;tryDrop(false)}
   syncCapture();
  },
  update(dt){
   if(!enabled)return false;
   if(profile==='roomScale'&&!wantsCursor()){
    aim=held()?null:aimCentre();
    const {state,label,hint}=reticleFor(aim,{held:held(),canGrab});
    reticle.set(state,{label,hint});
    carry?.update(dt,{camera,blockers:blockers()});
   }else if(aim){aim=null}
   if(wantsCursor())aim=null;
   if(modes.state().moveLocked)return false;
   // World, not local: an application that yaws the rig itself must still walk where it looks.
   forward.copy(FORWARD).applyQuaternion(camera.getWorldQuaternion(heading));forward.y=0;
   if(forward.lengthSq()<1e-8)return false;   // looking straight up or down gives no heading
   forward.normalize();right.crossVectors(forward,UP).normalize();
   move.set(0,0,0);
   if(keys.has('KeyW'))move.add(forward);
   if(keys.has('KeyS'))move.sub(forward);
   if(keys.has('KeyD'))move.add(right);
   if(keys.has('KeyA'))move.sub(right);
   if(!move.lengthSq())return false;
   move.normalize().multiplyScalar(dt*feel.speed);
   // One axis at a time, which slides along a wall instead of sticking to it, and the same
   // valid-floor rule the headset teleport uses, so desktop cannot walk through the furniture.
   let moved=false;
   for(const axis of ['x','z']){
    if(!move[axis])continue;
    candidate.copy(mover.position);candidate[axis]+=move[axis];
    if(floorTest(candidate,blockers())){mover.position.copy(candidate);moved=true}
   }
   if(moved)onEvent('move',{position:mover.position});
   return moved;
  },
  dispose(){
   tryDrop(false);
   canvas.removeEventListener('pointerdown',onPointerDown);
   canvas.removeEventListener('pointermove',onPointerMove);
   canvas.removeEventListener('pointerup',onPointerUp);
   canvas.removeEventListener('pointercancel',onPointerCancel);
   canvas.removeEventListener('contextmenu',onContextMenu);
   canvas.removeEventListener('wheel',onWheel);
   removeEventListener('keydown',onKeyDown);
   removeEventListener('keyup',onKeyUp);
   removeEventListener('blur',onBlur);
   document.removeEventListener?.('pointerlockchange',onLockChange);
   document.removeEventListener?.('pointerlockerror',onLockError);
   reticle.dispose();overlay.dispose();
   keys.clear();drag=null;aim=null;
  },
 };
}

export {grabbableOf};
