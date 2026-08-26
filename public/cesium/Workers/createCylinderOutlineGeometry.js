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

import{a as M}from"./chunk-7ZLWTKSF.js";import{a as L}from"./chunk-H7AFCEEW.js";import{a as N}from"./chunk-Z7UZ2XGJ.js";import{a as k}from"./chunk-UA3N5FHD.js";import{b as D,c as P,d as A}from"./chunk-LN5LAAB6.js";import{c as y}from"./chunk-OXROQHTA.js";import"./chunk-GQG3G4OP.js";import"./chunk-4JSGO3Z7.js";import"./chunk-V62DYOIH.js";import{a as R}from"./chunk-54IT5KT4.js";import"./chunk-E6GK7MVP.js";import"./chunk-YQTAAITT.js";import{b as _}from"./chunk-WV2SHQ7E.js";import{a as T,c as S}from"./chunk-TODZU3UG.js";import"./chunk-3XRQCEHV.js";import{a as E,b as m}from"./chunk-VIWNLE3Z.js";import{e as b}from"./chunk-4TAASUQ2.js";var V=new _;function d(t){t=t??S.EMPTY_OBJECT;let e=t.length,i=t.topRadius,f=t.bottomRadius,o=t.slices??128,u=Math.max(t.numberOfVerticalLines??16,0);if(m.typeOf.number("options.positions",e),m.typeOf.number("options.topRadius",i),m.typeOf.number("options.bottomRadius",f),m.typeOf.number.greaterThanOrEquals("options.slices",o,3),b(t.offsetAttribute)&&t.offsetAttribute===L.TOP)throw new E("GeometryOffsetAttribute.TOP is not a supported options.offsetAttribute for this geometry.");this._length=e,this._topRadius=i,this._bottomRadius=f,this._slices=o,this._numberOfVerticalLines=u,this._offsetAttribute=t.offsetAttribute,this._workerName="createCylinderOutlineGeometry"}d.packedLength=6;d.pack=function(t,e,i){return m.typeOf.object("value",t),m.defined("array",e),i=i??0,e[i++]=t._length,e[i++]=t._topRadius,e[i++]=t._bottomRadius,e[i++]=t._slices,e[i++]=t._numberOfVerticalLines,e[i]=t._offsetAttribute??-1,e};var p={length:void 0,topRadius:void 0,bottomRadius:void 0,slices:void 0,numberOfVerticalLines:void 0,offsetAttribute:void 0};d.unpack=function(t,e,i){m.defined("array",t),e=e??0;let f=t[e++],o=t[e++],u=t[e++],l=t[e++],a=t[e++],c=t[e];return b(i)?(i._length=f,i._topRadius=o,i._bottomRadius=u,i._slices=l,i._numberOfVerticalLines=a,i._offsetAttribute=c===-1?void 0:c,i):(p.length=f,p.topRadius=o,p.bottomRadius=u,p.slices=l,p.numberOfVerticalLines=a,p.offsetAttribute=c===-1?void 0:c,new d(p))};d.createGeometry=function(t){let e=t._length,i=t._topRadius,f=t._bottomRadius,o=t._slices,u=t._numberOfVerticalLines;if(e<=0||i<0||f<0||i===0&&f===0)return;let l=o*2,a=M.computePositions(e,i,f,o,!1),c=o*2,C;if(u>0){let h=Math.min(u,o);C=Math.round(o/h),c+=h}let s=N.createTypedArray(l,c*2),r=0,n;for(n=0;n<o-1;n++)s[r++]=n,s[r++]=n+1,s[r++]=n+o,s[r++]=n+1+o;if(s[r++]=o-1,s[r++]=0,s[r++]=o+o-1,s[r++]=o,u>0)for(n=0;n<o;n+=C)s[r++]=n,s[r++]=n+o;let O=new k;O.position=new A({componentDatatype:R.DOUBLE,componentsPerAttribute:3,values:a}),V.x=e*.5,V.y=Math.max(f,i);let g=new y(T.ZERO,_.magnitude(V));if(b(t._offsetAttribute)){e=a.length;let h=t._offsetAttribute===L.NONE?0:1,B=new Uint8Array(e/3).fill(h);O.applyOffset=new A({componentDatatype:R.UNSIGNED_BYTE,componentsPerAttribute:1,values:B})}return new P({attributes:O,indices:s,primitiveType:D.LINES,boundingSphere:g,offsetAttribute:t._offsetAttribute})};var w=d;function G(t,e){return b(e)&&(t=w.unpack(t,e)),w.createGeometry(t)}var et=G;export{et as default};
