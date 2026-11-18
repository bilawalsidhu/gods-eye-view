/**
 * The browser's Photon endpoint setting, read in one place. The Vite boundary
 * (build/vite.js) exposes only undefined (use the public service), null (off,
 * from an empty PHOTON_URL) or a validated https URL.
 */
export const PHOTON_SETTING = import.meta.env?.PHOTON_URL;
