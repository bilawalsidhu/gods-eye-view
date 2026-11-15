// Opt-in switches for sources whose terms are non-commercial. They are read
// on every request, so changing the environment needs no restart.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** True when `env[name]` is 1/true/yes/on (any case); everything else is off. */
export function envFlag(name, env = process.env) {
  return TRUTHY.has(
    String(env?.[name] ?? '')
      .trim()
      .toLowerCase(),
  );
}
