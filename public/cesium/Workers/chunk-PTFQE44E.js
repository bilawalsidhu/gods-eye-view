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

import{a as D,c as B}from"./chunk-WORPNHJT.js";import{a as y}from"./chunk-SWCW4GSU.js";import{a as z}from"./chunk-PZM5FOOW.js";import{b as q}from"./chunk-3MNKUQ6L.js";import{f as L}from"./chunk-J4SK6SKL.js";function X(n){let a=n._uSquared,t=n._ellipsoid.maximumRadius,e=n._ellipsoid.minimumRadius,g=(t-e)/t,m=Math.cos(n._startHeading),_=Math.sin(n._startHeading),r=(1-g)*Math.tan(n._start.latitude),p=1/Math.sqrt(1+r*r),R=p*r,f=Math.atan2(r,m),l=p*_,U=l*l,i=1-U,A=Math.sqrt(i),c=a/4,o=c*c,h=o*c,S=o*o,M=1+c-3*o/4+5*h/4-175*S/64,C=1-c+15*o/8-35*h/8,u=1-3*c+35*o/4,d=1-5*c,w=M*f-C*Math.sin(2*f)*c/2-u*Math.sin(4*f)*o/16-d*Math.sin(6*f)*h/48-Math.sin(8*f)*5*S/512,s=n._constants;s.a=t,s.b=e,s.f=g,s.cosineHeading=m,s.sineHeading=_,s.tanU=r,s.cosineU=p,s.sineU=R,s.sigma=f,s.sineAlpha=l,s.sineSquaredAlpha=U,s.cosineSquaredAlpha=i,s.cosineAlpha=A,s.u2Over4=c,s.u4Over16=o,s.u6Over64=h,s.u8Over256=S,s.a0=M,s.a1=C,s.a2=u,s.a3=d,s.distanceRatio=w}function Y(n,a){return n*a*(4+n*(4-3*a))/16}function k(n,a,t,e,g,m,_){let r=Y(n,t);return(1-r)*n*a*(e+r*g*(_+r*m*(2*_*_-1)))}function Z(n,a,t,e,g,m,_){let r=(a-t)/a,p=m-e,R=Math.atan((1-r)*Math.tan(g)),f=Math.atan((1-r)*Math.tan(_)),l=Math.cos(R),U=Math.sin(R),i=Math.cos(f),A=Math.sin(f),c=l*i,o=l*A,h=U*A,S=U*i,M=p,C,u,d,w,s,O,H,b;do{u=Math.cos(M),d=Math.sin(M);let I=o-S*u;O=Math.sqrt(i*i*d*d+I*I),s=h+c*u,w=Math.atan2(O,s);let E;O===0?(E=0,H=1):(E=c*d/O,H=1-E*E),C=M,b=s-2*h/H,isFinite(b)||(b=0),M=p+k(r,E,H,w,O,s,b)}while(Math.abs(M-C)>z.EPSILON12);let v=H*(a*a-t*t)/(t*t),J=1+v*(4096+v*(v*(320-175*v)-768))/16384,T=v*(256+v*(v*(74-47*v)-128))/1024,F=b*b,K=T*O*(b+T*(s*(2*F-1)-T*b*(4*O*O-3)*(4*F-3)/6)/4),Q=t*J*(w-K),V=Math.atan2(i*d,o-S*u),W=Math.atan2(l*d,o*u-S);n._distance=Q,n._startHeading=V,n._endHeading=W,n._uSquared=v}var $=new y,x=new y;function N(n,a,t,e){let g=y.normalize(e.cartographicToCartesian(a,x),$),m=y.normalize(e.cartographicToCartesian(t,x),x);q.typeOf.number.greaterThanOrEquals("value",Math.abs(Math.abs(y.angleBetween(g,m))-Math.PI),.0125),Z(n,e.maximumRadius,e.minimumRadius,a.longitude,a.latitude,t.longitude,t.latitude),n._start=D.clone(a,n._start),n._end=D.clone(t,n._end),n._start.height=0,n._end.height=0,X(n)}function P(n,a,t){let e=t??B.default;this._ellipsoid=e,this._start=new D,this._end=new D,this._constants={},this._startHeading=void 0,this._endHeading=void 0,this._distance=void 0,this._uSquared=void 0,L(n)&&L(a)&&N(this,n,a,e)}Object.defineProperties(P.prototype,{ellipsoid:{get:function(){return this._ellipsoid}},surfaceDistance:{get:function(){return q.defined("distance",this._distance),this._distance}},start:{get:function(){return this._start}},end:{get:function(){return this._end}},startHeading:{get:function(){return q.defined("distance",this._distance),this._startHeading}},endHeading:{get:function(){return q.defined("distance",this._distance),this._endHeading}}});P.prototype.setEndPoints=function(n,a){q.defined("start",n),q.defined("end",a),N(this,n,a,this._ellipsoid)};P.prototype.interpolateUsingFraction=function(n,a){return this.interpolateUsingSurfaceDistance(this._distance*n,a)};P.prototype.interpolateUsingSurfaceDistance=function(n,a){q.defined("distance",this._distance);let t=this._constants,e=t.distanceRatio+n/t.b,g=Math.cos(2*e),m=Math.cos(4*e),_=Math.cos(6*e),r=Math.sin(2*e),p=Math.sin(4*e),R=Math.sin(6*e),f=Math.sin(8*e),l=e*e,U=e*l,i=t.u8Over256,A=t.u2Over4,c=t.u6Over64,o=t.u4Over16,h=2*U*i*g/3+e*(1-A+7*o/4-15*c/4+579*i/64-(o-15*c/4+187*i/16)*g-(5*c/4-115*i/16)*m-29*i*_/16)+(A/2-o+71*c/32-85*i/16)*r+(5*o/16-5*c/4+383*i/96)*p-l*((c-11*i/2)*r+5*i*p/2)+(29*c/96-29*i/16)*R+539*i*f/1536,S=Math.asin(Math.sin(h)*t.cosineAlpha),M=Math.atan(t.a/t.b*Math.tan(S));h=h-t.sigma;let C=Math.cos(2*t.sigma+h),u=Math.sin(h),d=Math.cos(h),w=t.cosineU*d,s=t.sineU*u,H=Math.atan2(u*t.sineHeading,w-s*t.cosineHeading)-k(t.f,t.sineAlpha,t.cosineSquaredAlpha,h,u,d,C);return L(a)?(a.longitude=this._start.longitude+H,a.latitude=M,a.height=0,a):new D(this._start.longitude+H,M,0)};var et=P;export{et as a};
