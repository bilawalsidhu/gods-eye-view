import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {syntheticHand} from './helpers/synthetic-hand.js';
import {readJoints,fingerCurl,isFingerGun,isMicrogestureFist,fistFrame,fingerGunAim,createGestureTracker,GESTURE_TUNE,SWIPE_TURN} from '../src/hand-gestures.js';

// tests/helpers/synthetic-hand.js gives every finger a straight, fully-open pose (fingers along
// +Y). To pose a gesture on top of it, fold a finger like a real hinge: rotate the direction from
// one joint to the next by `angleDeg` around X at each hinge, walking outward. The metacarpal BONE
// stays put -- it is rigid to the palm on a real hand, so the first hinge is the knuckle where the
// proximal phalanx begins, then the two finger joints. (An earlier version of this helper hinged the
// metacarpal as well, which let a curl metric that counted it pass here while a real fist could not
// reach the same threshold.) A single rigid rotation of the whole chain cannot bring the tip
// anywhere near the palm -- it only sweeps a circle at a fixed radius -- so this folds joint by
// joint instead, the way an actual finger curls.
const CHAIN = {
 'thumb': ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
 'index-finger': ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
 'middle-finger': ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
 'ring-finger': ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
 'pinky-finger': ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
};
function curlFinger(hand, finger, angleDeg) {
 const chain = CHAIN[finger], theta = THREE.MathUtils.degToRad(angleDeg);
 const bones = chain.map(name => hand.getObjectByName(name));
 const original = bones.map(bone => bone.position.clone());
 const segments = []; for (let i = 1; i < bones.length; i++) segments.push(original[i].distanceTo(original[i - 1]));
 let direction = original[1].clone().sub(original[0]).normalize(), cursor = bones[0].position.clone();
 for (let i = 1; i < bones.length; i++) { if (i > 1) direction.applyAxisAngle(new THREE.Vector3(1, 0, 0), theta); cursor = cursor.clone().add(direction.clone().multiplyScalar(segments[i - 1])); bones[i].position.copy(cursor); }
 hand.updateMatrixWorld(true);
}
// A "curled fist" shape for the three fingers the finger-gun/D-pad posture keeps folded, shared by
// every fixture below. 75 degrees at each of the three real hinges is 225 of the 270 degrees
// fingerCurl normalises against, about .83 -- comfortably past GESTURE_TUNE.fingerGun.otherCurlMin. The index is left at its default straight
// pose throughout this file: armed no longer distinguishes an "aiming" curl from a "D-pad" curl,
// so every fixture is the same one posture.
function curlGun(hand) { for (const finger of ['middle-finger', 'ring-finger', 'pinky-finger']) curlFinger(hand, finger, 75); }
// The vertical fist: the gun's three folded fingers plus the index. This is the swipe posture, and
// it is what every turn fixture below poses -- a slide on a gun no longer turns anything.
function curlFist(hand) { curlGun(hand); curlFinger(hand, 'index-finger', 75); }
// A thumb resting on top of the closed fist, `t` of the way across it from the index side toward
// the pinky, the way Meta's microgesture material shows it. Contact is measured to the index's
// proximal phalanx and travel is measured across the fist, so a fixture has to sit the thumb on
// the top face rather than beside the finger the way the synthetic rig's rest pose does.
function fistContactPoint(hand, t = 0) {
 const joints = readJoints(fakeHand(hand)), frame = fistFrame(joints);
 const proximal = joints['index-finger-phalanx-proximal'], intermediate = joints['index-finger-phalanx-intermediate'];
 const anchor = new THREE.Vector3(proximal.x, proximal.y, proximal.z).lerp(new THREE.Vector3(intermediate.x, intermediate.y, intermediate.z), 0.5);
 return anchor
  .add(new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).multiplyScalar(0.012))
  .add(new THREE.Vector3(frame.across.x, frame.across.y, frame.across.z).multiplyScalar(t));
}
// Lifted off the top face, with no travel across the fist of its own.
function fistLiftOff(hand, t = 0) {
 const frame = fistFrame(readJoints(fakeHand(hand)));
 return fistContactPoint(hand, t).add(new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z).multiplyScalar(0.05));
}
// Wraps a posed synthetic hand as the {joints:{name:{visible,getWorldPosition}}} shape readJoints()
// expects from a real XRHand, so the same adapter under test sees the same interface either way.
function fakeHand(hand, hide = []) {
 const joints = {};
 hand.traverse(node => { if (node.isBone) joints[node.name] = { visible: !hide.includes(node.name), getWorldPosition: target => node.getWorldPosition(target) }; });
 return { joints };
}
// A point `t` of the way along the index's proximal->intermediate segment -- with the index left
// straight (no curl applied), this is also exactly on the metacarpal->intermediate contact axis,
// so a thumb placed here is both "touching" (small gap to the segment) and has a well-defined
// projection to slide along.
function indexContactPoint(hand, t) {
 const proximal = hand.getObjectByName('index-finger-phalanx-proximal').position, intermediate = hand.getObjectByName('index-finger-phalanx-intermediate').position;
 return proximal.clone().lerp(intermediate, t);
}
function restPosition(hand) { return hand.getObjectByName('thumb-tip').position.clone(); } // the default, well clear of the index
// A release position offset PERPENDICULAR to the (Y-aligned, for a straight index) contact axis --
// well past GESTURE_TUNE.contact.endAbove in distance-to-segment, but with almost no axial
// projection of its own, so lifting the thumb off does not itself register as travel along the
// swipe axis. A real hand lifts off sideways/upward, not by teleporting along the finger.
function liftOff(hand, t) { return indexContactPoint(hand, t).add(new THREE.Vector3(0.08, 0, 0)); }

