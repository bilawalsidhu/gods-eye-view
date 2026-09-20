/**
 * Read assistant text out of an OpenAI Responses API payload.
 *
 * The API returns `output_text` as a convenience on most shapes, but a
 * response carrying reasoning items ahead of the message does not always
 * populate it, so the content parts are walked as the fallback. Items without
 * a content array (reasoning summaries) contribute nothing rather than
 * throwing.
 *
 * @param {object} data Parsed Responses API body.
 * @returns {string} The assistant text, or '' when the payload carries none.
 */
function extractOpenAiResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  return data.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text || part?.output_text || '')
    .join(' ')
    .trim();
}

export { extractOpenAiResponseText };
