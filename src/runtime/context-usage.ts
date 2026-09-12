/** Report transcript measurements without guessing a model's context capacity. */
export function formatContextUsage(raw: string, turns: number): string {
  let usage: Record<string, unknown> | undefined;
  let model: string | undefined;
  const windows = new Map<string, number>();
  const outputs = new Map<string, number>();
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  for (const [index, line] of raw.split("\n").entries()) {
    try {
      const event = JSON.parse(line);
      if (event.message?.usage) {
        usage = event.message.usage;
        model = event.message.model;
        outputs.set(event.message.id ?? String(index), count(usage?.output_tokens));
      }
      for (const [name, value] of Object.entries(event.modelUsage ?? {})) {
        const window = count((value as { contextWindow?: unknown })?.contextWindow);
        if (window) windows.set(name, window);
      }
    } catch {
      /* Ignore partial trailing JSON and non-JSON diagnostic lines. */
    }
  }
  if (!usage) return "No usage data found.";
  const input = count(usage.input_tokens);
  const creation = count(usage.cache_creation_input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const context = input + creation + read;
  const window = model ? windows.get(model) : undefined;
  return [
    "Context Window",
    `Total: ${context.toLocaleString()}${window ? ` / ${window.toLocaleString()}` : ""} tokens`,
    window ? `Usage: ${((100 * context) / window).toFixed(1)}%` : "Capacity: not reported in this transcript",
    `Input: ${input.toLocaleString()}`,
    `Cache creation: ${creation.toLocaleString()}`,
    `Cache read: ${read.toLocaleString()}`,
    `Output (cumulative): ${[...outputs.values()].reduce((sum, n) => sum + n, 0).toLocaleString()}`,
    `Turns: ${turns}`,
  ].join("\n");
}
