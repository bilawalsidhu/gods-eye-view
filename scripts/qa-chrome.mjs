/**
 * Compatibility re-export. Browser discovery for QA gates lives in
 * scripts/qa-browser.mjs; import from there in new code.
 */
export { MACOS_CHROME, chromeExecutablePath } from './qa-browser.mjs';
