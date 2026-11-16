/**
 * Template options shared by the browser build, the boundary check and the
 * unit-test loader. Whitespace between nodes is kept (as a single space) so
 * an application view renders as its static markup did; Prettier formats
 * single-file components with strict whitespace sensitivity to match. Asset
 * URLs such as `/pin.svg` stay literal instead of becoming module imports.
 */
export const VUE_TEMPLATE_OPTIONS = Object.freeze({
  compilerOptions: Object.freeze({ whitespace: 'preserve' }),
  transformAssetUrls: false,
});

/** `@vitejs/plugin-vue` options for application builds. */
export const VUE_PLUGIN_OPTIONS = Object.freeze({
  template: VUE_TEMPLATE_OPTIONS,
});
