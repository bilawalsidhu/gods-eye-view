import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {layoutPanel,layoutLabel,wrapText,spanAt,unitFor,LEGIBILITY} from '../src/panels/layout.js';
import {PanelCollision} from '../src/panels/collision.js';
import {RoomGeometry} from '../src/panels/room.js';
import {dampVector,copyPose,facing} from '../src/panels/motion.js';
import {PanelManager} from '../src/panels/manager.js';
import {createPanelView} from '../src/panels/view.js';
const metrics={measure:(s,size)=>Array.from(String(s)).length*size*.5,glyphHeight:size=>size*.75};
const pose=(x=0,y=1.6,z=-1.25)=>({position:new THREE.Vector3(x,y,z),quaternion:new THREE.Quaternion(),scale:1});
const head=new THREE.Vector3(0,1.6,0),size={width:.6,height:.4,handle:true};
const simple={taskId:'one',title:'A panel',blocks:[{type:'paragraph',text:'Instructions for the learner.'}],actions:[{id:'go',label:'Continue',primary:true}]};
function solid(c,id,position,dimensions){const mesh=new THREE.Mesh(new THREE.BoxGeometry(...dimensions));mesh.position.set(...position);mesh.updateMatrixWorld();c.registerBox(id,mesh);return mesh;}
function fakeView(){const group=new THREE.Group(),face=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial()),handle=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial());group.add(face,handle);return {group,face,handle,metrics,dirty:false,paint(){},resize(l){face.scale.set(l.physicalWidth,l.physicalHeight,1);},dispose(){group.removeFromParent();}};}
function fixture(){const m=new PanelManager({scene:new THREE.Scene(),viewFactory:fakeView});m.viewer={position:head.clone(),quaternion:new THREE.Quaternion()};return m;}
function tick(m,n=1,dt=1/90){for(let i=0;i<n;i++){m.collision.refresh(m.panels);m.updateHover();m.update(dt);}}

