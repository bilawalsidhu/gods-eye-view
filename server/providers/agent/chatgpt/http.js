import { readResponseTextCapped } from '../../common/http.js';

export const AUTH_ORIGIN = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
export const TOKEN_URL = `${AUTH_ORIGIN}/api/accounts/oauth/token`;

/** Only application-authored messages cross the credential boundary. */
export class ChatGptError extends Error {
  constructor(message, status = 502, code = 'chatgpt_unavailable') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function planError(code, status = 502) {
  if (code === 'subscription_sharing_usage_limit_exceeded')
    return new ChatGptError(
      'ChatGPT plan usage limit reached. Review ChatGPT Settings → Usage or wait for the limit to reset.',
      429,
      code,
    );
  if (code === 'subscription_sharing_usage_unavailable')
    return new ChatGptError(
      'ChatGPT plan usage is unavailable for this account. Review the app permission and plan in ChatGPT Settings.',
      403,
      code,
    );
  if (status === 401 || status === 403)
    return new ChatGptError(
      'ChatGPT rejected this session. Sign in again and check plan permission.',
      status,
    );
  if (status === 429)
    return new ChatGptError(
      'ChatGPT is rate limited. Wait before trying again.',
      429,
    );
  return new ChatGptError(
    'ChatGPT could not complete this request. No tools were executed for this response.',
    status,
  );
}

/** Bounded JSON exchange, with no redirects or upstream text in errors. */
export async function chatGptJson(
  url,
  { fetchImpl = fetch, signal, ...init } = {},
) {
  const deadline = AbortSignal.timeout(15_000);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: combined,
    });
    const text = await readResponseTextCapped(response, 1024 * 1024, combined);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw planError();
    }
    if (!response.ok) {
      if (data?.error === 'invalid_grant')
        throw new ChatGptError(
          'ChatGPT authorization expired. Sign in again.',
          401,
          'invalid_grant',
        );
      throw planError(data?.error?.code, response.status);
    }
    return data;
  } catch (error) {
    if (error instanceof ChatGptError) throw error;
    if (signal?.aborted)
      throw new ChatGptError('ChatGPT request cancelled.', 409);
    throw new ChatGptError('Could not reach ChatGPT securely. Try again.');
  }
}
