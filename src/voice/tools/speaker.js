/**
 * Speaker-identity tool pack: enroll, recognise, list and forget voices. The
 * server keeps the voice prints (server/providers/ollama/speaker.js); these
 * handlers only call /api/voice/speaker, which enrolls from the last few
 * things the current session heard.
 */
const NO_ARGS = { type: 'object', additionalProperties: false, properties: {} };
const NAMED = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'The name exactly as spoken.' },
  },
  required: ['name'],
};

/** Result timeouts (ms) the server should allow for these tools. */
export const timeouts = Object.freeze({
  enroll_voice: 30_000,
  who_is_speaking: 20_000,
});

export const schemas = [
  {
    name: 'enroll_voice',
    description:
      'Learn the current speaker\'s voice under a name: "this is Anthony", "remember my voice as Anthony", "I\'m Sarah". Uses what they just said; never ask for a name that was already spoken.',
    parameters: NAMED,
  },
  {
    name: 'who_is_speaking',
    description:
      'Tell who is talking from their voice ("who am I", "who is speaking", "do you recognise my voice"). Returns the enrolled name and a 0-1 score, or no speaker when the voice is unknown.',
    parameters: NO_ARGS,
  },
  {
    name: 'forget_voice',
    description:
      'Delete an enrolled voice profile ("forget my voice" uses the current speaker\'s name from who_is_speaking; "forget Anthony\'s voice").',
    parameters: NAMED,
  },
  {
    name: 'list_voices',
    description:
      'List the names whose voices are enrolled ("whose voices do you know").',
    parameters: NO_ARGS,
  },
];

export function createHandlers({ fetchJson }) {
  const call = (body) => fetchJson('/api/voice/speaker', body);
  return {
    async enroll_voice({ name } = {}) {
      const result = await call({ op: 'enroll', name });
      return result.ok
        ? {
            ...result,
            hint: `Confirm briefly that you will recognise ${result.name} from now on.`,
          }
        : result;
    },
    async who_is_speaking() {
      return call({ op: 'identify' });
    },
    async forget_voice({ name } = {}) {
      return call({ op: 'forget', name });
    },
    async list_voices() {
      const result = await call({ op: 'list' });
      return {
        ok: result.ok !== false,
        count: result.count ?? 0,
        names: (result.profiles || []).map((profile) => profile.name),
      };
    },
  };
}
