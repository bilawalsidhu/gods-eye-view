import test from 'node:test';
import assert from 'node:assert/strict';
import {boxDistance,grabDistance,grabRadius,shapeCenter,outlineBox,holdDistanceClamp,carryTarget,screenRadius,gestureLatch,limit,qMul,qRotate,qConj,VelocityTracker,MIN_HOLD,MAX_HOLD,HOLD_CLEARANCE,THROW_SPEED_LIMIT} from '../src/grab.js';

const IDENTITY={x:0,y:0,z:0,w:1};
const yaw=a=>({x:0,y:Math.sin(a/2),z:0,w:Math.cos(a/2)});
// A stand-in for the cannon bodies the interaction layer passes in: only the fields this module
// reads, so the tests never need the engine.
const boxBody=(position,half,quaternion=IDENTITY,offset)=>({position,quaternion,shapes:[{halfExtents:half}],shapeOffsets:offset?[offset]:undefined});
const sphereBody=(position,radius)=>({position,quaternion:IDENTITY,shapes:[{radius}]});

test('box distance measures to the surface, is zero inside, and follows the box when it turns',()=>{
 const half={x:.1,y:.2,z:.3},center={x:0,y:0,z:0};
 assert.equal(boxDistance(center,center,IDENTITY,half),0,'the centre is inside');
 assert.equal(boxDistance({x:.05,y:.1,z:.1},center,IDENTITY,half),0,'anywhere inside is zero');
 assert.ok(Math.abs(boxDistance({x:.5,y:0,z:0},center,IDENTITY,half)-.4)<1e-9,'0.5 m out along x is 0.4 m clear of a 0.1 m half extent');
 // Turned a quarter turn, the 0.3 m half depth now faces +x, so the same point is far nearer.
 assert.ok(Math.abs(boxDistance({x:.5,y:0,z:0},center,yaw(Math.PI/2),half)-.2)<1e-9);
});

test('grab distance and radius read the shape offset, not the body origin',()=>{
 // Every model here pivots at its base, so the shape sits above the body position. Measuring from
 // the body origin instead would report a battery as a third of a metre further away than it is.
 const item={body:boxBody({x:0,y:0,z:0},{x:.09,y:.14,z:.13},IDENTITY,{x:0,y:.14,z:0})};
 assert.deepEqual(shapeCenter(item.body),{x:0,y:.14,z:0});
 assert.ok(Math.abs(grabDistance(item,{x:0,y:.14,z:0}))<1e-9,'the shape centre is inside the shape');
 assert.ok(Math.abs(grabDistance(item,{x:0,y:.54,z:0})-.26)<1e-9);
 assert.ok(Math.abs(grabRadius(item)-Math.hypot(.09,.14,.13))<1e-9);
 const ball={body:sphereBody({x:1,y:0,z:0},.25)};
 assert.ok(Math.abs(grabDistance(ball,{x:2,y:0,z:0})-.75)<1e-9);
 assert.equal(grabRadius(ball),.25);
 assert.equal(grabDistance({body:{position:{x:0,y:0,z:0},quaternion:IDENTITY,shapes:[]}},{x:0,y:0,z:0}),Infinity,'a body with no shape is never the nearest');
 assert.equal(grabRadius(null),0);
});

test('the outline box is the shape, placed and turned like the shape',()=>{
 const item={body:boxBody({x:1,y:0,z:0},{x:.09,y:.14,z:.13},yaw(Math.PI/2),{x:0,y:.14,z:0})};
 const outline=outlineBox(item);
 assert.deepEqual(outline.scale,{x:.18,y:.28,z:.26},'scale is the full extent, not the half');
 assert.ok(Math.abs(outline.position.y-.14)<1e-9,'the offset is rotated into world space with the body');
 assert.deepEqual(outline.quaternion,yaw(Math.PI/2));
 assert.deepEqual(outlineBox({body:sphereBody({x:0,y:0,z:0},.2)}).scale,{x:.4,y:.4,z:.4});
 assert.equal(outlineBox({body:{shapes:[{}]}}),null,'a shape with no extent draws no outline');
 assert.equal(outlineBox(null),null);
});

test('hold distance keeps a big object off the near plane and never inverts its own bounds',()=>{
 assert.equal(holdDistanceClamp(1,.1),1,'a comfortable distance is left alone');
 assert.equal(holdDistanceClamp(.05,0),MIN_HOLD,'closer than the minimum is pushed out');
 assert.equal(holdDistanceClamp(9,0),MAX_HOLD);
 // A 0.4 m radius object may not be held at 0.35 m or it fills the view: the floor rises with it.
 assert.ok(Math.abs(holdDistanceClamp(.35,.4)-(.4+HOLD_CLEARANCE))<1e-9);
 // An object too big for the normal range at all still gets a usable distance rather than a
 // range whose floor is above its ceiling.
 const huge=holdDistanceClamp(1,5);
 assert.ok(huge>=5+HOLD_CLEARANCE&&Number.isFinite(huge));
});

