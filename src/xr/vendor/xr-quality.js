// How much of the headset's native resolution the page asks for, and what it spends the
// saving on. A framebuffer scale of 1.0 is not "no scaling" -- it is the resolution the
// runtime recommends, which on a high-resolution headset is far more pixels than a WebGL
// scene with real-time shadows can shade inside a 90 Hz frame. Scale is the largest lever
// a page has: it saves quadratically on every fragment, and the compositor resamples the
// result, so the cost lands on sharpness rather than on frame pacing.
//
// No headset names appear here, per XR-COMPATIBILITY.md. A level is a user-visible
// preference with a conservative default, and measured frame timing moves it -- so a
// device we have never tested gets a sensible number instead of a special case.

// framebufferScale is read once per session (the runtime allocates the layer at entry, so
// three.js can only apply it before setSession). shadowMapSize and shadowUpdateHz are live:
// they are what an application can still give up mid-session when frames start slipping.
// pixelBudget is the total eye-buffer pixel count (both eyes, at scale 1) a level is willing to
// shade; framebufferScaleFor() below turns a headset's actual recommended buffer into a scale
// that fits inside it. sharp has no budget (Infinity: never scale down the runtime recommendation
// on its own), balanced's ~6.0e6 keeps a Quest 3-class buffer (~5.9e6px) at its raised .9 cap, and
// smooth's ~4.0e6 pulls a high-resolution headset down harder than the flat .7 alone would.
export const QUALITY_LEVELS={
 sharp:{framebufferScale:1,pixelBudget:Infinity,shadowMapSize:2048,shadowUpdateHz:30,softShadows:true,pixelRatioCap:2},
 balanced:{framebufferScale:.9,pixelBudget:6.0e6,shadowMapSize:1024,shadowUpdateHz:18,softShadows:true,pixelRatioCap:1.5},
 smooth:{framebufferScale:.7,pixelBudget:4.0e6,shadowMapSize:512,shadowUpdateHz:12,softShadows:false,pixelRatioCap:1.25},
};
// Ordered sharpest first, so stepping down is one index forward. The order is the contract
// the frame budget and the settings board both read; do not sort it elsewhere.
export const QUALITY_ORDER=['sharp','balanced','smooth'];
export const DEFAULT_QUALITY='balanced';

export function qualityLevel(name){return QUALITY_LEVELS[name]??QUALITY_LEVELS[DEFAULT_QUALITY];}
// One step toward smoother, saturating at the last level. Returns the same name when there
// is nothing left to give up, which is how callers know to stop asking.
export function nextSmoother(name){
 const index=QUALITY_ORDER.indexOf(name);
 if(index<0)return DEFAULT_QUALITY;
 return QUALITY_ORDER[Math.min(index+1,QUALITY_ORDER.length-1)];
}
export function nextSharper(name){
 const index=QUALITY_ORDER.indexOf(name);
 if(index<0)return DEFAULT_QUALITY;
 return QUALITY_ORDER[Math.max(index-1,0)];
}

// The scale to request for a headset's actual recommended buffer, given a level's cap and pixel
// budget. A framebufferScaleFor factor of 1.0 does not mean "no scaling" -- it means the runtime's
// own *recommended* size, which the probe in xr-capabilities.js reads fresh from the session's
// XRWebGLLayer at scale 1. That recommended size is set by the headset's panel resolution, not by
// anything this page controls, so a level that only ever applied a flat multiplier (the old
// framebufferScale alone) either wasted pixels on a modest headset or still overran the frame
// budget on a dense one. Scaling to a pixel budget instead is a fix that follows the actual buffer
// the runtime handed back on THIS entry -- no headset name, no user-agent sniff, just the numbers
// the platform already gave us (XR-COMPATIBILITY.md: capability detection only).
export function framebufferScaleFor(width,height,level){
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return level.framebufferScale;
 const scale=Math.min(level.framebufferScale,Math.sqrt(level.pixelBudget/(width*height)));
 return Math.min(1,Math.max(.55,scale));
}

