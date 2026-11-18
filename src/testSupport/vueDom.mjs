import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * Give a component test a browser document; returns the teardown.
 * Call it from `before`/`after`, since other suites assert there is no DOM.
 */
export function installVueDom() {
  GlobalRegistrator.register({ url: 'http://localhost/' });
  return () => GlobalRegistrator.unregister();
}
