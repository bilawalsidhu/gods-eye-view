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

import{a as K}from"./chunk-4BYMTYMT.js";import{a as G}from"./chunk-Q5MYX5A2.js";import{a as S}from"./chunk-34ULWVZF.js";import{c as B,h as R}from"./chunk-M3A6SPGI.js";import"./chunk-D5HNP2LB.js";import{a as t,b as _,d as L}from"./chunk-S4VBGY2U.js";import{a as F}from"./chunk-UCTPWOTZ.js";import"./chunk-54PMPXZ4.js";import"./chunk-R62IKKEC.js";import"./chunk-N3A5CZ2S.js";import"./chunk-G75U3WZT.js";import"./chunk-3THTQ4QB.js";var O=32767,ct=new _,rt=new t;function it(n,o,p,m,s){let d=n.length/3,U=n.subarray(0,d),v=n.subarray(d,2*d),P=n.subarray(2*d,3*d);G.zigZagDeltaDecode(U,v,P);let D=new Float64Array(n.length);for(let u=0;u<d;++u){let e=U[u],A=v[u],l=P[u],k=F.lerp(o.west,o.east,e/O),I=F.lerp(o.south,o.north,A/O),E=F.lerp(p,m,l/O),g=_.fromRadians(k,I,E,ct),C=s.cartographicToCartesian(g,rt);t.pack(C,D,u*3)}return D}var Y=it;var X=new R,$=new L,j=new t,H={min:void 0,max:void 0};function at(n){n=new Float64Array(n);let o=0;H.min=n[o++],H.max=n[o++],R.unpack(n,o,X),o+=R.packedLength,L.unpack(n,o,$),o+=L.packedLength,t.unpack(n,o,j)}function ft(n){let o=n.length,p=new Uint32Array(o+1),m=0;for(let s=0;s<o;++s)p[s]=m,m+=n[s];return p[o]=m,p}var Z=new t,q=new t,J=new t,dt=new t,Q=new t;function ut(n,o){let p=new Uint16Array(n.positions),m=new Uint16Array(n.widths),s=new Uint32Array(n.counts),d=new Uint16Array(n.batchIds);at(n.packedBuffer);let U=X,v=$,P=j,D=H.min,u=H.max,e=Y(p,U,D,u,v),A=e.length/3,l=A*4-4,k=new Float32Array(l*3),I=new Float32Array(l*3),E=new Float32Array(l*3),g=new Float32Array(l*2),C=new Uint16Array(l),N=0,z=0,tt=0,r,h=0,M=s.length;for(r=0;r<M;++r){let a=s[r],nt=m[r],ot=d[r];for(let f=0;f<a;++f){let w;if(f===0){let c=t.unpack(e,h*3,Z),T=t.unpack(e,(h+1)*3,q);w=t.subtract(c,T,J),t.add(c,w,w)}else w=t.unpack(e,(h+f-1)*3,J);let W=t.unpack(e,(h+f)*3,dt),x;if(f===a-1){let c=t.unpack(e,(h+a-1)*3,Z),T=t.unpack(e,(h+a-2)*3,q);x=t.subtract(c,T,Q),t.add(c,x,x)}else x=t.unpack(e,(h+f+1)*3,Q);t.subtract(w,P,w),t.subtract(W,P,W),t.subtract(x,P,x);let et=f===0?2:0,st=f===a-1?2:4;for(let c=et;c<st;++c){t.pack(W,k,N),t.pack(w,I,N),t.pack(x,E,N),N+=3;let T=c-2<0?-1:1;g[z++]=2*(c%2)-1,g[z++]=T*nt,C[tt++]=ot}}h+=a}let i=S.createTypedArray(l,A*6-6),b=0,y=0;for(M=A-1,r=0;r<M;++r)i[y++]=b,i[y++]=b+2,i[y++]=b+1,i[y++]=b+1,i[y++]=b+2,i[y++]=b+3,b+=4;o.push(k.buffer,I.buffer,E.buffer),o.push(g.buffer,C.buffer,i.buffer);let V={indexDatatype:i.BYTES_PER_ELEMENT===2?S.UNSIGNED_SHORT:S.UNSIGNED_INT,currentPositions:k.buffer,previousPositions:I.buffer,nextPositions:E.buffer,expandAndWidth:g.buffer,batchIds:C.buffer,indices:i.buffer};if(n.keepDecodedPositions){let a=ft(s);o.push(e.buffer,a.buffer),V=B(V,{decodedPositions:e.buffer,decodedPositionOffsets:a.buffer})}return V}var It=K(ut);export{It as default};
