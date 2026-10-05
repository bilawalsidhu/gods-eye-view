import './controller-fit.css';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {watchSession} from './xr-lifecycle.js';
import {clone as cloneSkinned} from 'three/addons/utils/SkeletonUtils.js';
import {alignHandToGrip, GRIP_TUNE} from './controller-hand.js';
import {createHandPoser, controllerCurls} from './hand-pose.js';
import {createControllerHandMaterial,styleHandModel} from './xr-hands.js';

const INCH=.0254, canvas=document.querySelector('#viewport');
const renderer=new THREE.WebGLRenderer({canvas,antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,2)); renderer.outputColorSpace=THREE.SRGBColorSpace; renderer.xr.enabled=true; renderer.xr.setReferenceSpaceType('local-floor');
const scene=new THREE.Scene(); scene.background=new THREE.Color('#10161f'); scene.add(new THREE.HemisphereLight('#dcecff','#1b2430',2.2));
const key=new THREE.DirectionalLight('#ffffff',2.8); key.position.set(2,4,3); scene.add(key);
const floor=new THREE.Mesh(new THREE.CircleGeometry(.72,64),new THREE.MeshStandardMaterial({color:'#172331',roughness:.92,metalness:.05})); floor.rotation.x=-Math.PI/2; floor.position.y=-.16; scene.add(floor);
const camera=new THREE.PerspectiveCamera(38,1,.01,10); camera.position.set(.34,.18,.48);
const controls=new OrbitControls(camera,canvas); controls.target.set(0,-.02,0); controls.enableDamping=true; controls.minDistance=.18; controls.maxDistance=1.8;
const grip=new THREE.Group(); scene.add(grip); const loader=new GLTFLoader(), source=new Map();
const state={handedness:'right',x:0,y:0,z:0,trigger:0,grip:0,thumb:true,opacity:.58}; let hand=null;
function load(path){if(!source.has(path))source.set(path,new Promise((resolve,reject)=>loader.load(path,gltf=>resolve(gltf.scene),undefined,reject)));return source.get(path)}
function resultingTune(side){const base=GRIP_TUNE[side];return {...base,offset:[base.offset[0]+state.x*INCH,base.offset[1]+state.y*INCH,base.offset[2]+state.z*INCH]}}
function offsetText(){const v=side=>resultingTune(side).offset.map(value=>Number(value.toFixed(4)));return `right: {offset: ${JSON.stringify(v('right'))}},\nleft: {offset: ${JSON.stringify(v('left'))}}`}
function updateReadout(){const [x,y,z]=resultingTune(state.handedness).offset;document.querySelector('#offset-readout').innerHTML=[['Hand',state.handedness],['X · palm / dorsal',`${x.toFixed(4)} m`],['Y · thumb / down',`${y.toFixed(4)} m`],['Z · forward / back',`${z.toFixed(4)} m`]].map(([label,value])=>`<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}
function toast(message){const node=document.querySelector('#toast');node.textContent=message;node.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.classList.remove('visible'),1800)}
function applyPose(){if(!hand)return;const curls=controllerCurls({trigger:state.trigger,squeeze:state.grip,triggerTouched:true,thumbTouched:state.thumb});hand.poser.setCurls(curls);hand.poser.setSpread(curls.spread)}
async function rebuild(){grip.clear();hand=null;const side=state.handedness,base=import.meta.env.BASE_URL;const [controllerAsset,handAsset]=await Promise.all([load(`${base}webxr-profiles/meta-quest-touch-plus/${side}.glb`),load(`${base}webxr-profiles/generic-hand/${side}.glb`)]);grip.add(controllerAsset.clone(true));const object=cloneSkinned(handAsset);styleHandModel(object,createControllerHandMaterial());object.updateMatrixWorld(true);hand={object,poser:createHandPoser(object)};alignHandToGrip(object,side,resultingTune(side));grip.add(object);applyPose();updateReadout()}
const gui=new GUI({container:document.querySelector('#gui'),title:'Hand position relative to controller'});gui.add(state,'handedness',{Right:'right',Left:'left'}).name('Hand').onChange(rebuild);const position=gui.addFolder('Position adjustment — inches');for(const [axis,label] of [['x','X · palm / dorsal'],['y','Y · thumb / down'],['z','Z · forward / back']])position.add(state,axis,-8,8,.05).name(label).onChange(rebuild);const pose=gui.addFolder('Controller pose');pose.add(state,'trigger',0,1,.01).name('Trigger').onChange(applyPose);pose.add(state,'grip',0,1,.01).name('Grip').onChange(applyPose);pose.add(state,'thumb').name('Thumb on controls').onChange(applyPose);
document.querySelector('#copy-offsets').addEventListener('click',async()=>{await navigator.clipboard.writeText(offsetText());toast('Resulting offsets copied')});document.querySelector('#reset-fit').addEventListener('click',()=>{state.x=state.y=state.z=0;for(const controller of position.controllers)controller.updateDisplay();rebuild()});
const enter=document.querySelector('#enter-mr');let stickReady=true,activeSource=null,activeController=null;const xrControllers=[0,1].map(index=>renderer.xr.getControllerGrip(index));
function attachActualController(controller,source){if(source.handedness!==state.handedness)return;activeController=controller;activeSource=source;controller.add(grip);toast(`${source.handedness} controller connected`) }
for(const controller of xrControllers)controller.addEventListener('connected',event=>attachActualController(controller,event.data));
function nudge(axis,delta){state[axis]=THREE.MathUtils.clamp(state[axis]+delta,-8,8);position.controllers.find(c=>c.property===axis)?.updateDisplay();rebuild()}
enter.addEventListener('click',async()=>{try{const session=await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['local-floor']});watchSession(session);for(const controller of xrControllers){scene.add(controller);controller.addEventListener('selectstart',()=>nudge('y',.05));controller.addEventListener('squeezestart',()=>nudge('y',-.05));}session.addEventListener('end',()=>{for(const controller of xrControllers)scene.remove(controller);activeSource=activeController=null;scene.add(grip);enter.hidden=false});await renderer.xr.setSession(session);enter.hidden=true;toast('Use the selected-hand controller · stick: X/Z · trigger: up · grip: down')}catch(error){toast(`MR unavailable: ${error.message}`)}});
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix()}function render(){if(renderer.xr.isPresenting){const axes=activeSource?.gamepad?.axes||[];const x=axes.at(-2)||0,z=axes.at(-1)||0;if(Math.hypot(x,z)<.35)stickReady=true;else if(stickReady){stickReady=false;nudge('x',Math.sign(x)*.05);nudge('z',Math.sign(z)*.05)}}controls.update();renderer.render(scene,camera)}addEventListener('resize',resize);resize();renderer.setAnimationLoop(render);rebuild();
