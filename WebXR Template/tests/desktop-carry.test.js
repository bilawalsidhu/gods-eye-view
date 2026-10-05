import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import {createDesktopCarry,CARRY} from '../src/desktop-carry.js';
import {MIN_HOLD,MAX_HOLD} from '../src/grab.js';

// A real cannon world, because the whole point of the dynamic driver is what the solver does
// with it. The camera stands at the origin at eye height looking down -z.
function fixture({mass=.45,kinematic=false,gravity=-9.81}={}){
 const world=new CANNON.World({gravity:new CANNON.Vec3(0,gravity,0)});
 world.allowSleep=true;
 const camera=new THREE.PerspectiveCamera(58,1.6,.025,100);
 camera.position.set(0,1.6,0);camera.updateMatrixWorld(true);
 const body=new CANNON.Body({mass:kinematic?0:mass,allowSleep:true,linearDamping:.08,angularDamping:.15});
 body.addShape(new CANNON.Box(new CANNON.Vec3(.14,.14,.14)));
 body.position.set(0,1.6,-1.2);
 if(kinematic){body.type=CANNON.Body.KINEMATIC;body.updateMassProperties()}
 world.addBody(body);
 const object=new THREE.Mesh(new THREE.BoxGeometry(.28,.28,.28),new THREE.MeshBasicMaterial());
 const item={object,body,held:null};
 if(kinematic)item.grab={freeze:true};
 object.userData.grabbable=item;
 const events=[];
 const carry=createDesktopCarry({world,camera,onEvent:(name,detail)=>events.push({name,detail})});
 return {world,camera,body,object,item,carry,events};
}
// One second of carrying at 60 fps, driving the physics the way the render loop does.
const run=(carry,world,{seconds=1,dt=1/60,blockers=[]}={})=>{
 const steps=Math.round(seconds/dt);
 for(let i=0;i<steps;i++){carry.update(dt,{blockers});world.step(1/72,dt,4);carry.sync()}
};
const holdPoint=(camera,distance)=>new THREE.Vector3(0,0,-1).applyQuaternion(camera.quaternion).multiplyScalar(distance).add(camera.position);

test('a dynamic prop is carried on a constraint, so it is still a physics object',()=>{
 const {world,body,carry,item}=fixture();
 const constraints=world.constraints.length;
 assert.equal(carry.grab(item,{distance:1}),true);
 assert.equal(item.held.desktop,true,'the object records that a desktop hand has it');
 assert.equal(world.constraints.length,constraints+1,'attached by a constraint, not by teleporting it');
 assert.equal(body.type,CANNON.Body.DYNAMIC,'and it stays dynamic while carried');
 // A body held still goes to sleep and then ignores everything written to it.
 assert.equal(body.allowSleep,false);
 assert.equal(carry.grab(item,{distance:1}),false,'one thing at a time');
});

test('a carried prop arrives at the hold point and stays there against gravity',()=>{
 const {world,camera,body,object,carry,item}=fixture();
 carry.grab(item,{distance:1});
 run(carry,world);
 const target=holdPoint(camera,1);
 assert.ok(body.position.distanceTo(target)<.06,`carried to the hold point: ${body.position.distanceTo(target)}`);
 assert.ok(Math.abs(body.position.y-1.6)<.06,'and held up rather than sagging');
 assert.ok(object.position.distanceTo(body.position)<1e-9,'the mesh shows where the physics put it');
});

test('the hold point stops short of a wall instead of pushing the object through it',()=>{
 const {world,camera,body,carry,item}=fixture();
 // A wall 0.8 m ahead. Asked to hold at 2 m, the object should end up short of it.
 const wall={min:{x:-2,y:0,z:-.85},max:{x:2,y:3,z:-.8}};
 carry.grab(item,{distance:2});
 run(carry,world,{blockers:[wall]});
 assert.ok(body.position.z>-.8,`kept on this side of the wall: ${body.position.z}`);
 assert.ok(body.position.z<-.3,'but still out in front of the camera');
});

test('a prop can still be placed down onto the surface it is aimed at',()=>{
 // The clamp exists to stop an object being shoved through geometry, not to hold it a bounding
 // radius off every surface: held that far back, a battery could never be lowered into the bay
 // it is being aimed at. A constrained prop is a real physics object, so a thin skin is enough.
 const {world,camera,body,carry,item}=fixture();
 const shelf={min:{x:-2,y:0,z:-1.3},max:{x:2,y:.2,z:1}};
 carry.grab(item,{distance:1});
 camera.position.set(0,1.1,.6);camera.lookAt(new THREE.Vector3(0,.2,-.1));camera.updateMatrixWorld(true);
 carry.discontinuity();
 run(carry,world,{seconds:1.5,blockers:[shelf]});
 const aimed=new THREE.Vector3(0,.2,-.1);
 const across=Math.hypot(body.position.x-aimed.x,body.position.z-aimed.z);
 // A tenth of a metre is the bar that matters: it is the tolerance the workshop's own bays
 // accept a battery within, so anything inside it is close enough to place by hand.
 assert.ok(across<.11,`lands over where it is aimed: ${across.toFixed(3)} m across`);
 // Resting on the shelf -- its centre a half-height up -- rather than hovering a bounding
 // radius clear of it, which is what the old full-radius clamp produced.
 assert.ok(body.position.y>.2&&body.position.y<.2+.14+.03,`sitting on the surface: y ${body.position.y.toFixed(3)}`);
});

