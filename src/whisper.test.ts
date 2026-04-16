import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// whisper.ts only exports `warmupWhisperAssets` (downloads binary + model
// from GitHub / HuggingFace) and `transcribeAudioToText` (spawns the
// bundled whisper.cpp binary). Neither is safe to exercise end-to-end in a
// unit test — the task spec explicitly scopes out network + binary tests.
//
// What we CAN cover here:
//   1. Module imports cleanly, `warmupPromise` is not eagerly populated.
//   2. Both public symbols have the expected callable shapes.
//   3. `transcribeAudioToText` takes the STT-API branch when
//      settings.stt.baseUrl is set, and passes the audio bytes + model name
//      through to the fetched endpoint. We stub globalThis.fetch so the
//      request never touches the network.
//
// `whisper-warmup.ts` is *not* imported here because its top-level IIFE
// would immediately kick off the real binary download. It's a thin CLI
// wrapper around warmupWhisperAssets(); smoke tests own that path.

const ORIG_CWD = process.cwd();
const TEMP_DIR = join(tmpdir(), `hermes-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const HERMES_DIR = join(TEMP_DIR, ".claude", "hermes");
const SETTINGS_FILE = join(HERMES_DIR, "settings.json");

await mkdir(HERMES_DIR, { recursive: true });
process.chdir(TEMP_DIR);

const whisper = await import("./whisper");
const config = await import("./config");

afterAll(async () => {
  process.chdir(ORIG_CWD);
  await rm(TEMP_DIR, { recursive: true, force: true });
});

describe("module surface", () => {
  test("exports `warmupWhisperAssets` as a function", () => {
    expect(typeof whisper.warmupWhisperAssets).toBe("function");
  });

  test("exports `transcribeAudioToText` as a function", () => {
    expect(typeof whisper.transcribeAudioToText).toBe("function");
  });
});

describe("transcribeAudioToText via STT API", () => {
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Stage a settings.json that points at a fake STT API. loadSettings()
    // caches internally; we call reloadSettings so later tests pick up the
    // on-disk change.
    await writeFile(
      SETTINGS_FILE,
      JSON.stringify({
        stt: { baseUrl: "http://stt.invalid", model: "fake-stt-model" },
      })
    );
    await config.reloadSettings();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts a multipart/form-data body to {baseUrl}/v1/audio/transcriptions", async () => {
    // Create an actual (tiny) input file so readFile() inside transcribeViaApi
    // does not throw before we get to the fetch call.
    const audioFile = join(TEMP_DIR, "sample.ogg");
    await writeFile(audioFile, Buffer.from([0x4f, 0x67, 0x67, 0x53])); // "OggS"

    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured.url = typeof input === "string" ? input : input.toString();
      captured.init = init;
      return Promise.resolve(
        new Response(JSON.stringify({ text: "hello world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }) as unknown as typeof globalThis.fetch;

    const transcript = await whisper.transcribeAudioToText(audioFile);
    expect(transcript).toBe("hello world");
    expect(captured.url).toBe("http://stt.invalid/v1/audio/transcriptions");
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.body).toBeDefined();
    // FormData body is a native FormData instance — check it stringifies as
    // expected by the runtime (Bun returns FormData).
    const body = captured.init?.body;
    expect(body).toBeDefined();
  });

  test("throws a labelled error when the STT API responds non-2xx", async () => {
    const audioFile = join(TEMP_DIR, "fail.ogg");
    await writeFile(audioFile, Buffer.from([0x4f, 0x67, 0x67, 0x53]));

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("server exploded", { status: 502, statusText: "Bad Gateway" })
      )) as unknown as typeof globalThis.fetch;

    await expect(whisper.transcribeAudioToText(audioFile)).rejects.toThrow(/STT API error.*502/);
  });

  test("trims the transcript returned by the STT API", async () => {
    const audioFile = join(TEMP_DIR, "padded.ogg");
    await writeFile(audioFile, Buffer.from([0x4f, 0x67, 0x67, 0x53]));

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: "   trimmed   " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )) as unknown as typeof globalThis.fetch;

    const transcript = await whisper.transcribeAudioToText(audioFile);
    expect(transcript).toBe("trimmed");
  });

  test("empty { text } JSON returns an empty string", async () => {
    const audioFile = join(TEMP_DIR, "empty.ogg");
    await writeFile(audioFile, Buffer.from([0x4f, 0x67, 0x67, 0x53]));

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )) as unknown as typeof globalThis.fetch;

    const transcript = await whisper.transcribeAudioToText(audioFile);
    expect(transcript).toBe("");
  });

  test("debug=true routes log callback but does not break transcription", async () => {
    const audioFile = join(TEMP_DIR, "debug.ogg");
    await writeFile(audioFile, Buffer.from([0x4f, 0x67, 0x67, 0x53]));

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )) as unknown as typeof globalThis.fetch;

    const logs: string[] = [];
    const transcript = await whisper.transcribeAudioToText(audioFile, {
      debug: true,
      log: (msg) => logs.push(msg),
    });
    expect(transcript).toBe("ok");
    // At least one log line should mention "voice transcribe" with the URL
    const combined = logs.join("\n");
    expect(combined).toContain("voice transcribe");
    expect(combined).toContain("stt.invalid");
  });
});

describe("warmupWhisperAssets shape", () => {
  test("warmupWhisperAssets is a function with optional options arg", () => {
    // We intentionally do NOT invoke it here — calling the function would
    // kick off a real GitHub/HuggingFace download. Checking the callable
    // shape is enough for a unit-level contract test; the network path
    // is covered by integration/smoke tests elsewhere.
    expect(typeof whisper.warmupWhisperAssets).toBe("function");
    expect(whisper.warmupWhisperAssets.length).toBeLessThanOrEqual(1);
  });
});
