import { registerHooks } from 'node:module';
import { load } from './vueLoader.js';

// Lets Node import single-file components: `node --import=<this file>`.
// Hosts reach it as `<core package>/build/register-vue`. The hooks run on the
// loading thread: off-thread hooks (module.register) would add a round trip
// to every module a test imports, not only the components.
registerHooks({ load });