test('the scroll wheel pushes the hold point out and pulls it in, within the clamp',()=>{
 const {world,camera,carry,item,body}=fixture();
 carry.grab(item,{distance:1});
 const start=carry.distance;
 assert.ok(carry.push(-1)>start,'scrolling away pushes out');
 assert.ok(carry.push(1)<carry.distance+1e-9);
 for(let i=0;i<40;i++)carry.push(-1);
 assert.equal(carry.distance,MAX_HOLD,'and never past arm\'s length');
 for(let i=0;i<80;i++)carry.push(1);
 assert.ok(carry.distance>=MIN_HOLD-1e-9,'nor into the near plane');
 run(carry,world,{seconds:1.5});
 assert.ok(body.position.distanceTo(holdPoint(camera,carry.distance))<.06,'the object follows the new distance');
});

test('releasing hands the prop back to the world, and a throw carries the hand speed',()=>{
 const {world,body,carry,item}=fixture();
 carry.grab(item,{distance:1});
 run(carry,world,{seconds:.3});
 const constraints=world.constraints.length;
 carry.release(false);
 assert.equal(world.constraints.length,constraints-1,'the constraint comes off with it');
 assert.equal(world.bodies.includes(body),true);
 assert.equal(body.type,CANNON.Body.DYNAMIC);
 assert.ok(Math.abs(body.mass-.45)<1e-9,'its mass is given back');
 assert.equal(body.allowSleep,true,'and so is its right to go to sleep');
 assert.equal(item.held,null);
 assert.ok(body.velocity.length()<.1,'a put-down is not a throw');
 // Now a throw: sweep the camera so the tracked hold point is genuinely moving.
 const thrown=fixture();
 thrown.carry.grab(thrown.item,{distance:1});
 for(let i=0;i<10;i++){thrown.camera.rotation.y-=.06;thrown.camera.updateMatrixWorld(true);thrown.carry.update(1/60,{});thrown.world.step(1/72,1/60,4)}
 thrown.carry.release(true);
 assert.ok(thrown.body.velocity.length()>.5,`a throw leaves the hand moving: ${thrown.body.velocity.length()}`);
});

test('a hand instrument is placed exactly and stays where it is let go',()=>{
 const {world,camera,body,carry,item}=fixture({kinematic:true});
 const constraints=world.constraints.length;
 carry.grab(item,{distance:.6});
 assert.equal(world.constraints.length,constraints,'no solver between you and an instrument');
 assert.equal(body.type,CANNON.Body.KINEMATIC);
 run(carry,world,{seconds:.5});
 assert.ok(body.position.distanceTo(holdPoint(camera,.6))<.005,'placed where it is pointed, not near it');
 carry.release(true);
 const where=body.position.clone();
 assert.equal(body.type,CANNON.Body.KINEMATIC,'it holds its pose instead of falling');
 assert.equal(body.mass,0);
 assert.equal(body.velocity.length(),0,'and is never thrown, even when asked');
 for(let i=0;i<60;i++)world.step(1/72,1/60,4);
 assert.ok(body.position.distanceTo(where)<1e-9,'still exactly where it was left');
});

test('a heavier prop lags further behind the hand than a light one',()=>{
 // This is the weight cue, and it comes from the hold point rather than from the solver.
 const lag=mass=>{
  const f=fixture({mass});
  f.carry.grab(f.item,{distance:1});
  f.camera.rotation.y-=.5;f.camera.updateMatrixWorld(true);
  for(let i=0;i<4;i++){f.carry.update(1/60,{});f.world.step(1/72,1/60,4)}
  return f.body.position.distanceTo(holdPoint(f.camera,1));
 };
 const light=lag(.4),heavy=lag(3);
 assert.ok(heavy>light,`a 3 kg prop trails a 0.4 kg one: ${heavy} vs ${light}`);
});

