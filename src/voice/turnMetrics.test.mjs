import assert from 'node:assert/strict';
import test from 'node:test';
import { countWords, findHedges } from './speechLint.js';
import { TurnMetrics } from './turnMetrics.js';

function harness() {
  let clock = 0;
  const timers = new Map();
  let nextTimer = 1;
  const spans = [];
  const metrics = new TurnMetrics({
    emit: (span) => spans.push(span),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    settleMs: 1000,
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return {
    metrics,
    spans,
    advance,
    event: (type, extra = {}) => metrics.serverEvent({ type, ...extra }),
  };
}

test('hedge lint finds filler phrases and ignores plain answers', () => {
  assert.deepEqual(
    findHedges('Keep in mind, it seems there are roughly 40 flights.'),
    ['keep in mind', 'it seems', 'roughly'],
  );
  assert.deepEqual(
    findHedges('46 fires in Bagmati. Biggest near Hetauda.'),
    [],
  );
  assert.deepEqual(findHedges('It’s worth noting the feed is stale.'), [
    "it's worth noting",
  ]);
  assert.equal(countWords('UAL428, United, 737-800, KIAH to KSFO.'), 6);
  assert.equal(countWords(''), 0);
});

test('a slow tool turn records first audio, the silence gap, preamble and words', () => {
  const { metrics, spans, advance, event } = harness();
  event('input_audio_buffer.speech_started');
  advance(1200);
  event('input_audio_buffer.speech_stopped');
  advance(400);
  event('response.created');
  advance(300);
  event('output_audio_buffer.started');
  advance(900);
  event('output_audio_buffer.stopped');
  const tool = metrics.toolStart('annotate_map');
  event('response.done', {
    response: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_audio',
              transcript: 'Finding the Capitol, then tracing it.',
            },
          ],
        },
        { type: 'function_call', name: 'annotate_map' },
      ],
    },
  });
  advance(2000);
  metrics.toolEnd(tool, true);
  event('response.created');
  advance(500);
  event('output_audio_buffer.started');
  advance(800);
  event('response.done', {
    response: {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_audio',
              transcript: 'The Capitol grounds are marked.',
            },
          ],
        },
      ],
    },
  });
  event('output_audio_buffer.stopped');
  assert.equal(spans.length, 0, 'turn stays open until it settles');
  advance(1000);
  assert.equal(spans.length, 1);
  const [span] = spans;
  assert.equal(span.eou_ms, 1200);
  assert.equal(span.first_audio_ms, 700);
  assert.equal(span.first_audio_source, 'buffer');
  assert.equal(span.max_silence_ms, 2500);
  assert.equal(span.preamble, true);
  assert.equal(span.preamble_text, 'Finding the Capitol, then tracing it.');
  assert.deepEqual(span.tools, [{ name: 'annotate_map', ms: 2000, ok: true }]);
  assert.equal(span.answer_words, 5);
  assert.equal(span.spoken_words, 11);
  assert.deepEqual(span.hedge_hits, []);
  assert.equal(span.reason, 'settled');
});

test('a new user turn closes the previous one and counts an interruption', () => {
  const { spans, advance, event } = harness();
  event('input_audio_buffer.speech_started');
  event('input_audio_buffer.speech_stopped');
  event('response.created');
  advance(600);
  event('output_audio_buffer.started');
  advance(300);
  event('input_audio_buffer.speech_started');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].reason, 'next_turn');
  assert.equal(spans[0].interruptions, 1);
  assert.equal(spans[0].first_audio_ms, 600);
});

test('a running tool keeps the turn open and progress responses are counted separately', () => {
  const { metrics, spans, advance, event } = harness();
  metrics.userText();
  const tool = metrics.toolStart('select_nearest_aircraft');
  advance(5000);
  assert.equal(spans.length, 0);
  metrics.narration('progress');
  event('response.created');
  event('response.output_audio_transcript.delta', { delta: 'Heading' });
  event('response.done', {
    response: {
      metadata: { gev: 'progress' },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_audio', transcript: 'Heading to Austin.' }],
        },
      ],
    },
  });
  advance(1500);
  assert.equal(spans.length, 0, 'the tool is still running');
  metrics.toolEnd(tool, true);
  advance(1000);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].progress_lines, 1);
  assert.equal(spans[0].answer_words, 0);
  assert.equal(spans[0].spoken_words, 3);
  assert.equal(spans[0].first_audio_source, 'transcript');
  assert.equal(spans[0].first_audio_ms, 5000);
});

test('flush closes an open turn once', () => {
  const { metrics, spans } = harness();
  metrics.userText();
  metrics.flush('stop');
  metrics.flush('stop');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].no_audio, true);
  assert.equal(spans[0].reason, 'stop');
});

test('a transcript delta before playback is generation time; playback time comes from the buffer event', () => {
  const { metrics, spans, advance, event } = harness();
  event('input_audio_buffer.speech_started');
  advance(500);
  event('input_audio_buffer.speech_stopped');
  event('response.created');
  advance(100);
  event('response.output_audio_transcript.delta', { delta: 'Flying' });
  advance(800);
  event('output_audio_buffer.started');
  advance(600);
  event('response.done', { response: { output: [] } });
  event('output_audio_buffer.stopped');
  metrics.flush('stop');
  const [span] = spans;
  assert.equal(span.first_text_ms, 100);
  assert.equal(
    span.first_audio_ms,
    900,
    'the provisional transcript time is replaced',
  );
  assert.equal(span.first_audio_source, 'buffer');
  assert.equal(span.max_silence_ms, 900);
  assert.deepEqual(span.deltas, { count: 1, first_ms: 100, last_ms: 100 });
});

test('once playback events are seen, later turns ignore transcript timing', () => {
  const { metrics, spans, advance, event } = harness();
  metrics.userText();
  event('output_audio_buffer.started');
  event('output_audio_buffer.stopped');
  metrics.userText();
  advance(50);
  event('response.output_audio_transcript.delta', { delta: 'Hi' });
  advance(450);
  event('output_audio_buffer.started');
  metrics.flush('stop');
  assert.equal(spans[1].first_text_ms, 50);
  assert.equal(spans[1].first_audio_ms, 500);
});
