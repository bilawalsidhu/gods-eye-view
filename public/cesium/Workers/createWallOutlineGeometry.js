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

import{a as z}from"./chunk-KUQFR7AR.js";import"./chunk-EOGEW5R4.js";import"./chunk-DISRVBHE.js";import"./chunk-ORULHQGP.js";import"./chunk-A4PR3MVA.js";import"./chunk-JKEOJFWC.js";import"./chunk-FWQONNTL.js";import{a as W}from"./chunk-Z7UZ2XGJ.js";import{a as N}from"./chunk-UA3N5FHD.js";import{b as R,c as S,d as M}from"./chunk-LN5LAAB6.js";import{c as D}from"./chunk-OXROQHTA.js";import"./chunk-GQG3G4OP.js";import"./chunk-4JSGO3Z7.js";import"./chunk-V62DYOIH.js";import{a as q}from"./chunk-54IT5KT4.js";import"./chunk-E6GK7MVP.js";import"./chunk-YQTAAITT.js";import{c as l}from"./chunk-WV2SHQ7E.js";import{a as p,c as O}from"./chunk-TODZU3UG.js";import{a as b}from"./chunk-3XRQCEHV.js";import{a as H}from"./chunk-VIWNLE3Z.js";import{e as m}from"./chunk-4TAASUQ2.js";var B=new p,U=new p;function _(i){i=i??O.EMPTY_OBJECT;let t=i.positions,e=i.maximumHeights,o=i.minimumHeights;if(!m(t))throw new H("options.positions is required.");if(m(e)&&e.length!==t.length)throw new H("options.positions and options.maximumHeights must have the same length.");if(m(o)&&o.length!==t.length)throw new H("options.positions and options.minimumHeights must have the same length.");let s=i.granularity??b.RADIANS_PER_DEGREE,r=i.ellipsoid??l.default;this._positions=t,this._minimumHeights=o,this._maximumHeights=e,this._granularity=s,this._ellipsoid=l.clone(r),this._workerName="createWallOutlineGeometry";let n=1+t.length*p.packedLength+2;m(o)&&(n+=o.length),m(e)&&(n+=e.length),this.packedLength=n+l.packedLength+1}_.pack=function(i,t,e){if(!m(i))throw new H("value is required");if(!m(t))throw new H("array is required");e=e??0;let o,s=i._positions,r=s.length;for(t[e++]=r,o=0;o<r;++o,e+=p.packedLength)p.pack(s[o],t,e);let n=i._minimumHeights;if(r=m(n)?n.length:0,t[e++]=r,m(n))for(o=0;o<r;++o)t[e++]=n[o];let c=i._maximumHeights;if(r=m(c)?c.length:0,t[e++]=r,m(c))for(o=0;o<r;++o)t[e++]=c[o];return l.pack(i._ellipsoid,t,e),e+=l.packedLength,t[e]=i._granularity,t};var G=l.clone(l.UNIT_SPHERE),L={positions:void 0,minimumHeights:void 0,maximumHeights:void 0,ellipsoid:G,granularity:void 0};_.unpack=function(i,t,e){if(!m(i))throw new H("array is required");t=t??0;let o,s=i[t++],r=new Array(s);for(o=0;o<s;++o,t+=p.packedLength)r[o]=p.unpack(i,t);s=i[t++];let n;if(s>0)for(n=new Array(s),o=0;o<s;++o)n[o]=i[t++];s=i[t++];let c;if(s>0)for(c=new Array(s),o=0;o<s;++o)c[o]=i[t++];let w=l.unpack(i,t,G);t+=l.packedLength;let u=i[t];return m(e)?(e._positions=r,e._minimumHeights=n,e._maximumHeights=c,e._ellipsoid=l.clone(w,e._ellipsoid),e._granularity=u,e):(L.positions=r,L.minimumHeights=n,L.maximumHeights=c,L.granularity=u,new _(L))};_.fromConstantHeights=function(i){i=i??O.EMPTY_OBJECT;let t=i.positions;if(!m(t))throw new H("options.positions is required.");let e,o,s=i.minimumHeight,r=i.maximumHeight,n=m(s),c=m(r);if(n||c){let u=t.length;e=n?new Array(u):void 0,o=c?new Array(u):void 0;for(let g=0;g<u;++g)n&&(e[g]=s),c&&(o[g]=r)}let w={positions:t,maximumHeights:o,minimumHeights:e,ellipsoid:i.ellipsoid};return new _(w)};_.createGeometry=function(i){let t=i._positions,e=i._minimumHeights,o=i._maximumHeights,s=i._granularity,r=i._ellipsoid,n=z.computePositions(r,t,o,e,s,!1);if(!m(n))return;let c=n.bottomPositions,w=n.topPositions,u=w.length,g=u*2,f=new Float64Array(g),E=0;u/=3;let h;for(h=0;h<u;++h){let y=h*3,A=p.fromArray(w,y,B),k=p.fromArray(c,y,U);f[E++]=k.x,f[E++]=k.y,f[E++]=k.z,f[E++]=A.x,f[E++]=A.y,f[E++]=A.z}let v=new N({position:new M({componentDatatype:q.DOUBLE,componentsPerAttribute:3,values:f})}),P=g/3;g=2*P-4+P;let a=W.createTypedArray(P,g),d=0;for(h=0;h<P-2;h+=2){let y=h,A=h+2,k=p.fromArray(f,y*3,B),x=p.fromArray(f,A*3,U);if(p.equalsEpsilon(k,x,b.EPSILON10))continue;let T=h+1,F=h+3;a[d++]=T,a[d++]=y,a[d++]=T,a[d++]=F,a[d++]=y,a[d++]=A}return a[d++]=P-2,a[d++]=P-1,new S({attributes:v,indices:a,primitiveType:R.LINES,boundingSphere:new D.fromVertices(f)})};var C=_;function J(i,t){return m(t)&&(i=C.unpack(i,t)),i._ellipsoid=l.clone(i._ellipsoid),C.createGeometry(i)}var pi=J;export{pi as default};
