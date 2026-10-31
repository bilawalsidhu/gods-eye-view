/** Own Scene panel listeners and presentation through project reads and actions. */
import { t, msg } from '../i18n/index.js';
import {
  sceneElements,
  presentSceneButtons,
  presentSceneProgress,
  presentSceneRuntime,
} from './scenePresentation.js';
import { useSceneStore } from './stores/scenes.js';
import { applicationPinia } from './vueRuntime.js';

export class SceneControls {
  /**
   * @param {object} options
   * @param {object} [options.store] Scene store the panel views render.
   */
  constructor({
    read,
    actions,
    subscribe,
    elements = sceneElements(),
    store = useSceneStore(applicationPinia()),
  }) {
    this.read = read;
    this.actions = actions;
    this.elements = elements;
    this.store = store;
    this.destroyed = false;
    this.actionGeneration = 0;
    this.removers = [];
    this.playbackKeyRemover = null;
    if (!elements.select) return;
    // The SceneShotList view renders the rows; their actions come back here.
    this.storeToken = store.attach({
      select: (id) => {
        this.run('selectShot', id);
        if (this.destroyed) return;
        store.selectShot(this.read().selectedShotId);
        this.setButtons(this.read().running);
      },
      rename: (sceneId, shotId, title) =>
        this.run('renameShot', sceneId, shotId, title),
      load: (sceneId, shotId) => this.run('load', sceneId, shotId),
      remove: (sceneId, shotId) => this.deleteShot(sceneId, shotId),
    });
    // The radio's PLAY means "listen"; this one plays the scene.
    const playLabel = t('PLAY', { context: 'scene' });
    if (elements.start) elements.start.textContent = playLabel;
    if (subscribe)
      this.unsubscribe = subscribe((notification) =>
        this.present(notification),
      );
    else {
      this.renderSceneSelect();
      this.renderShotList();
    }
    this.listen(elements.select, 'change', () =>
      this.run('selectScene', elements.select.value),
    );
    for (const [element, action] of Object.entries({
      capture: 'capture',
      update: 'update',
      next: 'next',
      export: 'export',
      download: 'download',
    })) {
      this.listen(elements[element], 'click', () => this.run(action));
    }
    this.listen(elements.new, 'click', () => this.createScene());
    this.listen(elements.delete, 'click', () => this.deleteSelectedScene());
    this.listen(elements.start, 'click', () =>
      this.run('start', this.read().selectedSceneId),
    );
    this.listen(elements.stop, 'click', () => this.run('stop', msg('Stopped')));
    this.listen(elements.import, 'click', () => elements.file?.click());
    this.listen(elements.file, 'change', async () => {
      const file = elements.file?.files?.[0];
      if (!file) return;
      await this.run(
        this.actions.reviewImport ? 'reviewImport' : 'import',
        file,
      );
      if (!this.destroyed) elements.file.value = '';
    });
    if (!subscribe) {
      this.updateStatus(t('Ready'));
      this.setProgress(0);
      this.setButtons(false);
    }
  }

  /** Apply only the presentation affected by an action; selection keeps row identity. */
  present({ state, change, initial }) {
    if (this.destroyed) return;
    const type = change?.type;
    if (
      initial ||
      [
        'scene-options-changed',
        'scene-created',
        'scene-deleted',
        'project-imported',
      ].includes(type)
    )
      this.renderSceneSelect();
    if (
      initial ||
      [
        'shots-changed',
        'scene-created',
        'scene-deleted',
        'shot-captured',
        'shot-updated',
        'shot-renamed',
        'shot-deleted',
        'project-imported',
      ].includes(type)
    )
      this.renderShotList();
    if (type === 'selection-changed')
      this.store.selectShot(state.selectedShotId);
    if (
      initial ||
      [
        'buttons-changed',
        'selection-changed',
        'scene-options-changed',
        'scene-created',
        'scene-deleted',
        'shots-changed',
        'shot-captured',
        'shot-deleted',
        'project-imported',
      ].includes(type)
    )
      this.setButtons(state.running);
    if (initial || type === 'progress-changed')
      this.setProgress(state.progress);
    if (initial || type === 'status-changed') this.updateStatus(state.status);
    if (initial || type === 'runtime-changed')
      this.updateRuntime(state.runtime);
    if (initial || type === 'playback-presentation')
      this.setPlaybackActive(state.playbackActive);
    if (initial || type === 'playback-keyboard')
      this.setPlaybackKeyboardEnabled(state.keyboardEnabled);
    if (type === 'project-exported') this.updateStatus(state.status);
    if (type === 'shot-loaded') this.updateStatus(state.status);
    if (type === 'run-event' && change.event === 'shot_start')
      this.setButtons(state.running);
  }

