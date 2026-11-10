import { createSessionHandoff } from '../app/sessionHandoff.js';
import {
  createEngineSwitch,
  handOffSession,
  resumeSession,
  waitForFirstFrame,
} from './engineSwitch.js';

/**
 * One scene-switch transaction: retain the session, detach and park the
 * outgoing globe, attach and resume the candidate, then uncover its frame.
 * The scene host owns ordering and the single rollback. The
 * application owns candidate cleanup, including a failure during resume.
 *
 * @param {object} options
 * @param {import('../app/layerSession.js').LayerSession} options.layerSession
 */
export function createSceneSwitcher({
  getApplication,
  startApplication,
  layerSession,
  renderers,
  diagnostics,
  keepFrame,
  onSettled,
  ...options
}) {
  const { signal } = layerSession.lifetime;
  let cover = null;
  let cockpit = null;
  const count = (name) => diagnostics?.count(name);
  const liveComponents = () => {
    const app = getApplication();
    if (app?.getState().status !== 'ready') return null;
    const components = app.getComponents();
    return components.scene?.engine ? components : null;
  };

  async function leave(from, _to, change, transaction) {
    const components = liveComponents();
    if (components) {
      cover ??= keepFrame?.(components.scene.engine);
      const style = components.controls.styleManager;
      cockpit = style.getCockpitState();
      layerSession.handoff = createSessionHandoff(layerSession, {
        addressLayerIds:
          style.shareLinkManager?.currentLayerState?.()?.enabledLayerIds,
        visit: change?.visit === true,
      });
      handOffSession(layerSession);
      renderers.retain(from);
      await getApplication().detachScene({ handoff: true }, transaction);
    }
    count('detaches');
  }

  async function resume(style, restoreView) {
    signal.throwIfAborted();
    await style.initialRestorePromise;
    signal.throwIfAborted();
    restoreView();
    count('attachments');
    await resumeSession(layerSession);
    // A visited entry or a stale track may replace the outgoing subject.
    const target = style.getAircraftTrackingTarget();
    if (
      cockpit?.active &&
      target &&
      target.id === cockpit.subject?.id &&
      target.layerId === cockpit.subject?.layerId &&
      style.controlCockpit('enter').ok
    ) {
      style.cockpitView.setVisionMode(cockpit.visionMode);
    }
  }

  async function enter(kind, { recovery = false } = {}, transaction) {
    let restoreView;
    layerSession.viewRestored = new Promise((resolve) => {
      restoreView = resolve;
    });
    let app = getApplication();
    if (!app || app.getState().status !== 'ready') {
      app = startApplication(kind, transaction);
      try {
        const { controls } = await app.start();
        await resume(controls.styleManager, restoreView);
      } catch (error) {
        if (!signal.aborted)
          await app
            .destroy(transaction)
            .catch((cleanupError) =>
              console.error(
                'A failed globe could not be released:',
                cleanupError,
              ),
            );
        throw error;
      }
    } else {
      await app.attachScene(kind, {
        transaction,
        resume: () =>
          resume(app.getComponents().controls.styleManager, restoreView),
      });
    }
    if (recovery) count('rollbacks');
  }

  async function settle() {
    const components = liveComponents();
    try {
      if (cover && components) await waitForFirstFrame(components.scene.engine);
    } finally {
      cover?.remove();
      cover = null;
    }
    if (!components) return;
    layerSession.handoff = null;
    cockpit = null;
    onSettled?.();
    components.controls.styleManager.shareLinkManager?.resumeNavigation?.();
  }

  return createEngineSwitch({
    ...options,
    sceneHost: getApplication()?.sceneHost,
    signal,
    leave,
    enter,
    settle,
  });
}
