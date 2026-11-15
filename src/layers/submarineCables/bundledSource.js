// This dataset is CC BY-NC-SA 3.0, not the project's MIT license.
// Commercial users must remove it or obtain a TeleGeography license.
// See DATA_SOURCES.md and the bundled dataset's source.json.
//
// Off unless GEV_ENABLE_TELEGEOGRAPHY is set: the browser reads the Vite
// define, Node (the MCP server's tools) reads the environment variable.
export const TELEGEOGRAPHY_FLAG = 'GEV_ENABLE_TELEGEOGRAPHY';

/** Whether the non-commercial TeleGeography dataset may be read. */
export function telegeographyEnabled() {
  if (import.meta.env?.GEV_ENABLE_TELEGEOGRAPHY === true) return true;
  const value = globalThis.process?.env?.[TELEGEOGRAPHY_FLAG];
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

// Resolved when read, so importing this module never needs a module URL.
function cableUrl() {
  return new URL(
    '../../data/local_data/telegeography_submarine_cables/cable-geo.json',
    import.meta.url,
  ).href;
}
function landingPointUrl() {
  return new URL(
    '../../data/local_data/telegeography_submarine_cables/landing-point-geo.json',
    import.meta.url,
  ).href;
}

/** Supply GeoJSON collections without coupling the renderer to asset URLs. */
export function createBundledCableSource({
  fetchImpl = (...args) => fetch(...args),
  enabled = telegeographyEnabled,
} = {}) {
  const isEnabled = () =>
    typeof enabled === 'function' ? enabled() === true : enabled === true;
  async function read(url, signal) {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { signal, cache: 'force-cache' });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* best effort */
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const json = await response.json();
    signal?.throwIfAborted();
    return json;
  }
  return {
    label: 'TeleGeography', // i18n-ignore: data provider name
    /** Read when asked, so a test or host can switch it at runtime. */
    get available() {
      return isEnabled();
    },
    async fetch(signal) {
      // Nothing is requested while the dataset is off.
      if (!isEnabled())
        throw Object.assign(
          new Error(
            `TeleGeography cable data is off; set ${TELEGEOGRAPHY_FLAG}=1 to enable it`,
          ),
          {
            name: 'SourceDisabledError',
            code: 'disabled',
          },
        );
      const [cables, landingPoints] = await Promise.all([
        read(cableUrl(), signal),
        read(landingPointUrl(), signal),
      ]);
      return { cables, landingPoints };
    },
  };
}
