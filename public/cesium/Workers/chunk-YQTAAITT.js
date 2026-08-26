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

import{e}from"./chunk-4TAASUQ2.js";function t(r){this.name="RuntimeError",this.message=r;let o;try{throw new Error}catch(s){o=s.stack}this.stack=o}e(Object.create)&&(t.prototype=Object.create(Error.prototype),t.prototype.constructor=t);t.prototype.toString=function(){let r=`${this.name}: ${this.message}`;return e(this.stack)&&(r+=`
${this.stack.toString()}`),r};var c=t;export{c as a};
