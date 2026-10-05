// Hand-only VR locomotion, derived entirely from XRHand joints -- WebXR exposes no eye-tracking
// data and no microgesture events (Meta's microgestures are OpenXR-native only), so "finger gun to
// aim, thumb-tap to shoot, thumb-swipe to turn" has to be read out of joint geometry every frame.
// Everything below fingerCurl and down is pure: plain {x,y,z} objects in, booleans/vectors out, so
// it runs under `node --test` with no GL and is exercised with tests/helpers/synthetic-hand.js.
// readJoints is the one seam that touches a renderer object, and only to copy world positions out.
import * as THREE from 'three';

// The 25 XRHand joints this module reads. Same set and names tests/helpers/synthetic-hand.js
// fabricates, so a test's joint map and a real XRHand's are interchangeable here.
export const JOINT_NAMES=[
 'wrist',
 'thumb-metacarpal','thumb-phalanx-proximal','thumb-phalanx-distal','thumb-tip',
 'index-finger-metacarpal','index-finger-phalanx-proximal','index-finger-phalanx-intermediate','index-finger-phalanx-distal','index-finger-tip',
 'middle-finger-metacarpal','middle-finger-phalanx-proximal','middle-finger-phalanx-intermediate','middle-finger-phalanx-distal','middle-finger-tip',
 'ring-finger-metacarpal','ring-finger-phalanx-proximal','ring-finger-phalanx-intermediate','ring-finger-phalanx-distal','ring-finger-tip',
 'pinky-finger-metacarpal','pinky-finger-phalanx-proximal','pinky-finger-phalanx-intermediate','pinky-finger-phalanx-distal','pinky-finger-tip',
];
const INDEX_CHAIN=['index-finger-metacarpal','index-finger-phalanx-proximal','index-finger-phalanx-intermediate','index-finger-phalanx-distal','index-finger-tip'];

// The chain fingerCurl walks per finger -- metacarpal to tip, thumb short one joint because it has
// no intermediate phalanx. Keyed the same way hand-pose.js's CHAINS/FINGERS are, so a caller moving
// between the two modules is not translating names.
export const CHAINS={
 'thumb':['thumb-metacarpal','thumb-phalanx-proximal','thumb-phalanx-distal','thumb-tip'],
 'index-finger':INDEX_CHAIN,
 'middle-finger':['middle-finger-metacarpal','middle-finger-phalanx-proximal','middle-finger-phalanx-intermediate','middle-finger-phalanx-distal','middle-finger-tip'],
 'ring-finger':['ring-finger-metacarpal','ring-finger-phalanx-proximal','ring-finger-phalanx-intermediate','ring-finger-phalanx-distal','ring-finger-tip'],
 'pinky-finger':['pinky-finger-metacarpal','pinky-finger-phalanx-proximal','pinky-finger-phalanx-intermediate','pinky-finger-phalanx-distal','pinky-finger-tip'],
};

// ---------------------------------------------------------------------------------------------
// Plain-object vector math. Deliberately not THREE.Vector3: every function below readJoints takes
// and returns {x,y,z} literals so this module (and its tests) never needs a renderer or a GL
// context, the same discipline locomotion.js keeps for teleport math.
// ---------------------------------------------------------------------------------------------
const sub=(a,b)=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const add=(a,b)=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const scale=(a,s)=>({x:a.x*s,y:a.y*s,z:a.z*s});
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const length=a=>Math.hypot(a.x,a.y,a.z);
const dist=(a,b)=>length(sub(a,b));
const normalize=a=>{const l=length(a);return l>1e-9?scale(a,1/l):{x:0,y:0,z:0};};
const cross=(a,b)=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
const clamp01=v=>Math.min(1,Math.max(0,v));
// Closest distance from point `p` to the segment a->b. Used both for "is the thumb resting on the
// index" (shoot) and "is the thumb resting on the index base" (the D-pad posture for swipe) --
// a point can be closest to the middle of a segment, not just one of its ends.
function pointSegmentDistance(p,a,b){
 const ab=sub(b,a),denom=dot(ab,ab)||1e-9,t=clamp01(dot(sub(p,a),ab)/denom);
 return dist(p,add(a,scale(ab,t)));
}

