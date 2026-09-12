/**
 * Helpers for extracting the user-visible reply from Claude CLI output.
 *
 * Claude can emit:
 * - a single JSON object (`{session_id,result}`)
 * - a JSON array of envelopes
 * - NDJSON / stream-json (`{"type":"system"...}\n{"type":"result"...}`)
 *
 * The messaging bridges only want the assistant's final text. These helpers
 * tolerate all three shapes so raw envelope dumps never leak back to users.
 */

export interface ClaudeSessionAndResult {
  sessionId?: string;
  error?: string;
  result?: string;
}

export function extractSessionAndResult(parsed: unknown): ClaudeSessionAndResult {
  if (Array.isArray(parsed)) {
    let sessionId: string | undefined;
    let result: string | undefined;
    let error: string | undefined;
    for (const item of parsed) {
      const extracted = extractSessionAndResult(item);
      if (extracted.error) error = extracted.error;
      if (extracted.sessionId && !sessionId) sessionId = extracted.sessionId;
      if (extracted.result !== undefined) result = extracted.result;
      if (extracted.sessionId && extracted.result !== undefined) sessionId = extracted.sessionId;
    }
    return { sessionId, result, ...(error ? { error } : {}) };
  }

  if (!isObject(parsed)) return {};

  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
  if (parsed.type === "result") {
    const failed =
      parsed.is_error === true || (typeof parsed.subtype === "string" && parsed.subtype.startsWith("error"));
    const errors = Array.isArray(parsed.errors)
      ? parsed.errors.filter((e) => typeof e === "string").join("; ")
      : "";
    return {
      ...(failed
        ? { error: errors || String(parsed.result || parsed.subtype || "Claude execution failed") }
        : {}),
      sessionId,
      result: typeof parsed.result === "string" ? parsed.result : undefined,
    };
  }

  return {
    sessionId,
    result: typeof parsed.result === "string" ? parsed.result : undefined,
  };
}

export function extractSessionAndResultFromText(raw: string): ClaudeSessionAndResult {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  const whole = safeParse(trimmed);
  const extractedWhole = extractSessionAndResult(whole);
  if (
    extractedWhole.sessionId !== undefined ||
    extractedWhole.result !== undefined ||
    extractedWhole.error !== undefined
  ) {
    return extractedWhole;
  }

  let sessionId: string | undefined;
  let result: string | undefined;
  let error: string | undefined;

  for (const line of trimmed.split(/\r?\n/)) {
    const extracted = extractSessionAndResult(safeParse(line.trim()));
    if (extracted.error) error = extracted.error;
    if (extracted.sessionId && !sessionId) sessionId = extracted.sessionId;
    if (extracted.result !== undefined) result = extracted.result;
    if (extracted.sessionId && extracted.result !== undefined) sessionId = extracted.sessionId;
  }

  return { sessionId, result, ...(error ? { error } : {}) };
}

function safeParse(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
