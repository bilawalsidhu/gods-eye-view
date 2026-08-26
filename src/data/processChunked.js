// Re-export from TypeScript version — allows Node ESM to resolve .js extension
// while Vite resolves the .ts source at build time.
export { processChunked, processChunkedSync } from './processChunked.ts';