// Adapter from a renderer XRHand (or anything shaped like one -- see tests/helpers/synthetic-hand.js)
// to the plain joint map every other function in this module consumes. Returns null rather than a
// partial map when the wrist, thumb-tip, or any index joint is not visible: those are load-bearing
// for every gesture below (aim needs the whole index chain; shoot and swipe both reference the
// thumb against it), so a caller with a hole there has nothing usable regardless of which gesture
// it wants -- "no joints -> no gesture locomotion" is the intended degrade, not a fallback.
const worldTarget=new THREE.Vector3();
export function readJoints(hand){
 if(!hand?.joints)return null;
 const wrist=hand.joints.wrist,thumbTip=hand.joints['thumb-tip'];
 if(!wrist?.visible||!thumbTip?.visible)return null;
 for(const name of INDEX_CHAIN)if(!hand.joints[name]?.visible)return null;
 const joints={};
 for(const name of JOINT_NAMES){
  const joint=hand.joints[name];
  if(!joint?.visible)continue;
  const p=joint.getWorldPosition(worldTarget);
  joints[name]={x:p.x,y:p.y,z:p.z};
 }
 return joints;
}

// 0 straight, 1 fist: the finger's bend summed over the joints that actually hinge -- the knuckle
// where the proximal phalanx meets the metacarpal, then the two finger joints -- normalised so 90
// degrees at every hinge reads as 1. The metacarpal is deliberately NOT part of this. It is rigid to
// the palm, and the chord-over-chain-length read this replaces counted it: the metacarpal is the
// longest link in the chain and never folds, so a real fist topped out near .5 and the finger-gun
// posture could not arm on a headset -- while the synthetic test rig, which hinged the metacarpal
// too, passed comfortably. Angles are also size-free, so a small or large hand reads the same with
// no bind-pose reference. Missing joints (a chain this finger's tracking has not resolved) read as
// 0, not a thrown error, in keeping with the "no joints -> nothing fires" rule above.
export function fingerCurl(joints,finger){
 const chain=CHAINS[finger];
 if(!chain||!joints)return 0;
 let bend=0;
 for(let i=1;i<chain.length-1;i++){
  const a=joints[chain[i-1]],b=joints[chain[i]],c=joints[chain[i+1]];
  if(!a||!b||!c)return 0;
  bend+=Math.acos(Math.max(-1,Math.min(1,dot(normalize(sub(b,a)),normalize(sub(c,b))))));
 }
 return clamp01(bend/((chain.length-2)*Math.PI/2));
}

// Every threshold gesture locomotion runs on, in one place, same discipline as GRIP_TUNE
// (controller-hand.js) and HAND_RAY_ORIGIN (xr-ray.js). None of these have been run on real hand
// tracking yet -- they were chosen from the synthetic-hand geometry tests exercise, not a headset --
// so treat all of them as device-validation outstanding until confirmed on Quest 3 and Vision Pro.
export const GESTURE_TUNE={
 fingerGun:{
  indexCurlMax:.3,   // index has to be visibly straight/relaxed (under ~80 degrees of bend summed
                      // over its three hinges), not just "less curled than the others" -- this is
                      // Meta's own microgesture rest posture, thumb included:
                      // the thumb resting on the index is normal, not a disqualifier (see contact
                      // below), which is why there is no thumb-clearance condition here at all
  otherCurlMin:.5,   // middle/ring/pinky folded into the palm -- this is what makes it read as a
                      // fist-with-a-barrel rather than an open hand with one finger pointed. .5 is
                      // 135 degrees of bend summed over the three hinges: a loosely folded finger
                      // clears it, a fist (~250 degrees) clears it easily, an open hand at rest
                      // (~60-90 degrees) does not
 },
 // The vertical fist: every finger folded, the index included. This is the posture Meta's own
 // microgesture material shows for the thumb swipe -- a closed hand held upright with the thumb
 // lying across the top of it -- and it is deliberately a DIFFERENT posture from the finger gun,
 // which keeps the index out. One posture, one meaning: the gun aims and taps to teleport, the
 // fist swipes to turn, and because the gun needs the index straight and the fist needs it folded
 // a frame can never read as both.
 fist:{
  curlMin:.5,       // the same fold the gun asks of its other three fingers, now asked of all four
 },
 // The thumb-on-index touch that both a tap and a swipe start from. beginBelow/endAbove are a
 // hysteresis pair (same shape as the old rearm band) so a thumb sitting right at the edge of the
 // segment cannot chatter contact on and off every frame.
 contact:{
  beginBelow:.022,  // thumb-tip within ~2 cm of the index's proximal->intermediate segment counts
                     // as touching down
  endAbove:.04,     // has to clear back out past a wider gap to count as lifted -- the dead band
                     // between the two is what stops one resting drop from toggling repeatedly
 },
 // What turns a touch, while it is still down, into a swipe.
 swipe:{
  minTravel:.018,  // ~1.8 cm of thumb travel ACROSS the fist, measured from where contact began,
                    // reads as a deliberate slide rather than a stationary tap. Shorter than the
                    // along-the-finger travel this replaced: the thumb has less room to move
                    // sideways over the knuckles than it does running down the index
  maxWindow:.3,     // ...but only if that travel is reached within 300 ms of touching down. This
                     // doubles as the speed floor (minTravel/maxWindow is ~0.07 m/s) without a
                     // separate minSpeed constant to keep in sync with it
  cooldown:.4,      // 400 ms dead time after a swipe fires, so one slide cannot register as two,
                     // and a second contact started right after cannot immediately swipe again
 },
 // What turns a touch, once it lifts, into a tap (shoot).
 tap:{
  maxDuration:.35,  // release within 350 ms of touching down, having travelled less than
                     // swipe.minTravel, and it reads as a deliberate tap -- longer than this is
                     // the thumb simply resting on the index between gestures, not a shot
 },
};

