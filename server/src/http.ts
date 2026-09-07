import { HttpProblem } from './errors.js';

export interface FetchJsonOptions {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal?: AbortSignal | undefined;
}

export interface FetchBinaryResult {
  readonly body: Buffer;
  readonly contentType: string;
  readonly cacheControl?: string | undefined;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpProblem(502, 'Bad Gateway', 'The upstream response exceeded the configured limit.');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new HttpProblem(502, 'Bad Gateway', 'The upstream response exceeded the configured limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchJson<T>(
  input: string | URL,
  init: RequestInit,
  options: FetchJsonOptions,
): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(input, { ...init, signal, redirect: 'error' });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new HttpProblem(504, 'Gateway Timeout', 'The upstream service did not respond in time.');
    }

    throw new HttpProblem(502, 'Bad Gateway', 'The upstream service could not be reached.');
  }

  const text = await readBounded(response, options.maxResponseBytes);
  if (!response.ok) {
    throw new HttpProblem(502, 'Bad Gateway', `The upstream service returned HTTP ${response.status}.`);
  }
  if (!text) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpProblem(502, 'Bad Gateway', 'The upstream service returned invalid JSON.');
  }
}

export async function fetchBinary(
  input: string | URL,
  init: RequestInit,
  options: FetchJsonOptions,
): Promise<FetchBinaryResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(input, { ...init, signal, redirect: 'error' });
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw new HttpProblem(504, 'Gateway Timeout', 'The upstream service did not respond in time.');
    }
    throw new HttpProblem(502, 'Bad Gateway', 'The upstream service could not be reached.');
  }
  if (!response.ok) {
    throw new HttpProblem(502, 'Bad Gateway', `The upstream service returned HTTP ${response.status}.`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxResponseBytes) {
    throw new HttpProblem(502, 'Bad Gateway', 'The upstream response exceeded the configured limit.');
  }
  if (!response.body) {
    return {
      body: Buffer.alloc(0),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      cacheControl: response.headers.get('cache-control') ?? undefined,
    };
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxResponseBytes) {
        await reader.cancel();
        throw new HttpProblem(502, 'Bad Gateway', 'The upstream response exceeded the configured limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return {
    body: Buffer.concat(chunks, total),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    cacheControl: response.headers.get('cache-control') ?? undefined,
  };
}
