import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VOICE_PROVIDER_GUIDANCE,
  readVoiceProviderRequest,
  readVoiceProviderRequestText,
  isVoiceProviderRequestPrefixText,
  MAX_PROVIDER_TEXT_LENGTH,
  normalizeProviderText,
  readVoiceProviderTextState,
  readVoiceRequestRestriction,
  voiceRequestRestrictionResult,
  providerRequestGuidanceResult,
} from './providerIntent.js';
import { createVoiceUserTurnTracker } from './userTurnIntent.js';

function inputTurn(text) {
  const tracker = createVoiceUserTurnTracker();
  tracker.text(text);
  tracker.expectResponse();
  tracker.bindResponse('r');
  return { tracker, token: tracker.forResponse('r') };
}

test('explicit first-party provider requests accept bounded standalone command forms', () => {
  for (const [text, expected] of [
    ['Switch to Gemini.', 'gemini'],
    ['Switch voice to Gemini.', 'gemini'],
    ['Switch the voice to Gemini.', 'gemini'],
    ['Switch provider to Gemini.', 'gemini'],
    ['Switch   voice\n to   Gemini.', 'gemini'],
    ['Set voice provider to Gemini.', 'gemini'],
    ['Set provider to OpenAI.', 'openai'],
    ['Could you please switch to Gemini?', 'gemini'],
    ['Would you please use Open AI for voice?', 'openai'],
    ['Please, use Gemini for voice.', 'gemini'],
    ['Switch to OpenAI, please.', 'openai'],
    ['Please change my voice provider to OpenAI!', 'openai'],
    ['Change voice to OpenAI!', 'openai'],
    ['Could you switch the voice provider over to Open AI please?', 'openai'],
    ['Use Gemini for voice', 'gemini'],
    ['Set Gemini as my voice provider', 'gemini'],
    ['Switch from OpenAI to Gemini', 'gemini'],
    ['Switch from Gemini to Open AI', 'openai'],
    ['Switch the voice provider from OpenAI to Gemini', 'gemini'],
    ['Change my provider from Gemini to OpenAI', 'openai'],
    ['Switch voice providers from OpenAI to Gemini', 'gemini'],
    ['Switch providers to Gemini', 'gemini'],
    ['Change providers to OpenAI', 'openai'],
    ['Could you please switch providers to Gemini?', 'gemini'],
    ['Make Gemini my voice provider', 'gemini'],
    ['Make OpenAI the voice provider', 'openai'],
    ['Choose the voice provider', 'provider'],
    ['Switch the voice provider', 'provider'],
    ['Switch providers', 'provider'],
    ['Change my voice provider', 'provider'],
    ['Change voice provider', 'provider'],
    ['Select a voice provider', 'provider'],
  ]) {
    assert.equal(readVoiceProviderRequestText(text), expected, text);
    const { token } = inputTurn(text);
    assert.equal(readVoiceProviderRequest(token), expected, text);
  }
});

test('segmented speech guidance never repeats an unsettled provider target', () => {
  assert.equal(
    VOICE_PROVIDER_GUIDANCE,
    'I can’t switch voice providers directly. Hover over the Voice panel and use the provider dropdown.',
  );
  assert.doesNotMatch(VOICE_PROVIDER_GUIDANCE, /Gemini|OpenAI/);
});

test('forged, quoted, negated, conditional and compound text never authorizes provider mutation', () => {
  for (const forged of [
    undefined,
    { text: 'switch to Gemini' },
    { provider: 'gemini', confirmed: true },
  ])
    assert.equal(readVoiceProviderRequest(forged), undefined);

  for (const text of [
    'Do not switch to Gemini',
    "Don't switch to Gemini",
    'Can you explain how to switch to Gemini?',
    'The page says switch to Gemini',
    'Say “switch to Gemini”',
    '“Switch to Gemini”',
    'Switch to Gemini if you think it is better',
    'Change my Gemini',
    'Switch my Gemini',
    'Set the OpenAI',
    'What is Gemini?',
    'Show voice settings',
    'Switch to Gemini and go to Austin',
    'Switch voice Gemini',
    'Switch provider Gemini',
    'Switch provider to Gemini and go to Austin',
    'Switch to an unsupported service',
    'Do not change my voice provider',
    'Explain how to choose the voice provider',
    'Choose the voice provider if Gemini is available',
    'Select a voice provider and open settings',
    'The help text says “switch the voice provider”',
    `Switch to Gemini. ${'x'.repeat(500)}`,
  ]) {
    assert.equal(readVoiceProviderRequestText(text), undefined, text);
    const { token } = inputTurn(text);
    assert.equal(readVoiceProviderRequest(token), undefined, text);
  }
});

