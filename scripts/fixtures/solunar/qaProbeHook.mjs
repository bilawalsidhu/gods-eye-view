import { registerHooks } from 'node:module';

// Replace only Puppeteer so the QA entry point receives attacker-shaped errors.
const fake = `
const secret = process.env.SOLUNAR_TEST_SECRET;
const handlers = {};
const page = {
  setViewport: async () => {},
  on: (name, fn) => { handlers[name] = fn; },
  goto: async () => {
    handlers.pageerror(new Error(secret));
    handlers.console({ type: () => 'error', text: () => secret });
    process.stderr.write('PROBE_EVENTS_DELIVERED\\n');
    throw new Error(secret);
  },
};
export default {
  launch: async () => ({
    createBrowserContext: async () => ({ newPage: async () => page }),
    close: async () => {},
  }),
};
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'puppeteer') {
      return {
        url: `data:text/javascript,${encodeURIComponent(fake)}`,
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  },
});