// True when `joints` reads as the finger-gun/D-pad hand SHAPE: index extended (or resting, not
// curled into a hook), other three fingers folded into the palm. This is deliberately the WHOLE
// armed condition -- no thumb position enters into it. Meta's real microgesture rest posture has
// the thumb sitting on the side of the index the entire time the hand is "armed"; a thumb-clearance
// check here would make that posture unable to aim at all, and would force a fresh disarm/rearm
// every time the thumb touches down to tap or swipe. The thumb only matters to the CONTACT model in
// createGestureTracker() below, which reads where the thumb is relative to the index, not whether
// it is touching.
export function isFingerGun(joints,tune=GESTURE_TUNE){
 if(!joints)return false;
 if(fingerCurl(joints,'index-finger')>=tune.fingerGun.indexCurlMax)return false;
 return ['middle-finger','ring-finger','pinky-finger'].every(finger=>fingerCurl(joints,finger)>=tune.fingerGun.otherCurlMin);
}

// True when `joints` reads as the vertical fist: all four fingers folded into the palm. The thumb
// is not part of this, exactly as it is not part of isFingerGun -- it rests on top of the fist for
// the whole gesture, and a clearance test here would make the posture unable to hold itself.
export function isMicrogestureFist(joints,tune=GESTURE_TUNE){
 if(!joints)return false;
 return ['index-finger','middle-finger','ring-finger','pinky-finger'].every(finger=>fingerCurl(joints,finger)>=tune.fist.curlMin);
}

// The frame a thumb swipe is measured in, on a closed fist: which way is "across the top of the
// fist", and which way is off it. Returns null when the hand cannot define the frame rather than
// guessing, the same rule readJoints follows.
//   along   -- the index's proximal phalanx, knuckle to first joint. On a closed fist this is the
//              ridge the thumb lies on, pointing away from the wrist.
//   across  -- index knuckle toward pinky knuckle, squared off against `along`. This is the
//              direction the thumb actually travels when it slides over the top of the fist, and
//              it is derived from the hand's own joints, so a left hand mirrors it for free.
//   normal  -- off the top face of the fist, on the side the thumb is resting.
export function fistFrame(joints){
 const proximal=joints?.['index-finger-phalanx-proximal'],intermediate=joints?.['index-finger-phalanx-intermediate'],
       indexKnuckle=joints?.['index-finger-metacarpal'],pinkyKnuckle=joints?.['pinky-finger-metacarpal'],thumbTip=joints?.['thumb-tip'];
 if(!proximal||!intermediate||!indexKnuckle||!pinkyKnuckle||!thumbTip)return null;
 const along=normalize(sub(intermediate,proximal));
 if(!along.x&&!along.y&&!along.z)return null;
 const raw=sub(pinkyKnuckle,indexKnuckle);
 const across=normalize(sub(raw,scale(along,dot(raw,along))));
 if(!across.x&&!across.y&&!across.z)return null;
 let normal=normalize(cross(across,along));
 if(!normal.x&&!normal.y&&!normal.z)return null;
 // Put the normal on the side the thumb is actually resting, so the hint floats off the top of the
 // fist and not through it. A thumb sitting exactly in the plane keeps the derived side, which is
 // deterministic rather than arbitrary.
 if(dot(normal,sub(thumbTip,proximal))<0)normal=scale(normal,-1);
 return {along,across,normal};
}

// Where the finger-gun points: origin at the index tip (where a beam should visually leave from),
// direction from the proximal knuckle through the tip (the straightest read of the finger's aim --
// using the tip alone would have nothing to define a direction from).
export function fingerGunAim(joints){
 const tip=joints?.['index-finger-tip'],proximal=joints?.['index-finger-phalanx-proximal'];
 if(!tip||!proximal)return null;
 return {origin:{x:tip.x,y:tip.y,z:tip.z},direction:normalize(sub(tip,proximal))};
}

