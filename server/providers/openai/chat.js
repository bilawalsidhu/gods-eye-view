import { generateMultiProviderChat } from '../ai.js';
import { GEV_REALTIME_TOOLS } from './tools.js';
import { realtimeInstructions } from './instructions.js';
import { readRequestBody } from '../common/request.js';
import { enforceOptInRateLimit, openAiRateLimiter } from './rate-limit.js';

export async function handleAiChat(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!enforceOptInRateLimit(openAiRateLimiter(), req, res)) return;

  try {
    const rawBody = await readRequestBody(req, 64 * 1024);
    const { message, context } = JSON.parse(rawBody || '{}');
    const systemPrompt =
      realtimeInstructions() +
      (context
        ? `\n\nCurrent View Context:\n${JSON.stringify(context, null, 2)}`
        : '');

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(message || '') },
    ];

    const result = await generateMultiProviderChat({
      messages,
      tools: GEV_REALTIME_TOOLS,
      env: process.env,
    });

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ error: error?.message || 'AI Chat request failed' }),
    );
  }
}
