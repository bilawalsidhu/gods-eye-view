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

import{a as z}from"./chunk-K2M3OJ7Z.js";import{h as I,i as b}from"./chunk-M3A6SPGI.js";import{a as W,b as O,d as L}from"./chunk-S4VBGY2U.js";import{a as m}from"./chunk-UCTPWOTZ.js";import{a as v}from"./chunk-G75U3WZT.js";import{e as k}from"./chunk-3THTQ4QB.js";var Z=Math.cos,B=Math.sin,p=Math.sqrt,N={};N.computePosition=function(t,M,g,u,G,h,a){let e=M.radiiSquared,i=t.nwCorner,r=t.boundingRectangle,n=i.latitude-t.granYCos*u+G*t.granXSin,d=Z(n),X=B(n),Y=e.z*X,s=i.longitude+u*t.granYSin+G*t.granXCos,S=d*Z(s),f=d*B(s),w=e.x*S,R=e.y*f,_=p(w*S+R*f+Y*X);if(h.x=w/_,h.y=R/_,h.z=Y/_,g){let o=t.stNwCorner;k(o)?(n=o.latitude-t.stGranYCos*u+G*t.stGranXSin,s=o.longitude+u*t.stGranYSin+G*t.stGranXCos,a.x=(s-t.stWest)*t.lonScalar,a.y=(n-t.stSouth)*t.latScalar):(a.x=(s-r.west)*t.lonScalar,a.y=(n-r.south)*t.latScalar)}};var A=new b,l=new W,F=new O,j=new W,y=new z;function D(t,M,g,u,G,h,a){let e=Math.cos(M),i=u*e,r=g*e,n=Math.sin(M),d=u*n,X=g*n;y._ellipsoid=L.default,l=y.project(t,l),l=W.subtract(l,j,l);let Y=b.fromRotation(M,A);l=b.multiplyByVector(Y,l,l),l=W.add(l,j,l),t=y.unproject(l,t),h-=1,a-=1;let s=t.latitude,S=s+h*X,f=s-i*a,w=s-i*a+h*X,R=Math.max(s,S,f,w),_=Math.min(s,S,f,w),o=t.longitude,E=o+h*r,T=o+a*d,V=o+a*d+h*r,q=Math.max(o,E,T,V),x=Math.min(o,E,T,V);return{north:R,south:_,east:q,west:x,granYCos:i,granYSin:d,granXCos:r,granXSin:X,nwCorner:t}}N.computeOptions=function(t,M,g,u,G,h,a){let e=t.east,i=t.west,r=t.north,n=t.south,d=!1,X=!1;r===m.PI_OVER_TWO&&(d=!0),n===-m.PI_OVER_TWO&&(X=!0);let Y,s=r-n;i>e?Y=m.TWO_PI-i+e:Y=e-i;let S=Math.ceil(Y/M)+1,f=Math.ceil(s/M)+1,w=Y/(S-1),R=s/(f-1),_=I.northwest(t,h),o=I.center(t,F);(g!==0||u!==0)&&(o.longitude<_.longitude&&(o.longitude+=m.TWO_PI),y._ellipsoid=L.default,j=y.project(o,j));let E=R,T=w,V=0,q=0,x=I.clone(t,G),c={granYCos:E,granYSin:V,granXCos:T,granXSin:q,nwCorner:_,boundingRectangle:x,width:S,height:f,northCap:d,southCap:X};if(g!==0){let C=D(_,g,w,R,o,S,f);if(r=C.north,n=C.south,e=C.east,i=C.west,r<-m.PI_OVER_TWO||r>m.PI_OVER_TWO||n<-m.PI_OVER_TWO||n>m.PI_OVER_TWO)throw new v("Rotated rectangle is invalid.  It crosses over either the north or south pole.");c.granYCos=C.granYCos,c.granYSin=C.granYSin,c.granXCos=C.granXCos,c.granXSin=C.granXSin,x.north=r,x.south=n,x.east=e,x.west=i}if(u!==0){g=g-u;let C=I.northwest(x,a),P=D(C,g,w,R,o,S,f);c.stGranYCos=P.granYCos,c.stGranXCos=P.granXCos,c.stGranYSin=P.granYSin,c.stGranXSin=P.granXSin,c.stNwCorner=C,c.stWest=P.west,c.stSouth=P.south}return c};var st=N;export{st as a};
