import { streamChat } from './chat.js';
import { createSentenceSplitter } from './sentences.js';

/**
 * Visual questions: the browser captures the viewport, the vision model
 * answers from the screenshot, and that answer is spoken directly. The
 * tool-calling model never sees the image bytes.
 */
export function visionModel(env = process.env) {
  return env.OLLAMA_VISION_MODEL || 'qwen3-vl:4b';
}

export const VISION_SYSTEM =
  'You are the eyes of a 3D globe application (satellite imagery, live aircraft, ' +
  'ships, public cameras). Answer the visual question from the screenshot in at ' +
  'most three short spoken sentences. Read visible labels, signs and captions ' +
  'when they help. Do not describe the user interface chrome unless asked. No preamble.';

export async function answerVisually(
  { question, image, context },
  { speech, signal, chat = streamChat, log = () => {} },
) {
  const splitter = createSentenceSplitter();
  let content = '';
  const started = Date.now();
  const contextText = context
    ? `\nKnown context: ${JSON.stringify(context).slice(0, 800)}`
    : '';
  const reply = await chat({
    model: visionModel(),
    messages: [
      { role: 'system', content: VISION_SYSTEM },
      { role: 'user', content: `${question}${contextText}`, images: [image] },
    ],
    tools: [],
    // qwen3-vl keeps its reasoning in message.thinking only when no think
    // flag is sent; think:false leaks <think> into the spoken content.
    think: 'omit',
    signal,
    options: { num_ctx: 4096, num_predict: 600, temperature: 0.2 },
    onToken: (delta) => {
      content += delta;
      for (const sentence of splitter.push(delta)) speech.enqueue(sentence);
    },
  });
  for (const sentence of splitter.flush()) speech.enqueue(sentence);
  log('vision.answer', {
    model: visionModel(),
    ms: Date.now() - started,
    evalCount: reply.evalCount,
    chars: content.length,
  });
  return content.trim() || 'I could not make out anything useful in the view.';
}
