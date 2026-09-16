import * as Cesium from 'cesium';
import { isPointerFree } from '../data/inputOwnership.js';
import { createInteractionSession } from '../director/interactions/session.js';

/** Own the active shot's pick handler, accessible actions and plain-text feedback. */
export function createSceneInteractions(
  viewer,
  { execute, available = () => true },
) {
  let panel,
    status,
    card,
    handler,
    items = [],
    targets = new Map();
  const buttons = new Map();
  const session = createInteractionSession({
    execute: (item, signal) => {
      if (!isPointerFree() || !available()) return false;
      card.replaceChildren();
      if (item.action.type === 'card') {
        const text = document.createElement('p');
        text.textContent = item.action.text;
        card.append(text);
        if (item.action.url) {
          const link = document.createElement('a');
          link.textContent = 'Source';
          link.style.color = '#6eeaff';
          link.href = item.action.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          card.append(link);
        }
        return true;
      }
      return execute(item.action, signal);
    },
    changed(state) {
      for (const [id, button] of buttons) {
        button.disabled = state.busy;
        button.setAttribute('aria-pressed', String(state.selected === id));
        button.style.outline = state.selected === id ? '2px solid #6eeaff' : '';
      }
    },
  });
  function clear() {
    session.clear();
    handler?.destroy();
    handler = null;
    panel?.remove();
    panel = null;
    status = null;
    card = null;
    buttons.clear();
    items = [];
    targets.clear();
  }
  async function dispatch(id) {
    const current = panel;
    const ok = await session.dispatch(id);
    if (current && current === panel && status)
      status.textContent = ok
        ? 'Action complete'
        : 'Action unavailable or cancelled';
    return ok;
  }
  return {
    clear,
    destroy: clear,
    getState: session.getState,
    activate(shot, registered) {
      clear();
      items = shot.interactions || [];
      if (!items.length) return;
      targets = registered;
      if (
        items.some(
          (item) =>
            !targets.has(
              JSON.stringify([item.target.packId, item.target.featureId]),
            ),
        )
      ) {
        items = [];
        targets.clear();
        throw new Error('Interaction feature is missing from the loaded pack');
      }
      panel = document.createElement('section');
      panel.dataset.directorInteractions = '';
      panel.setAttribute('aria-label', 'Scene actions');
      Object.assign(panel.style, {
        position: 'absolute',
        left: '12px',
        bottom: '80px',
        zIndex: '31',
        maxWidth: '300px',
        maxHeight: '40vh',
        overflowY: 'auto',
        background: '#08141eed',
        color: '#e3faff',
        border: '1px solid #2491a8',
        padding: '10px',
        font: '13px sans-serif',
      });
      const owner = panel;
      const title = document.createElement('strong');
      title.textContent = 'Scene actions';
      panel.append(title);
      status = document.createElement('p');
      status.setAttribute('role', 'status');
      status.textContent =
        'Select a feature or use Tab and Enter to choose an action.';
      panel.append(status);
      for (const item of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = item.label;
        button.dataset.directorAction = item.id;
        Object.assign(button.style, {
          display: 'block',
          background: '#10242e',
          color: '#e3faff',
          border: '1px solid #397080',
          borderRadius: '3px',
          padding: '6px 10px',
          cursor: 'pointer',
          font: 'inherit',
          margin: '6px 0',
          maxWidth: '100%',
          whiteSpace: 'normal',
        });
        button.addEventListener('click', () => {
          if (panel === owner) void dispatch(item.id);
        });
        buttons.set(item.id, button);
        panel.append(button);
      }
      card = document.createElement('div');
      card.dataset.directorActionCard = '';
      panel.append(card);
      viewer.container.append(panel);
      session.activate(items);
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event) => {
        if (panel !== owner || !isPointerFree() || !available()) return;
        const picked = viewer.scene.pick(event.position)?.id;
        const matches = items.filter(
          (item) =>
            targets.get(
              JSON.stringify([item.target.packId, item.target.featureId]),
            ) === picked,
        );
        if (!matches.length) return;
        for (const item of items) {
          const button = buttons.get(item.id);
          button.style.outline = matches.includes(item)
            ? '2px solid #6eeaff'
            : '';
        }
        status.textContent = `Selected feature: ${matches[0].target.featureId}. Choose an action.`;
        buttons.get(matches[0].id)?.focus({ preventScroll: true });
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
  };
}
