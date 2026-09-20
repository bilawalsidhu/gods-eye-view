/**
 * Prefix a root-absolute path with the app's runtime base (Vite `base`).
 * `__GEV_BASE__` is injected at build time by Vite (see build/vite.js `define`).
 * The `typeof` guard keeps plain-Node unit tests (no Vite) on '/'.
 */
export function withBase(path, base) {
  const effective = base ?? (typeof __GEV_BASE__ === 'undefined' ? '/' : __GEV_BASE__);
  return `${effective}${path.replace(/^\//, '')}`;
}