test('an open hand is not a finger gun', () => {
 const hand = syntheticHand();
 const joints = readJoints(fakeHand(hand));
 assert.equal(isFingerGun(joints), false);
 const tracker = createGestureTracker();
 assert.equal(tracker.update(joints, 0).armed, false);
});

test('the finger-gun/D-pad shape is armed regardless of where the thumb is -- resting on the index does not disqualify it', () => {
 const hand = syntheticHand();
 curlGun(hand);
 const thumbTip = hand.getObjectByName('thumb-tip');
 const away = readJoints(fakeHand(hand)); // default: thumb well clear of the index
 assert.equal(isFingerGun(away), true);
 thumbTip.position.copy(indexContactPoint(hand, 0.5)); hand.updateMatrixWorld(true);
 const touching = readJoints(fakeHand(hand)); // thumb resting directly on the segment
 assert.equal(isFingerGun(touching), true, 'a thumb resting on the index is the normal microgesture posture, not a disarm condition');
 const tracker = createGestureTracker();
 assert.equal(tracker.update(touching, 0).armed, true);
 const aim = fingerGunAim(touching);
 assert.ok(aim.direction.y > 0.99, 'aim is unaffected by thumb position');
});

test('a short touch-and-release with little travel fires exactly one shoot, on the release frame', () => {
 const hand = syntheticHand();
 curlGun(hand);
 const thumbTip = hand.getObjectByName('thumb-tip');
 const touch = indexContactPoint(hand, 0.5), away = liftOff(hand, 0.5);
 const tracker = createGestureTracker({handedness: 'right'});
 let time = 0;
 // Touch down.
 thumbTip.position.copy(touch); hand.updateMatrixWorld(true);
 let result = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(result.shoot, false); assert.equal(result.swipe, null);
 // Hold briefly, well under tap.maxDuration, without moving.
 result = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(result.shoot, false);
 // Lift clear.
 thumbTip.position.copy(away); hand.updateMatrixWorld(true);
 result = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(result.shoot, true, 'released quickly with negligible travel: a tap');
 assert.equal(result.swipe, null);
 // Staying lifted does not refire.
 result = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(result.shoot, false);
});

test('a fast slide across the fist past minTravel within the window swipes, with the turn sign flipped by handedness, and does not also shoot on release', () => {
 for (const [handedness, expectedTurn] of [['right', -1], ['left', 1]]) {
  const hand = syntheticHand({mirror: handedness === 'left'});
  curlFist(hand);
  const thumbTip = hand.getObjectByName('thumb-tip');
  const start = fistContactPoint(hand, 0), end = fistContactPoint(hand, 0.03); // 3 cm across, well beyond minTravel
  thumbTip.position.copy(start); hand.updateMatrixWorld(true);
  const tracker = createGestureTracker({handedness});
  let time = 0, fired = null;
  tracker.update(readJoints(fakeHand(hand)), time);
  for (let step = 1; step <= 6 && !fired; step++) {
   thumbTip.position.copy(start.clone().lerp(end, step / 6));
   hand.updateMatrixWorld(true);
   time += 0.1 / 6;
   const result = tracker.update(readJoints(fakeHand(hand)), time);
   if (result.swipe) fired = result;
  }
  assert.ok(fired, `${handedness} hand: a slide covering the travel threshold inside the window should swipe`);
  assert.equal(fired.swipe, 'toward-pinky');
  assert.equal(fired.turn, expectedTurn);
  assert.equal(SWIPE_TURN[handedness].towardPinky, expectedTurn);
  // Lifting clear afterward must not also fire a shoot -- the fist has no tap at all.
  const away = fistLiftOff(hand, 0.03);
  thumbTip.position.copy(away); hand.updateMatrixWorld(true);
  time += 1 / 60;
  const releaseResult = tracker.update(readJoints(fakeHand(hand)), time);
  assert.equal(releaseResult.shoot, false, 'a swiped contact does not also tap on release');
 }
});

