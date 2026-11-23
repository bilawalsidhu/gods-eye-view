import { initFirstRunExperience } from '../firstRunExperience.js';

/**
 * Reveal welcome controls only after restoration and the loading transition.
 * `playOpening` plays the opening on a bare address (src/app/openingIntro.js).
 */
export function startApplicationChrome({
  loadingScreen,
  styleManager,
  dataManager,
  signal,
  initializeWelcome = initFirstRunExperience,
  initializeSettings,
  playOpening = null,
}) {
  let disposed = false;
  let firstRun;
  let opening = null;
  let revealTimer;
  let resolveDelay;
  const minimumDelay = new Promise((resolve) => {
    resolveDelay = resolve;
  });
  const delayTimer = setTimeout(resolveDelay, 1000);
  const revealFirstRun = () => {
    if (disposed || signal.aborted || firstRun) return;
    firstRun = initializeWelcome?.({ styleManager, dataManager });
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
  };
  void Promise.all([styleManager.initialRestorePromise, minimumDelay])
    .catch(() => {
      /* Restoration reports its own outcome through the controls. */
    })
    .then(([restored] = []) => {
      if (disposed || signal.aborted) return;
      // A bare address, or a share of only a view, opens with the opening
      // (it ends where the camera stands); welcome waits for its end. Its
      // frames stay out of the address, held before the first one: a reload
      // or a copied link mid-flight would open on a speck of a planet.
      const shareLink = styleManager.shareLinkManager;
      const wanted =
        !!playOpening &&
        (!styleManager.hasShareState || sharesOnlyAView(restored));
      if (wanted) shareLink?.holdWrites?.(true, 'opening');
      opening = wanted
        ? playOpening({ viewer: styleManager.viewer, loadingScreen })
        : null;
      const release = () => shareLink?.holdWrites?.(false, 'opening');
      if (opening) {
        void opening.done.then(() => {
          release();
          revealFirstRun();
        });
        return;
      }
      if (wanted) release();
      loadingScreen.classList.add('hidden');
      loadingScreen.addEventListener('transitionend', revealFirstRun, {
        once: true,
      });
      revealTimer = setTimeout(revealFirstRun, 900);
    });
  const keySetup = Promise.resolve(
    signal.aborted ? null : initializeSettings?.({ signal }),
  );
  // Own the pending initializer too; it must not reveal a dialog after abort.
  void keySetup.catch(() =>
    console.error('Provider settings initialization failed'),
  );
  return async () => {
    disposed = true;
    opening?.cancel();
    clearTimeout(delayTimer);
    clearTimeout(revealTimer);
    resolveDelay();
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
    firstRun?.destroy();
    (await keySetup.catch(() => null))?.destroy();
  };
}

/**
 * Whether a start-up share restore left only a view: the camera landed where
 * the link points and nothing is followed or selected for it.
 */
function sharesOnlyAView(restored) {
  return (
    restored?.status === 'settled' &&
    restored.share?.camera === 'applied' &&
    restored.tracking?.status === 'skipped' &&
    restored.tracking.reason === 'no-shared-target' &&
    !restored.thing
  );
}
