import { describe, expect, test } from "bun:test";
import { cleanChildEnv } from "./runner";

// Claude CLI child processes inherit the parent's env. When Hermes is
// launched from inside another Claude Code session (a common dev path), the
// child sees CLAUDECODE/CLAUDE_CODE_* vars and can:
//   1. Mis-detect itself as "nested under Claude Code" and IPC permission
//      prompts back to the parent window instead of running headless.
//   2. Use the parent's exec path / entrypoint in diagnostics that are wrong
//      for the daemon.
// Known operator configuration survives, while parent signalling and unknown
// CLAUDE_CODE_* fields are stripped so the child is a fresh invocation.
describe("cleanChildEnv — strips parent Claude Code signalling vars", () => {
  test("strips CLAUDECODE", () => {
    const env = cleanChildEnv({ CLAUDECODE: "1", HOME: "/home/a" });
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env.HOME).toBe("/home/a");
  });

  test("strips CLAUDE_CODE_ENTRYPOINT", () => {
    const env = cleanChildEnv({ CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/usr/bin" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("strips CLAUDE_CODE_EXECPATH", () => {
    const env = cleanChildEnv({ CLAUDE_CODE_EXECPATH: "C:\\a\\claude.exe" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_EXECPATH");
  });

  test("strips any future CLAUDE_CODE_* var", () => {
    // Using a prefix match guards against new CLAUDE_CODE_* vars that a
    // future Claude Code release might add. If one of those leaks into the
    // child we're back to square one; prefix stripping is the cheap fix.
    const env = cleanChildEnv({
      CLAUDE_CODE_SOMETHING_NEW: "x",
      CLAUDE_CODE_PARENT_PID: "42",
      USER: "alice",
    });
    expect(env).not.toHaveProperty("CLAUDE_CODE_SOMETHING_NEW");
    expect(env).not.toHaveProperty("CLAUDE_CODE_PARENT_PID");
    expect(env.USER).toBe("alice");
  });

  test("does NOT strip unrelated CLAUDE_* vars (e.g. ANTHROPIC creds)", () => {
    // Stripping too aggressively would kill auth / provider routing. Only
    // the CLAUDE_CODE_* namespace and the legacy CLAUDECODE flag go.
    const env = cleanChildEnv({
      CLAUDE_MODEL: "opus",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "t",
    });
    expect(env.CLAUDE_MODEL).toBe("opus");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("t");
  });

  test("treats undefined values as absent (process.env quirk)", () => {
    // process.env values are technically `string | undefined`. The helper
    // must return a Record<string, string> — no undefineds leaking through.
    const env = cleanChildEnv({ HOME: "/home/a", MAYBE: undefined });
    expect(env.HOME).toBe("/home/a");
    expect(env).not.toHaveProperty("MAYBE");
    for (const v of Object.values(env)) {
      expect(typeof v).toBe("string");
    }
  });

  test("preserves documented provider, headless and resource controls", () => {
    const controls = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_USE_MANTLE: "1",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
      CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
      CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
      CLAUDE_CODE_SKIP_MANTLE_AUTH: "1",
      CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "test-token-not-a-real-credential",
      CLAUDE_CODE_MCP_ALLOWLIST_ENV: "1",
      CLAUDE_CODE_MCP_STARTUP_WAIT_MS: "2500",
      CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0",
      CLAUDE_CODE_DISABLE_WEB_FETCH: "1",
      CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "64000",
      CLAUDE_CODE_MAX_TURNS: "10",
      CLAUDE_CODE_MAX_RETRIES: "0",
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "2",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "2",
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
    };
    const result = cleanChildEnv(controls);
    for (const [name, value] of Object.entries(controls)) expect(result[name]).toBe(value);
    expect(result.HERMES_PARENT_PID).toBe(String(process.pid));
  });

  test("does not inherit session identity, memory overrides or automatic replay", () => {
    const transient = {
      CLAUDE_CODE_CHILD_SESSION: "parent",
      CLAUDE_CODE_BRIDGE_SESSION_ID: "parent",
      CLAUDE_CODE_REMOTE_SESSION_ID: "parent",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "not-a-real-token",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0",
      CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
      CLAUDE_CODE_TASK_LIST_ID: "shared-parent",
    };
    const result = cleanChildEnv(transient);
    for (const name of Object.keys(transient)) expect(result).not.toHaveProperty(name);
  });
});
