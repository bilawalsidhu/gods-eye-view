export const GEMINI_BRIEF_UNCONFIGURED_CODE = 'GEMINI_NOT_CONFIGURED';

/**
 * @param {unknown} apiKey
 * @returns {{ statusCode: number, payload: object }|null}
 */
export function keylessGeminiBriefResponse(apiKey) {
  if (String(apiKey ?? '').trim()) return null;
  return {
    statusCode: 200,
    payload: {
      configured: false,
      code: GEMINI_BRIEF_UNCONFIGURED_CODE,
      error: null,
      stream: false,
    },
  };
}

export function isGeminiBriefUnconfigured(status, data) {
  if (!data || typeof data !== 'object') return false;
  return status === 200
    && data.configured === false
    && data.code === GEMINI_BRIEF_UNCONFIGURED_CODE;
}
