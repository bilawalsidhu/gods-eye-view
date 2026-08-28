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

import{a as t}from"./chunk-N3A5CZ2S.js";import{a as O}from"./chunk-G75U3WZT.js";import{e as f}from"./chunk-3THTQ4QB.js";function n(e){e=t(e,t.EMPTY_OBJECT),this.position=t(e.position,!1),this.normal=t(e.normal,!1),this.st=t(e.st,!1),this.bitangent=t(e.bitangent,!1),this.tangent=t(e.tangent,!1),this.color=t(e.color,!1)}n.POSITION_ONLY=Object.freeze(new n({position:!0}));n.POSITION_AND_NORMAL=Object.freeze(new n({position:!0,normal:!0}));n.POSITION_NORMAL_AND_ST=Object.freeze(new n({position:!0,normal:!0,st:!0}));n.POSITION_AND_ST=Object.freeze(new n({position:!0,st:!0}));n.POSITION_AND_COLOR=Object.freeze(new n({position:!0,color:!0}));n.ALL=Object.freeze(new n({position:!0,normal:!0,st:!0,tangent:!0,bitangent:!0}));n.DEFAULT=n.POSITION_NORMAL_AND_ST;n.packedLength=6;n.pack=function(e,o,i){if(!f(e))throw new O("value is required");if(!f(o))throw new O("array is required");return i=t(i,0),o[i++]=e.position?1:0,o[i++]=e.normal?1:0,o[i++]=e.st?1:0,o[i++]=e.tangent?1:0,o[i++]=e.bitangent?1:0,o[i]=e.color?1:0,o};n.unpack=function(e,o,i){if(!f(e))throw new O("array is required");return o=t(o,0),f(i)||(i=new n),i.position=e[o++]===1,i.normal=e[o++]===1,i.st=e[o++]===1,i.tangent=e[o++]===1,i.bitangent=e[o++]===1,i.color=e[o]===1,i};n.clone=function(e,o){if(f(e))return f(o)||(o=new n),o.position=e.position,o.normal=e.normal,o.st=e.st,o.tangent=e.tangent,o.bitangent=e.bitangent,o.color=e.color,o};var _=n;export{_ as a};