test('measured layout fits angular limits and content determines size',()=>{
  const small=layoutPanel(simple,metrics),dense=layoutPanel({...simple,blocks:[...simple.blocks,{type:'paragraph',column:1,text:'A second column'}]},metrics);
  assert.ok(dense.width>small.width);assert.ok(small.physicalWidth<=spanAt(1.25,36)+1e-9);assert.ok(dense.physicalHeight<=spanAt(1.25,32)+1e-9);
  assert.ok(metrics.glyphHeight(24)*small.unit>=spanAt(1.25,.65));
});
test('long words, explicit newlines, and measurement units wrap without losing text',()=>{
  const text='Start\nABCDEFGHIJKLMNO 480 V';const lines=wrapText(text,60,s=>metrics.measure(s,20));
  assert.ok(lines.every(l=>metrics.measure(l,20)<=60));assert.ok(lines.join('').includes('ABCDEFGHIJKLMNO'));assert.ok(lines.includes('480\u00a0V'));
});
test('overflow preserves every body line and every action on explicit pages',()=>{
  const rows=Array.from({length:70},(_,i)=>`row-${i}`),actions=Array.from({length:15},(_,i)=>({id:`a${i}`,label:`Action ${i}`}));
  const l=layoutPanel({...simple,blocks:[{type:'list',items:rows}],actions},metrics);assert.ok(l.pages.length>2);
  for(const row of rows)assert.ok(l.pages.some(p=>p.items.some(i=>i.text?.includes(row))));
  for(const action of actions)assert.ok(l.pages.some(p=>p.controls.some(c=>c.id===action.id)));
  for(const p of l.pages){for(const c of p.controls){assert.ok(c.x>=0&&c.x+c.width<=l.width+.01);assert.ok(c.y>=0&&c.y+c.height<=l.height);}
    for(const item of p.items)assert.ok(item.y+item.height<=l.height);}
});
test('readings reserve panel dimensions and duplicate action IDs fail clearly',()=>{
  const l=layoutPanel(simple,metrics);const update=layoutPanel({...simple,title:'A'},metrics,{minWidth:l.physicalWidth,minHeight:l.physicalHeight});assert.ok(update.physicalWidth>=l.physicalWidth);assert.ok(update.physicalHeight>=l.physicalHeight);
  assert.throws(()=>layoutPanel({...simple,actions:[{id:'x',label:'A'},{id:'x',label:'B'}]},metrics),/unique/);
});
test('full panel footprint rejects an edge collision even when center is clear',()=>{
  const c=new PanelCollision();solid(c,'wall',[.32,1.6,-1.25],[.1,2,.2]);c.refresh();assert.equal(c.valid(pose(),size,head,'panel'),false);
});
test('continuous sweep cannot tunnel through a millimeter wall',()=>{
  const c=new PanelCollision();solid(c,'wall',[0,1.6,-1.8],[4,3,.001]);c.refresh();const moved=c.sweep(pose(),pose(0,1.6,-3),size,head,'panel');assert.ok(moved.fraction<1);assert.ok(moved.pose.position.z>-1.762);assert.ok(c.valid(moved.pose,size,head,'panel',{sight:false}));
});
test('rotation and scale envelopes cannot rotate a corner through a nearby wall',()=>{
  const c=new PanelCollision();solid(c,'wall',[.5,1.6,-1.25],[.1,3,4]);c.refresh();const to=pose();to.scale=2;to.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/4);const moved=c.sweep(pose(),to,size,head,'panel');assert.ok(moved.fraction<1);
});
test('small occluder between sample rays is detected by the full view pyramid',()=>{
  const c=new PanelCollision();solid(c,'occluder',[.073,1.643,-.6],[.015,.015,.01]);c.refresh();assert.equal(c.valid(pose(),size,head,'panel',{sight:false}),true);assert.equal(c.occluded(pose(),size,head,'panel'),true);
});
test('finite room triangles preserve a doorway opening',()=>{
  const c=new PanelCollision();c.registerTriangles('left',[new THREE.Triangle(new THREE.Vector3(-2,0,-.6),new THREE.Vector3(-.6,3,-.6),new THREE.Vector3(-.6,0,-.6))]);c.refresh();assert.equal(c.valid(pose(),size,head,'panel'),true);
});
test('motion settles without overshoot and matches 72/90/120 Hz',()=>{
  const results=[];for(const hz of [72,90,120]){let p=new THREE.Vector3(),v=new THREE.Vector3();for(let i=0;i<hz;i++){p=dampVector(p,v,new THREE.Vector3(1,0,0),1/hz,.25);assert.ok(p.x<=1);}results.push(p.x);}
  assert.ok(Math.max(...results)-Math.min(...results)<1e-10);assert.ok(results[0]>.99);
});
test('room poses update independently of geometry timestamps and remove stale entries',()=>{
  const c=new PanelCollision(),r=new RoomGeometry(c);r.start({},true);
  const source={planeSpace:{},lastChangedTime:1,polygon:[{x:-1,z:-1},{x:1,z:-1},{x:1,z:1},{x:-1,z:1}]};let x=0;
  const frame={detectedPlanes:new Set([source]),getViewerPose:()=>({}),getPose:()=>({transform:{matrix:new THREE.Matrix4().makeTranslation(x,0,0).toArray()}})};
  r.update(frame,{});assert.equal(r.state,'active');const id=[...c.entries.keys()][0],before=c.entries.get(id).triangles[0].a.x;
  x=2;r.update(frame,{});assert.equal(c.entries.get(id).triangles[0].a.x,before+2);
  frame.getViewerPose=()=>null;r.update(frame,{});assert.equal(r.state,'tracking interrupted');assert.equal(c.entries.size,1);
  frame.getViewerPose=()=>({});frame.detectedPlanes.clear();r.update(frame,{});assert.equal(c.entries.size,0);assert.equal(r.state,'waiting for room data');r.stop();assert.equal(r.state,'unavailable');
});
test('room capability absence is distinct from a room with no geometry yet',()=>{
  const r=new RoomGeometry(new PanelCollision());r.start({},true);r.update({getViewerPose:()=>({})},{});assert.equal(r.state,'unavailable');
  r.update({getViewerPose:()=>({}),detectedMeshes:new Set()},{});assert.equal(r.state,'waiting for room data');
});
test('one follower at a time, and small head movements leave its world pose still',()=>{
  const m=fixture(),a=m.createPanel({id:'a',mode:'following',content:simple});tick(m);const saved=copyPose(a.pose);m.viewer.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),.03);tick(m,90);assert.ok(a.pose.position.distanceTo(saved.position)<1e-9);
  const b=m.createPanel({id:'b',mode:'following',content:simple});assert.equal(a.visible,false);assert.equal(b.visible,true);
});
test('a following panel remains an upright billboard inside its position dead zone',()=>{
  const m=fixture(),p=m.createPanel({id:'p',mode:'following',content:simple});tick(m);const position=p.pose.position.clone();
  m.viewer.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),.06);tick(m,2);
  assert.ok(p.pose.position.distanceTo(position)<1e-9);assert.ok(p.pose.quaternion.angleTo(facing(p.pose.position,m.viewer.position))<1e-8);
});
test('a wall at preferred depth selects a closer central following position',()=>{
  const m=fixture();solid(m.collision,'wall',[0,1.6,-1.25],[4,3,.05]);m.collision.refresh();const p=m.createPanel({id:'p',mode:'following',content:simple});tick(m);assert.ok(p.initialized);assert.ok(p.pose.scale<1);assert.ok(Math.abs(p.pose.position.x)<1e-9);
});
test('a large turn recovers only while hidden, with content/page retained',()=>{
  const m=fixture(),p=m.createPanel({id:'p',mode:'following',content:simple});tick(m);const before=p.pose.position.clone();m.viewer.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI);tick(m,22);assert.ok(p.recovery);assert.ok(p.pose.position.distanceTo(before)<1e-9);tick(m,60);assert.ok(p.pose.position.z>0);assert.equal(p.content,simple);assert.equal(p.opacity,1);
});
test('press release activates once, leaving the target cancels permanently',()=>{
  const m=fixture();let count=0;const p=m.createPanel({id:'p',content:simple,pose:{position:[0,1.6,-1.25]},onAction:()=>count++});tick(m);const owner={},hit={panel:p,id:'go',point:p.pose.position.clone(),distance:1.25};m.inputs.set(owner,{hit});assert.equal(m.begin(owner),true);m.end(owner);assert.equal(count,1);m.end(owner);assert.equal(count,1);
  m.begin(owner);m.setInput(owner,new THREE.Ray(head,new THREE.Vector3(1,0,0)));m.inputs.get(owner).hit=hit;m.end(owner);assert.equal(count,1);
});
test('layout freezes during input and disabled actions never activate',()=>{
  const m=fixture();let count=0;const p=m.createPanel({id:'p',content:{...simple,actions:[{id:'go',label:'Go',enabled:false}]},pose:{position:[0,1.6,-1.25]},onAction:()=>count++});tick(m);m.activate(p,'go');assert.equal(count,0);p.locked=1;p.setContent({...simple,title:'Updated'});tick(m,20);assert.notEqual(p.content.title,'Updated');p.locked=0;tick(m,20);assert.equal(p.content.title,'Updated');
});
test('handle keeps grab offset, enforces ownership and cancels without throw',()=>{
  const m=fixture(),p=m.createPanel({id:'p',mode:'movable',content:simple});tick(m);const a={},b={},point=p.pose.position.clone().add(new THREE.Vector3(.1,-p.size.height/2,0));
  for(const owner of [a,b])m.inputs.set(owner,{hit:{panel:p,id:'@handle',point,distance:1.25,direct:true},near:point.clone(),ray:new THREE.Ray(head,new THREE.Vector3(0,0,-1))});
  m.begin(a,'pinch');assert.equal(p.held.owner,a);m.begin(b,'pinch');assert.equal(p.held.owner,a);const before=p.pose.position.clone();tick(m);assert.ok(p.pose.position.distanceTo(before)<.005);m.cancel(a);assert.equal(p.held,null);assert.equal(p.velocity.length(),0);assert.equal(p.state,'placed');
});
test('trigger selection acquires the grab bar without treating it as a content press',()=>{
  const m=fixture(),p=m.createPanel({id:'p',mode:'movable',content:simple});tick(m);const owner={},point=p.pose.position.clone().add(new THREE.Vector3(0,-p.size.height/2,0));
  m.inputs.set(owner,{hit:{panel:p,id:'@handle',point,distance:1.25,direct:false},ray:new THREE.Ray(head,new THREE.Vector3(0,0,-1))});assert.equal(m.begin(owner,'select'),true);assert.equal(p.held.owner,owner);assert.equal(m.inputs.get(owner).press,undefined);m.end(owner);assert.equal(p.state,'placed');
});
test('every held handle supports depth adjustment, including direct grabs',()=>{
  const m=fixture(),p=m.createPanel({id:'p',mode:'movable',content:simple});tick(m);const owner={},point=p.pose.position.clone().add(new THREE.Vector3(0,-p.size.height/2,0));
  m.inputs.set(owner,{hit:{panel:p,id:'@handle',point,distance:1.25,direct:true},near:point.clone(),ray:new THREE.Ray(head,new THREE.Vector3(0,0,-1))});m.begin(owner,'pinch');m.changeDepth(owner,.4);assert.equal(p.held.depthOffset,.4);m.cancel(owner);
  m.inputs.set(owner,{hit:{panel:p,id:'@handle',point,distance:1.25,direct:false},ray:new THREE.Ray(head,new THREE.Vector3(0,0,-1))});m.begin(owner,'grab');m.changeDepth(owner,.4);assert.equal(p.held.distance,1.65);m.cancel(owner);
});
test('an occluded panel cannot receive a ray hit and disposal removes scene objects',()=>{
  const m=fixture(),p=m.createPanel({id:'p',content:simple,pose:{position:[0,1.6,-1.25]}});tick(m);solid(m.collision,'wall',[0,1.6,-.6],[2,2,.1]);m.collision.refresh(m.panels);assert.equal(m.hit(new THREE.Ray(head,new THREE.Vector3(0,0,-1))),null);p.dispose();assert.equal(m.panels.length,0);assert.equal(m.scene.children.length,0);
});
test('room geometry writes depth without painting over passthrough and cleans up on reset',()=>{
  const scene=new THREE.Scene(),r=new RoomGeometry(new PanelCollision(),scene);r.start({},true);
  const source={meshSpace:{},lastChangedTime:1,vertices:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2])};
  r.update({getViewerPose:()=>({}),detectedMeshes:new Set([source]),getPose:()=>({transform:{matrix:new THREE.Matrix4().makeTranslation(0,0,-1).toArray()}})},{});
  assert.equal(scene.children.length,1);assert.equal(scene.children[0].material.colorWrite,false);assert.equal(scene.children[0].material.depthWrite,true);assert.equal(scene.children[0].matrix.elements[14],-1);
  let disposed=0;scene.children[0].geometry.addEventListener('dispose',()=>disposed++);r.reset();assert.equal(scene.children.length,0);assert.equal(disposed,1);r.dispose();
});

