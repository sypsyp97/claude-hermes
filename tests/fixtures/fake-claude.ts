#!/usr/bin/env bun
/**
 * Deterministic stand-in for the real `claude` CLI.
 *
 * Point `HERMES_CLAUDE_BIN="bun run tests/fixtures/fake-claude.ts"` at the
 * daemon and it will satisfy every spawn site: --output-format json /
 * text / stream-json, --resume, --print, --append-system-prompt,
 * --dangerously-skip-permissions, --model, and so on.
 *
 * Behavior is table-driven so tests can inject any scenario without
 * rebuilding the fixture:
 *
 *   HERMES_FAKE_SCENARIO_PATH   absolute path to a JSON scenario file
 *   HERMES_FAKE_REPLY           override the reply body (no scenario needed)
 *   HERMES_FAKE_SESSION_ID      override the session id it announces
 *   HERMES_FAKE_EXIT            override the exit code
 *   HERMES_FAKE_RATE_LIMIT      "1" -> stderr with a rate-limit message
 *   HERMES_FAKE_STDERR          custom stderr line
 *   HERMES_FAKE_DELAY_MS        artificial wall-clock delay before writing
 *   HERMES_FAKE_ECHO_PROMPT     "1" -> include stdin prompt in reply (useful for resume tests)
 *
 * When a scenario file is present its fields win over env vars.
 */

import { readFile } from "node:fs/promises";

interface Scenario {
  reply?: string;
  sessionId?: string;
  exitCode?: number;
  stderr?: string;
  rateLimit?: boolean;
  delayMs?: number;
  streamEvents?: unknown[];
  echoPrompt?: boolean;
}

interface ParsedArgs {
  outputFormat: "json" | "text" | "stream-json";
  prompt: string;
  resume?: string;
  model?: string;
  appendSystemPrompt?: string;
  print: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    outputFormat: "text",
    prompt: "",
    print: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-p":
      case "--print":
        out.print = true;
        if (argv[i + 1] && !argv[i + 1]!.startsWith("--") && argv[i + 1] !== "-p") {
          out.prompt = argv[++i]!;
        }
        break;
      case "--output-format":
        out.outputFormat = (argv[++i] as ParsedArgs["outputFormat"]) ?? "text";
        break;
      case "--resume":
        out.resume = argv[++i];
        break;
      case "--model":
        out.model = argv[++i];
        break;
      case "--append-system-prompt":
        out.appendSystemPrompt = argv[++i];
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--dangerously-skip-permissions":
      case "--tools":
      case "--allowedTools":
      case "--disallowedTools":
        if (a !== "--dangerously-skip-permissions") i++;
        break;
      default:
        if (!a?.startsWith("--") && !out.prompt && a !== "-p") {
          out.prompt = a;
        }
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
  } catch {}
  return Buffer.concat(chunks).toString("utf8");
}

async function loadScenario(): Promise<Scenario> {
  const path = process.env.HERMES_FAKE_SCENARIO_PATH;
  if (!path) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Scenario;
  } catch {
    return {};
  }
}

function envScenario(): Scenario {
  const out: Scenario = {};
  if (process.env.HERMES_FAKE_REPLY) out.reply = process.env.HERMES_FAKE_REPLY;
  if (process.env.HERMES_FAKE_SESSION_ID) out.sessionId = process.env.HERMES_FAKE_SESSION_ID;
  if (process.env.HERMES_FAKE_EXIT) out.exitCode = Number(process.env.HERMES_FAKE_EXIT);
  if (process.env.HERMES_FAKE_RATE_LIMIT === "1") out.rateLimit = true;
  if (process.env.HERMES_FAKE_STDERR) out.stderr = process.env.HERMES_FAKE_STDERR;
  if (process.env.HERMES_FAKE_DELAY_MS) out.delayMs = Number(process.env.HERMES_FAKE_DELAY_MS);
  if (process.env.HERMES_FAKE_ECHO_PROMPT === "1") out.echoPrompt = true;
  return out;
}

function defaultSessionId(): string {
  return `fake-session-${Math.random().toString(36).slice(2, 10)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fileScenario = await loadScenario();
  const envSc = envScenario();
  const scenario: Scenario = { ...envSc, ...fileScenario };

  const stdinBody = await readStdin();
  const prompt = args.prompt || stdinBody;

  // Test hook: simulate a wedged child that ignores SIGTERM. The escalation
  // path in executor / claude-stream must follow up with SIGKILL — this
  // fixture proves it. No-op on Windows (TerminateProcess is unconditional).
  if (process.env.HERMES_FAKE_IGNORE_SIGTERM === "1" && process.platform !== "win32") {
    process.on("SIGTERM", () => {
      // Swallow. The parent's SIGKILL fallback should still terminate us.
    });
  }

  if (scenario.delayMs && scenario.delayMs > 0) {
    await new Promise((r) => setTimeout(r, scenario.delayMs));
  }

  const exitCode = scenario.exitCode ?? 0;
  const sessionId = scenario.sessionId ?? defaultSessionId();
  const baseReply = scenario.reply ?? (scenario.echoPrompt ? `echo: ${prompt}`.trim() : "ok");
  const reply = scenario.echoPrompt && !scenario.reply ? `echo: ${prompt}`.trim() : baseReply;

  if (scenario.rateLimit) {
    process.stderr.write("You've hit your limit. Out of extra usage.\n");
    process.exit(exitCode || 1);
    return;
  }

  if (scenario.stderr) {
    process.stderr.write(scenario.stderr + "\n");
  }

  switch (args.outputFormat) {
    case "json": {
      const payload = { session_id: sessionId, result: reply, model: args.model ?? "fake" };
      process.stdout.write(JSON.stringify(payload) + "\n");
      break;
    }
    case "stream-json": {
      const events = scenario.streamEvents ?? [
        { type: "system", subtype: "init", session_id: sessionId, model: args.model ?? "fake" },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
        { type: "result", subtype: "success", result: reply, session_id: sessionId, num_turns: 1 },
      ];
      for (const ev of events) process.stdout.write(JSON.stringify(ev) + "\n");
      break;
    }
    default: {
      process.stdout.write(reply + "\n");
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`fake-claude error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