test('an object wedged out of reach is let go rather than dragged through the level',()=>{
 const {world,camera,carry,item,events}=fixture();
 carry.grab(item,{distance:1});
 // Pin the body where the hand cannot follow, the way a prop jammed behind a rack behaves.
 const pinned=new THREE.Vector3(0,1.6,-1.2);
 for(let i=0;i<60;i++){
  item.body.position.set(pinned.x,pinned.y,pinned.z);
  camera.position.z+=.08;camera.updateMatrixWorld(true);   // walk away from it
  carry.update(1/60,{});
 }
 assert.equal(carry.held,null,'the hand comes back empty');
 assert.equal(item.held,null);
 assert.ok(events.some(e=>e.name==='break'));
 assert.equal(world.constraints.length,0,'and the constraint does not outlive the hold');
});

test('dispose lets go of whatever is in hand and leaves the world as it found it',()=>{
 const {world,carry,item,body}=fixture();
 const bodies=world.bodies.length;
 carry.grab(item,{distance:1});
 assert.equal(world.bodies.length,bodies+1,'the invisible hand is a body too');
 carry.dispose();
 assert.equal(world.bodies.length,bodies,'and it is cleaned up');
 assert.equal(world.constraints.length,0);
 assert.equal(item.held,null);
 assert.equal(body.allowSleep,true);
});

test('the solver is given more iterations only while a constraint is live',()=>{
 const {world,carry,item}=fixture();
 const before=world.solver.iterations;
 carry.grab(item,{distance:1});
 assert.ok(world.solver.iterations>=CARRY.solverIterations,'a constraint needs more than free-body contact does');
 carry.release(false);
 assert.equal(world.solver.iterations,before,'and the scene gets its own setting back');
});

test('a mechanism is told where the hand is, not attached to it',()=>{
 // A vise handle, a door, a lever on a pivot: it owns its own motion and only wants the hand
 // position, through the same beginGrab/moveGrab/endGrab the headset path drives it with.
 const {world,camera,carry,item,body}=fixture({kinematic:true});
 const calls=[];
 item.grab={type:'mechanism'};
 item.mechanism={beginGrab:p=>calls.push(['begin',p.clone()]),moveGrab:p=>calls.push(['move',p.clone()]),endGrab:()=>calls.push(['end'])};
 const where=body.position.clone();
 assert.equal(carry.grab(item,{distance:.8}),true);
 assert.equal(calls[0][0],'begin');
 assert.equal(world.constraints.length,0,'no constraint');
 assert.equal(body.type,CANNON.Body.KINEMATIC,'and its body is left exactly as it was');
 run(carry,world,{seconds:.3});
 assert.ok(calls.some(c=>c[0]==='move'));
 assert.ok(calls.at(-1)[1].distanceTo(holdPoint(camera,.8))<.05,'the hand it is told about is the hold point');
 assert.ok(body.position.distanceTo(where)<1e-9,'the carry never moves a mechanism itself');
 carry.release(false);
 assert.equal(calls.at(-1)[0],'end');
 assert.equal(item.held,null);
 assert.equal(carry.held,null);
});

test('the world may arrive after the controls do, because activities swap scenes',()=>{
 let world=null;
 const camera=new THREE.PerspectiveCamera(58,1.6,.025,100);
 camera.position.set(0,1.6,0);camera.updateMatrixWorld(true);
 const carry=createDesktopCarry({world:()=>world,camera});
 world=new CANNON.World({gravity:new CANNON.Vec3(0,-9.81,0)});
 const body=new CANNON.Body({mass:.45});body.addShape(new CANNON.Box(new CANNON.Vec3(.1,.1,.1)));
 body.position.set(0,1.6,-1);world.addBody(body);
 const object=new THREE.Mesh(new THREE.BoxGeometry(.2,.2,.2),new THREE.MeshBasicMaterial());
 const item={object,body,held:null};
 assert.equal(carry.grab(item,{distance:1}),true);
 assert.equal(world.constraints.length,1,'it attaches into the world that exists by then');
 carry.release(false);
 assert.equal(world.constraints.length,0);
});

test('a camera teleport re-seats the hold rather than flinging or dropping the object',()=>{
 // A scene reset, a lab switch or a spawn moves the eye discontinuously. Chasing that looks
 // like the object being flung across the room, and the strain timer reads the lag as a snag
 // and drops it -- so the carry recognises the jump and starts again on the far side of it.
 const {world,camera,body,carry,item,events}=fixture();
 carry.grab(item,{distance:1});
 run(carry,world,{seconds:.4});
 camera.position.set(8,1.6,-9);camera.updateMatrixWorld(true);
 carry.update(1/60,{});
 assert.equal(carry.held,item,'still in hand');
 assert.ok(body.position.distanceTo(new THREE.Vector3(8,1.6,-10))<.2,`and arrived with the eye: ${body.position.toArray()}`);
 run(carry,world,{seconds:1});
 assert.equal(carry.held,item,'and is not dropped for lagging');
 assert.equal(events.filter(e=>e.name==='break').length,0);
});
