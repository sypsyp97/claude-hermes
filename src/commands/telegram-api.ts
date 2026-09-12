/** Bounded Bot API requests. Retry writes only after an explicit 429 rejection. */
import type { FetchLike } from "./discord-api";
import { setTimeout as delay } from "node:timers/promises";

interface ApiResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(public readonly code: number, public readonly description: string) {
    super(`Telegram API: ${code} ${description}`);
  }
}

export interface TelegramApiDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

const READ_METHODS = new Set(["getMe", "getFile", "getUpdates"]);

export async function telegramApi<T>(token: string, method: string, body?: Record<string, unknown>, deps: TelegramApiDeps = {}): Promise<T> {
  const f = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? (async (ms: number) => {
    try {
      await delay(ms, undefined, { signal: deps.signal });
    } catch (error) {
      deps.signal?.throwIfAborted();
      throw error;
    }
  });
  const maxRetries = deps.maxRetries ?? 3;
  const timeoutMs = deps.timeoutMs ?? (method === "getUpdates" ? 40_000 : 15_000);
  for (let attempt = 0; ; attempt++) {
    deps.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(deps.signal?.reason);
    deps.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`Telegram ${method} timed out`)), timeoutMs);
    let retryMs: number | undefined;
    try {
      const response = await f(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: controller.signal,
      });
      const data = await response.json() as ApiResponse;
      if (response.ok && data.ok) return data as T;
      const code = data.error_code ?? response.status;
      if (code === 429 && attempt < maxRetries) {
        const seconds = data.parameters?.retry_after;
        retryMs = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 1000;
      } else {
        throw new TelegramApiError(code, data.description ?? response.statusText);
      }
    } catch (err) {
      if (deps.signal?.aborted) throw deps.signal.reason;
      const transient = !(err instanceof TelegramApiError) || err.code >= 500;
      if (!READ_METHODS.has(method) || !transient || attempt >= maxRetries) throw err;
      retryMs = Math.min(30_000, 500 * 2 ** attempt) * (1 + Math.random() * 0.5);
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", abort);
    }
    await sleep(retryMs!);
  }
}
