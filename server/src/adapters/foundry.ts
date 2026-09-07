import type { TokenCredential } from '@azure/identity';
import type { RuntimeConfig } from '../config.js';
import { HttpProblem } from '../errors.js';
import { fetchJson } from '../http.js';
import type {
  AdapterContext,
  Foundry,
  FoundryCompletion,
  FoundryCompletionRequest,
  HudSummaryRequest,
  RealtimeClientSecret,
  RealtimeClientSecretRequest,
} from './contracts.js';

type JsonObject = Readonly<Record<string, unknown>>;

function responseText(data: JsonObject): string {
  if (typeof data.output_text === 'string') return data.output_text.trim();
  if (!Array.isArray(data.output)) return '';
  return data.output.flatMap((item) => {
    if (!item || typeof item !== 'object' || !Array.isArray((item as JsonObject).content)) return [];
    return ((item as JsonObject).content as readonly unknown[]).map((part) => {
      if (!part || typeof part !== 'object') return '';
      const value = part as JsonObject;
      return typeof value.text === 'string' ? value.text : '';
    });
  }).join(' ').trim();
}

export class FoundryRestAdapter implements Foundry {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly credential: TokenCredential,
  ) {}

  private async headers(
    context: AdapterContext,
    scope = 'https://ai.azure.com/.default',
  ): Promise<Record<string, string>> {
    const token = await this.credential.getToken(scope);
    if (!token) throw new HttpProblem(503, 'Service Unavailable', 'Azure identity did not issue a Foundry token.');
    return {
      accept: 'application/json',
      authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
      'x-correlation-id': context.correlationId,
    };
  }

  private options(context: AdapterContext) {
    return {
      timeoutMs: this.config.upstreamTimeoutMs,
      maxResponseBytes: this.config.responseLimitBytes,
      signal: context.signal,
    };
  }

  async createRealtimeClientSecret(
    request: RealtimeClientSecretRequest,
    context: AdapterContext,
  ): Promise<RealtimeClientSecret> {
    const url = new URL('/openai/v1/realtime/client_secrets', this.config.foundryEndpoint!);
    const model = this.config.foundryRealtimeDeployment!;
    const data = await fetchJson<JsonObject>(url, {
      method: 'POST',
      headers: await this.headers(context),
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model,
          ...(request.instructions ? { instructions: request.instructions } : {}),
          ...(request.modalities ? { output_modalities: request.modalities } : {}),
          ...(request.voice ? { audio: { output: { voice: request.voice } } } : {}),
        },
      }),
    }, this.options(context));
    const nested = data.client_secret && typeof data.client_secret === 'object'
      ? data.client_secret as JsonObject
      : data;
    const value = typeof nested.value === 'string' ? nested.value : '';
    const expiresAt = Number(nested.expires_at ?? nested.expiresAt);
    if (!value || !Number.isFinite(expiresAt)) {
      throw new HttpProblem(502, 'Bad Gateway', 'Foundry returned an invalid ephemeral client secret.');
    }
    return {
      value,
      expiresAt,
      endpoint: this.config.foundryEndpoint!,
      deployment: model,
      model,
    };
  }

  async createHudSummary(request: HudSummaryRequest, context: AdapterContext): Promise<string> {
    const url = new URL('/openai/v1/responses', this.config.foundryEndpoint!);
    const data = await fetchJson<JsonObject>(url, {
      method: 'POST',
      headers: await this.headers(context),
      body: JSON.stringify({
        model: this.config.foundryHudDeployment,
        instructions: [
          'Write one concise intelligence HUD summary.',
          'Use only supplied context and never infer a place.',
          'Output exactly five words with no title, punctuation, markdown, or introduction.',
        ].join(' '),
        input: JSON.stringify({ prompt: request.prompt, context: request.context }),
        max_output_tokens: 100,
      }),
    }, this.options(context));
    const text = responseText(data);
    if (!text) throw new HttpProblem(502, 'Bad Gateway', 'Foundry returned no HUD summary.');
    return text;
  }

  async complete(request: FoundryCompletionRequest, context: AdapterContext): Promise<FoundryCompletion> {
    const summary = await this.createHudSummary({
      prompt: request.messages.map((message) => `${message.role}: ${message.content}`).join('\n'),
    }, context);
    return { choices: [{ message: { role: 'assistant', content: summary } }] };
  }
}
