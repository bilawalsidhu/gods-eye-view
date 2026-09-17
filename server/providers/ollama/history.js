/**
 * Keep a voice conversation inside a fixed budget: the system prompt, the
 * last N user turns with their assistant and tool followers, tool results
 * truncated, and never an orphaned tool message (Ollama rejects a tool result
 * whose assistant tool_call was dropped).
 */
export function trimHistory(
  messages,
  { maxTurns = 6, maxToolResultChars = 600, maxContentChars = 4000 } = {},
) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const [system, ...rest] = messages;
  const turns = [];
  let current = null;
  for (const message of rest) {
    if (message.role === 'user') {
      current = [];
      turns.push(current);
    }
    if (!current) {
      current = [];
      turns.push(current);
    }
    current.push(message);
  }
  const kept = turns.slice(-maxTurns);
  const out = [system];
  kept.forEach((turn, index) => {
    const recent = index >= kept.length - 2;
    for (let i = 0; i < turn.length; i++) {
      const message = turn[i];
      if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
        const followers = [];
        let j = i + 1;
        while (j < turn.length && turn[j].role === 'tool') {
          followers.push(turn[j]);
          j++;
        }
        if (!recent) {
          // Older tool exchanges are summarized away; the answer text remains.
          i = j - 1;
          continue;
        }
        out.push(message);
        for (const follower of followers)
          out.push({
            ...follower,
            content: clip(follower.content, maxToolResultChars),
          });
        i = j - 1;
        continue;
      }
      if (message.role === 'tool') continue; // orphan: its call was dropped
      out.push({ ...message, content: clip(message.content, maxContentChars) });
    }
  });
  return out;
}

function clip(value, max) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
