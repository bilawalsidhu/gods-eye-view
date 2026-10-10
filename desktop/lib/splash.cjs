'use strict';

const { BrowserWindow } = require('electron');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  html,body{margin:0;height:100%;background:#0a0a0f;color:#e8eaed;
    font:13px/1.5 'Segoe UI',system-ui,sans-serif;-webkit-user-select:none;user-select:none}
  main{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  h1{margin:0;font-size:20px;letter-spacing:6px;font-weight:600}
  p{margin:0;color:rgba(232,234,237,.5);letter-spacing:1.5px;font-size:11px;text-transform:uppercase}
  .bar{width:220px;height:2px;background:rgba(255,255,255,.08);overflow:hidden;border-radius:2px}
  .bar i{display:block;width:40%;height:100%;background:#00d4ff;animation:slide 1.3s ease-in-out infinite}
  @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
</style></head>
<body><main><h1>GOD'S EYE VIEW</h1><div class="bar"><i></i></div>
<p>Starting local server</p></main></body></html>`;

/** Small frameless window shown while the local server boots. */
function createSplash() {
  const splash = new BrowserWindow({
    width: 420,
    height: 240,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#0a0a0f',
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  splash.once('ready-to-show', () => splash.show());
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  return splash;
}

module.exports = { createSplash };
