import { initDiscovery } from './controller.js';
import './discovery.css';

async function installOffline() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator))
    throw new Error('Use the built discovery page to install offline support.');
  const registration = await navigator.serviceWorker.register(
    '/discovery-sw.js',
    { scope: '/discovery.html' },
  );
  const worker =
    registration.installing ?? registration.waiting ?? registration.active;
  if (worker?.state === 'activated') {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(
        () => reject(new Error('Offline update timed out.')),
        30000,
      );
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        event.data?.ok
          ? resolve()
          : reject(new Error('Offline update failed.'));
      };
      worker.postMessage({ type: 'REFRESH_DISCOVERY_SHELL' }, [channel.port2]);
    });
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Offline installation timed out.')),
      30000,
    );
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        resolve();
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('Offline installation failed.'));
      }
    });
  });
}
const discovery = initDiscovery({ document, installOffline });
discovery.open();
window.addEventListener('beforeunload', () => discovery.destroy(), {
  once: true,
});
