/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.138.0
 *
 * Copyright 2011-2022 Cesium Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Columbus View (Pat. Pend.)
 *
 * Portions licensed separately.
 * See https://github.com/CesiumGS/cesium/blob/main/LICENSE.md for full licensing details.
 */

import{a as y}from"./chunk-BUKMP3AW.js";import{a as c}from"./chunk-D5QCMU6T.js";import"./chunk-GQG3G4OP.js";import{b as a}from"./chunk-V62DYOIH.js";import"./chunk-YQTAAITT.js";import{a as n}from"./chunk-TODZU3UG.js";import"./chunk-3XRQCEHV.js";import"./chunk-VIWNLE3Z.js";import"./chunk-4TAASUQ2.js";var b=new n,d=new n,A=[new n,new n,new n],x=new c,f=new n(.5,.5,.5),p=new n(-.5,-.5,-.5);function h(e,r){let o=new Float64Array(e.aabbs),g=Array.from({length:4},(t,i)=>{let s=n.unpack(o,i*6,b),B=n.unpack(o,i*6+3,d);return c.fromCorners(s,B,new c)}),w=new Float64Array(e.inverseTransform),T=a.unpack(w,0,new a),u=new Uint32Array(e.triangleIndices),m=new Float64Array(e.trianglePositions),l=Array.from({length:4},()=>[]);for(let t=0;t<u.length;t++){n.unpack(m,t*9,A[0]),n.unpack(m,t*9+3,A[1]),n.unpack(m,t*9+6,A[2]);let i=k(T,A);for(let s=0;s<4;s++)g[s].intersectAxisAlignedBoundingBox(i)&&l[s].push(u[t])}return{intersectingTrianglesArrays:l.map(t=>{let i=new Uint32Array(t);return r.push(i.buffer),i.buffer})}}function k(e,r){a.multiplyByPoint(e,r[0],r[0]),a.multiplyByPoint(e,r[1],r[1]),a.multiplyByPoint(e,r[2],r[2]);let o=c.fromPoints(r,x);return n.clamp(o.minimum,p,f,o.minimum),n.clamp(o.maximum,p,f,o.maximum),o}var P=y(h);export{P as default};
