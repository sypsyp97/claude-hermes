import { setTimeout as delay } from "node:timers/promises";
import { bridgeSignal } from "./bridge-context";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Keep the deadline alive until the body has been consumed. */
export async function requestWithTimeout<T>(
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  options: RequestOptions = {}
): Promise<T> {
  const parent = options.signal ?? init.signal ?? bridgeSignal();
  parent?.throwIfAborted();
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown) => {
    controller.abort(reason);
    rejectAbort(reason);
  };
  const onAbort = () => abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => abort(new Error("HTTP request timed out")), options.timeoutMs ?? 15_000);
  try {
    const fetcher = options.fetch ?? ((address, request) => fetch(address, request));
    return await Promise.race([
      Promise.resolve()
        .then(() => fetcher(url, { ...init, signal: controller.signal }))
        .then(consume),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

export async function waitForRetry(
  ms: number,
  signal: AbortSignal | undefined = bridgeSignal()
): Promise<void> {
  // Node timers overflow above 2^31-1; never turn a long server delay into 1ms.
  for (let left = Math.max(0, ms); left > 0; left -= Math.min(left, 2_147_483_647)) {
    try {
      await delay(Math.min(left, 2_147_483_647), undefined, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }
  signal?.throwIfAborted();
}

export function retryAfterMs(seconds: unknown): number | undefined {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds * 1000)
    : undefined;
}

export function downloadBytes(url: string, options: RequestOptions = {}): Promise<Uint8Array> {
  return requestWithTimeout(
    url,
    {},
    async (response) => {
      if (!response.ok) throw new Error(`Attachment download failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    { timeoutMs: 60_000, ...options }
  );
}
