'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  session,
  shell,
} = require('electron');
const { resolvePaths } = require('./lib/paths.cjs');
const { createLogger } = require('./lib/logger.cjs');
const { startServer } = require('./lib/server.cjs');
const { hardenSession } = require('./lib/security.cjs');
const { loadState, saveState, MIN_SIZE } = require('./lib/windowState.cjs');
const { buildMenu } = require('./lib/menu.cjs');
const { createSplash } = require('./lib/splash.cjs');

const APP_NAME = "God's Eye View";
app.setName(APP_NAME);
// Cesium needs WebGL; do not let a conservative blocklist silently drop the
// GPU on older drivers.
app.commandLine.appendSwitch('ignore-gpu-blocklist');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  const paths = resolvePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    logs: app.getPath('logs'),
  });
  const logger = createLogger(paths.logDir, 'desktop');
  let server = null;
  let mainWindow = null;
  let quitting = false;

  process.on('uncaughtException', (error) =>
    logger.error(`uncaught: ${error?.stack ?? error}`),
  );

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    server?.stop();
  });

  async function fail(error) {
    logger.error(error?.stack ?? String(error));
    const { response } = await dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: `${APP_NAME} could not start.`,
      detail: `${error?.message ?? error}\n\nLog: ${logger.file}`,
      buttons: ['Open Logs Folder', 'Quit'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 0) await shell.openPath(paths.logDir);
    app.quit();
  }

  function openMainWindow(url) {
    const displays = require('electron').screen.getAllDisplays();
    const state = loadState(paths.windowStateFile, displays);
    const window = new BrowserWindow({
      ...state,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: APP_NAME,
      backgroundColor: '#0a0a0f',
      show: false,
      icon: path.join(__dirname, 'assets', 'icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    if (state.maximized) window.maximize();
    window.once('ready-to-show', () => window.show());
    window.on('close', () => saveState(paths.windowStateFile, window));
    window.on('page-title-updated', (event) => event.preventDefault());
    window.loadURL(url);
    return window;
  }

  app.whenReady().then(async () => {
    const splash = createSplash();
    try {
      server = await startServer({ paths, logger });
      const origin = new URL(server.url).origin;
      hardenSession({ app, session: session.defaultSession, shell, origin });
      Menu.setApplicationMenu(
        buildMenu({
          stateDir: paths.stateDir,
          logDir: paths.logDir,
          devTools: !app.isPackaged || process.env.GEV_DEVTOOLS === '1',
        }),
      );
      server.onExit((code) => {
        if (!quitting)
          fail(
            new Error(`The local server stopped unexpectedly (code ${code}).`),
          );
      });
      mainWindow = openMainWindow(server.url);
      mainWindow.once('ready-to-show', () => splash.destroy());
    } catch (error) {
      if (!splash.isDestroyed()) splash.destroy();
      await fail(error);
    }
  });
}