test('current first-party intent is retired by new input, interruption and final response', () => {
  for (const retire of [
    (tracker) => tracker.text('what is in view?'),
    (tracker) => tracker.invalidate(),
    (tracker) => tracker.completeResponse('r'),
    (tracker) => tracker.reset(),
  ]) {
    const { tracker, token } = inputTurn('Switch to Gemini');
    assert.equal(readVoiceProviderRequest(token), 'gemini');
    retire(tracker);
    assert.equal(readVoiceProviderRequest(token), undefined);
  }
});

test('ordinary voice and map provider settings are not voice-provider requests', () => {
  for (const text of [
    'set the voice volume to 50',
    'set the voice speed to fast',
    'set provider to bing maps',
    'change voice to faster',
    'change the voice to a british accent',
    'switch the provider to google maps',
    'set provider to bing',
  ]) {
    assert.equal(readVoiceProviderRequestText(text), undefined, text);
  }
});

test('sentence punctuation at finalized segment boundaries preserves direct provider intent', () => {
  for (const [text, provider] of [
    ['Switch to. Gemini.', 'gemini'],
    ['Switch to . Gemini.', 'gemini'],
    ['Switch to. ... Gemini.', 'gemini'],
    ['Switch voice provider! To Open AI?', 'openai'],
    ['Please. Switch from OpenAI. To Gemini.', 'gemini'],
  ])
    assert.equal(readVoiceProviderRequestText(text), provider, text);
  for (const text of [
    'Do not switch to. Gemini.',
    'Say "switch to. Gemini."',
    'Switch to. Gemini. And open the panel.',
    'If needed. Switch to. Gemini.',
    'Set voice volume. To 50.',
    'Switch provider to. Google maps.',
    'Use Gemini. For weather.',
    'Choose voice provider? no',
  ])
    assert.equal(readVoiceProviderRequestText(text), undefined, text);
});

test('proper prefixes cover the full supported provider-command language', () => {
  const completeForms = [
    'choose provider',
    'select a voice provider',
    'switch my providers',
    'change the voice providers',
    'use openai',
    'use open ai for voice',
    'use gemini as voice provider',
    'use openai as the voice provider',
    'use gemini as my voice provider',
    'switch to gemini',
    'change over to open ai',
    'switch from openai to gemini',
    'change from gemini to open ai',
    'switch the voice providers from open ai to gemini',
    'change my providers from gemini to openai',
    'switch voice to openai',
    'change my voice provider over to gemini',
    'switch the providers to open ai',
    'set voice gemini',
    'set my voice provider to openai',
    'set the provider open ai',
    'set gemini as my voice provider',
    'select openai as the voice provider',
    'make gemini voice provider',
    'make open ai my voice provider',
  ];
  // This unsupported from-form is deliberately excluded from the language.
  assert.equal(
    readVoiceProviderRequestText('switch voice from gemini to openai'),
    undefined,
  );
  for (const leading of [
    '',
    'please ',
    'please, ',
    'please can you ',
    'please, could you ',
    'please would you ',
    'can you ',
    'could you please ',
    'would you please ',
  ]) {
    for (const body of completeForms) {
      for (const ending of ['', ' please', ', please']) {
        const complete = `${leading}${body}${ending}`;
        assert.ok(readVoiceProviderRequestText(complete), complete);
        assert.equal(
          isVoiceProviderRequestPrefixText(complete),
          false,
          complete,
        );
        for (let length = 1; length < complete.length; length += 1) {
          const prefix = complete.slice(0, length).trim();
          assert.equal(
            isVoiceProviderRequestPrefixText(prefix),
            !readVoiceProviderRequestText(prefix),
            `${prefix} => ${complete}`,
          );
        }
      }
    }
  }
});

