import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  return createApplication({
    createScene: (context) =>
      createStandaloneScene({
        ...context,
        googleApiKey,
        cesiumToken,
        loaderStatus,
      }),
    createControls: (context) =>
      createStandaloneControls({ ...context, loaderStatus }),
    createData: (context) =>
      createStandaloneData({ ...context, allowQaRegistration }),
    createTools: (context) =>
      createStandaloneTools({ ...context, loadingScreen }),
  });
}
