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

import{h as O,i as R,j as G,k as L}from"./chunk-Y7Z6CVXH.js";import{b as E}from"./chunk-HHFPYI7Q.js";import{a as u}from"./chunk-LP5YXEIX.js";import{a as N,b as s}from"./chunk-WORPNHJT.js";import{a as S,b as y,c as A}from"./chunk-SWCW4GSU.js";import{a as I,b as w}from"./chunk-3MNKUQ6L.js";import{f}from"./chunk-J4SK6SKL.js";var F={NONE:0,TRIANGLES:1,LINES:2,POLYLINES:3};Object.freeze(F);var M=F;var e={POINTS:u.POINTS,LINES:u.LINES,LINE_LOOP:u.LINE_LOOP,LINE_STRIP:u.LINE_STRIP,TRIANGLES:u.TRIANGLES,TRIANGLE_STRIP:u.TRIANGLE_STRIP,TRIANGLE_FAN:u.TRIANGLE_FAN};e.isLines=function(t){return t===e.LINES||t===e.LINE_LOOP||t===e.LINE_STRIP};e.isTriangles=function(t){return t===e.TRIANGLES||t===e.TRIANGLE_STRIP||t===e.TRIANGLE_FAN};e.validate=function(t){return t===e.POINTS||t===e.LINES||t===e.LINE_LOOP||t===e.LINE_STRIP||t===e.TRIANGLES||t===e.TRIANGLE_STRIP||t===e.TRIANGLE_FAN};Object.freeze(e);var g=e;function _(t){t=t??A.EMPTY_OBJECT,w.typeOf.object("options.attributes",t.attributes),this.attributes=t.attributes,this.indices=t.indices,this.primitiveType=t.primitiveType??g.TRIANGLES,this.boundingSphere=t.boundingSphere,this.geometryType=t.geometryType??M.NONE,this.boundingSphereCV=t.boundingSphereCV,this.offsetAttribute=t.offsetAttribute}_.computeNumberOfVertices=function(t){w.typeOf.object("geometry",t);let c=-1;for(let a in t.attributes)if(t.attributes.hasOwnProperty(a)&&f(t.attributes[a])&&f(t.attributes[a].values)){let o=t.attributes[a],r=o.values.length/o.componentsPerAttribute;if(c!==r&&c!==-1)throw new I("All attribute lists must have the same number of attributes.");c=r}return c};var W=new N,H=new S,V=new E,Z=[new N,new N,new N],K=[new s,new s,new s],$=[new s,new s,new s],tt=new S,et=new O,rt=new E,nt=new L;_._textureCoordinateRotationPoints=function(t,c,a,o){let r,D=G.center(o,W),Y=N.toCartesian(D,a,H),z=R.eastNorthUpToFixedFrame(Y,a,V),C=E.inverse(z,V),b=K,m=Z;m[0].longitude=o.west,m[0].latitude=o.south,m[1].longitude=o.west,m[1].latitude=o.north,m[2].longitude=o.east,m[2].latitude=o.south;let n=tt;for(r=0;r<3;r++)N.toCartesian(m[r],a,n),n=E.multiplyByPointAsVector(C,n,n),b[r].x=n.x,b[r].y=n.y;let B=O.fromAxisAngle(S.UNIT_Z,-c,et),v=y.fromQuaternion(B,rt),j=t.length,T=Number.POSITIVE_INFINITY,p=Number.POSITIVE_INFINITY,x=Number.NEGATIVE_INFINITY,d=Number.NEGATIVE_INFINITY;for(r=0;r<j;r++)n=E.multiplyByPointAsVector(C,t[r],n),n=y.multiplyByVector(v,n,n),T=Math.min(T,n.x),p=Math.min(p,n.y),x=Math.max(x,n.x),d=Math.max(d,n.y);let k=L.fromRotation(c,nt),i=$;i[0].x=T,i[0].y=p,i[1].x=T,i[1].y=d,i[2].x=x,i[2].y=p;let l=b[0],X=b[2].x-l.x,q=b[1].y-l.y;for(r=0;r<3;r++){let h=i[r];L.multiplyByVector(k,h,h),h.x=(h.x-l.x)/X,h.y=(h.y-l.y)/q}let J=i[0],Q=i[1],U=i[2],P=new Array(6);return s.pack(J,P),s.pack(Q,P,2),s.pack(U,P,4),P};var Lt=_;function ot(t){if(t=t??A.EMPTY_OBJECT,!f(t.componentDatatype))throw new I("options.componentDatatype is required.");if(!f(t.componentsPerAttribute))throw new I("options.componentsPerAttribute is required.");if(t.componentsPerAttribute<1||t.componentsPerAttribute>4)throw new I("options.componentsPerAttribute must be between 1 and 4.");if(!f(t.values))throw new I("options.values is required.");this.componentDatatype=t.componentDatatype,this.componentsPerAttribute=t.componentsPerAttribute,this.normalize=t.normalize??!1,this.values=t.values}var Ot=ot;export{M as a,g as b,Lt as c,Ot as d};