test('a slow slide covering the same distance past the window neither swipes nor shoots', () => {
 const hand = syntheticHand();
 curlFist(hand);
 const thumbTip = hand.getObjectByName('thumb-tip');
 const start = fistContactPoint(hand, 0), end = fistContactPoint(hand, 0.03);
 thumbTip.position.copy(start); hand.updateMatrixWorld(true);
 const tracker = createGestureTracker({handedness: 'right'});
 let time = 0;
 tracker.update(readJoints(fakeHand(hand)), time);
 // Same total travel as the fast fixture (t 0.5 -> 1.6), but spread over 600 ms: minTravel is
 // crossed around 2/3 of the way through (see the fast fixture), so this reaches it only around
 // t=0.4s -- comfortably past swipe.maxWindow (.3s), not just barely over it.
 for (let step = 1; step <= 12; step++) {
  thumbTip.position.copy(start.clone().lerp(end, step / 12));
  hand.updateMatrixWorld(true);
  time += 0.6 / 12;
  const result = tracker.update(readJoints(fakeHand(hand)), time);
  assert.equal(result.swipe, null);
 }
 // Release: the fist has no tap, and this is long past tap.maxDuration besides.
 const away = fistLiftOff(hand, 0.03);
 thumbTip.position.copy(away); hand.updateMatrixWorld(true);
 const result = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(result.shoot, false);
});

test('a long rest with no travel neither swipes nor shoots', () => {
 const hand = syntheticHand();
 curlFist(hand);
 const thumbTip = hand.getObjectByName('thumb-tip');
 const touch = fistContactPoint(hand, 0), away = fistLiftOff(hand, 0);
 thumbTip.position.copy(touch); hand.updateMatrixWorld(true);
 const tracker = createGestureTracker({handedness: 'right'});
 let time = 0;
 for (let step = 0; step < 10; step++) {
  time += 0.06; // ten frames, 600 ms total: past GESTURE_TUNE.tap.maxDuration
  const result = tracker.update(readJoints(fakeHand(hand)), time);
  assert.equal(result.swipe, null); assert.equal(result.shoot, false);
 }
 thumbTip.position.copy(away); hand.updateMatrixWorld(true);
 const result = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(result.shoot, false, 'held far longer than a tap -- this was a rest, not a gesture');
});

test('a second swipe attempt inside the cooldown window does not fire', () => {
 const hand = syntheticHand();
 curlFist(hand);
 const thumbTip = hand.getObjectByName('thumb-tip');
 const start = fistContactPoint(hand, 0), end = fistContactPoint(hand, 0.03), away = fistLiftOff(hand, 0);
 const tracker = createGestureTracker({handedness: 'right'});
 let time = 0, swipes = 0;
 function slide(from, to, duration, steps) {
  for (let step = 1; step <= steps; step++) {
   thumbTip.position.copy(from.clone().lerp(to, step / steps));
   hand.updateMatrixWorld(true);
   time += duration / steps;
   if (tracker.update(readJoints(fakeHand(hand)), time).swipe) swipes++;
  }
 }
 thumbTip.position.copy(start); hand.updateMatrixWorld(true); tracker.update(readJoints(fakeHand(hand)), time);
 slide(start, end, 0.1, 6);
 assert.equal(swipes, 1, 'the first slide swipes once');
 // Lift and immediately touch back down for a second attempt, still well inside GESTURE_TUNE.swipe.cooldown.
 thumbTip.position.copy(away); hand.updateMatrixWorld(true); time += 1 / 60; tracker.update(readJoints(fakeHand(hand)), time);
 thumbTip.position.copy(start); hand.updateMatrixWorld(true); time += 1 / 60; tracker.update(readJoints(fakeHand(hand)), time);
 slide(start, end, 0.1, 6);
 assert.equal(swipes, 1, 'a second slide inside the cooldown is suppressed');
});

