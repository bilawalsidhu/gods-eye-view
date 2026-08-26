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

import{a as P}from"./chunk-D5QCMU6T.js";import{a as u,b as d}from"./chunk-JKEOJFWC.js";import{a as j}from"./chunk-FWQONNTL.js";import{i as A}from"./chunk-4JSGO3Z7.js";import{a as _,b as h}from"./chunk-V62DYOIH.js";import{b as l,c as g}from"./chunk-WV2SHQ7E.js";import{a as e}from"./chunk-TODZU3UG.js";import{a as y,b as p}from"./chunk-VIWNLE3Z.js";import{e as r}from"./chunk-4TAASUQ2.js";var x=new _;function s(n,t){if(p.defined("origin",n),t=t??g.default,n=t.scaleToGeodeticSurface(n),!r(n))throw new y("origin must not be at the center of the ellipsoid.");let o=A.eastNorthUpToFixedFrame(n,t);this._ellipsoid=t,this._origin=n,this._xAxis=e.fromCartesian4(h.getColumn(o,0,x)),this._yAxis=e.fromCartesian4(h.getColumn(o,1,x));let i=e.fromCartesian4(h.getColumn(o,2,x));this._plane=j.fromPointNormal(n,i)}Object.defineProperties(s.prototype,{ellipsoid:{get:function(){return this._ellipsoid}},origin:{get:function(){return this._origin}},plane:{get:function(){return this._plane}},xAxis:{get:function(){return this._xAxis}},yAxis:{get:function(){return this._yAxis}},zAxis:{get:function(){return this._plane.normal}}});var w=new P;s.fromPoints=function(n,t){p.defined("cartesians",n);let o=P.fromPoints(n,w);return new s(o.center,t)};var O=new u,m=new e;s.prototype.projectPointOntoPlane=function(n,t){p.defined("cartesian",n);let o=O;o.origin=n,e.normalize(n,o.direction);let i=d.rayPlane(o,this._plane,m);if(r(i)||(e.negate(o.direction,o.direction),i=d.rayPlane(o,this._plane,m)),r(i)){let c=e.subtract(i,this._origin,i),a=e.dot(this._xAxis,c),f=e.dot(this._yAxis,c);return r(t)?(t.x=a,t.y=f,t):new l(a,f)}};s.prototype.projectPointsOntoPlane=function(n,t){p.defined("cartesians",n),r(t)||(t=[]);let o=0,i=n.length;for(let c=0;c<i;c++){let a=this.projectPointOntoPlane(n[c],t[o]);r(a)&&(t[o]=a,o++)}return t.length=o,t};s.prototype.projectPointToNearestOnPlane=function(n,t){p.defined("cartesian",n),r(t)||(t=new l);let o=O;o.origin=n,e.clone(this._plane.normal,o.direction);let i=d.rayPlane(o,this._plane,m);r(i)||(e.negate(o.direction,o.direction),i=d.rayPlane(o,this._plane,m));let c=e.subtract(i,this._origin,i),a=e.dot(this._xAxis,c),f=e.dot(this._yAxis,c);return t.x=a,t.y=f,t};s.prototype.projectPointsToNearestOnPlane=function(n,t){p.defined("cartesians",n),r(t)||(t=[]);let o=n.length;t.length=o;for(let i=0;i<o;i++)t[i]=this.projectPointToNearestOnPlane(n[i],t[i]);return t};var C=new e;s.prototype.projectPointOntoEllipsoid=function(n,t){p.defined("cartesian",n),r(t)||(t=new e);let o=this._ellipsoid,i=this._origin,c=this._xAxis,a=this._yAxis,f=C;return e.multiplyByScalar(c,n.x,f),t=e.add(i,f,t),e.multiplyByScalar(a,n.y,f),e.add(t,f,t),o.scaleToGeocentricSurface(t,t),t};s.prototype.projectPointsOntoEllipsoid=function(n,t){p.defined("cartesians",n);let o=n.length;r(t)?t.length=o:t=new Array(o);for(let i=0;i<o;++i)t[i]=this.projectPointOntoEllipsoid(n[i],t[i]);return t};var D=s;export{D as a};
