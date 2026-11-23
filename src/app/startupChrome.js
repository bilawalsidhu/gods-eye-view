import { initFirstRunExperience } from '../firstRunExperience.js';

/**
 * Reveal welcome controls only after restoration and the loading transition.
 * `playOpening` plays the opening (src/app/openingIntro.js) on a bare address
 * or a share of only a view.
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
  // A navigation stamped after this (a search, a posted view, a later link)
  // owns the camera: the opening must not take it back.
  const generationAtStart = styleManager._navigationGeneration;
  const revealFirstRun = () => {
    if (disposed || signal.aborted || firstRun) return;
    firstRun = initializeWelcome?.({ styleManager, dataManager });
    clearTimeout(revealTimer);
    loadingScreen.removeEventListener('transitionend', revealFirstRun);
  };
  // Welcome waits for the cover's fade, or for 900 ms where none ends.
  const revealAfterCover = () => {
    if (disposed || signal.aborted) return;
    loadingScreen.addEventListener('transitionend', revealFirstRun, {
      once: true,
    });
    revealTimer = setTimeout(revealFirstRun, 900);
  };
  void Promise.all([styleManager.initialRestorePromise, minimumDelay])
    .catch(() => {
      /* Restoration reports its own outcome through the controls. */
    })
    .then(([restored] = []) => {
      if (disposed || signal.aborted) return;
      // A bare address, or a share of only a view, opens with the opening
      // unless a newer navigation took the camera or the link was refused.
      // Hold the restored address through the flight so a reload or a copied
      // link opens at the destination.
      const shareLink = styleManager.shareLinkManager;
      const generation = Number.isInteger(restored?.navigationToken)
        ? restored.navigationToken
        : generationAtStart;
      const navigatedSince =
        Number.isFinite(generation) &&
        styleManager._navigationGeneration !== generation;
      const wanted =
        !!playOpening &&
        !navigatedSince &&
        !shareLink?.rejectedShareCode &&
        (!styleManager.hasShareState || sharesOnlyAView(restored));
      if (wanted) shareLink?.holdWrites?.(true, 'opening');
      try {
        opening = wanted
          ? playOpening({ viewer: styleManager.viewer, loadingScreen })
          : null;
      } catch (error) {
        console.error('The opening failed', error);
        opening = null;
      }
      const release = () => shareLink?.holdWrites?.(false, 'opening');
      if (opening) {
        // The cover fades long before a played-out opening ends; a skip
        // hides it only as the opening ends.
        let coverFaded = false;
        const onCoverFaded = () => {
          coverFaded = true;
        };
        loadingScreen.addEventListener('transitionend', onCoverFaded, {
          once: true,
        });
        void opening.done.then(() => {
          release();
          loadingScreen.removeEventListener('transitionend', onCoverFaded);
          if (coverFaded) revealFirstRun();
          else revealAfterCover();
        });
        return;
      }
      if (wanted) release();
      loadingScreen.classList.add('hidden');
      revealAfterCover();
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