test('missing joints degrade honestly: readJoints and the tracker return null/false without throwing', () => {
 assert.equal(readJoints(null), null);
 assert.equal(readJoints({joints: {}}), null);
 const hand = syntheticHand();
 curlGun(hand);
 // Hide a joint the index chain needs -- readJoints must refuse the whole hand, not hand back a
 // map with a hole in it.
 assert.equal(readJoints(fakeHand(hand, ['index-finger-tip'])), null);
 // A joint outside the index chain (say, the pinky tip) missing still leaves a usable map --
 // fingerCurl for that one finger reads 0 rather than throwing.
 const partial = readJoints(fakeHand(hand, ['pinky-finger-tip']));
 assert.ok(partial);
 assert.equal(fingerCurl(partial, 'pinky-finger'), 0);

 const tracker = createGestureTracker();
 assert.deepEqual(tracker.update(null, 0), {armed: false, fist: false, aim: null, frame: null, shoot: false, swipe: null, turn: 0});
 // A contact in progress, then joints drop out: state clears rather than leaving a stale contact
 // that could fire once tracking resumes.
 const thumbTip = hand.getObjectByName('thumb-tip');
 thumbTip.position.copy(indexContactPoint(hand, 0.5)); hand.updateMatrixWorld(true);
 tracker.update(readJoints(fakeHand(hand)), 0);
 tracker.update(null, 0.01);
 thumbTip.position.copy(restPosition(hand)); hand.updateMatrixWorld(true);
 const result = tracker.update(readJoints(fakeHand(hand)), 0.02);
 assert.equal(result.shoot, false, 'the interrupted contact was discarded, not resumed');
 assert.deepEqual(tracker.reset(), undefined);
});

test('fingerCurl reads 0 straight and rises toward 1 as a finger folds, clamped either way', () => {
 const hand = syntheticHand();
 const straight = readJoints(fakeHand(hand));
 assert.ok(fingerCurl(straight, 'middle-finger') < 0.05);
 curlFinger(hand, 'middle-finger', 75);
 const curled = readJoints(fakeHand(hand));
 const curl = fingerCurl(curled, 'middle-finger');
 assert.ok(curl > GESTURE_TUNE.fingerGun.otherCurlMin);
 assert.ok(curl <= 1 && curl >= 0);
 assert.equal(fingerCurl(curled, 'not-a-finger'), 0, 'an unknown finger name is not a crash');
});

// Regression for the headset failure: a fist folded only where a hand can fold. The chord-over-
// chain-length metric this replaced counted the rigid metacarpal in the chain, so on this same
// 90-degree fist it read about .49 -- under otherCurlMin -- and the posture never armed on a real
// hand; the rig had passed only because it hinged the metacarpal too.
test('curl is the summed hinge angle: 90 degrees at each real joint is a fist, 30 is still open, and a rigid swing of a straight finger is not a curl', () => {
 const folded = ['middle-finger', 'ring-finger', 'pinky-finger'];
 const fist = syntheticHand();
 for (const finger of folded) curlFinger(fist, finger, 90);
 const fistJoints = readJoints(fakeHand(fist));
 for (const finger of folded) assert.ok(fingerCurl(fistJoints, finger) > 0.95, `${finger} at 90 degrees per hinge reads as a fist`);
 assert.equal(isFingerGun(fistJoints), true, 'a fist with the index straight is the finger gun');
 const open = syntheticHand();
 for (const finger of folded) curlFinger(open, finger, 30);
 const openJoints = readJoints(fakeHand(open));
 for (const finger of folded) assert.ok(fingerCurl(openJoints, finger) < GESTURE_TUNE.fingerGun.otherCurlMin, `${finger} at 30 degrees per hinge is still open`);
 assert.equal(isFingerGun(openJoints), false, 'a relaxed open hand is not armed');
 // The whole index rotated as one rigid piece about its base: every hinge is still straight, so
 // the read must be straight too -- pointing a stiff finger somewhere else is not curling it.
 const swung = syntheticHand(), bones = CHAIN['index-finger'].map(name => swung.getObjectByName(name)), origin = bones[0].position.clone();
 for (const bone of bones) bone.position.sub(origin).applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(60)).add(origin);
 swung.updateMatrixWorld(true);
 assert.ok(fingerCurl(readJoints(fakeHand(swung)), 'index-finger') < 0.01, 'a rigid swing of a straight finger is not a curl');
});

