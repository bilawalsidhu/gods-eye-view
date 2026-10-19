import profiles from './localProfiles.json' with { type: 'json' };

export const LOCAL_AI_PROFILES = Object.freeze(profiles);
export const LOCAL_AI_SETTINGS = Object.freeze({
  GEV_AI_PROVIDER: 'openai',
  LOCAL_AI_PROFILE: 'balance',
  LOCAL_AI_LANGUAGE: 'ru',
  LOCAL_AI_MCP_URL: '',
  LOCAL_AI_MCP_TOOL: 'google_search',
});

export function localEndpoint(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Local services must use a loopback URL without credentials, query or fragment',
    );
  }
  return url.href.replace(/\/$/, '');
}

export function validateLocalSetting(name, value) {
  if (name === 'GEV_AI_PROVIDER' && !['openai', 'local'].includes(value))
    return 'Choose OpenAI or Local';
  if (name === 'LOCAL_AI_PROFILE' && !Object.hasOwn(profiles, value))
    return 'Choose low, balance or max';
  if (name === 'LOCAL_AI_LANGUAGE' && !['ru', 'en'].includes(value))
    return 'Choose ru or en';
  if (name.endsWith('_URL') && Object.hasOwn(LOCAL_AI_SETTINGS, name)) {
    try {
      localEndpoint(value);
    } catch (error) {
      return error.message;
    }
  }
  if (name === 'LOCAL_AI_MCP_TOOL' && !/^[a-zA-Z0-9_.-]{1,128}$/.test(value))
    return 'Invalid MCP tool name';
  return null;
}

export function localAiConfig(env = {}) {
  const settings = Object.fromEntries(
    Object.entries(LOCAL_AI_SETTINGS).map(([key, fallback]) => [
      key,
      env[key] || fallback,
    ]),
  );
  for (const [key, value] of Object.entries(settings)) {
    if (!value) continue;
    const error = validateLocalSetting(key, value);
    if (error) throw new Error(`${key}: ${error}`);
  }
  return {
    provider: settings.GEV_AI_PROVIDER,
    profile: settings.LOCAL_AI_PROFILE,
    ...profiles[settings.LOCAL_AI_PROFILE],
    language: settings.LOCAL_AI_LANGUAGE,
    mcpUrl: settings.LOCAL_AI_MCP_URL
      ? localEndpoint(settings.LOCAL_AI_MCP_URL)
      : '',
    mcpTool: settings.LOCAL_AI_MCP_TOOL,
  };
}
