- Add Vertex AI as a typed-chat AI Provider. It runs Gemini models through
  Vertex AI Express Mode at `/api/vertex/chat` with `VERTEX_API_KEY` and
  `VERTEX_CHAT_MODEL` (default `gemini-3-flash-preview`), chat only; with
  Vertex AI selected, the mic button opens chat instead of starting voice
  (thenekas, #1607).
