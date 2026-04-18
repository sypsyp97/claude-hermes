import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TDD red-phase test for Finding #6: `status --all` reads
 * `~/.claude/projects` and decodes slug filenames with
 * `decodePath(encoded)` which does `"/" + encoded.slice(1).replace(/-/g, "/")`.
 * That mangles any workspace path containing a hyphen — e.g. `my-app` is
 * reported as `/my/app`. The project-scoped daemon registry at
 * `<cwd>/.claude/hermes/daemons.json` (see `src/runtime/daemon-registry.ts`)
 * is the real source of truth and stores unmangled absolute cwds.
 *
 * Contract:
 *   - `findAllDaemons` reads from the daemon registry (honoring the
 *     `HERMES_DAEMON_REGISTRY` env var — the same hook
 *     `daemon-registry.test.ts` uses), not from `~/.claude/projects`.
 *   - Hyphenated cwds round-trip unchanged.
 *
 * Fix agent: export `findAllDaemons` from `src/commands/status.ts` (it is
 * currently module-private), and rewrite its body to call
 * `listDaemons()` from `../runtime/daemon-registry` instead of scanning
 * `~/.claude/projects` and decoding slugs. Filter out entries whose pid
 * is dead (same `process.kill(pid, 0)` check it does today).
 */

let tempHome: string;
let registryPath: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "hermes-status-all-"));
  registryPath = join(tempHome, "daemons.json");
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

describe("status --all uses the daemon registry (Finding #6)", () => {
  test("findAllDaemons is an exported function", async () => {
    // fix agent: export `findAllDaemons` from ./status
    const mod = (await import("./status")) as unknown as {
      findAllDaemons?: () => Promise<{ path: string; pid: string | number }[]>;
    };
    expect(typeof mod.findAllDaemons).toBe("function");
  });

  test("findAllDaemons returns entries from the registry, including hyphenated paths unmangled", async () => {
    // Seed two daemons in the registry — one with a hyphen in the path.
    // Both point at our own pid so `process.kill(pid, 0)` returns true,
    // which mimics the liveness filter the fix agent will keep in place.
    const plainPath = join(tempHome, "plainrepo");
    const hyphenPath = join(tempHome, "my-hyphenated-repo");
    await mkdir(plainPath, { recursive: true });
    await mkdir(hyphenPath, { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({
        daemons: [
          { pid: process.pid, cwd: plainPath, startedAt: "2025-01-01T00:00:00Z" },
          { pid: process.pid, cwd: hyphenPath, startedAt: "2025-01-01T00:00:01Z" },
        ],
      }),
      "utf8"
    );

    const prev = process.env.HERMES_DAEMON_REGISTRY;
    process.env.HERMES_DAEMON_REGISTRY = registryPath;
    try {
      const mod = (await import("./status")) as unknown as {
        findAllDaemons?: () => Promise<{ path: string; pid: string | number }[]>;
      };
      expect(typeof mod.findAllDaemons).toBe("function");
      const results = await mod.findAllDaemons!();
      const paths = results.map((r) => r.path);
      // The hyphenated path must round-trip exactly — no "-" → "/" mangling.
      expect(paths).toContain(plainPath);
      expect(paths).toContain(hyphenPath);
      // And it MUST NOT be rewritten into the buggy slash-form.
      const mangled = hyphenPath.replace(/-/g, "/");
      expect(paths).not.toContain(mangled);
    } finally {
      if (prev === undefined) delete process.env.HERMES_DAEMON_REGISTRY;
      else process.env.HERMES_DAEMON_REGISTRY = prev;
    }
  });
});
