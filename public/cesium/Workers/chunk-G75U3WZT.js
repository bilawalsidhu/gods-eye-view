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

import{e as u}from"./chunk-3THTQ4QB.js";function f(t){this.name="DeveloperError",this.message=t;let e;try{throw new Error}catch(o){e=o.stack}this.stack=e}u(Object.create)&&(f.prototype=Object.create(Error.prototype),f.prototype.constructor=f);f.prototype.toString=function(){let t=`${this.name}: ${this.message}`;return u(this.stack)&&(t+=`
${this.stack.toString()}`),t};f.throwInstantiationError=function(){throw new f("This function defines an interface and should not be called directly.")};var r=f;var n={};n.typeOf={};function c(t){return`${t} is required, actual value was undefined`}function a(t,e,o){return`Expected ${o} to be typeof ${e}, actual typeof was ${t}`}n.defined=function(t,e){if(!u(e))throw new r(c(t))};n.typeOf.func=function(t,e){if(typeof e!="function")throw new r(a(typeof e,"function",t))};n.typeOf.string=function(t,e){if(typeof e!="string")throw new r(a(typeof e,"string",t))};n.typeOf.number=function(t,e){if(typeof e!="number")throw new r(a(typeof e,"number",t))};n.typeOf.number.lessThan=function(t,e,o){if(n.typeOf.number(t,e),e>=o)throw new r(`Expected ${t} to be less than ${o}, actual value was ${e}`)};n.typeOf.number.lessThanOrEquals=function(t,e,o){if(n.typeOf.number(t,e),e>o)throw new r(`Expected ${t} to be less than or equal to ${o}, actual value was ${e}`)};n.typeOf.number.greaterThan=function(t,e,o){if(n.typeOf.number(t,e),e<=o)throw new r(`Expected ${t} to be greater than ${o}, actual value was ${e}`)};n.typeOf.number.greaterThanOrEquals=function(t,e,o){if(n.typeOf.number(t,e),e<o)throw new r(`Expected ${t} to be greater than or equal to ${o}, actual value was ${e}`)};n.typeOf.object=function(t,e){if(typeof e!="object")throw new r(a(typeof e,"object",t))};n.typeOf.bool=function(t,e){if(typeof e!="boolean")throw new r(a(typeof e,"boolean",t))};n.typeOf.bigint=function(t,e){if(typeof e!="bigint")throw new r(a(typeof e,"bigint",t))};n.typeOf.number.equals=function(t,e,o,i){if(n.typeOf.number(t,o),n.typeOf.number(e,i),o!==i)throw new r(`${t} must be equal to ${e}, the actual values are ${o} and ${i}`)};var l=n;export{r as a,l as b};
