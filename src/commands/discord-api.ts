/** Retry reads and explicit rate-limit rejections; surface ambiguous writes. */
import { requestWithTimeout, retryAfterMs, waitForRetry, type RequestOptions } from "../runtime/http";
import { bridgeSignal } from "../runtime/bridge-context";
export type { FetchLike } from "../runtime/http";

export const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordApiDeps extends RequestOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseBackoffMs?: number;
  rng?: () => number;
}

export class DiscordApiError extends Error {
  constructor(public readonly code: number, message: string, public readonly retryAfterMs?: number) {
    super(message);
  }
}

export async function discordApi<T>(token: string, method: string, endpoint: string, body?: unknown, deps: DiscordApiDeps = {}): Promise<T> {
  const signal = deps.signal ?? bridgeSignal();
  const sleep = deps.sleep ?? ((ms) => waitForRetry(ms, signal));
  const read = ["GET", "HEAD"].includes(method.toUpperCase());
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await requestWithTimeout(`${DISCORD_API}${endpoint}`, {
        method,
        headers: { Authorization: `Bot ${token}`, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) },
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
      }, async (response) => {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        if (!response.ok) {
          let seconds: unknown;
          try { seconds = JSON.parse(text).retry_after; } catch { /* plain error body */ }
          const retry = retryAfterMs(seconds) ?? retryAfterMs(Number(response.headers.get("retry-after")));
          throw new DiscordApiError(response.status, `Discord API ${method} ${endpoint}: ${response.status} ${text}`, retry);
        }
        return JSON.parse(text) as T;
      }, {...deps,signal});
    } catch (error) {
      signal?.throwIfAborted();
      const rateLimited = error instanceof DiscordApiError && error.code === 429;
      const transient = !(error instanceof DiscordApiError) || [500, 502, 503, 504].includes(error.code);
      if (attempt >= (deps.maxRetries ?? 4) || (!rateLimited && !(read && transient))) throw error;
      const backoff = Math.min(30_000, (deps.baseBackoffMs ?? 500) * 2 ** attempt) * (1 + (deps.rng ?? Math.random)() * 0.5);
      await sleep(error instanceof DiscordApiError && error.retryAfterMs !== undefined ? error.retryAfterMs : rateLimited ? 1000 : Math.floor(backoff));
    }
  }
}
