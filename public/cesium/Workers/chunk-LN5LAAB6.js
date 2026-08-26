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

import{h as O,i as R,j as G,k as L}from"./chunk-4JSGO3Z7.js";import{b as E}from"./chunk-V62DYOIH.js";import{a as u}from"./chunk-E6GK7MVP.js";import{a as N,b as s}from"./chunk-WV2SHQ7E.js";import{a as S,b as y,c as A}from"./chunk-TODZU3UG.js";import{a as I,b as w}from"./chunk-VIWNLE3Z.js";import{e as f}from"./chunk-4TAASUQ2.js";var U={NONE:0,TRIANGLES:1,LINES:2,POLYLINES:3},F=Object.freeze(U);var r={POINTS:u.POINTS,LINES:u.LINES,LINE_LOOP:u.LINE_LOOP,LINE_STRIP:u.LINE_STRIP,TRIANGLES:u.TRIANGLES,TRIANGLE_STRIP:u.TRIANGLE_STRIP,TRIANGLE_FAN:u.TRIANGLE_FAN};r.isLines=function(t){return t===r.LINES||t===r.LINE_LOOP||t===r.LINE_STRIP};r.isTriangles=function(t){return t===r.TRIANGLES||t===r.TRIANGLE_STRIP||t===r.TRIANGLE_FAN};r.validate=function(t){return t===r.POINTS||t===r.LINES||t===r.LINE_LOOP||t===r.LINE_STRIP||t===r.TRIANGLES||t===r.TRIANGLE_STRIP||t===r.TRIANGLE_FAN};var M=Object.freeze(r);function _(t){t=t??A.EMPTY_OBJECT,w.typeOf.object("options.attributes",t.attributes),this.attributes=t.attributes,this.indices=t.indices,this.primitiveType=t.primitiveType??M.TRIANGLES,this.boundingSphere=t.boundingSphere,this.geometryType=t.geometryType??F.NONE,this.boundingSphereCV=t.boundingSphereCV,this.offsetAttribute=t.offsetAttribute}_.computeNumberOfVertices=function(t){w.typeOf.object("geometry",t);let c=-1;for(let a in t.attributes)if(t.attributes.hasOwnProperty(a)&&f(t.attributes[a])&&f(t.attributes[a].values)){let o=t.attributes[a],e=o.values.length/o.componentsPerAttribute;if(c!==e&&c!==-1)throw new I("All attribute lists must have the same number of attributes.");c=e}return c};var W=new N,H=new S,g=new E,Z=[new N,new N,new N],K=[new s,new s,new s],$=[new s,new s,new s],tt=new S,et=new O,rt=new E,nt=new L;_._textureCoordinateRotationPoints=function(t,c,a,o){let e,V=G.center(o,W),D=N.toCartesian(V,a,H),Y=R.eastNorthUpToFixedFrame(D,a,g),C=E.inverse(Y,g),b=K,m=Z;m[0].longitude=o.west,m[0].latitude=o.south,m[1].longitude=o.west,m[1].latitude=o.north,m[2].longitude=o.east,m[2].latitude=o.south;let n=tt;for(e=0;e<3;e++)N.toCartesian(m[e],a,n),n=E.multiplyByPointAsVector(C,n,n),b[e].x=n.x,b[e].y=n.y;let z=O.fromAxisAngle(S.UNIT_Z,-c,et),B=y.fromQuaternion(z,rt),v=t.length,T=Number.POSITIVE_INFINITY,p=Number.POSITIVE_INFINITY,x=Number.NEGATIVE_INFINITY,d=Number.NEGATIVE_INFINITY;for(e=0;e<v;e++)n=E.multiplyByPointAsVector(C,t[e],n),n=y.multiplyByVector(B,n,n),T=Math.min(T,n.x),p=Math.min(p,n.y),x=Math.max(x,n.x),d=Math.max(d,n.y);let j=L.fromRotation(c,nt),i=$;i[0].x=T,i[0].y=p,i[1].x=T,i[1].y=d,i[2].x=x,i[2].y=p;let l=b[0],k=b[2].x-l.x,X=b[1].y-l.y;for(e=0;e<3;e++){let h=i[e];L.multiplyByVector(j,h,h),h.x=(h.x-l.x)/k,h.y=(h.y-l.y)/X}let q=i[0],J=i[1],Q=i[2],P=new Array(6);return s.pack(q,P),s.pack(J,P,2),s.pack(Q,P,4),P};var Lt=_;function ot(t){if(t=t??A.EMPTY_OBJECT,!f(t.componentDatatype))throw new I("options.componentDatatype is required.");if(!f(t.componentsPerAttribute))throw new I("options.componentsPerAttribute is required.");if(t.componentsPerAttribute<1||t.componentsPerAttribute>4)throw new I("options.componentsPerAttribute must be between 1 and 4.");if(!f(t.values))throw new I("options.values is required.");this.componentDatatype=t.componentDatatype,this.componentsPerAttribute=t.componentsPerAttribute,this.normalize=t.normalize??!1,this.values=t.values}var Ot=ot;export{F as a,M as b,Lt as c,Ot as d};
