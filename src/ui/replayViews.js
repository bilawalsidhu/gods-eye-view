/**
 * @module ui/replayViews
 * @description The "Saved views" block of the REPLAY settings: save the
 * current window, area, layers and speed under a name, and come back to it
 * (or remove it) later. Views live with the recorded history.
 */
import { msg, t } from '../i18n/index.js';

const COULD_NOT_SAVE = msg('Could not save the view');
const COULD_NOT_OPEN = msg('Could not open the view');

/**
 * @param {object} options
 * @param {object} options.controller  replay controller (listViews, saveView, deleteView, applyView)
 * @param {(parent: Element, label: string, title: string, onClick: Function) => Element} options.makeChip
 * @param {(parent: Element, type: string, label: string) => HTMLInputElement} options.makeInput
 * @returns {{ element: HTMLElement, refresh: () => Promise<void> }}
 */
export function createViewsBlock({ controller, makeChip, makeInput }) {
  const element = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'replay-alerts';
  label.textContent = t('Saved views');
  const nameIn = makeInput(element, 'text', t('Name for this view'));
  nameIn.maxLength = 60;
  const choose = document.createElement('select');
  choose.className = 'ui-input';
  choose.setAttribute('aria-label', t('Saved views'));
  const row = document.createElement('div');
  row.className = 'replay-chips';
  const note = document.createElement('div');
  note.className = 'replay-alerts';
  element.replaceChildren(label, nameIn, choose, row, note);
  let views = [];
  const say = (text) => {
    note.textContent = text;
  };

  async function refresh(select = null) {
    try {
      views = await controller.listViews();
    } catch (error) {
      views = [];
      say(error.message);
    }
    choose.replaceChildren(
      ...(views.length
        ? views.map((v) =>
            Object.assign(document.createElement('option'), {
              value: v.name,
              textContent: v.name,
            }),
          )
        : [
            Object.assign(document.createElement('option'), {
              value: '',
              textContent: t('No saved views yet'),
            }),
          ]),
    );
    if (select) choose.value = select;
    go.disabled = remove.disabled = !views.length;
  }

  makeChip(
    row,
    t('SAVE VIEW'),
    t('Save the current time window, area, layers and speed'),
    async () => {
      try {
        const { saved } = await controller.saveView(nameIn.value);
        say(t('Saved the view {name}', { name: saved }));
        nameIn.value = '';
        await refresh(saved);
      } catch (error) {
        say(`${t(COULD_NOT_SAVE)}: ${error.message}`);
      }
    },
  );
  const go = makeChip(
    row,
    t('OPEN VIEW'),
    t('Go back to the chosen view'),
    async () => {
      const found = views.find((v) => v.name === choose.value);
      if (!found) return;
      try {
        await controller.applyView(found.view);
        say(t('Opened the view {name}', { name: found.name }));
      } catch (error) {
        say(`${t(COULD_NOT_OPEN)}: ${error.message}`);
      }
    },
  );
  const remove = makeChip(
    row,
    t('DELETE VIEW'),
    t('Remove the chosen view'),
    async () => {
      if (!choose.value) return;
      try {
        await controller.deleteView(choose.value);
        say('');
      } catch (error) {
        say(error.message);
      }
      await refresh();
    },
  );
  go.disabled = remove.disabled = true;
  return { element, refresh };
}
