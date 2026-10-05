import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleInScene,ancestorWith,grabbableOf,actionOf,rayBox,blockerDistance,resolveAim,reticleFor,holdOffset,scrollHold} from '../src/desktop-aim.js';
import {MIN_HOLD,MAX_HOLD,holdDistanceClamp} from '../src/grab.js';

// Stand-ins for three objects: only `visible`, `parent` and `userData` are read.
const node=(userData={},parent=null,visible=true)=>({userData,parent,visible});
const hitOn=(object,distance)=>({object,distance});
const box=(minX,minZ,maxX,maxZ,minY=0,maxY=2)=>({min:{x:minX,y:minY,z:minZ},max:{x:maxX,y:maxY,z:maxZ}});

test('a parent hiding a subtree hides everything under it',()=>{
 const root=node({},null,false),child=node({},root);
 assert.equal(visibleInScene(child),false,'a mesh of a hidden group is not a target however solid it is');
 root.visible=true;
 assert.equal(visibleInScene(child),true);
});

test('the interaction is found on the ancestor that carries it, not the mesh the ray hit',()=>{
 const item={kind:'battery'};
 const group=node({grabbable:item,label:'B1'}),mesh=node({},group);
 assert.equal(grabbableOf(mesh),item);
 assert.equal(ancestorWith(mesh,'grabbable'),group);
 assert.equal(grabbableOf(node({})),null);
 const control=node({action:{type:'terminal'}});
 assert.deepEqual(actionOf(node({},control)),{type:'terminal'});
 assert.equal(actionOf(node({})),undefined);
 // A falsy action is still an action: a pad whose action is null must not read as scenery.
 assert.equal(actionOf(node({action:null})),null);
});

test('a ray reports where it enters a box, and misses cleanly',()=>{
 const origin={x:0,y:1,z:0},forward={x:0,y:0,z:-1};
 assert.ok(Math.abs(rayBox(origin,forward,box(-1,-3,1,-2))-2)<1e-9);
 assert.equal(rayBox(origin,forward,box(5,-3,6,-2)),null,'off to the side');
 assert.equal(rayBox(origin,{x:0,y:0,z:1},box(-1,-3,1,-2)),null,'behind the ray');
 // A ray parallel to a slab it is already inside still crosses the other slabs.
 assert.ok(Math.abs(rayBox({x:0,y:1,z:0},forward,box(-1,-3,1,-2,0,2))-2)<1e-9);
 assert.equal(rayBox({x:0,y:9,z:0},forward,box(-1,-3,1,-2,0,2)),null,'parallel and outside the slab');
 assert.equal(blockerDistance(origin,forward,[box(-1,-5,1,-4),box(-1,-3,1,-2)]),2,'the nearest wall is the one that counts');
 assert.equal(blockerDistance(origin,forward,[]),Infinity);
});

test('an object behind a wall is not a target, but one standing against it is',()=>{
 const origin={x:0,y:1,z:0},forward={x:0,y:0,z:-1};
 const wall=box(-1,-2.1,1,-2);
 const behind=node({grabbable:{kind:'battery'},label:'B1'});
 assert.equal(resolveAim([hitOn(behind,3)],{origin,direction:forward,blockers:[wall]}),null,'the wall is genuinely in front of it');
 // Against the wall: the mesh face reports a hair past the blocker box, which the slack covers.
 const against=node({grabbable:{kind:'battery'},label:'B1'});
 assert.ok(resolveAim([hitOn(against,2.02)],{origin,direction:forward,blockers:[wall]}),'an object on a shelf is still reachable');
});

test('scenery the ray crosses is skipped, and the first real interaction wins',()=>{
 const item={kind:'meter'};
 const scenery=node({}),meter=node({grabbable:item,label:'Fluke 87V'}),pad=node({action:()=>{}});
 const aim=resolveAim([hitOn(scenery,.5),hitOn(meter,1),hitOn(pad,2)],{});
 assert.equal(aim.item,item);
 assert.equal(aim.distance,1);
 assert.equal(resolveAim([hitOn(scenery,.5)],{}),null);
 assert.equal(resolveAim([],{}),null);
});

test('out of reach is reported as out of reach, not as nothing there',()=>{
 const far=node({grabbable:{kind:'battery'},label:'B1'});
 const aim=resolveAim([hitOn(far,4)],{reach:2.5});
 assert.equal(aim.beyondReach,true,'still a target, just not one you can take');
 assert.equal(resolveAim([hitOn(far,2)],{reach:2.5}).beyondReach,false);
});

test('the reticle names what will happen, and says so only when it will',()=>{
 const item={kind:'battery'};
 const grabbable=node({grabbable:item,label:'B1 battery'}),control=node({action:{type:'disconnect'},label:'Disconnect handle'});
 assert.deepEqual(reticleFor(null),{state:'idle',label:'',hint:''});
 assert.equal(reticleFor(resolveAim([hitOn(grabbable,1)],{})).state,'grab');
 assert.equal(reticleFor(resolveAim([hitOn(grabbable,1)],{})).label,'B1 battery');
 assert.equal(reticleFor(resolveAim([hitOn(control,1)],{})).state,'use');
 assert.equal(reticleFor(resolveAim([hitOn(grabbable,9)],{reach:2.5})).state,'far');
 // An object that is grabbable in principle but not right now -- seated, clamped -- reads as
 // scenery rather than offering a pickup that would be refused.
 assert.equal(reticleFor(resolveAim([hitOn(grabbable,1)],{}),{canGrab:()=>false}).state,'idle');
 const holding=reticleFor(resolveAim([hitOn(control,1)],{}),{held:{label:'B1 battery'}});
 assert.equal(holding.state,'holding','what you are carrying outranks what you are looking at');
 assert.match(holding.hint,/scroll/);
});

test('the held orientation is relative to the eye, so turning carries the object round',()=>{
 const quarter={x:0,y:Math.sin(Math.PI/4),z:0,w:Math.cos(Math.PI/4)};
 // Facing the same way as the camera: the offset is identity, and stays identity as you turn.
 const aligned=holdOffset(quarter,quarter);
 assert.ok(Math.abs(aligned.w-1)<1e-9&&Math.abs(aligned.y)<1e-9);
 // Square to the camera: the offset is the quarter turn between them.
 const square=holdOffset({x:0,y:0,z:0,w:1},quarter);
 assert.ok(Math.abs(square.y-Math.sin(Math.PI/4))<1e-9);
});

test('a scroll notch is a share of the current distance, so both ends feel like one step',()=>{
 const out=scrollHold(1,-1),in_=scrollHold(1,1);
 assert.ok(out>1&&in_<1,'scrolling away pushes out, toward pulls in');
 // The same notch at half the distance moves half as far, which is what makes it feel even.
 assert.ok(Math.abs((scrollHold(2,1)-2)/(scrollHold(1,1)-1)-2)<1e-9);
 // And it composes with the clamp rather than fighting it.
 assert.equal(holdDistanceClamp(scrollHold(MIN_HOLD,20),0),MIN_HOLD);
 assert.equal(holdDistanceClamp(scrollHold(MAX_HOLD,-20),0),MAX_HOLD);
});
