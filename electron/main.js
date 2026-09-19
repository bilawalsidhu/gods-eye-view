import { app, BrowserWindow, shell } from 'electron';
import { createServer, loadEnv } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserViteConfig } from '../build/vite.js';
import { localProviderPlugins } from '../server/providers/local.js';
import { apiNotFoundPlugin } from '../server/standalone/api-not-found.js';

const applicationRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

let mainWindow = null;
let viteServer = null;

function loadUserEnvironment(userDataPath) {
  const loaded = loadEnv('production', userDataPath, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function startLocalServer(userDataPath) {
  loadUserEnvironment(userDataPath);
  process.chdir(userDataPath);
  const browserConfig = createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({ keySetupSourceRoot: userDataPath }),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: '127.0.0.1',
    port: 4173,
  });
  const server = await createServer({
    ...browserConfig,
    root: applicationRoot,
    configFile: false,
    server: {
      ...browserConfig.server,
      host: '127.0.0.1',
      port: 4173,
      strictPort: false,
    },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') {
    await server.close();
    throw new Error('Local application server did not provide a TCP port');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function createMainWindow() {
  const { server, url } = await startLocalServer(app.getPath('userData'));
  viteServer = server;
  const allowedOrigin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: '上帝視角',
    icon: path.join(applicationRoot, 'build', 'icon.png'),
    backgroundColor: '#071119',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === allowedOrigin) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    try {
      await createMainWindow();
    } catch (error) {
      console.error('Failed to start the desktop application:', error);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  void viteServer?.close();
  viteServer = null;
});