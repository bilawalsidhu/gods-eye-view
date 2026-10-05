import test from 'node:test';
import assert from 'node:assert/strict';
import {SPRING,springStep,springVec,settled,smoothing,responseFor} from '../src/spring.js';

const run=(target,steps=240,dt=1/60,opts=SPRING)=>{
 let value=0,velocity=0,peak=0;
 for(let i=0;i<steps;i++){({value,velocity}=springStep(value,velocity,target,dt,opts));peak=Math.max(peak,value)}
 return {value,velocity,peak};
};

test('a critically damped spring arrives and stops without overshooting',()=>{
 const {value,velocity,peak}=run(1);
 assert.ok(Math.abs(value-1)<1e-3,`settles on the target: ${value}`);
 assert.ok(Math.abs(velocity)<1e-2,'and comes to rest');
 assert.ok(peak<=1+1e-9,`damping 1.0 means it never goes past: ${peak}`);
});

test('a stiffer response settles sooner, which is what per-kind carry weight is made of',()=>{
 const after=(hz,steps)=>run(1,steps,1/60,{...SPRING,response:responseFor(hz)}).value;
 // Weight is felt in the first few frames, not in where the object eventually ends up.
 const instrument=after(14,2),battery=after(7,2);
 assert.ok(instrument>battery+.2,`a hand instrument leads a battery early on: ${instrument} vs ${battery}`);
 assert.ok(after(14,6)>.99&&after(7,6)>.9,'and both have essentially arrived within a tenth of a second');
 assert.equal(responseFor(14),1/14);
 assert.ok(Number.isFinite(responseFor(0)),'a zero stiffness does not divide by zero');
});

test('a stiff spring stays stable at a normal frame time instead of diverging',()=>{
 // Regression. Semi-implicit Euler needs 2*damping*w*h below 2, and a 14 Hz hold point is
 // w = 88 rad/s: integrated in one 1/60 s step it ran away to -2e6 within a fifth of a second,
 // which on screen is a carried object vanishing. springStep subdivides the frame instead.
 for(const hz of [7,10,14,20,30,60]){
  for(const dt of [1/30,1/60,1/120,1/144]){
   const {value,velocity,peak}=run(1,Math.ceil(.5/dt),dt,{...SPRING,response:responseFor(hz)});
   assert.ok(Number.isFinite(value)&&Number.isFinite(velocity),`${hz} Hz at ${Math.round(1/dt)} fps stays finite`);
   assert.ok(Math.abs(value-1)<1e-3,`${hz} Hz at ${Math.round(1/dt)} fps arrives: ${value}`);
   assert.ok(peak<=1+1e-6,`${hz} Hz at ${Math.round(1/dt)} fps does not overshoot: ${peak}`);
  }
 }
});

test('the same elapsed time produces the same motion at any frame rate',()=>{
 // Substepping is what buys this: a hold point must not become snappier on a faster machine.
 const at=(dt,seconds)=>run(1,Math.round(seconds/dt),dt,{...SPRING,response:responseFor(14)}).value;
 assert.ok(Math.abs(at(1/60,.05)-at(1/120,.05))<5e-3,'60 and 120 fps agree a twentieth of a second in');
 assert.ok(Math.abs(at(1/60,.2)-at(1/144,.2))<1e-3);
});

test('the dt clamp keeps a frame hitch from detonating the integrator',()=>{
 // A tab left in the background returns with a multi-second dt. Unclamped, the semi-implicit
 // step would launch the value somewhere absurd and the object would appear to teleport.
 const hitch=springStep(0,0,1,5);
 assert.ok(Number.isFinite(hitch.value)&&Math.abs(hitch.value)<=1,`clamped to maxStep: ${hitch.value}`);
 assert.deepEqual(springStep(.5,2,1,0),{value:.5,velocity:2},'a zero dt changes nothing');
 assert.deepEqual(springStep(.5,2,1,-1),{value:.5,velocity:2},'and neither does a negative one');
});

test('springVec runs one independent spring per axis so a diagonal move stays straight',()=>{
 let pos={x:0,y:0,z:0},vel={x:0,y:0,z:0};
 const target={x:1,y:1,z:1};
 for(let i=0;i<30;i++)({pos,vel}=springVec(pos,vel,target,1/60));
 assert.ok(Math.abs(pos.x-pos.y)<1e-12&&Math.abs(pos.y-pos.z)<1e-12,'equal axes stay equal, so the path does not curve');
 assert.ok(pos.x>0&&pos.x<=1);
});

test('settled is a distance test against the tolerance the caller chose',()=>{
 assert.equal(settled({x:0,y:0,z:0},{x:.01,y:0,z:0}),true);
 assert.equal(settled({x:0,y:0,z:0},{x:.03,y:0,z:0}),false);
 assert.equal(settled({x:0,y:0,z:0},{x:.03,y:0,z:0},{...SPRING,settleDistance:.1}),true);
});

test('smoothing is frame-rate independent',()=>{
 // Two half-steps must land where one whole step does, or a follow speeds up with the frame rate.
 const once=smoothing(9,1/30),twice=1-(1-smoothing(9,1/60))**2;
 assert.ok(Math.abs(once-twice)<1e-12);
 assert.equal(smoothing(9,0),0);
 assert.equal(smoothing(9,-1),0,'a negative dt never rewinds a follow');
});
