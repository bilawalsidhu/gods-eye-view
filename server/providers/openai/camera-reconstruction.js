import { readCappedResponseText } from '../common/http.js';

export const CAMERA_RECONSTRUCTION_MODEL = 'gpt-image-2.5-flare';
/** Exact documented edit model; production remains disabled until provider/cost approval. */
export function createOpenAiReconstructionProvider({
  approved = false,
  priceLabel = 'Cost approval pending',
  resolveApiKey = () => process.env.OPENAI_API_KEY,
  fetchImpl = (...args) => fetch(...args),
  maxRequests = Infinity,
  testCameraId,
  quality = 'medium',
  budget = null,
} = {}) {
  if (!['low', 'medium'].includes(quality))
    throw Error('Explicit low or medium quality required.');
  let attempts = 0;
  async function checkAccess(signal) {
    const key = resolveApiKey();
    if (!key)
      return {
        listed: false,
        error:
          'The existing server OpenAI key is not configured. No generation was run.',
      };
    const response = await fetchImpl('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
      body = await readCappedResponseText(response, 1024 * 1024);
    if (!response.ok || body.tooLarge)
      return {
        listed: false,
        error:
          'Could not verify image-generation model access. No generation was run.',
      };
    const listed = (JSON.parse(body.text).data || []).some(
      (m) => m.id === CAMERA_RECONSTRUCTION_MODEL,
    );
    return {
      listed,
      error: listed
        ? undefined
        : `The exact ${CAMERA_RECONSTRUCTION_MODEL} model is not listed for the existing credential. No other-model fallback.`,
    };
  }
  return {
    id: 'OpenAI',
    model: CAMERA_RECONSTRUCTION_MODEL,
    get approved() {
      return (
        approved &&
        attempts < maxRequests &&
        (!budget || budget.status().remainingAttempts > 0)
      );
    },
    get remainingRequests() {
      return Math.max(0, maxRequests - attempts);
    },
    testCameraId,
    get budgetStatus() {
      return budget?.status() || null;
    },
    get priceLabel() {
      const b = budget?.status();
      if (b?.error) return b.error;
      return b
        ? `$${b.limitUsd?.toFixed(2)} image allowance; $${b.priorSpendUsd?.toFixed(6)} prior costs. $${b.allocatedUsd?.toFixed(6)} allocated; $${b.remainingAllocationUsd?.toFixed(6)} unallocated. $${b.perAttemptAllocationUsd?.toFixed(2)} allocation per sent attempt; ${b.remainingAttempts} attempts remain. Local guard only; provider invoice not capped.`
        : priceLabel;
    },
    checkAccess,
    async generate({ sourceImage, scope, note, signal }) {
      if (!approved) throw Error('Image-generation cost approval is required.');
      if (attempts >= maxRequests)
        throw Error('Approved setup-test request allowance exhausted.');
      const access = await checkAccess(signal);
      if (!access.listed) throw Error(access.error);
      const key = resolveApiKey();
      if (!key) throw Error('Existing OpenAI key is unavailable.');
      // Reserve synchronously after the asynchronous access check. Concurrent
      // clients must share this one allowance, including failed paid attempts.
      if (attempts >= maxRequests)
        throw Error('Approved setup-test request allowance exhausted.');
      attempts++;
      const reservation = budget?.reserve();
      try {
        const form = new FormData();
        form.append('model', CAMERA_RECONSTRUCTION_MODEL);
        form.append('n', '1');
        form.append('quality', quality);
        form.append('size', '1024x1024');
        form.append('output_format', 'png');
        form.append(
          'image[]',
          new Blob([Buffer.from(sourceImage.split(',')[1], 'base64')], {
            type: 'image/png',
          }),
          'original.png',
        );
        form.append(
          'prompt',
          `Create an AI reconstruction with clearer, plausible visual detail from this ${scope === 'region' ? 'selected camera crop' : 'camera frame'}. Preserve the composition and visible objects as closely as possible. Do not add people or identify people/license plates. Do not claim that invented details are factual recovery. Optional user reconstruction instruction follows; it may influence invented details: ${note || '(none)'}`,
        );
        const response = await fetchImpl(
            'https://api.openai.com/v1/images/edits',
            {
              method: 'POST',
              headers: { Authorization: `Bearer ${key}` },
              body: form,
              signal,
            },
          ),
          body = await readCappedResponseText(response, 9 * 1024 * 1024);
        if (!response.ok || body.tooLarge)
          throw Object.assign(
            Error(
              response.status === 429
                ? 'OpenAI quota or rate limit reached. No automatic retry.'
                : 'OpenAI image edit failed. No automatic retry or fallback.',
            ),
            { upstreamStatus: response.status },
          );
        const result = JSON.parse(body.text);
        if (typeof result.data?.[0]?.b64_json !== 'string')
          throw Error('No generated PNG returned.');
        const usage = result.usage;
        const textTokens = usage?.input_tokens_details?.text_tokens,
          imageTokens = usage?.input_tokens_details?.image_tokens,
          outputTokens = usage?.output_tokens;
        const counted = [textTokens, imageTokens, outputTokens].every(
          (n) => Number.isFinite(n) && n >= 0,
        );
        const costUsd = counted
          ? (textTokens * 5 + imageTokens * 8 + outputTokens * 30) / 1_000_000
          : null;
        if (budget) budget.settle(reservation, costUsd);
        return {
          image: 'data:image/png;base64,' + result.data[0].b64_json,
          usage: counted ? { textTokens, imageTokens, outputTokens } : null,
          costUsd,
          budget: budget?.status() || null,
          costBasis:
            'Computed from reported tokens at published standard rates; invoice/discounts not checked.',
        };
      } catch (error) {
        // An upstream attempt may be billed even after timeout/cancellation.
        // Persist the uncertainty and block new sends; never retry automatically.
        if (budget) {
          try {
            budget.settle(reservation, null);
          } catch {}
        }
        throw error;
      }
    },
  };
}
