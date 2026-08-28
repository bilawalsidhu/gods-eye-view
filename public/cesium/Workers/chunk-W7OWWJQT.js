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

import{a as z,c as q}from"./chunk-G72WI3OZ.js";import{a as U}from"./chunk-RNF7TLFF.js";import{f as I}from"./chunk-M3A6SPGI.js";import{a as e,e as C}from"./chunk-S4VBGY2U.js";import{a as O}from"./chunk-UCTPWOTZ.js";import{e as j}from"./chunk-3THTQ4QB.js";var G={},B=new e,J=new e,_=new e,v=new e,g=[new e,new e],K=new e,W=new e,X=new e,$=new e,ee=new e,te=new e,ne=new e,oe=new e,re=new e,se=new e,F=new I,k=new C;function V(o,s,a,c,r){let d=e.angleBetween(e.subtract(s,o,B),e.subtract(a,o,J)),y=c===z.BEVELED?1:Math.ceil(d/O.toRadians(5))+1,n=y*3,l=new Array(n);l[n-3]=a.x,l[n-2]=a.y,l[n-1]=a.z;let m;r?m=C.fromQuaternion(I.fromAxisAngle(e.negate(o,B),d/y,F),k):m=C.fromQuaternion(I.fromAxisAngle(o,d/y,F),k);let t=0;s=e.clone(s,B);for(let i=0;i<y;i++)s=C.multiplyByVector(m,s,s),l[t++]=s.x,l[t++]=s.y,l[t++]=s.z;return l}function ae(o){let s=K,a=W,c=X,r=o[1];a=e.fromArray(o[1],r.length-3,a),c=e.fromArray(o[0],0,c),s=e.midpoint(a,c,s);let d=V(s,a,c,z.ROUNDED,!1),y=o.length-1,n=o[y-1];r=o[y],a=e.fromArray(n,n.length-3,a),c=e.fromArray(r,0,c),s=e.midpoint(a,c,s);let l=V(s,a,c,z.ROUNDED,!1);return[d,l]}function H(o,s,a,c){let r=B;return c?r=e.add(o,s,r):(s=e.negate(s,s),r=e.add(o,s,r)),[r.x,r.y,r.z,a.x,a.y,a.z]}function T(o,s,a,c){let r=new Array(o.length),d=new Array(o.length),y=e.multiplyByScalar(s,a,B),n=e.negate(y,J),l=0,m=o.length-1;for(let t=0;t<o.length;t+=3){let i=e.fromArray(o,t,_),w=e.add(i,n,v);r[l++]=w.x,r[l++]=w.y,r[l++]=w.z;let f=e.add(i,y,v);d[m--]=f.z,d[m--]=f.y,d[m--]=f.x}return c.push(r,d),c}G.addAttribute=function(o,s,a,c){let r=s.x,d=s.y,y=s.z;j(a)&&(o[a]=r,o[a+1]=d,o[a+2]=y),j(c)&&(o[c]=y,o[c-1]=d,o[c-2]=r)};var le=new e,ce=new e;G.computePositions=function(o){let s=o.granularity,a=o.positions,c=o.ellipsoid,r=o.width/2,d=o.cornerType,y=o.saveAttributes,n=K,l=W,m=X,t=$,i=ee,w=te,f=ne,u=oe,p=re,x=se,E=[],S=y?[]:void 0,D=y?[]:void 0,h=a[0],N=a[1];l=e.normalize(e.subtract(N,h,l),l),n=c.geodeticSurfaceNormal(h,n),t=e.normalize(e.cross(n,l,t),t),y&&(S.push(t.x,t.y,t.z),D.push(n.x,n.y,n.z)),f=e.clone(h,f),h=N,m=e.negate(l,m);let A,P=[],M,Y=a.length;for(M=1;M<Y-1;M++){n=c.geodeticSurfaceNormal(h,n),N=a[M+1],l=e.normalize(e.subtract(N,h,l),l);let L=e.multiplyByScalar(n,e.dot(l,n),le);e.subtract(l,L,L),e.normalize(L,L);let R=e.multiplyByScalar(n,e.dot(m,n),ce);if(e.subtract(m,R,R),e.normalize(R,R),!O.equalsEpsilon(Math.abs(e.dot(L,R)),1,O.EPSILON7)){i=e.normalize(e.add(l,m,i),i),i=e.cross(i,n,i),i=e.cross(n,i,i),i=e.normalize(i,i);let Z=r/Math.max(.25,e.magnitude(e.cross(i,m,B))),b=q.angleIsGreaterThanPi(l,m,h,c);i=e.multiplyByScalar(i,Z,i),b?(u=e.add(h,i,u),x=e.add(u,e.multiplyByScalar(t,r,x),x),p=e.add(u,e.multiplyByScalar(t,r*2,p),p),g[0]=e.clone(f,g[0]),g[1]=e.clone(x,g[1]),A=U.generateArc({positions:g,granularity:s,ellipsoid:c}),E=T(A,t,r,E),y&&(S.push(t.x,t.y,t.z),D.push(n.x,n.y,n.z)),w=e.clone(p,w),t=e.normalize(e.cross(n,l,t),t),p=e.add(u,e.multiplyByScalar(t,r*2,p),p),f=e.add(u,e.multiplyByScalar(t,r,f),f),d===z.ROUNDED||d===z.BEVELED?P.push({leftPositions:V(u,w,p,d,b)}):P.push({leftPositions:H(h,e.negate(i,i),p,b)})):(p=e.add(h,i,p),x=e.add(p,e.negate(e.multiplyByScalar(t,r,x),x),x),u=e.add(p,e.negate(e.multiplyByScalar(t,r*2,u),u),u),g[0]=e.clone(f,g[0]),g[1]=e.clone(x,g[1]),A=U.generateArc({positions:g,granularity:s,ellipsoid:c}),E=T(A,t,r,E),y&&(S.push(t.x,t.y,t.z),D.push(n.x,n.y,n.z)),w=e.clone(u,w),t=e.normalize(e.cross(n,l,t),t),u=e.add(p,e.negate(e.multiplyByScalar(t,r*2,u),u),u),f=e.add(p,e.negate(e.multiplyByScalar(t,r,f),f),f),d===z.ROUNDED||d===z.BEVELED?P.push({rightPositions:V(p,w,u,d,b)}):P.push({rightPositions:H(h,i,u,b)})),m=e.negate(l,m)}h=N}n=c.geodeticSurfaceNormal(h,n),g[0]=e.clone(f,g[0]),g[1]=e.clone(h,g[1]),A=U.generateArc({positions:g,granularity:s,ellipsoid:c}),E=T(A,t,r,E),y&&(S.push(t.x,t.y,t.z),D.push(n.x,n.y,n.z));let Q;return d===z.ROUNDED&&(Q=ae(E)),{positions:E,corners:P,lefts:S,normals:D,endPositions:Q}};var we=G;export{we as a};
