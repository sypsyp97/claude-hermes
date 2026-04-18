import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * TDD red-phase test for Finding #5: `scripts/verify.ts` treats `--only=`
 * as a free-form comma-split with no validation. A typo like
 * `--only=typcheck,lint` drops `typcheck` on the floor (it fails the
 * `includes(s.name)` filter inside `selectSteps`) and runs only `lint`.
 * With `--only=typcheck` the filter produces zero steps, the main loop
 * never sets `allOk = false`, and the script exits 0 — silently skipping
 * the gate the autonomous loop relies on.
 *
 * Expected behavior:
 *   - Any invalid step name is rejected at parse time: exit non-zero, print
 *     a stderr message naming the offending token and listing valid names.
 *   - `--only=` with no surviving valid steps exits non-zero (no "zero steps
 *     ran → ok=true" silent pass).
 *
 * Fix agent: validate `only` inside `parseArgs` (or inside `selectSteps`)
 * against the known STEPS list. Reject unknown names with a clear error.
 */

const REPO_ROOT = process.cwd();
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "verify.ts");

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runVerify(args: string[], timeoutMs = 60_000): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["run", VERIFY_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d) => stdout.push(Buffer.from(d)));
    child.stderr.on("data", (d) => stderr.push(Buffer.from(d)));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      reject(new Error(`verify subprocess timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}

describe("scripts/verify.ts --only= validation (Finding #5)", () => {
  test("rejects an unknown step name with a non-zero exit and a helpful stderr message", async () => {
    // Typo: `typcheck` instead of `typecheck`. Must fail fast before running
    // anything.
    const result = await runVerify(["--only=typcheck,lint", "--json"]);
    expect(result.exitCode).not.toBe(0);
    // Error must mention the bad step so the user knows what to fix.
    expect(result.stderr.toLowerCase()).toContain("typcheck");
  }, 20_000);

  test("rejects --only= with ONLY unknown step names (no 'zero steps = ok' silent pass)", async () => {
    // Previously this would filter to [] and exit 0 because allOk is never
    // flipped to false when no steps run.
    const result = await runVerify(["--only=doesnotexist", "--json"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toLowerCase()).toContain("doesnotexist");
  }, 20_000);
});
