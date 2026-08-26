// Re-export from TypeScript version — allows Node ESM to resolve .js extension
// while Vite resolves the .ts source at build time.
export {
  resolvePickId,
  registerPickOwner,
  unregisterPickOwner,
  isOwnedByOtherLayer,
} from './pickRegistry.ts';
