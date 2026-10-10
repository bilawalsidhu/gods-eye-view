'use strict';

const { Menu, shell } = require('electron');

const PROJECT_URL = 'https://github.com/bilawalsidhu/gods-eye-view';

/**
 * Application menu. Provider keys are entered inside the app (POWER UP), so the
 * menu only needs navigation, view, and the two folders support asks about.
 * @param {{stateDir: string, logDir: string, devTools: boolean, mac?: boolean}} options
 */
function buildMenu({
  stateDir,
  logDir,
  devTools,
  mac = process.platform === 'darwin',
}) {
  const view = [
    { role: 'reload' },
    { role: 'forceReload' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];
  if (devTools) view.push({ type: 'separator' }, { role: 'toggleDevTools' });
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Configuration Folder',
          click: () => shell.openPath(stateDir),
        },
        { label: 'Open Logs Folder', click: () => shell.openPath(logDir) },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: view },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal(PROJECT_URL),
        },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal(`${PROJECT_URL}/issues`),
        },
      ],
    },
  ]);
}

module.exports = { buildMenu, PROJECT_URL };