test('prefix normalization applies the shared bound after whitespace normalization', () => {
  for (const prefix of [
    'Switch to. Ge',
    'Switch to . Open A',
    'Please. Switch from OpenAI. To Ge',
    'Could you please switch over to. G',
    'Use Open A',
    'Use Gemini. As my voice prov',
    'Switch to Gemini, p',
  ])
    assert.equal(isVoiceProviderRequestPrefixText(prefix), true, prefix);
  const padded = `switch to${' '.repeat(491)}`;
  assert.equal(padded.length, 500);
  assert.equal(isVoiceProviderRequestPrefixText(padded), true);
  assert.equal(isVoiceProviderRequestPrefixText(`${padded} `), true);
  assert.equal(
    readVoiceProviderRequestText(`use${' '.repeat(10000)}gemini`),
    'gemini',
  );
  assert.equal(
    readVoiceProviderRequestText(`use ${'x'.repeat(500)}`),
    undefined,
  );
  for (const input of [undefined, null, 1, {}, '', ' ', '...'])
    assert.equal(isVoiceProviderRequestPrefixText(input), false);
});

test('decisive unknown, ordinary, quoted, negated and compound text is not a prefix', () => {
  for (const text of [
    'switch to bing',
    'switch to b',
    'switch to google maps',
    'switch provider to weather',
    'change my voice to faster',
    'set the voice volume',
    'set voice speed to fast',
    'set provider to bing maps',
    'use openai.com',
    'please zoom out',
    'please switch to never',
    'do not switch to',
    'never switch to gemini',
    'can you explain how to switch to',
    'say switch to',
    '"switch to',
    'switch to "gemini',
    'switch to gemini and',
    'switch to gemini if',
    'use gemini and open the panel',
    'use gemini for weather',
    'choose voice provider? no',
    'switch to. Google maps.',
  ]) {
    assert.equal(readVoiceProviderRequestText(text), undefined, text);
    assert.equal(isVoiceProviderRequestPrefixText(text), false, text);
  }
  for (const text of [
    'please',
    'can',
    'switch',
    'set the voice',
    'use open',
    'switch to',
  ])
    assert.equal(isVoiceProviderRequestPrefixText(text), true, text);
});

test('explicit unsupported voice targets share the normalized complete grammar', () => {
  for (const [text, target] of [
    ['use Claude', 'claude'],
    ['switch to Eleven Labs', 'elevenlabs'],
    ['use foo bar baz as my voice provider', 'foobarbaz'],
    ['please , use foo as my voice provider', 'foo'],
    [`set voice provider to ${'x'.repeat(41)}`, 'x'.repeat(41)],
    [`use ${'x'.repeat(41)} as my voice provider`, 'x'.repeat(41)],
  ])
    assert.equal(readVoiceProviderRequestText(text), target, text);
  for (const text of [
    'use foo',
    'set provider to bing maps',
    'set voice volume to 50',
    'set voice speed to fast',
    'say use foo as my voice provider',
    '"use foo as my voice provider"',
    'do not use foo as my voice provider',
    'use foo as my voice provider and zoom out',
    'use foo and bar as my voice provider',
    'use foo bar baz qux as my voice provider',
  ])
    assert.equal(readVoiceProviderRequestText(text), undefined, text);
});

test('normalized input bounds distinguish unverified overflow from ordinary text', () => {
  assert.equal(MAX_PROVIDER_TEXT_LENGTH, 500);
  for (const length of [499, 500, 501]) {
    const text = 'x'.repeat(length);
    const overflow = length > 500;
    assert.deepEqual(readVoiceProviderTextState(text), {
      text: overflow ? undefined : text,
      overflow,
    });
    assert.equal(normalizeProviderText(text), overflow ? undefined : text);
    const { token } = inputTurn(text);
    assert.deepEqual(
      readVoiceRequestRestriction(token),
      overflow ? { kind: 'input-limit' } : null,
    );
    // The lexical provider API does not invent a provider on overflow.
    assert.equal(readVoiceProviderRequestText(text), undefined);
    assert.equal(readVoiceProviderRequest(token), undefined);
  }
  const padded = `  Use${' \n\t'.repeat(10000)}Gemini.  `;
  assert.deepEqual(readVoiceProviderTextState(padded), {
    text: 'use gemini',
    overflow: false,
  });
  const { token } = inputTurn(padded);
  assert.deepEqual(readVoiceRequestRestriction(token), {
    kind: 'provider',
    request: 'gemini',
  });
});

