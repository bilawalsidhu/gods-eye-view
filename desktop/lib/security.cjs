'use strict';

/** True when `candidate` is a URL on the same origin as `origin`. */
function isSameOrigin(candidate, origin) {
  try {
    return new URL(candidate).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** True for http(s) URLs, the only schemes ever handed to the OS browser. */
function isExternalWebUrl(candidate) {
  try {
    const { protocol } = new URL(candidate);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Permission policy for the application window: only the local app origin may
 * ask, and only for what the product uses (microphone for voice control,
 * fullscreen, clipboard writes). Camera, geolocation, notifications and every
 * other permission are refused.
 * @param {string} permission
 * @param {{mediaTypes?: string[]}} [details]
 */
function permissionAllowed(permission, details = {}) {
  if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write')
    return true;
  if (permission === 'media') {
    const types = details.mediaTypes ?? [];
    return types.length > 0 && types.every((type) => type === 'audio');
  }
  return false;
}

/**
 * Lock one session and every web contents it creates to the app origin.
 * @param {import('electron').App} app
 * @param {import('electron').Session} session
 * @param {import('electron').Shell} shell
 * @param {string} origin Local server origin.
 */
function hardenSession({ app, session, shell, origin }) {
  session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        isSameOrigin(details.requestingUrl ?? contents.getURL(), origin) &&
          permissionAllowed(permission, details),
      );
    },
  );
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      isSameOrigin(requestingOrigin, origin) &&
      permissionAllowed(permission, details),
  );
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event, url) => {
      if (isSameOrigin(url, origin)) return;
      event.preventDefault();
      if (isExternalWebUrl(url)) shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalWebUrl(url) && !isSameOrigin(url, origin))
        shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

module.exports = {
  hardenSession,
  isExternalWebUrl,
  isSameOrigin,
  permissionAllowed,
};
