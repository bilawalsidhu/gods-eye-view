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

import{a as y,b as P,d as k}from"./chunk-S4VBGY2U.js";import{a as L}from"./chunk-UCTPWOTZ.js";import{a as B}from"./chunk-N3A5CZ2S.js";import{b as q}from"./chunk-G75U3WZT.js";import{e as T}from"./chunk-3THTQ4QB.js";function Y(n){let a=n._uSquared,t=n._ellipsoid.maximumRadius,e=n._ellipsoid.minimumRadius,f=(t-e)/t,m=Math.cos(n._startHeading),_=Math.sin(n._startHeading),r=(1-f)*Math.tan(n._start.latitude),p=1/Math.sqrt(1+r*r),R=p*r,M=Math.atan2(r,m),l=p*_,U=l*l,i=1-U,A=Math.sqrt(i),c=a/4,o=c*c,h=o*c,S=o*o,u=1+c-3*o/4+5*h/4-175*S/64,C=1-c+15*o/8-35*h/8,d=1-3*c+35*o/4,g=1-5*c,w=u*M-C*Math.sin(2*M)*c/2-d*Math.sin(4*M)*o/16-g*Math.sin(6*M)*h/48-Math.sin(8*M)*5*S/512,s=n._constants;s.a=t,s.b=e,s.f=f,s.cosineHeading=m,s.sineHeading=_,s.tanU=r,s.cosineU=p,s.sineU=R,s.sigma=M,s.sineAlpha=l,s.sineSquaredAlpha=U,s.cosineSquaredAlpha=i,s.cosineAlpha=A,s.u2Over4=c,s.u4Over16=o,s.u6Over64=h,s.u8Over256=S,s.a0=u,s.a1=C,s.a2=d,s.a3=g,s.distanceRatio=w}function Z(n,a){return n*a*(4+n*(4-3*a))/16}function N(n,a,t,e,f,m,_){let r=Z(n,t);return(1-r)*n*a*(e+r*f*(_+r*m*(2*_*_-1)))}function $(n,a,t,e,f,m,_){let r=(a-t)/a,p=m-e,R=Math.atan((1-r)*Math.tan(f)),M=Math.atan((1-r)*Math.tan(_)),l=Math.cos(R),U=Math.sin(R),i=Math.cos(M),A=Math.sin(M),c=l*i,o=l*A,h=U*A,S=U*i,u=p,C=L.TWO_PI,d=Math.cos(u),g=Math.sin(u),w,s,O,H,b;do{d=Math.cos(u),g=Math.sin(u);let z=o-S*d;O=Math.sqrt(i*i*g*g+z*z),s=h+c*d,w=Math.atan2(O,s);let D;O===0?(D=0,H=1):(D=c*g/O,H=1-D*D),C=u,b=s-2*h/H,isFinite(b)||(b=0),u=p+N(r,D,H,w,O,s,b)}while(Math.abs(u-C)>L.EPSILON12);let v=H*(a*a-t*t)/(t*t),W=1+v*(4096+v*(v*(320-175*v)-768))/16384,I=v*(256+v*(v*(74-47*v)-128))/1024,F=b*b,J=I*O*(b+I*(s*(2*F-1)-I*b*(4*O*O-3)*(4*F-3)/6)/4),K=t*W*(w-J),Q=Math.atan2(i*g,o-S*d),X=Math.atan2(l*g,o*d-S);n._distance=K,n._startHeading=Q,n._endHeading=X,n._uSquared=v}var j=new y,x=new y;function V(n,a,t,e){let f=y.normalize(e.cartographicToCartesian(a,x),j),m=y.normalize(e.cartographicToCartesian(t,x),x);q.typeOf.number.greaterThanOrEquals("value",Math.abs(Math.abs(y.angleBetween(f,m))-Math.PI),.0125),$(n,e.maximumRadius,e.minimumRadius,a.longitude,a.latitude,t.longitude,t.latitude),n._start=P.clone(a,n._start),n._end=P.clone(t,n._end),n._start.height=0,n._end.height=0,Y(n)}function E(n,a,t){let e=B(t,k.default);this._ellipsoid=e,this._start=new P,this._end=new P,this._constants={},this._startHeading=void 0,this._endHeading=void 0,this._distance=void 0,this._uSquared=void 0,T(n)&&T(a)&&V(this,n,a,e)}Object.defineProperties(E.prototype,{ellipsoid:{get:function(){return this._ellipsoid}},surfaceDistance:{get:function(){return q.defined("distance",this._distance),this._distance}},start:{get:function(){return this._start}},end:{get:function(){return this._end}},startHeading:{get:function(){return q.defined("distance",this._distance),this._startHeading}},endHeading:{get:function(){return q.defined("distance",this._distance),this._endHeading}}});E.prototype.setEndPoints=function(n,a){q.defined("start",n),q.defined("end",a),V(this,n,a,this._ellipsoid)};E.prototype.interpolateUsingFraction=function(n,a){return this.interpolateUsingSurfaceDistance(this._distance*n,a)};E.prototype.interpolateUsingSurfaceDistance=function(n,a){q.defined("distance",this._distance);let t=this._constants,e=t.distanceRatio+n/t.b,f=Math.cos(2*e),m=Math.cos(4*e),_=Math.cos(6*e),r=Math.sin(2*e),p=Math.sin(4*e),R=Math.sin(6*e),M=Math.sin(8*e),l=e*e,U=e*l,i=t.u8Over256,A=t.u2Over4,c=t.u6Over64,o=t.u4Over16,h=2*U*i*f/3+e*(1-A+7*o/4-15*c/4+579*i/64-(o-15*c/4+187*i/16)*f-(5*c/4-115*i/16)*m-29*i*_/16)+(A/2-o+71*c/32-85*i/16)*r+(5*o/16-5*c/4+383*i/96)*p-l*((c-11*i/2)*r+5*i*p/2)+(29*c/96-29*i/16)*R+539*i*M/1536,S=Math.asin(Math.sin(h)*t.cosineAlpha),u=Math.atan(t.a/t.b*Math.tan(S));h=h-t.sigma;let C=Math.cos(2*t.sigma+h),d=Math.sin(h),g=Math.cos(h),w=t.cosineU*g,s=t.sineU*d,H=Math.atan2(d*t.sineHeading,w-s*t.cosineHeading)-N(t.f,t.sineAlpha,t.cosineSquaredAlpha,h,d,g,C);return T(a)?(a.longitude=this._start.longitude+H,a.latitude=u,a.height=0,a):new P(this._start.longitude+H,u,0)};var ct=E;export{ct as a};
