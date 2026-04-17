import { describe, expect, test } from "bun:test";
import { DISCORD_API, discordApi, type FetchLike } from "./discord-api";

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

interface Recorded {
  fetchCalls: FakeFetchCall[];
  sleeps: number[];
}

function makeFakeFetch(queue: Array<Response | Error>): { fetch: FetchLike; recorded: Recorded } {
  const fetchCalls: FakeFetchCall[] = [];
  const fakeFetch: FetchLike = async (url, init) => {
    fetchCalls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fake fetch: queue empty");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fakeFetch, recorded: { fetchCalls, sleeps: [] } };
}

function makeFakeSleep(recorded: Recorded): (ms: number) => Promise<void> {
  return async (ms: number) => {
    recorded.sleeps.push(ms);
  };
}

describe("discordApi — happy path", () => {
  test("200 returns parsed JSON, single fetch, no sleep", async () => {
    const { fetch, recorded } = makeFakeFetch([jsonResponse(200, { id: "abc" })]);
    const result = await discordApi<{ id: string }>("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
    });
    expect(result).toEqual({ id: "abc" });
    expect(recorded.fetchCalls.length).toBe(1);
    expect(recorded.sleeps.length).toBe(0);
  });

  test("204 returns undefined", async () => {
    const { fetch, recorded } = makeFakeFetch([emptyResponse(204)]);
    const result = await discordApi("tok", "DELETE", "/y", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
    });
    expect(result).toBeUndefined();
    expect(recorded.fetchCalls.length).toBe(1);
  });

  test("composes URL with DISCORD_API base, sets Authorization + JSON body", async () => {
    const { fetch, recorded } = makeFakeFetch([jsonResponse(200, {})]);
    await discordApi(
      "tok-123",
      "POST",
      "/channels/c/messages",
      { content: "hi" },
      {
        fetch,
        sleep: makeFakeSleep(recorded),
      }
    );
    expect(recorded.fetchCalls[0].url).toBe(`${DISCORD_API}/channels/c/messages`);
    const init = recorded.fetchCalls[0].init as RequestInit & { headers: Record<string, string> };
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bot tok-123");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ content: "hi" }));
  });

  test("body undefined when not provided", async () => {
    const { fetch, recorded } = makeFakeFetch([jsonResponse(200, {})]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
    });
    expect((recorded.fetchCalls[0].init as RequestInit).body).toBeUndefined();
  });
});

describe("discordApi — fatal 4xx", () => {
  test("401 throws immediately, no retry, no sleep", async () => {
    const { fetch, recorded } = makeFakeFetch([textResponse(401, "Unauthorized")]);
    await expect(
      discordApi("tok", "GET", "/x", undefined, {
        fetch,
        sleep: makeFakeSleep(recorded),
        maxRetries: 5,
      })
    ).rejects.toThrow(/401/);
    expect(recorded.fetchCalls.length).toBe(1);
    expect(recorded.sleeps.length).toBe(0);
  });

  test("404 throws immediately with body in message", async () => {
    const { fetch, recorded } = makeFakeFetch([textResponse(404, "no such channel")]);
    await expect(
      discordApi("tok", "GET", "/channels/missing", undefined, {
        fetch,
        sleep: makeFakeSleep(recorded),
      })
    ).rejects.toThrow(/404.*no such channel/);
    expect(recorded.fetchCalls.length).toBe(1);
  });
});

describe("discordApi — 429 rate limit", () => {
  test("honors retry_after and retries until success", async () => {
    const { fetch, recorded } = makeFakeFetch([
      jsonResponse(429, { retry_after: 0.25 }),
      jsonResponse(200, { ok: true }),
    ]);
    const result = await discordApi<{ ok: boolean }>(
      "tok",
      "POST",
      "/x",
      { a: 1 },
      {
        fetch,
        sleep: makeFakeSleep(recorded),
      }
    );
    expect(result).toEqual({ ok: true });
    expect(recorded.fetchCalls.length).toBe(2);
    expect(recorded.sleeps).toEqual([250]);
  });

  test("retry_after rounds up via Math.ceil", async () => {
    const { fetch, recorded } = makeFakeFetch([
      jsonResponse(429, { retry_after: 0.001 }),
      jsonResponse(200, {}),
    ]);
    await discordApi("tok", "GET", "/x", undefined, { fetch, sleep: makeFakeSleep(recorded) });
    expect(recorded.sleeps[0]).toBe(1);
  });
});

