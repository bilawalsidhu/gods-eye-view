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

import{a as k,b as _,c as j}from"./chunk-Q5IXWMLP.js";import"./chunk-6HIVPZ7K.js";import"./chunk-RRZIPF5C.js";import{a as A}from"./chunk-24JYWT5N.js";import{b as N,c as g,d as F}from"./chunk-LH3SUUXG.js";import{d as T}from"./chunk-K2M3OJ7Z.js";import{f as s}from"./chunk-M3A6SPGI.js";import{a as b}from"./chunk-D5HNP2LB.js";import{a}from"./chunk-S4VBGY2U.js";import"./chunk-UCTPWOTZ.js";import"./chunk-54PMPXZ4.js";import"./chunk-R62IKKEC.js";import{a as d}from"./chunk-N3A5CZ2S.js";import{b as h}from"./chunk-G75U3WZT.js";import{e as w}from"./chunk-3THTQ4QB.js";var L=0,C=1;function l(e){h.typeOf.object("options",e),h.typeOf.object("options.frustum",e.frustum),h.typeOf.object("options.origin",e.origin),h.typeOf.object("options.orientation",e.orientation);let t=e.frustum,o=e.orientation,u=e.origin,c=d(e._drawNearPlane,!0),m,p;t instanceof _?(m=L,p=_.packedLength):t instanceof k&&(m=C,p=k.packedLength),this._frustumType=m,this._frustum=t.clone(),this._origin=a.clone(u),this._orientation=s.clone(o),this._drawNearPlane=c,this._workerName="createFrustumOutlineGeometry",this.packedLength=2+p+a.packedLength+s.packedLength}l.pack=function(e,t,o){h.typeOf.object("value",e),h.defined("array",t),o=d(o,0);let u=e._frustumType,c=e._frustum;return t[o++]=u,u===L?(_.pack(c,t,o),o+=_.packedLength):(k.pack(c,t,o),o+=k.packedLength),a.pack(e._origin,t,o),o+=a.packedLength,s.pack(e._orientation,t,o),o+=s.packedLength,t[o]=e._drawNearPlane?1:0,t};var E=new _,G=new k,R=new s,S=new a;l.unpack=function(e,t,o){h.defined("array",e),t=d(t,0);let u=e[t++],c;u===L?(c=_.unpack(e,t,E),t+=_.packedLength):(c=k.unpack(e,t,G),t+=k.packedLength);let m=a.unpack(e,t,S);t+=a.packedLength;let p=s.unpack(e,t,R);t+=s.packedLength;let P=e[t]===1;if(!w(o))return new l({frustum:c,origin:m,orientation:p,_drawNearPlane:P});let n=u===o._frustumType?o._frustum:void 0;return o._frustum=c.clone(n),o._frustumType=u,o._origin=a.clone(m,o._origin),o._orientation=s.clone(p,o._orientation),o._drawNearPlane=P,o};l.createGeometry=function(e){let t=e._frustumType,o=e._frustum,u=e._origin,c=e._orientation,m=e._drawNearPlane,p=new Float64Array(3*4*2);j._computeNearFarPlanes(u,c,t,o,p);let P=new A({position:new F({componentDatatype:b.DOUBLE,componentsPerAttribute:3,values:p})}),n,r,y=m?2:1,i=new Uint16Array(8*(y+1)),f=m?0:1;for(;f<2;++f)n=m?f*8:0,r=f*4,i[n]=r,i[n+1]=r+1,i[n+2]=r+1,i[n+3]=r+2,i[n+4]=r+2,i[n+5]=r+3,i[n+6]=r+3,i[n+7]=r;for(f=0;f<2;++f)n=(y+f)*8,r=f*4,i[n]=r,i[n+1]=r+4,i[n+2]=r+1,i[n+3]=r+5,i[n+4]=r+2,i[n+5]=r+6,i[n+6]=r+3,i[n+7]=r+7;return new g({attributes:P,indices:i,primitiveType:N.LINES,boundingSphere:T.fromVertices(p)})};var O=l;function D(e,t){return w(t)&&(e=O.unpack(e,t)),O.createGeometry(e)}var I=D;export{I as default};
