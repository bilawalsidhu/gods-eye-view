/**
 * Accessibility and correctness checks on the static shell.
 *
 * Static analysis cannot see a DOM built at runtime, so this covers index.html only and
 * the Playwright suite covers the rest. Three rules from the recommended set are turned
 * off below, each because it is checking a convention this project does not follow rather
 * than a defect.
 */
export default {
  extends: ['html-validate:recommended', 'html-validate:document'],
  rules: {
    // The WCAG rules that earn their place on a static shell.
    'input-missing-label': 'error',
    'empty-heading': 'error',
    'heading-level': 'error',
    'area-alt': 'error',
    'no-autoplay': 'error',

    // Off: `<!doctype html>` lowercase is the current convention and is what Vite emits
    // into the built HTML, so requiring uppercase would fail on output we do not write.
    'doctype-style': 'off',
    // Configured rather than off: self-closing void elements are what every formatter in
    // this repo produces. The rule still fires on a genuinely mismatched end tag.
    'void-style': ['error', { style: 'selfclosing' }],
    // Off: the only script here is a same-origin module that Vite rewrites and
    // content-hashes at build time. Subresource integrity is for third-party scripts
    // loaded off a CDN, and there are none.
    'require-sri': 'off',
  },
};
