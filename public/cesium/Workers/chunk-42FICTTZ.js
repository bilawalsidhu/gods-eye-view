/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.124
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

import{a as C}from"./chunk-RNF7TLFF.js";import{a as P}from"./chunk-GJI4ZBKE.js";import{a as O,b as L}from"./chunk-S4VBGY2U.js";import{a as y}from"./chunk-UCTPWOTZ.js";import{e as S}from"./chunk-3THTQ4QB.js";var T={};function b(a,e){return y.equalsEpsilon(a.latitude,e.latitude,y.EPSILON10)&&y.equalsEpsilon(a.longitude,e.longitude,y.EPSILON10)}var q=new L,v=new L;function w(a,e,i,h){e=P(e,O.equalsEpsilon);let p=e.length;if(p<2)return;let E=S(h),u=S(i),l=new Array(p),g=new Array(p),r=new Array(p),d=e[0];l[0]=d;let f=a.cartesianToCartographic(d,q);u&&(f.height=i[0]),g[0]=f.height,E?r[0]=h[0]:r[0]=0;let o=g[0],m=r[0],t=o===m,n=1;for(let c=1;c<p;++c){let A=e[c],s=a.cartesianToCartographic(A,v);u&&(s.height=i[c]),t=t&&s.height===0,b(f,s)?f.height<s.height&&(g[n-1]=s.height):(l[n]=A,g[n]=s.height,E?r[n]=h[c]:r[n]=0,t=t&&g[n]===r[n],L.clone(s,f),++n)}if(!(t||n<2))return l.length=n,g.length=n,r.length=n,{positions:l,topHeights:g,bottomHeights:r}}var D=new Array(2),F=new Array(2),B={positions:void 0,height:void 0,granularity:void 0,ellipsoid:void 0};T.computePositions=function(a,e,i,h,p,E){let u=w(a,e,i,h);if(!S(u))return;e=u.positions,i=u.topHeights,h=u.bottomHeights;let l=e.length,g=l-2,r,d,f=y.chordLength(p,a.maximumRadius),o=B;if(o.minDistance=f,o.ellipsoid=a,E){let m=0,t;for(t=0;t<l-1;t++)m+=C.numberOfPoints(e[t],e[t+1],f)+1;r=new Float64Array(m*3),d=new Float64Array(m*3);let n=D,c=F;o.positions=n,o.height=c;let A=0;for(t=0;t<l-1;t++){n[0]=e[t],n[1]=e[t+1],c[0]=i[t],c[1]=i[t+1];let s=C.generateArc(o);r.set(s,A),c[0]=h[t],c[1]=h[t+1],d.set(C.generateArc(o),A),A+=s.length}}else o.positions=e,o.height=i,r=new Float64Array(C.generateArc(o)),o.height=h,d=new Float64Array(C.generateArc(o));return{bottomPositions:d,topPositions:r,numCorners:g}};var j=T;export{j as a};
