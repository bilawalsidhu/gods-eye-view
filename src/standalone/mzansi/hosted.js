// Hosted previews intentionally expose only audited browser-safe functionality.
export const hosted = import.meta.env?.VITE_MZANSI_HOSTED === 'true';
export function hostedCatalog(catalog) {
  if (!hosted) return catalog;
  return {
    ...catalog,
    getSourceAvailability: (id) =>
      id === 'earthquakes'
        ? { available: true }
        : {
            available: false,
            reason:
              'This upstream layer requires a separately configured provider or licence and is disabled in the MzansiView preview. Use Explore Durban for published places.',
          },
  };
}
