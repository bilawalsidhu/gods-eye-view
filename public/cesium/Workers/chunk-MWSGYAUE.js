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

import{f as C}from"./chunk-M3A6SPGI.js";import{a as n,e as b}from"./chunk-S4VBGY2U.js";import{a as w}from"./chunk-UCTPWOTZ.js";var j={},q=new n,L=new n,Q=new C,G=new b;function W(m,O,p,S,g,_,d,f,M,s){let a=m+O;n.multiplyByScalar(S,Math.cos(a),q),n.multiplyByScalar(p,Math.sin(a),L),n.add(q,L,q);let u=Math.cos(m);u=u*u;let l=Math.sin(m);l=l*l;let h=_/Math.sqrt(d*u+g*l)/f;return C.fromAxisAngle(q,h,Q),b.fromQuaternion(Q,G),b.multiplyByVector(G,M,s),n.normalize(s,s),n.multiplyByScalar(s,f,s),s}var U=new n,Z=new n,N=new n,v=new n;j.raisePositionsToHeight=function(m,O,p){let S=O.ellipsoid,g=O.height,_=O.extrudedHeight,d=p?m.length/3*2:m.length/3,f=new Float64Array(d*3),M=m.length,s=p?M:0;for(let a=0;a<M;a+=3){let u=a+1,l=a+2,r=n.fromArray(m,a,U);S.scaleToGeodeticSurface(r,r);let h=n.clone(r,Z),x=S.geodeticSurfaceNormal(r,v),P=n.multiplyByScalar(x,g,N);n.add(r,P,r),p&&(n.multiplyByScalar(x,_,P),n.add(h,P,h),f[a+s]=h.x,f[u+s]=h.y,f[l+s]=h.z),f[a]=r.x,f[u]=r.y,f[l]=r.z}return f};var D=new n,J=new n,K=new n;j.computeEllipsePositions=function(m,O,p){let S=m.semiMinorAxis,g=m.semiMajorAxis,_=m.rotation,d=m.center,f=m.granularity*8,M=S*S,s=g*g,a=g*S,u=n.magnitude(d),l=n.normalize(d,D),r=n.cross(n.UNIT_Z,d,J);r=n.normalize(r,r);let h=n.cross(l,r,K),x=1+Math.ceil(w.PI_OVER_TWO/f),P=w.PI_OVER_TWO/(x-1),y=w.PI_OVER_TWO-x*P;y<0&&(x-=Math.ceil(Math.abs(y)/P));let k=2*(x*(x+2)),e=O?new Array(k*3):void 0,o=0,t=U,i=Z,H=x*4*3,z=H-1,A=0,c=p?new Array(H):void 0,I,T,R,E,V;for(y=w.PI_OVER_TWO,t=W(y,_,h,r,M,a,s,u,l,t),O&&(e[o++]=t.x,e[o++]=t.y,e[o++]=t.z),p&&(c[z--]=t.z,c[z--]=t.y,c[z--]=t.x),y=w.PI_OVER_TWO-P,I=1;I<x+1;++I){if(t=W(y,_,h,r,M,a,s,u,l,t),i=W(Math.PI-y,_,h,r,M,a,s,u,l,i),O){for(e[o++]=t.x,e[o++]=t.y,e[o++]=t.z,R=2*I+2,T=1;T<R-1;++T)E=T/(R-1),V=n.lerp(t,i,E,N),e[o++]=V.x,e[o++]=V.y,e[o++]=V.z;e[o++]=i.x,e[o++]=i.y,e[o++]=i.z}p&&(c[z--]=t.z,c[z--]=t.y,c[z--]=t.x,c[A++]=i.x,c[A++]=i.y,c[A++]=i.z),y=w.PI_OVER_TWO-(I+1)*P}for(I=x;I>1;--I){if(y=w.PI_OVER_TWO-(I-1)*P,t=W(-y,_,h,r,M,a,s,u,l,t),i=W(y+Math.PI,_,h,r,M,a,s,u,l,i),O){for(e[o++]=t.x,e[o++]=t.y,e[o++]=t.z,R=2*(I-1)+2,T=1;T<R-1;++T)E=T/(R-1),V=n.lerp(t,i,E,N),e[o++]=V.x,e[o++]=V.y,e[o++]=V.z;e[o++]=i.x,e[o++]=i.y,e[o++]=i.z}p&&(c[z--]=t.z,c[z--]=t.y,c[z--]=t.x,c[A++]=i.x,c[A++]=i.y,c[A++]=i.z)}y=w.PI_OVER_TWO,t=W(-y,_,h,r,M,a,s,u,l,t);let B={};return O&&(e[o++]=t.x,e[o++]=t.y,e[o++]=t.z,B.positions=e,B.numPts=x),p&&(c[z--]=t.z,c[z--]=t.y,c[z--]=t.x,B.outerPositions=c),B};var tt=j;export{tt as a};
