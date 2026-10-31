/**
 * Template compiler options shared by the browser build, the boundary check
 * and the unit-test loader. Whitespace between nodes is kept so a view renders
 * as its static markup did: inline layouts depend on text between nodes.
 */
const VUE_COMPILER_OPTIONS = Object.freeze({ whitespace: 'preserve' });

/**
 * SFC template options. Asset URLs such as `/pin.svg` stay literal, as they
 * were in the static markup, instead of becoming module imports.
 */
export const VUE_TEMPLATE_OPTIONS = Object.freeze({
  compilerOptions: VUE_COMPILER_OPTIONS,
  transformAssetUrls: false,
});

/** `@vitejs/plugin-vue` options for application builds. */
export const VUE_PLUGIN_OPTIONS = Object.freeze({
  template: VUE_TEMPLATE_OPTIONS,
});
