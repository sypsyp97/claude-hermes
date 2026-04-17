/**
 * Low-level Discord REST helper. Wraps `fetch` with:
 *
 *   - 429 rate-limit: honors `retry_after` from the response body.
 *   - 5xx (500/502/503/504): exponential backoff up to `maxRetries`. If the
 *     server sent `Retry-After`, that overrides our backoff.
 *   - Network errors (fetch rejects): same exponential backoff.
 *   - 4xx other than 429: throws immediately, no retry — these are caller
 *     bugs (bad token, bad channel, missing permission) that retry can't fix.
 *
 * `fetch` and `sleep` are injectable so tests don't need a real network.
 * Defaults are the ambient `fetch` and a `setTimeout`-based sleep.
 *
 * The retry budget exists because Discord's REST edge occasionally returns
 * 502/503 during deploys and the previous implementation dropped those
 * messages on the floor. The bounded budget keeps a hard outage from
 * stalling a request indefinitely.
 */

export const DISCORD_API = "https://discord.com/api/v10";

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_BACKOFF_MS = 500;
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/**
 * `fetch` is typed by its call signature only, not `typeof fetch`. Bun's
 * `fetch` carries an extra `preconnect` static method that test fakes can't
 * reasonably implement; the helper never uses it.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DiscordApiDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Max retries for 5xx + network errors. 429 honors `retry_after` separately but shares the same budget. */
  maxRetries?: number;
  /** Base backoff for 5xx / network. Doubles each retry. */
  baseBackoffMs?: number;
  /**
   * Random source for backoff jitter, expected to return a value in [0, 1).
   * Jitter shifts each backoff into `[base*2^a, base*2^a * 1.5]`. Without
   * jitter, every hermes instance retries in lockstep against a Discord
   * outage and turns a small spike into a thundering herd.
   */
  rng?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function discordApi<T>(
  token: string,
  method: string,
  endpoint: string,
  body?: unknown,
  deps: DiscordApiDeps = {},
): Promise<T> {
  const f: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoff = deps.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const rng = deps.rng ?? Math.random;

  const backoffWithJitter = (att: number): number => {
    const raw = baseBackoff * 2 ** att;
    return Math.floor(raw * (1 + rng() * 0.5));
  };

  let attempt = 0;

  while (true) {
    let res: Response;
    try {
      res = await f(`${DISCORD_API}${endpoint}`, {
        method,
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await sleep(backoffWithJitter(attempt));
      attempt++;
      continue;
    }

    if (res.status === 429) {
      const data = (await res.json().catch(() => ({ retry_after: 1 }))) as { retry_after?: number };
      const retryMs = Math.max(1, Math.ceil((data.retry_after ?? 1) * 1000));
      if (attempt >= maxRetries) {
        throw new Error(`Discord API ${method} ${endpoint}: 429 rate-limited (gave up after ${maxRetries} retries)`);
      }
      await sleep(retryMs);
      attempt++;
      continue;
    }

    if (RETRYABLE_STATUS.has(res.status)) {
      const text = await res.text().catch(() => "");
      if (attempt >= maxRetries) {
        throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${res.statusText} ${text}`);
      }
      const retryAfterHeader = res.headers.get("retry-after");
      const headerMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : Number.NaN;
      const delay = Number.isFinite(headerMs) && headerMs > 0
        ? Math.ceil(headerMs)
        : backoffWithJitter(attempt);
      await sleep(delay);
      attempt++;
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord API ${method} ${endpoint}: ${res.status} ${res.statusText} ${text}`);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
