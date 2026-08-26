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

import{c as O}from"./chunk-TODZU3UG.js";import{a as f}from"./chunk-VIWNLE3Z.js";import{e as t}from"./chunk-4TAASUQ2.js";function n(e){e=e??O.EMPTY_OBJECT,this.position=e.position??!1,this.normal=e.normal??!1,this.st=e.st??!1,this.bitangent=e.bitangent??!1,this.tangent=e.tangent??!1,this.color=e.color??!1}n.POSITION_ONLY=Object.freeze(new n({position:!0}));n.POSITION_AND_NORMAL=Object.freeze(new n({position:!0,normal:!0}));n.POSITION_NORMAL_AND_ST=Object.freeze(new n({position:!0,normal:!0,st:!0}));n.POSITION_AND_ST=Object.freeze(new n({position:!0,st:!0}));n.POSITION_AND_COLOR=Object.freeze(new n({position:!0,color:!0}));n.ALL=Object.freeze(new n({position:!0,normal:!0,st:!0,tangent:!0,bitangent:!0}));n.DEFAULT=n.POSITION_NORMAL_AND_ST;n.packedLength=6;n.pack=function(e,o,i){if(!t(e))throw new f("value is required");if(!t(o))throw new f("array is required");return i=i??0,o[i++]=e.position?1:0,o[i++]=e.normal?1:0,o[i++]=e.st?1:0,o[i++]=e.tangent?1:0,o[i++]=e.bitangent?1:0,o[i]=e.color?1:0,o};n.unpack=function(e,o,i){if(!t(e))throw new f("array is required");return o=o??0,t(i)||(i=new n),i.position=e[o++]===1,i.normal=e[o++]===1,i.st=e[o++]===1,i.tangent=e[o++]===1,i.bitangent=e[o++]===1,i.color=e[o]===1,i};n.clone=function(e,o){if(t(e))return t(o)||(o=new n),o.position=e.position,o.normal=e.normal,o.st=e.st,o.tangent=e.tangent,o.bitangent=e.bitangent,o.color=e.color,o};var _=n;export{_ as a};
