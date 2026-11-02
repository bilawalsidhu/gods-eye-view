import { register } from 'node:module';

// Lets Node import single-file components: `node --import=<this file>`.
// Hosts reach it as `<core package>/build/register-vue`.
register('./vueLoader.js', import.meta.url);
