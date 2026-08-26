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

import{a as k,b as _,c as A}from"./chunk-FYNDPPUD.js";import"./chunk-EKCJJ3N6.js";import"./chunk-FWQONNTL.js";import{a as F}from"./chunk-UA3N5FHD.js";import{b,c as N,d as g}from"./chunk-LN5LAAB6.js";import{c as y}from"./chunk-OXROQHTA.js";import"./chunk-GQG3G4OP.js";import{h as s}from"./chunk-4JSGO3Z7.js";import"./chunk-V62DYOIH.js";import{a as T}from"./chunk-54IT5KT4.js";import"./chunk-E6GK7MVP.js";import"./chunk-YQTAAITT.js";import"./chunk-WV2SHQ7E.js";import{a}from"./chunk-TODZU3UG.js";import"./chunk-3XRQCEHV.js";import{b as h}from"./chunk-VIWNLE3Z.js";import{e as w}from"./chunk-4TAASUQ2.js";var d=0,j=1;function P(e){h.typeOf.object("options",e),h.typeOf.object("options.frustum",e.frustum),h.typeOf.object("options.origin",e.origin),h.typeOf.object("options.orientation",e.orientation);let t=e.frustum,o=e.orientation,u=e.origin,c=e._drawNearPlane??!0,p,m;t instanceof _?(p=d,m=_.packedLength):t instanceof k&&(p=j,m=k.packedLength),this._frustumType=p,this._frustum=t.clone(),this._origin=a.clone(u),this._orientation=s.clone(o),this._drawNearPlane=c,this._workerName="createFrustumOutlineGeometry",this.packedLength=2+m+a.packedLength+s.packedLength}P.pack=function(e,t,o){h.typeOf.object("value",e),h.defined("array",t),o=o??0;let u=e._frustumType,c=e._frustum;return t[o++]=u,u===d?(_.pack(c,t,o),o+=_.packedLength):(k.pack(c,t,o),o+=k.packedLength),a.pack(e._origin,t,o),o+=a.packedLength,s.pack(e._orientation,t,o),o+=s.packedLength,t[o]=e._drawNearPlane?1:0,t};var C=new _,E=new k,G=new s,R=new a;P.unpack=function(e,t,o){h.defined("array",e),t=t??0;let u=e[t++],c;u===d?(c=_.unpack(e,t,C),t+=_.packedLength):(c=k.unpack(e,t,E),t+=k.packedLength);let p=a.unpack(e,t,R);t+=a.packedLength;let m=s.unpack(e,t,G);t+=s.packedLength;let l=e[t]===1;if(!w(o))return new P({frustum:c,origin:p,orientation:m,_drawNearPlane:l});let n=u===o._frustumType?o._frustum:void 0;return o._frustum=c.clone(n),o._frustumType=u,o._origin=a.clone(p,o._origin),o._orientation=s.clone(m,o._orientation),o._drawNearPlane=l,o};P.createGeometry=function(e){let t=e._frustumType,o=e._frustum,u=e._origin,c=e._orientation,p=e._drawNearPlane,m=new Float64Array(24);A._computeNearFarPlanes(u,c,t,o,m);let l=new F({position:new g({componentDatatype:T.DOUBLE,componentsPerAttribute:3,values:m})}),n,i,O=p?2:1,r=new Uint16Array(8*(O+1)),f=p?0:1;for(;f<2;++f)n=p?f*8:0,i=f*4,r[n]=i,r[n+1]=i+1,r[n+2]=i+1,r[n+3]=i+2,r[n+4]=i+2,r[n+5]=i+3,r[n+6]=i+3,r[n+7]=i;for(f=0;f<2;++f)n=(O+f)*8,i=f*4,r[n]=i,r[n+1]=i+4,r[n+2]=i+1,r[n+3]=i+5,r[n+4]=i+2,r[n+5]=i+6,r[n+6]=i+3,r[n+7]=i+7;return new N({attributes:l,indices:r,primitiveType:b.LINES,boundingSphere:y.fromVertices(m)})};var L=P;function S(e,t){return w(t)&&(e=L.unpack(e,t)),L.createGeometry(e)}var $=S;export{$ as default};
