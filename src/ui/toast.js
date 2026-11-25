import { useStatusStore } from './stores/status.js';
import { applicationPinia } from './vueRuntime.js';

// Counts every show on the page, so a repeated message is announced again.
let shown = 0;

/**
 * One owner's use of the page toast, which the scene chrome renders from the
 * status store. Each owner keeps its own timer, so a later toast from another
 * owner is hidden when this one's time is up, as the shared element was.
 * @param {object} options
 * @param {number} options.durationMs How long a toast stays up.
 * @param {object} [options.store] The status store.
 */
export function createToast({
  durationMs,
  store = useStatusStore(applicationPinia()),
}) {
  let timer = null;
  // The text stays while the toast fades out.
  const hide = () => {
    clearTimeout(timer);
    timer = null;
    if (store.toast?.visible)
      store.publishToast({ ...store.toast, visible: false });
  };
  return {
    /** @param {string} message */
    show(message) {
      store.publishToast({ text: message, visible: true, shown: ++shown });
      clearTimeout(timer);
      timer = setTimeout(hide, durationMs);
    },
    /** Hide the toast now and drop the timer. */
    hide,
    /** Drop the timer, leaving the toast as it is. */
    cancel() {
      clearTimeout(timer);
      timer = null;
    },
  };
}
