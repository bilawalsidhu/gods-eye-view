/**
 * Electron desktop shell — `npm start`.
 *
 * The dev server is the whole app: Vite serves the client AND runs the API
 * proxies as middleware (see Dockerfile). So the shell starts that server the
 * way `npm run dev` does, on loopback only, and opens a window on it. The
 * server runs under the Node that launched npm, not Electron's bundled one,
 * because package.json `engines` pins a newer Node than Electron ships.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, session, shell } from 'electron';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const READY_TIMEOUT_MS = 120_000;
// What the page may ask for: the microphone for voice control, location for
// "where am I", and the clipboard for share links.
const GRANTED_PERMISSIONS = new Set([
  'media',
  'geolocation',
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
]);

let server = null;
let appOrigin = null;
let quitting = false;

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Keep the usual port when it is free, so the page keeps its origin (and its
 * saved layers and settings) from one launch to the next. When `npm run dev`
 * already holds it, take any free port rather than refusing to start.
 */
async function choosePort() {
  const preferred = Number.parseInt(process.env.PORT, 10) || DEFAULT_PORT;
  if (await portIsFree(preferred)) return preferred;
  const port = await anyFreePort();
  console.warn(`[Electron] Port ${preferred} is busy; using ${port}.`);
  return port;
}

function startServer(port) {
  // npm sets npm_node_execpath to the Node it runs under; fall back to PATH.
  const node = process.env.npm_node_execpath || 'node';
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(
    node,
    [vite, '--host', HOST, '--port', String(port), '--strictPort'],
    {
      cwd: ROOT,
      env: { ...process.env, HOST, PORT: String(port) },
      stdio: 'inherit',
    },
  );
  child.once('exit', (code, signal) => {
    server = null;
    if (app.isReady() && !quitting) {
      dialog.showErrorBox(
        "God's Eye View",
        `The local server stopped (${signal || `exit code ${code}`}). ` +
          'See the terminal for details.',
      );
    }
    app.quit();
  });
  child.once('error', (error) => {
    console.error(`[Electron] Could not start the server: ${error.message}`);
  });
  return child;
}

async function waitForServer(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!server) throw new Error('the server exited before it was ready');
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no answer from ${url} after ${READY_TIMEOUT_MS / 1000}s`);
}

function isAppUrl(url) {
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
}

function openExternally(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

function configureSession() {
  const allow = (webContents, permission) =>
    GRANTED_PERMISSIONS.has(permission) && isAppUrl(webContents.getURL());
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) =>
      callback(allow(webContents, permission)),
  );
  session.defaultSession.setPermissionCheckHandler((webContents, permission) =>
    webContents ? allow(webContents, permission) : false,
  );
}

function createWindow(url) {
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    title: "God's Eye View",
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once('ready-to-show', () => window.show());
  // Links to other sites (attribution, sources, docs) open in the browser.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (isAppUrl(target)) return { action: 'allow' };
    openExternally(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    openExternally(target);
  });
  window.loadURL(url);
  return window;
}

function stopServer() {
  quitting = true;
  if (server && server.exitCode === null) server.kill('SIGTERM');
}

app.on('before-quit', stopServer);
app.on('window-all-closed', () => app.quit());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => app.quit());
}

app.whenReady().then(async () => {
  try {
    const port = await choosePort();
    const url = `http://${HOST}:${port}/`;
    appOrigin = new URL(url).origin;
    server = startServer(port);
    await waitForServer(url);
    configureSession();
    createWindow(url);
    console.log(`[Electron] Ready at ${url}`);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
    });
  } catch (error) {
    dialog.showErrorBox("God's Eye View", `Start refused: ${error.message}`);
    stopServer();
    app.quit();
  }
});
