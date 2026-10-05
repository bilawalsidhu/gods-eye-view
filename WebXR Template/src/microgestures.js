// Meta's own hand-tracking microgestures as WebXR sees them: Quest Browser 38.1+ reports a tracked
// hand as an `oculus-hand` input source whose gamepad carries the five thumb inputs as buttons.
// Unlike hand-gestures.js (finger gun / fist, read out of joint geometry every frame) the headset's
// recognizer makes the call here, so this module only has to edge-detect five booleans, gate them
// the way Meta's locomotion design does, and report what the hand asked for.
// Pure -- plain objects in, plain objects out -- so it runs under `node --test` with no renderer.
import {fingerCurl} from './hand-gestures.js';

// Button order from the oculus-hand profile in immersive-web/webxr-input-profiles (same on both
// hands; buttons 0-3 are the generic-hand select/squeeze slots and 4 is the left hand's menu).
export const MICROGESTURE_BUTTON={swipeLeft:5,swipeRight:6,swipeForward:7,swipeBackward:8,tapThumb:9};
export const MICROGESTURE_PROFILE='oculus-hand';

// None of these have been run on a headset -- chosen from Meta's Interaction SDK locomotion notes
// ("rolling the wrist more than 45 degrees will exit locomotion, extending the index finger will
// exit locomotion") and ordinary comfort, so all are device-validation outstanding on Quest 3.
export const MICROGESTURE_TUNE={
 exitRoll:Math.PI/4,   // wrist rolled this far from where locomotion began hands the hand back
 indexExtended:.12,    // fingerCurl of the index below this is a pointing finger, not a resting one
                       // (hand-gestures.js reads .3 as "straight" for the gun; a microgesture hand
                       // rests with the index softly bent, so this is deliberately tighter)
 idleTimeout:8,        // seconds with no microgesture before locomotion drops on its own, so a
                       // hand that was never rolled away cannot sit armed for a whole lesson
 turnAngle:Math.PI/6,  // the same 30 degree snap turn the thumbstick and finger-fist paths use
 stepDistance:.35,     // one swipe forward or back
};

// True when this input source can report microgestures. The profile name is the real signal; a
// hand whose gamepad carries at least the ten profile buttons is accepted too, for a runtime that
// reports them without naming the profile.
export function hasMicrogestures(source){
 if(!source?.hand)return false;
 if(source.profiles?.includes(MICROGESTURE_PROFILE))return true;
 return (source.gamepad?.buttons?.length??0)>MICROGESTURE_BUTTON.tapThumb;
}

const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const unit=a=>{const l=Math.hypot(a.x,a.y,a.z);return l>1e-9?{x:a.x/l,y:a.y/l,z:a.z/l}:null;};
const reject=(a,axis)=>{const d=dot(a,axis);return {x:a.x-axis.x*d,y:a.y-axis.y*d,z:a.z-axis.z*d};};
const wrap=angle=>Math.atan2(Math.sin(angle),Math.cos(angle));

// How far the wrist is rolled about the forearm, in radians: the knuckle line (index to pinky),
// measured against world up, looking along the hand. 0 is whatever a flat palm-down hand reads;
// only DIFFERENCES between two readings mean anything, which is how the tracker below uses it, so
// the sign convention and the handedness of the hand do not matter. null when the hand is pointing
// nearly straight up or down (no roll to speak of) or a joint is missing.
export function wristRoll(joints){
 const wrist=joints?.['wrist'],middle=joints?.['middle-finger-metacarpal'],index=joints?.['index-finger-metacarpal'],pinky=joints?.['pinky-finger-metacarpal'];
 if(!wrist||!middle||!index||!pinky)return null;
 const forearm=unit(sub(middle,wrist));if(!forearm)return null;
 const knuckles=unit(reject(sub(pinky,index),forearm)),tilted=reject({x:0,y:1,z:0},forearm);
 // A forearm within ~15 degrees of vertical has no meaningful "up" to roll against.
 if(!knuckles||Math.hypot(tilted.x,tilted.y,tilted.z)<.25)return null;
 const up=unit(tilted);
 return Math.atan2(dot(cross(up,knuckles),forearm),dot(up,knuckles));
}

const PRESSED=Object.fromEntries(Object.keys(MICROGESTURE_BUTTON).map(name=>[name,false]));
const idle=(active=false)=>({active,entered:false,exited:null,tap:false,turn:0,step:0});

// One hand's microgesture state. Meta gates locomotion behind a thumb tap, and so does this: a tap
// on a hand that is free (nothing held, no panel, not aiming at UI -- the caller's `enabled`)
// ENTERS locomotion; from then on a tap teleports, a left/right swipe snap-turns, a forward/back
// swipe steps; rolling the wrist past `exitRoll`, extending the index, or going quiet for
// `idleTimeout` leaves it again. Outside locomotion every microgesture is ignored, which is what
// keeps a stray swipe while reaching for a block from turning the room.
export function createMicrogestureTracker({tune=MICROGESTURE_TUNE}={}){
 let previous={...PRESSED},active=false,rollAtEntry=null,lastActivity=0;
 const leave=reason=>{active=false;rollAtEntry=null;return {...idle(),exited:reason};};
 function reset(){previous={...PRESSED};active=false;rollAtEntry=null;}
 // `gamepad` is the input source's XRGamepad, `joints` the readJoints() map (or null -- roll and
 // index checks then simply do not run). `enabled` false means the hand is busy elsewhere (holding
 // something, a panel owns it) and ends locomotion; `canEnter` false only stops a tap from STARTING
 // it, e.g. while the hand's ray rests on a button, and leaves a running session alone.
 function update(gamepad,joints,now,enabled=true,canEnter=true){
  const pressed={};for(const name in MICROGESTURE_BUTTON)pressed[name]=!!gamepad?.buttons?.[MICROGESTURE_BUTTON[name]]?.pressed;
  // Edges are tracked every frame, gated or not, so a swipe made while a panel owned the hand is
  // spent by the time the hand is free again instead of firing the frame it is released.
  const edge={};for(const name in pressed)edge[name]=pressed[name]&&!previous[name];
  previous=pressed;
  if(!gamepad)return active?leave('lost'):idle();
  if(!enabled)return active?leave('busy'):idle();
  if(active){
   if(joints){
    // readJoints() only returns a map with the whole index chain present, so a curl of 0 here is
    // a straight finger, never a missing one.
    if(fingerCurl(joints,'index-finger')<tune.indexExtended)return leave('index');
    const roll=wristRoll(joints);
    if(roll!==null&&rollAtEntry!==null&&Math.abs(wrap(roll-rollAtEntry))>tune.exitRoll)return leave('roll');
   }
   if(now-lastActivity>tune.idleTimeout)return leave('idle');
   const result=idle(true);
   if(edge.tapThumb){result.tap=true;lastActivity=now;}
   // Left and right share the turn sign the snap-turn code already uses: left is +, right is -.
   if(edge.swipeLeft!==edge.swipeRight){result.turn=edge.swipeLeft?1:-1;lastActivity=now;}
   if(edge.swipeForward!==edge.swipeBackward){result.step=edge.swipeForward?1:-1;lastActivity=now;}
   return result;
  }
  // A tap with the index pointed is a poke or a pinch-adjacent flick, and would be thrown straight
  // back out by the exit check above on the next frame, so it never enters.
  if(edge.tapThumb&&canEnter&&!(joints&&fingerCurl(joints,'index-finger')<tune.indexExtended)){active=true;rollAtEntry=wristRoll(joints);lastActivity=now;return {...idle(true),entered:true};}
  return idle();
 }
 return {update,reset,get active(){return active;}};
}
