import { createScenarioEditorLayer } from '../../layers/scenarioEditor/index.js';
import * as input from '../../data/inputOwnership.js';

/** Save a text file through the browser's download path. */
function downloadText(name, text) {
  if (
    typeof document === 'undefined' ||
    typeof URL?.createObjectURL !== 'function'
  )
    return false;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Ask for one JSON file and resolve with its text. */
function pickTextFile() {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('No document'));
      return;
    }
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.json,application/json';
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (!file) {
        reject(new Error('No file chosen'));
        return;
      }
      file.text().then(resolve, reject);
    });
    picker.click();
  });
}

/**
 * Construct the Scenario Editor over the Simulation and Virtual Cameras
 * layers, with the page's pointer ownership and file dialogs.
 */
export function createApplicationScenarioEditor({
  simulation,
  cameras,
  ...options
}) {
  return createScenarioEditorLayer({
    simulation,
    cameras,
    services: { input },
    download: downloadText,
    pickFile: pickTextFile,
    ...options,
  });
}