test('the carry target stops short of the surface the aim ray hits',()=>{
 const origin={x:0,y:1.6,z:0},forward={x:0,y:0,z:-1};
 assert.deepEqual(carryTarget(origin,forward,1,{}),{x:0,y:1.6,z:-1,distance:1});
 // A wall 0.8 m away and an object of 0.2 m radius: the hold point lands at 0.6 m, so the object
 // rests against the wall instead of being pushed through it.
 assert.ok(Math.abs(carryTarget(origin,forward,1.5,{surfaceDistance:.8,radius:.2}).distance-.6)<1e-9);
 // Pressed right up against a wall, the hold point never collapses into the camera.
 assert.equal(carryTarget(origin,forward,1.5,{surfaceDistance:.1,radius:.2}).distance,MIN_HOLD);
 assert.equal(carryTarget(origin,forward,1.2,{surfaceDistance:Infinity}).distance,1.2,'open air uses the requested distance');
});

test('screen radius reports how big a hit sphere actually is to click on',()=>{
 const fov=58*Math.PI/180,height=1000;
 const near=screenRadius(.03,1,fov,height),far=screenRadius(.03,3,fov,height);
 assert.ok(near>25&&near<30,`a terminal at 1 m is a comfortable target: ${near}`);
 assert.ok(Math.abs(near/far-3)<1e-9,'apparent size falls off linearly with distance');
 assert.equal(screenRadius(.03,0,fov,height),Infinity,'a degenerate distance never reports a tiny target');
 assert.equal(screenRadius(.03,1,0,height),Infinity);
});

test('the gesture latch needs a closer approach to engage than to hold',()=>{
 assert.equal(gestureLatch(.03,false),false,'0.03 is outside the enter threshold');
 assert.equal(gestureLatch(.03,true),true,'but inside the exit threshold once engaged');
 assert.equal(gestureLatch(.02,false),true);
 assert.equal(gestureLatch(.05,true),false);
});

test('limit caps a vector without turning it',()=>{
 assert.deepEqual(limit({x:1,y:0,z:0},8),{x:1,y:0,z:0});
 const capped=limit({x:300,y:0,z:0},THROW_SPEED_LIMIT);
 assert.ok(Math.abs(Math.hypot(capped.x,capped.y,capped.z)-THROW_SPEED_LIMIT)<1e-9);
 assert.deepEqual(limit({x:0,y:0,z:0},8),{x:0,y:0,z:0},'a still hand does not divide by zero');
});

test('quaternion helpers compose and rotate the way three does',()=>{
 const half=yaw(Math.PI/2),turned=qRotate(half,{x:1,y:0,z:0});
 assert.ok(Math.abs(turned.x)<1e-9&&Math.abs(turned.z+1)<1e-9,'+x yaws to -z');
 const back=qRotate(qConj(half),turned);
 assert.ok(Math.abs(back.x-1)<1e-9,'the conjugate undoes it');
 const full=qMul(half,half);
 assert.ok(Math.abs(Math.abs(full.y)-1)<1e-9&&Math.abs(full.w)<1e-9,'two quarter turns make a half turn');
});

test('the velocity tracker reports hand speed and spin, and forgets on clear',()=>{
 const tracker=new VelocityTracker();
 assert.deepEqual(tracker.linear(),{x:0,y:0,z:0},'one sample or none is not a velocity');
 tracker.push({x:0,y:1,z:0},IDENTITY,0);
 assert.deepEqual(tracker.linear(),{x:0,y:0,z:0});
 tracker.push({x:0,y:1,z:-.4},IDENTITY,.1);
 assert.ok(Math.abs(tracker.linear().z+4)<1e-9,'0.4 m in 0.1 s is 4 m/s');
 // Two samples at the same instant would divide by zero; the span is rejected instead.
 const stalled=new VelocityTracker();
 stalled.push({x:0,y:0,z:0},IDENTITY,1);stalled.push({x:1,y:0,z:0},IDENTITY,1);
 assert.deepEqual(stalled.linear(),{x:0,y:0,z:0});
 const spin=new VelocityTracker();
 spin.push({x:0,y:0,z:0},IDENTITY,0);spin.push({x:0,y:0,z:0},yaw(Math.PI/2),.5);
 assert.ok(Math.abs(spin.angular().y-Math.PI)<1e-6,'a quarter turn in half a second is pi rad/s');
 spin.clear();
 assert.deepEqual(spin.angular(),{x:0,y:0,z:0});
 // Only the window is kept, so a throw reads the last moment of the gesture rather than its start.
 const window=new VelocityTracker(2);
 for(let i=0;i<5;i++)window.push({x:i,y:0,z:0},IDENTITY,i);
 assert.equal(window.samples.length,2);
});