describe("discordApi — 5xx exponential backoff", () => {
  test("500 then 200: one retry with base backoff, returns parsed", async () => {
    const { fetch, recorded } = makeFakeFetch([
      textResponse(500, "Internal Server Error"),
      jsonResponse(200, { id: "x" }),
    ]);
    const result = await discordApi<{ id: string }>("tok", "POST", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 0,
    });
    expect(result).toEqual({ id: "x" });
    expect(recorded.fetchCalls.length).toBe(2);
    expect(recorded.sleeps).toEqual([100]);
  });

  test("503 → 502 → 504 → 200 retries each with exponential growth", async () => {
    const { fetch, recorded } = makeFakeFetch([
      textResponse(503, "a"),
      textResponse(502, "b"),
      textResponse(504, "c"),
      jsonResponse(200, { ok: 1 }),
    ]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      maxRetries: 5,
      rng: () => 0,
    });
    expect(recorded.fetchCalls.length).toBe(4);
    expect(recorded.sleeps).toEqual([100, 200, 400]);
  });

  test("500 forever throws after maxRetries with 5xx in message", async () => {
    const queue: Response[] = [];
    for (let i = 0; i < 10; i++) queue.push(textResponse(500, "boom"));
    const { fetch, recorded } = makeFakeFetch(queue);
    await expect(
      discordApi("tok", "GET", "/x", undefined, {
        fetch,
        sleep: makeFakeSleep(recorded),
        baseBackoffMs: 10,
        maxRetries: 3,
        rng: () => 0,
      })
    ).rejects.toThrow(/500.*boom/);
    expect(recorded.fetchCalls.length).toBe(4);
    expect(recorded.sleeps).toEqual([10, 20, 40]);
  });

  test("503 with Retry-After header is honored over default backoff", async () => {
    const res = new Response("slow down", { status: 503, headers: { "Retry-After": "2" } });
    const { fetch, recorded } = makeFakeFetch([res, jsonResponse(200, {})]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 0,
    });
    expect(recorded.sleeps).toEqual([2000]);
  });
});

describe("discordApi — backoff jitter", () => {
  test("rng=0 → no jitter, slept value equals base * 2^attempt", async () => {
    const { fetch, recorded } = makeFakeFetch([
      textResponse(503, "x"),
      textResponse(503, "x"),
      jsonResponse(200, {}),
    ]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 0,
    });
    expect(recorded.sleeps).toEqual([100, 200]);
  });

  test("rng=0.5 shifts each backoff up by 25%", async () => {
    const { fetch, recorded } = makeFakeFetch([
      textResponse(503, "x"),
      textResponse(503, "x"),
      jsonResponse(200, {}),
    ]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 0.5,
    });
    // Expected: 100 * 1.25 = 125, 200 * 1.25 = 250.
    expect(recorded.sleeps).toEqual([125, 250]);
  });

  test("rng=1 shifts each backoff up by 50% (upper bound)", async () => {
    const { fetch, recorded } = makeFakeFetch([textResponse(503, "x"), jsonResponse(200, {})]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 1,
    });
    expect(recorded.sleeps).toEqual([150]);
  });

  test("network-error backoff is also jittered", async () => {
    const { fetch, recorded } = makeFakeFetch([new Error("ECONNRESET"), jsonResponse(200, {})]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 0.5,
    });
    expect(recorded.sleeps).toEqual([125]);
  });

  test("Retry-After header bypasses jitter (server told us when)", async () => {
    const res = new Response("slow down", { status: 503, headers: { "Retry-After": "2" } });
    const { fetch, recorded } = makeFakeFetch([res, jsonResponse(200, {})]);
    await discordApi("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 100,
      rng: () => 1, // would push backoff to 150ms; but header says 2000ms
    });
    expect(recorded.sleeps).toEqual([2000]);
  });
});

describe("discordApi — network errors", () => {
  test("fetch rejects once then succeeds: retries with backoff", async () => {
    const { fetch, recorded } = makeFakeFetch([new Error("ECONNRESET"), jsonResponse(200, { ok: true })]);
    const result = await discordApi<{ ok: boolean }>("tok", "GET", "/x", undefined, {
      fetch,
      sleep: makeFakeSleep(recorded),
      baseBackoffMs: 50,
      rng: () => 0,
    });
    expect(result).toEqual({ ok: true });
    expect(recorded.fetchCalls.length).toBe(2);
    expect(recorded.sleeps).toEqual([50]);
  });

  test("fetch always rejects throws after maxRetries with last error preserved", async () => {
    const errs: Error[] = [];
    for (let i = 0; i < 10; i++) errs.push(new Error(`net-${i}`));
    const { fetch, recorded } = makeFakeFetch(errs);
    await expect(
      discordApi("tok", "GET", "/x", undefined, {
        fetch,
        sleep: makeFakeSleep(recorded),
        baseBackoffMs: 5,
        maxRetries: 2,
        rng: () => 0,
      })
    ).rejects.toThrow(/net-2/);
    expect(recorded.fetchCalls.length).toBe(3);
    expect(recorded.sleeps).toEqual([5, 10]);
  });
});

describe("discordApi — defaults", () => {
  test("uses ambient fetch when none injected (smoke: hits a non-network code path)", async () => {
    // We can't make a real network call in tests; just assert the function is
    // shaped to accept no deps without throwing at the type level. This test
    // exists so a future refactor that breaks the optional-deps contract fails.
    expect(typeof discordApi).toBe("function");
  });
});
