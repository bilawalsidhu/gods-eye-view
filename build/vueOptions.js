/**
 * Template compiler options shared by the browser build, the boundary check
 * and the unit-test loader. Whitespace is preserved so a view renders exactly
 * the DOM its static markup did: inline layouts depend on text between nodes.
 */
export const VUE_COMPILER_OPTIONS = Object.freeze({ whitespace: 'preserve' });

/** `@vitejs/plugin-vue` options for application builds. */
export const VUE_PLUGIN_OPTIONS = Object.freeze({
  template: { compilerOptions: VUE_COMPILER_OPTIONS },
});
