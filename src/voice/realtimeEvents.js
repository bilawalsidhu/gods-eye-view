/** Only this adapter knows the Realtime transcript and response event names. */
export function realtimeSessionEvent(payload) {
  const type = payload?.type;
  if (type === 'input_audio_buffer.speech_started')
    return { type: 'interruption', reason: 'user-speech' };
  if (type === 'conversation.item.input_audio_transcription.completed')
    return {
      type: 'transcript',
      role: 'user',
      text: payload.transcript || '',
      final: true,
      itemId: payload.item_id || null,
    };
  if (
    [
      'response.output_audio_transcript.delta',
      'response.output_audio_transcript.done',
      'response.output_text.delta',
      'response.output_text.done',
      'response.audio_transcript.delta',
      'response.audio_transcript.done',
      'response.text.delta',
      'response.text.done',
    ].includes(type)
  ) {
    const final = type.endsWith('.done');
    return {
      type: 'transcript',
      role: 'assistant',
      text: final
        ? (payload.transcript ?? payload.text ?? '')
        : payload.delta || '',
      final,
      itemId: payload.item_id || null,
      responseId: payload.response_id || null,
    };
  }
  if (type === 'response.done')
    return {
      type: 'completion',
      responseId: payload.response?.id || null,
      status: payload.response?.status || 'unknown',
    };
  return null;
}
