// Saved scenes: save, open, rename, duplicate and delete workspace states
// the engine can actually restore (camera, enabled layers, mode, selection,
// panel state). Stored locally; validated on read.
import { t } from '../../i18n/index.js';
import { el, button, chip, emptyState, formatCoordinate } from './dom.js';
import { formatTimestamp, formatAge } from './provenance.js';
import { modeById } from './modes.js';
import { pageHead } from './pages.js';

export function renderScenes(ctx) {
  const engine = ctx.engine();
  const scenes = ctx.workspace.scenes
    .list()
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const nameInput = el('input', {
    className: 'oryn-input',
    attrs: {
      type: 'text',
      maxlength: 160,
      placeholder: t('Scene name'),
      'aria-label': t('Scene name'),
    },
  });
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Saved Scenes'),
      t(
        'A scene restores the camera, the enabled layers, the active mode and the selected item. Scenes are stored in this browser. A scene cannot bring back historical records a feed no longer serves.',
      ),
    ),
    el(
      'form',
      {
        className: 'oryn-card oryn-form',
        on: {
          submit: (event) => {
            event.preventDefault();
            const name = nameInput.value.trim();
            if (!name || !engine) return;
            try {
              ctx.saveScene(name);
              nameInput.value = '';
              ctx.rerender();
            } catch (error) {
              ctx.toast(error?.message || String(error));
            }
          },
        },
      },
      el('h3', { className: 'oryn-card-title', text: t('Save current view') }),
      el(
        'div',
        { className: 'oryn-form-row' },
        nameInput,
        button({
          label: t('Save scene'),
          iconName: 'pin',
          className: 'oryn-btn-primary',
          type: 'submit',
          disabled: !engine,
        }),
      ),
      engine
        ? null
        : el('p', {
            className: 'oryn-note',
            text: t('Saving is available once the globe has initialized.'),
          }),
    ),
    scenes.length
      ? el(
          'div',
          { className: 'oryn-grid' },
          scenes.map((scene) => {
            const mode = modeById(scene.mode);
            return el(
              'div',
              { className: 'oryn-card' },
              el(
                'div',
                { className: 'oryn-card-head' },
                el('h3', { className: 'oryn-card-title', text: scene.name }),
                chip(t(mode.label), 'neutral'),
              ),
              el('span', {
                className: 'oryn-card-meta',
                text: [
                  formatCoordinate(
                    scene.camera.position.lat,
                    scene.camera.position.lon,
                  ),
                  t('{count} layers', { count: scene.enabledLayers.length }),
                  scene.selection
                    ? t('selection: {label}', {
                        label: scene.selection.label || scene.selection.id,
                      })
                    : null,
                  t('updated {age}', { age: formatAge(scene.updatedAt) }),
                ]
                  .filter(Boolean)
                  .join(' · '),
              }),
              el('span', {
                className: 'oryn-card-meta',
                text: scene.enabledLayers.join(', ') || t('no layers'),
              }),
              el(
                'div',
                { className: 'oryn-actions' },
                button({
                  label: t('Open'),
                  iconName: 'map',
                  className: 'oryn-btn-sm oryn-btn-primary',
                  disabled: !engine,
                  onClick: () => ctx.openScene(scene.id),
                }),
                button({
                  label: t('Rename'),
                  iconName: 'edit',
                  className: 'oryn-btn-sm',
                  onClick: () => {
                    const name = window.prompt(t('New scene name'), scene.name);
                    if (name && name.trim()) {
                      ctx.workspace.renameScene(scene.id, name.trim());
                      ctx.rerender();
                    }
                  },
                }),
                button({
                  label: t('Duplicate'),
                  iconName: 'plus',
                  className: 'oryn-btn-sm',
                  onClick: () => {
                    ctx.workspace.duplicateScene(scene.id);
                    ctx.rerender();
                  },
                }),
                button({
                  label: t('Update'),
                  iconName: 'refresh',
                  className: 'oryn-btn-sm',
                  disabled: !engine,
                  title: t('Overwrite this scene with the current view'),
                  onClick: () => {
                    try {
                      ctx.saveScene(scene.name, { id: scene.id });
                      ctx.rerender();
                    } catch (error) {
                      ctx.toast(error?.message || String(error));
                    }
                  },
                }),
                button({
                  label: t('Delete'),
                  iconName: 'trash',
                  className: 'oryn-btn-sm oryn-btn-danger',
                  onClick: () => {
                    if (
                      window.confirm(
                        t('Delete scene "{name}"?', { name: scene.name }),
                      )
                    ) {
                      ctx.workspace.deleteScene(scene.id);
                      ctx.rerender();
                    }
                  },
                }),
              ),
              el('span', {
                className: 'oryn-card-meta',
                text: t('saved {time}', {
                  time: formatTimestamp(scene.createdAt),
                }),
              }),
            );
          }),
        )
      : emptyState(
          t('No saved scenes'),
          t(
            'Compose a view on the map, then save it here or from the command bar.',
          ),
        ),
  );
}
