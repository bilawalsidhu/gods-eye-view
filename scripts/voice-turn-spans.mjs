#!/usr/bin/env node
/**
 * Summarize voice turn spans from the Realtime debug log.
 *
 * Every closed voice turn writes one `turn.span` record (see
 * src/voice/turnMetrics.js). This prints each span and p50/p90 figures for
 * end-of-speech → first audio, the longest silence, tool time, preamble rate,
 * spoken words and hedge hits.
 *
 * Usage:
 *   node scripts/voice-turn-spans.mjs [log.jsonl] [--since <ISO time>] [--session <id>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const positional = args.filter(
  (arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'),
);
const logPath =
  positional[0] || path.join(root, '.gev-logs', 'realtime-conversations.jsonl');
const since = option('--since') ? Date.parse(option('--since')) : null;
const session = option('--session');

const spans = [];
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.includes('"turn.span"')) continue;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (record.event !== 'turn.span') continue;
  if (since && Date.parse(record.timestamp) < since) continue;
  if (session && record.sessionId !== session) continue;
  spans.push({
    at: record.timestamp,
    session: record.sessionId,
    ...record.payload,
  });
}

const quantile = (values, q) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const withTools = spans.filter((span) => span.tools?.length);
const slowToolTurns = withTools.filter((span) =>
  span.tools.some((tool) => tool.ms >= 700),
);
const summary = {
  turns: spans.length,
  toolTurns: withTools.length,
  firstAudioMs: {
    p50: quantile(spans.map((s) => s.first_audio_ms), 0.5),
    p90: quantile(spans.map((s) => s.first_audio_ms), 0.9),
  },
  maxSilenceMs: {
    p50: quantile(spans.map((s) => s.max_silence_ms), 0.5),
    p90: quantile(spans.map((s) => s.max_silence_ms), 0.9),
  },
  toolMs: {
    p50: quantile(withTools.flatMap((s) => s.tools.map((t) => t.ms)), 0.5),
    p90: quantile(withTools.flatMap((s) => s.tools.map((t) => t.ms)), 0.9),
  },
  preambleRate: withTools.length
    ? withTools.filter((s) => s.preamble).length / withTools.length
    : null,
  slowToolPreambleOrProgressRate: slowToolTurns.length
    ? slowToolTurns.filter((s) => s.preamble || s.progress_lines > 0).length /
      slowToolTurns.length
    : null,
  answerWords: {
    p50: quantile(spans.map((s) => s.answer_words), 0.5),
    p90: quantile(spans.map((s) => s.answer_words), 0.9),
  },
  spokenWordsTotal: spans.reduce((sum, s) => sum + (s.spoken_words || 0), 0),
  hedgeHits: spans.reduce((sum, s) => sum + (s.hedge_hits?.length || 0), 0),
};

if (args.includes('--json')) {
  console.log(JSON.stringify({ summary, spans }, null, 2));
} else {
  for (const span of spans) {
    const tools = (span.tools || [])
      .map((tool) => `${tool.name}:${tool.ms}ms`)
      .join(',');
    console.log(
      [
        span.at,
        `first=${span.first_audio_ms ?? '-'}ms`,
        `maxSilence=${span.max_silence_ms ?? '-'}ms`,
        `preamble=${span.preamble ? 'y' : 'n'}`,
        `progress=${span.progress_lines}`,
        `words=${span.answer_words}/${span.spoken_words}`,
        `hedges=${span.hedge_hits?.length || 0}`,
        tools || '(no tools)',
        span.answer_text ? `"${span.answer_text.slice(0, 80)}"` : '',
      ].join('  '),
    );
  }
  console.log(JSON.stringify(summary, null, 2));
}
