/** Function-calling adapter for a tool catalog: tool records and results. */

/** Tools as `{ type: 'function', name, description, parameters }` records. */
export function toFunctionTools(tools, { exclude = [] } = {}) {
  const skipped = new Set(exclude);
  return tools
    .filter((tool) => !skipped.has(tool.name))
    .map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.inputSchema),
    }));
}

/**
 * A tool result as one JSON function output. Images are counted rather than
 * sent, since function outputs carry text.
 */
export function toFunctionOutput(name, result) {
  return {
    ok: true,
    tool: name,
    summary: result.summary,
    data: result.data,
    ...(result.images?.length ? { images_omitted: result.images.length } : {}),
  };
}
