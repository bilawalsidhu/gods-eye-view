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

import{b as l,f as O,g as R,h as G,i as L}from"./chunk-M3A6SPGI.js";import{a as A,b as h,c as a,e as y}from"./chunk-S4VBGY2U.js";import{a as c}from"./chunk-54PMPXZ4.js";import{a as s}from"./chunk-N3A5CZ2S.js";import{a as N,b as w}from"./chunk-G75U3WZT.js";import{e as I}from"./chunk-3THTQ4QB.js";var U={NONE:0,TRIANGLES:1,LINES:2,POLYLINES:3},M=Object.freeze(U);var r={POINTS:c.POINTS,LINES:c.LINES,LINE_LOOP:c.LINE_LOOP,LINE_STRIP:c.LINE_STRIP,TRIANGLES:c.TRIANGLES,TRIANGLE_STRIP:c.TRIANGLE_STRIP,TRIANGLE_FAN:c.TRIANGLE_FAN};r.isLines=function(t){return t===r.LINES||t===r.LINE_LOOP||t===r.LINE_STRIP};r.isTriangles=function(t){return t===r.TRIANGLES||t===r.TRIANGLE_STRIP||t===r.TRIANGLE_FAN};r.validate=function(t){return t===r.POINTS||t===r.LINES||t===r.LINE_LOOP||t===r.LINE_STRIP||t===r.TRIANGLES||t===r.TRIANGLE_STRIP||t===r.TRIANGLE_FAN};var F=Object.freeze(r);function _(t){t=s(t,s.EMPTY_OBJECT),w.typeOf.object("options.attributes",t.attributes),this.attributes=t.attributes,this.indices=t.indices,this.primitiveType=s(t.primitiveType,F.TRIANGLES),this.boundingSphere=t.boundingSphere,this.geometryType=s(t.geometryType,M.NONE),this.boundingSphereCV=t.boundingSphereCV,this.offsetAttribute=t.offsetAttribute}_.computeNumberOfVertices=function(t){w.typeOf.object("geometry",t);let m=-1;for(let u in t.attributes)if(t.attributes.hasOwnProperty(u)&&I(t.attributes[u])&&I(t.attributes[u].values)){let o=t.attributes[u],e=o.values.length/o.componentsPerAttribute;if(m!==e&&m!==-1)throw new N("All attribute lists must have the same number of attributes.");m=e}return m};var W=new h,H=new A,V=new l,Z=[new h,new h,new h],K=[new a,new a,new a],$=[new a,new a,new a],tt=new A,et=new O,rt=new l,nt=new L;_._textureCoordinateRotationPoints=function(t,m,u,o){let e,g=G.center(o,W),D=h.toCartesian(g,u,H),Y=R.eastNorthUpToFixedFrame(D,u,V),C=l.inverse(Y,V),b=K,f=Z;f[0].longitude=o.west,f[0].latitude=o.south,f[1].longitude=o.west,f[1].latitude=o.north,f[2].longitude=o.east,f[2].latitude=o.south;let n=tt;for(e=0;e<3;e++)h.toCartesian(f[e],u,n),n=l.multiplyByPointAsVector(C,n,n),b[e].x=n.x,b[e].y=n.y;let B=O.fromAxisAngle(A.UNIT_Z,-m,et),v=y.fromQuaternion(B,rt),j=t.length,T=Number.POSITIVE_INFINITY,p=Number.POSITIVE_INFINITY,d=Number.NEGATIVE_INFINITY,x=Number.NEGATIVE_INFINITY;for(e=0;e<j;e++)n=l.multiplyByPointAsVector(C,t[e],n),n=y.multiplyByVector(v,n,n),T=Math.min(T,n.x),p=Math.min(p,n.y),d=Math.max(d,n.x),x=Math.max(x,n.y);let k=L.fromRotation(m,nt),i=$;i[0].x=T,i[0].y=p,i[1].x=T,i[1].y=x,i[2].x=d,i[2].y=p;let P=b[0],z=b[2].x-P.x,X=b[1].y-P.y;for(e=0;e<3;e++){let E=i[e];L.multiplyByVector(k,E,E),E.x=(E.x-P.x)/z,E.y=(E.y-P.y)/X}let q=i[0],J=i[1],Q=i[2],S=new Array(6);return a.pack(q,S),a.pack(J,S,2),a.pack(Q,S,4),S};var Lt=_;function ot(t){if(t=s(t,s.EMPTY_OBJECT),!I(t.componentDatatype))throw new N("options.componentDatatype is required.");if(!I(t.componentsPerAttribute))throw new N("options.componentsPerAttribute is required.");if(t.componentsPerAttribute<1||t.componentsPerAttribute>4)throw new N("options.componentsPerAttribute must be between 1 and 4.");if(!I(t.values))throw new N("options.values is required.");this.componentDatatype=t.componentDatatype,this.componentsPerAttribute=t.componentsPerAttribute,this.normalize=s(t.normalize,!1),this.values=t.values}var Ot=ot;export{M as a,F as b,Lt as c,Ot as d};
