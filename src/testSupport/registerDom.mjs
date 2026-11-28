import { installVueDom } from './vueDom.mjs';

// Import first in a test file whose modules load Vue at import time: Vue binds
// the document when it loads. Each test file runs in its own process.
installVueDom();