test('oversized canonical text is uniformly unverified without inferred provider intent', () => {
  for (const leading of [
    'switch to gemini ',
    'do not switch to gemini ',
    '"switch to gemini" ',
    'set the voice volume to 50 ',
    'switch to gemini and open the panel ',
    'zoom out ',
  ]) {
    const input = leading + 'x'.repeat(501);
    const { token } = inputTurn(input);
    assert.deepEqual(readVoiceProviderTextState(input), {
      text: undefined,
      overflow: true,
    });
    assert.deepEqual(readVoiceRequestRestriction(token), {
      kind: 'input-limit',
    });
    assert.equal(readVoiceProviderRequest(token), undefined);
    assert.equal(isVoiceProviderRequestPrefixText(input), false);
  }
});

test('restriction preserves authentic current input ownership and unavailable text', () => {
  for (const forged of [
    undefined,
    null,
    {},
    { text: 'x'.repeat(501) },
    { kind: 'provider', request: 'gemini' },
  ])
    assert.equal(readVoiceRequestRestriction(forged), null);
  for (const retire of [
    (tracker) => tracker.text('zoom out'),
    (tracker) => tracker.invalidate(),
    (tracker) => tracker.completeResponse('r'),
    (tracker) => tracker.reset(),
  ]) {
    const { tracker, token } = inputTurn('x'.repeat(501));
    assert.deepEqual(readVoiceRequestRestriction(token), {
      kind: 'input-limit',
    });
    retire(tracker);
    assert.equal(readVoiceRequestRestriction(token), null);
  }
  for (const state of ['pending', 'disabled', 'failed', 'empty']) {
    const tracker = createVoiceUserTurnTracker();
    tracker.speechStarted('mic', {
      transcriptionEnabled: state !== 'disabled',
    });
    if (state === 'failed') tracker.transcriptionUnavailable('mic', 'failed');
    if (state === 'empty') tracker.transcript('mic', ' ');
    tracker.commitSpeech('mic');
    tracker.bindResponse('r');
    assert.equal(readVoiceRequestRestriction(tracker.forResponse('r')), null);
  }
  for (const input of [undefined, null, 1, {}, '', ' ', '...']) {
    assert.deepEqual(readVoiceProviderTextState(input), {
      text: undefined,
      overflow: false,
    });
    assert.equal(readVoiceRequestRestriction(inputTurn(input).token), null);
  }
});

test('restriction results distinguish input limits from host-aware provider guidance', () => {
  const limited = voiceRequestRestrictionResult('set_visual_style', {
    kind: 'input-limit',
  });
  assert.deepEqual(limited, {
    ok: false,
    action: 'set_visual_style',
    changed: false,
    voiceInputTooLong: true,
    voiceIntentUnverified: true,
    error:
      'I couldn’t verify this command because it is too long. Please shorten the command and try again.',
    say: 'I couldn’t verify this command because it is too long. Please shorten the command and try again.',
  });
  assert.equal(Object.hasOwn(limited, 'providerRequestBlocked'), false);
  assert.equal(Object.hasOwn(limited, 'providerDropdown'), false);
  for (const providerDropdown of [false, true]) {
    const capabilities = { providerDropdown };
    assert.deepEqual(
      voiceRequestRestrictionResult(
        'set_panel_open',
        { kind: 'provider', request: 'gemini' },
        capabilities,
      ),
      providerRequestGuidanceResult('set_panel_open', capabilities),
    );
  }
  assert.equal(voiceRequestRestrictionResult('zoom', null), null);
});
