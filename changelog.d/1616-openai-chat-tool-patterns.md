- Typed chat on OpenAI answers again: OpenAI refused every message because
  `resolve_area`'s area-id pattern uses Unicode classes Chat Completions does
  not accept. Chat leaves those patterns out; area ids are still checked
  before the tool runs (samehkhamis, #1616).
