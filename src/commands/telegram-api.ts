/** Retry safe reads and explicit 429 rejections, including multipart uploads. */
import { requestWithTimeout, retryAfterMs, waitForRetry, type RequestOptions } from "../runtime/http";
import { bridgeSignal } from "../runtime/bridge-context";

interface ApiResponse {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export class TelegramApiError extends Error {
  constructor(public readonly code: number, public readonly description: string, public readonly retryAfterMs?: number) {
    super(`Telegram API: ${code} ${description}`);
  }
}

export interface TelegramApiDeps extends RequestOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

const READ_METHODS = new Set(["getMe", "getFile", "getUpdates"]);

export async function telegramApi<T>(token: string, method: string, body?: Record<string, unknown> | FormData, deps: TelegramApiDeps = {}): Promise<T> {
  const signal = deps.signal ?? bridgeSignal();
  const sleep = deps.sleep ?? ((ms) => waitForRetry(ms, signal));
  const timeoutMs = deps.timeoutMs ?? (method === "getUpdates" ? 40_000 : 15_000);
  const multipart = body instanceof FormData;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await requestWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: multipart ? undefined : { "Content-Type": "application/json" },
        body: multipart ? body : body ? JSON.stringify(body) : undefined,
      }, async (response) => {
        const data = await response.json() as ApiResponse;
        if (response.ok && data.ok) return data as T;
        throw new TelegramApiError(data.error_code ?? response.status, data.description ?? response.statusText, retryAfterMs(data.parameters?.retry_after));
      }, { ...deps, timeoutMs, signal });
    } catch (error) {
      signal?.throwIfAborted();
      const rateLimited = error instanceof TelegramApiError && error.code === 429;
      const transient = !(error instanceof TelegramApiError) || error.code >= 500;
      if (attempt >= (deps.maxRetries ?? 3) || (!rateLimited && !(READ_METHODS.has(method) && transient))) throw error;
      await sleep(rateLimited ? error.retryAfterMs ?? 1000 : Math.min(30_000, 500 * 2 ** attempt) * (1 + Math.random() * 0.5));
    }
  }
}
