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

import{a as M}from"./chunk-OTRIIEF3.js";import{a as V}from"./chunk-5CC3QRYS.js";import{a as N}from"./chunk-34ULWVZF.js";import{a as k}from"./chunk-24JYWT5N.js";import{b as D,c as P,d as L}from"./chunk-LH3SUUXG.js";import{d as y}from"./chunk-K2M3OJ7Z.js";import"./chunk-M3A6SPGI.js";import{a as A}from"./chunk-D5HNP2LB.js";import{a as S,c as R}from"./chunk-S4VBGY2U.js";import"./chunk-UCTPWOTZ.js";import"./chunk-54PMPXZ4.js";import"./chunk-R62IKKEC.js";import{a as c}from"./chunk-N3A5CZ2S.js";import{a as T,b as m}from"./chunk-G75U3WZT.js";import{e as d}from"./chunk-3THTQ4QB.js";var w=new R;function a(t){t=c(t,c.EMPTY_OBJECT);let e=t.length,i=t.topRadius,f=t.bottomRadius,o=c(t.slices,128),r=Math.max(c(t.numberOfVerticalLines,16),0);if(m.typeOf.number("options.positions",e),m.typeOf.number("options.topRadius",i),m.typeOf.number("options.bottomRadius",f),m.typeOf.number.greaterThanOrEquals("options.slices",o,3),d(t.offsetAttribute)&&t.offsetAttribute===V.TOP)throw new T("GeometryOffsetAttribute.TOP is not a supported options.offsetAttribute for this geometry.");this._length=e,this._topRadius=i,this._bottomRadius=f,this._slices=o,this._numberOfVerticalLines=r,this._offsetAttribute=t.offsetAttribute,this._workerName="createCylinderOutlineGeometry"}a.packedLength=6;a.pack=function(t,e,i){return m.typeOf.object("value",t),m.defined("array",e),i=c(i,0),e[i++]=t._length,e[i++]=t._topRadius,e[i++]=t._bottomRadius,e[i++]=t._slices,e[i++]=t._numberOfVerticalLines,e[i]=c(t._offsetAttribute,-1),e};var b={length:void 0,topRadius:void 0,bottomRadius:void 0,slices:void 0,numberOfVerticalLines:void 0,offsetAttribute:void 0};a.unpack=function(t,e,i){m.defined("array",t),e=c(e,0);let f=t[e++],o=t[e++],r=t[e++],h=t[e++],l=t[e++],p=t[e];return d(i)?(i._length=f,i._topRadius=o,i._bottomRadius=r,i._slices=h,i._numberOfVerticalLines=l,i._offsetAttribute=p===-1?void 0:p,i):(b.length=f,b.topRadius=o,b.bottomRadius=r,b.slices=h,b.numberOfVerticalLines=l,b.offsetAttribute=p===-1?void 0:p,new a(b))};a.createGeometry=function(t){let e=t._length,i=t._topRadius,f=t._bottomRadius,o=t._slices,r=t._numberOfVerticalLines;if(e<=0||i<0||f<0||i===0&&f===0)return;let h=o*2,l=M.computePositions(e,i,f,o,!1),p=o*2,E;if(r>0){let O=Math.min(r,o);E=Math.round(o/O),p+=O}let s=N.createTypedArray(h,p*2),u=0,n;for(n=0;n<o-1;n++)s[u++]=n,s[u++]=n+1,s[u++]=n+o,s[u++]=n+1+o;if(s[u++]=o-1,s[u++]=0,s[u++]=o+o-1,s[u++]=o,r>0)for(n=0;n<o;n+=E)s[u++]=n,s[u++]=n+o;let _=new k;_.position=new L({componentDatatype:A.DOUBLE,componentsPerAttribute:3,values:l}),w.x=e*.5,w.y=Math.max(f,i);let g=new y(S.ZERO,R.magnitude(w));if(d(t._offsetAttribute)){e=l.length;let O=t._offsetAttribute===V.NONE?0:1,B=new Uint8Array(e/3).fill(O);_.applyOffset=new L({componentDatatype:A.UNSIGNED_BYTE,componentsPerAttribute:1,values:B})}return new P({attributes:_,indices:s,primitiveType:D.LINES,boundingSphere:g,offsetAttribute:t._offsetAttribute})};var C=a;function G(t,e){return d(e)&&(t=C.unpack(t,e)),C.createGeometry(t)}var et=G;export{et as default};
