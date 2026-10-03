/**
 * The God's Eye View panel's script, run inside the panel page a host shows.
 * It is sent as source text (see src/tools/globePanel.js), so it must not use
 * imports or anything outside the function.
 *
 * The page lives on the host's site, and hosts may refuse other addresses,
 * such as a server on the user's machine. So the panel never requests the
 * app's server itself: every request for the app's own paths goes to the
 * panel's MCP server as a call to `config.toolName`, which requests the path
 * from the app's server. The app's built page, scripts, styles, images and
 * data all arrive that way; map imagery from providers loads directly.
 */
export function panelRuntime(config) {
  const status = document.getElementById('status');
  const open = document.getElementById('open');
  const expand = document.getElementById('expand');
  const say = (text) => {
    if (status.isConnected) status.textContent = text;
  };
  let blocked = null;
  document.addEventListener('securitypolicyviolation', (event) => {
    blocked = `${event.effectiveDirective} blocked ${event.blockedURI || 'a resource'}`;
  });

  // JSON-RPC with the host.
  let nextId = 1;
  const pending = new Map();
  const send = (message) =>
    window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  // Requests to the app's server, through the MCP server.
  const MAX_CALLS = 6;
  let calls = 0;
  const waiting = [];
  async function callTool(args) {
    if (calls >= MAX_CALLS) await new Promise((go) => waiting.push(go));
    calls += 1;
    try {
      const result = await request('tools/call', {
        name: config.toolName,
        arguments: args,
      });
      if (result?.isError || !result?.structuredContent)
        throw new Error(result?.content?.[0]?.text || 'The request failed');
      return result.structuredContent;
    } finally {
      calls -= 1;
      waiting.shift()?.();
    }
  }
  const toBase64 = (bytes) => {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(binary);
  };
  const fromBase64 = (text) =>
    Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  async function bodyBytes(body) {
    if (body == null) return null;
    if (typeof body === 'string') return new TextEncoder().encode(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body))
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  const NULL_BODY = new Set([101, 204, 205, 304]);
  const held = new Map();

  /** Request a path on the app's server; resolves to a Response. */
  function appFetch(path, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    // Built files never change while the panel runs, so each loads once.
    const shared = method === 'GET' && path.startsWith(config.panelBase);
    if (shared && held.has(path)) return held.get(path).then(respond);
    const loading = (async () => {
      const headers = {};
      new Headers(init.headers || {}).forEach((value, name) => {
        headers[name] = value;
      });
      const bytes = await bodyBytes(init.body);
      let part = await callTool({
        path,
        method,
        headers,
        ...(bytes ? { body: toBase64(bytes) } : {}),
      });
      const parts = [fromBase64(part.body)];
      while (part.nextOffset !== undefined) {
        if (init.signal?.aborted) break;
        part = await callTool({ id: part.id, offset: part.nextOffset });
        parts.push(fromBase64(part.body));
      }
      let body = new Blob(parts);
      if (part.encoding === 'gzip')
        body = await new Response(
          body.stream().pipeThrough(new DecompressionStream('gzip')),
        ).blob();
      return {
        body: await body.arrayBuffer(),
        status: part.status,
        statusText: part.statusText,
        headers: part.headers,
      };
    })();
    if (shared) {
      held.set(path, loading);
      loading.catch(() => held.delete(path));
    }
    const result = loading.then(respond);
    if (!init.signal) return result;
    return Promise.race([
      result,
      new Promise((_, reject) => {
        const abort = () =>
          reject(new DOMException('The request was aborted', 'AbortError'));
        if (init.signal.aborted) abort();
        init.signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  }
  function respond({ body, status, statusText, headers }) {
    return new Response(NULL_BODY.has(status) ? null : body.slice(0), {
      status,
      statusText,
      headers,
    });
  }

  // The app's own paths: relative ones, absolute ones on this page's site
  // (matched by scheme and host, since a host may use its own scheme), and
  // ones under the app's address in the page, an https address for code
  // that needs one (`config.appBaseUrl`).
  const page = new URL(document.baseURI);
  const appOrigin = new URL(config.appBaseUrl).origin;
  function appPath(value) {
    let url;
    try {
      url = new URL(String(value), document.baseURI);
    } catch {
      return null;
    }
    const own =
      url.origin === appOrigin ||
      (url.protocol === page.protocol && url.host === page.host);
    return own ? url.pathname + url.search : null;
  }
  const fileUrls = new Map();
  /**
   * A data: URL holding an app file, for elements that load by URL. Hosts
   * allow data: images where some refuse blob: ones. Files of the panel
   * build never change and are kept; others, such as live camera frames
   * that change address on every refresh, are not.
   */
  function appFileUrl(path) {
    if (fileUrls.has(path)) return fileUrls.get(path);
    const loading = appFetch(path)
      .then((response) => response.blob())
      .then(
        (blob) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      );
    if (path.startsWith(config.panelBase)) {
      fileUrls.set(path, loading);
      loading.catch(() => fileUrls.delete(path));
    }
    return loading;
  }

  function installRequests() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const isRequest = input instanceof Request;
      const path = appPath(isRequest ? input.url : input);
      if (path === null) return nativeFetch(input, init);
      if (!isRequest) return appFetch(path, init);
      return appFetch(path, {
        method: init.method || input.method,
        headers: init.headers || input.headers,
        body:
          init.body ??
          (['GET', 'HEAD'].includes(input.method)
            ? undefined
            : await input.arrayBuffer()),
        signal: init.signal || input.signal,
      });
    };

    // XMLHttpRequest for app paths: answered from appFetch, with the
    // instance's state replaced, and the usual events dispatched.
    const xhr = XMLHttpRequest.prototype;
    const nativeOpen = xhr.open;
    const nativeSend = xhr.send;
    const nativeHeader = xhr.setRequestHeader;
    const nativeAbort = xhr.abort;
    xhr.open = function (method, url, ...rest) {
      const path = appPath(url);
      if (path === null) {
        this.__gev = null;
        return nativeOpen.call(this, method, url, ...rest);
      }
      this.__gev = { method, path, headers: {}, controller: null };
      setState(this, { readyState: 1 });
      this.dispatchEvent(new Event('readystatechange'));
    };
    xhr.setRequestHeader = function (name, value) {
      if (!this.__gev) return nativeHeader.call(this, name, value);
      this.__gev.headers[name] = value;
    };
    xhr.abort = function () {
      if (!this.__gev) return nativeAbort.call(this);
      this.__gev.controller?.abort();
    };
    xhr.send = function (body) {
      const state = this.__gev;
      if (!state) return nativeSend.call(this, body);
      state.controller = new AbortController();
      appFetch(state.path, {
        method: state.method,
        headers: state.headers,
        body,
        signal: state.controller.signal,
      })
        .then(async (response) => {
          const type = this.responseType;
          const value =
            type === 'arraybuffer'
              ? await response.arrayBuffer()
              : type === 'blob'
                ? await response.blob()
                : await response.text();
          const text = typeof value === 'string' ? value : null;
          let parsed = value;
          if (type === 'json') {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          } else if (type === 'document')
            parsed = new DOMParser().parseFromString(text, 'text/html');
          const headers = [...response.headers]
            .map(([name, val]) => `${name}: ${val}`)
            .join('\r\n');
          setState(this, {
            readyState: 4,
            status: response.status,
            statusText: response.statusText,
            response: parsed,
            responseText: type === '' || type === 'text' ? text : '',
            responseURL: new URL(state.path, document.baseURI).href,
            getAllResponseHeaders: () => headers,
            getResponseHeader: (name) => response.headers.get(name),
          });
          for (const name of ['readystatechange', 'load', 'loadend'])
            this.dispatchEvent(
              name === 'readystatechange'
                ? new Event(name)
                : new ProgressEvent(name),
            );
        })
        .catch((error) => {
          setState(this, { readyState: 4, status: 0 });
          const name = error?.name === 'AbortError' ? 'abort' : 'error';
          for (const event of ['readystatechange', name, 'loadend'])
            this.dispatchEvent(
              event === 'readystatechange'
                ? new Event(event)
                : new ProgressEvent(event),
            );
        });
    };
    function setState(target, values) {
      for (const [name, value] of Object.entries(values))
        Object.defineProperty(target, name, {
          configurable: true,
          ...(typeof value === 'function' ? { value } : { get: () => value }),
        });
    }

    const nativeBeacon = navigator.sendBeacon?.bind(navigator);
    if (nativeBeacon)
      navigator.sendBeacon = (url, data) => {
        const path = appPath(url);
        if (path === null) return nativeBeacon(url, data);
        appFetch(path, { method: 'POST', body: data }).catch(() => {});
        return true;
      };

    // Images name app files by URL; give them the file as a data: URL.
    const image = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'src',
    );
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...image,
      set(value) {
        const path = appPath(value);
        if (path === null) return image.set.call(this, value);
        appFileUrl(path).then(
          (url) => image.set.call(this, url),
          () => this.dispatchEvent(new Event('error')),
        );
      },
    });

    // Workers on the app's server start from a small worker here that is
    // handed the script once it has loaded; messages wait until then.
    const NativeWorker = window.Worker;
    const BOOT =
      'const early=[];let ready=false;' +
      "addEventListener('message',e=>{if(e.data&&e.data.__gevScript){" +
      'const go=()=>{ready=true;for(const d of early)dispatchEvent(new MessageEvent("message",{data:d}))};' +
      'if(e.data.module)import(e.data.__gevScript).then(go);else{importScripts(e.data.__gevScript);go()}' +
      'e.stopImmediatePropagation();return}' +
      'if(!ready){early.push(e.data);e.stopImmediatePropagation()}});';
    window.Worker = function Worker(url, options) {
      const path = appPath(url);
      if (path === null || String(url).startsWith('blob:'))
        return new NativeWorker(url, options);
      const worker = new NativeWorker(
        URL.createObjectURL(new Blob([BOOT], { type: 'text/javascript' })),
        options,
      );
      appFetch(path)
        .then((response) => response.blob())
        .then((blob) => URL.createObjectURL(blob))
        .then((script) =>
          worker.postMessage({
            __gevScript: script,
            module: options?.type === 'module',
          }),
        );
      return worker;
    };
    window.Worker.prototype = NativeWorker.prototype;

    // Some hosts drop the GPU contents of a panel's 2D canvases while they
    // consider the panel off screen, and the overlays then cover the globe
    // in black. Keep 2D canvases in memory instead, which hosts do not drop.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      return type === '2d'
        ? getContext.call(this, type, { ...options, willReadFrequently: true })
        : getContext.call(this, type, options);
    };

    // Markup the app adds as HTML text would request its images from this
    // page's site at once; hold their addresses until the files are here.
    const htmlWithHeldImages = (html) =>
      String(html).replace(
        /(<(?:img|source)\b[^>]*?\s)src=(["'])([^"']*)\2/gi,
        (tag, before, quote, value) =>
          appPath(value) === null
            ? tag
            : `${before}data-gev-src=${quote}${value}${quote}`,
      );
    const fillHeldImages = (root) => {
      for (const element of root?.querySelectorAll?.('[data-gev-src]') ?? []) {
        const path = appPath(element.getAttribute('data-gev-src'));
        element.removeAttribute('data-gev-src');
        appFileUrl(path).then((url) => element.setAttribute('src', url));
      }
    };
    const innerHtml = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'innerHTML',
    );
    Object.defineProperty(Element.prototype, 'innerHTML', {
      ...innerHtml,
      set(value) {
        innerHtml.set.call(this, htmlWithHeldImages(value));
        fillHeldImages(this);
      },
    });
    const insertHtml = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (position, html) {
      insertHtml.call(this, position, htmlWithHeldImages(html));
      fillHeldImages(this.parentNode ?? this);
    };

    // Markup and styles the app adds later name app files too.
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.nodeName === 'STYLE') void inlineStyleUrls(node);
          for (const element of [node, ...node.querySelectorAll('img[src]')]) {
            if (element.nodeName !== 'IMG') continue;
            const path = appPath(element.getAttribute('src'));
            if (path !== null)
              appFileUrl(path).then((url) => element.setAttribute('src', url));
          }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  /** Replace url() references to app files in CSS with data: URLs. */
  async function cssWithFiles(text, baseUrl) {
    const found = new Map();
    for (const match of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const reference = match[2];
      if (/^(data|blob):/.test(reference)) continue;
      const path = appPath(new URL(reference, baseUrl).href);
      if (path !== null && !found.has(reference))
        found.set(
          reference,
          appFileUrl(path).catch(() => null),
        );
    }
    let result = text;
    for (const [reference, loading] of found) {
      const url = await loading;
      if (url) result = result.split(reference).join(url);
    }
    return result;
  }
  async function inlineStyleUrls(style) {
    if (!/url\(/.test(style.textContent)) return;
    style.textContent = await cssWithFiles(style.textContent, document.baseURI);
  }

  async function addStylesheet(href) {
    const path = appPath(href);
    const style = document.createElement('style');
    document.head.appendChild(style);
    if (path === null) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      style.replaceWith(link);
      return;
    }
    const text = await (await appFetch(path)).text();
    style.textContent = await cssWithFiles(
      text,
      new URL(path, document.baseURI).href,
    );
  }

  function runScript(text, type) {
    const script = document.createElement('script');
    if (type) script.type = type;
    script.textContent = text;
    document.body.appendChild(script);
  }

  /**
   * Load God's Eye View into this page from the app's panel build, in
   * inline embed mode, starting at the first view as its link would.
   */
  async function startApp(url, view) {
    window.GEV_EMBED_INLINE = true;
    window.GEV_APP_BASE_URL = config.appBaseUrl;
    try {
      history.replaceState(
        null,
        '',
        location.href.split('#')[0] + new URL(url).hash,
      );
      // The app restores this view from its link, following included, so
      // it needs applying again only for what links cannot carry: cockpit.
      if (queued === view && !view.follow?.cockpit) queued = null;
    } catch {
      // The view still arrives once the app is ready.
    }
    installRequests();
    const response = await appFetch(config.panelBase);
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? 'the app has no panel build (npm run build:panel)'
          : `the app answered ${response.status}`,
      );
    const built = new DOMParser().parseFromString(
      await response.text(),
      'text/html',
    );
    window.CESIUM_BASE_URL = `${config.panelBase}cesium/`;
    const [prelude] = await Promise.all([
      appFetch(config.panelBase + config.workerPreludePath).then((r) =>
        r.text(),
      ),
      ...[...built.head.querySelectorAll('link[rel="stylesheet"]')].map(
        (link) => addStylesheet(link.getAttribute('href')),
      ),
    ]);
    // Cesium's script sets CESIUM_WORKERS, its workers as one script it
    // starts from memory. Workers request files themselves, which this page
    // cannot answer, so the prelude, holding those files, runs ahead of it.
    let workers;
    Object.defineProperty(window, 'CESIUM_WORKERS', {
      configurable: true,
      get: () => workers,
      set: (script) => {
        workers = prelude + script;
      },
    });
    // Images in the markup load their files once added; give them the
    // files instead of letting them request this page's site.
    const images = [];
    for (const image of built.body.querySelectorAll('img[src]')) {
      const path = appPath(image.getAttribute('src'));
      if (path === null) continue;
      image.removeAttribute('src');
      images.push([image, path]);
    }
    for (const node of [...built.body.childNodes]) {
      if (node.nodeName !== 'SCRIPT')
        document.body.insertBefore(document.adoptNode(node), status);
    }
    for (const [image, path] of images)
      appFileUrl(path).then((url) => image.setAttribute('src', url));
    const scripts = await Promise.all(
      [...built.querySelectorAll('script')].map(async (script) => ({
        type: script.type,
        text: script.getAttribute('src')
          ? await (await appFetch(appPath(script.getAttribute('src')))).text()
          : script.textContent,
      })),
    );
    for (const { type, text } of scripts) runScript(text, type);
    // Browsers cap live 3D contexts across pages and take one back when
    // there are too many; say so rather than show no map.
    document.addEventListener(
      'webglcontextlost',
      () => {
        const notice = document.createElement('div');
        notice.id = 'status';
        notice.textContent =
          "This panel lost its 3D graphics, likely because other God's Eye " +
          "View panels in this conversation hold them. Use Open in God's " +
          'Eye View above, or show it in a new conversation.';
        document.body.appendChild(notice);
      },
      { capture: true, once: true },
    );
  }

  // Tool results: the first view starts the app, later ones move it.
  let started = false;
  let ready = false;
  let queued = null;
  let currentUrl = null;
  const postView = (view) =>
    window.postMessage({ type: 'gev:view', id: nextId++, view }, '*');
  function show(result) {
    const data = result?.structuredContent;
    const view = data?.view;
    const url = data?.url || view?.url;
    if (!view || !url) return;
    currentUrl = url;
    open.hidden = false;
    if (ready) return postView(view);
    queued = view;
    if (started) return;
    started = true;
    say("Loading God's Eye View…");
    startApp(url, view).catch((error) =>
      say(`God's Eye View could not load here: ${error?.message || error}.`),
    );
    setTimeout(() => {
      if (!ready)
        say(
          "God's Eye View did not load here" +
            (blocked ? ` (${blocked})` : '') +
            ". Use Open in God's Eye View above.",
        );
    }, config.loadTimeoutMs);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (event.source === window) {
      if (message?.type === 'gev:ready') {
        ready = true;
        status.remove();
        if (queued) postView(queued);
        queued = null;
      }
      return;
    }
    if (event.source !== window.parent || message?.jsonrpc !== '2.0') return;
    if (
      message.id !== undefined &&
      pending.has(message.id) &&
      !message.method
    ) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(message.error);
      else resolve(message.result);
      return;
    }
    if (message.method === 'ui/notifications/tool-result') show(message.params);
    if (message.method === 'ui/notifications/host-context-changed')
      showDisplayMode(message.params);
  });

  // Fullscreen, where the host offers it, gives the globe the room.
  let displayMode = 'inline';
  const showDisplayMode = (context) => {
    if (context?.displayMode) displayMode = context.displayMode;
    if (context?.availableDisplayModes)
      expand.hidden = !context.availableDisplayModes.includes('fullscreen');
    expand.textContent = displayMode === 'fullscreen' ? 'Collapse' : 'Expand';
  };
  expand.addEventListener('click', () => {
    request('ui/request-display-mode', {
      mode: displayMode === 'fullscreen' ? 'inline' : 'fullscreen',
    }).then(
      (result) => showDisplayMode({ displayMode: result?.mode }),
      () => {},
    );
  });

  open.addEventListener('click', () => {
    if (!currentUrl) return;
    request('ui/open-link', { url: currentUrl }).catch(() =>
      window.open(currentUrl, '_blank', 'noopener'),
    );
  });

  // The handshake the MCP Apps SDK's App.connect performs: hosts validate
  // these parameters, and keep a view hidden until it is initialized.
  request('ui/initialize', {
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    appInfo: {
      name: 'gods-eye-view',
      title: "God's Eye View",
      version: '1.0.0',
    },
    protocolVersion: config.protocolVersion,
  }).then(
    (result) => {
      showDisplayMode(result?.hostContext);
      send({ method: 'ui/notifications/initialized' });
      notify('ui/notifications/size-changed', {
        width: document.body.clientWidth,
        height: config.panelHeight,
      });
    },
    (error) =>
      say(
        "This client did not accept the God's Eye View panel" +
          (error?.message ? `: ${error.message}` : '.'),
      ),
  );
}