// Which way a thumb swipe ACROSS the fist turns the rig, per hand. "towardPinky" is the thumb
// sliding over the knuckles away from the index, which on a right hand held up is a leftward
// sweep -- so it turns left, and the mirrored sweep on a left hand turns right. This mapping is
// still the part most likely to flip after real device testing: it is reasoned from the hand's
// own geometry, not measured against a headset. If a slide turns the wrong way on device, flip
// the two signs here and nothing else.
export const SWIPE_TURN={right:{towardPinky:-1},left:{towardPinky:1}};

// Tracks one hand's gesture state across frames. `handedness` only feeds SWIPE_TURN; everything
// else is symmetric. One posture (isFingerGun) covers both aiming and the D-pad: a tap and a swipe
// are just two different endings for the same thumb-on-index CONTACT, told apart by how far the
// thumb travelled before it lifted (or while it is still down, for a swipe -- which can fire before
// release at all). That single contact object is the only latched state this needs.
export function createGestureTracker({handedness='right',tune=GESTURE_TUNE}={}){
 let contact=null,cooldownUntil=-Infinity,posture=null;
 function reset(){contact=null;cooldownUntil=-Infinity;posture=null;}
 const nothing=()=>({armed:false,fist:false,aim:null,frame:null,shoot:false,swipe:null,turn:0});
 function update(joints,nowSeconds){
  if(!joints){reset();return nothing();}
  // The two postures are mutually exclusive -- the gun wants the index straight, the fist wants it
  // folded -- so this is a single read with no precedence rule to get wrong.
  const armed=isFingerGun(joints,tune),fist=!armed&&isMicrogestureFist(joints,tune);
  const current=armed?'gun':fist?'fist':null;
  const aim=armed?fingerGunAim(joints):null,frame=fist?fistFrame(joints):null;
  let shoot=false,swipe=null,turn=0;

  // Changing posture mid-touch abandons the contact rather than carrying it across: a thumb that
  // was resting on a finger gun must not complete as a swipe the moment the index curls.
  if(current!==posture){contact=null;posture=current;}

  if(!current){
   // Letting the posture go mid-touch is not a deliberate release -- it ends the contact silently,
   // the same way losing joint tracking does, rather than reading as a tap or a swipe.
   contact=null;
  }else{
   const thumbTip=joints['thumb-tip'],indexProximal=joints['index-finger-phalanx-proximal'],indexIntermediate=joints['index-finger-phalanx-intermediate'];
   if(thumbTip&&indexProximal&&indexIntermediate){
    // Contact is the thumb resting on the index's proximal phalanx -- the ridge along the top of a
    // closed fist, and the side of the finger on a gun. The same segment serves both.
    const gap=pointSegmentDistance(thumbTip,indexProximal,indexIntermediate);
    if(!contact){
     if(gap<tune.contact.beginBelow){
      // A swipe is measured across the fist (fistFrame's `across`), which is the way the thumb
      // travels when it slides over the knuckles. A gun has no swipe, so it needs no axis and
      // stores none -- its contact only has to time a tap.
      const axis=frame?.across??null;
      contact={t0:nowSeconds,axis,p0:axis?dot(sub(thumbTip,indexProximal),axis):0,travel:0,consumed:false};
     }
    }else{
     const elapsed=nowSeconds-contact.t0;
     if(contact.axis){
      const displacement=dot(sub(thumbTip,indexProximal),contact.axis)-contact.p0;
      if(Math.abs(displacement)>contact.travel)contact.travel=Math.abs(displacement);
      if(fist&&!contact.consumed&&nowSeconds>=cooldownUntil&&contact.travel>=tune.swipe.minTravel&&elapsed<=tune.swipe.maxWindow){
       // Fires the instant the threshold is crossed, which may be several frames before release --
       // a swipe is a live slide, not something that waits for the thumb to lift.
       swipe=displacement>0?'toward-pinky':'toward-index';
       turn=Math.sign(displacement)*(SWIPE_TURN[handedness]?.towardPinky??-1);
       contact.consumed=true;cooldownUntil=nowSeconds+tune.swipe.cooldown;
      }
     }
     if(gap>tune.contact.endAbove){
      // Release. A short, low-travel touch on the GUN is a tap, and commits the teleport it was
      // aiming. The fist has no tap: its thumb rests there between swipes, and a rest is not a
      // command. Anything else ends the contact with nothing.
      if(armed&&!contact.consumed&&elapsed<=tune.tap.maxDuration&&contact.travel<tune.swipe.minTravel)shoot=true;
      contact=null;
     }
    }
   }
  }

  return {armed,fist,aim,frame,shoot,swipe,turn};
 }
 return {update,reset};
}
