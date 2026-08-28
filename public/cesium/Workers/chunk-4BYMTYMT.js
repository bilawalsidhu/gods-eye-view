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

import{e as f}from"./chunk-3THTQ4QB.js";function c(t){let n,a=t.name,e=t.message;f(a)&&f(e)?n=`${a}: ${e}`:n=t.toString();let o=t.stack;return f(o)&&(n+=`
${o}`),n}var i=c;function l(t){async function n({data:e}){let o=[],s={id:e.id,result:void 0,error:void 0};self.CESIUM_BASE_URL=e.baseUrl;try{let r=await t(e.parameters,o);s.result=r}catch(r){r instanceof Error?s.error={name:r.name,message:r.message,stack:r.stack}:s.error=r}e.canTransferArrayBuffer||(o.length=0);try{postMessage(s,o)}catch(r){s.result=void 0,s.error=`postMessage failed with error: ${i(r)}
  with responseMessage: ${JSON.stringify(s)}`,postMessage(s)}}function a(e){postMessage({id:e.data?.id,error:`postMessage failed with error: ${JSON.stringify(e)}`})}return self.onmessage=n,self.onmessageerror=a,self}var d=l;export{d as a};