test('a new canvas size replaces immutable GPU texture storage and releases the old texture',()=>{
  const previous=globalThis.document;
  const context={measureText:s=>({width:s.length*12,actualBoundingBoxAscent:18,actualBoundingBoxDescent:4}),createLinearGradient:()=>({addColorStop(){}})};
  for(const name of ['setTransform','clearRect','beginPath','roundRect','fill','stroke','fillText','drawImage'])context[name]=()=>{};
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>context})};
  try{
    const brand={name:'Neutral',colors:{background:'#101b24',surface:'#203541',text:'#f1f8fa',muted:'#c7d8dc',accent:'#a7e2d4',accentText:'#102b30',border:'#76959c'},fonts:{body:{family:'Trebuchet MS'},display:{family:'Georgia'}}};
    const v=createPanelView(brand),p={content:simple,layout:layoutPanel(simple,metrics),page:0,mode:'movable',state:'placed'};v.paint(p);const texture=v.face.material.map;let disposed=0;texture.addEventListener('dispose',()=>disposed++);
    p.content={title:'Panel options',actions:[{id:'back',label:'Back'}]};p.layout=layoutPanel(p.content,metrics);v.paint(p);assert.notEqual(v.face.material.map,texture);assert.equal(disposed,1);
    const unchanged=v.face.material.map;v.paint(p);assert.equal(v.face.material.map,unchanged);v.dispose();
  }finally{globalThis.document=previous;}
});
test('dense columns keep body text above controls while retaining every checklist row',()=>{
  const content={...simple,blocks:[{type:'reading',text:'DC V · NO CONTACT'},{type:'list',column:1,items:Array.from({length:12},(_,i)=>`Pair ${i+1}`)}],actions:Array.from({length:5},(_,i)=>({id:`a${i}`,label:`Button ${i}`}))};
  const l=layoutPanel(content,metrics);for(const page of l.pages){const y=Math.min(...page.controls.filter(c=>!c.id.startsWith('@')).map(c=>c.y));for(const item of page.items.filter(i=>i.column===0))assert.ok(item.y+item.height<=y);}
});
test('live content that keeps its size stays clickable instead of resizing every update',()=>{
  const live=n=>({...simple,taskId:'live',footer:`reading ${String(n).padStart(2,'0')}`});
  const m=fixture(),p=m.createPanel({id:'p',mode:'anchored',content:live(0),pose:{position:[0,1.6,-1.25],quaternion:[0,0,0,1]}});
  tick(m,4);
  const control=p.layout.pages[0].controls.find(c=>c.id==='go'),aim=new THREE.Vector3(((control.x+control.width/2)/p.layout.width-.5)*p.size.width,(.5-(control.y+control.height/2)/p.layout.height)*p.size.height,0);
  const target=p.group.localToWorld(aim.clone());
  for(let i=0;i<20;i++){
    p.setContent(live(i+1));
    m.time+=.11;tick(m,1);
    const hit=m.hit(new THREE.Ray(new THREE.Vector3(target.x,target.y,target.z+.5),new THREE.Vector3(0,0,-1)));
    assert.equal(hit?.id,'go');
  }
});
test('reading distance scales layout units without moving the angular floor',()=>{
  const near=unitFor(.45,metrics),far=unitFor(1.25,metrics);
  assert.ok(Math.abs(near/far-.45/1.25)<1e-12);
  assert.ok(Math.abs(metrics.glyphHeight(24)*near-spanAt(.45,LEGIBILITY.body))<1e-12);
  assert.ok(Math.abs(metrics.glyphHeight(24)*far-spanAt(1.25,LEGIBILITY.body))<1e-12);
  // the floor is a headset minimum, not a desktop one; keep it above what a Quest can resolve
  assert.ok(LEGIBILITY.body>=.8&&LEGIBILITY.secondary>=.6);
});
test('the default panel layout is unchanged by the reading-distance parameter',()=>{
  assert.deepEqual(layoutPanel(simple,metrics,{distance:1.25}),layoutPanel(simple,metrics));
});
test('a label drops the panel size floor and its chrome, keeping the legibility rule',()=>{
  const smallest=layoutPanel({title:'A',actions:[]},metrics);
  const label=layoutLabel({text:'12:00 · 0.32 kW · 3 PANELS'},metrics,{distance:.45});
  assert.ok(label.physicalHeight<smallest.physicalHeight/4);
  assert.ok(label.physicalWidth<smallest.physicalWidth/2);
  assert.equal(label.pages.length,1);
  assert.deepEqual(label.pages[0].controls,[]);
  assert.equal(label.pages[0].items.filter(i=>i.type==='text').length,1);
});
test('a label given a plate size fills it exactly and scales its type to fit',()=>{
  const size={width:.75,height:.036};
  const strip=layoutLabel({text:'HOLD RIM TO MOVE / RELEASE TO SNAP',align:'center'},metrics,{size});
  assert.ok(Math.abs(strip.physicalWidth-size.width)<1e-9);
  assert.ok(Math.abs(strip.physicalHeight-size.height)<1e-9);
  // content sits inside the plate, not overflowing it
  for(const item of strip.pages[0].items){
    assert.ok(item.y>=0&&item.y+item.height<=strip.height+1e-9);
    assert.ok(item.size*strip.unit<size.height);
  }
  // a taller plate with the same text gets proportionally larger type
  const tall=layoutLabel({text:'HOLD RIM TO MOVE / RELEASE TO SNAP',align:'center'},metrics,{size:{width:1.5,height:.072}});
  assert.ok(tall.unit>strip.unit);
  // without a plate the label still shrinks to its content
  const natural=layoutLabel({text:'HOLD RIM TO MOVE / RELEASE TO SNAP',align:'center'},metrics,{distance:.45});
  assert.ok(natural.physicalWidth<size.width);
});
test('a label rides its parent transform and stays out of collision and input',()=>{
  const m=fixture(),table=new THREE.Group();table.position.set(0,.8,-.6);table.scale.setScalar(.5);m.scene.add(table);table.updateMatrixWorld(true);
  const label=m.createPanel({id:'tag',variant:'label',parent:table,content:{text:'12:00 · 0.32 kW'},layout:{distance:.45},pose:{position:[0,.2,0],quaternion:[0,0,0,1]}});
  m.createPanel({id:'main',mode:'following',content:simple});tick(m,3);
  assert.equal(label.group.parent,table);
  assert.ok(Math.abs(label.group.getWorldScale(new THREE.Vector3()).x-.5)<1e-9);
  assert.ok(!m.collision.obstacles.some(o=>o.id==='tag'));
  const hit=m.hit(new THREE.Ray(new THREE.Vector3(0,1,1),new THREE.Vector3(0,0,-1)));
  assert.ok(!hit||hit.panel!==label);
});
test('a fully blocked follower holds instead of forcing a central placement',()=>{
  const m=fixture(),p=m.createPanel({id:'p',mode:'following',content:simple});tick(m);const original=p.pose.position.clone();m.viewer.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI);
  solid(m.collision,'back-wall',[0,1.6,.7],[5,4,.2]);tick(m,120);assert.equal(p.state,'blocked');assert.ok(p.pose.position.distanceTo(original)<1e-9);
});
