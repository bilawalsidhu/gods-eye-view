import { sameSiteGated } from './common/same-site.js';
import { readCameraBody } from './openai/camera-image.js';
import { enforceRateLimit, openAiRateLimiter } from './openai/rate-limit.js';

export function boundedReconstructionPng(value, maxSide = 2048) {
  if (
    typeof value !== 'string' ||
    value.length > 8 * 1024 * 1024 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return null;
  const bytes = Buffer.from(value.split(',')[1], 'base64');
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  )
    return null;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 && width <= maxSide && height <= maxSide
    ? { width, height }
    : null;
}

/** No default provider, credentials or outgoing generation. Enable only with an explicitly approved server adapter. */
export function createCameraReconstructionHandler({
  provider = null,
  rateLimit = enforceRateLimit,
} = {}) {
  const active = new Set();
  return async (req, res) => {
    const reply = (status, data) => {
      if (res.destroyed) return;
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(data));
    };
    if (!['GET', 'POST'].includes(req.method))
      return reply(405, { error: 'Method not allowed' });
    if (req.method === 'GET' && typeof provider?.checkAccess === 'function') {
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 20000),
        cancel = () => {
          if (!res.writableEnded) controller.abort();
        };
      res.on('close', cancel);
      try {
        const access = await provider.checkAccess(controller.signal);
        if (!access.listed)
          return reply(200, {
            available: false,
            provider: provider.id,
            model: provider.model,
            error: access.error,
          });
        if (!provider.approved)
          return reply(200, {
            available: false,
            provider: provider.id,
            model: provider.model,
            priceLabel: provider.priceLabel,
            budget: provider.budgetStatus,
            access: 'Exact model listed; inference/quota untested',
            code: provider.budgetStatus
              ? 'BUDGET_BLOCKED'
              : 'COST_APPROVAL_REQUIRED',
            error: provider.budgetStatus
              ? 'Image allowance exhausted, locked, or awaiting charge reconciliation. No image has been sent.'
              : `${provider.id} ${provider.model} is listed, but generation is waiting for specific cost approval. No image has been sent.`,
          });
      } catch {
        return reply(503, {
          available: false,
          error: 'Generation setup check failed. No image has been sent.',
        });
      } finally {
        clearTimeout(timer);
        res.off('close', cancel);
      }
    }
    const ready =
      provider?.approved === true &&
      typeof provider.id === 'string' &&
      typeof provider.model === 'string' &&
      typeof provider.priceLabel === 'string' &&
      typeof provider.generate === 'function';
    if (!ready) {
      req.resume();
      return reply(req.method === 'GET' ? 200 : 503, {
        available: false,
        code: 'PROVIDER_APPROVAL_REQUIRED',
        error:
          'AI reconstruction is waiting for an approved provider, exact model, cost and credential setup. No image has been sent for generation.',
      });
    }
    if (req.method === 'GET')
      return reply(200, {
        available: true,
        provider: provider.id,
        model: provider.model,
        priceLabel: provider.priceLabel,
        budget: provider.budgetStatus,
        warning:
          'Paid AI generation can invent details. Output is AI reconstruction, not recovered evidence.',
      });
    const ip = req.socket?.remoteAddress || 'local';
    if (active.has(ip))
      return reply(429, {
        error: 'A reconstruction is already running. Wait or cancel it first.',
      });
    if (!rateLimit(openAiRateLimiter(), req, res)) return;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 180000);
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('aborted', cancel);
    res.on('close', cancel);
    active.add(ip);
    try {
      if (
        !String(req.headers?.['content-type'] || '').startsWith(
          'application/json',
        )
      )
        return reply(415, { error: 'JSON required' });
      const input = JSON.parse(
        await readCameraBody(req, controller.signal, 9 * 1024 * 1024),
      );
      if (provider.testCameraId && input.cameraId !== provider.testCameraId)
        return reply(403, {
          error:
            'The limited test allowance is for the approved public Georgia traffic camera only. No edit was sent.',
        });
      if (input.confirmReconstruction !== true)
        return reply(400, {
          error: 'Explicit paid AI reconstruction confirmation is required',
        });
      if (input.provider !== provider.id || input.model !== provider.model)
        return reply(409, {
          error:
            'Approved provider/model changed. Reopen AI reconstruction before generating.',
        });
      if (
        !['whole', 'region'].includes(input.scope) ||
        typeof input.note !== 'string' ||
        input.note.length > 1500 ||
        !boundedReconstructionPng(input.sourceImage)
      )
        return reply(400, {
          error:
            'One bounded original PNG input, scope and optional note are required',
        });
      // Adapter receives only the chosen pristine input and a bounded explicit generation instruction.
      const result = await provider.generate({
        sourceImage: input.sourceImage,
        scope: input.scope,
        note: input.note,
        signal: controller.signal,
      });
      if (controller.signal.aborted)
        return reply(499, {
          error:
            'Generation canceled. A paid request already sent cannot be recalled.',
        });
      const size = boundedReconstructionPng(result?.image);
      if (!size)
        return reply(502, {
          error:
            'Provider returned no supported bounded PNG. No automatic retry.',
        });
      return reply(200, {
        image: result.image,
        ...size,
        provider: provider.id,
        model: provider.model,
        scope: input.scope,
        label: 'AI reconstruction — not factual recovered detail',
        usage: result.usage || null,
        costUsd: Number.isFinite(result.costUsd) ? result.costUsd : null,
        budget: result.budget || null,
        costBasis:
          typeof result.costBasis === 'string' ? result.costBasis : undefined,
      });
    } catch (e) {
      return reply(
        e.code === 'BODY_TOO_LARGE'
          ? 413
          : e instanceof SyntaxError
            ? 400
            : 502,
        {
          error: controller.signal.aborted
            ? 'Generation canceled or timed out. Sent input cannot be recalled.'
            : 'AI reconstruction failed. Your original is unchanged. No automatic retry.',
          upstreamStatus: Number.isInteger(e.upstreamStatus)
            ? e.upstreamStatus
            : undefined,
        },
      );
    } finally {
      clearTimeout(timer);
      active.delete(ip);
      req.off('aborted', cancel);
      res.off('close', cancel);
    }
  };
}
export function cameraReconstructionProxy({ provider = null } = {}) {
  const handler = sameSiteGated(
    createCameraReconstructionHandler({ provider }),
  );
  const install = (server) => {
    server.middlewares.use('/api/camera-reconstruction', handler);
  };
  return {
    name: 'camera-reconstruction',
    configureServer: install,
    configurePreviewServer: install,
  };
}
