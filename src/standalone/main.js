import { createStandaloneApplication } from './application.js';
import { describeError } from './errors.js';
import { viewUrl } from '../xr/routes.js';

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = `Error: ${describeError(error)}`;
  loaderStatus.style.color = '#ff4444';
});

if (new URLSearchParams(location.search).get('embed') !== '1') {
  const link = document.createElement('a');
  link.href = viewUrl(location.href, 'spatial');
  link.textContent = 'Spatial view ↗';
  link.style.cssText =
    'position:fixed;bottom:16px;right:16px;z-index:10000;padding:10px 14px;border:1px solid #6ce6c0;border-radius:8px;background:#08151e;color:#b7ffe9;font:13px Inter,sans-serif;text-decoration:none';
  document.body.append(link);
}

export { application };
