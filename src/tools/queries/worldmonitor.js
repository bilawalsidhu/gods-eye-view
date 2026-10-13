/** Optional local World Monitor queries, shared by MCP and local chat/voice. */
import { defineTool } from '../catalog.js';

const countrySchema = {
  type: 'object',
  properties: {
    country: {
      type: 'string',
      pattern: '^[A-Za-z]{2}$',
      description: 'Two-letter ISO country code, for example US or JP.',
    },
  },
  required: ['country'],
  additionalProperties: false,
};

export const worldMonitorTools = Object.freeze([
  defineTool({
    name: 'world_monitor_country_headlines',
    title: 'World Monitor country headlines',
    description:
      'Read up to five dated country headlines from the configured local World Monitor cache. Reports incomplete or unavailable coverage; an empty list does not establish that nothing happened.',
    inputSchema: countrySchema,
    requires: ['worldmonitor'],
    async run({ country }, { services, signal }) {
      const data = await services.worldmonitor.getCountryHeadlines(country, {
        signal,
      });
      return {
        summary: `${country.toUpperCase()}: ${data.headlines?.length ?? 0} cached World Monitor headlines. Coverage: ${data.status}.${data.reason ? ` ${data.reason}` : ''}`,
        data,
      };
    },
  }),
  defineTool({
    name: 'world_monitor_country_brief',
    title: 'World Monitor country risk and news',
    description:
      'Combine cached country headlines and composite instability, travel advisory and sanctions data from local World Monitor. This is a data summary, not a model-generated assessment. Check coverage and observation timestamps.',
    inputSchema: countrySchema,
    requires: ['worldmonitor'],
    async run({ country }, { services, signal }) {
      const data = await services.worldmonitor.getCountryBrief(country, {
        signal,
      });
      return {
        summary: data.summary || `World Monitor country data: ${data.status}.`,
        data,
      };
    },
  }),
  defineTool({
    name: 'world_monitor_feed_digest',
    title: 'World Monitor feed digest',
    description:
      'Read the English news digest from the configured local World Monitor installation. Preserves stale/partial/unavailable coverage and content generation time. No hosted World Monitor fallback.',
    inputSchema: {
      type: 'object',
      properties: {
        variant: {
          type: 'string',
          enum: ['full', 'tech', 'finance', 'happy', 'commodity'],
          default: 'full',
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      additionalProperties: false,
    },
    requires: ['worldmonitor'],
    async run(args, { services, signal }) {
      const data = await services.worldmonitor.getFeedDigest({
        ...args,
        signal,
      });
      return {
        summary: `${data.returned ?? 0} World Monitor news items. Coverage: ${data.status}.${data.reason ? ` ${data.reason}` : ''}`,
        data,
      };
    },
  }),
]);
