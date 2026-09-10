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

import{a as c,c as x}from"./chunk-WORPNHJT.js";import{a as h}from"./chunk-SWCW4GSU.js";import{a as u}from"./chunk-PZM5FOOW.js";import{a as d}from"./chunk-3MNKUQ6L.js";import{f as n}from"./chunk-J4SK6SKL.js";var s=class e{constructor(i){this._ellipsoid=i??x.WGS84,this._semimajorAxis=this._ellipsoid.maximumRadius,this._oneOverSemimajorAxis=1/this._semimajorAxis}get ellipsoid(){return this._ellipsoid}static mercatorAngleToGeodeticLatitude(i){return u.PI_OVER_TWO-2*Math.atan(Math.exp(-i))}static geodeticLatitudeToMercatorAngle(i){i>e.MaximumLatitude?i=e.MaximumLatitude:i<-e.MaximumLatitude&&(i=-e.MaximumLatitude);let t=Math.sin(i);return .5*Math.log((1+t)/(1-t))}project(i,t){let o=this._semimajorAxis,r=i.longitude*o,m=e.geodeticLatitudeToMercatorAngle(i.latitude)*o,a=i.height;return n(t)?(t.x=r,t.y=m,t.z=a,t):new h(r,m,a)}unproject(i,t){if(!n(i))throw new d("cartesian is required");let o=this._oneOverSemimajorAxis,r=i.x*o,m=e.mercatorAngleToGeodeticLatitude(i.y*o),a=i.z;return n(t)?(t.longitude=r,t.latitude=m,t.height=a,t):new c(r,m,a)}};s.MaximumLatitude=s.mercatorAngleToGeodeticLatitude(Math.PI);var L=s;export{L as a};