  listen(target, type, callback) {
    if (!target) return;
    const listener = (event) => {
      if (!this.destroyed) return callback(event);
    };
    target.addEventListener(type, listener);
    this.removers.push(() => target.removeEventListener(type, listener));
  }

  run(action, ...args) {
    if (this.destroyed) return;
    const generation = ++this.actionGeneration;
    const failed = () => {
      if (!this.destroyed && generation === this.actionGeneration)
        this.updateStatus(t('Scene action failed'));
    };
    try {
      const result = this.actions[action](...args);
      return result?.then ? Promise.resolve(result).catch(failed) : result;
    } catch {
      failed();
    }
  }

  /** Publish the project to the SceneOptions and SceneShotList views. */
  renderSceneSelect() {
    if (!this.destroyed) this.store.publishOptions(this.read());
  }

  createScene() {
    if (this.destroyed) return;
    const name = window.prompt(
      t('New scene name'),
      t('Scene {n}', { n: this.read().scenes.length + 1 }),
    );
    if (name) this.run('create', name);
  }

  deleteSelectedScene() {
    if (this.destroyed) return;
    const state = this.read();
    const scene = state.scenes.find(
      (item) => item.id === state.selectedSceneId,
    );
    if (
      scene &&
      window.confirm(
        t('Delete scene "{scene}" and all shots?', { scene: scene.title }),
      )
    )
      this.run('deleteScene');
  }

  deleteShot(sceneId, shotId) {
    if (this.destroyed) return;
    const scene = this.read().scenes.find((item) => item.id === sceneId);
    const shot = scene?.shots.find((item) => item.id === shotId);
    if (
      shot &&
      window.confirm(
        t('Delete shot "{shot}"?', { shot: shot.displayTitle || shot.title }),
      )
    )
      this.run('deleteShot', sceneId, shotId);
  }

  renderShotList() {
    if (!this.destroyed) this.store.publish(this.read());
  }

  setButtons(running) {
    if (this.destroyed) return;
    const state = this.read();
    const scene = state.scenes?.find(
      (item) => item.id === state.selectedSceneId,
    );
    const shots = scene?.shots ?? [];
    presentSceneButtons(this.elements, running, state.hasRun, {
      hasScene: !!scene,
      // PLAY and NEXT run on into the following scenes.
      playableShots: (state.scenes ?? []).reduce(
        (total, item) => total + (item.shots?.length ?? 0),
        0,
      ),
      hasSelectedShot: shots.some((shot) => shot.id === state.selectedShotId),
    });
    this.elements.panel?.classList.toggle('has-shots', shots.length > 0);
  }

  setProgress(progress) {
    if (!this.destroyed) presentSceneProgress(this.elements.progress, progress);
  }

  updateStatus(text) {
    if (!this.destroyed && this.elements.status)
      this.elements.status.textContent = text;
  }

  updateRuntime(text) {
    if (!this.destroyed) presentSceneRuntime(this.elements.runtime, text);
  }

  setPlaybackActive(active) {
    if (this.destroyed && active) return;
    document.body.classList.toggle('scene-playback-mode', active);
  }

  setPlaybackKeyboardEnabled(enabled) {
    if (!enabled) {
      this.playbackKeyRemover?.();
      this.playbackKeyRemover = null;
    } else if (!this.destroyed && !this.playbackKeyRemover) {
      const onKeyDown = (event) => {
        if (!this.destroyed && event.key === 'Escape' && this.read().running)
          this.run('stop', msg('Stopped (Esc)'));
      };
      document.addEventListener('keydown', onKeyDown);
      this.playbackKeyRemover = () =>
        document.removeEventListener('keydown', onKeyDown);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.actionGeneration++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.setPlaybackKeyboardEnabled(false);
    for (const remove of this.removers.splice(0)) remove();
    if (this.storeToken) this.store.detach(this.storeToken);
    this.elements.panel?.classList.toggle('has-shots', false);
    presentSceneRuntime(this.elements.runtime, '');
    this.setPlaybackActive(false);
  }
}
