/** The standalone tool catalog for voice, loaded the first time voice needs it. */

import { getLocale, t } from '../i18n/index.js';

let pending = null;

export function loadToolCatalog() {
  pending ??= Promise.all([
    import('../tools/index.js'),
    import('../tools/services.js'),
  ]).then(
    ([
      { composeCatalog, coreTools, catalogForSurface },
      { createToolServices },
    ]) =>
      catalogForSurface(
        composeCatalog({
          tools: coreTools,
          services: createToolServices({
            summaryPresentation: { getLocale, localizeLabel: t },
            fetchImpl: (...args) => globalThis.fetch(...args),
            appUrl: new URL(globalThis.document.baseURI).origin,
          }),
        }),
        'voice',
        { get_hud_caption: { voice: true } },
      ),
  );
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
