/**
 * @license
 * Cesium - https://github.com/CesiumGS/cesium
 * Version 1.144.0
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

import{a as m}from"./chunk-ER474XE6.js";import{a as b}from"./chunk-WF6KNLYB.js";import{b as v,c as x,d as c}from"./chunk-VGKISNF5.js";import{c as l}from"./chunk-VPJRLZMB.js";import"./chunk-635BMVFD.js";import"./chunk-Y7Z6CVXH.js";import"./chunk-HHFPYI7Q.js";import{a as i}from"./chunk-SSZI3JCE.js";import"./chunk-LP5YXEIX.js";import"./chunk-AMKKUAL3.js";import"./chunk-WORPNHJT.js";import{a as u,c as A}from"./chunk-SWCW4GSU.js";import"./chunk-PZM5FOOW.js";import{b as f}from"./chunk-3MNKUQ6L.js";import{f as s}from"./chunk-J4SK6SKL.js";function p(r){r=r??A.EMPTY_OBJECT;let e=r.vertexFormat??m.DEFAULT;this._vertexFormat=e,this._workerName="createPlaneGeometry"}p.packedLength=m.packedLength;p.pack=function(r,e,o){return f.typeOf.object("value",r),f.defined("array",e),o=o??0,m.pack(r._vertexFormat,e,o),e};var d=new m,P={vertexFormat:d};p.unpack=function(r,e,o){f.defined("array",r),e=e??0;let a=m.unpack(r,e,d);return s(o)?(o._vertexFormat=m.clone(a,o._vertexFormat),o):new p(P)};var y=new u(-.5,-.5,0),F=new u(.5,.5,0);p.createGeometry=function(r){let e=r._vertexFormat,o=new b,a,n;if(e.position){if(n=new Float64Array(12),n[0]=y.x,n[1]=y.y,n[2]=0,n[3]=F.x,n[4]=y.y,n[5]=0,n[6]=F.x,n[7]=F.y,n[8]=0,n[9]=y.x,n[10]=F.y,n[11]=0,o.position=new c({componentDatatype:i.DOUBLE,componentsPerAttribute:3,values:n}),e.normal){let t=new Float32Array(12);t[0]=0,t[1]=0,t[2]=1,t[3]=0,t[4]=0,t[5]=1,t[6]=0,t[7]=0,t[8]=1,t[9]=0,t[10]=0,t[11]=1,o.normal=new c({componentDatatype:i.FLOAT,componentsPerAttribute:3,values:t})}if(e.st){let t=new Float32Array(8);t[0]=0,t[1]=0,t[2]=1,t[3]=0,t[4]=1,t[5]=1,t[6]=0,t[7]=1,o.st=new c({componentDatatype:i.FLOAT,componentsPerAttribute:2,values:t})}if(e.tangent){let t=new Float32Array(12);t[0]=1,t[1]=0,t[2]=0,t[3]=1,t[4]=0,t[5]=0,t[6]=1,t[7]=0,t[8]=0,t[9]=1,t[10]=0,t[11]=0,o.tangent=new c({componentDatatype:i.FLOAT,componentsPerAttribute:3,values:t})}if(e.bitangent){let t=new Float32Array(12);t[0]=0,t[1]=1,t[2]=0,t[3]=0,t[4]=1,t[5]=0,t[6]=0,t[7]=1,t[8]=0,t[9]=0,t[10]=1,t[11]=0,o.bitangent=new c({componentDatatype:i.FLOAT,componentsPerAttribute:3,values:t})}a=new Uint16Array(6),a[0]=0,a[1]=1,a[2]=2,a[3]=0,a[4]=2,a[5]=3}return new x({attributes:o,indices:a,primitiveType:v.TRIANGLES,boundingSphere:new l(u.ZERO,Math.sqrt(2))})};var w=p;function h(r,e){return s(e)&&(r=w.unpack(r,e)),w.createGeometry(r)}var N=h;export{N as default};
