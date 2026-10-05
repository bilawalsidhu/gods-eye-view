import test from 'node:test';
import assert from 'node:assert/strict';
import {QUALITY_LEVELS,QUALITY_ORDER,DEFAULT_QUALITY,qualityLevel,nextSmoother,nextSharper,applyRenderQuality,createFrameBudget,sessionTargetHz,framebufferScaleFor} from '../src/xr-quality.js';

test('levels are ordered sharpest first and each step gives up resolution, not just shadows',()=>{
 assert.deepEqual(QUALITY_ORDER,Object.keys(QUALITY_LEVELS));
 assert.ok(QUALITY_ORDER.includes(DEFAULT_QUALITY));
 for(let i=1;i<QUALITY_ORDER.length;i++){
  const sharper=QUALITY_LEVELS[QUALITY_ORDER[i-1]],smoother=QUALITY_LEVELS[QUALITY_ORDER[i]];
  assert.ok(smoother.framebufferScale<sharper.framebufferScale,`${QUALITY_ORDER[i]} renders fewer pixels`);
  assert.ok(smoother.shadowMapSize<=sharper.shadowMapSize);assert.ok(smoother.shadowUpdateHz<=sharper.shadowUpdateHz);
 }
 assert.equal(QUALITY_LEVELS.sharp.framebufferScale,1,'sharp is the runtime recommendation, never above it');
 assert.equal(qualityLevel('bogus'),QUALITY_LEVELS[DEFAULT_QUALITY],'an unknown name is the default, not a crash');
});
test('stepping saturates at both ends and recovers from an unknown level',()=>{
 assert.equal(nextSmoother('sharp'),'balanced');assert.equal(nextSmoother('balanced'),'smooth');assert.equal(nextSmoother('smooth'),'smooth');
 assert.equal(nextSharper('smooth'),'balanced');assert.equal(nextSharper('sharp'),'sharp');
 assert.equal(nextSmoother('bogus'),DEFAULT_QUALITY);assert.equal(nextSharper('bogus'),DEFAULT_QUALITY);
});
test('applying a level sets the framebuffer scale, caps pixel ratio and resizes shadow maps once',()=>{
 let scale=null,ratio=null,disposed=0;
 const light={shadow:{mapSize:{width:2048,height:2048,setScalar(v){this.width=this.height=v}},map:{dispose(){disposed++}}}};
 const renderer={xr:{setFramebufferScaleFactor:v=>scale=v},setPixelRatio:v=>ratio=v};
 globalThis.devicePixelRatio=3;
 const level=applyRenderQuality(renderer,'smooth',{shadowLights:[light,null]});
 assert.equal(scale,QUALITY_LEVELS.smooth.framebufferScale);assert.equal(ratio,QUALITY_LEVELS.smooth.pixelRatioCap);
 assert.equal(light.shadow.mapSize.width,512);assert.equal(light.shadow.map,null);assert.equal(disposed,1,'the old target is released so it is reallocated at the new size');
 applyRenderQuality(renderer,'smooth',{shadowLights:[light]});assert.equal(disposed,1,'same size, nothing to release');
 assert.equal(level,QUALITY_LEVELS.smooth);
 delete globalThis.devicePixelRatio;
});
test('a shadow filter change marks materials dirty, because the type is compiled into programs',()=>{
 const materials=[{needsUpdate:false},{needsUpdate:false}];
 const scene={traverse(fn){fn({material:materials[0]});fn({material:[materials[1]]});fn({})}};
 const renderer={shadowMap:{type:'soft',needsUpdate:false}};
 applyRenderQuality(renderer,'smooth',{shadowTypes:{soft:'soft',basic:'basic'},scene});
 assert.equal(renderer.shadowMap.type,'basic');assert.ok(renderer.shadowMap.needsUpdate);assert.ok(materials.every(m=>m.needsUpdate));
 materials.forEach(m=>m.needsUpdate=false);renderer.shadowMap.needsUpdate=false;
 applyRenderQuality(renderer,'smooth',{shadowTypes:{soft:'soft',basic:'basic'},scene});
 assert.ok(materials.every(m=>!m.needsUpdate),'no change, no recompile');
});
test('the frame budget reports strain only when frames run long for whole windows in a row',()=>{
 const budget=createFrameBudget({targetHz:90,window:10,patience:2});
 assert.ok(Math.abs(budget.budgetMs-11.11)<.01);
 for(let i=0;i<9;i++)budget.push(30);
 assert.equal(budget.strained,false,'not until the window is full');
 budget.push(30);assert.equal(budget.strained,false,'one full window is one run, patience is two');
 for(let i=0;i<10;i++)budget.push(30);assert.equal(budget.strained,true);
 budget.reset();assert.equal(budget.strained,false);assert.equal(budget.samples,0);
});
test('single stalls and hitches do not count as strain, and headroom is reported separately',()=>{
 const budget=createFrameBudget({targetHz:72,window:10,patience:1});
 for(let i=0;i<9;i++)budget.push(11);budget.push(5000);
 assert.equal(budget.strained,false,'one clamped stall among good frames is not a slow session');
 budget.reset();for(let i=0;i<10;i++)budget.push(5);
 assert.equal(budget.hasHeadroom,true);assert.equal(budget.strained,false);
 budget.push(11);budget.push(11);budget.push(NaN);budget.push(-1);budget.push(0);assert.equal(budget.samples,2,'garbage samples are ignored');
 const alternating=createFrameBudget({targetHz:72,window:4,patience:2});
 for(const ms of [30,30,30,30,5,5,5,5,30,30,30,30])alternating.push(ms);
 assert.equal(alternating.strained,false,'a good window between two bad ones resets patience');
});
test('the target rate comes from the session, with a 72 Hz assumption only when it says nothing',()=>{
 assert.equal(sessionTargetHz({frameRate:90}),90);assert.equal(sessionTargetHz({supportedFrameRates:[120,90]}),120);
 assert.equal(sessionTargetHz({}),72);assert.equal(sessionTargetHz(null),72);assert.equal(sessionTargetHz({frameRate:0}),72);
});
test('the framebuffer scale fits a level pixel budget around the headset\'s own recommended buffer',()=>{
 assert.ok(Math.abs(framebufferScaleFor(3360,1760,QUALITY_LEVELS.balanced)-.9)<1e-6,'a Quest-3-class buffer keeps balanced\'s raised cap');
 assert.ok(Math.abs(framebufferScaleFor(7000,3200,QUALITY_LEVELS.balanced)-.55)<1e-6,'a dense buffer would want ~.52, but .55 is the floor');
 assert.equal(framebufferScaleFor(3360,1760,QUALITY_LEVELS.sharp),1,'sharp has no budget, so it stays at the runtime recommendation');
 assert.equal(framebufferScaleFor(20000,20000,QUALITY_LEVELS.sharp),1,'even an enormous buffer cannot push sharp below 1 -- its budget is Infinity');
 assert.equal(framebufferScaleFor(NaN,1760,QUALITY_LEVELS.balanced),QUALITY_LEVELS.balanced.framebufferScale,'garbage width falls back to the level\'s flat scale');
 assert.equal(framebufferScaleFor(3360,0,QUALITY_LEVELS.balanced),QUALITY_LEVELS.balanced.framebufferScale,'a zero dimension is not a finite positive size');
 assert.equal(framebufferScaleFor(3360,-1,QUALITY_LEVELS.balanced),QUALITY_LEVELS.balanced.framebufferScale);
});