test('the vertical fist and the finger gun are different postures, and nothing reads as both', () => {
 const gun = syntheticHand(); curlGun(gun);
 const gunJoints = readJoints(fakeHand(gun));
 assert.equal(isFingerGun(gunJoints), true);
 assert.equal(isMicrogestureFist(gunJoints), false, 'an extended index is not a fist');
 const fist = syntheticHand(); curlFist(fist);
 const fistJoints = readJoints(fakeHand(fist));
 assert.equal(isMicrogestureFist(fistJoints), true);
 assert.equal(isFingerGun(fistJoints), false, 'a folded index is not a gun');
 const open = readJoints(fakeHand(syntheticHand()));
 assert.equal(isMicrogestureFist(open), false, 'an open hand is neither');
 const tracker = createGestureTracker();
 const result = tracker.update(fistJoints, 0);
 assert.equal(result.fist, true); assert.equal(result.armed, false);
 assert.equal(result.aim, null, 'the fist does not aim -- it has no arc');
 assert.ok(result.frame, 'and it carries the frame its hint is drawn in');
});

test('the fist frame is orthonormal, runs across the knuckles, and mirrors with the hand', () => {
 for (const mirror of [false, true]) {
  const hand = syntheticHand({mirror}); curlFist(hand);
  const joints = readJoints(fakeHand(hand)), frame = fistFrame(joints);
  const v = a => new THREE.Vector3(a.x, a.y, a.z);
  for (const axis of ['along', 'across', 'normal']) assert.ok(Math.abs(v(frame[axis]).length() - 1) < 1e-9, `${axis} is a unit direction`);
  assert.ok(Math.abs(v(frame.across).dot(v(frame.along))) < 1e-9, 'across is square to the finger');
  assert.ok(Math.abs(v(frame.normal).dot(v(frame.across))) < 1e-9);
  assert.ok(Math.abs(v(frame.normal).dot(v(frame.along))) < 1e-9);
  // Across points from the index knuckle toward the pinky knuckle, in the hand's own terms, so a
  // mirrored hand mirrors it rather than needing a handedness flag.
  const toPinky = v(joints['pinky-finger-metacarpal']).sub(v(joints['index-finger-metacarpal']));
  assert.ok(v(frame.across).dot(toPinky) > 0, mirror ? 'left hand' : 'right hand');
 }
 assert.equal(fistFrame(null), null);
 assert.equal(fistFrame({}), null);
});

test('a slide on the finger gun does not turn, and a tap on the fist does not shoot', () => {
 // The gun: a deliberate slide along the index. It must not turn -- turning is the fist's job.
 const gun = syntheticHand(); curlGun(gun);
 const gunThumb = gun.getObjectByName('thumb-tip');
 const gunTracker = createGestureTracker({handedness: 'right'});
 const from = indexContactPoint(gun, 0.5), to = indexContactPoint(gun, 1.6);
 gunThumb.position.copy(from); gun.updateMatrixWorld(true);
 let time = 0;
 gunTracker.update(readJoints(fakeHand(gun)), time);
 for (let step = 1; step <= 6; step++) {
  gunThumb.position.copy(from.clone().lerp(to, step / 6)); gun.updateMatrixWorld(true);
  const result = gunTracker.update(readJoints(fakeHand(gun)), time += 0.1 / 6);
  assert.equal(result.turn, 0, 'a gun never turns');
  assert.equal(result.swipe, null);
 }
 // The fist: a short touch and release, which on a gun would be a tap.
 const fist = syntheticHand(); curlFist(fist);
 const fistThumb = fist.getObjectByName('thumb-tip');
 const fistTracker = createGestureTracker({handedness: 'right'});
 fistThumb.position.copy(fistContactPoint(fist, 0)); fist.updateMatrixWorld(true);
 let t2 = 0;
 fistTracker.update(readJoints(fakeHand(fist)), t2 += 1 / 60);
 fistThumb.position.copy(fistLiftOff(fist, 0)); fist.updateMatrixWorld(true);
 const released = fistTracker.update(readJoints(fakeHand(fist)), t2 += 1 / 60);
 assert.equal(released.shoot, false, 'the fist has no tap -- a resting thumb is not a teleport');
});

test('changing posture mid-touch abandons the contact rather than completing it', () => {
 // Thumb down on a gun, then the index curls: the contact must not carry over and complete as a
 // swipe on the fist it just became.
 const hand = syntheticHand(); curlGun(hand);
 const thumbTip = hand.getObjectByName('thumb-tip');
 thumbTip.position.copy(indexContactPoint(hand, 0.5)); hand.updateMatrixWorld(true);
 const tracker = createGestureTracker({handedness: 'right'});
 let time = 0;
 tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 curlFinger(hand, 'index-finger', 75); hand.updateMatrixWorld(true);
 const start = fistContactPoint(hand, 0);
 thumbTip.position.copy(start); hand.updateMatrixWorld(true);
 const turned = tracker.update(readJoints(fakeHand(hand)), time += 1 / 60);
 assert.equal(turned.fist, true);
 assert.equal(turned.turn, 0, 'the carried contact did not complete as a swipe');
});
