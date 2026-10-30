import { register } from 'node:module';

// Lets unit tests import single-file components (`node --import`).
register('./vueLoader.mjs', import.meta.url);
