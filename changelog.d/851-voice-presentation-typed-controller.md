- Voice: the dock's assistant phase line now says what OpenAI Realtime voice
  is doing (READY, WORKING, SPEAKING, EXECUTING, LISTENING) instead of always
  LISTENING. SPEAKING needs audible output, not just `response.created`, and
  lasts while audio drains after `response.done`; an accepted Space barge-in
  hands the line to the user, a refused one changes nothing. Unknown session
  states and non-boolean flags fail closed. Thanks to asturksever for the #837
  voice card and barge-in compatibility review and quanticsoul4772 for the
  Windows validation and fail-closed review on #851.