// Applies a level to a renderer. Split from the level table so the table stays pure and
// testable, and so applications with their own shadow pipeline (a cached depth map, a
// throttled invalidator) can take the numbers without this touching their renderer.
export function applyRenderQuality(renderer,name,{shadowLights=[],shadowTypes=null,scene=null}={}){
 const level=qualityLevel(name);
 // Before session entry this is the number the runtime will allocate from; after entry it
 // is recorded for the next session. Either way it is safe to set at any time.
 renderer.xr?.setFramebufferScaleFactor?.(level.framebufferScale);
 renderer.setPixelRatio?.(Math.min(globalThis.devicePixelRatio??1,level.pixelRatioCap));
 for(const light of shadowLights){
  if(!light?.shadow)continue;
  if(light.shadow.mapSize.width!==level.shadowMapSize){
   light.shadow.mapSize.setScalar(level.shadowMapSize);
   // A resized map needs its allocated target dropped, or three.js keeps rendering into
   // the old one at the old resolution.
   light.shadow.map?.dispose?.();light.shadow.map=null;
  }
 }
 // Soft (PCF-filtered) shadows sample the map several times per fragment; at headset
 // resolution that is a measurable share of the frame. The type is baked into compiled
 // programs, so a change has to mark every material dirty -- one hitch, on a deliberate
 // quality change, rather than a per-frame cost.
 if(shadowTypes&&renderer.shadowMap){
  const type=level.softShadows?shadowTypes.soft:shadowTypes.basic;
  if(renderer.shadowMap.type!==type){
   renderer.shadowMap.type=type;renderer.shadowMap.needsUpdate=true;
   scene?.traverse?.(object=>{const material=object.material;if(!material)return;for(const each of Array.isArray(material)?material:[material])each.needsUpdate=true;});
  }
 }
 return level;
}

// Rolling frame-time watch. Its only job is to answer "are we missing the display's
// frames, sustained, rather than for one hitch?" -- loading a model, entering a session and
// the first shadow update all produce single slow frames that must not change quality.
// Windows are discrete, not sliding: a verdict is reached once per `window` frames, so
// `patience` means whole windows in a row and a single bad stretch cannot be counted twice.
export function createFrameBudget({targetHz=72,window=90,strainRatio=1.2,headroomRatio=.7,patience=2}={}){
 const budget=1000/targetHz;
 let count=0,total=0,lastAverage=0,strainRuns=0,headroomRuns=0;
 return {
  get budgetMs(){return budget;},
  // The last completed window's mean; zero until one has completed.
  get averageMs(){return lastAverage;},
  // Frames collected toward the current window.
  get samples(){return count;},
  push(frameMs){
   if(!Number.isFinite(frameMs)||frameMs<=0)return;
   // A stall -- a model load, a shader compile -- is not a frame rate. It counts as at most
   // three missed frames, so one hitch cannot drag a whole window over the line by itself.
   total+=Math.min(frameMs,budget*3);count++;
   if(count<window)return;
   lastAverage=total/count;count=0;total=0;
   if(lastAverage>budget*strainRatio){strainRuns++;headroomRuns=0;}
   else if(lastAverage<budget*headroomRatio){headroomRuns++;strainRuns=0;}
   else{strainRuns=0;headroomRuns=0;}
  },
  // True only after `patience` consecutive full windows on the wrong side of the budget.
  get strained(){return strainRuns>=patience;},
  get hasHeadroom(){return headroomRuns>=patience;},
  reset(){count=0;total=0;lastAverage=0;strainRuns=0;headroomRuns=0;},
 };
}

// The frame rate to budget against: what the session actually reports, not an assumption.
// A Vision Pro session runs at 90 Hz, a Quest session at 72 or 90 or 120, and a session
// that reports nothing is treated as 72 so we do not manufacture strain that is not there.
export function sessionTargetHz(session){
 const rate=session?.frameRate??session?.supportedFrameRates?.[0];
 return Number.isFinite(rate)&&rate>0?rate:72;
}
