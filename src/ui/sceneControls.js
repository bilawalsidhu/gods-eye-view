/** Own Scene panel listeners and presentation through project reads and actions. */
import { t, msg, onLocaleChange } from '../i18n/index.js';
import { sceneButtonsDisabled, scenePercent } from './scenePresentation.js';
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
    store = useSceneStore(applicationPinia()),
  }) {
    this.read = read;
    this.actions = actions;
    this.store = store;
    this.destroyed = false;
    this.actionGeneration = 0;
    this.playbackKeyRemover = null;
    // The panel views render the buttons, status, progress and runtime chip.
    this.panel = {
      running: false,
      hasShots: false,
      disabled: sceneButtonsDisabled(false, false),
      status: '',
      progress: 0,
      runtime: '',
      // The radio's PLAY means "listen"; this one plays the scene.
      playLabel: t('PLAY', { context: 'scene' }),
    };
    // The SceneShotList view renders the rows and the panel its buttons;
    // their actions come back here.
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
      selectScene: (sceneId) => this.run('selectScene', sceneId),
      create: () => this.createScene(),
      deleteScene: () => this.deleteSelectedScene(),
      capture: () => this.run('capture'),
      update: () => this.run('update'),
      next: () => this.run('next'),
      export: () => this.run('export'),
      download: () => this.run('download'),
      start: () => this.run('start', this.read().selectedSceneId),
      stop: () => this.run('stop', msg('Stopped')),
      importFile: (file) =>
        this.run(this.actions.reviewImport ? 'reviewImport' : 'import', file),
    });
    this.presentPanel({});
    // Scene and shot titles are shown translated; the select and the list
    // show them again.
    this.offLocale = onLocaleChange(() => {
      this.presentPanel({ playLabel: t('PLAY', { context: 'scene' }) });
      this.renderSceneSelect();
      this.renderShotList();
    });
    if (subscribe)
      this.unsubscribe = subscribe((notification) =>
        this.present(notification),
      );
    else {
      this.renderSceneSelect();
      this.renderShotList();
    }
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

  /** Merge `patch` into the panel and publish it. */
  presentPanel(patch) {
    if (this.destroyed) return;
    Object.assign(this.panel, patch);
    // A newer owner's panel is left alone.
    if (this.store.owns(this.storeToken))
      this.store.publishPanel({ ...this.panel });
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
    this.presentPanel({
      running: !!running,
      hasShots: shots.length > 0,
      disabled: sceneButtonsDisabled(running, state.hasRun, {
        hasScene: !!scene,
        // PLAY and NEXT run on into the following scenes.
        playableShots: (state.scenes ?? []).reduce(
          (total, item) => total + (item.shots?.length ?? 0),
          0,
        ),
        hasSelectedShot: shots.some((shot) => shot.id === state.selectedShotId),
      }),
    });
  }

  setProgress(progress) {
    this.presentPanel({ progress: scenePercent(progress) });
  }

  updateStatus(text) {
    this.presentPanel({ status: text });
  }

  updateRuntime(text) {
    this.presentPanel({ runtime: text || '' });
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
    this.offLocale();
    this.setPlaybackKeyboardEnabled(false);
    // The panel keeps its last status and buttons, without shots or the
    // runtime chip.
    if (this.store.owns(this.storeToken))
      this.store.publishPanel({ ...this.panel, hasShots: false, runtime: '' });
    this.store.detach(this.storeToken);
    this.setPlaybackActive(false);
  }
}
