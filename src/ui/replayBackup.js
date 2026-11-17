/**
 * @module ui/replayBackup
 * @description The "Backup and restore" block of the REPLAY settings: a
 * button that saves a complete copy of the recorded history, and a list of
 * earlier copies to switch back to. Restoring never overwrites the current
 * history, so the block says where it stayed.
 */
import { msg, t } from '../i18n/index.js';
import { formatBytes } from '../replay/model.js';

const COULD_NOT_BACK_UP = msg('Could not back up');
const COULD_NOT_RESTORE = msg('Could not restore');

/**
 * @param {object} options
 * @param {object} options.controller  replay controller (backUp, listBackups, restoreBackup)
 * @param {(parent: Element, label: string, title: string, onClick: Function) => Element} options.makeChip
 * @param {() => void} [options.onChanged] called after a restore, to redraw
 * @returns {{ element: HTMLElement, refresh: () => Promise<void> }}
 */
export function createBackupBlock({
  controller,
  makeChip,
  onChanged = () => {},
}) {
  const element = document.createElement('div');
  const label = document.createElement('div');
  label.className = 'replay-alerts';
  label.textContent = t('Backup and restore');
  const choose = document.createElement('select');
  choose.className = 'ui-input';
  choose.setAttribute('aria-label', t('Backups'));
  const row = document.createElement('div');
  row.className = 'replay-chips';
  const note = document.createElement('div');
  note.className = 'replay-alerts';
  element.append(label, choose, row, note);

  const say = (text) => {
    note.textContent = text;
  };

  async function refresh() {
    let files = [];
    try {
      files = (await controller.listBackups()).files;
    } catch (error) {
      say(error.message);
    }
    choose.replaceChildren(
      ...(files.length
        ? files.map((file) => {
            const option = document.createElement('option');
            option.value = file.path;
            option.textContent = `${file.name.replace(/^gev-history-backup-|\.sqlite$/g, '')} · ${formatBytes(file.bytes)}`;
            return option;
          })
        : [
            Object.assign(document.createElement('option'), {
              textContent: t('No backups yet'),
              value: '',
            }),
          ]),
    );
    restore.disabled = !files.length;
  }

  makeChip(
    row,
    t('BACK UP NOW'),
    t('Save a complete copy of the recorded history'),
    async () => {
      try {
        const r = await controller.backUp();
        say(
          t('Backed up {count} positions to {path}', {
            count: r.count.toLocaleString(),
            path: r.path,
          }),
        );
      } catch (error) {
        say(`${t(COULD_NOT_BACK_UP)}: ${error.message}`);
      }
      await refresh();
    },
  );
  const restore = makeChip(
    row,
    t('RESTORE'),
    t('Switch to the chosen backup; the current history stays on disk'),
    async () => {
      if (!choose.value) return;
      if (
        !globalThis.confirm?.(
          t(
            'Switch to this backup? The current history stays on disk under its own name.',
          ),
        )
      )
        return;
      try {
        const r = await controller.restoreBackup(choose.value);
        say(
          t(
            'Restored {count} positions. The previous history is still at {path}',
            {
              count: r.count.toLocaleString(),
              path: r.previous,
            },
          ),
        );
        onChanged();
      } catch (error) {
        say(`${t(COULD_NOT_RESTORE)}: ${error.message}`);
      }
      await refresh();
    },
  );
  restore.disabled = true;
  return { element, refresh };
}
